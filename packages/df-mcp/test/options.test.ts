import { isAbsolute, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { guardStdout, parseArgv } from '../src/options';

const ROOT = resolve('/ws/MyApp');
const SWS = resolve('/ws/MyApp/MyApp.sws');

describe('parseArgv', () => {
  it('falls back to the working directory, which is what a bare registration relies on', () => {
    expect(parseArgv([], {}).root).toBe(process.cwd());
  });

  it('takes --root over the working directory', () => {
    expect(parseArgv(['--root', ROOT], {}).root).toBe(ROOT);
  });

  it('derives the root from an absolute --sws', () => {
    const options = parseArgv(['--sws', SWS], {});

    expect(options.sws).toBe(SWS);
    expect(options.root).toBe(ROOT);
  });

  it('lets --root win over the folder an absolute --sws sits in', () => {
    expect(parseArgv(['--sws', resolve('/other/a.sws'), '--root', ROOT], {}).root).toBe(ROOT);
  });

  it('reads the environment when no flag is given', () => {
    expect(parseArgv([], { DATAFLEX_WORKSPACE: ROOT }).root).toBe(ROOT);
    expect(parseArgv([], { DATAFLEX_SWS: SWS }).sws).toBe(SWS);
  });

  it('always returns an absolute root', () => {
    expect(isAbsolute(parseArgv(['--root', '.'], {}).root)).toBe(true);
  });

  it('leaves execution off unless it is asked for', () => {
    expect(parseArgv([], {}).allowExecute).toBe(false);
    expect(parseArgv(['--allow-execute'], {}).allowExecute).toBe(true);
    expect(parseArgv([], { DATAFLEX_MCP_ALLOW_EXECUTE: '1' }).allowExecute).toBe(true);
    expect(parseArgv([], { DATAFLEX_MCP_ALLOW_EXECUTE: '0' }).allowExecute).toBe(false);
  });
});

describe('guardStdout', () => {
  const original = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    write: process.stdout.write
  };

  afterEach(() => {
    console.log = original.log;
    console.info = original.info;
    console.debug = original.debug;
    process.stdout.write = original.write;
    vi.restoreAllMocks();
  });

  it('routes a stray console.log away from stdout, where it would corrupt a JSON-RPC frame', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    guardStdout();
    console.log('a library printing to stdout');
    console.info('and another');
    console.debug('and another');

    expect(error).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledWith('a library printing to stdout');
  });

  it('redirects a direct process.stdout.write too', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    guardStdout();
    process.stdout.write('raw bytes');

    expect(stderr).toHaveBeenCalledWith('raw bytes');
  });
});
