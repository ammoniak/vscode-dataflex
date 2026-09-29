import { join } from 'node:path';
import * as vscode from 'vscode';
import { APP_HTML, findWebAssets } from '@vscode-dataflex/workspace';
import type { WebAssets } from '@vscode-dataflex/workspace';
import type { PreviewModelResponse } from '@vscode-dataflex/langserver/protocol';
// The mode table itself, not the preview barrel: that one also re-exports the headless renderer,
// and the extension has no business bundling a browser launcher to fill a dropdown.
import {
  MODE_CHOICES,
  isModeName,
  modeValue,
  viewportFor
} from '@vscode-dataflex/langserver/preview/modes';
import type { ModeName } from '@vscode-dataflex/langserver/preview/modes';
import type { DataFlexClient } from './client';

/**
 * A live preview of a web view, drawn by the DataFlex web framework itself.
 *
 * Not a drawing of what a view might look like: the actual `df.WebForm`, `df.WebTabContainer` and
 * `df.WebList` objects, in the workspace's own theme, laid out by the same code that lays them out
 * in the running application. The language server turns the source into the object definition the
 * framework builds from (see `df-langserver/src/preview/`), and this hosts it.
 *
 * A webview, unlike anywhere else in this extension. `profileCommand.ts` argues against one and is
 * right for a profile, where the useful action on a row is to go and read the method and a quick
 * pick is the shortest path to it. That reasoning does not transfer: the useful action on a layout
 * is to look at it, and there is no text rendering of "this form sits in columns four through nine
 * with a right-aligned label" that beats seeing it.
 *
 * See docs/PREVIEW.md.
 */

const DEFAULT_THEME = 'Df_Flat_Desktop';

/**
 * How long typing stops before the preview redraws.
 *
 * Long enough that a burst of keystrokes is one redraw, short enough that pausing to look at the
 * preview shows the current file. The redraw itself is cheap -- the page stays, only the object
 * tree is rebuilt -- so this is about not asking the server for a model on every character.
 */
const REFRESH_DELAY_MS = 400;

/**
 * Which of a rendered view's pictures loaded, as the page reported it.
 *
 * `src` is what the framework wrote into the element and `url` what the browser made of it
 * against the page's `<base>`; when a picture fails, the pair says whether the source, the base
 * or the resource policy is at fault.
 */
export interface PreviewImageReport {
  /** The document previewed. */
  uri: string;
  total: number;
  loaded: number;
  failed: { src: string; url: string }[];
}

/**
 * What a panel currently has on screen, so that an edit which changes nothing does not touch it.
 *
 * `shell` is what the page itself is built from -- the framework include list, the theme, the base
 * -- and `model`, where there is one, the definition drawn into it. Same shell and same model is
 * nothing to do; same shell and a new model is a message to the page; anything else is a new page.
 * `ready` is whether the page has said it is listening: a message posted to a webview whose script
 * has not run yet is dropped rather than queued.
 *
 * `page` is the definition written into the html, which is what a webview that reloads -- dragged
 * to another editor group, or restored after the extension host restarts -- comes back showing.
 * When it is not `model`, the updates posted since have been lost and are sent again.
 */
interface Showing {
  shell: string;
  model?: string;
  page?: string;
  ready: boolean;
}

/**
 * Modes offered in the picker, base layout first.
 *
 * `undefined` is not "no choice made" but a layout in its own right: the definition with no
 * `WebSetResponsive` rule applied, which is what the framework draws before its own mode
 * controller reports in. It is the default because it is what the preview has always shown.
 */
const MODE_OPTIONS: { value: string; name: ModeName | undefined; label: string }[] = [
  { value: '', name: undefined, label: 'Base (no responsive rules)' },
  ...MODE_CHOICES.map((choice) => ({ value: choice.name, name: choice.name, label: choice.label }))
];

export class PreviewPanels implements vscode.Disposable {
  /** One panel per file, keyed by the document uri, so re-running the command reuses it. */
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly showing = new Map<string, Showing>();
  /** Documents whose panel was hidden when their refresh came due. */
  private readonly deferred = new Map<string, vscode.TextDocument>();
  /**
   * The responsive mode each panel is showing, where it is not the base layout.
   *
   * Per panel rather than global: comparing a view's desktop and phone layouts side by side is the
   * reason to have this at all, and a single setting would make the two panels fight.
   */
  private readonly modes = new Map<string, ModeName>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly imageReports = new vscode.EventEmitter<PreviewImageReport>();

