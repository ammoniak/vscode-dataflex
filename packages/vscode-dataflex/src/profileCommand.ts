import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import * as vscode from 'vscode';
import { findProgram, runDfCli } from '@vscode-dataflex/workspace';
import {
  MethodProfile,
  Overlay,
  ProfileReport,
  collectProfile,
  formatProfile,
  writeOverlay
} from '@vscode-dataflex/coverage';
import { DataFlexClient } from './client';

/**
 * "DataFlex: Profile Project" -- builds an instrumented copy of a project, runs it, and reports
 * where its time went.
 *
 * This is the coverage pipeline with a different probe runtime, deliberately: the overlay, the
 * include shadowing and the build are already proven, and duplicating them for profiling would
 * mean two of the awkward part. What differs is where the probes go (one per method, not one per
 * basic block), what they call, and how the results get written: a DFUnit suite exits through
 * `ExitProcess`, while an ordinary program ends inside `Start_UI` and has to be caught by the
 * shutdown broadcast the desktop sends just before it aborts.
 *
 * The measurement is **inclusive**: a method's time includes everything it called. So a view's
 * event handler will always look expensive, and the thing to look for is a method whose own mean
 * is high relative to what it calls. Probing costs about 5 microseconds per call, which is
 * documented in `DfProfile.pkg`; a method called hundreds of thousands of times is measuring
 * mostly itself.
 */
export class ProfileCommand implements vscode.Disposable {
  private readonly output: vscode.OutputChannel;
  /** Kept so the results stay reachable after the notification is gone. */
  private last?: { report: ProfileReport; project: string };

  constructor(
    private readonly client: DataFlexClient,
    private readonly extensionPath: string
  ) {
    this.output = vscode.window.createOutputChannel('DataFlex Profile');
  }

  dispose(): void {
    this.output.dispose();
  }

  /** The most recent report, for tests and for `dataflex.showLastProfile`. */
  getLastReport(): ProfileReport | undefined {
    return this.last?.report;
  }

  /**
   * Runs a profiling session end to end.
   *
   * Returns the report rather than only showing it, so an integration test can assert on real
   * numbers without driving the notification UI.
   */
  async run(projectName?: string): Promise<ProfileReport | undefined> {
    const status = this.client.getStatus();
    if (status.swsPath === undefined || status.root === undefined || status.cliPath === undefined) {
      vscode.window.showErrorMessage(
        'DataFlex: no workspace resolved, so there is nothing to profile.'
      );
      return undefined;
    }

    const project = projectName ?? (await this.pickProject());
    if (project === undefined) {
      return undefined;
    }

    const exclude = vscode.workspace
      .getConfiguration('dataflex')
      .get<string[]>('coverage.exclude', []);
    const targets = await this.client.coverageTargets({ project, exclude });
    if (targets.entry === undefined || targets.targets.length === 0) {
      vscode.window.showErrorMessage(
        `DataFlex: could not work out what to instrument for ${project}. ` +
          'The workspace may still be indexing.'
      );
      return undefined;
    }

    const scratch = mkdtempSync(join(tmpdir(), 'dataflex-profile-'));
    const programs = join(status.root, 'Programs');
    let overlay: Overlay | undefined;
    let executable: string | undefined;

    this.output.clear();
    this.output.show(true);
    this.output.appendLine(`Profiling ${project}`);

    try {
      try {
        overlay = writeOverlay({
          entry: targets.entry,
          targets: targets.targets,
          scratch,
          runtimeDirectory: join(this.extensionPath, 'runtime'),
          mode: 'profile',
          flushStyle: 'exitBroadcast'
        });
      } catch (error) {
        // The common one is a project with no `Start_UI` at all -- a web application, or a
        // console utility. Say which, rather than "instrumentation failed".
        vscode.window.showErrorMessage(`DataFlex: ${String(error instanceof Error ? error.message : error)}`);
        return undefined;
      }

      if (overlay.plan.probes.length === 0) {
        vscode.window.showWarningMessage(
          `DataFlex: nothing in ${project} could be profiled. ` +
            'Methods whose returns cannot be probed are skipped; see the DataFlex Profile output.'
        );
        this.appendSkipped(overlay);
        return undefined;
      }

      this.output.appendLine(
        `${overlay.plan.probes.length} method probe(s) across ${targets.targets.length} file(s)` +
          (targets.excluded > 0 ? `, ${targets.excluded} excluded by dataflex.coverage.exclude` : '')
      );
      this.appendSkipped(overlay);

      const built = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `DataFlex: building ${project} with profiling…` },
        () =>
          runDfCli(
            status.cliPath!,
            [
              'build-file',
              overlay!.entrySource,
              '--workspace',
              status.swsPath!,
              '--output-dir',
              programs,
              '--rebuild',
              '-I',
              overlay!.overlayDir,
              '-I',
              overlay!.runtimeDir
            ],
            status.root!
          )
      );
      this.output.appendLine(built.stdout + built.stderr);
      if (built.exitCode !== 0) {
        vscode.window.showErrorMessage(
          'DataFlex: the instrumented build failed. See the DataFlex Profile output.'
        );
        return undefined;
      }

