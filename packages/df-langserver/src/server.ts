import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CodeActionKind,
  DidChangeConfigurationNotification,
  InitializeResult,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
  createConnection
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { SourceUnit, parseSource } from '@vscode-dataflex/parser';
import { TestDiscovery, coverageTargets, readSourceFile } from '@vscode-dataflex/workspace';
import {
  AnalyzeWorkspaceParams,
  AnalyzeWorkspaceRequest,
  AnalyzeWorkspaceResponse,
  AnalyzedFile,
  CoverageTargetsParams,
  CoverageTargetsRequest,
  CoverageTargetsResponse,
  DiscoverTestsRequest,
  DiscoverTestsResponse,
  EMPTY_STATUS,
  PreviewModelParams,
  PreviewModelRequest,
  PreviewModelResponse,
  ReloadRequest,
  StatusNotification,
  StatusRequest
} from './protocol';
import { buildPreviewModel } from './preview/model';
import { ServerWorkspace, WorkspaceOptions } from './workspace';
import { documentHighlights, references } from './providers/references';
import { codeActions } from './providers/codeActions';
import { signatureHelp } from './providers/signatureHelp';
import { SEMANTIC_TOKENS_LEGEND, semanticTokens } from './providers/semanticTokens';
import { prepareRename, rename } from './providers/rename';
import { formatting } from './providers/formatting';
import { inlayHints } from './providers/inlayHints';
import { analyze } from './analysis/analyze';
import { analyzeWorkspace } from './analysis/analyzeWorkspace';
import { overridesAncestor } from './analysis/overrides';
import type { MethodOwner } from './analysis/overrides';
import { isExcluded, isWorkspaceOwnedFile } from './analysis/workspaceFiles';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver';
import { RuleSettings, defaultRuleSettings } from './analysis/rules';
import { documentSymbols, foldingRanges } from './providers/documentSymbols';
import { definition, hover, wordAt, workspaceSymbols } from './providers/navigation';
import { DEFAULT_DOCS_BASE_URL } from './providers/docsLink';
import { completion } from './providers/completion';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

/** One parse per document version, shared by every provider handling that keystroke. */
const parseCache = new Map<string, { version: number; unit: SourceUnit }>();

let workspace: ServerWorkspace | undefined;
let settings: WorkspaceOptions = {};
let ruleSettings: RuleSettings = defaultRuleSettings();
let analysisSeverity: DiagnosticSeverity = DiagnosticSeverity.Hint;
/** Globs excluded from analysis; empty by default so nothing is ever hidden silently. */
let analysisExclude: string[] = [];
/** Per-rule severity, overriding the global default. */
let severityOverrides: Record<string, DiagnosticSeverity> = {};
/** Base URL for hover documentation links; empty disables them. */
let docsBaseUrl: string = DEFAULT_DOCS_BASE_URL;
let hoverTableFields = false;
let inlayHintsEnabled = false;
let inlayHintsSuppressMatching = true;

const SEVERITY_BY_NAME: Record<string, DiagnosticSeverity> = {
  hint: DiagnosticSeverity.Hint,
  information: DiagnosticSeverity.Information,
  warning: DiagnosticSeverity.Warning
};

/** Pending diagnostic runs, so a burst of keystrokes analyses once. */
const analysisTimers = new Map<string, NodeJS.Timeout>();
const ANALYSIS_DELAY_MS = 300;

function log(message: string): void {
  connection.console.log(message);
}

function unitFor(document: TextDocument): SourceUnit {
  const cached = parseCache.get(document.uri);
  if (cached !== undefined && cached.version === document.version) {
    return cached.unit;
  }
  const unit = parseSource(document.getText(), { uri: document.uri });
  parseCache.set(document.uri, { version: document.version, unit });
  return unit;
}

/**
 * An override test bound to the current index, or `undefined` before it is ready.
 *
 * Returning `undefined` matters: with no index the honest answer is "cannot tell", and
 * `unused-parameter` then reports nothing rather than flooding with event overrides.
 */
function makeOverrideCheck(): ((name: string, owner: MethodOwner) => boolean) | undefined {
  const index = workspace?.getIndex();
  if (index === undefined) {
    return undefined;
  }
  return (name, owner) => overridesAncestor(index, name, owner);
}

