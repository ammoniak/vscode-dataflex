/**
 * Parses every call site in whole DataFlex corpora and reports how well the expression layer copes.
 *
 * Same discipline as `corpus-check`, aimed one level down. Two numbers matter:
 *   - crashes, which must be zero: this runs inside the editor and may never throw; and
 *   - the imprecise rate, the share of call sites containing a fragment the expression parser
 *     could not model. The argument-count rule must never report on those, so this number bounds
 *     how much of the codebase that rule can speak about at all.
 *
 * The "top unparsed fragments" table says exactly what to implement next.
 *
 * Usage: npx tsx scripts/expr-check.ts [dir-or-file ...]
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { DfNode, ExprNode, callArguments, parseSource, walk } from '../packages/df-parser/src/index';

const SOURCE_EXTENSIONS = new Set([
  '.src', '.pkg', '.dd', '.wo', '.vw', '.rv', '.sl', '.dg', '.mod', '.cls',
  '.bpo', '.rpt', '.mnu', '.inc', '.prg', '.mac', '.fmac', '.srv', '.ds', '.pkd'
]);

const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules', '.git', 'apphtml', 'data', 'programs', 'bitmaps'
]);

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

const DEFAULT_ROOTS = [
  'C:/Program Files/DataFlex 26.0/Pkg',
  'C:/DataFlex 26.0 Examples',
  ...extraRoots()
];

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

function read(path: string): string | undefined {
  try {
    const buffer = readFileSync(path);
    const hasBom = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
    return hasBom ? buffer.subarray(3).toString('utf8') : buffer.toString('latin1');
  } catch {
    return undefined;
  }
}

/** Every `error` fragment in a tree, so the table says what is actually unmodelled. */
function errorsIn(node: ExprNode, out: string[]): void {
  if (node.kind === 'error') {
    out.push(node.name ?? node.text);
  }
  for (const child of [node.left, node.right, node.operand, node.inner, node.target, node.subscript]) {
    if (child !== undefined) {
      errorsIn(child, out);
    }
  }
  for (const arg of node.args ?? []) {
    errorsIn(arg, out);
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const roots = (argv.length > 0 ? argv : DEFAULT_ROOTS).filter((root) => {
    if (existsSync(root)) {
      return true;
    }
    console.log(`skipping missing root: ${root}`);
    return false;
  });

  const files: string[] = [];
  for (const root of roots) {
    collect(root, files);
  }

  let callSites = 0;
  let imprecise = 0;
  let arguments0 = 0;
  const crashes: { file: string; error: string }[] = [];
  const fragments = new Map<string, number>();
  /** One real statement per fragment, so the table can be acted on rather than guessed about. */
  const examples = new Map<string, string>();
  const byArgCount = new Map<number, number>();
  const started = Date.now();

  for (const file of files) {
    const text = read(file);
    if (text === undefined) {
      continue;
    }
    try {
      const unit = parseSource(text, { uri: file });
      const statements: DfNode[] = [];
      walk(unit.root, (node) => {
        if (node.kind === 'statement') {
          statements.push(node);
        }
      });

      for (const statement of statements) {
        const call = callArguments(unit, statement);
        if (call === undefined) {
          continue;
        }
        callSites++;
        byArgCount.set(call.args.length, (byArgCount.get(call.args.length) ?? 0) + 1);
        if (call.args.length === 0) {
          arguments0++;
        }
        if (call.imprecise) {
          imprecise++;
          const found: string[] = [];
          for (const arg of call.args) {
            errorsIn(arg, found);
          }
          for (const fragment of found) {
            const key = fragment.trim().slice(0, 24) || '(empty)';
            fragments.set(key, (fragments.get(key) ?? 0) + 1);
            if (!examples.has(key)) {
              examples.set(key, (statement.text ?? '').trim().slice(0, 100));
            }
          }
        }
      }
    } catch (error) {
      crashes.push({ file, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const rate = callSites === 0 ? 0 : (imprecise / callSites) * 100;
  console.log(`\nroots            : ${roots.join(', ')}`);
  console.log(`files parsed     : ${files.length}`);
  console.log(`call sites       : ${callSites.toLocaleString()}`);
  console.log(`imprecise        : ${imprecise.toLocaleString()}  (${rate.toFixed(2)}%)`);
  console.log(`no arguments     : ${arguments0.toLocaleString()}`);
  console.log(`crashes          : ${crashes.length}`);
  console.log(`elapsed          : ${((Date.now() - started) / 1000).toFixed(1)}s`);

  console.log('\nargument counts:');
  for (const [count, total] of [...byArgCount].sort((a, b) => a[0] - b[0]).slice(0, 12)) {
    console.log(`  ${String(count).padStart(3)} args  ${String(total).padStart(8)}`);
  }

  if (fragments.size > 0) {
    console.log('\ntop unparsed fragments:');
    for (const [fragment, count] of [...fragments].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
      console.log(`  ${String(count).padStart(6)}  ${JSON.stringify(fragment).padEnd(10)}  ${examples.get(fragment) ?? ''}`);
    }
  }

  for (const crash of crashes.slice(0, 10)) {
    console.log(`  CRASH ${crash.file}: ${crash.error}`);
  }

  if (crashes.length > 0) {
    process.exitCode = 1;
  }
}

main();
