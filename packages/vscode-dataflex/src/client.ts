import * as vscode from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind
} from 'vscode-languageclient/node';
import {
  CoverageTargetsParams,
  CoverageTargetsRequest,
  CoverageTargetsResponse,
  DataFlexStatus,
  DiscoverTestsRequest,
  DiscoverTestsResponse,
  EMPTY_STATUS,
  PreviewModelParams,
  PreviewModelRequest,
  PreviewModelResponse,
  ReloadRequest,
  StatusNotification,
  StatusRequest
} from '@vscode-dataflex/langserver/protocol';

/**
 * Owns the language server process and everything the rest of the extension needs from it.
 *
 * The server is the single source of truth for workspace resolution and the symbol index, so the
 * status bar, the build tasks and the Test Explorer all read from here instead of running
 * `df-cli` again and risking a different answer.
 */
export class DataFlexClient implements vscode.Disposable {
  private readonly client: LanguageClient;
  private readonly statusEmitter = new vscode.EventEmitter<DataFlexStatus>();
  private latest: DataFlexStatus = EMPTY_STATUS;

  /** Fires whenever the server reports new workspace or index state. */
  readonly onStatusChanged = this.statusEmitter.event;

  constructor(context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {
    const module = context.asAbsolutePath('out/server.js');
    const serverOptions: ServerOptions = {
      run: { module, transport: TransportKind.ipc },
      debug: {
        module,
        transport: TransportKind.ipc,
        options: { execArgv: ['--nolazy', '--inspect=6019'] }
      }
    };

    const clientOptions: LanguageClientOptions = {
      // `untitled` matters: a new, unsaved DataFlex buffer should get the same language
      // features. Without it the editor silently falls back to word-based suggestions, which
      // look plausible -- every word already in the file is offered -- while the class-aware
      // ranking is simply absent.
      documentSelector: [
        { scheme: 'file', language: 'dataflex' },
        { scheme: 'untitled', language: 'dataflex' }
      ],
      synchronize: {
        // The server re-resolves when the workspace definition changes: installing a package
        // rewrites DfPkg, which changes the include search path underneath it.
        //
        // Source files are watched for a different reason. The index is otherwise only corrected
        // when the editor saves a file it had open, so anything writing to disk behind it -- a
        // `git checkout`, the Studio, another tool -- leaves declarations that are not missing but
        // wrong, and a method that has since gained a parameter goes on being compared against its
        // old signature at every call site.
        fileEvents: vscode.workspace.createFileSystemWatcher(
          '**/*.{sws,src,pkg,dd,wo,vw,rv,dg,mod,cls,fd}'
        )
      },
      outputChannel: output,
      // Failing to start is worth surfacing; every language feature depends on it.
      revealOutputChannelOn: 4
    };

    this.client = new LanguageClient(
      'dataflex',
      'DataFlex Language Server',
      serverOptions,
      clientOptions
    );
  }

  async start(): Promise<void> {
    await this.client.start();
    this.client.onNotification(StatusNotification, (status: DataFlexStatus) => {
      this.latest = status;
      this.statusEmitter.fire(status);
    });
    // The first notification may already have fired before the handler was attached.
    await this.refreshStatus();
  }

  async dispose(): Promise<void> {
    this.statusEmitter.dispose();
    await this.client.stop();
  }

  /** The last status the server reported. Never `undefined`; empty before the server answers. */
  getStatus(): DataFlexStatus {
    return this.latest;
  }

  async refreshStatus(): Promise<DataFlexStatus> {
    try {
      this.latest = await this.client.sendRequest<DataFlexStatus>(StatusRequest);
    } catch (error) {
      this.output.appendLine(`Status request failed: ${String(error)}`);
    }
    this.statusEmitter.fire(this.latest);
    return this.latest;
  }

  /** Re-resolves the workspace and rebuilds the index. */
  async reload(): Promise<DataFlexStatus> {
    this.latest = await this.client.sendRequest<DataFlexStatus>(ReloadRequest);
    this.statusEmitter.fire(this.latest);
    return this.latest;
  }

  /** Sends an arbitrary custom request, returning `undefined` if the server errors. */
  async request<T>(method: string, params?: unknown): Promise<T | undefined> {
    try {
      return await this.client.sendRequest<T>(method, params);
    } catch (error) {
      this.output.appendLine(`Request ${method} failed: ${String(error)}`);
      return undefined;
    }
  }

  async discoverTests(): Promise<DiscoverTestsResponse> {
    try {
      return await this.client.sendRequest<DiscoverTestsResponse>(DiscoverTestsRequest);
    } catch (error) {
      this.output.appendLine(`Test discovery failed: ${String(error)}`);
      return [];
    }
  }

  /** Which source files a coverage run should instrument, resolved on the server. */
  async coverageTargets(params: CoverageTargetsParams): Promise<CoverageTargetsResponse> {
    try {
      return await this.client.sendRequest<CoverageTargetsResponse>(CoverageTargetsRequest, params);
    } catch (error) {
      this.output.appendLine(`Coverage target discovery failed: ${String(error)}`);
      return { targets: [], excluded: 0 };
    }
  }

  /**
   * The object definition that draws one web view.
   *
   * `undefined` when the index is not built yet, which the caller must distinguish from "this file
   * has nothing to draw": the first is worth waiting for and the second is not.
   */
  async previewModel(params: PreviewModelParams): Promise<PreviewModelResponse> {
    try {
      return await this.client.sendRequest<PreviewModelResponse>(PreviewModelRequest, params);
    } catch (error) {
      this.output.appendLine(`Preview model request failed: ${String(error)}`);
      return undefined;
    }
  }
}