function publishStatus(): void {
  void connection.sendNotification(StatusNotification, workspace?.status() ?? EMPTY_STATUS);
}

connection.onInitialize((params): InitializeResult => {
  const folder = params.workspaceFolders?.[0];
  if (folder !== undefined) {
    try {
      workspace = new ServerWorkspace(fileURLToPath(folder.uri), log, publishStatus);
    } catch {
      workspace = undefined;
    }
  }

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      documentSymbolProvider: true,
      foldingRangeProvider: true,
      definitionProvider: true,
      hoverProvider: true,
      workspaceSymbolProvider: true,
      referencesProvider: true,
      codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
      // A space is what separates DataFlex arguments, so it is also what advances the signature.
      signatureHelpProvider: { triggerCharacters: [' '], retriggerCharacters: [' '] },
      semanticTokensProvider: { legend: SEMANTIC_TOKENS_LEGEND, full: true },
      renameProvider: { prepareProvider: true },
      documentFormattingProvider: true,
      inlayHintProvider: true,
      documentHighlightProvider: true,
      completionProvider: {
        // Re-trigger after a space so `WebSet ` offers properties before anything is typed.
        triggerCharacters: [' '],
        resolveProvider: false
      }
    }
  };
});

connection.onInitialized(async () => {
  void connection.client.register(DidChangeConfigurationNotification.type, undefined);
  settings = await readSettings();
  await workspace?.reload(settings);
  publishStatus();
});

async function readSettings(): Promise<WorkspaceOptions> {
  try {
    const configuration = (await connection.workspace.getConfiguration('dataflex')) as {
      cliPath?: string;
      workspaceFile?: string;
      analysis?: Partial<RuleSettings> & {
        severity?: string;
        exclude?: string[];
        severityOverrides?: Record<string, string>;
      };
      docs?: { baseUrl?: string };
      hover?: { tableFields?: boolean };
      inlayHints?: { parameterNames?: boolean; suppressWhenArgumentMatchesName?: boolean };
    } | null;
    docsBaseUrl = (configuration?.docs?.baseUrl ?? DEFAULT_DOCS_BASE_URL).trim();
    hoverTableFields = configuration?.hover?.tableFields === true;
    inlayHintsEnabled = configuration?.inlayHints?.parameterNames === true;
    inlayHintsSuppressMatching =
      configuration?.inlayHints?.suppressWhenArgumentMatchesName !== false;
    const analysis = { ...(configuration?.analysis ?? {}) };
    analysisSeverity = SEVERITY_BY_NAME[String(analysis.severity ?? 'hint')] ?? DiagnosticSeverity.Hint;
    analysisExclude = Array.isArray(analysis.exclude) ? analysis.exclude : [];

    // Per-rule severity: a noisy-but-useful rule can stay a greyed-out hint while the rest are
    // raised into the Problems panel.
    severityOverrides = {};
    for (const [rule, name] of Object.entries(analysis.severityOverrides ?? {})) {
      const mapped = SEVERITY_BY_NAME[String(name)];
      if (mapped !== undefined) {
        severityOverrides[rule] = mapped;
      }
    }

    delete analysis.severity;
    delete analysis.exclude;
    delete analysis.severityOverrides;
    ruleSettings = { ...defaultRuleSettings(), ...analysis };
    return {
      cliPath: configuration?.cliPath,
      workspaceFile: configuration?.workspaceFile
    };
  } catch {
    return {};
  }
}

/**
 * Publishes analysis findings for one document.
 *
 * Debounced because analysis runs on every keystroke and re-scans the token stream; 300 ms is
 * short enough to feel immediate and long enough that typing a word does not analyse six times.
 */
function scheduleAnalysis(uri: string): void {
  const existing = analysisTimers.get(uri);
  if (existing !== undefined) {
    clearTimeout(existing);
  }
  analysisTimers.set(
    uri,
    setTimeout(() => {
      analysisTimers.delete(uri);
      const document = documents.get(uri);
      if (document === undefined) {
        return;
      }
      void connection.sendDiagnostics({
        uri,
        diagnostics: analyze(unitFor(document), {
          settings: ruleSettings,
          severity: analysisSeverity,
          severityOverrides,
          overridesAncestor: makeOverrideCheck()
        })
      });
    }, ANALYSIS_DELAY_MS)
  );
}

