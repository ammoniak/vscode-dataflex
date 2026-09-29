import { DebugHost, type HostEvent, type HostReply } from './host';
import { frameContext } from './scope';

/**
 * The DataFlex debug adapter.
 *
 * Speaks the Debug Adapter Protocol to VS Code and the host's line protocol to the debugger engine.
 * It is deliberately free of any `vscode` import so it can be unit tested against a fake host; the
 * extension wraps it in a `DebugAdapterInlineImplementation`.
 *
 * Two shapes of the engine drive most of the design:
 *
 * Breakpoints cannot be set before the program is loaded, and the engine moves them to the next
 * line that carries an instruction. So `initialized` is not sent until the program reports it has
 * started, and the line the engine chose is reported back rather than the line that was asked for.
 *
 * There is no API that returns the call stack or a frame's variables. Frames are recovered by
 * walking queue levels, and their names and variable lists come from parsing the source.
 */

export interface DapMessage {
  seq: number;
  type: 'request' | 'response' | 'event';
  [key: string]: unknown;
}

export interface LaunchArguments {
  /** The compiled program. */
  program?: string;
  /** Working directory; the workspace root is the sensible default and the extension fills it in. */
  cwd?: string;
  /**
   * The WebApp Server application id, e.g. `MyApp260`. The extension resolves it from the program
   * being launched; `true` is accepted from a hand-written configuration and resolved the same way.
   * Passing a boolean through to the engine launches the program standalone, which fails.
   */
  webApp?: boolean | string;
  url?: string;
  stopOnEntry?: boolean;
  noDebugHeap?: boolean;
  /**
   * Whether a web app session arriving mid-debug takes over the one being debugged. Off by
   * default: silently abandoning the session under the cursor is the worse surprise.
   */
  acceptNewWebAppSessions?: boolean;
}

export interface AttachArguments {
  processId?: number;
}

/**
 * The half of {@link DebugHost} the session uses.
 *
 * Named separately so a test can substitute a scripted engine: everything interesting about the
 * adapter -- breakpoint bookkeeping, frame numbering, how a stop is reported -- is decided here and
 * would otherwise need a DataFlex installation and a compiled program to exercise at all.
 */
export interface DebugHostLike {
  start(hostPath: string, progId?: string): Promise<string>;
  onEvent(listener: (event: HostEvent) => void): void;
  send(cmd: string, extra?: Record<string, unknown>): Promise<HostReply>;
  trySend(cmd: string, extra?: Record<string, unknown>): Promise<HostReply | undefined>;
  once(match: (event: HostEvent) => boolean, timeoutMs: number): Promise<HostEvent>;
  dispose(): Promise<void>;
}

export interface DebugSessionOptions {
  /** Absolute path of dataflex-debug-host.exe. */
  hostPath: string;
  /** Sends a DAP message to the client. */
  send: (message: DapMessage) => void;
  /** Diagnostics for the DataFlex output channel. */
  log?: (line: string) => void;
  /** Forces a particular engine version, e.g. `VDFDebugger.DebuggerEngine.25.0`. */
  progId?: string;
  /** Substitutes the engine host. Tests use it; nothing else should. */
  createHost?: () => DebugHostLike;
}

interface EngineFrame {
  level: number;
  file: string;
  line: number;
}

/** The only thread DataFlex ever reports. */
const THREAD_ID = 1;

export class DataflexDebugSession {
  private readonly host: DebugHostLike;
  private readonly options: DebugSessionOptions;
  private sequence = 1;

  private launchArguments: LaunchArguments = {};
  private stack: EngineFrame[] | undefined;
  private stopped = false;
  private terminated = false;
  /** Why the program stopped, decided by what was asked of it last. */
  private pendingStopReason: 'breakpoint' | 'step' | 'pause' | 'entry' | 'exception' = 'breakpoint';
  /** Lines actually set, per file, so a re-send can clear what it replaces. */
  private readonly applied = new Map<string, number[]>();

  constructor(options: DebugSessionOptions) {
    this.options = options;
    this.host = options.createHost?.() ?? new DebugHost();
    this.host.onEvent((event) => this.onHostEvent(event));
  }

  handleMessage(message: DapMessage): void {
    if (message.type !== 'request') {
      return;
    }
    void this.dispatch(message);
  }

  async dispose(): Promise<void> {
    await this.host.dispose();
  }

