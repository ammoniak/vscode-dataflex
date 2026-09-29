/**
 * Rendering a preview outside the webview.
 *
 * The extension draws a `.wo` in a VS Code webview; `scripts/preview-check.ts` and the MCP server
 * both need the same page in a headless browser instead. The code lived in the script until a
 * second caller appeared -- so it moved here, beside the model it renders, parameterised on where
 * the bootstrap and the browser are.
 *
 * The page loads the extension's *own* `media/preview/bootstrap.js`, with a stub standing in for
 * `acquireVsCodeApi`. So the sequence that starts the framework and the code that turns a click
 * into a source location are the shipped ones, not a copy that can drift. The one difference from
 * the webview is `file://` URLs instead of `asWebviewUri`, which is what makes this runnable from
 * a terminal.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WebAssets } from '@vscode-dataflex/workspace';
import type { PreviewModel } from './model';

/** The theme used unless the workspace lacks it. */
export const DEFAULT_THEME = 'Df_Flat_Desktop';

/** Where a headless Chromium usually lives on Windows. */
export const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
];

/** The first installed browser, or `undefined` when neither is present. */
export function findBrowser(candidates: readonly string[] = BROWSERS): string | undefined {
  return candidates.find((candidate) => existsSync(candidate));
}

export interface RenderOptions {
  /** Absolute path to the extension's `media/preview/bootstrap.js`. */
  bootstrapPath: string;
  /** Absolute path to chrome.exe or msedge.exe. */
  browserPath: string;
  /** Theme folder name; falls back to the workspace's first when absent. */
  theme?: string;
  /** When set, the browser also writes a PNG of the rendered view here. */
  screenshotPath?: string;
  /** Viewport for the screenshot. */
  windowSize?: { width: number; height: number };
}

export interface RenderResult {
  /** The page's own self-check block. */
  report: string;
  /** The generated page, left on disk for inspection. */
  page: string;
  /** Present when a screenshot was asked for and the browser wrote one. */
  screenshot?: string;
}

/**
 * What the view failed to do, named. Nothing is a pass.
 *
 * Drawing is the point, but the other two are what make the preview usable while the file is being
 * typed in: it has to survive being handed a new definition, and it must never take the focus --
 * a preview that focuses its first control moves the caret out of the editor every few keystrokes.
 */
export function failures(report: string): string[] {
  if (!report.includes('rendered: yes')) {
    return [report.split('\n')[0] ?? 'no report'];
  }
  const missing: string[] = [];
  if (!report.includes('rebuilt:  yes')) {
    missing.push('a new definition did not rebuild the page');
  }
  if (!report.includes('focus:    left alone')) {
    missing.push('the render took the focus');
  }
  if (!report.includes('refocus:  left alone')) {
    missing.push('the rebuild took the focus');
  }
  return missing;
}

