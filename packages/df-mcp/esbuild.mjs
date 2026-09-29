import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { copyCoverageRuntime } from '../../scripts/copy-coverage-runtime.mjs';

// Beside the bundle, so `node dist/server.mjs` needs nothing else on disk. This is what lets the
// server be registered by absolute path and launched from an unrelated workspace directory.
copyCoverageRuntime(join(import.meta.dirname, 'dist', 'runtime'));

/**
 * The extension's preview bootstrap, copied rather than bundled.
 *
 * It is not a module this code imports -- it is a script the generated page loads by URL, and the
 * whole point of loading the extension's own copy is that the preview an agent sees is drawn by
 * the code that ships. Copying keeps that true for a bundle launched from anywhere.
 */
const bootstrapTo = join(import.meta.dirname, 'dist', 'preview');
mkdirSync(bootstrapTo, { recursive: true });
copyFileSync(
  join(import.meta.dirname, '..', 'vscode-dataflex', 'media', 'preview', 'bootstrap.js'),
  join(bootstrapTo, 'bootstrap.js')
);

/**
 * One self-contained ESM file.
 *
 * Nothing is external: the point of the bundle is that Claude Code can launch it with a bare
 * `node <path>` from a DataFlex workspace that has no `node_modules` of its own.
 *
 * The banner supplies what bundled CommonJS dependencies expect and ESM does not define --
 * `require`, `__dirname`, `__filename`. Without it `df-coverage`'s session module fails at load.
 */
const banner = `#!/usr/bin/env node
import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirname_of } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirname_of(__filename);
`;

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  minify: process.argv.includes('--minify'),
  banner: { js: banner },
  logLevel: 'info'
});
