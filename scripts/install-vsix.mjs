/**
 * Packages nothing; installs the already-built VSIX with a clean console.
 *
 * `code --install-extension` prints a Node deprecation warning that has nothing to do with this
 * extension. Traced with `NODE_OPTIONS=--trace-deprecation`, the stack is entirely inside VS
 * Code's own CLI:
 *
 *     at urlParse (node:url)
 *     at Qi.queryRawGalleryExtensions (.../cliProcessMain.js)
 *     at ks.updateMetadata            (.../cliProcessMain.js)
 *
 * After installing, the CLI queries the extension marketplace to refresh metadata, and that HTTP
 * client still uses the deprecated `url.parse()`. There is no flag to skip it and nothing to fix
 * on our side, so this filters those specific lines and passes everything else through --
 * including the exit code, so a real failure still fails.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// An explicit path is accepted so the failure path can be exercised.
const vsix = process.argv[2] ?? join(here, '..', 'packages', 'vscode-dataflex', 'dataflex.vsix');

if (!existsSync(vsix)) {
  console.error(`No VSIX at ${vsix}. Run "npm run package" first.`);
  process.exit(1);
}

/**
 * Suppresses the deprecation block and nothing else.
 *
 * Stack frames are only dropped while inside that block: a real install failure also prints
 * `at ...` lines, and swallowing those would hide the actual problem.
 */
function makeFilter(stream) {
  let inDeprecation = false;

  return (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.length === 0) {
        continue;
      }
      if (/DeprecationWarning/.test(line)) {
        inDeprecation = true;
        continue;
      }
      if (inDeprecation) {
        // The warning is followed by its stack and a "use --trace-deprecation" hint.
        if (/^\s+at /.test(line) || /^\(Use `?[A-Za-z]* ?--trace-deprecation/.test(line)) {
          continue;
        }
        inDeprecation = false;
      }
      stream.write(`${line}
`);
    }
  };
}

const child = spawn(`code --install-extension "${vsix}" --force`, {
  shell: true,
  stdio: ['inherit', 'pipe', 'pipe']
});

/** Prints `chunk` line by line, dropping known-irrelevant noise. */
const filter = (stream) => (chunk) => {
  for (const line of chunk.toString().split(/\r?\n/)) {
    if (line.length === 0 || NOISE.some((pattern) => pattern.test(line))) {
      continue;
    }
    stream.write(`${line}\n`);
  }
};

child.stdout.on('data', makeFilter(process.stdout));
child.stderr.on('data', makeFilter(process.stderr));

child.on('error', (error) => {
  console.error(`Could not run the "code" CLI: ${error.message}`);
  process.exit(1);
});

child.on('close', (code) => {
  process.exit(code ?? 1);
});
