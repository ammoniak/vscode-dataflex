/**
 * Drives the debug host through a whole session, headlessly.
 *
 * The COM engine cannot be unit tested -- it needs a DataFlex installation, a compiled program and
 * a message pump -- so this is the check that stands in for one. It goes through the same
 * `DebugHost` client the extension uses, so a break in either shows up here rather than as a debug
 * session in VS Code that silently does nothing.
 *
 *   npm run debug-host-check              a Windows desktop program
 *   npm run debug-host-check -- --webapp  a web application, browser and all
 *
 * Build the desktop target first, once:
 *   df-cli build-file "AppSrc/OrderPrecompile.pkg" --precompile --workspace "Order Entry.sws" \
 *     --toolchain 26.0.0+windows-64
 *   df-cli build "Order Entry.sws" --target Order
 *
 * The web application target is the shipped WebOrder example, which must be registered with the
 * WebApp Server (`df-cli webapp list` shows it).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DebugHost, type HostEvent } from '@vscode-dataflex/debug';

const ROOT = join(import.meta.dirname, '..');
/** The published host first, then the plain build output, so either build step is enough. */
const HOST =
  [
    join(ROOT, 'packages', 'vscode-dataflex', 'host', 'dataflex-debug-host.exe'),
    join(ROOT, 'packages', 'df-debug-host', 'bin', 'Release', 'net8.0-windows', 'win-x64', 'dataflex-debug-host.exe')
  ].find((candidate) => existsSync(candidate)) ?? '';

const webAppMode = process.argv.includes('--webapp');

interface Target {
  label: string;
  workspace: string;
  exe: string;
  source: string;
  /** A line that runs without anyone touching the program. */
  line: number;
  webApp: boolean;
  url?: string;
  /** A local that has a value a couple of steps after the breakpoint. */
  local?: string;
}

const DESKTOP: Target = {
  label: 'Order Entry (Windows desktop)',
  workspace: 'C:\\DataFlex 26.0 Examples\\Order Entry',
  exe: 'C:\\DataFlex 26.0 Examples\\Order Entry\\Programs\\Order64.exe',
  source: 'C:\\DataFlex 26.0 Examples\\Order Entry\\AppSrc\\Order.src',
  // `Get OptionsObject to hoOptions`, inside OnCreateCommandBars, which runs during startup.
  line: 45,
  webApp: false,
  local: 'hoOptions'
};

const WEBAPP: Target = {
  label: 'WebOrder (web application)',
  workspace: 'C:\\DataFlex 26.0 Examples\\WebOrder',
  exe: 'C:\\DataFlex 26.0 Examples\\WebOrder\\Programs\\WebApp.exe',
  source: 'C:\\DataFlex 26.0 Examples\\WebOrder\\AppSrc\\WebApp.src',
  // `Set psTheme`, during construction of oWebApp, which runs when a session starts.
  line: 13,
  webApp: true,
  url: 'http://localhost/WebOrder/'
};

const target = webAppMode ? WEBAPP : DESKTOP;

/** Buffers events, because a wait can be set up after the event it wants has already arrived. */
class Events {
  private readonly seen: HostEvent[] = [];
  private readonly waiters: { name: string; resolve: (event: HostEvent) => void }[] = [];

  constructor(host: DebugHost) {
    host.onEvent((event) => {
      const waiter = this.waiters.findIndex((entry) => entry.name === event.event);
      if (waiter >= 0) {
        this.waiters.splice(waiter, 1)[0]!.resolve(event);
        return;
      }
      this.seen.push(event);
    });
  }

  wait(name: string, timeoutMs: number): Promise<HostEvent> {
    const index = this.seen.findIndex((event) => event.event === name);
    if (index >= 0) {
      return Promise.resolve(this.seen.splice(index, 1)[0]!);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for '${name}'`)), timeoutMs);
      this.waiters.push({
        name,
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event);
        }
      });
    });
  }
}

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) {
    failures++;
  }
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `  ${detail}` : ''}`);
}

async function main(): Promise<void> {
  if (HOST.length === 0) {
    console.error('Host not built. Run: npm run debug-host-build');
    process.exit(1);
  }
  if (!existsSync(target.exe)) {
    console.error(`Target not built: ${target.exe}\nSee the header of this file.`);
    process.exit(1);
  }

  console.log(`${target.label}\n`);

  const host = new DebugHost();
  const events = new Events(host);

  try {
    const progId = await host.start(HOST);
    check('engine created', true, progId);

    await host.send('start', {
      exe: target.exe,
      cwd: target.workspace,
      webApp: target.webApp,
      url: target.url ?? ''
    });
    await events.wait('init', 60_000);
    check('program initialised', true);

    const valid = await host.send('isValidSource', { file: target.source });
    check('source is part of the program', valid.valid === true);

    const bp = await host.send('setBreakpoint', { file: target.source, line: target.line });
    check('breakpoint verified', bp.verified === true, `line ${String(bp.line)}`);

    await host.send('continue');
    // A web application does not run until a request arrives; the engine opens a browser for it,
    // so this waits on a page load rather than on the program alone.
    const paused = await events.wait('paused', webAppMode ? 120_000 : 30_000);
    check(
      'stopped at the breakpoint',
      String(paused.file).toLowerCase() === target.source.toLowerCase(),
      `${String(paused.file)}:${String(paused.line)}`
    );

    const self = await host.send('eval', { expr: 'Self' });
    check('evaluates in the paused frame', self.success === true, `Self = ${String(self.value)}`);

    const stack = await host.send('stack');
    const frames = (stack.frames ?? []) as { level: number; file: string; line: number }[];
    check('call stack has frames', frames.length > 0, `${frames.length} frames`);
    check(
      'innermost frame is the paused location',
      frames.length > 0 && frames[0]!.file.toLowerCase() === target.source.toLowerCase(),
      frames.length > 0 ? `${frames[0]!.file}:${frames[0]!.line}` : ''
    );
    check('outermost frame is level 0', frames.length > 0 && frames[frames.length - 1]!.level === 0);
    for (const frame of frames.slice(0, 4)) {
      console.log(`         level ${frame.level}  ${frame.file}:${frame.line}`);
    }

    if (target.local !== undefined) {
      // Step past the assignment so the local has a value to read.
      for (let i = 0; i < 2; i++) {
        await host.send('stepOver');
        await events.wait('paused', 15_000);
      }

      const inFrame = await host.send('eval', { expr: target.local });
      check('local evaluates in its own frame', inFrame.success === true && inFrame.value !== '', String(inFrame.value));

      // Scoping is what makes per-frame variables possible: the local must resolve in its own
      // frame and not in its caller.
      const inCaller = await host.send('eval', { expr: target.local, level: 0 });
      check('eval is scoped to the selected frame', inCaller.success === false);
    }

    await host.send('stop');
    await events.wait('exit', 20_000);
    check('program exited', true);
  } catch (error) {
    failures++;
    console.error(` FAIL  ${(error as Error).message}`);
  } finally {
    await host.dispose();
  }

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
