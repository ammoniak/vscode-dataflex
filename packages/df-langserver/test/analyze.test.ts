import { describe, expect, it } from 'vitest';
import { DiagnosticSeverity, DiagnosticTag } from 'vscode-languageserver';
import { parseSource } from '@vscode-dataflex/parser';
import { analyze } from '../src/analysis/analyze';
import { RuleId, RuleSettings } from '../src/analysis/rules';

function findings(source: string, settings?: Partial<RuleSettings>) {
  return analyze(parseSource(source, { uri: 'test.pkg' }), { settings });
}

function codes(source: string, settings?: Partial<RuleSettings>): RuleId[] {
  return findings(source, settings).map((d) => d.code as RuleId);
}

describe('unused-local', () => {
  it('flags a local that is never read', () => {
    const source = ['Procedure Foo', '    String sUnused', 'End_Procedure'].join('\n');
    const found = findings(source);
    expect(found).toHaveLength(1);
    expect(found[0]!.code).toBe('unused-local');
    expect(found[0]!.message).toContain('sUnused');
  });

  it('reports at Hint severity with the Unnecessary tag so it greys out', () => {
    const found = findings(['Procedure Foo', '    String sUnused', 'End_Procedure'].join('\n'));
    expect(found[0]!.severity).toBe(DiagnosticSeverity.Hint);
    expect(found[0]!.tags).toEqual([DiagnosticTag.Unnecessary]);
    expect(found[0]!.source).toBe('dataflex');
  });

  it('does not flag a local that is used', () => {
    const source = [
      'Procedure Foo',
      '    String sName',
      '    Move "x" to sName',
      'End_Procedure'
    ].join('\n');
    expect(codes(source)).toEqual([]);
  });

  it('is case-insensitive, as the language is', () => {
    const source = [
      'Procedure Foo',
      '    String sName',
      '    Move "x" to SNAME',
      'End_Procedure'
    ].join('\n');
    expect(codes(source)).toEqual([]);
  });

  it('counts a struct member access as a use of the variable', () => {
    const source = [
      'Procedure Foo',
      '    tMyStruct myRow',
      '    Move 1 to myRow.iValue',
      'End_Procedure'
    ].join('\n');
    expect(codes(source, { 'unused-local': true })).toEqual([]);
  });

  it('does not count an occurrence inside a comment', () => {
    // Working from tokens rather than raw text is what makes this correct.
    const source = [
      'Procedure Foo',
      '    String sName',
      '    // sName is described here but never used',
      'End_Procedure'
    ].join('\n');
    expect(codes(source)).toEqual(['unused-local']);
  });

  it('does not count an occurrence inside a string literal', () => {
    const source = [
      'Procedure Foo',
      '    String sName',
      '    Send Info_Box "sName"',
      'End_Procedure'
    ].join('\n');
    expect(codes(source)).toEqual(['unused-local']);
  });

  it('scopes each procedure separately', () => {
    const source = [
      'Procedure Foo',
      '    String sShared',
      'End_Procedure',
      'Procedure Bar',
      '    Move "x" to sShared',
      'End_Procedure'
    ].join('\n');
    // Used in Bar, but not in Foo where it is declared.
    expect(codes(source)).toEqual(['unused-local']);
  });

  it('flags each name of a multi-name declaration independently', () => {
    const source = [
      'Procedure Foo',
      '    String sUsed sUnused',
      '    Move "x" to sUsed',
      'End_Procedure'
    ].join('\n');
    const found = findings(source);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain('sUnused');
  });
});

describe('unused-parameter', () => {
  it('is off by default, because overriding an event means unused parameters', () => {
    const source = ['Procedure OnClick Integer iButton', 'End_Procedure'].join('\n');
    expect(codes(source)).toEqual([]);
  });

  it('flags an unused parameter when switched on', () => {
    // Needs a body: an empty one is a deliberate no-op stub and is excluded on purpose.
    const source = [
      'Procedure OnClick Integer iButton',
      '    Send Refresh',
      'End_Procedure'
    ].join('\n');
    const found = findings(source, { 'unused-parameter': true });
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain('iButton');
  });

  it('does not flag an empty override stub', () => {
    // Suppressing inherited behaviour with an empty body is idiomatic, and its parameters are
    // dictated by whatever it overrides.
    const source = ['Procedure OnClick Integer iButton', 'End_Procedure'].join('\n');
    expect(codes(source, { 'unused-parameter': true })).toEqual([]);
  });

  it('does not flag a parameter that is used', () => {
    const source = [
      'Procedure OnClick Integer iButton',
      '    Showln iButton',
      'End_Procedure'
    ].join('\n');
    expect(codes(source, { 'unused-parameter': true })).toEqual([]);
  });
});

