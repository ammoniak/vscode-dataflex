import { readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve as resolvePath, sep } from 'node:path';
import { join } from 'node:path';
import { ServerWorkspace } from '@vscode-dataflex/langserver';
import type { DataFlexStatus } from '@vscode-dataflex/langserver';
import type { DfWorkspace, IncludeResolver, SymbolIndex, TableIndex } from '@vscode-dataflex/workspace';

/** How often the freshness sweep may run. Cheap, but not worth doing twice in one breath. */
const SWEEP_INTERVAL_MS = 2_000;

/** How far below the root to look for a `.sws` when the root itself has none. */
const SEARCH_DEPTH = 2;

/** Directories that never hold a `.sws` and can be large. */
const SKIP = new Set(['apphtml', 'data', 'programs', 'dfpkg', 'node_modules', '.git', 'bitmaps', 'help']);

/** Windows and posix separators compared alike, so an agent's `MyApp/MyApp.sws` matches. */
function slash(value: string): string {
  return value.split(sep).join('/');
}

function swsIn(directory: string): string[] {
  try {
    return readdirSync(directory)
      .filter((entry) => entry.toLowerCase().endsWith('.sws'))
      .map((entry) => join(directory, entry));
  } catch {
    return [];
  }
}

function swsBelow(root: string, depth: number): string[] {
  if (depth <= 0) {
    return [];
  }
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP.has(entry.name.toLowerCase()) || entry.name.startsWith('.')) {
      continue;
    }
    const child = join(root, entry.name);
    found.push(...swsIn(child), ...swsBelow(child, depth - 1));
  }
  return found;
}

export interface SessionOptions {
  /** Folder to look in for a `.sws`. */
  root: string;
  /** An exact `.sws` to use, skipping discovery. */
  sws?: string;
  /** Where the workspace's own progress messages go. Never stdout -- that is the transport. */
  log?: (message: string) => void;
}

/** Everything an index-backed tool needs, resolved. */
export interface Loaded {
  index: SymbolIndex;
  resolver: IncludeResolver;
  workspace: DfWorkspace;
  tables: TableIndex | undefined;
  /** Files re-indexed since the last call, for the tool footer. Always 0 until the sweep lands. */
  refreshed: number;
}

/**
 * One workspace, loaded once, for the life of the process.
 *
 * Lazy on purpose. Resolving a workspace costs a `df-cli config --json` call and building the
 * index about a second, and a registration that is in scope for every project must not pay either
 * until a tool is actually called -- `dataflex_status` in a folder with no `.sws` answers in
 * milliseconds. `ensureIndex` keeps a single in-flight promise so two concurrent tool calls share
 * one build instead of racing two.
 */
export class McpSession {
  private readonly log: (message: string) => void;
  private workspace: ServerWorkspace | undefined;
  private loading: Promise<ServerWorkspace> | undefined;
  private lastSweep = 0;

  private swsOverride: string | undefined;

  constructor(private readonly options: SessionOptions) {
    this.log = options.log ?? ((): void => {});
    this.swsOverride = options.sws;
  }

  get root(): string {
    return this.options.root;
  }

  /**
   * The `.sws` files at the root, or failing that just below it.
   *
   * An agent's working directory is wherever the user started it, and a folder holding several
   * DataFlex workspaces side by side is an ordinary layout -- one such folder holds nine across
   * seven subfolders. Looking only at the root turned that into a dead end. Searching a couple of
   * levels down instead makes the answer either "here it is" or a list worth choosing from.
   *
   * Depth-limited and noise-skipping on purpose: this runs before anything is loaded, so it has
   * to stay cheap, and `AppHtml`, `Data` and `Programs` hold no `.sws`.
   */
  candidates(): string[] {
    const here = swsIn(this.options.root);
    return here.length > 0 ? here : swsBelow(this.options.root, SEARCH_DEPTH);
  }

  /**
   * Matches what the caller asked for against the workspaces actually present.
   *
   * Deliberately forgiving about the form, because the alternative is an agent pasting absolute
   * paths it got from a previous call: `MyApp`, `MyApp.sws`, `MyApp/MyApp.sws` and the full path
   * all name the same workspace. Ambiguity is refused rather than resolved by order.
   */
  resolveCandidate(wanted: string): { path: string } | { ambiguous: string[] } | undefined {
    const found = this.candidates();
    const needle = slash(wanted).replace(/\/+$/, '').toLowerCase();

    const exact = found.find((candidate) => candidate.toLowerCase() === resolvePath(wanted).toLowerCase());
    if (exact !== undefined) {
      return { path: exact };
    }

    // Tried in order of how specifically each names a workspace, and only the first tier that
    // matches is considered. Without that, `Editor` is ambiguous between the file
    // `Editor.sws` and the folder `Editor/` that holds it and one other -- which is not a
    // real ambiguity, it is just two ways of saying the same thing.
    const byFile = found.filter((candidate) => {
      const file = basename(candidate).toLowerCase();
      return file === needle || file === `${needle}.sws`;
    });
    const bySuffix = found.filter((candidate) =>
      slash(candidate.toLowerCase()).endsWith(`/${needle}`)
    );
    const byFolder = found.filter(
      (candidate) => basename(dirname(candidate)).toLowerCase() === needle
    );
    const matches = [byFile, bySuffix, byFolder].find((tier) => tier.length > 0) ?? [];
    if (matches.length === 1) {
      return { path: matches[0]! };
    }
    if (matches.length > 1) {
      return { ambiguous: matches };
    }
    // An absolute path to something the search did not reach is still worth honouring.
    return isAbsolute(wanted) ? { path: resolvePath(wanted) } : undefined;
  }

