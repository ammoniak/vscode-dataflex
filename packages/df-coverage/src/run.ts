import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  findProgram,
  parseJUnit,
  runDfCli,
  type CoverageTarget,
  type JUnitResults,
  type TestProject
} from '@vscode-dataflex/workspace';
import { collectReport, writeOverlay, type Overlay } from './session';
import type { CoverageReport } from './report';

export interface CoverageRunOptions {
  /**
   * The project source to instrument, when it is not `project.file`.
   *
   * The language server resolves this itself for the extension, and that resolution is the one to
   * trust rather than re-deriving it here.
   */
  entry?: string;
  /** What to instrument, from `coverageTargets`. */
  targets: readonly CoverageTarget[];
  /** Directory holding the DataFlex-side runtime packages. */
  runtimeDirectory: string;
  /** Where the test application object starts and ends, for the flush override. */
  applicationLine: number;
  flushBeforeLine: number;
}

export interface TestRunOptions {
  cliPath: string;
  /** Absolute path to the `.sws`. */
  swsPath: string;
  workspaceRoot: string;
  project: TestProject;
  /** A scratch directory the caller creates and removes. */
  scratch: string;
  timeoutSeconds: number;
  /** Present to run under instrumentation; absent for a plain run. */
  coverage?: CoverageRunOptions;
  /** Build and program output as it arrives. */
  onOutput?: (chunk: string) => void;
  /** Cancels the run and kills the child. */
  signal?: AbortSignal;
  /** Leave the built executable in place rather than deleting it. */
  keepExecutable?: boolean;
}

export interface TestRunResult {
  buildArgs: string[];
  buildOutput: string;
  buildExitCode: number;
  /** Absent when the build failed or produced nothing. */
  executable?: string;
  exitCode: number;
  output: string;
  timedOut: boolean;
  /** Where the program was asked to write its JUnit XML. */
  reportPath: string;
  /** Absent when the program wrote no report. */
  results?: JUnitResults;
  /** Present for a coverage run, whether or not counts came back. */
  overlay?: Overlay;
  /**
   * Absent when the run wrote no counts at all.
   *
   * That is not the same as zero coverage, and must not be reported as such: DFUnit exits through
   * Win32 `ExitProcess`, so a suite that dies before its flush runs produces no data rather than
   * partial data. A killed process writes nothing either.
   */
  coverage?: CoverageReport;
}

/**
 * Builds a DFUnit project, runs it, and reads back what it wrote.
 *
 * One copy of a sequence that used to exist three times -- in `scripts/coverage-run.ts`, in the
 * extension's test controller, and again for profiling. Everything host-specific is a callback:
 * `onOutput` stands in for a VS Code test run's output channel or a script's `console.log`, and
 * `signal` for a cancellation token.
 */
export async function runTestProject(options: TestRunOptions): Promise<TestRunResult> {
  const { cliPath, swsPath, workspaceRoot, project, scratch, coverage } = options;
  const programs = join(workspaceRoot, 'Programs');
  const reportPath = join(scratch, coverage === undefined ? 'results.xml' : 'instrumented.xml');
  const say = options.onOutput ?? ((): void => {});

  const overlay =
    coverage === undefined
      ? undefined
      : writeOverlay({
          entry: coverage.entry ?? project.file,
          applicationLine: coverage.applicationLine,
          flushBeforeLine: coverage.flushBeforeLine,
          targets: coverage.targets,
          scratch,
          runtimeDirectory: coverage.runtimeDirectory
        });

  // `-I` paths are searched first, so the instrumented copies shadow the originals without the
  // workspace itself being touched.
  const buildArgs =
    overlay === undefined
      ? ['build', resolve(swsPath), '--target', project.project]
      : [
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
        ];

  const build = await runDfCli(cliPath, buildArgs, workspaceRoot);
  const buildOutput = `${build.stdout}${build.stderr}`;
  say(buildOutput);

  const base: TestRunResult = {
    buildArgs,
    buildOutput,
    buildExitCode: build.exitCode,
    exitCode: -1,
    output: '',
    timedOut: false,
    reportPath,
    ...(overlay === undefined ? {} : { overlay })
  };
  if (build.exitCode !== 0) {
    return base;
  }

  const stem =
    overlay?.programName ?? basename(project.project).replace(/\.[^.]+$/, '');
  const executable = findProgram(programs, stem);
  if (executable === undefined) {
    return base;
  }

  try {
    const run = await execute(executable, reportPath, workspaceRoot, options);
    const results = existsSync(reportPath)
      ? parseJUnit(readFileSync(reportPath, 'utf8'))
      : undefined;
    const report = overlay === undefined ? undefined : collectReport(overlay.plan, overlay.hitsPath);

    return {
      ...base,
      executable,
      exitCode: run.exitCode,
      output: run.output,
      timedOut: run.timedOut,
      ...(results === undefined ? {} : { results }),
      ...(report === undefined ? {} : { coverage: report })
    };
  } finally {
    // The instrumented program is named apart from the user's own build, but it is still written
    // into their `Programs` directory, so it is taken out again.
    if (overlay !== undefined && options.keepExecutable !== true) {
      for (const path of [executable, executable.replace(/\.exe$/i, '.dbg')]) {
        try {
          if (existsSync(path)) {
            unlinkSync(path);
          }
        } catch {
          // Left behind rather than failing the run; it is named apart from the real build.
        }
      }
    }
  }
}

/** Runs the built program the way DFUnit's own Jenkinsfile does. */
function execute(
  executable: string,
  reportPath: string,
  cwd: string,
  options: TestRunOptions
): Promise<{ exitCode: number; output: string; timedOut: boolean }> {
  return new Promise((done) => {
    const child = spawn(executable, ['--console', '-o', reportPath], { cwd, windowsHide: true });
    let output = '';
    const collect = (chunk: Buffer): void => {
      const text = chunk.toString();
      output += text;
      options.onOutput?.(text);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    let settled = false;
    const finish = (exitCode: number, timedOut: boolean, note?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      done({ exitCode, output: note === undefined ? output : `${output}\n${note}`, timedOut });
    };

    // A DataFlex program that opens a modal error dialog would otherwise wait for a click that is
    // never coming.
    const timer = setTimeout(() => {
      child.kill();
      finish(-1, true, `Killed after ${options.timeoutSeconds}s.`);
    }, options.timeoutSeconds * 1000);

    const onAbort = (): void => {
      child.kill();
      finish(-1, false, 'Cancelled.');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error) => finish(-1, false, error.message));
    child.on('close', (code) => finish(code ?? -1, false));
  });
}
