import { normalize } from 'node:path';
import { parseSource } from '@vscode-dataflex/parser';
import { IncludeResolver } from './includeResolver';
import { readSourceFile } from './symbolIndex';

/**
 * Works out which source files a coverage run should instrument.
 *
 * Reachability from the test program's `.src` is what bounds the set: a real workspace's `UnitTest.src` pulls
 * in six packages and their dependencies, not all 570 files under `AppSrc`. Instrumenting the
 * whole tree would inflate compile time for code the suite cannot reach anyway.
 */

/** One file to instrument, with every overlay path that could shadow it. */
export interface CoverageTarget {
  /** Absolute path of the original. */
  file: string;
  /**
   * Relative, `/`-separated paths inside the overlay.
   *
   * The compiler resolves `Use Platform\Common\cUtils.pkg` by joining that spelling onto each
   * search-path directory in turn, so a file under two of them is reachable by two spellings.
   * Writing the instrumented copy to every one of them means no spelling can quietly find the
   * original and report the file as wholly uncovered.
   */
  overlayPaths: string[];
}

export interface CoverageTargetOptions {
  /** Absolute path of the project's `.src`. */
  entry: string;
  resolver: IncludeResolver;
  /** The compiler's search path, from `df-cli config --json`. */
  searchPath: readonly string[];
  /** Only files under this root, and outside `DfPkg`, are instrumented. */
  root: string;
  /** True for a file the caller wants left out entirely. */
  isExcluded?: (file: string) => boolean;
  /** True when a file belongs to the workspace rather than a dependency. */
  isOwned: (file: string, root: string) => boolean;
}

/** Directory part of a path, for resolving a `Use` relative to the file that wrote it. */
function directoryOf(file: string): string {
  return file.replace(/[\\/][^\\/]*$/, '');
}

/**
 * Collects the instrumentable files reachable from `entry`.
 *
 * The walk descends only through files the workspace owns. Following `Use` into the runtime
 * library instead would mean parsing the entire Web UI class library on every coverage run to
 * find, at best, the rare package that reaches back into application code.
 */
export function coverageTargets(options: CoverageTargetOptions): CoverageTarget[] {
  const { entry, resolver, root, isOwned } = options;
  const directories = options.searchPath.map((entry) => normalize(entry));

  const seen = new Set<string>();
  const targets: CoverageTarget[] = [];
  const queue = [normalize(entry)];

  while (queue.length > 0) {
    const file = queue.shift()!;
    const key = file.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    if (!isOwned(file, root)) {
      continue;
    }

    const text = readSourceFile(file);
    if (text === undefined) {
      continue;
    }

    if (options.isExcluded?.(file) !== true) {
      targets.push({ file, overlayPaths: overlayPathsFor(file, directories) });
    }

    let uses;
    try {
      uses = parseSource(text, { uri: file }).uses;
    } catch {
      continue;
    }
    for (const use of uses) {
      if (use.name === undefined) {
        continue;
      }
      const resolved = resolver.resolve(use.name, directoryOf(file));
      if (resolved !== undefined) {
        queue.push(normalize(resolved));
      }
    }
  }

  return targets;
}

/** Every relative spelling under which a search-path directory could reach this file. */
function overlayPathsFor(file: string, directories: readonly string[]): string[] {
  const lower = file.toLowerCase();
  const paths: string[] = [];

  for (const directory of directories) {
    const prefix = directory.toLowerCase().replace(/[\\/]+$/, '') + '\\';
    const alt = directory.toLowerCase().replace(/[\\/]+$/, '') + '/';
    if (lower.startsWith(prefix) || lower.startsWith(alt)) {
      const relative = file.slice(directory.replace(/[\\/]+$/, '').length + 1).replace(/\\/g, '/');
      if (relative.length > 0 && !paths.includes(relative)) {
        paths.push(relative);
      }
    }
  }

  // A file on no search-path directory cannot be reached by a `Use` at all, so nothing would
  // shadow it. Keeping its base name means it is at least present rather than silently dropped.
  if (paths.length === 0) {
    paths.push(file.split(/[\\/]/).pop() ?? file);
  }

  return paths;
}
