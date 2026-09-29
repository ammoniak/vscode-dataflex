import { build, context } from 'esbuild';
import { join } from 'node:path';

import { copyCoverageRuntime } from '../../scripts/copy-coverage-runtime.mjs';

// Into the extension folder, where `.vscodeignore` lets it into the vsix and the test
// controller finds it beside the extension at run time.
copyCoverageRuntime(join(import.meta.dirname, 'runtime'));

/**
 * Whether the debugger goes into this build.
 *
 * On by default so the F5 development host has it, since there is no other way to work on it. The
 * standard vsix is built with `--no-debugger`: `extension.ts` guards its registration with
 * `INCLUDE_DEBUGGER`, esbuild substitutes the literal below before tree shaking, and the dead
 * branch takes `src/debug.ts`, `@vscode-dataflex/debug` and the parser copy it pulls with it --
 * about 1.3 MB of the bundle, on top of the 64 MB host that `.vscodeignore` then leaves out.
 *
 * `scripts/package-extension.mjs` strips the matching manifest contributions, so the two always
 * agree: a build with no debug registration also offers no `dataflex` debug type.
 */
const includeDebugger = !process.argv.includes('--no-debugger');

/**
 * Bundles the extension client and the language server as separate CJS entry points.
 * `vscode` is provided by the host at runtime; the server never imports it.
 */
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
  minify: process.argv.includes('--minify'),
  define: { INCLUDE_DEBUGGER: String(includeDebugger) },
  logLevel: 'info'
};

const targets = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'out/extension.js' },
  { ...common, entryPoints: ['../df-langserver/src/server.ts'], outfile: 'out/server.js' }
];

if (process.argv.includes('--watch')) {
  for (const options of targets) {
    const ctx = await context(options);
    await ctx.watch();
  }
} else {
  await Promise.all(targets.map((options) => build(options)));
}
