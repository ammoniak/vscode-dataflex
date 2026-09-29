import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { findProgram, findWebAppId } from '@vscode-dataflex/workspace';
import { DataflexDebugSession, type DapMessage } from '@vscode-dataflex/debug';
import type { DataFlexClient } from './client';
import type { DataFlexStatusBar } from './statusBar';

/**
 * Source-level debugging, wired to the Studio's own debugger engine.
 *
 * The engine (`VDFDebugger.DebuggerEngine`, in `Bin64\vdfdbg.dll`) is an in-process, apartment
 * threaded COM server, so it cannot be driven from the extension host: it needs a thread that owns
 * an STA and pumps messages. `dataflex-debug-host.exe` does that and nothing else, and the adapter
 * itself lives in `@vscode-dataflex/debug` where the parser is reachable -- which is what fills the
 * Variables pane, since the engine can evaluate an expression but cannot say what variables exist.
 *
 * Nothing in this file is reachable unless the build included the debugger: `extension.ts` imports
 * it behind `INCLUDE_DEBUGGER`, esbuild folds that constant, and the whole module -- adapter,
 * parser and all -- drops out of the standard bundle. So there is no "is debugging on?" question
 * left to ask at runtime, and no code here answers one.
 *
 * See docs/DEBUGGING.md.
 */

const HOST_EXECUTABLE = 'dataflex-debug-host.exe';

/**
 * Where the host sits in an installed extension, and where it sits in a working tree.
 *
 * Reachable only from a build that has the debugger in it, so a miss means a working tree that has
 * never run `npm run debug-host-build` -- the standard vsix does not get this far.
 */
function findHost(extensionPath: string): string | undefined {
  const candidates = [
    join(extensionPath, 'host', HOST_EXECUTABLE),
    join(
      extensionPath,
      '..',
      'df-debug-host',
      'bin',
      'Release',
      'net8.0-windows',
      'win-x64',
      HOST_EXECUTABLE
    )
  ];
  return candidates.find((path) => existsSync(path));
}

const MISSING_HOST_MESSAGE =
  `DataFlex: ${HOST_EXECUTABLE} was not found, so debugging is unavailable. Run ` +
  '"npm run debug-host-build" to publish it; "npm run package:debug" is the vsix that carries it.';

/**
 * Fills in what a launch configuration leaves out, so `F5` works with no `launch.json` at all.
 */
export class DataflexDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  constructor(
    private readonly client: DataFlexClient,
    private readonly statusBar: DataFlexStatusBar,
    private readonly output: vscode.OutputChannel
  ) {}

  /**
   * What the Run and Debug view offers when there is no launch.json.
   *
   * The web application entry is listed separately rather than left to a setting, because
   * `webApp` is not a detail of an otherwise identical launch: without it the engine never starts
   * a WebApp Server session and never opens a browser, so nothing ever requests a page and the
   * session sits there having apparently done nothing.
   */
  provideDebugConfigurations(): vscode.DebugConfiguration[] {
    // No web application entry here on purpose. It does not work yet, and offering it in the list
    // a developer picks from when they have no launch.json is how someone ends up waiting on a
    // modal dialog behind their editor wondering why the debugger is slow.
    return [
      {
        type: 'dataflex',
        request: 'launch',
        name: 'DataFlex: Debug Project',
        stopOnEntry: false
      },
    ];
  }

  async resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration
  ): Promise<vscode.DebugConfiguration | undefined> {
    const status = this.client.getStatus();
    // "Nothing happened" is the hardest debug-session failure to diagnose, because VS Code
    // abandons the launch silently when a provider returns undefined. Every exit below says why.
    this.output.appendLine(`[debug] resolving ${JSON.stringify(config)}`);

    // Pressing F5 in a .src with no launch.json arrives here empty.
    if (config.type === undefined) {
      config.type = 'dataflex';
      config.request = 'launch';
      config.name = 'DataFlex: Debug Project';
    }

    if (config.request === 'attach') {
      return config;
    }

    if (status.root === undefined) {
      const reason =
        status.lastError ??
        'the workspace has not resolved yet -- check the DataFlex output channel';
      this.output.appendLine(`[debug] no workspace root: ${reason}`);
      void vscode.window.showErrorMessage(`DataFlex: cannot debug, ${reason}.`);
      return undefined;
    }

    config.cwd ??= status.root;

    if (config.program === undefined) {
      const project = config.project ?? this.statusBar.getProjectToRun();
      if (project === undefined) {
        this.output.appendLine('[debug] no project selected and none in the workspace');
        void vscode.window.showErrorMessage('DataFlex: no project is selected.');
        return undefined;
      }

      const stem = String(project).replace(/\.[^.]+$/, '');
      const program = findProgram(join(status.root, 'Programs'), stem);
      if (program === undefined) {
        this.output.appendLine(
          `[debug] no executable for ${stem} in ${join(status.root, 'Programs')}`
        );
        void vscode.window.showErrorMessage(
          `DataFlex: ${stem} has not been built yet. Run "DataFlex: Build Workspace" first.`
        );
        return undefined;
      }
      config.program = program;
    }

    if (config.webApp === true) {
      // The engine wants the WebApp Server application id, not a flag. Given `true` it launches the
      // program standalone, and the DataFlex runtime then refuses to run and puts up a modal that
      // reads, from outside, as the debugger having hung. Nobody should have to know the id, and it
      // is not in the workspace, so it is looked up from the executable being launched.
      const registration = await findWebAppId(String(config.program));
      if (registration === undefined) {
        this.output.appendLine(`[debug] ${String(config.program)} is not registered with the WebApp Server`);
        void vscode.window.showErrorMessage(
          'DataFlex: this program is not registered with the WebApp Server, so it cannot be ' +
            'debugged as a web application. `df-cli webapp list` shows what is registered.'
        );
        return undefined;
      }

      this.output.appendLine(
        `[debug] web application ${registration.id} (DataFlex ${registration.version})` +
          (registration.enabled ? '' : ', which is registered as disabled')
      );
      config.webApp = registration.id;
    }

    this.output.appendLine(`[debug] launching ${String(config.program)} (webApp=${String(config.webApp === true)})`);
    return config;
  }
}

