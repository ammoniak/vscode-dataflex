import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The coverage runtime is DataFlex source, not JavaScript, so esbuild will not bundle it. It is
 * copied beside the bundle instead, where the host finds it at run time. Without this, coverage
 * works when run from the repository and fails for anything shipped.
 *
 * Shared by the extension's bundler and the MCP server's, so the two cannot drift.
 */
export function copyCoverageRuntime(destination) {
  const from = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'df-coverage', 'runtime');
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(from).filter((file) => file.toLowerCase().endsWith('.pkg'))) {
    copyFileSync(join(from, name), join(destination, name));
  }
}
