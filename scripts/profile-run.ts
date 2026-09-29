/**
 * Profiles a DataFlex Windows program end to end, without VS Code.
 *
 * The counterpart of `coverage-run.ts`, and it exists for the same reason: the extension's own
 * profiling path can only be exercised inside an extension host, which makes it awkward to prove
 * that instrumented source still compiles and that a real run writes real numbers.
 *
 * Usage: npm run profile-run -- <workspace.sws> <project.src> [--seconds N] [--keep] [--dry-run]
 *
 * A Windows program runs until it is closed, so `--seconds` says how long to let it run before
 * asking it to close. That request is a normal window close, not a kill: the timings are written
 * from the shutdown broadcast, which a killed process never sends.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  IncludeResolver,
  coverageTargets,
  cliForWorkspace,
  loadWorkspace,
  runDfCli
} from '../packages/df-workspace/src/index';
import { isWorkspaceOwnedFile } from '../packages/df-langserver/src/analysis/workspaceFiles';
import { collectProfile, formatProfile, writeOverlay } from '../packages/df-coverage/src/index';

const RUNTIME_DIR = resolve(__dirname, '..', 'packages', 'df-coverage', 'runtime');

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function numberFlag(name: string, fallback: number): number {
  const at = process.argv.indexOf(name);
  if (at < 0) {
    return fallback;
  }
  const value = Number(process.argv[at + 1]);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Runs the program, then asks its window to close.
 *
 * `CloseMainWindow` rather than `kill`: it posts WM_CLOSE, so the application shuts down the way a
 * user closing it would and the desktop broadcasts its exit notification. A kill would leave
 * nothing written, which is exactly the failure this script is meant to catch.
 */
function runAndClose(executable: string, cwd: string, seconds: number): Promise<number> {
  return new Promise((done) => {
    const child = spawn(executable, [], { cwd, windowsHide: false });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));

    const closer = setTimeout(() => {
      console.log(`asking ${basename(executable)} (pid ${child.pid}) to close...`);
      spawn(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }`
        ],
        { windowsHide: true }
      );
    }, seconds * 1000);

    // A program that ignores the close request would otherwise hang this script forever.
    const giveUp = setTimeout(() => {
      console.log('it did not close; killing it (no timings will be written).');
      child.kill();
    }, (seconds + 60) * 1000);

    child.on('error', (error) => {
      clearTimeout(closer);
      clearTimeout(giveUp);
      console.error(`failed to start: ${error.message}`);
      done(-1);
    });
    child.on('close', (code) => {
      clearTimeout(closer);
      clearTimeout(giveUp);
      if (output.trim().length > 0) {
        console.log(output.trim());
      }
      done(code ?? -1);
    });
  });
}

/** `<stem>.exe` or `<stem>64.exe`, whichever the toolchain produced; newest wins. */
function findProgram(directory: string, stem: string): string | undefined {
  const candidates = [join(directory, `${stem}.exe`), join(directory, `${stem}64.exe`)].filter(
    (path) => existsSync(path)
  );
  if (candidates.length <= 1) {
    return candidates[0];
  }
  return candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

async function main(): Promise<void> {
  const flags = new Set(['--keep', '--dry-run']);
  const args = process.argv
    .slice(2)
    .filter((arg, index, all) => !flags.has(arg) && arg !== '--seconds' && all[index - 1] !== '--seconds');
  const dryRun = process.argv.includes('--dry-run');
  const keep = process.argv.includes('--keep') || dryRun;
  const seconds = numberFlag('--seconds', 20);

  const swsPath = args[0];
  const projectName = args[1];
  if (swsPath === undefined || projectName === undefined) {
    fail('Usage: npm run profile-run -- <workspace.sws> <project.src> [--seconds N] [--keep]');
  }

  const { cliPath, warning } = await cliForWorkspace(resolve(swsPath));
  if (cliPath === undefined) {
    fail('df-cli.exe not found.');
  }
  if (warning !== undefined) {
    console.warn(warning);
  }

  const workspace = await loadWorkspace(cliPath, resolve(swsPath));
  if (workspace === undefined) {
    fail(`df-cli could not open ${swsPath}`);
  }

  const resolver = new IncludeResolver(workspace.searchPath);
  const entry = resolver.resolve(projectName);
  if (entry === undefined) {
    fail(`Could not resolve ${projectName} on the workspace search path.`);
  }

  console.log(`workspace          : ${swsPath}`);
  console.log(`project            : ${projectName}`);
  console.log(`entry              : ${entry}`);

  const targets = coverageTargets({
    entry,
    resolver,
    searchPath: workspace.searchPath,
    root: workspace.root,
    isOwned: isWorkspaceOwnedFile
  });
  console.log(`files to instrument: ${targets.length}`);

  const scratch = mkdtempSync(join(tmpdir(), 'dataflex-profile-'));
  const programs = join(workspace.root, 'Programs');
  let executable: string | undefined;

  try {
    const overlay = writeOverlay({
      entry,
      targets,
      scratch,
      runtimeDirectory: RUNTIME_DIR,
      mode: 'profile',
      flushStyle: 'exitBroadcast'
    });
    console.log(`method probes      : ${overlay.plan.probes.length}`);
    console.log(`overlay files      : ${overlay.plan.files.length}`);
    if (overlay.plan.skipped.length > 0) {
      console.log(`unprobeable methods: ${overlay.plan.skipped.length}`);
    }
    if (dryRun) {
      console.log(`generated program  : ${overlay.entrySource}`);
      return;
    }

    console.log('\n--- building ---');
    const build = await runDfCli(
      cliPath,
      [
        'build-file',
        overlay.entrySource,
        '--workspace',
        resolve(swsPath),
        '--output-dir',
        programs,
        '--rebuild',
        '-I',
        overlay.overlayDir,
        '-I',
        overlay.runtimeDir
      ],
      workspace.root
    );
    console.log((build.stdout + build.stderr).trim());
    if (build.exitCode !== 0) {
      fail('Instrumented build failed.');
    }

    executable = findProgram(programs, overlay.programName);
    if (executable === undefined) {
      fail(`Built successfully but no executable appeared in ${programs}.`);
    }

    console.log(`\n--- running for ${seconds}s ---`);
    const exitCode = await runAndClose(executable, workspace.root, seconds);
    console.log(`exit ${exitCode}`);

    const report = collectProfile(overlay.plan, overlay.hitsPath);
    if (report === undefined) {
      fail(
        `No timings at ${overlay.hitsPath}. The program has to close normally for the shutdown ` +
          'broadcast to reach the flush; a kill skips the write.'
      );
    }

    console.log('');
    console.log(formatProfile(report, 40));
    console.log('');
    console.log(
      `${report.methods.length} of ${overlay.plan.probes.length} probed method(s) ran, ` +
        `${report.totalMilliseconds.toFixed(0)} ms measured in total (inclusive).`
    );
  } finally {
    if (executable !== undefined && !keep) {
      for (const path of [executable, executable.replace(/\.exe$/i, '.dbg')]) {
        try {
          if (existsSync(path)) {
            unlinkSync(path);
          }
        } catch {
          console.log(`Could not remove ${path}; remove it by hand.`);
        }
      }
    }
    if (keep) {
      console.log(`\nkept: ${scratch}`);
    } else {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

void main();
