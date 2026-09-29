/**
 * Measures the dead-procedure rule against a real workspace.
 *
 * Dead-code detection is the one rule that can tell you to delete working code, so it does not
 * ship on until its false-positive rate is known. This prints what was spared and why, plus a
 * sample of findings to triage by hand.
 *
 * Usage: npm run deadcode-check -- <path-to-sws>
 */
import { cliForWorkspace, IncludeResolver, loadWorkspace, SymbolIndex } from '../packages/df-workspace/src/index';
import { findDeadMethods } from '../packages/df-langserver/src/analysis/deadCode';

async function main(): Promise<void> {
  const sws = process.argv[2] ?? 'C:/DataFlex 26.0 Examples/WebOrder/WebOrder.sws';
  const { cliPath: cli, warning } = await cliForWorkspace(sws);
  if (cli === undefined) {
    console.error('df-cli.exe not found');
    process.exit(2);
  }
  if (warning !== undefined) {
    console.warn(warning);
  }

  const workspace = await loadWorkspace(cli, sws);
  if (workspace === undefined) {
    console.error(`could not load ${sws}`);
    process.exit(2);
  }

  const index = new SymbolIndex();
  await index.build(new IncludeResolver(workspace.searchPath));

  const started = Date.now();
  const result = findDeadMethods(index, workspace.root);
  const elapsed = Date.now() - started;

  console.log(`\nworkspace   : ${workspace.name}`);
  console.log(`indexed     : ${index.fileCount} files, ${index.classCount} classes`);
  console.log(`candidates  : ${result.candidates} methods in workspace-owned files`);
  console.log(`dead        : ${result.dead.length}`);
  console.log(`elapsed     : ${elapsed} ms\n`);

  console.log('spared by:');
  for (const [reason, count] of Object.entries(result.sparedBy).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason.padEnd(14)} ${count}`);
  }

  console.log('\nsample findings:');
  for (const { declaration } of result.dead.slice(0, 30)) {
    const where = declaration.file.split(/[\\/]/).slice(-2).join('/');
    const owner = declaration.ownerClass ?? '(top level)';
    console.log(
      `  ${declaration.name.padEnd(38)} ${String(declaration.kind).padEnd(10)} ` +
        `${owner.padEnd(26)} ${where}:${declaration.nameRange.start.line + 1}`
    );
  }
}

void main();
