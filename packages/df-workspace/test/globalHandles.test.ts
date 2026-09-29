import { describe, expect, it } from 'vitest';
import { SymbolIndex } from '../src/symbolIndex';

/**
 * What class a `Global_Variable Handle` actually holds.
 *
 * The declaration says `Handle` and nothing more, so the type is only recoverable from the
 * assignments made to the global -- which are usually in a different file from the declaration.
 * These cover the assignment shapes that occur in real code and, just as importantly, the ones
 * that must *not* produce an answer: naming a class the code never binds would be a guess
 * presented to the reader as a fact.
 */

const DECL = 'C:\\ws\\AppSrc\\WebApp.src';
const IMPL = 'C:\\ws\\Mail\\cAppMailInterface.pkg';
const OTHER = 'C:\\ws\\Mail\\Other.pkg';

const DECLARES = 'Global_Variable Handle ghoMailInterface\n';

/** An index over a declaration file plus any number of assigning files. */
function indexOf(...files: [string, string][]): SymbolIndex {
  const index = new SymbolIndex();
  for (const [file, source] of files) {
    index.indexFile(file, source);
  }
  return index;
}

/** The common case: the global declared in one file, assigned in one other. */
function assignedIn(body: string[]): SymbolIndex {
  return indexOf([DECL, DECLARES], [IMPL, body.join('\n')]);
}

describe('global handle resolution', () => {
  it('reads the class from `Move Self` inside a class', () => {
    const index = assignedIn([
      'Class cAppMailInterface is a cObject',
      '    Procedure Construct_Object',
      '        Move Self to ghoMailInterface',
      '    End_Procedure',
      'End_Class'
    ]);

    const held = index.globalHandleClass('ghoMailInterface');
    expect(held?.className).toBe('cAppMailInterface');
    expect(held?.assignment.text).toBe('Move Self to ghoMailInterface');
    expect(held?.assignment.file).toBe(IMPL);
  });

  it('reads through a parenthesised `Move (Self)`', () => {
    const index = assignedIn([
      'Class cAppMailInterface is a cObject',
      '    Procedure Construct_Object',
      '        Move (Self) to ghoMailInterface',
      '    End_Procedure',
      'End_Class'
    ]);

    expect(index.globalHandleClass('ghoMailInterface')?.className).toBe('cAppMailInterface');
  });

  /**
   * Inside an object, `Self` is the class the object *is a*, not the object's own name.
   *
   * `Object oMail is a cWebForm` makes `Self` a `cWebForm`; reporting `oMail` would name something
   * that is not a class at all.
   */
  it('resolves `Self` inside an object to the class it is a', () => {
    const index = assignedIn([
      'Object oMail is a cWebForm',
      '    Procedure OnLoad',
      '        Move Self to ghoMailInterface',
      '    End_Procedure',
      'End_Object'
    ]);

    expect(index.globalHandleClass('ghoMailInterface')?.className).toBe('cWebForm');
  });

  /**
   * An object named as the source is resolved against the index, not the statement.
   *
   * The object is usually declared in a file that had not been read yet when the assignment was
   * collected, so the name is kept unresolved until the question is actually asked.
   */
  it('resolves an object named in another file', () => {
    const index = indexOf(
      [DECL, DECLARES],
      ['C:\\ws\\Mail\\Objects.pkg', 'Object oMailer is a cMailer\nEnd_Object\n'],
      [IMPL, 'Procedure Bind\n    Move oMailer to ghoMailInterface\nEnd_Procedure\n']
    );

    expect(index.globalHandleClass('ghoMailInterface')?.className).toBe('cMailer');
  });

  it('reads the class out of `Get Create U_cRegistry`, dropping the U_ prefix', () => {
    const index = assignedIn([
      'Procedure Bind',
      '    Get Create U_cRegistry to ghoMailInterface',
      'End_Procedure'
    ]);

    expect(index.globalHandleClass('ghoMailInterface')?.className).toBe('cRegistry');
  });

  /** `Get Create of hoParent U_cX` names the parent first; the class is still the one to report. */
  it('reads the class out of `Get Create of <parent>`', () => {
    const index = assignedIn([
      'Procedure Bind',
      '    Get Create of hoParent U_cCJCommandBar to ghoMailInterface',
      'End_Procedure'
    ]);

    expect(index.globalHandleClass('ghoMailInterface')?.className).toBe('cCJCommandBar');
  });

  it('reads the class out of `Get Create (RefClass(...))`', () => {
    const index = assignedIn([
      'Procedure Bind',
      '    Get Create (RefClass(cIniFile)) to ghoMailInterface',
      'End_Procedure'
    ]);

    expect(index.globalHandleClass('ghoMailInterface')?.className).toBe('cIniFile');
  });
});