describe('unreachable-code', () => {
  it('flags a statement after an unconditional return', () => {
    const source = [
      'Procedure Foo',
      '    Procedure_Return',
      '    Send DoSomething',
      'End_Procedure'
    ].join('\n');
    const found = findings(source);
    expect(found.map((d) => d.code)).toEqual(['unreachable-code']);
    expect(found[0]!.range.start.line).toBe(2);
  });

  it('flags after Function_Return too', () => {
    const source = [
      'Function Foo Returns Integer',
      '    Function_Return 0',
      '    Send DoSomething',
      'End_Function'
    ].join('\n');
    expect(codes(source)).toEqual(['unreachable-code']);
  });

  it('does not flag after a conditional return on the same line', () => {
    // `If (x) Function_Return 0` guards the return; what follows is perfectly reachable.
    const source = [
      'Function Foo Returns Integer',
      '    If (bDone) Function_Return 0',
      '    Send DoSomething',
      '    Function_Return 1',
      'End_Function'
    ].join('\n');
    expect(codes(source)).toEqual([]);
  });

  it('does not flag a return as the last statement', () => {
    const source = ['Procedure Foo', '    Send DoSomething', '    Procedure_Return', 'End_Procedure'].join('\n');
    expect(codes(source)).toEqual([]);
  });

  it('treats a return inside a block as leaving only that block', () => {
    const source = [
      'Procedure Foo',
      '    If (x) Begin',
      '        Procedure_Return',
      '    End',
      '    Send StillReachable',
      'End_Procedure'
    ].join('\n');
    expect(codes(source)).toEqual([]);
  });

  it('does not flag the next arm of a flat Case block', () => {
    // A `Case` arm without `Begin` is a flat sibling, so the arm after one ending in
    // `Function_Return` is the next label -- a fresh entry point, not dead code.
    const source = [
      'Function F Returns String',
      '    Case Begin',
      '        Case (x=1)',
      '            Function_Return "a"',
      '            Case Break',
      '        Case (x=2)',
      '            Function_Return "b"',
      '            Case Break',
      '    Case End',
      'End_Function'
    ].join('\n');
    expect(codes(source)).toEqual([]);
  });

  it('still flags real dead code inside a case arm', () => {
    const source = [
      'Function F Returns String',
      '    Case Begin',
      '        Case (x=1)',
      '            Function_Return "a"',
      '            Send NeverRuns',
      '            Case Break',
      '    Case End',
      'End_Function'
    ].join('\n');
    expect(codes(source)).toEqual(['unreachable-code']);
  });

  it('reports once per block rather than for every dead line', () => {
    const source = [
      'Procedure Foo',
      '    Procedure_Return',
      '    Send A',
      '    Send B',
      '    Send C',
      'End_Procedure'
    ].join('\n');
    expect(codes(source)).toEqual(['unreachable-code']);
  });
});

describe('duplicate-declaration', () => {
  it('flags a name declared twice in one scope', () => {
    const source = [
      'Procedure Foo',
      '    String sName',
      '    Integer sName',
      '    Move "x" to sName',
      'End_Procedure'
    ].join('\n');
    expect(codes(source)).toContain('duplicate-declaration');
  });

  it('allows the same name in different procedures', () => {
    const source = [
      'Procedure Foo',
      '    String sName',
      '    Move "x" to sName',
      'End_Procedure',
      'Procedure Bar',
      '    String sName',
      '    Move "y" to sName',
      'End_Procedure'
    ].join('\n');
    expect(codes(source)).toEqual([]);
  });
});

describe('suppression comments', () => {
  it('honours df-ignore on the same line', () => {
    const source = [
      'Procedure Foo',
      '    String sUnused // df-ignore:unused-local',
      'End_Procedure'
    ].join('\n');
    expect(codes(source)).toEqual([]);
  });

  it('honours df-ignore on the line above', () => {
    const source = [
      'Procedure Foo',
      '    // df-ignore:unused-local',
      '    String sUnused',
      'End_Procedure'
    ].join('\n');
    expect(codes(source)).toEqual([]);
  });

  it('honours a comma-separated list and `all`', () => {
    const withList = [
      'Procedure Foo',
      '    String sUnused // df-ignore: duplicate-declaration, unused-local',
      'End_Procedure'
    ].join('\n');
    expect(codes(withList)).toEqual([]);

    const withAll = ['Procedure Foo', '    String sUnused // df-ignore:all', 'End_Procedure'].join('\n');
    expect(codes(withAll)).toEqual([]);
  });

  it('does not suppress a different rule', () => {
    const source = [
      'Procedure Foo',
      '    String sUnused // df-ignore:unreachable-code',
      'End_Procedure'
    ].join('\n');
    expect(codes(source)).toEqual(['unused-local']);
  });
});

