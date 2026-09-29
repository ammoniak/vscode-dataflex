import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import * as vscode from 'vscode';
import {
  JUnitTestCase,
  TestNode,
  TestProject
} from '@vscode-dataflex/workspace';
import { Overlay, runTestProject } from '@vscode-dataflex/coverage';
import type {
  CoverageReport,
  CoverageRunOptions,
  TestRunResult
} from '@vscode-dataflex/coverage';
import { DataFlexClient } from './client';
import { DetailsByFile, coverageDetails, fileCoverage } from './coverage';
import { DataFlexStatusBar } from './statusBar';

/**
 * Test Explorer integration for DFUnit.
 *
 * Discovery is static -- the object tree is read straight out of the parser, following `Use` into
 * spec packages -- so the suite appears without compiling anything. Running goes through the
 * console reporter that DFUnit's own CI uses: build with `df-cli`, run the executable with
 * `--console -o <file>`, then map the JUnit XML back onto the discovered tree.
 */
export class DataFlexTestController implements vscode.Disposable {
  private readonly controller: vscode.TestController;
  private readonly disposables: vscode.Disposable[] = [];
  /** Test item id -> where its project lives, so a run knows what to build. */
  private readonly projectOfItem = new Map<string, TestProject>();
  /**
   * Per-run coverage detail, answered back from `loadDetailedCoverage`.
   *
   * Held per `TestRun` because the editor asks for detail lazily, well after the run has produced
   * them, and two runs may be in flight at once.
   */
  private readonly coverageByRun = new WeakMap<vscode.TestRun, DetailsByFile>();
  /**
   * Kinds of run profile registered.
   *
   * Exposed because the VS Code API offers no way to enumerate a controller's profiles, and the
   * Coverage one disappearing would silently remove "Run with Coverage" from the Test Explorer
   * without failing anything else.
   */
  readonly profileKinds: vscode.TestRunProfileKind[] = [];

