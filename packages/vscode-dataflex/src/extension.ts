import * as vscode from 'vscode';
import { findStudio } from '@vscode-dataflex/workspace';
import { runDfCli } from '@vscode-dataflex/workspace';
import { AnalysisReport } from './analysisReport';
import { DataFlexClient } from './client';
import { PreviewPanels } from './preview';
import type { PreviewImageReport } from './preview';
import { ProfileCommand } from './profileCommand';
import { DataFlexStatusBar } from './statusBar';
import { DataFlexTaskProvider, DataFlexTaskDefinition } from './tasks';
import { DataFlexTestController } from './testController';

/**
 * Extension entry point.
 *
 * The extension is a thin client: parsing, indexing and every language feature live in the
 * language server (`out/server.js`). What stays here is the part that needs the VS Code API --
 * the status bar, build/run tasks, the Test Explorer and the commands.
 */
/**
 * What `activate` hands back.
 *
 * Deliberately narrow: it exists for integration tests to assert on things the VS Code API does
 * not expose. A controller's run profiles are the case in point -- nothing else can tell whether
 * the Coverage profile was registered, and losing it would quietly remove "Run with Coverage"
 * from the Test Explorer without breaking anything that fails loudly.
 */
export interface DataFlexApi {
  testRunProfileKinds: readonly vscode.TestRunProfileKind[];
  /**
   * A preview's own account of which pictures loaded. A webview's document is out of the
   * extension host's reach, so this is the only way to test that a relative url survives the
   * page base and the resource policy.
   */
  onDidReportPreviewImages: vscode.Event<PreviewImageReport>;
}

