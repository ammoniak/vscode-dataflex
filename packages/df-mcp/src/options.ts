import { isAbsolute, dirname, resolve } from 'node:path';
import { Writable } from 'node:stream';

export interface Options {
  /** Folder to resolve the workspace from. */
  root: string;
  /** An exact `.sws`, when one was named. */
  sws?: string;
  /** Whether the tools that run a compiler or a program are registered at all. */
  allowExecute: boolean;
}

/**
 * Where the workspace comes from: `--sws`, then `--root`, then the environment, then the cwd.
 *
 * The cwd default is what makes a bare `claude mcp add` work at all -- an MCP server is spawned
 * with the client's working directory, so a registration with no arguments still lands in the
 * DataFlex workspace the user has open.
 */
export function parseArgv(argv: readonly string[], env: NodeJS.ProcessEnv = {}): Options {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const sws = flag('--sws') ?? env['DATAFLEX_SWS'];
  const explicitRoot = flag('--root') ?? env['DATAFLEX_WORKSPACE'];

  const root =
    explicitRoot !== undefined
      ? resolve(explicitRoot)
      : sws !== undefined && isAbsolute(sws)
        ? dirname(resolve(sws))
        : process.cwd();

  return {
    root,
    ...(sws === undefined ? {} : { sws: resolve(sws) }),
    allowExecute: argv.includes('--allow-execute') || env['DATAFLEX_MCP_ALLOW_EXECUTE'] === '1'
  };
}

/**
 * Takes stdout away from everything except the transport, which is handed it back.
 *
 * Stdout *is* the JSON-RPC channel. One `console.log` from anywhere in the libraries below --
 * and `df-workspace` and `df-coverage` both print freely, because they were written for scripts --
 * corrupts a frame, and the client sees a server that connected and then hung.
 *
 * So the real `write` is captured first and returned as a stream for `StdioServerTransport` to
 * own, and only then is the one on `process.stdout` replaced. Redirecting stdout without handing
 * the transport an escape hatch silently redirects the server's own replies too, which looks
 * exactly like the failure it was meant to prevent.
 */
export function guardStdout(): Writable {
  const stdout = process.stdout;
  const write = stdout.write.bind(stdout);

  // Backpressure stays honest: the adapter holds each chunk until the real stream reports it
  // flushed, so `drain` still means what the transport thinks it means.
  const channel = new Writable({
    write(chunk: Buffer, _encoding, callback): void {
      write(chunk, (error) => callback(error ?? null));
    }
  });

  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) =>
    (process.stderr.write as (...args: unknown[]) => boolean)(
      chunk,
      ...rest
    )) as typeof process.stdout.write;

  return channel;
}
