import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DiagnosticSeverity } from 'vscode-languageserver';
import { IncludeResolver, SymbolIndex } from '@vscode-dataflex/workspace';
import { analyzeWorkspace } from '../src/analysis/analyzeWorkspace';
import { defaultRuleSettings } from '../src/analysis/rules';

/**
 * Whether `// df-ignore` reaches `argument-count`.
 *
 * It did not. The rule needs the whole index to know what a message name resolves to, so its
 * findings are appended after `analyze()` has returned -- and `analyze()` is where suppression was
 * applied. That made it the one rule no comment could switch off, the whole-file marker included,
 * which is exactly the marker generated code carries.
 */
const scratch = mkdtempSync(join(tmpdir(), 'df-suppress-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const DECLARATION = [
  'Class cFeed is a cObject',
  '    Procedure Revoke String sFeedType String sLogin Integer iCompanyID',
  '    End_Procedure',
  'End_Class'
].join('\n');

/** A workspace of two files: the declaration, and a caller passing one argument too few. */
function workspaceWith(callerHeader: string, callLine: string): { root: string } {
  const root = mkdtempSync(join(scratch, 'ws-'));
  writeFileSync(join(root, 'cFeed.pkg'), DECLARATION, 'utf8');
  writeFileSync(
    join(root, 'Caller.pkg'),
    [callerHeader, 'Procedure Caller', `    ${callLine}`, 'End_Procedure'].join('\n'),
    'utf8'
  );
  return { root };
}

async function findings(callerHeader: string, callLine: string): Promise<number> {
  const { root } = workspaceWith(callerHeader, callLine);
  const resolver = new IncludeResolver([root]);
  const index = new SymbolIndex();
  await index.build(resolver);

  const result = analyzeWorkspace({
    resolver,
    index,
    root,
    settings: { ...defaultRuleSettings(), 'argument-count': true },
    severity: DiagnosticSeverity.Warning,
    severityOverrides: {},
    exclude: [],
    rules: ['argument-count']
  });
  return result.byRule['argument-count'] ?? 0;
}

const CALL = 'Send Revoke of ghoFeed sLogin iCompanyID';

describe('argument-count suppression', () => {
  it('reports the mismatch when nothing silences it', async () => {
    expect(await findings('', CALL)).toBe(1);
  });

  it('is silenced by // df-ignore:argument-count on the line above', async () => {
    expect(await findings('', `// df-ignore:argument-count\n    ${CALL}`)).toBe(0);
  });

  it('is silenced by a trailing // df-ignore:all', async () => {
    expect(await findings('', `${CALL} // df-ignore:all`)).toBe(0);
  });

  it('is silenced by a whole-file // df-analysis-ignore', async () => {
    expect(await findings('// df-analysis-ignore', CALL)).toBe(0);
  });

  it('is silenced when the file names it in df-analysis-ignore', async () => {
    expect(await findings('// df-analysis-ignore: argument-count', CALL)).toBe(0);
  });

  it('still reports when the file suppresses a different rule', async () => {
    expect(await findings('// df-analysis-ignore: unused-local', CALL)).toBe(1);
  });
});
