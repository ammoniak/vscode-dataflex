import type { TestProject } from '@vscode-dataflex/workspace';

/**
 * Custom requests layered on top of standard LSP.
 *
 * The server owns workspace resolution and the symbol index, so anything the client needs to
 * know about them -- the status bar, the build tasks, the Test Explorer -- comes through here
 * rather than the client running `df-cli` a second time and risking a different answer.
 */

export interface DataFlexProjectInfo {
  name: string;
  toolchain?: string;
  /** Number of entries on the compiler search path, useful for diagnosing a thin index. */
  searchPathCount: number;
}

export interface DataFlexStatus {
  /** Absolute path to the resolved `df-cli.exe`, if one was found. */
  cliPath?: string;
  workspaceName?: string;
  /** Absolute path to the `.sws`. */
  swsPath?: string;
  /** Directory containing the `.sws`; the working directory for builds and runs. */
  root?: string;
  projects: DataFlexProjectInfo[];
  dependencyCount: number;
  searchPathCount: number;
  /** Whether `df-cli` reported a clean load. A false value means navigation may be incomplete. */
  loadedSuccessfully: boolean;
  /** Files parsed into the index; zero while it is still building. */
  indexedFiles: number;
  /** Distinct declaration names in the index. */
  indexedNames: number;
  indexedClasses: number;
  /** True once the first index build has finished. */
  indexReady: boolean;
  /** Populated when the workspace could not be resolved at all. */
  lastError?: string;
}

export const EMPTY_STATUS: DataFlexStatus = {
  projects: [],
  dependencyCount: 0,
  searchPathCount: 0,
  loadedSuccessfully: false,
  indexedFiles: 0,
  indexedNames: 0,
  indexedClasses: 0,
  indexReady: false
};

/** Client -> server: current workspace and index state. */
export const StatusRequest = 'dataflex/status';

/** Server -> client: pushed whenever the status changes, so the status bar can follow along. */
export const StatusNotification = 'dataflex/statusChanged';

/** Client -> server: re-resolve the workspace and rebuild the index. */
export const ReloadRequest = 'dataflex/reload';

/** Client -> server: the DFUnit test tree, for the Test Explorer. */
export const DiscoverTestsRequest = 'dataflex/discoverTests';

export type DiscoverTestsResponse = TestProject[];

/** Client -> server: analyse every source file the workspace itself owns. */
export const AnalyzeWorkspaceRequest = 'dataflex/analyzeWorkspace';

export interface AnalyzeWorkspaceParams {
  /**
   * Rule ids to include. Omitted means every enabled rule.
   *
   * This is what lets a report be narrowed: `unused-local` alone can produce thousands of
   * findings on a large codebase, burying everything else in the Problems panel.
   */
  rules?: string[];
}

export interface AnalyzedFile {
  uri: string;
  diagnostics: import('vscode-languageserver').Diagnostic[];
}

export interface AnalyzeWorkspaceResponse {
  files: AnalyzedFile[];
  /** Files examined, including those with no findings. */
  filesAnalyzed: number;
  /** Files skipped by `dataflex.analysis.exclude`, reported so exclusion is never silent. */
  filesSkipped: number;
  /** Total findings across all files. */
  findings: number;
  /** Findings per rule id. */
  byRule: Record<string, number>;
}

/**
 * Client -> server: which source files a coverage run should instrument.
 *
 * Answered here rather than in the extension because the server owns the include resolver and the
 * search path; the status only reports how many entries that path has, not what they are.
 */
export const CoverageTargetsRequest = 'dataflex/coverageTargets';

export interface CoverageTargetsParams {
  /** Project name as it appears in the `.sws`, e.g. `UnitTest.src`. */
  project: string;
  /** Globs to leave out, from `dataflex.coverage.exclude`. */
  exclude?: string[];
}

export interface CoverageTargetsResponse {
  /** Absolute path of the project's `.src`, or undefined when it could not be resolved. */
  entry?: string;
  /** Files to instrument, each with every overlay path that could shadow it. */
  targets: { file: string; overlayPaths: string[] }[];
  /** Files left out by `exclude`, reported so exclusion is never silent. */
  excluded: number;
}

/**
 * Client -> server: the object definition that renders one web view.
 *
 * Answered here rather than in the extension because building it needs the class index -- which
 * class draws as which JavaScript control, which properties are client-side, what number an
 * `Enum_List` constant stands for -- and the server owns that. The extension only hosts the
 * webview and passes this through to the framework unaltered.
 */
export const PreviewModelRequest = 'dataflex/previewModel';

export interface PreviewModelParams {
  /** Document to preview. Its parsed unit is taken from the server's cache. */
  uri: string;
  /**
   * Responsive mode to lay out for, as an `rm*` constant value -- see `preview/modes.ts`.
   *
   * Omitted means the desktop base layout with no `WebSetResponsive` rule applied, which is what
   * the framework itself shows before its mode controller reports in.
   */
  mode?: number;
}

export type PreviewModelResponse = import('./preview/model').PreviewModel | undefined;
