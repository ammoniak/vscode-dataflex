import { describe, expect, it } from 'vitest';
import { parseSource } from '@vscode-dataflex/parser';
import { DiagnosticSeverity } from 'vscode-languageserver';
import { analyze, fileSuppression } from '../src/analysis/analyze';
import { isExcluded, matchesGlob } from '../src/analysis/workspaceFiles';

const SEP = String.fromCharCode(92);
const DIRTY = ['Procedure Foo', '    String sUnused', 'End_Procedure'].join('\n');

describe('matchesGlob', () => {
  it('matches a recursive pattern against a nested path', () => {
    expect(matchesGlob('C:/ws/AppSrc/Vendor/ChilkatAx-9.5.0-win32.pkg', '**/ChilkatAx*.pkg')).toBe(true);
    expect(matchesGlob('C:/ws/AppSrc/Customer.wo', '**/ChilkatAx*.pkg')).toBe(false);
  });

  it('accepts Windows separators on either side', () => {
    const path = ['C:', 'ws', 'AppSrc', 'Gen', 'Wrapper.pkg'].join(SEP);
    expect(matchesGlob(path, '**/Gen/*.pkg')).toBe(true);
    expect(matchesGlob(path, ['**', 'Gen', '*.pkg'].join(SEP))).toBe(true);
  });

  it('is case-insensitive, as Windows paths are', () => {
    expect(matchesGlob('C:/WS/AppSrc/CHILKAT.PKG', '**/chilkat.pkg')).toBe(true);
  });

  it('lets a leading recursive segment match nothing', () => {
    expect(matchesGlob('C:/a.pkg', '**/*.pkg')).toBe(true);
  });

  it('keeps a single star inside one segment', () => {
    expect(matchesGlob('C:/ws/a/b.pkg', 'C:/ws/*.pkg')).toBe(false);
    expect(matchesGlob('C:/ws/b.pkg', 'C:/ws/*.pkg')).toBe(true);
  });

  it('treats a dot literally rather than as any character', () => {
    expect(matchesGlob('C:/ws/axpkg', '**/a.pkg')).toBe(false);
  });

  it('matches nothing for a malformed pattern instead of throwing', () => {
    expect(() => matchesGlob('C:/ws/a.pkg', '**/[')).not.toThrow();
  });

  it('isExcluded needs only one pattern to match', () => {
    const path = 'C:/ws/AppSrc/ChilkatAx-9.5.0-win32.pkg';
    expect(isExcluded(path, ['**/Other*.pkg', '**/ChilkatAx*.pkg'])).toBe(true);
    expect(isExcluded(path, [])).toBe(false);
  });
});

describe('file-level suppression', () => {
  it('reports findings when the file carries no marker', () => {
    expect(analyze(parseSource(DIRTY)).map((d) => d.code)).toEqual(['unused-local']);
  });

  it('silences every rule for a bare marker', () => {
    const source = `// df-analysis-ignore\n${DIRTY}`;
    expect(fileSuppression(parseSource(source))).toBe('all');
    expect(analyze(parseSource(source))).toEqual([]);
  });

  it('silences only the named rules', () => {
    const source = `// df-analysis-ignore: unused-local\n${DIRTY}`;
    expect(analyze(parseSource(source))).toEqual([]);
  });

  it('leaves other rules reporting when a different rule is named', () => {
    const source = `// df-analysis-ignore: unreachable-code\n${DIRTY}`;
    expect(analyze(parseSource(source)).map((d) => d.code)).toEqual(['unused-local']);
  });

  it('accepts a comma-separated list', () => {
    const source = `// df-analysis-ignore: unreachable-code, unused-local\n${DIRTY}`;
    expect(analyze(parseSource(source))).toEqual([]);
  });

  it('finds the marker anywhere in the file, not only at the top', () => {
    const source = `${DIRTY}\n// df-analysis-ignore`;
    expect(analyze(parseSource(source))).toEqual([]);
  });

  it('ignores the marker inside a string literal', () => {
    // Only comments carry it; the lexer already tells the two apart.
    const source = ['Procedure Foo', '    String sUnused', '    Showln "df-analysis-ignore"', 'End_Procedure'].join('\n');
    expect(analyze(parseSource(source)).map((d) => d.code)).toEqual(['unused-local']);
  });
});

describe('per-rule severity', () => {
  const NOISY = [
    'Procedure Foo',
    '    String sUnused',
    '    Procedure_Return',
    '    Send NeverRuns',
    'End_Procedure'
  ].join('\n');

  it('applies the default severity to every rule', () => {
    const found = analyze(parseSource(NOISY), { severity: DiagnosticSeverity.Warning });
    expect(found.every((d) => d.severity === DiagnosticSeverity.Warning)).toBe(true);
  });

  it('lets one noisy rule stay a hint while the rest are listed', () => {
    // The point: `unused-local` finds thousands of results on a real codebase and buries
    // everything else in the Problems panel, which does not show hints.
    const found = analyze(parseSource(NOISY), {
      severity: DiagnosticSeverity.Warning,
      severityOverrides: { 'unused-local': DiagnosticSeverity.Hint }
    });

    const byRule = new Map(found.map((d) => [String(d.code), d.severity]));
    expect(byRule.get('unused-local')).toBe(DiagnosticSeverity.Hint);
    expect(byRule.get('unreachable-code')).toBe(DiagnosticSeverity.Warning);
  });

  it('keeps the Unnecessary tag only where the finding is a hint', () => {
    const found = analyze(parseSource(NOISY), {
      severity: DiagnosticSeverity.Warning,
      severityOverrides: { 'unused-local': DiagnosticSeverity.Hint }
    });
    const unused = found.find((d) => d.code === 'unused-local')!;
    const unreachable = found.find((d) => d.code === 'unreachable-code')!;

    expect(unused.tags).toBeDefined();
    expect(unreachable.tags).toBeUndefined();
  });

  it('runs only the selected rules when the settings narrow them', () => {
    const found = analyze(parseSource(NOISY), {
      settings: {
        'unused-local': false,
        'unreachable-code': true,
        'duplicate-declaration': false,
        'unused-parameter': false
      }
    });
    expect(found.map((d) => d.code)).toEqual(['unreachable-code']);
  });
});
