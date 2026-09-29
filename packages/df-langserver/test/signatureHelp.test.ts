import { describe, expect, it } from 'vitest';
import { parseSource } from '@vscode-dataflex/parser';
import { SymbolIndex } from '@vscode-dataflex/workspace';
import { activeParameterAt, signatureHelp } from '../src/providers/signatureHelp';

/**
 * Signature help.
 *
 * DataFlex passes arguments positionally with no punctuation -- `Send DoIt a b c` -- so nothing on
 * the line says what the third argument is for. That absence is also why `argument-count` finds
 * real bugs; this is the same knowledge offered before the mistake rather than after it.
 */

const LIB = 'C:\\ws\\lib.pkg';
const LIBRARY = [
  'Class cThing is a cObject',
  '    Procedure Configure String sName Integer iCount Boolean bFlag',
  '    End_Procedure',
  '    Function Total Integer iA Integer iB Returns Integer',
  '    End_Function',
  '    Procedure NoArgs',
  '    End_Procedure',
  '    Procedure Set psCaption String sValue',
  '    End_Procedure',
  'End_Class',
  ''
].join('\n');

function indexed(): SymbolIndex {
  const index = new SymbolIndex();
  index.indexFile(LIB, LIBRARY);
  return index;
}

/** Signature help at the cursor marked by `|` in the source. */
function helpAt(source: string) {
  const marker = source.indexOf('|');
  const text = source.replace('|', '');
  const before = text.slice(0, marker);
  const line = before.split('\n').length - 1;
  const character = marker - (before.lastIndexOf('\n') + 1);
  const unit = parseSource(text, { uri: 'C:\\ws\\call.pkg' });
  return signatureHelp(unit, { line, character }, indexed());
}

describe('signatureHelp', () => {
  it('describes the procedure being sent', () => {
    const help = helpAt('Procedure P\n    Send Configure |\nEnd_Procedure\n');
    expect(help?.signatures[0]?.label).toBe('Send Configure sName iCount bFlag');
  });

  it('names each parameter with its type', () => {
    const help = helpAt('Procedure P\n    Send Configure |\nEnd_Procedure\n');
    const parameters = help?.signatures[0]?.parameters ?? [];
    expect(parameters.map((p) => p.label)).toEqual(['sName', 'iCount', 'bFlag']);
    expect(parameters[1]?.documentation).toBe('Integer');
  });

  it('starts on the first parameter', () => {
    expect(helpAt('Procedure P\n    Send Configure |\nEnd_Procedure\n')?.activeParameter).toBe(0);
  });

  it('advances as arguments are typed', () => {
    expect(helpAt('Procedure P\n    Send Configure "a" |\nEnd_Procedure\n')?.activeParameter).toBe(1);
    expect(helpAt('Procedure P\n    Send Configure "a" 2 |\nEnd_Procedure\n')?.activeParameter).toBe(2);
  });

  it('describes a function, including where the result goes', () => {
    const help = helpAt('Procedure P\n    Get Total |\nEnd_Procedure\n');
    expect(help?.signatures[0]?.label).toContain('Get Total iA iB to');
  });

  /**
   * `to` means the receiver after `Send` and the destination after `Get`. Reading it the wrong way
   * once made a generated OLE wrapper look like thousands of defects, so the count is taken from
   * the same parser the arity rule uses.
   */
  it('does not count the destination of a Get as an argument', () => {
    const help = helpAt('Procedure P\n    Get Total 1 2 to| iResult\nEnd_Procedure\n');
    expect(help?.activeParameter).toBe(2);
  });

  it('says nothing for a message that takes no arguments', () => {
    expect(helpAt('Procedure P\n    Send NoArgs |\nEnd_Procedure\n')).toBeUndefined();
  });

  it('says nothing for a name the workspace does not declare', () => {
    expect(helpAt('Procedure P\n    Send NoSuchThing |\nEnd_Procedure\n')).toBeUndefined();
  });

  it('says nothing on a line that is not a call', () => {
    expect(helpAt('Procedure P\n    Showln "x"|\nEnd_Procedure\n')).toBeUndefined();
  });

  it('says nothing without an index', () => {
    const unit = parseSource('Procedure P\n    Send Configure \nEnd_Procedure\n', { uri: LIB });
    expect(signatureHelp(unit, { line: 1, character: 19 }, undefined)).toBeUndefined();
  });

  /** DataFlex has one flat namespace; the same name is declared many times over. */
  it('offers each distinct signature once', () => {
    const index = new SymbolIndex();
    index.indexFile(LIB, LIBRARY);
    index.indexFile(
      'C:\\ws\\other.pkg',
      [
        'Class cOther is a cObject',
        // Same shape as cThing.Configure: one signature, not two.
        '    Procedure Configure String sName Integer iCount Boolean bFlag',
        '    End_Procedure',
        'End_Class',
        ''
      ].join('\n')
    );
    const unit = parseSource('Procedure P\n    Send Configure \nEnd_Procedure\n', {
      uri: 'C:\\ws\\call.pkg'
    });
    const help = signatureHelp(unit, { line: 1, character: 19 }, index);
    expect(help?.signatures).toHaveLength(1);
  });

  it('picks the overload that can still take this argument', () => {
    const index = new SymbolIndex();
    index.indexFile(
      LIB,
      [
        'Class cA is a cObject',
        '    Procedure Ambiguous String sOne',
        '    End_Procedure',
        'End_Class',
        'Class cB is a cObject',
        '    Procedure Ambiguous String sOne String sTwo String sThree',
        '    End_Procedure',
        'End_Class',
        ''
      ].join('\n')
    );
    const source = 'Procedure P\n    Send Ambiguous "a" "b" \nEnd_Procedure\n';
    const unit = parseSource(source, { uri: 'C:\\ws\\call.pkg' });
    const help = signatureHelp(unit, { line: 1, character: 27 }, index);

    expect(help?.activeParameter).toBe(2);
    // The one-parameter overload cannot accept a third argument, so the other is highlighted.
    const active = help!.signatures[help!.activeSignature!]!;
    expect(active.parameters).toHaveLength(3);
  });
});

describe('activeParameterAt', () => {
  const arg = (line: number, endCharacter: number) => ({
    range: { end: { line, character: endCharacter } }
  });

  it('counts only arguments that close before the cursor', () => {
    const args = [arg(0, 10), arg(0, 20), arg(0, 30)];
    expect(activeParameterAt(args, { line: 0, character: 5 })).toBe(0);
    expect(activeParameterAt(args, { line: 0, character: 15 })).toBe(1);
    expect(activeParameterAt(args, { line: 0, character: 25 })).toBe(2);
    expect(activeParameterAt(args, { line: 0, character: 40 })).toBe(3);
  });

  it('counts nothing when there are no arguments yet', () => {
    expect(activeParameterAt([], { line: 0, character: 5 })).toBe(0);
  });
});
