/**
 * Prints the parser's block-balance diagnostics for specific files, with the offending source
 * line. This is the drill-down companion to `corpus-check`, which only reports counts.
 *
 * Usage: npm run parse-diagnostics -- <file> [...]
 */
import { readFileSync } from 'node:fs';
import { parseSource } from '../packages/df-parser/src/index';

let total = 0;

for (const file of process.argv.slice(2)) {
  const buffer = readFileSync(file);
  const hasBom = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const text = hasBom ? buffer.subarray(3).toString('utf8') : buffer.toString('latin1');

  const unit = parseSource(text, { uri: file });
  const lines = text.split(/\r?\n/);

  for (const diagnostic of unit.diagnostics) {
    total++;
    const lineNumber = diagnostic.range.start.line;
    console.log(`${file}:${lineNumber + 1}  [${diagnostic.severity}] ${diagnostic.message}`);
    console.log(`    | ${(lines[lineNumber] ?? '').trim().slice(0, 100)}`);
  }
}

console.log(`\n${total} diagnostic(s).`);