  /**
   * Fires when a preview has tried all its pictures. What the integration suite listens to: a
   * webview's document cannot be inspected from the extension host, so the page's own report is
   * the only evidence that the `<base>` and the resource roots let a relative url through.
   */
  readonly onDidReportImages = this.imageReports.event;

  constructor(
    private readonly client: DataFlexClient,
    private readonly extensionUri: vscode.Uri,
    private readonly output: vscode.OutputChannel
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        const key = event.document.uri.toString();
        if (this.panels.has(key) && event.contentChanges.length > 0) {
          this.scheduleRefresh(event.document);
        }
      })
    );
  }

  /** Opens the preview for a document, or brings its existing panel forward. */
  async show(document: vscode.TextDocument): Promise<void> {
    const key = document.uri.toString();
    const existing = this.panels.get(key);
    if (existing !== undefined) {
      existing.reveal(vscode.ViewColumn.Beside, true);
      await this.render(document, existing);
      return;
    }

    const root = this.client.getStatus().root;
    const panel = vscode.window.createWebviewPanel(
      'dataflex.preview',
      `Preview ${basename(document.uri)}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        // Kept alive because rebuilding the framework's object tree on every tab switch is both
        // slow and pointless -- the preview has no state worth throwing away.
        retainContextWhenHidden: true,
        // The framework is DataFlex's and lives in the workspace, so the webview has to be allowed
        // to reach outside the extension. Nothing is copied; every asset is referenced in place.
        localResourceRoots: [
          this.extensionUri,
          ...(root === undefined ? [] : [vscode.Uri.file(root)])
        ]
      }
    );

    this.panels.set(key, panel);
    panel.onDidDispose(() => {
      this.panels.delete(key);
      this.showing.delete(key);
      this.deferred.delete(key);
      this.modes.delete(key);
      const timer = this.timers.get(key);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.timers.delete(key);
      }
    });
    // A hidden panel is not re-rendered, so it catches up here. `retainContextWhenHidden` keeps
    // what it was showing, which is why the catch-up can wait for it to be looked at again.
    panel.onDidChangeViewState(() => {
      const waiting = this.deferred.get(key);
      if (panel.visible && waiting !== undefined) {
        this.deferred.delete(key);
        void this.render(waiting, panel);
      }
    });
    panel.webview.onDidReceiveMessage((message: unknown) => this.onMessage(document, message));

    await this.render(document, panel);
  }

  /** Re-renders after an edit, coalescing bursts. */
  private scheduleRefresh(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const existing = this.timers.get(key);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        const panel = this.panels.get(key);
        if (panel === undefined) {
          return;
        }
        if (!panel.visible) {
          this.deferred.set(key, document);
          return;
        }
        void this.render(document, panel);
      }, REFRESH_DELAY_MS)
    );
  }

  private async render(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const key = document.uri.toString();
    this.deferred.delete(key);
    const root = this.client.getStatus().root;
    if (root === undefined) {
      this.publish(key, panel, 'no-workspace', () =>
        this.message(
          panel.webview,
          'No DataFlex workspace',
          'The preview needs a resolved workspace to find the web framework. See the DataFlex output channel.'
        )
      );
      return;
    }

    const assets = findWebAssets(root);
    if (assets === undefined) {
      this.publish(key, panel, 'no-framework', () =>
        this.message(
          panel.webview,
          'The DataFlex web framework was not found',
          `The preview draws with the framework the project itself uses, which the Web UI package ` +
            `puts in <code>${escapeHtml(join(root, APP_HTML, 'WebUI', 'df-min.js'))}</code>. ` +
            `It is not there. Build the workspace, or open a workspace that has a web application in it.`
        )
      );
      return;
    }

    const mode = this.modes.get(key);
    const wanted = modeValue(mode);
    const model = await this.client.previewModel({
      uri: document.uri.toString(),
      ...(wanted === undefined ? {} : { mode: wanted })
    });
    if (model === undefined) {
      this.publish(key, panel, 'no-index', () =>
        this.message(
          panel.webview,
          'Waiting for the index',
          'The preview needs the workspace index to know which class draws as which control. It will refresh when the index is ready.'
        )
      );
      return;
    }
    if (model.view === undefined) {
      this.publish(key, panel, `nothing-to-draw:${JSON.stringify(model.problems)}`, () =>
        this.message(
          panel.webview,
          `${basename(document.uri)} has nothing to draw`,
          model.problems.length > 0
            ? `<ul>${model.problems.map((p) => `<li>${escapeHtml(p.message)}</li>`).join('')}</ul>`
            : 'It declares no web view and no web control.'
        )
      );
      return;
    }

    // The page is what the framework runs in; the model is what it draws. They change on their
    // own schedules -- the shell only when the workspace's framework or the theme does -- and the
    // difference is the whole point: a new model goes to the page that is already up.
    const theme = chooseTheme(assets);
    const shell = JSON.stringify([assets.appHtml, assets.includes, theme]);
    // The mode goes in with the definition rather than with the shell, so switching layouts posts
    // a message instead of rewriting the page -- the whole point of the split. It has to be in
    // *something*, because a view with no `WebSetResponsive` rule at all builds the same
    // definition for every mode, and only the width the drawing is given would change.
    const definition = JSON.stringify([mode ?? '', model]);
    const showing = this.showing.get(key);
    if (showing?.shell === shell && showing.model === definition) {
      return;
    }
    if (showing?.shell === shell && showing.model !== undefined && showing.ready) {
      this.showing.set(key, { shell, model: definition, page: showing.page, ready: true });
      void panel.webview.postMessage({ type: 'model', model, width: viewportWidth(mode) });
      return;
    }

    this.showing.set(key, { shell, model: definition, page: definition, ready: false });
    panel.webview.html = this.page(panel.webview, assets, model, theme, mode);
  }

  /**
   * Writes a page, unless the same one is already up.
   *
   * Every state that is not a drawing goes through here, so that an edit which leaves the preview
   * saying "waiting for the index" does not reload that page -- and, on the way, does not throw
   * away a page the user had scrolled or a details block they had opened.
   */
  private publish(
    key: string,
    panel: vscode.WebviewPanel,
    shell: string,
    build: () => string
  ): void {
    if (this.showing.get(key)?.shell === shell) {
      return;
    }
    this.showing.set(key, { shell, ready: false });
    panel.webview.html = build();
  }

  /** Click in the preview, reveal in the editor; anything else the page says goes to the log. */
  private onMessage(document: vscode.TextDocument, message: unknown): void {
    const data = message as {
      type?: string;
      path?: string;
      detail?: string;
      mode?: unknown;
      total?: number;
      loaded?: number;
      failed?: { src: string; url: string }[];
    };
    if (data.type === 'mode') {
      const key = document.uri.toString();
      const panel = this.panels.get(key);
      if (panel === undefined) {
        return;
      }
      // The empty string is the base layout, which is a choice like any other rather than a
      // failure to choose; anything else the page could send is not a mode and is ignored.
      if (data.mode === '' || data.mode === undefined) {
        this.modes.delete(key);
      } else if (isModeName(data.mode)) {
        this.modes.set(key, data.mode);
      } else {
        return;
      }
      void this.render(document, panel);
      return;
    }
    if (data.type === 'ready') {
      const key = document.uri.toString();
      const showing = this.showing.get(key);
      if (showing === undefined) {
        return;
      }
      showing.ready = true;
      const panel = this.panels.get(key);
      if (showing.model !== showing.page && panel !== undefined) {
        // A reloaded page: it is drawing what its html carries, so the updates posted since it was
        // written are gone. Saying so is enough -- the render sends the current definition.
        showing.model = showing.page;
        void this.render(document, panel);
      }
      return;
    }
    if (data.type === 'reveal' && typeof data.path === 'string') {
      void this.reveal(document, data.path);
      return;
    }
    if (data.type === 'log' && typeof data.detail === 'string') {
      this.output.appendLine(`[preview] ${data.detail}`);
      return;
    }
    if (data.type === 'images' && typeof data.total === 'number') {
      const report: PreviewImageReport = {
        uri: document.uri.toString(),
        total: data.total,
        loaded: data.loaded ?? 0,
        failed: data.failed ?? []
      };
      if (report.total > 0) {
        this.output.appendLine(
          `[preview] images: ${report.loaded}/${report.total} loaded in ${basename(document.uri)}`
        );
        for (const image of report.failed) {
          this.output.appendLine(`[preview]   not loaded: ${image.src} -> ${image.url}`);
        }
      }
      this.imageReports.fire(report);
    }
  }

  /**
   * `path` is the object's dotted long name, which is what `PreviewModel.ranges` is keyed by.
   *
   * The object is not necessarily in the previewed file. A class's subobjects are drawn in every
   * instance of it, the way `Construct_Object` creates them, so clicking the icon inside a widget
   * belongs in the widget's own `.wo` -- which is what the entry's `file` names.
   */
  private async reveal(document: vscode.TextDocument, path: string): Promise<void> {
    const wanted = modeValue(this.modes.get(document.uri.toString()));
    const model = await this.client.previewModel({
      uri: document.uri.toString(),
      ...(wanted === undefined ? {} : { mode: wanted })
    });
    const entry = model?.ranges[path];
    if (entry === undefined) {
      return;
    }
    const range = entry.range;
    const target =
      entry.file === undefined
        ? document
        : await vscode.workspace.openTextDocument(vscode.Uri.file(entry.file));
    const editor = await vscode.window.showTextDocument(target, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false
    });
    const at = new vscode.Range(
      range.start.line,
      range.start.character,
      range.start.line,
      range.start.character
    );
    editor.selection = new vscode.Selection(at.start, at.start);
    editor.revealRange(at, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /**
   * The page the framework runs in.
   *
   * The `<head>` is the workspace's own `Index.html` where there is one, with its relative URLs
   * rewritten. That is not a shortcut: that block is what `df-cli` maintains, and it names the
   * framework version the project actually uses, every theme it ships, and -- between the custom
   * controls markers -- the JavaScript for each custom control the application defines. Building
   * the list here instead would preview custom controls as blank boxes.
   */
  private page(
    webview: vscode.Webview,
    assets: WebAssets,
    model: NonNullable<PreviewModelResponse>,
    theme: string,
    mode: ModeName | undefined
  ): string {
    const nonce = makeNonce();

    // The framework writes relative urls into the page as it finds them -- `df.WebImage` assigns
    // `psUrl` straight to `img.src` -- and in the real application those are relative to
    // `AppHtml`, where `Index.html` lives. The webview's document lives nowhere near it, so the
    // base is set to `AppHtml`. Which is exactly what the Studio's own preview shell,
    // `Lib\WebAppDesigner.html`, does with its `<base id="previewer_base">`. Everything this file
    // emits itself is already an absolute webview uri and is unaffected.
    const base = `${webview.asWebviewUri(vscode.Uri.file(assets.appHtml)).toString()}/`;

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<base href="${base}">
${this.csp(webview, nonce)}
<script nonce="${nonce}">var sDfPreloadTheme = ${JSON.stringify(theme)}; var bDfDebug = false;</script>
${headIncludes(webview, assets)}
<style nonce="${nonce}">${PAGE_STYLE}</style>
</head>
<body>
<div id="dfpreview-banner">
  <span>
    Static preview &mdash; no server, so lists and grids are empty and nothing is clickable.
    Click a control to jump to its source.
  </span>
  <label id="dfpreview-mode">Layout
    <select>${modeOptionsHtml(mode)}</select>
  </label>
</div>
${problemsHtml(model.problems)}
<div id="viewport"${viewportStyle(mode)}></div>
<script nonce="${nonce}">window.__dfPreview = ${JSON.stringify(model)};</script>
<script nonce="${nonce}" src="${webview
      .asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'preview', 'bootstrap.js'))
      .toString()}"></script>
</body>
</html>`;
  }

  /** A styled message in place of a render, for every state that is not a drawing. */
  private message(webview: vscode.Webview, title: string, body: string): string {
    const nonce = makeNonce();
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
${this.csp(webview, nonce)}
<style nonce="${nonce}">${PAGE_STYLE}</style>
</head>
<body><div class="dfpreview-message"><h2>${escapeHtml(title)}</h2><p>${body}</p></div></body>
</html>`;
  }

  /**
   * The content security policy.
   *
   * `'unsafe-inline'` for styles is unavoidable and deliberate: the framework builds its DOM with
   * `df.dom.create('<div style="...">')` throughout, and a style attribute counts as inline style.
   * Scripts get no such licence -- ours run under a nonce and the framework's from the workspace.
   */
  private csp(webview: vscode.Webview, nonce: string): string {
    const source = webview.cspSource;
    return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${source} data:; font-src ${source}; style-src ${source} 'unsafe-inline'; script-src ${source} 'nonce-${nonce}';">`;
  }

  dispose(): void {
    this.imageReports.dispose();
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

/**
 * The theme to preload.
 *
 * The setting wins; otherwise the framework's usual desktop theme when the workspace ships it, and
 * whatever it does ship when it does not. A theme that is not there renders an unstyled page, which
 * looks like a broken preview rather than a missing folder.
 */
function chooseTheme(assets: WebAssets): string {
  const configured = vscode.workspace.getConfiguration('dataflex').get<string>('preview.theme');
  if (configured !== undefined && configured.length > 0 && assets.themes.includes(configured)) {
    return configured;
  }
  return assets.themes.includes(DEFAULT_THEME) ? DEFAULT_THEME : (assets.themes[0] ?? DEFAULT_THEME);
}

/** The workspace's own stylesheet and script list, pointed at the webview. */
function headIncludes(webview: vscode.Webview, assets: WebAssets): string {
  return assets.includes
    .map((relative) => {
      const uri = webview
        .asWebviewUri(vscode.Uri.file(join(assets.appHtml, ...relative.split('/'))))
        .toString();
      return relative.toLowerCase().endsWith('.css')
        ? `<link rel="stylesheet" href="${uri}">`
        : `<script src="${uri}"></script>`;
    })
    .join('\n');
}

/**
 * The width to draw into, or `undefined` for whatever the panel is.
 *
 * The responsive *values* are already in the definition by the time the page loads -- the rules
 * were replayed when the model was built -- so this does not decide the layout. What it decides is
 * whether the layout is shown at a width it would ever be seen at: a phone's column spans drawn
 * across a 1600-pixel panel are the right numbers arranged into a picture of nothing.
 */
function viewportWidth(mode: ModeName | undefined): number | undefined {
  return mode === undefined ? undefined : viewportFor(mode).width;
}

/** The `style` attribute for the drawing area, empty for the base layout. */
function viewportStyle(mode: ModeName | undefined): string {
  const width = viewportWidth(mode);
  return width === undefined ? '' : ` style="max-width:${width}px"`;
}

/** The picker's options, with the panel's current mode selected. */
function modeOptionsHtml(mode: ModeName | undefined): string {
  return MODE_OPTIONS.map((option) => {
    const selected = option.name === mode ? ' selected' : '';
    return `<option value="${escapeHtml(option.value)}"${selected}>${escapeHtml(option.label)}</option>`;
  }).join('');
}

/** What the model could not do, listed rather than left to be discovered by squinting. */
function problemsHtml(problems: { message: string; range: { start: { line: number } } }[]): string {
  if (problems.length === 0) {
    return '';
  }
  const items = problems
    .map((p) => `<li><span>line ${p.range.start.line + 1}</span> ${escapeHtml(p.message)}</li>`)
    .join('');
  return `<details id="dfpreview-problems"><summary>${problems.length} thing${
    problems.length === 1 ? '' : 's'
  } could not be drawn</summary><ul>${items}</ul></details>`;
}

const PAGE_STYLE = `
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; }
  #viewport { flex: 1 1 auto; min-height: 0; }
  /* Centred, and bordered, so a phone-width drawing reads as a narrow view rather than as one
     that failed to fill the panel. Both are inert at the base layout, where there is no width. */
  #viewport[style] {
    margin: 0 auto; width: 100%;
    border-left: 1px solid var(--vscode-editorWidget-border, #ddd);
    border-right: 1px solid var(--vscode-editorWidget-border, #ddd);
  }
  #dfpreview-banner {
    flex: 0 0 auto; padding: 4px 10px; font: 11px var(--vscode-font-family, sans-serif);
    color: var(--vscode-descriptionForeground, #666);
    background: var(--vscode-editorWidget-background, #f3f3f3);
    border-bottom: 1px solid var(--vscode-editorWidget-border, #ddd);
    display: flex; align-items: center; gap: 10px;
  }
  #dfpreview-banner > span { flex: 1 1 auto; }
  #dfpreview-mode { flex: 0 0 auto; display: flex; align-items: center; gap: 4px; white-space: nowrap; }
  #dfpreview-mode select {
    font: inherit; color: var(--vscode-dropdown-foreground, inherit);
    background: var(--vscode-dropdown-background, #fff);
    border: 1px solid var(--vscode-dropdown-border, #ccc);
    border-radius: 2px; padding: 1px 4px;
  }
  #dfpreview-problems {
    flex: 0 0 auto; padding: 4px 10px; font: 11px var(--vscode-font-family, sans-serif);
    color: var(--vscode-descriptionForeground, #666);
    background: var(--vscode-editorWidget-background, #f3f3f3);
    border-bottom: 1px solid var(--vscode-editorWidget-border, #ddd);
  }
  #dfpreview-problems ul { margin: 4px 0 0; padding-left: 18px; }
  #dfpreview-problems span { opacity: 0.7; margin-right: 4px; }
  .dfpreview-message {
    padding: 24px; font: 13px var(--vscode-font-family, sans-serif);
    color: var(--vscode-foreground, #333);
  }
  .dfpreview-message h2 { font-size: 15px; font-weight: 600; margin: 0 0 8px; }
  .dfpreview-message code { font-family: var(--vscode-editor-font-family, monospace); }
`;

function basename(uri: vscode.Uri): string {
  return uri.path.slice(uri.path.lastIndexOf('/') + 1);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function makeNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return nonce;
}
