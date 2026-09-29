/**
 * Measures how long the workspace declaration index takes to build, per workspace.
 *
 * The index is built on activation, so this is the number that decides whether go-to-definition
 * feels instant or whether the build needs caching to disk.
 *
 * Usage: npm run index-bench -- <path-to-sws> [...]
 */
import { cliForWorkspace, IncludeResolver, loadWorkspace, SymbolIndex } from '../packages/df-workspace/src/index';

async function main(): Promise<void> {
  for (const sws of process.argv.slice(2)) {
    // Per workspace, not once for the run: a benchmark comparing two workspaces that ask for
    // different DataFlex versions has to time each against its own library.
    const { cliPath: cli, warning } = await cliForWorkspace(sws);
    if (cli === undefined) {
      console.error('df-cli.exe not found');
      process.exit(2);
    }
    if (warning !== undefined) {
      console.warn(warning);
    }

    const configStarted = Date.now();
    const workspace = await loadWorkspace(cli, sws);
    const configMs = Date.now() - configStarted;
    if (workspace === undefined) {
      console.log(`${sws}: FAILED to load`);
      continue;
    }

    const scanStarted = Date.now();
    const resolver = new IncludeResolver(workspace.searchPath);
    const files = resolver.allSourceFiles();
    const scanMs = Date.now() - scanStarted;

    const indexStarted = Date.now();
    const index = new SymbolIndex();
    await index.build(resolver);
    const indexMs = Date.now() - indexStarted;

    console.log(
      `${workspace.name.padEnd(18)} ` +
        `paths=${String(workspace.searchPath.length).padStart(3)} ` +
        `files=${String(files.length).padStart(5)} ` +
        `names=${String(index.size).padStart(6)} ` +
        `| df-cli ${String(configMs).padStart(5)} ms ` +
        `| scan ${String(scanMs).padStart(4)} ms ` +
        `| index ${String(indexMs).padStart(5)} ms`
    );
  }
}

void main();
