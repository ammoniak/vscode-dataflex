/**
 * Checks the documentation links the hover would produce against the live site.
 *
 * The hover constructs `/VdfClassRef/{Web|Windows}/{Class}/` URLs without ever calling the network,
 * because the site publishes no index to drive them from -- its sitemap covers only the guides and
 * `/search/search_index.json` is served empty. A constructed URL that is wrong is a hard 404, so
 * the heuristic needs auditing from time to time rather than trusting.
 *
 * This is the audit: it takes a real workspace, asks the index for every library class the hover
 * would link, and resolves a sample of them.
 *
 * Usage: npx tsx scripts/docs-link-check.ts [workspace-dir] [--sample N] [--all]
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { IncludeResolver, SymbolIndex, cliForWorkspace, loadWorkspace } from '@vscode-dataflex/workspace';
import { STATEMENT_VERBS } from '@vscode-dataflex/parser';
import { docsEntryForCommand, docsUrlFor } from '../packages/df-langserver/src/providers/docsLink';
import { isWorkspaceOwnedFile } from '../packages/df-langserver/src/analysis/workspaceFiles';

const DEFAULT_ROOT = 'C:/DataFlex 26.0 Examples/WebOrder';

function flagValue(name: string, fallback: number): number {
  const at = process.argv.indexOf(name);
  const value = at === -1 ? NaN : Number.parseInt(process.argv[at + 1] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** HEAD would be cheaper, but MkDocs Material serves pages statically and answers GET reliably. */
async function status(url: string): Promise<number> {
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'follow' });
    return response.status;
  } catch {
    return 0;
  }
}

/** Which link shape a URL is, for the per-category tally. */
function category(url: string): string {
  if (url.includes('/LanguageReference/')) {
    return 'command';
  }
  // A couple of keywords are documented in the guides instead -- `File_Field`, `Self`.
  if (url.includes('/DevelopmentGuide/') || url.includes('/LanguageGuide/')) {
    return 'keyword';
  }
  return /-(Procedure|Function|Property|Event)-/.test(url) ? 'member' : 'class';
}

async function main(): Promise<void> {
  // `--sample N` takes a value, so the positional workspace path is whatever is left over.
  const argv = process.argv.slice(2);
  const sampleAt = argv.indexOf('--sample');
  const positional = argv.filter(
    (arg, index) => !arg.startsWith('--') && index !== sampleAt + 1
  );
  const root = positional[0] ?? DEFAULT_ROOT;
  const sampleSize = flagValue('--sample', 40);
  const all = process.argv.includes('--all');

  // The .sws first: it is what names the DataFlex version whose library this must resolve against.
  const sws = readdirSync(root).find((entry) => entry.toLowerCase().endsWith('.sws'));
  if (sws === undefined) {
    console.error(`No .sws in ${root}`);
    process.exit(1);
  }

  const { cliPath: cli, warning } = await cliForWorkspace(join(root, sws));
  if (cli === undefined) {
    console.error('df-cli.exe not found.');
    process.exit(1);
  }
  if (warning !== undefined) {
    console.warn(warning);
  }

  const workspace = await loadWorkspace(cli, join(root, sws));
  if (workspace === undefined) {
    console.error(`df-cli could not open ${sws}`);
    process.exit(1);
  }

  const resolver = new IncludeResolver(workspace.searchPath);
  const index = new SymbolIndex();
  await index.build(resolver);

  // Every page the hover would actually link, deduplicated by URL. Classes, the members the
  // workspace declares, and the command words the parser knows -- the three shapes the hover
  // builds, so a regression in any of them shows up here rather than as a 404 for the reader.
  const links = new Map<string, string>();
  for (const declaration of index.allDeclarations()) {
    const url = docsUrlFor({
      kind: declaration.kind,
      name: declaration.name,
      file: declaration.file,
      workspaceOwned: isWorkspaceOwnedFile(declaration.file, workspace.root),
      ownerClass: declaration.ownerClass
    });
    if (url !== undefined) {
      links.set(url, declaration.name);
    }
  }
  for (const verb of STATEMENT_VERBS) {
    const url = docsEntryForCommand(verb)?.url;
    if (url !== undefined) {
      links.set(url, verb);
    }
  }

  const urls = [...links.keys()].sort();
  // Evenly spaced rather than the first N, so the sample spans both platform sections.
  const step = all ? 1 : Math.max(1, Math.floor(urls.length / sampleSize));
  const sample = urls.filter((_, position) => position % step === 0).slice(0, all ? urls.length : sampleSize);

  console.log(`workspace     : ${root}`);
  console.log(`linkable      : ${urls.length} page(s)`);
  console.log(`checking      : ${sample.length}\n`);

  const bad: { url: string; status: number }[] = [];
  /** Checked and dead per category, which is what says which of the three shapes is wrong. */
  const byPlatform = new Map<string, { checked: number; dead: number }>();

  for (const url of sample) {
    const tally = byPlatform.get(category(url)) ?? { checked: 0, dead: 0 };
    tally.checked++;

    const code = await status(url);
    if (code !== 200) {
      tally.dead++;
      bad.push({ url, status: code });
      console.log(`  ${String(code).padStart(3)}  ${url}`);
    }
    byPlatform.set(category(url), tally);
  }

  const rate = sample.length === 0 ? 0 : (bad.length / sample.length) * 100;
  console.log(`\ndead links    : ${bad.length} / ${sample.length}  (${rate.toFixed(1)}%)`);
  for (const [platform, tally] of [...byPlatform].sort()) {
    const share = tally.checked === 0 ? 0 : (tally.dead / tally.checked) * 100;
    console.log(
      `  ${platform.padEnd(8)} ${tally.dead} dead of ${tally.checked}  (${share.toFixed(1)}%)`
    );
  }

  if (bad.length > 0) {
    console.log(
      '\nA dead link means `docsPlatform` in packages/df-langserver/src/providers/docsLink.ts\n' +
        'is placing these classes in the wrong section, or the documentation moved them.'
    );
    process.exitCode = 1;
  }
}

void main();