describe('rule settings', () => {
  it('reports nothing when every rule is off', () => {
    const source = [
      'Procedure Foo',
      '    String sUnused',
      '    Procedure_Return',
      '    Send Dead',
      'End_Procedure'
    ].join('\n');
    expect(
      codes(source, {
        'unused-local': false,
        'unreachable-code': false,
        'duplicate-declaration': false,
        'unused-parameter': false
      })
    ).toEqual([]);
  });
});

describe('implicit-global', () => {
  const objectScope = [
    'Object oValidations_DD is a cDataDictionary',
    '    String sBeschraenkung',
    'End_Object'
  ].join('\n');

  it('flags a variable declared in an object body', () => {
    const found = findings(objectScope);
    expect(found).toHaveLength(1);
    expect(found[0]!.code).toBe('implicit-global');
    expect(found[0]!.message).toContain('sBeschraenkung');
    expect(found[0]!.message).toContain("outside any method of 'oValidations_DD'");
  });

  it('reports at Warning severity without the Unnecessary tag', () => {
    // The other rules are hints, which VS Code greys out and keeps out of the Problems panel.
    // This one is a correctness hazard, so it has to be listed and must not be dimmed.
    const found = findings(objectScope);
    expect(found[0]!.severity).toBe(DiagnosticSeverity.Warning);
    expect(found[0]!.tags).toBeUndefined();
  });

  it('lets severityOverrides lower it', () => {
    const found = analyze(parseSource(objectScope, { uri: 'test.pkg' }), {
      severityOverrides: { 'implicit-global': DiagnosticSeverity.Hint }
    });
    expect(found[0]!.severity).toBe(DiagnosticSeverity.Hint);
  });

  it('keeps its warning even when the global severity is lowered', () => {
    // A per-rule built-in default outranks the blanket setting; only an explicit override wins.
    const found = analyze(parseSource(objectScope, { uri: 'test.pkg' }), {
      severity: DiagnosticSeverity.Hint
    });
    expect(found[0]!.severity).toBe(DiagnosticSeverity.Warning);
  });

  it('flags a variable at file scope too', () => {
    const source = ['Use cWebView.pkg', 'Date[] dWochentag'].join('\n');
    const found = findings(source);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain('declared outside any method,');
  });

  it('adds the truncation note for an untyped-length String', () => {
    expect(findings(objectScope)[0]!.message).toContain('80 characters');
  });

  it('does not add the truncation note for other types', () => {
    const source = ['Object oX is a cWebView', '    Integer iCount', 'End_Object'].join('\n');
    expect(findings(source)[0]!.message).not.toContain('80 characters');
  });

  it('does not flag a local inside a method of an object', () => {
    const source = [
      'Object oX is a cWebView',
      '    Procedure Foo',
      '        String sName',
      '        Move "x" to sName',
      '    End_Procedure',
      'End_Object'
    ].join('\n');
    expect(codes(source)).toEqual([]);
  });

  it('does not flag a Property', () => {
    const source = [
      'Object oX is a cWebView',
      '    Property String psThing ""',
      'End_Object'
    ].join('\n');
    expect(codes(source)).toEqual([]);
  });

  it('does not flag a deliberate Global_Variable', () => {
    expect(codes('Global_Variable String gsName 255')).toEqual([]);
  });

  it('does not flag struct fields of either shape', () => {
    // Array-typed fields used to parse as `variable`, which made every one of them look like an
    // implicit global -- 143 false positives across MyApp.
    const source = [
      'Struct tHelpTopic',
      '    String sCaption',
      '    tHelpTopic[] aSubTopics',
      '    String[] sValues',
      'End_Struct'
    ].join('\n');
    expect(codes(source)).toEqual([]);
  });

  it('can be turned off', () => {
    expect(codes(objectScope, { 'implicit-global': false })).toEqual([]);
  });
});

describe('robustness', () => {
  it('does not analyse outside a procedure body', () => {
    // Object-level `Property` and `Set` are not locals.
    const source = [
      'Object oX is a cWebView',
      '    Set psCaption to "x"',
      'End_Object'
    ].join('\n');
    expect(codes(source)).toEqual([]);
  });

  it('survives an unterminated procedure', () => {
    expect(() => findings('Procedure Foo\n    String sUnused\n')).not.toThrow();
  });

  it('returns nothing for an empty file', () => {
    expect(codes('')).toEqual([]);
  });
});
