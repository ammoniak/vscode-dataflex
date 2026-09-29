/**
 * Renders a web view headlessly and reports what came out.
 *
 * The preview cannot be unit tested end to end: the thing being tested is whether the DataFlex web
 * framework, which is 600 KB of somebody else's JavaScript, accepts a definition this repository
 * built and draws it. That needs a browser. So this drives a real Chromium over the real framework
 * out of a real workspace, the same way `debug-host-check` drives the real debugger engine rather
 * than trusting that the adapter starts.
 *
 * It is the check that catches the failure that matters: a model that is structurally plausible,
 * passes every unit test, and renders nothing.
 *
 *   npm run preview-check                                   the Order Entry customer view
 *   npm run preview-check -- "<workspace>" "<file.wo>"      any other
 *   npm run preview-check -- ... --keep                     leave the generated page for a browser
 *   npm run preview-check -- "<workspace>" --all            every .wo in the workspace
 *
 * Requires Chrome or Edge, which is how the render is inspected. Nothing is written into the
 * workspace; the generated page goes to the system temp directory and references the framework in
 * place.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSource } from '@vscode-dataflex/parser';
import {
  cliForWorkspace,
  findWebAssets,
  IncludeResolver,
  loadWorkspace,
  readSourceFile,
  SymbolIndex
} from '@vscode-dataflex/workspace';
import type { WebAssets } from '@vscode-dataflex/workspace';
import { buildPreviewModel } from '../packages/df-langserver/src/preview/model';
import {
  DEFAULT_THEME,
  BROWSERS,
  countObjects,
  failures,
  findBrowser,
  renderOnce,
  renderPage
} from '../packages/df-langserver/src/preview/headless';

const DEFAULT_WORKSPACE = 'C:/DataFlex 26.0 Examples/WebOrder';
const DEFAULT_VIEW = 'AppSrc/Customer.wo';

/** The extension's own bootstrap, loaded as-is so that what runs here is what ships. */
const BOOTSTRAP = join(
  __dirname,
  '..',
  'packages',
  'vscode-dataflex',
  'media',
  'preview',
  'bootstrap.js'
);


const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const workspaceRoot = positional[0] ?? DEFAULT_WORKSPACE;
const viewPath = join(workspaceRoot, positional[1] ?? DEFAULT_VIEW);
const keep = process.argv.includes('--keep');
const sweep = process.argv.includes('--all');
const wantsShot = process.argv.includes('--screenshot');
const asJson = process.argv.includes('--json');