/**
 * Creates one adapter per session, running inside the extension host.
 *
 * Inline rather than a separate adapter process: the adapter needs the parser, and the parser is
 * already loaded here. The only thing that genuinely needs its own process is the COM host, and
 * that is what it gets.
 */
export class DataflexDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  constructor(
    private readonly extensionPath: string,
    private readonly output: vscode.OutputChannel
  ) {}

  createDebugAdapterDescriptor(
    _session: vscode.DebugSession
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    const hostPath = findHost(this.extensionPath);
    if (hostPath === undefined) {
      this.output.appendLine(`[debug] ${HOST_EXECUTABLE} not found under ${this.extensionPath}`);
      void vscode.window.showErrorMessage(MISSING_HOST_MESSAGE);
      return undefined;
    }
    this.output.appendLine(`[debug] adapter host ${hostPath}`);

    const progId = vscode.workspace.getConfiguration('dataflex').get<string>('debuggerProgId');
    return new vscode.DebugAdapterInlineImplementation(
      new InlineAdapter(hostPath, progId, this.output)
    );
  }
}

/** Adapts the protocol-only session to the shape VS Code hosts inline. */
class InlineAdapter implements vscode.DebugAdapter {
  private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  private readonly session: DataflexDebugSession;

  readonly onDidSendMessage = this.emitter.event;

  constructor(hostPath: string, progId: string | undefined, output: vscode.OutputChannel) {
    this.session = new DataflexDebugSession({
      hostPath,
      progId: progId !== undefined && progId.length > 0 ? progId : undefined,
      send: (message) => this.emitter.fire(message as vscode.DebugProtocolMessage),
      log: (line) => output.appendLine(`[debug] ${line}`)
    });
  }

  handleMessage(message: vscode.DebugProtocolMessage): void {
    this.session.handleMessage(message as DapMessage);
  }

  dispose(): void {
    void this.session.dispose();
    this.emitter.dispose();
  }
}

/**
 * Picks a running DataFlex program to attach to.
 *
 * The engine reports process ids and nothing else, so each is shown with whatever the operating
 * system calls it. A program built without debug information is not in the list at all, which is
 * the usual reason for an empty picker.
 */
async function pickAttachTarget(extensionPath: string): Promise<number | undefined> {
  const hostPath = findHost(extensionPath);
  if (hostPath === undefined) {
    void vscode.window.showErrorMessage(MISSING_HOST_MESSAGE);
    return undefined;
  }

  const { DebugHost } = await import('@vscode-dataflex/debug');
  const host = new DebugHost();
  try {
    await host.start(hostPath);
    const reply = await host.send('attachable');
    const processes = Array.isArray(reply.processes) ? (reply.processes as number[]) : [];
    if (processes.length === 0) {
      void vscode.window.showInformationMessage(
        'DataFlex: no debuggable DataFlex programs are running. A program must be built with ' +
          'debug information to be attachable.'
      );
      return undefined;
    }

    const picked = await vscode.window.showQuickPick(
      processes.map((pid) => ({ label: `Process ${pid}`, pid })),
      { title: 'Attach to a running DataFlex program' }
    );
    return picked?.pid;
  } catch (error) {
    void vscode.window.showErrorMessage(
      `DataFlex: could not list attachable processes. ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  } finally {
    await host.dispose();
  }
}

/**
 * Registers everything the debugger contributes, or is never called at all.
 *
 * The single entry point exists so `extension.ts` has exactly one thing to put behind
 * `INCLUDE_DEBUGGER`. The manifest is stripped to match by `scripts/package-extension.mjs`, so a
 * build without this registration also has no `dataflex` debug type to invoke it.
 */
export function registerDebugging(
  context: vscode.ExtensionContext,
  client: DataFlexClient,
  statusBar: DataFlexStatusBar,
  output: vscode.OutputChannel
): void {
  const configuration = new DataflexDebugConfigurationProvider(client, statusBar, output);
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider('dataflex', configuration),
    // Also registered as a dynamic provider, which is what puts these configurations in the Run
    // and Debug view's list for a workspace that has no launch.json.
    vscode.debug.registerDebugConfigurationProvider(
      'dataflex',
      configuration,
      vscode.DebugConfigurationProviderTriggerKind.Dynamic
    ),
    vscode.debug.registerDebugAdapterDescriptorFactory(
      'dataflex',
      new DataflexDebugAdapterFactory(context.extensionPath, output)
    ),
    vscode.commands.registerCommand('dataflex.attach', async () => {
      const processId = await pickAttachTarget(context.extensionPath);
      if (processId === undefined) {
        return;
      }
      await vscode.debug.startDebugging(undefined, {
        type: 'dataflex',
        request: 'attach',
        name: `DataFlex: Attach to ${processId}`,
        processId
      });
    })
  );
}
