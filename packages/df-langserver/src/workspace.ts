import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DfWorkspace,
  IncludeResolver,
  SymbolIndex,
  TableIndex,
  cliForWorkspace,
  findWorkspaceFiles,
  loadWorkspace
} from '@vscode-dataflex/workspace';
import { DataFlexStatus, EMPTY_STATUS } from './protocol';

export interface WorkspaceOptions {
  /** Absolute path to `df-cli.exe`; empty to discover it. */
  cliPath?: string;
  /** `.sws` path relative to the workspace root; empty to detect it. */
  workspaceFile?: string;
}

/**
 * Owns workspace resolution and the declaration index for one folder.
 *
 * Everything derives from a single `df-cli config --json` call, which yields the compiler's own
 * include search path -- already resolving DataFlex 26's per-workspace `DfPkg` package cache.
 * Keeping this on the server side means the index, the status bar and the Test Explorer all read
 * the same resolution rather than each running `df-cli` and possibly disagreeing.
 */
export class ServerWorkspace {
  private cliPath: string | undefined;
  private workspace: DfWorkspace | undefined;
  private resolver: IncludeResolver | undefined;
  private index = new SymbolIndex();
  private tables = new TableIndex();
  private indexReady = false;
  private indexGeneration = 0;
  private lastError: string | undefined;

  constructor(
    readonly rootPath: string,
    private readonly log: (message: string) => void,
    private readonly onStatusChanged: () => void
  ) {}

  getResolver(): IncludeResolver | undefined {
    return this.resolver;
  }

  getWorkspace(): DfWorkspace | undefined {
    return this.workspace;
  }

  /** The index, or `undefined` until the first build completes. */
  getIndex(): SymbolIndex | undefined {
    return this.indexReady ? this.index : undefined;
  }

  /** Tables read from the workspace's `.fd` files, or `undefined` before the first build. */
  getTables(): TableIndex | undefined {
    return this.indexReady ? this.tables : undefined;
  }

  status(): DataFlexStatus {
    if (this.workspace === undefined) {
      return { ...EMPTY_STATUS, cliPath: this.cliPath, lastError: this.lastError };
    }
    return {
      cliPath: this.cliPath,
      workspaceName: this.workspace.name,
      swsPath: this.workspace.swsPath,
      root: this.workspace.root,
      projects: this.workspace.projects.map((project) => ({
        name: project.name,
        toolchain: project.toolchain,
        searchPathCount: project.makePath.length
      })),
      dependencyCount: this.workspace.dependencies.length,
      searchPathCount: this.workspace.searchPath.length,
      loadedSuccessfully: this.workspace.loadedSuccessfully,
      indexedFiles: this.index.fileCount,
      indexedNames: this.index.size,
      indexedClasses: this.index.classCount,
      indexReady: this.indexReady,
      lastError: this.lastError
    };
  }

  /** Resolves the workspace, then builds the index in the background. */
  async reload(options: WorkspaceOptions): Promise<void> {
    this.lastError = undefined;
    this.indexReady = false;

    // The workspace is chosen before the compiler, because the workspace is what says which
    // compiler it wants. Several DataFlex versions are routinely installed side by side, and
    // resolving a `"df": 26.0` workspace with the 27 CLI silently indexes the wrong runtime
    // library -- every `Use` lands in the wrong `Pkg` directory.
    const swsPath = this.pickWorkspaceFile(options.workspaceFile);
    if (swsPath === undefined) {
      this.fail(`No .sws workspace file found in ${this.rootPath}.`);
      return;
    }

    const resolved = await cliForWorkspace(swsPath, options.cliPath);
    this.cliPath = resolved.cliPath;
    if (this.cliPath === undefined) {
      this.fail(
        'Could not find df-cli.exe. Set "dataflex.cliPath" to its full path. DataFlex 26 has no ' +
          'standalone console compiler, so builds and workspace resolution both need it.'
      );
      return;
    }

    this.log(`Using df-cli: ${this.cliPath}`);
    if (resolved.warning !== undefined) {
      this.log(`Warning: ${resolved.warning}`);
    }

    const loaded = await loadWorkspace(this.cliPath, swsPath);
    if (loaded === undefined) {
      this.fail(`df-cli could not read ${swsPath}.`);
      return;
    }

    this.workspace = loaded;
    this.resolver = new IncludeResolver(loaded.searchPath);
    this.log(
      `Loaded workspace "${loaded.name}": ${loaded.projects.length} project(s), ` +
        `${loaded.dependencies.length} dependency/-ies, ${loaded.searchPath.length} search paths.`
    );
    if (!loaded.loadedSuccessfully) {
      this.log(
        'Warning: df-cli reported the workspace did not load cleanly; navigation may be incomplete.'
      );
    }
    this.onStatusChanged();

    await this.buildIndex();
  }

