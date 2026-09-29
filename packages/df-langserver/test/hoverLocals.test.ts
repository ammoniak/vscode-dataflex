import { describe, expect, it } from 'vitest';
import { nodeChainAt, parseSource } from '@vscode-dataflex/parser';
import { findLocal } from '../src/providers/navigation';

/**
 * Local-scope resolution, which is what gives a hover to the things you point at most.
 *
 * `variable` and `field` are deliberately absent from the index, so before this the hover returned
 * nothing at all for a parameter or a local.
 */

const NL = '\n';

/** Resolves `name` as it would be seen from the given line. */
function at(source: string, line: number, name: string) {
  const unit = parseSource(source, { uri: 'test.pkg' });
  return findLocal(nodeChainAt(unit.root, line, 8), name);
}

const PROCEDURE = [
  'Procedure PopDialogX String sTitle Integer ByRef iMode', // 0
  '    String sLocal',                                      // 1
  '    Integer iCount',                                     // 2
  '    Move "x" to sLocal',                                 // 3
  'End_Procedure'                                           // 4
].join(NL);

describe('findLocal', () => {
  it('finds a local variable and its type', () => {
    expect(at(PROCEDURE, 3, 'sLocal')).toEqual({
      kind: 'local',
      name: 'sLocal',
      type: 'String',
      container: 'PopDialogX'
    });
  });

  it('finds a parameter, keeping ByRef', () => {
    expect(at(PROCEDURE, 3, 'iMode')).toEqual({
      kind: 'parameter',
      name: 'iMode',
      type: 'Integer',
      byRef: true,
      container: 'PopDialogX'
    });
  });

  it('matches case-insensitively, as DataFlex does', () => {
    expect(at(PROCEDURE, 3, 'SLOCAL')?.name).toBe('sLocal');
  });

  it('finds a struct field', () => {
    const source = [
      'Struct tTopic',
      '    String sCaption',
      '    tTopic[] aSubTopics',
      'End_Struct'
    ].join(NL);
    expect(at(source, 2, 'sCaption')).toEqual({
      kind: 'field',
      name: 'sCaption',
      type: 'String',
      container: 'tTopic'
    });
  });

  it('prefers the innermost scope', () => {
    // A local shadowing a parameter is what the code at that point actually refers to.
    const source = [
      'Procedure Foo String sName',
      '    String sName',
      '    Move "x" to sName',
      'End_Procedure'
    ].join(NL);
    expect(at(source, 2, 'sName')?.kind).toBe('local');
  });

  it('does not reach into a different procedure', () => {
    const source = [
      'Procedure A',
      '    String sHidden',
      'End_Procedure',
      'Procedure B',
      '    Send Something',
      'End_Procedure'
    ].join(NL);
    expect(at(source, 4, 'sHidden')).toBeUndefined();
  });

  it('says nothing for a name that is not local', () => {
    expect(at(PROCEDURE, 3, 'cWebForm')).toBeUndefined();
  });

  it('resolves inside a method of an object', () => {
    const source = [
      'Object oX is a cWebView',
      '    Procedure Foo',
      '        Integer iRow',
      '        Move 1 to iRow',
      '    End_Procedure',
      'End_Object'
    ].join(NL);
    expect(at(source, 3, 'iRow')?.type).toBe('Integer');
  });
});
