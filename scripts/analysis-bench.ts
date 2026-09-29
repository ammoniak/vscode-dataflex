/**
 * Times parse + analyse for the largest files in a tree.
 *
 * Live analysis runs on a debounce after every keystroke, so its cost per file is what the editor
 * actually feels. Anything superlinear in file size shows up here first.
 *
 * Usage: npm run analysis-bench -- [dir]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parseSource } from '../packages/df-parser/src/index';
import { analyze } from '../packages/df-langserver/src/analysis/analyze';

const EXTENSIONS = new Set(['.src', '.pkg', '.dd', '.wo', '.vw', '.rv', '.dg', '.cls']);
const SKIP = new Set(['node_modules', '.git', 'apphtml', 'data', 'programs', 'bitmaps']);

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

function read(path: string): string {
  const buffer = readFileSync(path);
  const hasBom = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  return hasBom ? buffer.subarray(3).toString('utf8') : buffer.toString('latin1');
}

const root = process.argv[2] ?? 'C:/DataFlex 26.0 Examples/WebOrder/AppSrc';
const files: string[] = [];
collect(root, files);

const sized = files
  .map((file) => ({ file, size: statSync(file).size }))
  .sort((a, b) => b.size - a.size)
  .slice(0, 12);

console.log(`\n${'file'.padEnd(42)} ${'KB'.padStart(6)} ${'lines'.padStart(6)} ${'parse'.padStart(8)} ${'analyse'.padStart(9)}`);
console.log('-'.repeat(78));

let worstAnalyse = 0;
for (const { file, size } of sized) {
  const text = read(file);
  const lines = text.split('\n').length;

  const p0 = performance.now();
  const unit = parseSource(text, { uri: file });
  const parseMs = performance.now() - p0;

  const a0 = performance.now();
  analyze(unit);
  const analyseMs = performance.now() - a0;
  worstAnalyse = Math.max(worstAnalyse, analyseMs);

  console.log(
    `${file.split(/[\\/]/).slice(-1)[0]!.padEnd(42).slice(0, 42)} ` +
      `${(size / 1024).toFixed(0).padStart(6)} ${String(lines).padStart(6)} ` +
      `${parseMs.toFixed(1).padStart(6)}ms ${analyseMs.toFixed(1).padStart(7)}ms`
  );
}

console.log(`\nworst analyse: ${worstAnalyse.toFixed(0)} ms`);