  /** Parses every file on the search path into the declaration index. */
  async buildIndex(): Promise<void> {
    const resolver = this.resolver;
    if (resolver === undefined) {
      return;
    }

    this.indexGeneration++;
    const generation = this.indexGeneration;
    const started = Date.now();
    const index = new SymbolIndex();

    await index.build(resolver, {
      isCancelled: () => generation !== this.indexGeneration
    });

    if (generation !== this.indexGeneration) {
      return;
    }

    // Tables come from `.fd` files, which are not DataFlex source and so are not part of the
    // symbol index build. There are a couple of hundred of them and each is a dozen lines, so
    // this costs far less than the walk that found them.
    const tables = new TableIndex();
    for (const file of resolver.allFieldDefinitionFiles()) {
      tables.addFile(file);
    }

    this.index = index;
    this.tables = tables;
    this.indexReady = true;
    this.log(
      `Indexed ${index.fileCount} files, ${index.size} names, ${index.classCount} classes, ` +
        `${tables.size} tables in ${Date.now() - started} ms.`
    );
    this.onStatusChanged();
  }

  /** Re-indexes a single file after an edit or a save. */
  reindexFile(uri: string, text?: string): void {
    if (!this.indexReady) {
      return;
    }
    let path: string;
    try {
      path = fileURLToPath(uri);
    } catch {
      return;
    }
    this.index.indexFile(path, text);
  }

  /**
   * Re-reads whatever changed on disk behind the editor's back.
   *
   * The per-file path above only ever fires for a document the editor had open and saved. A
   * `git checkout`, a Studio write or another tool's edit reaches the index through here instead,
   * and a host with no filesystem watcher at all can call it before answering.
   */
  refreshIndex(): { reindexed: number; removed: number } {
    if (!this.indexReady || this.resolver === undefined) {
      return { reindexed: 0, removed: 0 };
    }
    const changed = this.index.refreshStale(this.resolver);
    if (changed.reindexed > 0 || changed.removed > 0) {
      this.log(
        `Re-indexed ${changed.reindexed} changed file(s), dropped ${changed.removed} that are gone.`
      );
      this.onStatusChanged();
    }
    return changed;
  }

  /**
   * Rebuilds the table index from the workspace's `.fd` files.
   *
   * Not mtime-tracked like the symbol index: there are a couple of hundred `.fd` files and each is
   * a dozen lines, so re-reading all of them costs less than deciding which ones to re-read.
   */
  refreshTables(): void {
    if (!this.indexReady || this.resolver === undefined) {
      return;
    }
    const tables = new TableIndex();
    for (const file of this.resolver.allFieldDefinitionFiles()) {
      tables.addFile(file);
    }
    this.tables = tables;
  }

  private fail(message: string): void {
    this.lastError = message;
    this.workspace = undefined;
    this.resolver = undefined;
    this.log(message);
    this.onStatusChanged();
  }

  private pickWorkspaceFile(configured: string | undefined): string | undefined {
    if (configured !== undefined && configured.length > 0) {
      // Absolute is accepted so a non-editor host can pin one `.sws` outright; the extension's
      // `dataflex.workspaceFile` setting is documented relative and keeps resolving that way.
      return isAbsolute(configured) ? configured : join(this.rootPath, configured);
    }
    // More than one `.sws` in a folder is unusual; take the first deterministically rather than
    // blocking startup on a prompt the server cannot show.
    return findWorkspaceFiles(this.rootPath)[0];
  }
}
