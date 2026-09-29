import { describe, expect, it } from 'vitest';
import {
  DataflexDebugSession,
  type DapMessage,
  type DebugHostLike,
  type HostEvent,
  type HostReply
} from '../src';

/**
 * The debug adapter, driven against a scripted engine.
 *
 * The real engine needs a DataFlex installation, a compiled program and a message pump, so what it
 * would cost to test here is covered by `npm run debug-host-check` instead. What is left is
 * everything the adapter decides on its own, and all of it is the kind of thing that fails
 * silently: a breakpoint reported at the line that was asked for rather than the line the engine
 * moved it to, a frame numbering scheme that is off by one, a stop reported as the wrong reason.
 */

class FakeHost implements DebugHostLike {
  readonly sent: { cmd: string; args: Record<string, unknown> }[] = [];
  private readonly listeners: ((event: HostEvent) => void)[] = [];

  /** Scripted replies, by command. */
  replies: Record<string, HostReply | ((args: Record<string, unknown>) => HostReply)> = {};
  /** Commands that should reject, as the engine does when it refuses one. */
  failures = new Set<string>();

  start(): Promise<string> {
    return Promise.resolve('VDFDebugger.DebuggerEngine.26.0');
  }

  onEvent(listener: (event: HostEvent) => void): void {
    this.listeners.push(listener);
  }

  send(cmd: string, extra: Record<string, unknown> = {}): Promise<HostReply> {
    this.sent.push({ cmd, args: extra });
    if (this.failures.has(cmd)) {
      return Promise.reject(new Error(`engine refused ${cmd}`));
    }
    const reply = this.replies[cmd];
    const body = typeof reply === 'function' ? reply(extra) : (reply ?? {});
    return Promise.resolve({ ok: true, ...body });
  }

  async trySend(cmd: string, extra: Record<string, unknown> = {}): Promise<HostReply | undefined> {
    try {
      return await this.send(cmd, extra);
    } catch {
      return undefined;
    }
  }

  once(match: (event: HostEvent) => boolean): Promise<HostEvent> {
    return new Promise((resolve) => {
      this.listeners.push(function listener(event) {
        if (match(event)) {
          resolve(event);
        }
      });
    });
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }

