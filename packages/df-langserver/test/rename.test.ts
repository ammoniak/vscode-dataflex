import { describe, expect, it } from 'vitest';
import { parseSource } from '@vscode-dataflex/parser';
import { SymbolIndex } from '@vscode-dataflex/workspace';
import { prepareRename, rename, renameTarget } from '../src/providers/rename';

/**
 * Rename.
 *
 * DataFlex has one flat namespace, no imports, and names that repeat heavily -- `Refresh` is
 * declared 23 times on a real search path. A rename that edited every occurrence of a common name
 * would corrupt unrelated code across a thousand files, and the edit lands before anyone can read
 * it. So most of these tests are about what rename *refuses* to do.
 */

const ROOT = 'C:\\ws';
const OWN = 'C:\\ws\\AppSrc\\App.pkg';
const CALLER = 'C:\\ws\\AppSrc\\Caller.pkg';
const LIBRARY = 'C:\\DataFlex\\Pkg\\Base.pkg';

const SOURCE = [
  'Class cThing is a cObject',
  '    Procedure DoIt String sName',
  '        String sLocal',
  '        Move sName to sLocal',
  '        Showln sLocal',
  '    End_Procedure',
  '',
  '    Procedure Other',
  '        String sLocal',
  '        Showln sLocal',
  '    End_Procedure',
  'End_Class',
  ''
].join('\n');

const LIB_SOURCE = ['Class cBase is a cObject', '    Procedure Refresh', '    End_Procedure', 'End_Class', ''].join('\n');
const CALLER_SOURCE = ['Procedure P', '    Send DoIt "x"', 'End_Procedure', ''].join('\n');

const SOURCES: Record<string, string> = {
  [OWN]: SOURCE,
  [CALLER]: CALLER_SOURCE,
  [LIBRARY]: LIB_SOURCE
};

const unit = parseSource(SOURCE, { uri: OWN });
const LINES = SOURCE.split('\n');

function index(): SymbolIndex {
  const symbols = new SymbolIndex();
  for (const [file, text] of Object.entries(SOURCES)) {
    symbols.indexFile(file, text);
  }
  return symbols;
}

/** The word at the first occurrence of `needle` on the line containing `marker`. */
function wordFor(marker: string, needle: string) {
  const line = LINES.findIndex((text) => text.includes(marker));
  const character = LINES[line]!.indexOf(needle, LINES[line]!.indexOf(marker.trim()));
  return {
    text: needle,
    range: {
      start: { line, character },
      end: { line, character: character + needle.length }
    }
  };
}

const opts = { root: ROOT, currentFile: OWN, readFile: (f: string) => SOURCES[f] };

describe('what a rename means here', () => {
  it('treats a local as scoped to its own method', () => {
    const target = renameTarget(unit, wordFor('Move sName to sLocal', 'sLocal'), index(), { root: ROOT });
    expect('scope' in target && target.scope).toBe('local');
  });

  it('treats a parameter as a local too', () => {
    const target = renameTarget(unit, wordFor('Move sName to sLocal', 'sName'), index(), { root: ROOT });
    expect('scope' in target && target.scope).toBe('local');
  });

  it('treats a name the workspace declares as workspace-wide', () => {
    const target = renameTarget(unit, wordFor('Procedure DoIt', 'DoIt'), index(), { root: ROOT });
    expect('scope' in target && target.scope).toBe('workspace');
  });
});

describe('renaming a local', () => {
  it('edits only the method that declares it', () => {
    const result = rename(unit, wordFor('Move sName to sLocal', 'sLocal'), 'sRenamed', index(), opts);
    const edits = ('changes' in result ? Object.values(result.changes!)[0] : []) ?? [];
    // Declaration plus two uses in DoIt; the `sLocal` in Other is a different variable.
    expect(edits).toHaveLength(3);
    for (const edit of edits) {
      expect(edit.range.start.line).toBeLessThan(6);
    }
  });

  /**
   * `sLocal` is declared separately in both methods. Renaming one must not touch the other, which
   * is exactly what a workspace-wide occurrence search would have done.
   */
  it('leaves an unrelated local of the same name alone', () => {
    const result = rename(unit, wordFor('Move sName to sLocal', 'sLocal'), 'sRenamed', index(), opts);
    const edits = ('changes' in result ? Object.values(result.changes!)[0] : []) ?? [];
    const otherMethod = LINES.findIndex((t) => t.includes('Procedure Other'));
    expect(edits.every((e) => e.range.start.line < otherMethod)).toBe(true);
  });

  it('renames the parameter and its uses', () => {
    const result = rename(unit, wordFor('Move sName to sLocal', 'sName'), 'sInput', index(), opts);
    const edits = ('changes' in result ? Object.values(result.changes!)[0] : []) ?? [];
    expect(edits).toHaveLength(2);
  });
});

