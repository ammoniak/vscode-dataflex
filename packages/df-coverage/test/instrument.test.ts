import { describe, expect, it } from 'vitest';
import { parseSource } from '@vscode-dataflex/parser';
import { instrument } from '../src/instrument';

function run(source: string) {
  return instrument(source, parseSource(source, { uri: 'test.pkg' }), { file: 'C:\\ws\\test.pkg' });
}

/** Instrumented lines, trimmed, for readable assertions. */
function codeLines(source: string): string[] {
  return run(source).code.split('\n').map((line) => line.trim());
}

describe('instrument', () => {
  it('probes a straight-line procedure once', () => {
    const result = run(
      ['Procedure Foo', '    Send A', '    Send B', 'End_Procedure'].join('\n')
    );
    expect(result.probes).toHaveLength(1);
    expect(result.probes[0]!.kind).toBe('entry');
    expect(result.probes[0]!.method).toBe('Foo');
    expect(result.code).toContain('Send DfCovHit 0');
  });

  it('puts the entry probe after local declarations', () => {
    // DataFlex requires declarations before any executable statement; a probe above them would
    // not compile.
    const lines = codeLines(
      [
        'Procedure Foo',
        '    String sName',
        '    Integer iCount',
        '    Send A',
        'End_Procedure'
      ].join('\n')
    );
    expect(lines).toEqual([
      'Procedure Foo',
      'String sName',
      'Integer iCount',
      'Send DfCovHit 0',
      'Send A',
      'End_Procedure'
    ]);
  });

  it('probes each branch separately', () => {
    const result = run(
      [
        'Procedure Foo',
        '    Send Before',
        '    If (x) Begin',
        '        Send Inside',
        '    End',
        '    Send After',
        'End_Procedure'
      ].join('\n')
    );
    // Entry, the branch body, and the join after it.
    expect(result.probes.length).toBeGreaterThanOrEqual(3);
    const probedLines = result.probes.map((p) => p.line).sort((a, b) => a - b);
    // Lines are the *original* ones: Send Before (1), Send Inside (3), Send After (5).
    expect(probedLines).toEqual([1, 3, 5]);
  });

  it('records original line numbers even though the copy has shifted', () => {
    const source = [
      'Procedure Foo',
      '    Send A',
      '    If (x) Begin',
      '        Send B',
      '    End',
      'End_Procedure'
    ].join('\n');
    const result = instrument(source, parseSource(source), { file: 'f.pkg' });

    // `Send B` is on line 3 of the original; in the output it has moved down.
    const probeForB = result.probes.find((p) => p.line === 3);
    expect(probeForB).toBeDefined();
    expect(result.code.split('\n')[3]!.trim()).not.toBe('Send B');
  });

  it('preserves indentation', () => {
    const result = run(
      ['Procedure Foo', '        Send Deep', 'End_Procedure'].join('\n')
    );
    expect(result.code.split('\n')[1]).toBe('        Send DfCovHit 0');
  });

  it('skips a single-line conditional rather than mis-probing it', () => {
    // A probe before `If (x) Send Foo` would run whether or not the branch is taken, reporting
    // the branch as covered when it was not.
    const result = run(
      ['Procedure Foo', '    If (bDone) Send Away', '    Send After', 'End_Procedure'].join('\n')
    );
    expect(result.skipped).toEqual([
      { line: 1, reason: 'inside a single-line conditional' }
    ]);
    expect(result.code).not.toContain('If (bDone) Send DfCovHit');
  });

  it('leaves macro bodies untouched', () => {
    const source = [
      '#COMMAND MyThing R',
      '    Send Something !1',
      '#ENDCOMMAND',
      'Procedure Foo',
      '    Send A',
      'End_Procedure'
    ].join('\n');
    const result = instrument(source, parseSource(source), { file: 'f.pkg' });

    expect(result.code.split('\n')[1]).toBe('    Send Something !1');
    expect(result.probes).toHaveLength(1);
  });

  it('probes each arm of a case block', () => {
    const result = run(
      [
        'Function F Returns String',
        '    Case Begin',
        '        Case (x=1)',
        '            Send A',
        '            Case Break',
        '        Case (x=2)',
        '            Send B',
        '            Case Break',
        '    Case End',
        'End_Function'
      ].join('\n')
    );
    const probedLines = result.probes.map((p) => p.line).sort((a, b) => a - b);
    expect(probedLines).toContain(3);
    expect(probedLines).toContain(6);
  });

  it('probes a loop body separately from the code after it', () => {
    const result = run(
      [
        'Procedure Foo',
        '    For i from 1 to 10',
        '        Send Inside',
        '    Loop',
        '    Send After',
        'End_Procedure'
      ].join('\n')
    );
    const probedLines = result.probes.map((p) => p.line).sort((a, b) => a - b);
    expect(probedLines).toContain(2);
    expect(probedLines).toContain(4);
  });

  it('does not probe unreachable code', () => {
    // Nothing can run it, so a probe there would only ever report a miss.
    const result = run(
      ['Procedure Foo', '    Procedure_Return', '    Send NeverRuns', 'End_Procedure'].join('\n')
    );
    expect(result.probes.map((p) => p.line)).not.toContain(2);
  });

  it('continues ids across files so they stay unique in a workspace', () => {
    const source = ['Procedure Foo', '    Send A', 'End_Procedure'].join('\n');
    const second = instrument(source, parseSource(source), { file: 'b.pkg', firstId: 40 });
    expect(second.probes[0]!.id).toBe(40);
    expect(second.code).toContain('Send DfCovHit 40');
  });

  it('accepts a custom probe form', () => {
    const result = instrument(
      ['Procedure Foo', '    Send A', 'End_Procedure'].join('\n'),
      parseSource('Procedure Foo\n    Send A\nEnd_Procedure'),
      { file: 'f.pkg', emit: (id) => `DfCovHit ${id}` }
    );
    expect(result.code).toContain('DfCovHit 0');
  });

  it('leaves a file with no procedures unchanged', () => {
    const source = ['Use cWebView.pkg', 'Object oX is a cWebView', 'End_Object'].join('\n');
    const result = instrument(source, parseSource(source), { file: 'f.pkg' });
    expect(result.code).toBe(source);
    expect(result.probes).toEqual([]);
  });

  it('does not throw on an unterminated procedure', () => {
    expect(() => run('Procedure Foo\n    Send A\n')).not.toThrow();
  });
});
