/**
 * Runs a DFUnit suite under coverage, end to end, without VS Code.
 *
 * This is the proof that instrumentation survives a real compiler and a real run. It also does the
 * thing the editor cannot easily do: run the suite twice, uninstrumented and instrumented, and
 * compare the results. A probe that changes behaviour is worse than no coverage at all, so that
 * comparison is the point, not a nicety.
 *
 * Usage: npm run coverage-run -- <workspace.sws> [project.src] [--keep] [--dry-run]
 *
 * `--dry-run` writes the overlay and stops, keeping it, so the generated program can be read.
 */
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  IncludeResolver,
  TestDiscovery,
  coverageTargets,
  cliForWorkspace,
  loadWorkspace
} from '../packages/df-workspace/src/index';
import type { JUnitResults } from '../packages/df-workspace/src/index';
import { isWorkspaceOwnedFile } from '../packages/df-langserver/src/analysis/workspaceFiles';
import { runTestProject, writeOverlay } from '../packages/df-coverage/src/index';

const RUNTIME_DIR = resolve(__dirname, '..', 'packages', 'df-coverage', 'runtime');
const TIMEOUT_SECONDS = 600;

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}



/** `name -> status`, for comparing an instrumented run against a clean one. */
function resultMap(results: JUnitResults | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const testCase of results?.cases ?? []) {
    map.set([...testCase.suitePath, testCase.name].join('/').toLowerCase(), testCase.status);
  }
  return map;
}