  // -------------------------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------------------------

  private async dispatch(request: DapMessage): Promise<void> {
    const command = String(request.command ?? '');
    try {
      switch (command) {
        case 'initialize':
          this.respond(request, this.capabilities());
          return;

        case 'launch':
          await this.launch(request);
          return;

        case 'attach':
          await this.attach(request);
          return;

        case 'setBreakpoints':
          await this.setBreakpoints(request);
          return;

        case 'configurationDone':
          this.respond(request, {});
          await this.afterConfiguration();
          return;

        case 'threads':
          this.respond(request, { threads: [{ id: THREAD_ID, name: 'DataFlex' }] });
          return;

        case 'stackTrace':
          await this.stackTrace(request);
          return;

        case 'scopes':
          this.scopes(request);
          return;

        case 'variables':
          await this.variables(request);
          return;

        case 'evaluate':
          await this.evaluate(request);
          return;

        case 'continue':
          this.pendingStopReason = 'breakpoint';
          await this.resume('continue');
          this.respond(request, { allThreadsContinued: true });
          return;

        case 'next':
          this.pendingStopReason = 'step';
          await this.resume('stepOver');
          this.respond(request, {});
          return;

        case 'stepIn':
          this.pendingStopReason = 'step';
          await this.resume('stepInto');
          this.respond(request, {});
          return;

        case 'stepOut':
          this.pendingStopReason = 'step';
          await this.resume('stepOut');
          this.respond(request, {});
          return;

        case 'pause':
          this.pendingStopReason = 'pause';
          await this.host.send('pause');
          this.respond(request, {});
          return;

        case 'disconnect':
        case 'terminate':
          this.respond(request, {});
          await this.dispose();
          return;

        default:
          // Unknown requests are not errors: clients probe for capabilities they may not get.
          this.respond(request, {});
          return;
      }
    } catch (error) {
      this.fail(request, error instanceof Error ? error.message : String(error));
    }
  }

  private capabilities(): Record<string, unknown> {
    return {
      supportsConfigurationDoneRequest: true,
      supportsConditionalBreakpoints: true,
      supportsEvaluateForHovers: true,
      supportsTerminateRequest: true,
      // Nothing below is offered, and each absence is a real limit of the engine rather than an
      // omission: it exposes no way to write a variable, no data or function breakpoints, and no
      // second thread.
      supportsSetVariable: false,
      supportsFunctionBreakpoints: false,
      supportsDataBreakpoints: false,
      supportsHitConditionalBreakpoints: false,
      supportsStepBack: false,
      exceptionBreakpointFilters: []
    };
  }

  private async launch(request: DapMessage): Promise<void> {
    const args = (request.arguments ?? {}) as LaunchArguments;
    this.launchArguments = args;

    const program = args.program ?? '';
    if (program.length === 0) {
      this.fail(request, 'No program to debug. Set "program" in the launch configuration.');
      return;
    }

    const progId = await this.host.start(this.options.hostPath, this.options.progId);
    this.log(`debugger engine: ${progId}`);

    if (args.acceptNewWebAppSessions === true) {
      await this.host.trySend('acceptWebAppSessions', { value: true });
    }

    await this.host.send('start', {
      exe: program,
      cwd: args.cwd ?? '',
      webApp: args.webApp ?? false,
      url: args.url ?? '',
      noDebugHeap: args.noDebugHeap === true
    });

    const started = await this.host.once(
      (event) => event.event === 'init' || event.event === 'startupError' || event.event === 'initError',
      60_000
    );

    if (started.event !== 'init') {
      this.fail(request, String(started.message ?? 'the program could not be started'));
      await this.dispose();
      return;
    }

    // The program is loaded and waiting, which is the first moment breakpoints can be set, so this
    // is when the client is told to send them.
    this.stopped = true;
    this.respond(request, {});
    this.event('initialized', {});
  }

  private async attach(request: DapMessage): Promise<void> {
    const args = (request.arguments ?? {}) as AttachArguments;
    if (typeof args.processId !== 'number') {
      this.fail(request, 'No process to attach to. Set "processId" in the attach configuration.');
      return;
    }

    const progId = await this.host.start(this.options.hostPath, this.options.progId);
    this.log(`debugger engine: ${progId}`);
    await this.host.send('attach', { pid: args.processId });

    // Attaching to a program that is already running need not produce an init event promptly, so a
    // timeout here means "carry on", not "failed".
    await this.host
      .once((event) => event.event === 'init', 15_000)
      .catch(() => undefined);

    this.stopped = true;
    this.respond(request, {});
    this.event('initialized', {});
  }