  constructor(
    private readonly client: DataFlexClient,
    private readonly statusBar: DataFlexStatusBar,
    private readonly output: vscode.OutputChannel,
    /** Extension root; `runtime/` beneath it holds the coverage packages. */
    private readonly extensionPath: string
  ) {
    this.controller = vscode.tests.createTestController('dataflex', 'DataFlex');
    this.disposables.push(this.controller);

    this.controller.refreshHandler = async () => {
      await this.refresh();
    };

    this.controller.createRunProfile(
      'Run',
      vscode.TestRunProfileKind.Run,
      (request, token) => this.run(request, token, false),
      true
    );
    this.profileKinds.push(vscode.TestRunProfileKind.Run);

    const coverage = this.controller.createRunProfile(
      'Run with Coverage',
      vscode.TestRunProfileKind.Coverage,
      (request, token) => this.run(request, token, true),
      false
    );
    coverage.loadDetailedCoverage = (testRun, file) =>
      Promise.resolve(this.coverageByRun.get(testRun)?.get(file.uri.fsPath.toLowerCase()) ?? []);
    this.profileKinds.push(vscode.TestRunProfileKind.Coverage);
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  /** Rebuilds the test tree from source. Safe to call whenever the workspace or a file changes. */
  async refresh(): Promise<void> {
    if (this.client.getStatus().swsPath === undefined) {
      return;
    }

    // Discovery runs on the server, which owns the resolver and the index.
    const projects = await this.client.discoverTests();

    this.controller.items.replace([]);
    this.projectOfItem.clear();

    let total = 0;
    for (const project of projects) {
      for (const application of project.applications) {
        const item = this.toTestItem(application, project, []);
        this.controller.items.add(item);
        total += countTests(application);
      }
    }

    this.output.appendLine(
      `Discovered ${total} DFUnit test(s) in ${projects.length} project(s): ` +
        `${projects.map((p) => p.project).join(', ') || '(none)'}`
    );
  }

  /**
   * Builds a `TestItem` tree.
   *
   * Item ids are the DFUnit *reported* path (`MyApp/Sanity/Integer arithmetic`), which is exactly
   * what the JUnit report keys on, so mapping results back needs no fuzzy matching.
   */
  private toTestItem(node: TestNode, project: TestProject, parentPath: string[]): vscode.TestItem {
    const path = [...parentPath, node.reportedName];
    const item = this.controller.createTestItem(
      path.join('/'),
      node.name,
      vscode.Uri.file(node.file)
    );
    item.range = new vscode.Range(
      node.range.start.line,
      node.range.start.character,
      node.range.end.line,
      node.range.end.character
    );
    // Show the framework's name when it differs from the identifier, since that is what the
    // results and any CI report will call it.
    if (node.reportedName !== node.name) {
      item.description = node.reportedName;
    }

    this.projectOfItem.set(item.id, project);
    for (const child of node.children) {
      item.children.add(this.toTestItem(child, project, path));
    }
    return item;
  }

  private async run(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
    coverage: boolean
  ): Promise<void> {
    const status = this.client.getStatus();
    if (status.swsPath === undefined || status.root === undefined || status.cliPath === undefined) {
      vscode.window.showErrorMessage('DataFlex: no workspace loaded, cannot run tests.');
      return;
    }

    const requested = this.requestedItems(request);
    if (requested.length === 0) {
      return;
    }

    // DFUnit runs a whole executable at a time, so group by project and run each once.
    const byProject = new Map<TestProject, vscode.TestItem[]>();
    for (const item of requested) {
      const project = this.projectOfItem.get(item.id);
      if (project === undefined) {
        continue;
      }
      const bucket = byProject.get(project);
      if (bucket === undefined) {
        byProject.set(project, [item]);
      } else {
        bucket.push(item);
      }
    }

    const run = this.controller.createTestRun(request);
    try {
      for (const [project, items] of byProject) {
        if (token.isCancellationRequested) {
          break;
        }
        await this.runProject(
          run,
          project,
          items,
          status.swsPath,
          status.root,
          status.cliPath,
          token,
          coverage
        );
      }
    } finally {
      run.end();
    }
  }

  private async runProject(
    run: vscode.TestRun,
    project: TestProject,
    items: vscode.TestItem[],
    swsPath: string,
    workspaceRoot: string,
    cliPath: string,
    token: vscode.CancellationToken,
    coverage: boolean
  ): Promise<void> {
    const leaves = items.flatMap(collectLeaves);
    for (const leaf of leaves) {
      run.enqueued(leaf);
    }

    const errorAll = (message: string): void => {
      const reported = new vscode.TestMessage(message);
      for (const leaf of leaves) {
        run.errored(leaf, reported);
      }
    };

    // The scratch directory is created up front because a coverage build needs it before there is
    // anything to run: the instrumented copies are laid out inside it.
    // The scratch directory is created up front because a coverage build needs it before there is
    // anything to run: the instrumented copies are laid out inside it.
    const scratch = mkdtempSync(join(tmpdir(), 'dataflex-tests-'));
    const timeoutSeconds = vscode.workspace
      .getConfiguration('dataflex')
      .get<number>('test.timeoutSeconds', 300);

    // A DataFlex program that opens a modal dialog waits for a click that is never coming, so the
    // run is time-boxed; cancelling from the editor kills the child the same way.
    const canceller = new AbortController();
    const cancellation = token.onCancellationRequested(() => canceller.abort());

    let result: TestRunResult | undefined;
    try {
      let coverageOptions: CoverageRunOptions | undefined;
      if (coverage) {
        coverageOptions = await this.instrument(run, project);
        if (coverageOptions === undefined) {
          errorAll(
            `Could not work out what to instrument for ${project.project}. ` +
              'The workspace may still be indexing.'
          );
          return;
        }
      }

      run.appendOutput(`Building ${project.project}...\r\n`);
      result = await runTestProject({
        cliPath,
        swsPath,
        workspaceRoot,
        project,
        scratch,
        timeoutSeconds,
        signal: canceller.signal,
        onOutput: (chunk: string) => run.appendOutput(toTerminalText(chunk)),
        ...(coverageOptions === undefined ? {} : { coverage: coverageOptions })
      });

      if (result.buildExitCode !== 0) {
        errorAll(`${coverage ? 'Instrumented build' : 'Build'} failed:\n${result.buildOutput}`);
        return;
      }
      if (result.executable === undefined) {
        errorAll(
          `Built successfully but no executable was found for ${project.project} in ` +
            `${join(workspaceRoot, 'Programs')}.`
        );
        return;
      }

      // --- run -------------------------------------------------------------
      for (const leaf of leaves) {
        run.started(leaf);
      }

      if (result.results === undefined) {
        // The common cause is the program failing before the reporter ran -- a missing
        // workspace config, a database login prompt, or a DataFlex error dialog. Say so rather
        // than silently reporting nothing.
        errorAll(
          [
            `${basename(result.executable)} exited with code ${result.exitCode} without writing a report.`,
            '',
            'DFUnit only writes results once the test application starts, so this usually means',
            'the program failed first -- a missing workspace configuration, a database login',
            'prompt, or an error dialog. Try running it by hand to see the error:',
            '',
            `  "${result.executable}" --console -o results.xml`,
            result.output.trim().length > 0 ? `\nOutput:\n${result.output}` : ''
          ].join('\n')
        );
        return;
      }

      this.applyResults(run, leaves, result.results.cases);

      if (result.overlay !== undefined) {
        this.publishCoverage(run, result.overlay, result.coverage);
      }
    } finally {
      // The instrumented executable is removed by `runTestProject`, which is also what put it in
      // the user's `Programs` directory; their own build is a different name and never touched.
      cancellation.dispose();
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  /**
   * Lays out the instrumented copies for a coverage run.
   *
   * The file list comes from the server, which owns the include resolver: reachability from the
   * test program's `.src` is what bounds it, so a suite that touches thirteen files does not pay
   * to compile five hundred.
   */
  private async instrument(
    run: vscode.TestRun,
    project: TestProject
  ): Promise<CoverageRunOptions | undefined> {
    const exclude = vscode.workspace
      .getConfiguration('dataflex')
      .get<string[]>('coverage.exclude', []);

    const response = await this.client.coverageTargets({ project: project.project, exclude });
    if (response.entry === undefined || response.targets.length === 0) {
      return undefined;
    }
    if (response.excluded > 0) {
      run.appendOutput(`${response.excluded} file(s) excluded by dataflex.coverage.exclude\r\n`);
    }

    const application = project.applications[0];
    if (application === undefined) {
      return undefined;
    }

    return {
      entry: response.entry,
      applicationLine: application.range.start.line,
      flushBeforeLine: application.range.end.line,
      targets: response.targets,
      runtimeDirectory: join(this.extensionPath, 'runtime')
    };
  }

  /** Reads the counts a coverage run wrote and hands them to the editor. */
  private publishCoverage(
    run: vscode.TestRun,
    overlay: Overlay,
    report: CoverageReport | undefined
  ): void {
    if (report === undefined) {
      // DFUnit leaves through Win32 ExitProcess, so a suite that dies before the flush produces
      // no counts at all. Saying so beats presenting the absence as zero coverage.
      run.appendOutput(
        'No coverage counts were written: the suite did not reach the end of its run.\r\n'
      );
      return;
    }

    const details = coverageDetails(report, overlay.plan.probes);
    this.coverageByRun.set(run, details);
    for (const file of fileCoverage(details, report.files.map((entry: { file: string }) => entry.file))) {
      run.addCoverage(file);
    }
    run.appendOutput(
      `Coverage: ${report.covered} / ${report.total} probe(s) hit ` +
        `(${(report.ratio * 100).toFixed(1)}%) across ${report.files.length} file(s)\r\n`
    );
  }

  /** Matches report entries to test items by their reported path. */
  private applyResults(
    run: vscode.TestRun,
    leaves: vscode.TestItem[],
    cases: JUnitTestCase[]
  ): void {
    const byPath = new Map<string, JUnitTestCase>();
    for (const testCase of cases) {
      byPath.set([...testCase.suitePath, testCase.name].join('/').toLowerCase(), testCase);
    }

    for (const leaf of leaves) {
      const result = byPath.get(leaf.id.toLowerCase());
      if (result === undefined) {
        run.skipped(leaf);
        continue;
      }

      const duration = result.duration === undefined ? undefined : result.duration * 1000;
      if (result.status === 'passed') {
        run.passed(leaf, duration);
        continue;
      }

      const message = new vscode.TestMessage(result.message ?? 'Test failed.');
      if (leaf.uri !== undefined && leaf.range !== undefined) {
        message.location = new vscode.Location(leaf.uri, leaf.range);
      }
      if (result.status === 'failed') {
        run.failed(leaf, message, duration);
      } else {
        run.errored(leaf, message, duration);
      }
    }
  }

  /** The items a run request covers: those explicitly included, or the whole tree. */
  private requestedItems(request: vscode.TestRunRequest): vscode.TestItem[] {
    if (request.include !== undefined) {
      return [...request.include];
    }
    const roots: vscode.TestItem[] = [];
    this.controller.items.forEach((item) => roots.push(item));
    return roots;
  }
}

function collectLeaves(item: vscode.TestItem): vscode.TestItem[] {
  if (item.children.size === 0) {
    return [item];
  }
  const leaves: vscode.TestItem[] = [];
  item.children.forEach((child) => leaves.push(...collectLeaves(child)));
  return leaves;
}

function countTests(node: TestNode): number {
  return node.kind === 'test'
    ? 1
    : node.children.reduce((total, child) => total + countTests(child), 0);
}

/** The test run terminal needs CRLF line endings. */
function toTerminalText(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}
