/**
 * Parses whole DataFlex corpora and reports how well the structure parser copes.
 *
 * Two numbers matter:
 *   - crashes, which must be zero: the parser is an editor component and may never throw; and
 *   - the unknown rate, the share of logical lines the parser could not classify into anything
 *     semantically useful. Driving that number down is what turns the tolerant layer into a
 *     usable one, and the "top unknown heads" table says exactly what to implement next.
 *
 * Usage: npm run corpus-check -- <dir-or-file> [...]
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parseSource, walk, DfNode } from '../packages/df-parser/src/index';

const SOURCE_EXTENSIONS = new Set([
  '.src', '.pkg', '.dd', '.wo', '.vw', '.rv', '.sl', '.dg', '.mod', '.cls',
  '.bpo', '.rpt', '.mnu', '.inc', '.prg', '.mac', '.fmac', '.srv', '.ds', '.pkd'
]);

/**
 * Directories that never contain DataFlex source.
 *
 * `AppHtml` matters: classic-ASP web apps put VBScript `.inc` files there, and `.inc` is also a
 * legitimate DataFlex extension (`Language_WebApp_English.inc`). The language server avoids the
 * clash by indexing only the `appsrc`/`ddsrc`/`idesrc` paths that `df-cli config` reports, and
 * the corpus checker mirrors that so the numbers describe DataFlex rather than VBScript.
 */
const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'apphtml',
  'data',
  'programs',
  'bitmaps'
]);

interface Stats {
  files: number;
  bytes: number;
  logicalLines: number;
  unknown: number;
  diagnostics: number;
  crashes: { file: string; error: string }[];
  unbalanced: { file: string; count: number }[];
  unknownHeads: Map<string, number>;
  nodeKinds: Map<string, number>;
  slowest: { file: string; ms: number }[];
}

