import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DiagnosticSeverity } from 'vscode-languageserver';
import { IncludeResolver, SymbolIndex } from '@vscode-dataflex/workspace';
import { analyzeWorkspace, defaultRuleSettings } from '@vscode-dataflex/langserver/analysis';
import type { RuleSettings } from '@vscode-dataflex/langserver/analysis';

/**
 * The whole-workspace analysis, over the repository's own DFUnit fixture.
 *
 * This logic lived inside the language server's request handler until the MCP server needed it
 * too, which is why these are its first unit tests: reaching it before meant standing up an LSP
 * connection. It needs no DataFlex install -- the search path is handed over directly instead of
 * coming from `df-cli config --json`.
 */
const ROOT = resolve('fixtures/dfunit');
const SEARCH_PATH = [resolve(ROOT, 'AppSrc'), resolve(ROOT, 'AppSrc/Tests')];

function run(overrides: Partial<Parameters<typeof analyzeWorkspace>[0]> = {}) {
  const resolver = new IncludeResolver(SEARCH_PATH);
  const index = new SymbolIndex();
  for (const file of resolver.allSourceFiles()) {
    index.indexFile(file);
  }
  return analyzeWorkspace({
    resolver,
    index,
    root: ROOT,
    settings: defaultRuleSettings(),
    severity: DiagnosticSeverity.Hint,
    severityOverrides: {},
    exclude: [],
    ...overrides
  });
}

describe('analyzeWorkspace', () => {
  it('analyses the files the workspace owns and reports a per-rule breakdown', () => {
    const result = run();

    expect(result.filesAnalyzed).toBeGreaterThan(0);
    expect(result.filesSkipped).toBe(0);
    expect(Object.values(result.byRule).reduce((sum, n) => sum + n, 0)).toBe(result.findings);
    for (const file of result.files) {
      expect(file.uri.startsWith('file:')).toBe(true);
      expect(file.diagnostics.length).toBeGreaterThan(0);
    }
  });

  it('counts every reported finding against a rule', () => {
    const result = run();
    const reported = result.files.flatMap((file) => file.diagnostics);

    expect(reported).toHaveLength(result.findings);
    for (const diagnostic of reported) {
      expect(diagnostic.code, diagnostic.message).toBeDefined();
      expect(diagnostic.source).toBe('dataflex');
    }
  });

  it('skips files an exclude glob covers, and says how many', () => {
    const all = run();
    const excluded = run({ exclude: ['**/Tests/**'] });

    expect(excluded.filesSkipped).toBeGreaterThan(0);
    expect(excluded.filesAnalyzed).toBe(all.filesAnalyzed - excluded.filesSkipped);
  });

  it('turns on a rule that ships off when it is named explicitly', () => {
    // `dead-procedure` defaults to off, so a list that merely *filtered* enabled rules would
    // report nothing here. It is authoritative instead: naming a rule is a request to run it.
    const settings: RuleSettings = defaultRuleSettings();
    expect(settings['dead-procedure']).toBe(false);

    const result = run({ rules: ['dead-procedure'] });

    expect(result.byRule['dead-procedure']).toBeGreaterThan(0);
  });

  it('runs only the rules the explicit list names', () => {
    const result = run({ rules: ['dead-procedure'] });

    expect(Object.keys(result.byRule)).toEqual(['dead-procedure']);
  });

  it('reports nothing at all when the list is empty', () => {
    const result = run({ rules: [] });

    expect(result.findings).toBe(0);
    expect(result.files).toHaveLength(0);
    // Still counted as analysed: the files were read and parsed, they just had no rule to break.
    expect(result.filesAnalyzed).toBeGreaterThan(0);
  });

  it('reports uris that point back at the analysed files', () => {
    const result = run({ rules: ['dead-procedure'] });

    for (const file of result.files) {
      expect(fileURLToPath(file.uri).toLowerCase()).toContain('dfunit');
    }
  });

  it('skips the index-dependent rules rather than guessing when there is no index', () => {
    const withoutIndex = run({ index: undefined, rules: ['dead-procedure'] });

    expect(withoutIndex.byRule['dead-procedure']).toBeUndefined();
    expect(withoutIndex.findings).toBe(0);
  });
});
