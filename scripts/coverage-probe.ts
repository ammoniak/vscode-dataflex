/**
 * Measures what instrumentation would do to a real codebase.
 *
 * The open question for coverage is whether inserting a probe per basic block inflates a program
 * past a compiler limit. This answers it without compiling anything: it reports how many lines
 * and statements would be added, and how much code cannot be probed at all.
 *
 * Usage: npm run coverage-probe -- [dir]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parseSource } from '../packages/df-parser/src/index';
import { instrument } from '../packages/df-coverage/src/index';

const EXTENSIONS = new Set(['.src', '.pkg', '.dd', '.wo', '.vw', '.rv', '.dg', '.cls']);
const SKIP = new Set(['node_modules', '.git', 'apphtml', 'data', 'programs', 'bitmaps', 'dfpkg']);

function collect(target: string, out: string[]): void {
  let info;
  try {
    info = statSync(target);
  } catch {
    return;
  }
  if (info.isFile()) {
    if (EXTENSIONS.has(extname(target).toLowerCase())) {
      out.push(target);
    }
    return;
  }
  if (!info.isDirectory()) {
    return;
  }
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (SKIP.has(entry.name.toLowerCase())) {
      continue;
    }
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

const root = process.argv[2] ?? 'C:/DataFlex 26.0 Examples/WebOrder/AppSrc';
const files: string[] = [];
collect(root, files);

let originalLines = 0;
let instrumentedLines = 0;
let probes = 0;
let nextId = 0;
const skippedByReason = new Map<string, number>();
const worst: { file: string; growth: number; probes: number }[] = [];

for (const file of files) {
  const text = read(file);
  if (text === undefined) {
    continue;
  }
  const unit = parseSource(text, { uri: file });
  const result = instrument(text, unit, { file, firstId: nextId });
  nextId += result.probes.length;

  const before = text.split(/\r?\n/).length;
  const after = result.code.split(/\r?\n/).length;
  originalLines += before;
  instrumentedLines += after;
  probes += result.probes.length;

  for (const skip of result.skipped) {
    skippedByReason.set(skip.reason, (skippedByReason.get(skip.reason) ?? 0) + 1);
  }

  if (result.probes.length > 0) {
    worst.push({ file, growth: after / before, probes: result.probes.length });
  }
}

const growth = originalLines === 0 ? 1 : instrumentedLines / originalLines;

console.log(`\nroot               : ${root}`);
console.log(`files              : ${files.length}`);
console.log(`lines before       : ${originalLines.toLocaleString()}`);
console.log(`lines after        : ${instrumentedLines.toLocaleString()}`);
console.log(`growth             : ${((growth - 1) * 100).toFixed(1)}%`);
console.log(`probes inserted    : ${probes.toLocaleString()}`);

console.log('\nnot probed:');
if (skippedByReason.size === 0) {
  console.log('  (nothing)');
}
for (const [reason, count] of [...skippedByReason].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(6)}  ${reason}`);
}

console.log('\nlargest growth in one file:');
for (const entry of worst.sort((a, b) => b.growth - a.growth).slice(0, 5)) {
  console.log(
    `  ${((entry.growth - 1) * 100).toFixed(0).padStart(4)}%  ` +
      `${String(entry.probes).padStart(5)} probes  ${entry.file.split(/[\\/]/).slice(-2).join('/')}`
  );
}