      executable = findProgram(programs, overlay.programName);
      if (executable === undefined) {
        vscode.window.showErrorMessage(
          `DataFlex: built successfully but no executable appeared in ${programs}.`
        );
        return undefined;
      }

      // No timeout here, unlike a test run: this program is being driven by hand, and the whole
      // point is to exercise the slow thing before closing it.
      this.output.appendLine(`Running ${executable}. Close the application to end the profile.`);
      const exitCode = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `DataFlex: profiling ${basename(executable)} — close the application when done`,
          cancellable: true
        },
        (_progress, token) => run(executable!, status.root!, token)
      );
      this.output.appendLine(`Exited with code ${exitCode}.`);

      const report = collectProfile(overlay.plan, overlay.hitsPath);
      if (report === undefined) {
        // Nothing was written at all. The usual causes are a program killed rather than closed,
        // or one that failed before reaching `Start_UI` -- neither of which is "took no time".
        vscode.window.showWarningMessage(
          'DataFlex: no timings were written. The program has to be closed normally, so the ' +
            'shutdown broadcast reaches the flush; killing it skips the write.'
        );
        return undefined;
      }

      this.last = { report, project };
      this.output.appendLine('');
      this.output.appendLine(formatProfile(report, report.methods.length));
      await this.present(report, project);
      return report;
    } finally {
      // The instrumented executable lives in the user's `Programs` directory only for the length
      // of the run. It is named apart from their own build, which is never touched.
      if (executable !== undefined) {
        for (const path of [executable, executable.replace(/\.exe$/i, '.dbg')]) {
          try {
            if (existsSync(path)) {
              unlinkSync(path);
            }
          } catch {
            this.output.appendLine(`Could not remove ${path}; remove it by hand.`);
          }
        }
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  /**
   * Shows the results and lets one be opened.
   *
   * A quick pick rather than a webview: the useful action on a profile row is to go and read the
   * method, and this is the shortest path from "slowest first" to the source. The full table is
   * in the output channel, and `dataflex.showLastProfile` brings this back.
   */
  async present(report?: ProfileReport, project?: string): Promise<void> {
    const shown = report ?? this.last?.report;
    const name = project ?? this.last?.project;
    if (shown === undefined) {
      vscode.window.showInformationMessage('DataFlex: nothing has been profiled yet.');
      return;
    }

    const picked = await vscode.window.showQuickPick(
      shown.methods.map((method) => ({
        label: method.method,
        description: describe(method),
        detail: `${vscode.workspace.asRelativePath(method.file)}:${method.line + 1}`,
        method
      })),
      {
        title: `DataFlex: ${name ?? 'profile'} — ${shown.methods.length} method(s), slowest first`,
        placeHolder: 'Inclusive time: a method includes everything it called'
      }
    );
    if (picked === undefined) {
      return;
    }

    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(picked.method.file));
    const editor = await vscode.window.showTextDocument(document);
    const position = new vscode.Position(picked.method.line, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }

  private appendSkipped(overlay: Overlay): void {
    if (overlay.plan.skipped.length === 0) {
      return;
    }
    // Never silent: a method missing from a profile has to be findable, or its absence reads as
    // "it was free".
    this.output.appendLine(`${overlay.plan.skipped.length} method(s) could not be probed:`);
    for (const entry of overlay.plan.skipped.slice(0, 20)) {
      this.output.appendLine(`  ${entry.file}:${entry.line + 1} ${entry.reason}`);
    }
    if (overlay.plan.skipped.length > 20) {
      this.output.appendLine(`  ... ${overlay.plan.skipped.length - 20} more`);
    }
  }

  private async pickProject(): Promise<string | undefined> {
    const projects = this.client.getStatus().projects;
    if (projects.length === 0) {
      vscode.window.showWarningMessage('DataFlex: this workspace declares no projects.');
      return undefined;
    }
    if (projects.length === 1) {
      return projects[0]!.name;
    }
    const picked = await vscode.window.showQuickPick(
      projects.map((project) => ({ label: project.name, description: project.toolchain })),
      { title: 'DataFlex: which project should be profiled?' }
    );
    return picked?.label;
  }
}

/** `123 ms · 45 calls · 2.73 ms mean`, or the same with a warning when the counts disagree. */
export function describe(method: MethodProfile): string {
  const base =
    `${method.milliseconds.toFixed(0)} ms · ${method.calls} call(s) · ` +
    `${method.mean.toFixed(2)} ms mean`;
  return method.balanced ? base : `${base} · unbalanced, understated`;
}

/** Runs the instrumented program, resolving with its exit code. Cancelling kills it. */
function run(
  executable: string,
  cwd: string,
  token: vscode.CancellationToken
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(executable, [], { cwd, windowsHide: false });
    const cancel = token.onCancellationRequested(() => child.kill());
    child.on('error', () => {
      cancel.dispose();
      resolve(-1);
    });
    child.on('close', (code) => {
      cancel.dispose();
      resolve(code ?? -1);
    });
  });
}