connection.onDidChangeConfiguration(async () => {
  const next = await readSettings();
  const changed = next.cliPath !== settings.cliPath || next.workspaceFile !== settings.workspaceFile;
  settings = next;
  if (changed) {
    await workspace?.reload(settings);
  }
  // Rule toggles take effect without an edit.
  for (const document of documents.all()) {
    scheduleAnalysis(document.uri);
  }
});

// --- document lifecycle ----------------------------------------------------

documents.onDidOpen((event) => {
  scheduleAnalysis(event.document.uri);
});

documents.onDidChangeContent((event) => {
  scheduleAnalysis(event.document.uri);
});

documents.onDidClose((event) => {
  parseCache.delete(event.document.uri);
  const timer = analysisTimers.get(event.document.uri);
  if (timer !== undefined) {
    clearTimeout(timer);
    analysisTimers.delete(event.document.uri);
  }
  // Clear findings for a file nobody is looking at any more.
  void connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

documents.onDidSave((event) => {
  // Keep the cross-file index current: one file, one parse.
  workspace?.reindexFile(event.document.uri, event.document.getText());
});

// --- files changing behind the editor --------------------------------------

/**
 * How long a burst of filesystem events is allowed to settle before the index is corrected.
 *
 * A `git checkout` between branches reports hundreds of files at once, and there is no point
 * re-reading anything until the last of them has landed.
 */
const FILE_CHANGE_DEBOUNCE_MS = 300;

let fieldDefinitionsChanged = false;
let fileChangeTimer: NodeJS.Timeout | undefined;

function extensionOf(uri: string): string {
  const at = uri.lastIndexOf('.');
  return at === -1 ? '' : uri.slice(at).toLowerCase();
}

/**
 * Brings the index back in line with the disk, then re-analyses whatever is open.
 *
 * The changed paths are deliberately not used to decide what to re-read. `refreshIndex` compares
 * the modification time of every file on the search path against the one it was indexed with, so
 * it handles creations, deletions and edits alike, re-reads only what actually moved, and cannot
 * disagree with the index about which extensions count. It also catches the changes no watcher
 * reported -- the search path reaches outside the folder the editor has open, into sibling
 * libraries and the runtime `Pkg` directory. A save that came through the editor is already
 * indexed, and is skipped here for the same reason.
 */
function applyFileChanges(): void {
  const tablesChanged = fieldDefinitionsChanged;
  fieldDefinitionsChanged = false;

  const changed = workspace?.refreshIndex() ?? { reindexed: 0, removed: 0 };
  if (tablesChanged) {
    workspace?.refreshTables();
  }
  if (changed.reindexed === 0 && changed.removed === 0 && !tablesChanged) {
    return;
  }
  // Findings and hovers in open files are answered against the index, so they are stale too.
  for (const document of documents.all()) {
    scheduleAnalysis(document.uri);
  }
}

connection.onDidChangeWatchedFiles((params) => {
  // A `.sws` says which compiler and which search path the workspace has, so nothing below it can
  // be patched up file by file -- the whole resolution has to be taken again.
  if (params.changes.some((change) => extensionOf(change.uri) === '.sws')) {
    fieldDefinitionsChanged = false;
    if (fileChangeTimer !== undefined) {
      clearTimeout(fileChangeTimer);
      fileChangeTimer = undefined;
    }
    void workspace?.reload(settings).then(() => {
      publishStatus();
      for (const document of documents.all()) {
        scheduleAnalysis(document.uri);
      }
    });
    return;
  }

  // `.fd` files are the one input the symbol index does not hold, so they are the one thing worth
  // reading off the event list.
  if (params.changes.some((change) => extensionOf(change.uri) === '.fd')) {
    fieldDefinitionsChanged = true;
  }

  if (fileChangeTimer !== undefined) {
    clearTimeout(fileChangeTimer);
  }
  fileChangeTimer = setTimeout(() => {
    fileChangeTimer = undefined;
    applyFileChanges();
  }, FILE_CHANGE_DEBOUNCE_MS);
});

// --- language features -----------------------------------------------------

connection.onDocumentSymbol((params) => {
  const document = documents.get(params.textDocument.uri);
  return document === undefined ? [] : documentSymbols(unitFor(document));
});

connection.onFoldingRanges((params) => {
  const document = documents.get(params.textDocument.uri);
  return document === undefined ? [] : foldingRanges(unitFor(document));
});

connection.onDefinition((params) => {
  const document = documents.get(params.textDocument.uri);
  if (document === undefined) {
    return [];
  }
  return definition(
    unitFor(document),
    document,
    params.position,
    workspace?.getResolver(),
    workspace?.getIndex()
  );
});

connection.onHover((params) => {
  const document = documents.get(params.textDocument.uri);
  return document === undefined
    ? undefined
    : hover(unitFor(document), document, params.position, workspace?.getIndex(), {
        docsBaseUrl,
        root: workspace?.getWorkspace()?.root,
        tables: workspace?.getTables(),
        tableFields: hoverTableFields
      });
});

/**
 * The absolute path behind a document URI.
 *
 * `undefined` for an untitled buffer, which has no file to compare against the index.
 */
function fileOf(document: TextDocument): string | undefined {
  try {
    return fileURLToPath(document.uri);
  } catch {
    return undefined;
  }
}

connection.languages.inlayHint.on((params) => {
  const document = documents.get(params.textDocument.uri);
  return document === undefined
    ? []
    : inlayHints(unitFor(document), workspace?.getIndex(), params.range, {
        enabled: inlayHintsEnabled,
        suppressWhenArgumentMatchesName: inlayHintsSuppressMatching
      });
});

connection.onDocumentFormatting((params) => {
  const document = documents.get(params.textDocument.uri);
  return document === undefined
    ? []
    : formatting(unitFor(document), document.getText(), {
        tabSize: params.options.tabSize,
        insertSpaces: params.options.insertSpaces
      });
});

connection.onPrepareRename((params) => {
  const document = documents.get(params.textDocument.uri);
  const word = document === undefined ? undefined : wordAt(document, params.position);
  if (document === undefined || word === undefined) {
    return null;
  }
  const result = prepareRename(unitFor(document), word, workspace?.getIndex(), {
    root: workspace?.getWorkspace()?.root
  });
  // A refusal is thrown, not returned: that is how the protocol surfaces the reason to the user
  // instead of silently doing nothing.
  if ('reason' in result) {
    throw new Error(result.reason);
  }
  return result.range;
});

connection.onRenameRequest((params) => {
  const document = documents.get(params.textDocument.uri);
  const word = document === undefined ? undefined : wordAt(document, params.position);
  if (document === undefined || word === undefined) {
    return null;
  }
  const result = rename(unitFor(document), word, params.newName, workspace?.getIndex(), {
    root: workspace?.getWorkspace()?.root,
    currentFile: fileOf(document),
    readFile: (file) => {
      const open = documents.get(pathToFileURL(file).toString());
      return open === undefined ? readSourceFile(file) : open.getText();
    }
  });
  if ('reason' in result) {
    throw new Error(result.reason);
  }
  return result;
});

connection.languages.semanticTokens.on((params) => {
  const document = documents.get(params.textDocument.uri);
  return {
    data:
      document === undefined
        ? []
        : semanticTokens(unitFor(document), workspace?.getIndex(), {
            root: workspace?.getWorkspace()?.root
          })
  };
});

connection.onSignatureHelp((params) => {
  const document = documents.get(params.textDocument.uri);
  return document === undefined
    ? undefined
    : signatureHelp(unitFor(document), params.position, workspace?.getIndex());
});

connection.onCodeAction((params) => {
  const document = documents.get(params.textDocument.uri);
  return document === undefined ? [] : codeActions(document, params.context.diagnostics);
});

connection.onReferences((params) => {
  const document = documents.get(params.textDocument.uri);
  if (document === undefined) {
    return [];
  }
  const word = wordAt(document, params.position);
  if (word === undefined) {
    return [];
  }
  return references(workspace?.getIndex(), word.text, {
    includeDeclaration: params.context?.includeDeclaration !== false,
    // Open documents win over disk, so unsaved edits are searched as they appear on screen.
    readFile: (file) => {
      const open = documents.get(pathToFileURL(file).toString());
      return open === undefined ? readSourceFile(file) : open.getText();
    }
  });
});

connection.onDocumentHighlight((params) => {
  const document = documents.get(params.textDocument.uri);
  if (document === undefined) {
    return [];
  }
  const word = wordAt(document, params.position);
  if (word === undefined) {
    return [];
  }
  const declarations = (workspace?.getIndex()?.lookup(word.text) ?? [])
    .filter((entry) => entry.file.toLowerCase() === fileOf(document)?.toLowerCase())
    .map((entry) => entry.nameRange);
  return documentHighlights(unitFor(document), word.text, declarations);
});

connection.onCompletion((params) => {
  const document = documents.get(params.textDocument.uri);
  return document === undefined
    ? undefined
    : completion(unitFor(document), document, params.position, workspace?.getIndex());
});

connection.onWorkspaceSymbol((params) => workspaceSymbols(params.query, workspace?.getIndex()));

// --- custom requests -------------------------------------------------------

connection.onRequest(StatusRequest, () => workspace?.status() ?? EMPTY_STATUS);

connection.onRequest(ReloadRequest, async () => {
  await workspace?.reload(settings);
  return workspace?.status() ?? EMPTY_STATUS;
});

connection.onRequest(DiscoverTestsRequest, (): DiscoverTestsResponse => {
  const resolver = workspace?.getResolver();
  const projects = workspace?.getWorkspace()?.projects;
  if (resolver === undefined || projects === undefined) {
    return [];
  }
  return new TestDiscovery(resolver, workspace?.getIndex()).discoverProjects(projects);
});

/**
 * Reports which source files a coverage run should instrument.
 *
 * Reachability from the test program's `.src` is what bounds the set. Instrumenting everything
 * under `AppSrc` would inflate compile time for code the suite cannot reach anyway -- one real
 * workspace's `UnitTest.src` reaches 13 files, not 570.
 */
connection.onRequest(CoverageTargetsRequest, (params: CoverageTargetsParams): CoverageTargetsResponse => {
  const resolver = workspace?.getResolver();
  const loaded = workspace?.getWorkspace();
  if (resolver === undefined || loaded === undefined) {
    return { targets: [], excluded: 0 };
  }

  const entry = resolver.resolve(params.project);
  if (entry === undefined) {
    return { targets: [], excluded: 0 };
  }

  const exclude = params.exclude ?? [];
  let excluded = 0;
  const targets = coverageTargets({
    entry,
    resolver,
    searchPath: loaded.searchPath,
    root: loaded.root,
    isOwned: isWorkspaceOwnedFile,
    isExcluded: (file) => {
      const skip = isExcluded(file, exclude);
      if (skip) {
        excluded++;
      }
      return skip;
    }
  });

  return { entry, targets, excluded };
});

/**
 * The object definition that draws one web view.
 *
 * Needs the index and nothing else the client has: which JavaScript class draws a DataFlex class,
 * which properties are client-side, and what number an `Enum_List` constant stands for are all
 * questions only the index can answer. Returns `undefined` while the index is still building --
 * the client shows "waiting for the index" rather than an empty preview, which would look like the
 * file has nothing in it.
 */
connection.onRequest(PreviewModelRequest, (params: PreviewModelParams): PreviewModelResponse => {
  const index = workspace?.getIndex();
  const document = documents.get(params.uri);
  if (index === undefined || document === undefined) {
    return undefined;
  }
  return buildPreviewModel(unitFor(document), index, {
    ...(params.mode === undefined ? {} : { mode: params.mode })
  });
});

/** Delegates to `analyzeWorkspace`, which the MCP server and any script share. */
connection.onRequest(AnalyzeWorkspaceRequest, (params?: AnalyzeWorkspaceParams): AnalyzeWorkspaceResponse => {
  const resolver = workspace?.getResolver();
  const root = workspace?.getWorkspace()?.root;
  if (resolver === undefined || root === undefined) {
    return { files: [], filesAnalyzed: 0, filesSkipped: 0, findings: 0, byRule: {} };
  }

  // The watcher only covers the folder the editor has open, while the search path reaches outside
  // it -- sibling libraries, `DfPkg`, the runtime `Pkg` directory. `argument-count` compares a call
  // against a declaration that may live in any of them, so the index is brought up to date here
  // rather than trusting that every change was seen.
  workspace?.refreshIndex();

  return analyzeWorkspace({
    resolver,
    index: workspace?.getIndex(),
    root,
    settings: ruleSettings,
    severity: analysisSeverity,
    severityOverrides,
    exclude: analysisExclude,
    ...(params?.rules === undefined ? {} : { rules: params.rules })
  });
});

documents.listen(connection);
connection.listen();
