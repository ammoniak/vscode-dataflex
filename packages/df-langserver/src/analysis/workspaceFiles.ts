/**
 * Decides which files a workspace-wide analysis should cover.
 *
 * Only the workspace's own source: findings inside `DfPkg` package dependencies or the runtime
 * library are somebody else's code, and there are enough of them to bury the ones the user can
 * actually act on.
 */

/** Splits a path on either separator, since resolved DataFlex paths mix them. */
function segments(path: string): string[] {
  return path.split(/[\\/]/);
}

/** True when `file` lives under `root` but not inside a materialised package dependency. */
export function isWorkspaceOwnedFile(file: string, root: string): boolean {
  const lowerFile = file.toLowerCase();
  const lowerRoot = root.toLowerCase();
  if (!lowerFile.startsWith(lowerRoot)) {
    return false;
  }
  // DataFlex 26 materialises dependencies into <workspace>/DfPkg/<publisher>_<name>-<version>.
  return !segments(lowerFile).includes('dfpkg');
}

/** Filters a file list down to the workspace's own source. */
export function ownedFiles(files: readonly string[], root: string): string[] {
  return files.filter((file) => isWorkspaceOwnedFile(file, root));
}

/**
 * Matches a path against a glob.
 *
 * Deliberately small -- a double star, a single star and `?` over `/`-separated segments --
 * because the only job is letting a user exclude generated code, as in a recursive pattern
 * ending in `ChilkatAx*.pkg`. Both separators are accepted and matching is case-insensitive, as
 * Windows paths require.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  const normalise = (value: string): string => value.replace(/\\/g, '/').toLowerCase();
  const target = normalise(path);

  let regex = '';
  const source = normalise(pattern);
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === '*') {
      if (source[i + 1] === '*') {
        // `**` crosses directory boundaries; `**/` may also match nothing at all.
        i++;
        if (source[i + 1] === '/') {
          i++;
          regex += '(?:.*/)?';
        } else {
          regex += '.*';
        }
      } else {
        regex += '[^/]*';
      }
    } else if (ch === '?') {
      regex += '[^/]';
    } else if ('.+^$(){}[]|'.includes(ch)) {
      regex += '\\' + ch;
    } else {
      regex += ch;
    }
  }

  try {
    return new RegExp(`^${regex}$`).test(target);
  } catch {
    // A malformed pattern must not take analysis down; it simply matches nothing.
    return false;
  }
}

/** True when any pattern excludes this path. */
export function isExcluded(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(path, pattern));
}
