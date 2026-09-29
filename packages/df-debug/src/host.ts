import { type ChildProcess, spawn } from 'node:child_process';

/**
 * The debug host process, and the line-delimited JSON conversation with it.
 *
 * The host owns the COM debugger engine because that engine is apartment-threaded and delivers its
 * events through a connection point, which needs a thread with a message pump. Everything else --
 * the protocol, the scope rules, the presentation -- stays here in TypeScript, where the parser
 * already lives.
 */

/** An unsolicited message from the engine. */
export interface HostEvent {
  event: string;
  [key: string]: unknown;
}

/** A reply to one command. */
export interface HostReply {
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
}

export class HostError extends Error {}

export class DebugHost {
  private child: ChildProcess | undefined;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: HostReply) => void; reject: (e: Error) => void }>();
  private readonly listeners: ((event: HostEvent) => void)[] = [];
  /** Rejectors for outstanding `once` waits, so a dead host fails them instead of hanging. */
  private readonly waiters = new Set<(error: Error) => void>();
  private exited = false;

  /**
   * Starts the host and waits for it to report that the engine was created.
   *
   * @returns the ProgID it bound to, which is worth logging: on a machine with several DataFlex
   * versions installed, which engine answered decides which programs can be debugged at all.
   */
  async start(hostPath: string, progId?: string): Promise<string> {
    const args = progId !== undefined && progId.length > 0 ? ['--prog-id', progId] : [];
    const child = spawn(hostPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.receive(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => this.emit({ event: 'stderr', text: chunk }));
    child.on('exit', (code) => {
      this.exited = true;
      this.failPending(new HostError(`the debug host exited with code ${String(code)}`));
      this.emit({ event: 'hostExit', code });
    });
    child.on('error', (error) => {
      this.exited = true;
      this.failPending(new HostError(`the debug host could not start: ${error.message}`));
    });

    const ready = await this.once((event) => event.event === 'ready' || event.event === 'fatal', 30_000);
    if (ready.event === 'fatal') {
      throw new HostError(String(ready.message ?? 'the debugger engine could not be created'));
    }
    return String(ready.progId ?? 'unknown');
  }

  onEvent(listener: (event: HostEvent) => void): void {
    this.listeners.push(listener);
  }

  /** Sends a command and resolves with its reply, or rejects if the engine refused it. */
  send(cmd: string, extra: Record<string, unknown> = {}): Promise<HostReply> {
    if (this.child === undefined || this.exited) {
      return Promise.reject(new HostError('the debug host is not running'));
    }

    const id = this.nextId++;
    return new Promise<HostReply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child?.stdin?.write(`${JSON.stringify({ id, cmd, ...extra })}\n`);
    });
  }

  /**
   * Sends a command whose failure is not worth surfacing.
   *
   * Shutdown paths mostly: stopping a program that has already exited is a normal race, not
   * something a user needs told about.
   */
  async trySend(cmd: string, extra: Record<string, unknown> = {}): Promise<HostReply | undefined> {
    try {
      return await this.send(cmd, extra);
    } catch {
      return undefined;
    }
  }

  once(match: (event: HostEvent) => boolean, timeoutMs: number): Promise<HostEvent> {
    return new Promise<HostEvent>((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer);
        const index = this.listeners.indexOf(listener);
        if (index >= 0) {
          this.listeners.splice(index, 1);
        }
        this.waiters.delete(fail);
      };

      const timer = setTimeout(() => {
        done();
        reject(new HostError('timed out waiting for the debugger engine'));
      }, timeoutMs);

      const listener = (event: HostEvent): void => {
        if (!match(event)) {
          return;
        }
        done();
        resolve(event);
      };

      // A host that dies while something is waiting on it must fail that wait, not leave it to
      // time out: the wait for a program to start is 60 seconds, and a minute of a debug session
      // that has already ended looks exactly like a hang.
      const fail = (error: Error): void => {
        done();
        reject(error);
      };

      this.listeners.push(listener);
      this.waiters.add(fail);
    });
  }

  async dispose(): Promise<void> {
    if (this.child === undefined) {
      return;
    }
    await this.trySend('stop');
    await this.trySend('shutdown');
    this.child.stdin?.end();
    // The host stops itself when stdin closes; the kill is for the case where it does not.
    setTimeout(() => this.child?.kill(), 2_000).unref?.();
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
      if (line.length > 0) {
        this.dispatch(line);
      }
    }
  }

  private dispatch(line: string): void {
    let message: HostReply & { id?: number; event?: string };
    try {
      message = JSON.parse(line) as HostReply & { id?: number; event?: string };
    } catch {
      this.emit({ event: 'stderr', text: line });
      return;
    }

    if (typeof message.id === 'number') {
      const waiter = this.pending.get(message.id);
      if (waiter !== undefined) {
        this.pending.delete(message.id);
        if (message.ok === false) {
          waiter.reject(new HostError(String(message.error ?? 'the debugger engine refused the request')));
        } else {
          waiter.resolve(message);
        }
      }
      return;
    }

    if (typeof message.event === 'string') {
      this.emit(message as HostEvent);
    }
  }

  private emit(event: HostEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  private failPending(error: Error): void {
    for (const waiter of this.pending.values()) {
      waiter.reject(error);
    }
    this.pending.clear();

    for (const fail of [...this.waiters]) {
      fail(error);
    }
    this.waiters.clear();
  }
}
