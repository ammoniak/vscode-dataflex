/**
 * Renders the hover for real symbols in a real workspace.
 *
 * The hover assembles up to eight optional facts, and the only way to judge whether the result is
 * informative or just tall is to look at it against actual code rather than a fixture. This prints
 * the markdown the editor would show, with a line count for each.
 *
 * Usage: npx tsx scripts/hover-preview.ts [workspace-dir] [name ...]
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  IncludeResolver,
  SymbolIndex,
  TableIndex,
  cliForWorkspace,
  loadWorkspace
} from '@vscode-dataflex/workspace';
import { declarationHover } from '../packages/df-langserver/src/providers/hoverContent';
import { factsFor } from '../packages/df-langserver/src/providers/navigation';

const DEFAULT_ROOT = 'C:/DataFlex 26.0 Examples/WebOrder';
const DEFAULT_NAMES = [
  'cWebForm',
  'psCaption',
  'ButtonCallback',
  'Refresh',
  'ghoMailInterface',
  'ghoApplication',
  'cAboDataDictionary',
  'C_WebDefault',
  'alignRight'
];

/** The same assembly the provider does, kept in step by hand for this preview only. */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const root = argv[0] ?? DEFAULT_ROOT;
  const names = argv.length > 1 ? argv.slice(1) : DEFAULT_NAMES;

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
    console.error('Workspace failed to load.');
    process.exit(1);
  }

  const resolver = new IncludeResolver(workspace.searchPath);
  const index = new SymbolIndex();
  await index.build(resolver);

  const tables = new TableIndex();
  for (const file of resolver.allFieldDefinitionFiles()) {
    tables.addFile(file);
  }

  const heights: number[] = [];
  for (const name of names) {
    const found = index.lookup(name);
    if (found.length === 0) {
      console.log(`\n=== ${name} — not found ===`);
      continue;
    }
    const markdown = declarationHover(factsFor(found[0]!, index, { root: workspace.root, tables }));
    const lines = markdown.split('\n').length;
    heights.push(lines);
    console.log(`\n=== ${name} (${found.length} declaration(s), ${lines} rendered lines) ===`);
    console.log(markdown);
  }

  // How much of the global-handle feature actually resolves, which is what says whether it earns
  // its place. Reported here rather than assumed.
  const resolved = index.resolvedGlobalHandles();
  const globals = index.allDeclarations().filter((d) => d.isGlobal === true);
  const handles = globals.filter((d) => (d.type ?? '').toLowerCase() === 'handle');
  console.log(
    `\n--- globals: ${globals.length} declared, ${handles.length} of them handles, ` +
      `${resolved.length} resolved to a class; ${index.globalAssignmentCount()} assignments tracked ---`
  );
  for (const entry of resolved.slice(0, 12)) {
    console.log(`      ${entry.global.padEnd(28)} ${entry.className}`);
  }

  if (heights.length > 0) {
    const max = Math.max(...heights);
    const mean = heights.reduce((sum, n) => sum + n, 0) / heights.length;
    console.log(`\n--- height: mean ${mean.toFixed(1)} lines, worst ${max} ---`);
  }
}

void main();
