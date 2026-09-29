import { build } from 'esbuild';

/** Bundles the VS Code integration tests; mocha loads them from out-test/. */
await build({
  entryPoints: ['test/integration/extension.test.ts'],
  bundle: true,
  outdir: 'out-test',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode', 'mocha'],
  sourcemap: true,
  logLevel: 'info'
});