  /** Raises an engine event, as the host would. */
  raise(event: HostEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  commands(): string[] {
    return this.sent.map((entry) => entry.cmd);
  }
}

/** Drives a session and collects everything it sends back. */
function session(host: FakeHost): { session: DataflexDebugSession; out: DapMessage[] } {
  const out: DapMessage[] = [];
  const instance = new DataflexDebugSession({
    hostPath: 'dataflex-debug-host.exe',
    send: (message) => out.push(message),
    createHost: () => host
  });
  return { session: instance, out };
}

let sequence = 100;

function request(command: string, args?: Record<string, unknown>): DapMessage {
  return { seq: sequence++, type: 'request', command, arguments: args };
}

/** Lets the session's promise chain settle; every handler is async. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function responseTo(out: DapMessage[], command: string): DapMessage | undefined {
  return out.filter((m) => m.type === 'response' && m.command === command).pop();
}

function eventsNamed(out: DapMessage[], name: string): DapMessage[] {
  return out.filter((m) => m.type === 'event' && m.event === name);
}

/** Launches and gets as far as a stop, which most of the interesting requests need. */
async function launched(host: FakeHost): Promise<{ session: DataflexDebugSession; out: DapMessage[] }> {
  const context = session(host);
  context.session.handleMessage(request('initialize'));
  await settle();

  context.session.handleMessage(request('launch', { program: 'C:\\ws\\Programs\\App64.exe', cwd: 'C:\\ws' }));
  await settle();
  host.raise({ event: 'init' });
  await settle();
  return context;
}

describe('initialize', () => {
  it('claims only what the engine can actually do', async () => {
    const { session: instance, out } = session(new FakeHost());
    instance.handleMessage(request('initialize'));
    await settle();

    const body = responseTo(out, 'initialize')?.body as Record<string, unknown>;
    expect(body.supportsConfigurationDoneRequest).toBe(true);
    expect(body.supportsConditionalBreakpoints).toBe(true);
    expect(body.supportsEvaluateForHovers).toBe(true);
    // The engine offers no way to write a variable back, so the pane must not offer editing.
    expect(body.supportsSetVariable).toBe(false);
    expect(body.supportsStepBack).toBe(false);
  });
});

describe('launch', () => {
  it('waits for the program to load before asking for breakpoints', async () => {
    const host = new FakeHost();
    const { session: instance, out } = session(host);
    instance.handleMessage(request('launch', { program: 'App64.exe', cwd: 'C:\\ws' }));
    await settle();

    // Breakpoints are refused before the program is loaded, so the client must not be invited to
    // send them yet.
    expect(eventsNamed(out, 'initialized')).toHaveLength(0);

    host.raise({ event: 'init' });
    await settle();
    expect(eventsNamed(out, 'initialized')).toHaveLength(1);
    expect(responseTo(out, 'launch')?.success).toBe(true);
  });

  it('reports a startup failure instead of hanging', async () => {
    const host = new FakeHost();
    const { session: instance, out } = session(host);
    instance.handleMessage(request('launch', { program: 'App64.exe' }));
    await settle();

    host.raise({ event: 'startupError', message: 'the program is not compiled with debug information' });
    await settle();

    const response = responseTo(out, 'launch');
    expect(response?.success).toBe(false);
    expect(response?.message).toContain('debug information');
  });

  it('refuses a configuration with no program', async () => {
    const { session: instance, out } = session(new FakeHost());
    instance.handleMessage(request('launch', {}));
    await settle();
    expect(responseTo(out, 'launch')?.success).toBe(false);
  });

  it('passes the web app flag and url through', async () => {
    const host = new FakeHost();
    const { session: instance } = session(host);
    instance.handleMessage(
      request('launch', { program: 'WebApp.exe', webApp: true, url: 'http://localhost/WebOrder' })
    );
    await settle();

    const start = host.sent.find((entry) => entry.cmd === 'start');
    expect(start?.args.webApp).toBe(true);
    expect(start?.args.url).toBe('http://localhost/WebOrder');
  });
});

describe('setBreakpoints', () => {
  it('reports the line the engine moved the breakpoint to', async () => {
    const host = new FakeHost();
    // Asking for a blank line: the engine binds to the next line carrying an instruction.
    host.replies.setBreakpoint = (args) => ({ verified: true, line: Number(args.line) + 2 });
    const { session: instance, out } = await launched(host);

    instance.handleMessage(
      request('setBreakpoints', { source: { path: 'C:\\ws\\AppSrc\\Order.src' }, breakpoints: [{ line: 40 }] })
    );
    await settle();

    const breakpoints = (responseTo(out, 'setBreakpoints')?.body as { breakpoints: unknown[] }).breakpoints;
    expect(breakpoints).toEqual([{ verified: true, line: 42, message: undefined }]);
  });

  it('marks a line with no instruction unverified, with a reason', async () => {
    const host = new FakeHost();
    host.replies.setBreakpoint = () => ({ verified: false, line: 7 });
    const { session: instance, out } = await launched(host);

    instance.handleMessage(
      request('setBreakpoints', { source: { path: 'Order.src' }, breakpoints: [{ line: 7 }] })
    );
    await settle();

    const breakpoints = (responseTo(out, 'setBreakpoints')?.body as { breakpoints: { verified: boolean; message?: string }[] })
      .breakpoints;
    expect(breakpoints[0]!.verified).toBe(false);
    expect(breakpoints[0]!.message).toContain('No executable instruction');
  });

  it('clears the breakpoints it previously set in that file', async () => {
    const host = new FakeHost();
    host.replies.setBreakpoint = (args) => ({ verified: true, line: Number(args.line) });
    const { session: instance } = await launched(host);

    instance.handleMessage(
      request('setBreakpoints', { source: { path: 'Order.src' }, breakpoints: [{ line: 10 }] })
    );
    await settle();
    instance.handleMessage(
      request('setBreakpoints', { source: { path: 'Order.src' }, breakpoints: [{ line: 20 }] })
    );
    await settle();

    // Without this the first breakpoint stays armed in the engine and the program stops at a line
    // the editor no longer shows a marker on.
    const removals = host.sent.filter((entry) => entry.cmd === 'removeBreakpoint');
    expect(removals).toHaveLength(1);
    expect(removals[0]!.args.line).toBe(10);
  });

  it('survives a breakpoint the engine rejects outright', async () => {
    const host = new FakeHost();
    host.failures.add('setBreakpoint');
    const { session: instance, out } = await launched(host);

    instance.handleMessage(
      request('setBreakpoints', { source: { path: 'Nowhere.src' }, breakpoints: [{ line: 3 }] })
    );
    await settle();

    const response = responseTo(out, 'setBreakpoints');
    expect(response?.success).toBe(true);
    const breakpoints = (response?.body as { breakpoints: { verified: boolean }[] }).breakpoints;
    expect(breakpoints[0]!.verified).toBe(false);
  });
});

describe('configurationDone', () => {
  it('runs the program when stopOnEntry is not asked for', async () => {
    const host = new FakeHost();
    const { session: instance } = await launched(host);
    instance.handleMessage(request('configurationDone'));
    await settle();
    expect(host.commands()).toContain('continue');
  });

  it('stops at entry when asked, without running anything', async () => {
    const host = new FakeHost();
    const context = session(host);
    context.session.handleMessage(request('launch', { program: 'App64.exe', stopOnEntry: true }));
    await settle();
    host.raise({ event: 'init' });
    await settle();

    context.session.handleMessage(request('configurationDone'));
    await settle();

    expect(host.commands()).not.toContain('continue');
    const stopped = eventsNamed(context.out, 'stopped');
    expect((stopped[0]?.body as { reason: string }).reason).toBe('entry');
  });
});

describe('stopping', () => {
  it('reports a stop after a step as a step, not a breakpoint', async () => {
    const host = new FakeHost();
    const { session: instance, out } = await launched(host);

    instance.handleMessage(request('next'));
    await settle();
    host.raise({ event: 'paused', file: 'Order.src', line: 46 });
    await settle();

    const stopped = eventsNamed(out, 'stopped').pop();
    expect((stopped?.body as { reason: string }).reason).toBe('step');
  });

  it('reports an unhandled exception as an exception stop', async () => {
    const host = new FakeHost();
    const { out } = await launched(host);
    host.raise({ event: 'exception', description: 'Error 98: Invalid message' });
    await settle();

    const stopped = eventsNamed(out, 'stopped').pop();
    expect((stopped?.body as { reason: string }).reason).toBe('exception');
    expect(eventsNamed(out, 'output').some((m) => String((m.body as { output: string }).output).includes('Error 98'))).toBe(
      true
    );
  });

  it('terminates once, however many ways the program ends', async () => {
    const host = new FakeHost();
    const { out } = await launched(host);
    host.raise({ event: 'exit' });
    host.raise({ event: 'hostExit', code: 0 });
    await settle();
    expect(eventsNamed(out, 'terminated')).toHaveLength(1);
  });

  it('surfaces a broken breakpoint condition rather than silently never stopping', async () => {
    const host = new FakeHost();
    const { out } = await launched(host);
    host.raise({ event: 'breakpointError', message: "'nosuch': undefined symbol" });
    await settle();

    const output = eventsNamed(out, 'output').map((m) => String((m.body as { output: string }).output));
    expect(output.some((line) => line.includes('undefined symbol'))).toBe(true);
  });
});

describe('stack and evaluation', () => {
  const FRAMES = [
    { level: 14, file: 'C:\\ws\\AppSrc\\Order.src', line: 47 },
    { level: 13, file: 'C:\\Pkg\\cCJCommandBarSystem.pkg', line: 1154 },
    { level: 0, file: 'C:\\ws\\AppSrc\\Order.src', line: 729 }
  ];

  async function stopped(): Promise<{ host: FakeHost; session: DataflexDebugSession; out: DapMessage[] }> {
    const host = new FakeHost();
    host.replies.stack = { frames: FRAMES };
    const context = await launched(host);
    host.raise({ event: 'paused', file: FRAMES[0]!.file, line: FRAMES[0]!.line });
    await settle();
    return { host, ...context };
  }

  it('numbers frames so that ids survive the round trip to variables', async () => {
    const { session: instance, out } = await stopped();
    instance.handleMessage(request('stackTrace', { threadId: 1 }));
    await settle();

    const frames = (responseTo(out, 'stackTrace')?.body as { stackFrames: { id: number; line: number }[] }).stackFrames;
    expect(frames.map((frame) => frame.id)).toEqual([15, 14, 1]);
    expect(frames[0]!.line).toBe(47);
  });

  it('evaluates in the frame the user selected, not the innermost one', async () => {
    const { host, session: instance } = await stopped();
    host.replies.eval = { success: true, value: '111' };

    instance.handleMessage(request('evaluate', { expression: 'hoOptions', frameId: 1, context: 'watch' }));
    await settle();

    // Frame id 1 is queue level 0. Getting this wrong reads the wrong frame's locals and is
    // invisible until two frames happen to declare the same name.
    const evaluate = host.sent.filter((entry) => entry.cmd === 'eval').pop();
    expect(evaluate?.args.level).toBe(0);
  });

  it('reports a failed evaluation as a failed request, so a hover shows nothing', async () => {
    const { host, session: instance, out } = await stopped();
    host.replies.eval = { success: false, value: "'x': undefined symbol, or variable out of scope" };

    instance.handleMessage(request('evaluate', { expression: 'x', frameId: 15, context: 'hover' }));
    await settle();

    expect(responseTo(out, 'evaluate')?.success).toBe(false);
  });

  it('has no stack while the program is running', async () => {
    const { session: instance, out } = await stopped();
    instance.handleMessage(request('continue'));
    await settle();

    instance.handleMessage(request('stackTrace', { threadId: 1 }));
    await settle();

    const frames = (responseTo(out, 'stackTrace')?.body as { stackFrames: unknown[] }).stackFrames;
    expect(frames).toEqual([]);
  });
});

describe('attach', () => {
  it('refuses without a process id', async () => {
    const { session: instance, out } = session(new FakeHost());
    instance.handleMessage(request('attach', {}));
    await settle();
    expect(responseTo(out, 'attach')?.success).toBe(false);
  });

  it('attaches to the process it was given', async () => {
    const host = new FakeHost();
    const { session: instance } = session(host);
    instance.handleMessage(request('attach', { processId: 4242 }));
    await settle();
    host.raise({ event: 'init' });
    await settle();

    expect(host.sent.find((entry) => entry.cmd === 'attach')?.args.pid).toBe(4242);
  });
});
