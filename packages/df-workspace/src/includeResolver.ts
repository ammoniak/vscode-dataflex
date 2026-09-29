import { readdirSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, normalize, resolve } from 'node:path';

/**
 * Extensions a bare `Use` name may be completed with.
 *
 * `Use cWebView.pkg` names the file outright, but `Use ui` does not, and the runtime library
 * relies on that shorter form.
 */
const IMPLIED_EXTENSIONS = [
  '.pkg',
  '.inc',
  '.dd',
  '.src',
  '.vw',
  '.wo',
  '.dg',
  '.rv',
  '.sl',
  '.mod',
  '.cls',
  '.bpo',
  '.pkd'
];

/**
 * Directories never worth walking when indexing.
 *
 * `AppHtml` matters: classic-ASP web apps keep VBScript `.inc` files there, and `.inc` is also a
 * DataFlex extension.
 */
const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'apphtml',
  'data',
  'programs',
  'bitmaps',
  '.vscode'
]);

/**
 * Field-definition files, which describe database tables rather than declaring code.
 *
 * `.fd` is what the Studio writes beside each data dictionary and what the compiler reads to make
 * `Customer.Name` resolve, so it is the workspace's own answer for what tables and columns exist.
 *
 * `.int` is the connection file for a SQL-backed table. It carries no column list, but it does
 * carry `FIELD_LENGTH` for the columns whose length was pinned by hand -- the only place on disk,
 * outside the binary table header, where a length can be read at all.
 */
export const FIELD_DEFINITION_EXTENSIONS: ReadonlySet<string> = new Set(['.fd', '.int']);

/**
 * Source files that carry no extension at all.
 *
 * `Lib\FMAC` is the compiler's own macro library -- its header says "THIS IS THE FILE THAT DEFINES
 * THE COMMANDS IN DATAFLEX" -- and it declares 444 `#COMMAND`s, including ones application code
 * uses constantly (`WebSetResponsive`). Without it the parser cannot know DataFlex's own statement
 * vocabulary, and every use of those commands parses as `unknown`.
 */
export const MACRO_FILENAMES: ReadonlySet<string> = new Set(['fmac']);

/** File extensions worth indexing as DataFlex source. */
export const DATAFLEX_EXTENSIONS: ReadonlySet<string> = new Set([
  '.src', '.pkg', '.dd', '.wo', '.vw', '.rv', '.sl', '.dg', '.mod', '.cls',
  '.bpo', '.rpt', '.mnu', '.inc', '.prg', '.mac', '.fmac', '.srv', '.ds', '.pkd'
]);

/**
 * Resolves `Use` / `#Include` names against the compiler's search path.
 *
 * The search path comes from `df-cli config --json` (`projects[].makepath`), so this only has to
 * reproduce the compiler's *lookup* rule -- first directory on the path that holds a matching
 * file wins -- and not its dependency resolution. Each directory is listed once and cached; the
 * index is flat because DataFlex does not search recursively.
 */
export class IncludeResolver {
  private readonly index = new Map<string, string>();
  private readonly directories: string[];

  constructor(searchPath: readonly string[]) {
    this.directories = searchPath.map((entry) => normalize(entry));
    this.rebuild();
  }

  /** Re-scans every search-path directory. Call after a build or a package install. */
  rebuild(): void {
    this.index.clear();
    for (const directory of this.directories) {
      let entries: string[];
      try {
        entries = readdirSync(directory);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const key = entry.toLowerCase();
        // First directory on the search path wins, matching the compiler.
        if (this.index.has(key)) {
          continue;
        }
        const full = join(directory, entry);
        try {
          if (statSync(full).isFile()) {
            this.index.set(key, full);
          }
        } catch {
          // Raced with a build; skip.
        }
      }
    }
  }

  /**
   * Every DataFlex source file reachable from the search path, **including subdirectories**.
   *
   * This deliberately differs from `resolve()`. The compiler looks a `Use` name up only in the
   * search-path directories themselves -- `Use Platform\Common\cUtils.pkg` spells the
   * subdirectory out -- so resolution stays flat. Indexing must not: real workspaces nest most of
   * their source (one real workspace keeps 10 files directly in `AppSrc` and 560 beneath it), and a flat scan
   * silently omits almost everything, leaving navigation and analysis working from a fraction of
   * the code.
   */
  allSourceFiles(): string[] {
    return this.filesWithExtensions(DATAFLEX_EXTENSIONS);
  }

  /**
   * Every `.fd` field-definition file on the search path.
   *
   * Kept separate from `allSourceFiles` rather than adding `.fd` to `DATAFLEX_EXTENSIONS`: these
   * are compiler input, not DataFlex source. Running them through `parseSource` would add a
   * `#REPLACE` for every column to the symbol index and the reference tallies, which is exactly
   * the kind of noise the dead-code rule cannot afford.
   */
  allFieldDefinitionFiles(): string[] {
    return this.filesWithExtensions(FIELD_DEFINITION_EXTENSIONS);
  }

  private filesWithExtensions(extensions: ReadonlySet<string>): string[] {
    const found: string[] = [];
    const seen = new Set<string>();

    const walk = (directory: string, depth: number): void => {
      // Deep enough for any real layout; a guard against a symlink loop.
      if (depth > 12) {
        return;
      }
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (SKIP_DIRECTORIES.has(entry.name.toLowerCase())) {
          continue;
        }
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (
          extensions.has(extname(entry.name).toLowerCase()) ||
          (extensions === DATAFLEX_EXTENSIONS && MACRO_FILENAMES.has(entry.name.toLowerCase()))
        ) {
          const key = full.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            found.push(full);
          }
        }
      }
    };

    for (const directory of this.directories) {
      walk(directory, 0);
    }
    return found;
  }

  /**
   * Resolves one `Use` / `#Include` name to an absolute path, or `undefined` if it is not on the
   * search path. `fromDirectory` handles the relative form (`Use Sub\Helper.pkg`).
   */
  resolve(name: string, fromDirectory?: string): string | undefined {
    const cleaned = name.trim().replace(/^["'<]+/, '').replace(/[">']+$/, '');
    if (cleaned.length === 0) {
      return undefined;
    }

    if (isAbsolute(cleaned)) {
      return this.firstExisting([cleaned, ...withImpliedExtensions(cleaned)]);
    }

    // A name containing a separator is relative to the including file, then to the search path.
    if (/[\\/]/.test(cleaned)) {
      const candidates: string[] = [];
      if (fromDirectory !== undefined) {
        candidates.push(resolve(fromDirectory, cleaned), ...withImpliedExtensions(resolve(fromDirectory, cleaned)));
      }
      for (const directory of this.directories) {
        const combined = resolve(directory, cleaned);
        candidates.push(combined, ...withImpliedExtensions(combined));
      }
      return this.firstExisting(candidates);
    }

    const direct = this.index.get(cleaned.toLowerCase());
    if (direct !== undefined) {
      return direct;
    }
    for (const extension of IMPLIED_EXTENSIONS) {
      const found = this.index.get((cleaned + extension).toLowerCase());
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }

  private firstExisting(candidates: string[]): string | undefined {
    for (const candidate of candidates) {
      try {
        if (statSync(candidate).isFile()) {
          return normalize(candidate);
        }
      } catch {
        // Not there; try the next candidate.
      }
    }
    return undefined;
  }
}

function withImpliedExtensions(path: string): string[] {
  return extname(path).length > 0 ? [] : IMPLIED_EXTENSIONS.map((extension) => path + extension);
}