function collect(target: string, out: string[]): void {
  let info;
  try {
    info = statSync(target);
  } catch {
    return;
  }
  if (info.isFile()) {
    if (SOURCE_EXTENSIONS.has(extname(target).toLowerCase())) {
      out.push(target);
    }
    return;
  }
  if (!info.isDirectory()) {
    return;
  }
  let entries;
  try {
    entries = readdirSync(target, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry.name.toLowerCase())) {
      continue;
    }
    collect(join(target, entry.name), out);
  }
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function topN(map: Map<string, number>, n: number): [string, number][] {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

/**
 * Extra corpus roots, from `DATAFLEX_CORPUS`, semicolon-separated.
 *
 * The defaults below are what a DataFlex 26 install puts on any machine. Real application code is
 * the corpus that matters most and is the one nobody can ship, so it is named by environment
 * instead: `set DATAFLEX_CORPUS=C:\MyLibraries` and it is checked alongside the rest.
 */
function extraRoots(): string[] {
  return (process.env.DATAFLEX_CORPUS ?? '')
    .split(';')
    .map((root) => root.trim())
    .filter((root) => root.length > 0);
}

/**
 * Corpora checked when no roots are given: the DataFlex 26 runtime library and the shipped
 * examples, which between them cover the framework and the sample code. Real application code is
 * the third corpus that matters and the one nobody can ship, so it comes from `DATAFLEX_CORPUS`.
 */
const DEFAULT_ROOTS = [
  'C:/Program Files/DataFlex 26.0/Pkg',
  'C:/DataFlex 26.0 Examples',
  ...extraRoots()
];

function main(): void {
  const argv = process.argv.slice(2);
  const roots = (argv.length > 0 ? argv : DEFAULT_ROOTS).filter((root) => {
    if (existsSync(root)) {
      return true;
    }
    console.log(`skipping missing root: ${root}`);
    return false;
  });

  if (roots.length === 0) {
    console.error('usage: npm run corpus-check -- <dir-or-file> [...]');
    process.exit(2);
  }

  const files: string[] = [];
  for (const root of roots) {
    collect(root, files);
  }

  const stats: Stats = {
    files: 0,
    bytes: 0,
    logicalLines: 0,
    unknown: 0,
    diagnostics: 0,
    crashes: [],
    unbalanced: [],
    unknownHeads: new Map(),
    nodeKinds: new Map(),
    slowest: []
  };

  // Pass 1: collect every struct / legacy `Type` name in the corpus. Layer 3 (the workspace
  // linker) will supply exactly this set, so seeding it here shows what the unknown rate will
  // look like once cross-file type resolution exists, rather than leaving it to be guessed.
  const knownTypes = new Set<string>();
  const knownCommands = new Set<string>();
  const readSource = (path: string): string | undefined => {
    try {
      // DataFlex sources are a mix of UTF-8 (usually with a BOM) and Windows-1252. Sniff the
      // BOM rather than guessing, so byte-level mojibake never shows up as parser noise.
      const buffer = readFileSync(path);
      const hasBom = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
      return hasBom ? buffer.subarray(3).toString('utf8') : buffer.toString('latin1');
    } catch {
      return undefined;
    }
  };

  if (process.env.DF_SINGLE_PASS !== '1') {
    for (const file of files) {
      const text = readSource(file);
      if (text === undefined) {
        continue;
      }
      try {
        walk(parseSource(text, { uri: file }).root, (node: DfNode) => {
          if (node.name === undefined) {
            return;
          }
          if (node.kind === 'struct') {
            knownTypes.add(node.name.toLowerCase());
          } else if (node.kind === 'command') {
            knownCommands.add(node.name.toLowerCase());
          }
        });
      } catch {
        // Pass 2 reports the crash with a stack; ignore it here.
      }
    }
    console.log(
      `seeded ${knownTypes.size} struct/Type names and ${knownCommands.size} #COMMAND names ` +
        'from a first pass'
    );
  }

  const started = Date.now();

  for (const file of files) {
    let text: string;
    try {
      // DataFlex sources are a mix of UTF-8 (usually with a BOM) and Windows-1252. Sniff the
      // BOM rather than guessing, so byte-level mojibake never shows up as parser noise.
      const buffer = readFileSync(file);
      const hasBom = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
      text = hasBom ? buffer.subarray(3).toString('utf8') : buffer.toString('latin1');
    } catch {
      continue;
    }

    const t0 = performance.now();
    try {
      const unit = parseSource(text, { uri: file, knownTypes, knownCommands });
      const ms = performance.now() - t0;

      stats.files++;
      stats.bytes += text.length;
      stats.logicalLines += unit.logicalLineCount;
      stats.unknown += unit.unknownCount;
      stats.diagnostics += unit.diagnostics.length;
      stats.slowest.push({ file, ms });

      if (unit.diagnostics.length > 0) {
        stats.unbalanced.push({ file, count: unit.diagnostics.length });
      }

      walk(unit.root, (node: DfNode) => {
        bump(stats.nodeKinds, node.kind);
        if (node.kind === 'unknown') {
          bump(stats.unknownHeads, (node.verb ?? '<punct>').toLowerCase());
        }
      });
    } catch (error) {
      stats.crashes.push({ file, error: error instanceof Error ? error.stack ?? error.message : String(error) });
    }
  }

  const elapsed = Date.now() - started;
  const unknownRate = stats.logicalLines === 0 ? 0 : (stats.unknown / stats.logicalLines) * 100;

  console.log('');
  console.log('=== DataFlex corpus check ===');
  console.log(`roots            : ${roots.join(', ')}`);
  console.log(`files parsed     : ${stats.files}`);
  console.log(`bytes            : ${(stats.bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`logical lines    : ${stats.logicalLines.toLocaleString()}`);
  console.log(`unknown lines    : ${stats.unknown.toLocaleString()}  (${unknownRate.toFixed(2)}%)`);
  console.log(`parse diagnostics: ${stats.diagnostics.toLocaleString()} in ${stats.unbalanced.length} files`);
  console.log(`crashes          : ${stats.crashes.length}`);
  console.log(`elapsed          : ${elapsed} ms  (${(stats.bytes / 1024 / 1024 / (elapsed / 1000)).toFixed(1)} MB/s)`);

  console.log('');
  console.log('--- node kinds ---');
  for (const [kind, count] of topN(stats.nodeKinds, 25)) {
    console.log(`  ${kind.padEnd(14)} ${count.toLocaleString()}`);
  }

  console.log('');
  console.log('--- top unknown heads (what to implement next) ---');
  for (const [head, count] of topN(stats.unknownHeads, 40)) {
    const share = ((count / Math.max(stats.unknown, 1)) * 100).toFixed(1);
    console.log(`  ${head.padEnd(28)} ${String(count).padStart(6)}  ${share.padStart(5)}% of unknown`);
  }

  if (stats.unbalanced.length > 0) {
    console.log('');
    console.log('--- files with the most block-balance diagnostics ---');
    for (const entry of stats.unbalanced.sort((a, b) => b.count - a.count).slice(0, 15)) {
      console.log(`  ${String(entry.count).padStart(5)}  ${entry.file}`);
    }
  }

  if (stats.crashes.length > 0) {
    console.log('');
    console.log('--- CRASHES ---');
    for (const crash of stats.crashes.slice(0, 5)) {
      console.log(`  ${crash.file}\n    ${crash.error.split('\n').slice(0, 3).join('\n    ')}`);
    }
    process.exitCode = 1;
  }

  console.log('');
  console.log('--- slowest files ---');
  for (const entry of stats.slowest.sort((a, b) => b.ms - a.ms).slice(0, 5)) {
    console.log(`  ${entry.ms.toFixed(1).padStart(7)} ms  ${entry.file}`);
  }
}

main();