  private async setBreakpoints(request: DapMessage): Promise<void> {
    const args = (request.arguments ?? {}) as {
      source?: { path?: string };
      breakpoints?: { line: number; condition?: string }[];
      lines?: number[];
    };
    const file = args.source?.path ?? '';
    const wanted = args.breakpoints ?? (args.lines ?? []).map((line) => ({ line, condition: undefined }));

    for (const line of this.applied.get(file) ?? []) {
      await this.host.trySend('removeBreakpoint', { file, line });
    }
    this.applied.set(file, []);

    const results: { verified: boolean; line: number; message?: string }[] = [];
    for (const breakpoint of wanted) {
      try {
        const reply = await this.host.send('setBreakpoint', {
          file,
          line: breakpoint.line,
          condition: breakpoint.condition ?? ''
        });
        const verified = reply.verified === true;
        // The engine moves a breakpoint to the next line carrying an instruction; report where it
        // actually landed, or the marker sits on a line nothing will ever stop at.
        const line = typeof reply.line === 'number' ? reply.line : breakpoint.line;
        if (verified) {
          this.applied.get(file)?.push(line);
        }
        results.push({
          verified,
          line,
          message: verified ? undefined : 'No executable instruction is compiled at this line.'
        });
      } catch (error) {
        results.push({
          verified: false,
          line: breakpoint.line,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    this.respond(request, { breakpoints: results });
  }

  private async afterConfiguration(): Promise<void> {
    if (this.launchArguments.stopOnEntry === true) {
      this.pendingStopReason = 'entry';
      this.reportStopped('entry');
      return;
    }
    await this.resume('continue');
  }

  private async resume(command: 'continue' | 'stepOver' | 'stepInto' | 'stepOut'): Promise<void> {
    this.stack = undefined;
    this.stopped = false;
    await this.host.send(command);
  }

  private async stackTrace(request: DapMessage): Promise<void> {
    const frames = await this.currentStack();
    const body = frames.map((frame) => {
      const context = frameContext(frame.file, frame.line);
      return {
        id: frame.level + 1,
        name: context.name,
        line: frame.line,
        column: 1,
        source: { name: baseName(frame.file), path: frame.file }
      };
    });

    this.respond(request, { stackFrames: body, totalFrames: body.length });
  }

  private scopes(request: DapMessage): void {
    const frameId = Number((request.arguments as { frameId?: number } | undefined)?.frameId ?? 1);
    this.respond(request, {
      scopes: [{ name: 'Locals', variablesReference: frameId, expensive: false }]
    });
  }

  private async variables(request: DapMessage): Promise<void> {
    const reference = Number((request.arguments as { variablesReference?: number } | undefined)?.variablesReference ?? 0);
    const level = reference - 1;
    const frames = await this.currentStack();
    const frame = frames.find((entry) => entry.level === level);
    if (frame === undefined) {
      this.respond(request, { variables: [] });
      return;
    }

    const context = frameContext(frame.file, frame.line);
    const variables: { name: string; value: string; type?: string; variablesReference: number }[] = [];

    // `Self` is not declared anywhere, so the parser cannot report it, but it is the single most
    // useful thing to see in a DataFlex frame: everything else is relative to it.
    const self = await this.evaluateAt('Self', level);
    if (self.success) {
      variables.push({ name: 'Self', value: self.value, type: 'Handle', variablesReference: 0 });
    }

    for (const local of context.locals) {
      const result = await this.evaluateAt(local.name, level);
      variables.push({
        name: local.name,
        value: result.success ? result.value : '<out of scope>',
        type: local.byRef === true ? `${local.type ?? ''} ByRef`.trim() : local.type,
        variablesReference: 0
      });
    }

    this.respond(request, { variables });
  }

  private async evaluate(request: DapMessage): Promise<void> {
    const args = (request.arguments ?? {}) as { expression?: string; frameId?: number; context?: string };
    const expression = args.expression ?? '';
    const level = typeof args.frameId === 'number' ? args.frameId - 1 : undefined;

    const result = await this.evaluateAt(expression, level);
    if (!result.success) {
      // A hover over something that is not an expression is the common case, and an error dialog
      // for it would be intolerable; the client shows nothing when the request fails.
      this.fail(request, result.value.length > 0 ? result.value : 'cannot be evaluated here');
      return;
    }

    this.respond(request, { result: result.value, variablesReference: 0 });
  }

  private async evaluateAt(expression: string, level?: number): Promise<{ success: boolean; value: string }> {
    if (expression.trim().length === 0) {
      return { success: false, value: '' };
    }

    try {
      const payload: Record<string, unknown> = { expr: expression };
      if (level !== undefined && level >= 0) {
        payload.level = level;
      }
      const reply = await this.host.send('eval', payload);
      return { success: reply.success === true, value: String(reply.value ?? '') };
    } catch (error) {
      return { success: false, value: error instanceof Error ? error.message : String(error) };
    }
  }

  private async currentStack(): Promise<EngineFrame[]> {
    if (this.stack !== undefined) {
      return this.stack;
    }
    if (!this.stopped) {
      return [];
    }

    const reply = await this.host.send('stack');
    const frames = Array.isArray(reply.frames) ? (reply.frames as EngineFrame[]) : [];
    this.stack = frames;
    return frames;
  }

  // -------------------------------------------------------------------------------------------
  // Engine events
  // -------------------------------------------------------------------------------------------

  private onHostEvent(event: HostEvent): void {
    switch (event.event) {
      case 'paused':
        this.stopped = true;
        this.stack = undefined;
        this.reportStopped(this.pendingStopReason);
        return;

      case 'continued':
        this.stopped = false;
        this.stack = undefined;
        this.event('continued', { threadId: THREAD_ID, allThreadsContinued: true });
        return;

      case 'exception':
        this.stopped = true;
        this.stack = undefined;
        this.output(`Unhandled exception: ${String(event.description ?? '')}\n`, 'stderr');
        this.reportStopped('exception', String(event.description ?? ''));
        return;

      case 'exit':
      case 'hostExit':
        this.reportTerminated();
        return;

      case 'startupError':
      case 'initError':
      case 'webAppError':
        this.output(`${String(event.message ?? '')}\n`, 'stderr');
        return;

      case 'breakpointError':
        // A condition that will not compile is the user's to fix, and silently never stopping is
        // the worst possible answer.
        this.output(`Breakpoint condition: ${String(event.message ?? '')}\n`, 'stderr');
        return;

      case 'webAppLog':
        this.output(`${String(event.text ?? '')}\n`);
        return;

      case 'webAppSession':
        this.output(
          event.accepted === true
            ? 'A new web app session took over the debug session.\n'
            : 'A new web app session was denied; the session being debugged continues.\n'
        );
        return;

      case 'fatal':
        this.output(`${String(event.message ?? '')}\n`, 'stderr');
        this.reportTerminated();
        return;

      case 'stderr':
        this.log(String(event.text ?? ''));
        return;

      default:
        return;
    }
  }

  private reportStopped(reason: string, description?: string): void {
    this.event('stopped', {
      reason,
      threadId: THREAD_ID,
      allThreadsStopped: true,
      ...(description !== undefined ? { description, text: description } : {})
    });
  }

  private reportTerminated(): void {
    if (this.terminated) {
      return;
    }
    this.terminated = true;
    this.event('terminated', {});
    this.event('exited', { exitCode: 0 });
  }

  // -------------------------------------------------------------------------------------------

  private respond(request: DapMessage, body: Record<string, unknown>): void {
    this.options.send({
      seq: this.sequence++,
      type: 'response',
      request_seq: request.seq,
      success: true,
      command: request.command,
      body
    });
  }

  private fail(request: DapMessage, message: string): void {
    this.options.send({
      seq: this.sequence++,
      type: 'response',
      request_seq: request.seq,
      success: false,
      command: request.command,
      message
    });
  }

  private event(event: string, body: Record<string, unknown>): void {
    this.options.send({ seq: this.sequence++, type: 'event', event, body });
  }

  private output(text: string, category: 'stdout' | 'stderr' = 'stdout'): void {
    this.event('output', { category, output: text });
  }

  private log(line: string): void {
    this.options.log?.(line.replace(/\s+$/, ''));
  }
}

function baseName(file: string): string {
  const parts = file.split(/[\\/]/);
  return parts[parts.length - 1] ?? file;
}
