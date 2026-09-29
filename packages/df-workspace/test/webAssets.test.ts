import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findWebAssets, managedUrls } from '../src/webAssets';

/**
 * Finding the web framework a workspace runs on.
 *
 * The list of scripts and stylesheets is not cosmetic: it is what decides whether a custom control
 * draws or appears as a blank box, because `Index.html`'s managed block is the only place the
 * JavaScript half of a custom control is named.
 */

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A workspace on disk, described as a map of relative path to contents. */
function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'df-assets-'));
  roots.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const path = join(root, ...relative.split('/'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

const INDEX = `<!DOCTYPE HTML>
<html><head>
  <link href="CssStyle/application.css" rel="stylesheet" type="text/css" />
  <!-- Managed Includes (do not remove this line, used for automatic insertion) -->
  <link rel="stylesheet" href="WebUI/system.css?v=1.0.52">
  <script src="WebUI/df-min.js?v=1.0.52"></script>
  <link rel="stylesheet" href="CssThemes/Df_Material/theme.css?v=1.0.3">
  <script src="https://cdn.example.com/analytics.js"></script>
  <!-- End of Managed Includes (do not remove this line, used for automatic insertion) -->
  <!-- DataFlex Custom Controls (do not remove this line, used for automatic insertion) -->
  <script src="Custom/AmCharts5.js?v=20260722"></script>
  -->
  <script>
    var oWebApp = new df.WebApp("WebServiceDispatcher.wso");
    oWebApp.displayApp("#viewport");
  </script>
</head><body></body></html>`;

const FULL = {
  'AppHtml/Index.html': INDEX,
  'AppHtml/WebUI/df-min.js': '// engine',
  'AppHtml/WebUI/system.css': '/* system */',
  'AppHtml/CssThemes/Df_Material/theme.css': '/* material */',
  'AppHtml/CssThemes/Df_Web_Creme/theme.css': '/* creme */',
  'AppHtml/CssStyle/application.css': '/* app */',
  'AppHtml/Custom/AmCharts5.js': '// a custom control'
};

describe('findWebAssets', () => {
  it('finds the framework, the themes and the includes', () => {
    const assets = findWebAssets(workspace(FULL));
    expect(assets).toBeDefined();
    expect(assets?.themes.sort()).toEqual(['Df_Material', 'Df_Web_Creme']);
    expect(assets?.includes).toContain('WebUI/df-min.js');
  });

  it('carries custom controls through, which is the whole point of reading Index.html', () => {
    const assets = findWebAssets(workspace(FULL));
    expect(assets?.includes).toContain('Custom/AmCharts5.js');
  });

  it('leaves out anything hosted somewhere else', () => {
    const assets = findWebAssets(workspace(FULL));
    // An absolute url is somebody else's server, and a preview must not reach for one.
    expect(assets?.includes.join(' ')).not.toContain('cdn.example.com');
  });

  it('leaves out what Index.html names but the workspace does not have', () => {
    const { 'AppHtml/Custom/AmCharts5.js': _removed, ...withoutControl } = FULL;
    const assets = findWebAssets(workspace(withoutControl));
    // A <script src> for a file that is not there would 404 in the panel, so it is dropped here.
    expect(assets?.includes).not.toContain('Custom/AmCharts5.js');
    expect(assets?.includes).toContain('WebUI/df-min.js');
  });

  it('drops the cache-busting query, since the file on disk has none', () => {
    const assets = findWebAssets(workspace(FULL));
    expect(assets?.includes.some((url) => url.includes('?'))).toBe(false);
  });

  it('finds AppHtml however it is spelled', () => {
    const root = workspace({
      'APPHTML/WebUI/df-min.js': '// engine',
      'APPHTML/WebUI/system.css': '/* system */'
    });
    expect(findWebAssets(root)).toBeDefined();
  });

  it('falls back to the minimum when there is no Index.html', () => {
    const root = workspace({
      'AppHtml/WebUI/df-min.js': '// engine',
      'AppHtml/WebUI/system.css': '/* system */',
      'AppHtml/CssThemes/Df_Web_Creme/theme.css': '/* creme */'
    });
    const assets = findWebAssets(root);
    expect(assets?.includes).toEqual([
      'WebUI/system.css',
      'WebUI/df-min.js',
      'CssThemes/Df_Web_Creme/theme.css'
    ]);
  });

  it('answers undefined for a workspace with no web application in it', () => {
    expect(findWebAssets(workspace({ 'AppSrc/Order.src': 'Use Windows.pkg' }))).toBeUndefined();
  });

  it('answers undefined for a path that is not there at all', () => {
    expect(findWebAssets(join(tmpdir(), 'no-such-workspace-9d3f'))).toBeUndefined();
  });
});

describe('managedUrls', () => {
  it('reads both managed blocks and nothing outside them', () => {
    const urls = managedUrls(INDEX);
    expect(urls).toContain('WebUI/df-min.js');
    expect(urls).toContain('Custom/AmCharts5.js');
    // Outside the markers, so not part of what df-cli maintains.
    expect(urls).not.toContain('CssStyle/application.css');
  });

  it('ignores the bootstrap that starts the real application', () => {
    // It is an inline script building a df.WebApp against the web service; the preview builds its
    // own. Only href and src are read, so it cannot be picked up by accident.
    expect(managedUrls(INDEX).join(' ')).not.toContain('WebServiceDispatcher');
  });

  it('returns nothing for a page with no markers', () => {
    expect(managedUrls('<html><head><script src="a.js"></script></head></html>')).toEqual([]);
  });
});
