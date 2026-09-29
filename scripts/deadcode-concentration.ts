/**
 * Shows where dead-procedure findings concentrate.
 *
 * A generated vendor wrapper (an ActiveX binding, say) can declare thousands of methods an
 * application never calls. Those are technically dead but not actionable, and they would drown
 * the findings that are -- so it matters whether the total is spread across hand-written code or
 * piled into a handful of generated files.
 *
 * Usage: npm run deadcode-concentration -- [path-to-sws]
 */
import { cliForWorkspace, IncludeResolver, loadWorkspace, SymbolIndex } from '../packages/df-workspace/src/index';
import { findDeadMethods } from '../packages/df-langserver/src/analysis/deadCode';

async function main(): Promise<void> {
  const sws = process.argv[2] ?? 'C:/DataFlex 26.0 Examples/WebOrder/WebOrder.sws';
  const { cliPath: cli, warning } = await cliForWorkspace(sws);
  if (warning !== undefined) {
    console.warn(warning);
  }
  const workspace = await loadWorkspace(cli!, sws);
  if (workspace === undefined) {
    console.error(`could not load ${sws}`);
    process.exit(2);
  }

  const index = new SymbolIndex();
  await index.build(new IncludeResolver(workspace.searchPath));
  const result = findDeadMethods(index, workspace.root);

  const byFile = new Map<string, number>();
  for (const { declaration } of result.dead) {
    byFile.set(declaration.file, (byFile.get(declaration.file) ?? 0) + 1);
  }

  const ranked = [...byFile].sort((a, b) => b[1] - a[1]);
  console.log(`dead: ${result.dead.length} across ${byFile.size} files\n`);
  console.log('top 15 files:');
  let topTotal = 0;
  for (const [file, count] of ranked.slice(0, 15)) {
    topTotal += count;
    console.log(`  ${String(count).padStart(5)}  ${file.split(/[\\/]/).slice(-2).join('/')}`);
  }
  const share = result.dead.length === 0 ? 0 : (topTotal / result.dead.length) * 100;
  console.log(`\n  those 15 files hold ${topTotal} findings (${share.toFixed(0)}% of the total)`);

  const tail = ranked.filter(([, count]) => count <= 3);
  console.log(`  ${tail.length} files hold 3 or fewer findings each`);
}

void main();