export async function activate(context: vscode.ExtensionContext): Promise<DataFlexApi> {
  const output = vscode.window.createOutputChannel('DataFlex');
  context.subscriptions.push(output);

  const client = new DataFlexClient(context, output);
  const statusBar = new DataFlexStatusBar();
  context.subscriptions.push(statusBar, { dispose: () => void client.dispose() });

  const testController = new DataFlexTestController(client, statusBar, output, context.extensionPath);
  context.subscriptions.push(testController);

  const analysisReport = new AnalysisReport(client, context.workspaceState);
  context.subscriptions.push(analysisReport);

  const profileCommand = new ProfileCommand(client, context.extensionPath);
  context.subscriptions.push(profileCommand);

  const previews = new PreviewPanels(client, context.extensionUri, output);
  context.subscriptions.push(previews);

  context.subscriptions.push(
    client.onStatusChanged((status) => {
      statusBar.update(status);
      // Discovery is static, so refresh whenever the workspace or index changes underneath it.
      void testController.refresh();
    })
  );

  // --- tasks ---------------------------------------------------------------
  const taskProvider = new DataFlexTaskProvider(client, statusBar);
  context.subscriptions.push(
    vscode.tasks.registerTaskProvider(DataFlexTaskProvider.taskType, taskProvider)
  );

  const runTask = async (task: DataFlexTaskDefinition['task']): Promise<void> => {
    const status = client.getStatus();
    if (status.swsPath === undefined) {
      vscode.window.showErrorMessage(
        'DataFlex: no workspace loaded. See the DataFlex output channel for details.'
      );
      output.show(true);
      return;
    }
    const created = taskProvider.create({ type: 'dataflex', task });
    if (created === undefined) {
      vscode.window.showErrorMessage(`DataFlex: could not create the ${task} task.`);
      return;
    }
    await vscode.tasks.executeTask(created);
  };

  // --- debugging -----------------------------------------------------------
  /**
   * Source-level debugging through the Studio's own debugger engine, which turns out to be a
   * registered COM server rather than something only the Studio can reach. See docs/DEBUGGING.md.
   *
   * A build-time decision, not a setting. The debugger needs `dataflex-debug-host.exe`, a
   * self-contained .NET publish that costs 64 MB and drives a Windows-only COM server, so shipping
   * it to everyone in order to have it switched off by default was the wrong trade -- and on macOS
   * or Linux it could never have run at all. `esbuild.mjs` folds `INCLUDE_DEBUGGER` to a literal,
   * so in the standard build this branch and everything it reaches are gone from the bundle rather
   * than merely unreachable.
   */
  if (INCLUDE_DEBUGGER) {
    // Dynamic, and with the extension `moduleResolution: node16` wants on an `import()`: a static
    // import would leave esbuild to prove the module has no side effects before dropping it, and
    // a dead `import()` it can drop outright.
    const { registerDebugging } = await import('./debug.js');
    registerDebugging(context, client, statusBar, output);
  }

  // --- commands ------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('dataflex.build', () => runTask('build')),
    vscode.commands.registerCommand('dataflex.rebuild', () => runTask('rebuild')),
    vscode.commands.registerCommand('dataflex.run', () => runTask('run')),
    /**
     * Hands the current project to the DataFlex Studio's debugger.
     *
     * The Studio owns the only documented DataFlex debugger: it reads the `.dbg` file the compiler
     * writes beside the executable, and that format is not published. Until something replaces it
     * -- see `docs/DEBUGGING.md` -- "debug" means "open it where a debugger exists".
     */
    vscode.commands.registerCommand('dataflex.debugInStudio', async () => {
      const status = client.getStatus();
      if (status.cliPath === undefined || status.swsPath === undefined) {
        vscode.window.showWarningMessage('DataFlex: no workspace is open.');
        return;
      }
      const studio = findStudio(status.cliPath);
      if (studio === undefined) {
        vscode.window.showWarningMessage(
          'DataFlex: the Studio is not installed beside df-cli.exe, so there is no debugger to ' +
            'hand this to. See docs/DEBUGGING.md.'
        );
        return;
      }
      // The Studio takes the workspace; the project is chosen inside it.
      const terminal = vscode.window.createTerminal({ name: 'DataFlex Studio' });
      terminal.sendText(`& "${studio}" "${status.swsPath}"`, true);
    }),

    /**
     * Builds an instrumented copy of a project, runs it, and reports where its time went.
     *
     * Separate from "Debug in DataFlex Studio" because it answers a different question. The
     * Studio can pause and step; this cannot. What this can do is tell you which method the time
     * actually went into, across a whole run, which no amount of stepping shows.
     */
    vscode.commands.registerCommand('dataflex.profile', () => profileCommand.run()),
    vscode.commands.registerCommand('dataflex.showLastProfile', () => profileCommand.present()),

    /**
     * Draws the web view in the active editor, using the workspace's own copy of the framework.
     *
     * Takes the active editor rather than a uri argument so it works from the command palette as
     * well as the editor title bar, where VS Code passes one.
     */
    vscode.commands.registerCommand('dataflex.previewWebView', async (uri?: vscode.Uri) => {
      const document =
        uri === undefined
          ? vscode.window.activeTextEditor?.document
          : await vscode.workspace.openTextDocument(uri);
      if (document === undefined || document.languageId !== 'dataflex') {
        vscode.window.showWarningMessage('DataFlex: open a DataFlex web view to preview it.');
        return;
      }
      await previews.show(document);
    }),

    vscode.commands.registerCommand('dataflex.refreshTests', () => testController.refresh()),
    vscode.commands.registerCommand('dataflex.analyzeWorkspace', () => analysisReport.run()),
    vscode.commands.registerCommand('dataflex.clearAnalysisResults', () => analysisReport.clear()),

    vscode.commands.registerCommand('dataflex.reloadWorkspace', async () => {
      await client.reload();
      vscode.window.showInformationMessage('DataFlex: workspace reloaded.');
    }),

    vscode.commands.registerCommand('dataflex.selectProject', async () => {
      const status = client.getStatus();
      if (status.workspaceName === undefined) {
        output.show(true);
        return;
      }
      if (status.projects.length === 0) {
        vscode.window.showWarningMessage(
          `DataFlex: "${status.workspaceName}" declares no projects.`
        );
        return;
      }
      // The first entry means "no --target", which is how `df-cli` compiles the whole workspace.
      const ALL = 'All projects';
      const picked = await vscode.window.showQuickPick(
        [
          {
            label: ALL,
            description: `${status.projects.length} project(s)`,
            detail: 'Build every project in the workspace'
          },
          ...status.projects.map((project) => ({
            label: project.name,
            description: project.toolchain,
            detail: `${project.searchPathCount} search path entries`
          }))
        ],
        { title: 'Select the DataFlex project to build and run' }
      );
      if (picked !== undefined) {
        statusBar.setSelectedProject(picked.label === ALL ? undefined : picked.label);
      }
    }),

    // Not contributed: returns the raw report so tests can assert on it without driving the
    // notification UI.
    vscode.commands.registerCommand('dataflex.internal.analyzeWorkspace', (rules?: string[]) =>
      client.request('dataflex/analyzeWorkspace', rules === undefined ? undefined : { rules })
    ),

    // Not contributed to the command palette: a machine-readable view of what the server
    // resolved, used by the integration tests and handy when diagnosing a setup.
    vscode.commands.registerCommand('dataflex.internal.status', async () => {
      const status = await client.refreshStatus();
      return {
        ...status,
        workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
        selectedProject: statusBar.getSelectedProject(),
        projectNames: status.projects.map((p) => p.name)
      };
    }),

    vscode.commands.registerCommand('dataflex.showWorkspaceConfiguration', async () => {
      const status = client.getStatus();
      if (status.cliPath === undefined || status.swsPath === undefined) {
        vscode.window.showErrorMessage('DataFlex: no workspace loaded.');
        output.show(true);
        return;
      }
      const result = await runDfCli(
        status.cliPath,
        ['config', '--json', status.swsPath],
        status.root
      );
      const content = result.stdout.trim().length > 0 ? result.stdout : result.stderr;
      const document = await vscode.workspace.openTextDocument({ language: 'json', content });
      await vscode.window.showTextDocument(document, { preview: true });
    })
  );

  await client.start();

  return {
    testRunProfileKinds: testController.profileKinds,
    onDidReportPreviewImages: previews.onDidReportImages
  };
}

export function deactivate(): void {
  // Everything is registered through context.subscriptions.
}
