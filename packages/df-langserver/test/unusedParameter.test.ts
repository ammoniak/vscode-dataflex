import { describe, expect, it } from 'vitest';
import { SymbolIndex } from '@vscode-dataflex/workspace';
import { parseSource } from '@vscode-dataflex/parser';
import { analyze } from '../src/analysis/analyze';
import { overridesAncestor } from '../src/analysis/overrides';

/**
 * `unused-parameter` fired 1,629 times on a real 18,500-procedure codebase, almost all of them
 * event overrides where the framework -- not the author -- decides the signature. Excluding
 * overrides and empty stubs takes it to 526, which are hand-written procedures genuinely ignoring
 * an argument.
 */

/** A framework-ish base class plus application code that derives from it. */
const FRAMEWORK = [
  'Class cWebBaseControl is a cObject',
  '    Procedure OnClick String sRowId String sCellValue',
  '    End_Procedure',
  '    Procedure Refresh_Data Integer iMode',
  '    End_Procedure',
  'End_Class'
].join('\n');

function indexed(...sources: [string, string][]): SymbolIndex {
  const index = new SymbolIndex();
  for (const [file, text] of sources) {
    index.indexFile(file, text);
  }
  return index;
}

function findings(source: string, index?: SymbolIndex): string[] {
  const options = {
    settings: { 'unused-parameter': true, 'unused-local': false },
    overridesAncestor:
      index === undefined
        ? undefined
        : (name: string, owner: { ownerClass?: string; ownerIsObject?: boolean }) =>
            overridesAncestor(index, name, owner)
  };
  return analyze(parseSource(source, { uri: 'test.pkg' }), options).map((d) => String(d.message));
}

describe('unused-parameter', () => {
  it('reports a hand-written procedure that ignores an argument', () => {
    // The shape worth reporting: a dialog entry point declaring parameters it never reads.
    const source = [
      'Class cMyDialog is a cWebBaseControl',
      '    Procedure PopupMyDialog Handle hReturnObj String sSetupParameter1',
      '        Send DoSomething',
      '    End_Procedure',
      'End_Class'
    ].join('\n');

    const index = indexed(['C:\\ws\\fw.pkg', FRAMEWORK], ['C:\\ws\\app.pkg', source]);
    const reported = findings(source, index);
    expect(reported).toHaveLength(2);
    expect(reported.join(' ')).toContain('hReturnObj');
    expect(reported.join(' ')).toContain('sSetupParameter1');
  });

  it('does not report an override of a parent class member', () => {
    // The framework decides `OnClick`'s signature, so ignoring its arguments is normal.
    const source = [
      'Class cMyControl is a cWebBaseControl',
      '    Procedure OnClick String sRowId String sCellValue',
      '        Send Refresh',
      '    End_Procedure',
      'End_Class'
    ].join('\n');

    const index = indexed(['C:\\ws\\fw.pkg', FRAMEWORK], ['C:\\ws\\app.pkg', source]);
    expect(findings(source, index)).toEqual([]);
  });

  it('recognises an override by ancestry, not by an On-prefix convention', () => {
    // `Refresh_Data` is a hook with an ordinary name; a naming rule would miss it entirely.
    const source = [
      'Class cMyControl is a cWebBaseControl',
      '    Procedure Refresh_Data Integer iMode',
      '        Send Rebuild',
      '    End_Procedure',
      'End_Class'
    ].join('\n');

    const index = indexed(['C:\\ws\\fw.pkg', FRAMEWORK], ['C:\\ws\\app.pkg', source]);
    expect(findings(source, index)).toEqual([]);
  });

  it('does not report a method that only looks like an event', () => {
    // Named `OnSomething` but overriding nothing -- the author chose this signature.
    const source = [
      'Class cMyControl is a cWebBaseControl',
      '    Procedure OnMyOwnThing Integer iUnused',
      '        Send Work',
      '    End_Procedure',
      'End_Class'
    ].join('\n');

    const index = indexed(['C:\\ws\\fw.pkg', FRAMEWORK], ['C:\\ws\\app.pkg', source]);
    expect(findings(source, index)).toHaveLength(1);
  });

  it('does not report an empty body', () => {
    // A deliberate no-op stub, suppressing inherited behaviour.
    const source = [
      'Class cMyControl is a cObject',
      '    Procedure DoNothing Integer iIgnored',
      '    End_Procedure',
      'End_Class'
    ].join('\n');
    expect(findings(source)).toEqual([]);
  });

  it('falls back to reporting when no index can answer the override question', () => {
    // Before the index is built the honest answer is "cannot tell"; flooding with overrides
    // would be worse than waiting.
    const source = [
      'Class cMyControl is a cWebBaseControl',
      '    Procedure OnClick String sRowId',
      '        Send Refresh',
      '    End_Procedure',
      'End_Class'
    ].join('\n');
    // With no override check the parameter is reported, which is why the server always supplies
    // one once indexing has finished.
    expect(findings(source)).toHaveLength(1);
  });

  it('handles an override declared on an object rather than a class', () => {
    const source = [
      'Object oMyControl is a cWebBaseControl',
      '    Procedure OnClick String sRowId String sCellValue',
      '        Send Refresh',
      '    End_Procedure',
      'End_Object'
    ].join('\n');

    const index = indexed(['C:\\ws\\fw.pkg', FRAMEWORK], ['C:\\ws\\app.pkg', source]);
    expect(findings(source, index)).toEqual([]);
  });
});