  /** True when the chosen workspace was found under the root rather than in it. */
  private foundBelowRoot(): boolean {
    return swsIn(this.options.root).length === 0;
  }

  /** Resolves the workspace and builds the index. Memoised; safe to call from every tool. */
  async ensureWorkspace(): Promise<ServerWorkspace> {
    if (this.workspace !== undefined) {
      return this.workspace;
    }
    this.loading ??= this.load();
    return this.loading;
  }

  private async load(): Promise<ServerWorkspace> {
    let chosen = this.swsOverride;

    // Only when the root itself holds none: several `.sws` *in* one folder is the ordinary
    // "one workspace, a few variants" case, and `ServerWorkspace` already picks the first
    // deterministically. Several found in *different* subfolders are different applications, and
    // picking one of those would be a guess with consequences, so it says so instead.
    if (chosen === undefined && this.foundBelowRoot()) {
      const found = this.candidates();
      if (found.length === 1) {
        chosen = found[0];
        this.log(`No .sws in ${this.options.root}; using ${chosen} found below it.`);
      } else if (found.length > 1) {
        this.log(
          `No .sws in ${this.options.root}, but ${found.length} below it. ` +
            'Choose one with dataflex_reload { sws }, or start the server with --sws.'
        );
      }
    }

    const workspace = new ServerWorkspace(this.options.root, this.log, () => {});
    await workspace.reload({ workspaceFile: chosen });
    this.workspace = workspace;
    return workspace;
  }

  /**
   * The index, or a thrown error naming what is missing.
   *
   * Throwing rather than returning `undefined` because every caller would otherwise repeat the
   * same three failure messages, and the MCP layer turns a thrown error into a tool error the
   * agent can read.
   */
  async ensureIndex(): Promise<Loaded> {
    const workspace = await this.ensureWorkspace();
    const status = workspace.status();
    const resolved = workspace.getWorkspace();
    const resolver = workspace.getResolver();
    if (resolved === undefined || resolver === undefined) {
      // Every tool funnels through here, so the list belongs in the error rather than only in
      // `dataflex_status`: an agent that called the wrong tool first should still learn what to
      // choose from without a second round trip.
      const found = this.candidates();
      const choices =
        found.length === 0
          ? ''
          : `\n\n${found.length} workspace(s) are available here. Choose one with ` +
            `dataflex_reload { sws: \"<name>\" } -- the folder name is enough:\n` +
            found.map((candidate) => `  ${candidate}`).join('\n');
      throw new Error(
        (status.lastError ?? `No DataFlex workspace resolved in ${this.options.root}.`) + choices
      );
    }
    const index = workspace.getIndex();
    if (index === undefined) {
      throw new Error('The declaration index is not ready yet. Try again in a moment.');
    }
    const refreshed = this.refreshStale(workspace);
    return { index, resolver, workspace: resolved, tables: workspace.getTables(), refreshed };
  }

  /**
   * Re-indexes the files that changed since the index was built.
   *
   * Necessary because the agent calling these tools is also the thing editing the files, so an
   * index built once at startup is stale by the second call.
   *
   * The comparison lives in the index itself, against the modification time each file had when it
   * was read. A sweep kept here instead could only start recording from its own first run, so a
   * change landing between the build and that run was invisible; and it had no way to drop a
   * deleted file's declarations, which then went on answering lookups. Deciding from the index's
   * own record covers the whole search path rather than just the workspace's own files, which is
   * what a wrong arity needs -- the declaration a call is checked against may sit in a sibling
   * library.
   */
  private refreshStale(workspace: ServerWorkspace): number {
    const now = Date.now();
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) {
      return 0;
    }
    this.lastSweep = now;

    const changed = workspace.refreshIndex();
    return changed.reindexed + changed.removed;
  }

  /** Throws the workspace away and resolves it again, picking up new files and a different .sws. */
  async reload(sws?: string): Promise<void> {
    this.workspace = undefined;
    this.loading = undefined;
    this.lastSweep = 0;
    if (sws !== undefined) {
      const match = this.resolveCandidate(sws);
      if (match === undefined) {
        throw new Error(
          `No workspace matching \"${sws}\" here. Available:\n` +
            this.candidates().map((candidate) => `  ${candidate}`).join('\n')
        );
      }
      if ('ambiguous' in match) {
        throw new Error(
          `\"${sws}\" matches more than one workspace; name it more precisely:\n` +
            match.ambiguous.map((candidate) => `  ${candidate}`).join('\n')
        );
      }
      this.swsOverride = match.path;
    }
    await this.ensureWorkspace();
  }

  /** The `df-cli.exe` the workspace resolved with, once it has loaded. */
  cliPath(): string | undefined {
    return this.workspace?.status().cliPath;
  }

  /** Status without forcing a load, so a cold `dataflex_status` stays cheap. */
  status(): DataFlexStatus | undefined {
    return this.workspace?.status();
  }
}