/** Renders one model and returns the page's own report. */
export function renderOnce(
  model: PreviewModel,
  assets: WebAssets,
  options: RenderOptions
): RenderResult {
  const dir = mkdtempSync(join(tmpdir(), 'df-preview-'));
  const page = join(dir, 'preview.html');
  writeFileSync(page, renderPage(model, assets, options));

  const size = options.windowSize ?? { width: 1280, height: 900 };
  const dom = execFileSync(
    options.browserPath,
    [
      '--headless=new',
      '--disable-gpu',
      '--allow-file-access-from-files',
      '--virtual-time-budget=10000',
      ...(options.screenshotPath === undefined
        ? []
        : [
            `--screenshot=${options.screenshotPath}`,
            `--window-size=${size.width},${size.height}`
          ]),
      '--dump-dom',
      pathToFileURL(page).href
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );

  const report = between(dom, '<pre id="report">', '</pre>').trim();
  return {
    report,
    page,
    ...(options.screenshotPath !== undefined && existsSync(options.screenshotPath)
      ? { screenshot: options.screenshotPath }
      : {})
  };
}

/** Objects in the tree, the synthesised app included. */
export function countObjects(object: { aObjs: unknown[] }): number {
  return 1 + (object.aObjs as { aObjs: unknown[] }[]).reduce((sum, child) => sum + countObjects(child), 0);
}

export function between(text: string, open: string, close: string): string {
  const from = text.indexOf(open);
  if (from < 0) {
    return '';
  }
  const to = text.indexOf(close, from + open.length);
  return to < 0 ? '' : text.slice(from + open.length, to);
}

/**
 * The page the framework runs in.
 *
 * The extension's own `bootstrap.js` does the rendering, loaded from the repository with a stub
 * standing in for `acquireVsCodeApi` that records what would have been posted to the webview host.
 * So the sequence that starts the framework and the code that turns a click into a source
 * location are the shipped ones, not a copy that can drift. The one difference from the webview
 * is `file://` URLs instead of `asWebviewUri`, which is what keeps this runnable from a terminal.
 */
export function renderPage(
  model: PreviewModel,
  assets: WebAssets,
  options: Pick<RenderOptions, 'bootstrapPath' | 'theme'>
): string {
  // The workspace's own include list, exactly as the extension uses it -- which is what brings in
  // custom controls. Without it the DataFlex Reports viewer views fail with "could not find class
  // df.WebDRReportViewer", because that control's JavaScript is named only in Index.html.
  const head = assets.includes
    .map((relative) => {
      const href = pathToFileURL(join(assets.appHtml, ...relative.split('/'))).href;
      return relative.toLowerCase().endsWith('.css')
        ? `<link rel="stylesheet" href="${href}">`
        : `<script src="${href}"></script>`;
    })
    .join('\n');
  const wanted = options.theme ?? DEFAULT_THEME;
  const theme = assets.themes.includes(wanted) ? wanted : (assets.themes[0] ?? '');
  // The framework writes image urls relative to AppHtml, as `Index.html` would have them; the base
  // is what makes them resolve, here as in the extension.
  const base = `${pathToFileURL(assets.appHtml).href}/`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<base href="${base}">
<title>DataFlex preview check</title>
<script>var sDfPreloadTheme = ${JSON.stringify(theme)}; var bDfDebug = false;</script>
${head}
<style>html, body { height: 100%; margin: 0; } #viewport { width: 100%; height: 100%; }</style>
</head>
<body>
<div id="viewport"></div>
<pre id="report"></pre>
<script>
window.__dfPreview = ${JSON.stringify(model)};
// What the webview host would have received: reveal requests from clicks, and log lines.
const messages = [];
function acquireVsCodeApi() { return { postMessage: (message) => messages.push(message) }; }
</script>
<script src="${pathToFileURL(options.bootstrapPath).href}"></script>
<script>
const model = window.__dfPreview;
const viewport = document.getElementById("viewport");
const lines = [];
function publish() { document.getElementById("report").textContent = lines.join("\\n"); }

// The bootstrap renders inside the framework's ready and stylesheet callbacks, so the page is
// polled until something is drawn or the bootstrap has written its failure box. Iterations
// rather than the clock, because --virtual-time-budget is what advances time here.
let polls = 0;
(function waitForRender() {
  const failed = viewport.querySelector(".dfpreview-message");
  if (failed) { lines.push("ERROR: " + failed.textContent.trim()); return finish(); }
  if (viewport.innerHTML.length > 200) return inspect();
  if (++polls > 60) { lines.push("TIMEOUT: nothing finished rendering"); return finish(); }
  setTimeout(waitForRender, 100);
})();

function inspect() {
  const app = window.__dfPreviewApp;
  lines.push("rendered: yes");
  lines.push("elements: " + viewport.querySelectorAll("*").length);
  lines.push("controls: " + viewport.querySelectorAll("[class*=Web]").length);
  lines.push("text:     " + JSON.stringify(viewport.innerText.replace(/\\s+/g, " ").trim().slice(0, 300)));

  // Every object in the definition, looked up the way click-to-source does: by dotted long name
  // through findObj. A bare name finds only the view, and that showed up as "every click reveals
  // the top of the file" rather than as a failure here.
  const paths = Object.keys(model.ranges);
  const located = paths.filter((path) => app.findObj(path)).length;
  lines.push("located:  " + located + "/" + paths.length);

  // Click to source, through the bootstrap's own listener. Every tab button first, which is what
  // makes a card container render the pages it did not show at first; then every element the
  // framework tagged and every column header. What the bootstrap posted is compared with the
  // model's ranges, and anything it never reached is named.
  // Before anything is clicked: what the render alone did with the focus.
  lines.push("focus:    " + describeFocus());

  const logsBefore = messages.length;
  const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  // Re-queried after every click rather than iterated from one snapshot: a click can redraw what
  // it hit -- a header click sorts the grid and rebuilds every header cell -- and a click sent to
  // a detached element walks up to nothing. A user's click always lands on the live page.
  const clickEach = (selector, keyOf) => {
    const seen = new Set();
    for (;;) {
      const next = [...viewport.querySelectorAll(selector)].find((el) => !seen.has(keyOf(el)));
      if (!next) break;
      seen.add(keyOf(next));
      click(next);
    }
  };
  const inList = (el) => (el.closest("[data-dfobj]") || {}).getAttribute?.("data-dfobj") || "";
  clickEach(".WebTab_Btn", (el) => [...viewport.querySelectorAll(".WebTab_Btn")].indexOf(el));
  clickEach("[data-dfobj]", (el) => el.getAttribute("data-dfobj"));
  clickEach("th[data-dfcol]", (el) => inList(el) + "#" + el.getAttribute("data-dfcol"));
  const revealed = new Set(messages.filter((m) => m.type === "reveal").map((m) => m.path));
  const reached = paths.filter((path) => revealed.has(path));
  const missed = paths.filter((path) => !revealed.has(path));
  const unknown = [...revealed].filter((path) => !(path in model.ranges));
  lines.push("reveals:  " + reached.length + "/" + paths.length + " objects reachable by click");
  if (missed.length > 0) lines.push("          not reached: " + missed.slice(0, 8).join(", ") + (missed.length > 8 ? " ..." : ""));
  if (unknown.length > 0) lines.push("          revealed but not in the model: " + unknown.join(", "));
  messages.splice(logsBefore); // the clicks' own server-call complaints are not news

  // The refresh the extension sends when the file is edited: a new definition posted to the page,
  // which tears the app down and builds another one inside the same document. What this catches is
  // a teardown that leaves the old tree behind or a rebuild that draws nothing -- neither of which
  // the first render can show, and both of which look like a broken preview after one keystroke.
  const firstApp = window.__dfPreviewApp;
  // The clicks above focused what they hit, the way a user's clicks would. Cleared, so that what
  // the reading after the rebuild says is about the rebuild.
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  window.postMessage({ type: "model", model }, "*");

  setTimeout(function () {
    const after = viewport.querySelectorAll("[class*=Web]").length;
    lines.push("rebuilt:  " + (window.__dfPreviewApp !== firstApp ? "yes" : "no") + ", " + after + " controls");
    lines.push("refocus:  " + describeFocus());

    // Images arrive after the render, so they are counted a moment later -- a moment
    // --virtual-time-budget skips through. This is the one automated proof that a relative url
    // actually found its file.
    setTimeout(function () {
      const images = Array.from(viewport.querySelectorAll("img"));
      const loaded = images.filter((img) => img.complete && img.naturalWidth > 0).length;
      lines.push("images:   " + loaded + "/" + images.length);
      finish();
    }, 1500);
  }, 500);
}

/*
  What has the focus, if anything.

  The preview must leave it where it was: the framework's views focus their first control when
  shown and the browser focuses the first thing in a dialog it opens, and in a webview either one
  pulls the caret out of the editor -- on the first draw, and again on every redraw while typing.
*/
function describeFocus() {
  const focused = document.activeElement;
  if (focused === null || focused === document.body) return "left alone";
  return "TAKEN by " + focused.tagName + (focused.className ? "." + focused.className : "");
}

function finish() {
  for (const message of messages) {
    if (message.type === "log") lines.push("log:      " + message.detail);
  }
  publish();
}
</script>
</body>
</html>`;
}