async function main(): Promise<number> {
  const browser = findBrowser(BROWSERS);
  if (browser === undefined) {
    console.error('No Chrome or Edge found; this check needs one to render.');
    return 1;
  }
  if (!sweep && !existsSync(viewPath)) {
    console.error(`No such file: ${viewPath}`);
    return 1;
  }

  // The framework, referenced where it lies. It is DataFlex's, and is never copied anywhere.
  // Found the same way the extension finds it, so a pass here means something about the real thing.
  const assets = findWebAssets(workspaceRoot);
  if (assets === undefined) {
    console.error(`No web framework under ${join(workspaceRoot, 'AppHtml')}. Is this a web workspace?`);
    return 1;
  }

  const sws = readdirSync(workspaceRoot).find((entry) => entry.toLowerCase().endsWith('.sws'));
  if (sws === undefined) {
    console.error(`No .sws in ${workspaceRoot}.`);
    return 1;
  }
  const { cliPath: cli, warning } = await cliForWorkspace(join(workspaceRoot, sws));
  if (cli === undefined) {
    console.error('df-cli.exe not found on this machine.');
    return 1;
  }
  if (warning !== undefined) {
    console.warn(warning);
  }
  const workspace = await loadWorkspace(cli, join(workspaceRoot, sws));
  if (workspace === undefined) {
    console.error('df-cli could not resolve the workspace.');
    return 1;
  }

  console.log(`workspace   ${workspace.root}`);
  const index = new SymbolIndex();
  await index.build(new IncludeResolver(workspace.searchPath));

  if (sweep) {
    return sweepAll(index, assets, browser);
  }

  const text = readSourceFile(viewPath);
  if (text === undefined) {
    console.error(`Could not read ${viewPath}`);
    return 1;
  }
  const model = buildPreviewModel(parseSource(text, { uri: viewPath }), index);

  console.log(`view        ${model.view ?? '(nothing renderable)'}`);
  console.log(`classes     ${model.definition.aClasses.map((c) => c.sType).join(', ')}`);
  console.log(`objects     ${countObjects(model.definition.obj) - 1}`);
  for (const problem of model.problems.slice(0, 10)) {
    console.log(`  note      line ${problem.range.start.line + 1}: ${problem.message}`);
  }
  if (model.problems.length > 10) {
    console.log(`  note      ... and ${model.problems.length - 10} more`);
  }
  if (model.view === undefined) {
    return 0;
  }

  const shotDir = wantsShot ? mkdtempSync(join(tmpdir(), 'df-preview-shot-')) : undefined;
  const rendered = renderOnce(model, assets, {
    bootstrapPath: BOOTSTRAP,
    browserPath: browser,
    theme: DEFAULT_THEME,
    ...(shotDir === undefined ? {} : { screenshotPath: join(shotDir, 'preview.png') })
  });
  const report = rendered.report;
  const broke = failures(report);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          workspace: workspaceRoot,
          view: model.view,
          classes: model.definition.aClasses.map((entry) => entry.sType),
          objects: countObjects(model.definition.obj) - 1,
          problems: model.problems.map((problem) => ({
            line: problem.range.start.line + 1,
            message: problem.message
          })),
          report,
          failures: broke,
          page: rendered.page,
          screenshot: rendered.screenshot
        },
        undefined,
        2
      )
    );
    return broke.length === 0 ? 0 : 1;
  }

  console.log('');
  console.log(report.length > 0 ? report : '(the page produced no report -- it did not run)');
  if (rendered.screenshot !== undefined) {
    console.log(`\nscreenshot  ${rendered.screenshot}`);
  }
  if (keep) {
    console.log(`\npage        ${rendered.page}`);
  }

  return broke.length === 0 ? 0 : 1;
}


/**
 * Renders every view in the workspace and reports one line each.
 *
 * One view rendering proves the mechanism; a workspace rendering proves the model builder is not
 * quietly overfitted to whichever file it was written against. A file with nothing renderable is
 * a pass -- the point is that it says so rather than drawing an empty box.
 */
async function sweepAll(
  index: SymbolIndex,
  assets: WebAssets,
  browser: string
): Promise<number> {
  const views = allViews(workspaceRoot);
  console.log(`views       ${views.length}\n`);

  let drew = 0;
  let nothing = 0;
  const broke: string[] = [];

  for (const file of views) {
    const text = readSourceFile(file);
    if (text === undefined) {
      continue;
    }
    const name = file.slice(workspaceRoot.length + 1);
    const model = buildPreviewModel(parseSource(text, { uri: file }), index);
    if (model.view === undefined) {
      nothing++;
      console.log(`  --  ${name}  (nothing renderable)`);
      continue;
    }

    const { report } = renderOnce(model, assets, {
      bootstrapPath: BOOTSTRAP,
      browserPath: browser,
      theme: DEFAULT_THEME
    });
    if (failures(report).length === 0) {
      drew++;
      const controls = /controls: (\d+)/.exec(report)?.[1] ?? '?';
      const reveals = /reveals:  (\d+\/\d+)/.exec(report)?.[1] ?? '?';
      console.log(`  ok  ${name}  ${controls} controls, ${reveals} reachable by click`);
    } else {
      broke.push(name);
      console.log(`  FAIL ${name}  ${failures(report).join('; ')}`);
    }
  }

  console.log(`\ndrew ${drew}, nothing renderable ${nothing}, failed ${broke.length}`);
  return broke.length === 0 ? 0 : 1;
}

/** Every `.wo` under the workspace, skipping the package cache and the generated web folder. */
function allViews(root: string): string[] {
  const skip = new Set(['apphtml', 'dfpkg', 'programs', 'data', 'bitmaps', '.git']);
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skip.has(entry.name.toLowerCase())) {
          walk(join(dir, entry.name));
        }
      } else if (entry.name.toLowerCase().endsWith('.wo')) {
        found.push(join(dir, entry.name));
      }
    }
  };
  walk(root);
  return found.sort();
}






main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