describe('global handle resolution declines to guess', () => {
  it('claims nothing for `Move 0`, which is a reset rather than a binding', () => {
    const index = assignedIn(['Procedure Release', '    Move 0 to ghoMailInterface', 'End_Procedure']);

    expect(index.globalHandleClass('ghoMailInterface')).toBeUndefined();
  });

  /**
   * Two classes both binding themselves to one global has no single answer, and picking the first
   * would report whichever file happened to be indexed first.
   */
  it('claims nothing when two assignments disagree', () => {
    const index = indexOf(
      [DECL, DECLARES],
      [IMPL, 'Class cFirst is a cObject\n    Move Self to ghoMailInterface\nEnd_Class\n'],
      [OTHER, 'Class cSecond is a cObject\n    Move Self to ghoMailInterface\nEnd_Class\n']
    );

    expect(index.globalHandleClass('ghoMailInterface')).toBeUndefined();
  });

  it('still answers when two assignments agree', () => {
    const index = indexOf(
      [DECL, DECLARES],
      [IMPL, 'Class cSame is a cObject\n    Move Self to ghoMailInterface\nEnd_Class\n'],
      [OTHER, 'Class cSame is a cObject\n    Move Self to ghoMailInterface\nEnd_Class\n']
    );

    expect(index.globalHandleClass('ghoMailInterface')?.className).toBe('cSame');
  });

  it('claims nothing for a `Get` that is not a Create', () => {
    const index = assignedIn([
      'Procedure Bind',
      '    Get FindMailer to ghoMailInterface',
      'End_Procedure'
    ]);

    expect(index.globalHandleClass('ghoMailInterface')).toBeUndefined();
  });

  it('claims nothing for an object name nothing declares', () => {
    const index = assignedIn([
      'Procedure Bind',
      '    Move oNeverDeclared to ghoMailInterface',
      'End_Procedure'
    ]);

    expect(index.globalHandleClass('ghoMailInterface')).toBeUndefined();
  });
});

describe('resolvedGlobalHandles', () => {
  /**
   * The collector records the destination of every `Move ... to <name>`, because it cannot tell a
   * global from a local at that point. Only names actually declared `Global_Variable` may be
   * reported, or the tally would include every ordinary local in the workspace.
   */
  it('reports only names declared as globals', () => {
    const index = assignedIn([
      'Class cAppMailInterface is a cObject',
      '    Procedure Construct_Object',
      '        Handle hoLocal',
      '        Move Self to ghoMailInterface',
      '        Move Self to hoLocal',
      '    End_Procedure',
      'End_Class'
    ]);

    expect(index.resolvedGlobalHandles()).toEqual([
      { global: 'ghoMailInterface', className: 'cAppMailInterface' }
    ]);
  });

  /** Re-indexing must replace a file's assignments, not add to them or leave the old ones behind. */
  it('drops assignments from a file that no longer makes them', () => {
    const index = assignedIn([
      'Class cAppMailInterface is a cObject',
      '    Move Self to ghoMailInterface',
      'End_Class'
    ]);
    expect(index.globalHandleClass('ghoMailInterface')?.className).toBe('cAppMailInterface');

    index.indexFile(IMPL, 'Class cAppMailInterface is a cObject\nEnd_Class\n');

    expect(index.globalHandleClass('ghoMailInterface')).toBeUndefined();
    expect(index.resolvedGlobalHandles()).toEqual([]);
  });
});