describe('renaming a workspace symbol', () => {
  it('edits every file that mentions it', () => {
    const result = rename(unit, wordFor('Procedure DoIt', 'DoIt'), 'DoItBetter', index(), opts);
    const files = 'changes' in result ? Object.keys(result.changes!) : [];
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.toLowerCase().includes('caller.pkg'))).toBe(true);
  });
});

describe('what rename refuses', () => {
  /** The declaration is read-only, so renaming here would change the calls and not the definition. */
  it('refuses a symbol the library declares', () => {
    const source = 'Procedure P\n    Send Refresh\nEnd_Procedure\n';
    const callUnit = parseSource(source, { uri: OWN });
    const word = {
      text: 'Refresh',
      range: { start: { line: 1, character: 9 }, end: { line: 1, character: 16 } }
    };
    const result = renameTarget(callUnit, word, index(), { root: ROOT });
    expect('reason' in result).toBe(true);
    expect('reason' in result && result.reason).toContain('does not own');
  });

  it('refuses a name nothing declares', () => {
    const source = 'Procedure P\n    Send Unknown\nEnd_Procedure\n';
    const callUnit = parseSource(source, { uri: OWN });
    const word = {
      text: 'Unknown',
      range: { start: { line: 1, character: 9 }, end: { line: 1, character: 16 } }
    };
    expect('reason' in renameTarget(callUnit, word, index(), { root: ROOT })).toBe(true);
  });

  it('refuses a new name DataFlex would not accept', () => {
    for (const bad of ['has space', '1leading', 'quote"', '']) {
      const result = rename(unit, wordFor('Move sName to sLocal', 'sLocal'), bad, index(), opts);
      expect('reason' in result).toBe(true);
    }
  });

  it('accepts the names DataFlex does allow', () => {
    for (const good of ['sOther', '_leading', 'with$dollar', 'trailing#']) {
      const result = rename(unit, wordFor('Move sName to sLocal', 'sLocal'), good, index(), opts);
      expect('changes' in result).toBe(true);
    }
  });

  it('refuses while the index is still building', () => {
    const word = wordFor('Procedure DoIt', 'DoIt');
    expect('reason' in renameTarget(unit, word, undefined, { root: ROOT })).toBe(true);
  });
});

describe('prepareRename', () => {
  it('offers the word under the cursor', () => {
    const result = prepareRename(unit, wordFor('Procedure DoIt', 'DoIt'), index(), { root: ROOT });
    expect('placeholder' in result && result.placeholder).toBe('DoIt');
  });

  it('passes the refusal through, so the editor can say why', () => {
    const source = 'Procedure P\n    Send Refresh\nEnd_Procedure\n';
    const callUnit = parseSource(source, { uri: OWN });
    const word = {
      text: 'Refresh',
      range: { start: { line: 1, character: 9 }, end: { line: 1, character: 16 } }
    };
    expect('reason' in prepareRename(callUnit, word, index(), { root: ROOT })).toBe(true);
  });
});

/**
 * A workspace materialises its package dependencies into `DfPkg/` beneath its own root.
 *
 * So "is this file under the workspace root" is the wrong question -- it answered yes for the
 * whole Web UI library, and rename offered to rewrite 2,277 `cWebForm` call sites while leaving
 * the declaration, inside a read-only package, untouched.
 */
describe('dependencies vendored inside the workspace', () => {
  const PACKAGED = 'C:\\ws\\DfPkg\\DataFlex_dev_Web_UI-1.0.52\\AppSrc\\cWebForm.pkg';

  function withPackage(): SymbolIndex {
    const symbols = new SymbolIndex();
    symbols.indexFile(PACKAGED, 'Class cWebForm is a cObject\nEnd_Class\n');
    return symbols;
  }

  const probe = parseSource('Object oX is a cWebForm\nEnd_Object\n', { uri: OWN });
  const word = {
    text: 'cWebForm',
    range: { start: { line: 0, character: 15 }, end: { line: 0, character: 23 } }
  };

  it('refuses a class declared inside a package, despite the path being under the root', () => {
    const result = renameTarget(probe, word, withPackage(), { root: ROOT });
    expect('reason' in result).toBe(true);
  });

  /** `AppSrc/cWebForm.pkg` reads like the user's own file; the package name explains the refusal. */
  it('names the package rather than the last two path segments', () => {
    const result = renameTarget(probe, word, withPackage(), { root: ROOT });
    expect('reason' in result && result.reason).toContain('DataFlex_dev_Web_UI-1.0.52');
    expect('reason' in result && result.reason).not.toContain('AppSrc/cWebForm.pkg');
  });

  it('still allows a class the workspace itself declares', () => {
    const symbols = new SymbolIndex();
    symbols.indexFile(OWN, 'Class cMine is a cObject\nEnd_Class\n');
    const mine = parseSource('Object oX is a cMine\nEnd_Object\n', { uri: OWN });
    const target = renameTarget(
      mine,
      { text: 'cMine', range: { start: { line: 0, character: 15 }, end: { line: 0, character: 20 } } },
      symbols,
      { root: ROOT }
    );
    expect('scope' in target && target.scope).toBe('workspace');
  });
});
