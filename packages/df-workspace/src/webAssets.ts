/**
 * Finding the web framework a workspace runs on.
 *
 * A DataFlex web application carries its own copy of the client framework under `AppHtml`: the
 * engine, the themes, and the JavaScript half of every custom control the application defines.
 * `df-cli` maintains the list in `AppHtml\Index.html` between marker comments, which is the only
 * authoritative statement of what a page needs to load -- the framework version the project
 * actually uses, and custom controls that nothing else enumerates.
 *
 * Anything that wants to draw the application's controls outside the application reads it from
 * here, in place. The framework is DataFlex's, so it is never copied anywhere.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Where a workspace keeps its web assets. */
export const APP_HTML = 'AppHtml';

/** The engine, relative to `AppHtml`. Its absence means this is not a web workspace. */
const ENGINE = 'WebUI/df-min.js';

/**
 * Blocks `df-cli` maintains in `Index.html`, and what ends each one.
 *
 * The two are shaped differently. The managed includes have an explicit closing marker. The custom
 * controls block has only an opening one, so it is read to the end of the `<head>`: every custom
 * control's script is inserted after that marker, and there is nothing else in a `<head>` that a
 * preview would be harmed by loading. Ending it at the next comment instead looks tidier and is
 * wrong -- a real application comments its own control scripts, and one such loses Froala, the PDF
 * viewer, dhtmlx and its translation package to the first `<!--` inside the block.
 *
 * Both markers are themselves HTML comments, which is the other trap: searching for a block's end
 * from the marker text finds the marker's own `-->` and yields nothing at all.
 */
const MANAGED_BLOCKS: readonly { open: string; close: string }[] = [
  { open: 'Managed Includes (do not remove this line', close: 'End of Managed Includes' },
  { open: 'DataFlex Custom Controls (do not remove this line', close: '</head>' }
];

export interface WebAssets {
  /** Absolute path of the workspace's `AppHtml` directory. */
  appHtml: string;
  /** Theme folder names under `AppHtml\CssThemes`. */
  themes: string[];
  /**
   * Stylesheets and scripts a page must load, relative to `appHtml`, in order.
   *
   * Taken from `Index.html` where there is one, so custom controls come along; otherwise the
   * minimum that renders anything.
   */
  includes: string[];
}

/**
 * The web assets of a workspace, or `undefined` when it has none.
 *
 * `AppHtml` is spelled inconsistently even within DataFlex's own examples -- `AppHtml` in one
 * place, `AppHTML` in another. Windows paths are case-insensitive so one spelling finds either,
 * and the directory listing settles it anywhere that disagrees.
 */
export function findWebAssets(root: string): WebAssets | undefined {
  const appHtml = resolveCaseInsensitive(root, APP_HTML);
  if (appHtml === undefined || !existsSync(join(appHtml, ...ENGINE.split('/')))) {
    return undefined;
  }

  const themesDir = join(appHtml, 'CssThemes');
  const themes = existsSync(themesDir)
    ? readdirSync(themesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [];

  const indexPath = join(appHtml, 'Index.html');
  const managed = existsSync(indexPath) ? managedUrls(readFileSync(indexPath, 'utf8')) : [];
  const includes = (
    managed.length > 0
      ? managed
      : // No Index.html: enough to draw stock controls, so a source-only workspace still previews.
        // Custom controls are lost with it, since nothing else lists them.
        ['WebUI/system.css', ENGINE, ...themes.map((theme) => `CssThemes/${theme}/theme.css`)]
  ).filter((url) => existsSync(join(appHtml, ...url.split('/'))));

  return { appHtml, themes, includes: dedupe(includes) };
}

/**
 * Relative urls named by `<link href>` and `<script src>` inside the managed blocks.
 *
 * Only those two attributes, and only relative urls: the bootstrap that starts the real
 * application is an inline script that builds a `df.WebApp` against the web service, and an
 * absolute url is somebody else's server. A `?v=` cache-buster is dropped, since the file on disk
 * has no query string.
 */
export function managedUrls(indexHtml: string): string[] {
  const urls: string[] = [];
  for (const { open, close } of MANAGED_BLOCKS) {
    const marker = indexHtml.indexOf(open);
    if (marker < 0) {
      continue;
    }
    // Past the marker comment's own `-->`, or the block would end where it begins.
    const closesAt = indexHtml.indexOf('-->', marker + open.length);
    const from = closesAt < 0 ? marker + open.length : closesAt + 3;

    const to = indexHtml.indexOf(close, from);
    const block = indexHtml.slice(from, to < 0 ? indexHtml.length : to);
    for (const match of block.matchAll(/(?:href|src)\s*=\s*"([^"]+)"/gi)) {
      const url = match[1]!;
      if (!/^[a-z]+:|^\/\//i.test(url)) {
        urls.push(url.split('?')[0]!);
      }
    }
  }
  return urls;
}

function dedupe(urls: string[]): string[] {
  const seen = new Set<string>();
  return urls.filter((url) => {
    const key = url.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function resolveCaseInsensitive(parent: string, name: string): string | undefined {
  const direct = join(parent, name);
  if (existsSync(direct)) {
    return direct;
  }
  try {
    const match = readdirSync(parent).find((entry) => entry.toLowerCase() === name.toLowerCase());
    return match === undefined ? undefined : join(parent, match);
  } catch {
    return undefined;
  }
}
