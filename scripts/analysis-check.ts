/**
 * Runs the static analysis rules over whole corpora and reports what each one fires on.
 *
 * The point is to measure a rule's noise before trusting it on by default: a rule that fires
 * thousands of times on working, shipped code is wrong about that code, not the other way round.
 * Sample findings are printed so they can be triaged by hand.
 *
 * Usage: npm run analysis-check -- [dir ...]
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parseSource } from '../packages/df-parser/src/index';
import { cliForWorkspace, IncludeResolver, loadWorkspace, SymbolIndex } from '@vscode-dataflex/workspace';
import { analyze } from '../packages/df-langserver/src/analysis/analyze';
import { overridesAncestor } from '../packages/df-langserver/src/analysis/overrides';
import { RULES, RuleId } from '../packages/df-langserver/src/analysis/rules';
import { findArgumentCountMismatches, makeArityResolver } from '../packages/df-langserver/src/analysis/argumentCount';
import { isWorkspaceOwnedFile } from '../packages/df-langserver/src/analysis/workspaceFiles';
import type { ResolveArity } from '../packages/df-langserver/src/analysis/argumentCount';

const SOURCE_EXTENSIONS = new Set(['.src', '.pkg', '.dd', '.wo', '.vw', '.rv', '.dg', '.mod', '.cls']);
const SKIP = new Set(['node_modules', '.git', 'apphtml', 'data', 'programs', 'bitmaps']);

const DEFAULT_ROOTS = ['C:/DataFlex 26.0 Examples', 'C:/Program Files/DataFlex 26.0/Pkg'];

function collect(target: string, out: string[]): void {
  let info;
  try {
    info = statSync(target);
  } catch {
    return;
  }
  if (info.isFile()) {
    if (SOURCE_EXTENSIONS.has(extname(target).toLowerCase())) out.push(target);
    return;
  }
  if (!info.isDirectory()) return;
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (SKIP.has(entry.name.toLowerCase())) continue;
    collect(join(target, entry.name), out);
  }
}

function read(path: string): string | undefined {
  try {
    const buffer = readFileSync(path);
    const hasBom = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
    return hasBom ? buffer.subarray(3).toString('utf8') : buffer.toString('latin1');
  } catch {
    return undefined;
  }
}

const roots = (process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_ROOTS).filter(existsSync);
/** How many example findings to print per rule; `--samples N` widens it for review. */
const sampleLimit = (() => {
  const at = process.argv.indexOf('--samples');
  const value = at === -1 ? NaN : Number.parseInt(process.argv[at + 1] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : 6;
})();

const files: string[] = [];
for (const root of roots) collect(root, files);

/**
 * Builds the index when a single workspace is being checked, so the override-aware rules are
 * measured the way they actually behave in the editor rather than with the check disabled.
 */
async function buildIndex(): Promise<{ index: SymbolIndex; root: string } | undefined> {
  if (roots.length !== 1) return undefined;
  const sws = readdirSync(roots[0]!).find((entry) => entry.toLowerCase().endsWith('.sws'));
  if (sws === undefined) return undefined;
  const { cliPath: cli, warning } = await cliForWorkspace(join(roots[0]!, sws));
  if (cli === undefined) return undefined;
  if (warning !== undefined) console.warn(warning);
  console.log(`Using df-cli: ${cli}`);
  const workspace = await loadWorkspace(cli, join(roots[0]!, sws));
  if (workspace === undefined) return undefined;
  const index = new SymbolIndex();
  await index.build(new IncludeResolver(workspace.searchPath));
  return { index, root: workspace.root };
}

async function main(): Promise<void> {
  const built = await buildIndex();
  const index = built?.index;
  const overrideCheck =
    index === undefined ? undefined : (name: string, owner: never) => overridesAncestor(index, name, owner);
  console.log(index === undefined ? 'no index (override check disabled)' : 'index built for override check');

  // The same resolver the server builds, so the measurement matches what a user would see.
  const resolveArity: ResolveArity | undefined =
    index === undefined
      ? undefined
      : makeArityResolver(index, (file) => isWorkspaceOwnedFile(file, built!.root));

  // Every rule on, so even the opt-in ones get measured.
  const settings = Object.fromEntries(RULES.map((r) => [r.id, true])) as Record<RuleId, boolean>;

  const counts = new Map<RuleId, number>();
  const samples = new Map<RuleId, string[]>();
  let procedures = 0;

  for (const file of files) {
    const text = read(file);
    if (text === undefined) continue;
    const unit = parseSource(text, { uri: file });
    const lines = text.split(/\r?\n/);
    const found = analyze(unit, { settings, overridesAncestor: overrideCheck });
    // Needs the index, so it is driven here rather than from `analyze`, matching the server.
    if (resolveArity !== undefined) {
      for (const finding of findArgumentCountMismatches(unit, resolveArity)) {
        found.push({ range: finding.range, message: finding.message, code: 'argument-count' });
      }
    }
    for (const diagnostic of found) {
      const rule = diagnostic.code as RuleId;
      counts.set(rule, (counts.get(rule) ?? 0) + 1);
      const bucket = samples.get(rule) ?? [];
      if (bucket.length < sampleLimit) {
        const line = (lines[diagnostic.range.start.line] ?? '').trim().slice(0, 80);
        bucket.push(`${file.split(/[\/]/).slice(-2).join('/')}:${diagnostic.range.start.line + 1}  ${line}`);
        samples.set(rule, bucket);
      }
    }
    const countProcs = (node: { kind: string; children?: unknown[] }): void => {
      if (node.kind === 'procedure' || node.kind === 'function') procedures++;
      for (const child of (node.children ?? []) as { kind: string; children?: unknown[] }[]) countProcs(child);
    };
    countProcs(unit.root as never);
  }

  console.log(`\nroots      : ${roots.join(', ')}`);
  console.log(`files      : ${files.length}`);
  console.log(`procedures : ${procedures.toLocaleString()}\n`);

  for (const rule of RULES) {
    const count = counts.get(rule.id) ?? 0;
    const per = procedures === 0 ? 0 : (count / procedures) * 100;
    console.log(
      `${rule.id.padEnd(24)} ${String(count).padStart(6)} findings  ` +
        `(${per.toFixed(1)} per 100 procedures)  default=${rule.defaultEnabled ? 'on' : 'off'}`
    );
    for (const sample of samples.get(rule.id) ?? []) console.log(`      ${sample}`);
  }
}

void main();