async function main(): Promise<void> {
  const flags = new Set(['--keep', '--dry-run']);
  const args = process.argv.slice(2).filter((arg) => !flags.has(arg));
  const dryRun = process.argv.includes('--dry-run');
  const keep = process.argv.includes('--keep') || dryRun;
  const swsPath = args[0];
  if (swsPath === undefined) {
    fail('Usage: npm run coverage-run -- <workspace.sws> [project.src] [--keep]');
  }

  const { cliPath, warning } = await cliForWorkspace(resolve(swsPath));
  if (cliPath === undefined) {
    fail('df-cli.exe not found.');
  }
  if (warning !== undefined) {
    console.warn(warning);
  }

  console.log(`workspace          : ${swsPath}`);
  const workspace = await loadWorkspace(cliPath, resolve(swsPath));
  if (workspace === undefined) {
    fail(`df-cli could not open ${swsPath}`);
  }

  const resolver = new IncludeResolver(workspace.searchPath);
  const projects = new TestDiscovery(resolver, undefined).discoverProjects(workspace.projects);
  if (projects.length === 0) {
    fail('No DFUnit test applications were discovered in this workspace.');
  }

  const wanted = args[1];
  const project =
    wanted === undefined
      ? projects[0]!
      : projects.find((candidate) => candidate.project.toLowerCase() === wanted.toLowerCase());
  if (project === undefined) {
    fail(
      `No test project named ${wanted}. Found: ${projects.map((p) => p.project).join(', ')}`
    );
  }

  const application = project.applications[0];
  if (application === undefined) {
    fail(`${project.project} has no test application object.`);
  }

  console.log(`project            : ${project.project}`);
  console.log(`test application   : ${application.name} (${basename(application.file)})`);

  // --- what to instrument ----------------------------------------------------
  const targets = coverageTargets({
    entry: project.file,
    resolver,
    searchPath: workspace.searchPath,
    root: workspace.root,
    isOwned: isWorkspaceOwnedFile
  });
  console.log(`files to instrument: ${targets.length}`);

  const scratch = mkdtempSync(join(tmpdir(), 'dataflex-coverage-'));
  const programs = join(workspace.root, 'Programs');
  let coverageExecutable: string | undefined;

  try {
    if (dryRun) {
      const overlay = writeOverlay({
        entry: project.file,
        applicationLine: application.range.start.line,
        flushBeforeLine: application.range.end.line,
        targets,
        scratch,
        runtimeDirectory: RUNTIME_DIR
      });
      console.log(`probes inserted    : ${overlay.plan.probes.length}`);
      console.log(`overlay files      : ${overlay.plan.files.length}`);
      console.log(`generated program  : ${overlay.entrySource}`);
      return;
    }

    // --- baseline: the suite as it really is ---------------------------------
    // Run twice on purpose. A probe that changes behaviour is worse than no coverage at all, so
    // the comparison below is the point of this script, not a nicety.
    console.log('\n--- baseline (uninstrumented) ---');
    const baselineRun = await runTestProject({
      cliPath,
      swsPath: resolve(swsPath),
      workspaceRoot: workspace.root,
      project,
      scratch,
      timeoutSeconds: TIMEOUT_SECONDS,
      onOutput: () => {},
      keepExecutable: keep
    });
    if (baselineRun.buildExitCode !== 0) {
      fail(`Baseline build failed:\n${baselineRun.buildOutput}`);
    }
    if (baselineRun.executable === undefined) {
      fail(`Baseline built but no executable appeared in ${programs}.`);
    }
    const baseline = resultMap(baselineRun.results);
    console.log(`exit ${baselineRun.exitCode}, ${baseline.size} test(s) reported`);

    // --- instrumented --------------------------------------------------------
    console.log('\n--- instrumented ---');
    const run = await runTestProject({
      cliPath,
      swsPath: resolve(swsPath),
      workspaceRoot: workspace.root,
      project,
      scratch,
      timeoutSeconds: TIMEOUT_SECONDS,
      onOutput: () => {},
      keepExecutable: keep,
      coverage: {
        targets,
        runtimeDirectory: RUNTIME_DIR,
        applicationLine: application.range.start.line,
        flushBeforeLine: application.range.end.line
      }
    });
    const overlay = run.overlay!;
    coverageExecutable = run.executable;
    console.log(`probes inserted    : ${overlay.plan.probes.length}`);
    console.log(`overlay files      : ${overlay.plan.files.length}`);
    if (overlay.plan.skipped.length > 0) {
      console.log(`not probeable      : ${overlay.plan.skipped.length} statement(s)`);
    }
    if (run.buildExitCode !== 0) {
      fail(`Instrumented build failed:\n${run.buildOutput}`);
    }
    if (run.executable === undefined) {
      fail(`Instrumented build succeeded but no ${overlay.programName} executable appeared.`);
    }
    console.log(`built              : ${basename(run.executable)}`);

    const instrumented = resultMap(run.results);
    console.log(`exit ${run.exitCode}, ${instrumented.size} test(s) reported`);

    // --- did instrumentation change behaviour? -------------------------------
    const differences: string[] = [];
    for (const [name, status] of baseline) {
      const after = instrumented.get(name);
      if (after !== status) {
        differences.push(`  ${name}: ${status} -> ${after ?? '(missing)'}`);
      }
    }
    for (const name of instrumented.keys()) {
      if (!baseline.has(name)) {
        differences.push(`  ${name}: (absent) -> ${instrumented.get(name)}`);
      }
    }

    console.log('\n--- behaviour ---');
    if (differences.length === 0) {
      console.log(`identical: all ${baseline.size} test(s) reported the same result`);
    } else {
      console.log(`CHANGED by instrumentation (${differences.length}):`);
      console.log(differences.join('\n'));
    }


    const report = run.coverage;
    console.log('\n--- coverage ---');
    if (report === undefined) {
      console.log(
        'No counts were written. DFUnit exits through Win32 ExitProcess, so a run that dies\n' +
          'before ManualRunTests returns produces no data at all rather than partial data.\n' +
          `Output:\n${run.output}`
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      `${report.covered} / ${report.total} probes hit (${(report.ratio * 100).toFixed(1)}%) ` +
        `across ${report.files.length} file(s)\n`
    );
    for (const file of [...report.files].sort((a, b) => a.covered / a.total - b.covered / b.total)) {
      const percent = file.total === 0 ? 0 : (file.covered / file.total) * 100;
      console.log(
        `  ${percent.toFixed(0).padStart(3)}%  ${String(file.covered).padStart(5)}/${String(
          file.total
        ).padEnd(5)}  ${file.file.replace(workspace.root, '').replace(/^[\\/]/, '')}`
      );
    }
  } finally {
    // The coverage executable lives in the user's Programs directory only for the length of the
    // run; their own build artifact is a different name and is never touched.
    if (coverageExecutable !== undefined && !keep) {
      for (const suffix of ['.exe', '.dbg']) {
        const path = coverageExecutable.replace(/\.exe$/i, suffix);
        try {
          if (existsSync(path)) {
            unlinkSync(path);
          }
        } catch {
          console.error(`Could not remove ${path}; remove it by hand.`);
        }
      }
    }
    if (keep) {
      console.log(`\nkept scratch: ${scratch}`);
    } else {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

void main();
