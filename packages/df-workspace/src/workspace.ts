import { readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { runDfCli } from './cli';

/** One buildable project inside a workspace, as reported by `df-cli config --json`. */
export interface DfProject {
  name: string;
  /**
   * The compiler's include search path, in order.
   *
   * This is the single most valuable thing `df-cli` gives us. It already resolves the DataFlex
   * 26 package cache (`<workspace>/DfPkg/<publisher>_<name>-<version>/AppSrc`, where the whole
   * Web UI class library now lives) and appends the install's `Pkg` directory. Reimplementing it
   * would mean re-deriving dependency resolution and getting it subtly wrong.
   */
  makePath: string[];
  toolchain?: string;
  type?: string;
}

export interface DfDependency {
  id: string;
  version?: string;
  /** Absolute path the package was materialised to. */
  location?: string;
}

export interface DfWorkspace {
  /** Absolute path of the `.sws` file. */
  swsPath: string;
  /** Directory containing the `.sws`. */
  root: string;
  name: string;
  loadedSuccessfully: boolean;
  isLegacySws: boolean;
  projects: DfProject[];
  dependencies: DfDependency[];
  /** Union of every project's `makePath`, de-duplicated, in first-seen order. */
  searchPath: string[];
}

const SWS_EXTENSION = '.sws';

/** Finds `.sws` workspace files directly inside `folder` (workspaces keep theirs at the root). */
export function findWorkspaceFiles(folder: string): string[] {
  try {
    return readdirSync(folder)
      .filter((entry) => entry.toLowerCase().endsWith(SWS_EXTENSION))
      .map((entry) => join(folder, entry))
      .filter((path) => {
        try {
          return statSync(path).isFile();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

interface RawProject {
  name?: string;
  makepath?: string[];
  toolchain?: string;
  type?: string;
}

interface RawDependency {
  id?: string;
  version?: string;
  loaded?: { fslocation?: string };
}

interface RawConfig {
  name?: string;
  sws?: string;
  fslocation?: string;
  loadedSuccessfully?: boolean;
  isLegacySws?: boolean;
  projects?: RawProject[];
  dependencies?: Record<string, RawDependency>;
}

/**
 * Loads a workspace by asking `df-cli config --json` to resolve it.
 *
 * Returns `undefined` when the CLI cannot open the workspace at all; a workspace that opens with
 * problems comes back with `loadedSuccessfully: false` so the caller can surface that rather
 * than silently indexing an incomplete search path.
 */
export async function loadWorkspace(
  cliPath: string,
  swsPath: string
): Promise<DfWorkspace | undefined> {
  const result = await runDfCli(cliPath, ['config', '--json', swsPath], dirname(swsPath));
  if (result.stdout.trim().length === 0) {
    return undefined;
  }

  let raw: RawConfig;
  try {
    raw = JSON.parse(result.stdout) as RawConfig;
  } catch {
    return undefined;
  }

  const projects: DfProject[] = (raw.projects ?? []).map((project) => ({
    name: project.name ?? '',
    makePath: (project.makepath ?? []).map((p) => normalize(p)),
    toolchain: project.toolchain,
    type: project.type
  }));

  const dependencies: DfDependency[] = Object.values(raw.dependencies ?? {}).map((dep) => ({
    id: dep.id ?? '',
    version: dep.version,
    location: dep.loaded?.fslocation === undefined ? undefined : normalize(dep.loaded.fslocation)
  }));

  const searchPath: string[] = [];
  const seen = new Set<string>();
  for (const project of projects) {
    for (const entry of project.makePath) {
      const key = entry.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        searchPath.push(entry);
      }
    }
  }

  return {
    swsPath: normalize(raw.sws ?? swsPath),
    root: normalize(raw.fslocation ?? dirname(swsPath)),
    name: raw.name ?? '',
    loadedSuccessfully: raw.loadedSuccessfully ?? false,
    isLegacySws: raw.isLegacySws ?? false,
    projects,
    dependencies,
    searchPath
  };
}
