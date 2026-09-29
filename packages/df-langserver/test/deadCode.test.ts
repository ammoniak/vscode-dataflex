import { describe, expect, it } from 'vitest';
import { DiagnosticSeverity } from 'vscode-languageserver';
import { SymbolIndex } from '@vscode-dataflex/workspace';
import { deadMethodDiagnostics, findDeadMethods } from '../src/analysis/deadCode';

/**
 * The `dead-procedure` rule.
 *
 * This is the rule most able to be wrong about working code, because DataFlex dispatches
 * dynamically: a method reached only through `Send (RefProc(...))` or a name assembled at runtime
 * has no visible caller. Every one of the "spared" reasons below exists because reporting that
 * case was wrong on real code, so each is tested as its own guarantee rather than as an
 * implementation detail.
 */

const ROOT = 'C:\\ws';
const OWN = 'C:\\ws\\AppSrc\\App.pkg';
const LIBRARY = 'C:\\DataFlex\\Pkg\\Base.pkg';

function indexOf(...files: [string, string][]): SymbolIndex {
  const index = new SymbolIndex();
  for (const [file, text] of files) {
    index.indexFile(file, text);
  }
  return index;
}

/** Names the rule reports as dead. */
function dead(index: SymbolIndex): string[] {
  return findDeadMethods(index, ROOT).dead.map((entry) => entry.declaration.name);
}

describe('what the rule reports', () => {
  it('reports a method nothing calls', () => {
    const index = indexOf([
      OWN,
      ['Class cThing is a cObject', '    Procedure NeverCalled', '    End_Procedure', 'End_Class', ''].join('\n')
    ]);
    expect(dead(index)).toContain('NeverCalled');
  });

  it('says nothing about a method something calls', () => {
    const index = indexOf(
      [OWN, ['Class cThing is a cObject', '    Procedure Used', '    End_Procedure', 'End_Class', ''].join('\n')],
      ['C:\\ws\\AppSrc\\Caller.pkg', ['Procedure P', '    Send Used', 'End_Procedure', ''].join('\n')]
    );
    expect(dead(index)).not.toContain('Used');
  });

  /** The workspace's own code only. Reporting the runtime library would be thousands of findings. */
  it('says nothing about library code', () => {
    const index = indexOf([
      LIBRARY,
      ['Class cBase is a cObject', '    Procedure LibraryOnly', '    End_Procedure', 'End_Class', ''].join('\n')
    ]);
    expect(dead(index)).not.toContain('LibraryOnly');
  });
});

describe('what the rule spares, and why', () => {
  /**
   * An override is a hook: the framework calls it, and nothing in the workspace names it. This is
   * the single biggest reason, sparing ~19,000 methods on a real workspace.
   */
  it('spares an override of an ancestor member', () => {
    const index = indexOf(
      [LIBRARY, ['Class cBase is a cObject', '    Procedure OnClick', '    End_Procedure', 'End_Class', ''].join('\n')],
      [OWN, ['Class cMine is a cBase', '    Procedure OnClick', '    End_Procedure', 'End_Class', ''].join('\n')]
    );
    expect(dead(index)).not.toContain('OnClick');
  });

  /** `{ Published=True }` exposes a method to a DFUnit test or the web client. */
  it('spares a published method', () => {
    const index = indexOf([
      OWN,
      [
        'Class cThing is a cObject',
        '    { Published=True }',
        '    Procedure PublishedOne',
        '    End_Procedure',
        'End_Class',
        ''
      ].join('\n')
    ]);
    expect(dead(index)).not.toContain('PublishedOne');
  });

  /**
   * DataFlex builds message names at runtime. A name appearing in any string literal anywhere may
   * be dispatched through it, and guessing otherwise reports working code.
   */
  it('spares a method whose name appears in a string literal', () => {
    const index = indexOf(
      [OWN, ['Class cThing is a cObject', '    Procedure Dynamic', '    End_Procedure', 'End_Class', ''].join('\n')],
      ['C:\\ws\\AppSrc\\Other.pkg', ['Procedure P', '    Send DoIt "Dynamic"', 'End_Procedure', ''].join('\n')]
    );
    expect(dead(index)).not.toContain('Dynamic');
  });

  it('counts why each method was spared', () => {
    const index = indexOf(
      [LIBRARY, ['Class cBase is a cObject', '    Procedure OnClick', '    End_Procedure', 'End_Class', ''].join('\n')],
      [OWN, ['Class cMine is a cBase', '    Procedure OnClick', '    End_Procedure', 'End_Class', ''].join('\n')]
    );
    const result = findDeadMethods(index, ROOT);
    expect(result.sparedBy.override).toBeGreaterThan(0);
    expect(result.candidates).toBeGreaterThan(0);
  });
});

describe('diagnostics', () => {
  it('reports one per method, in the file that declares it', () => {
    const index = indexOf([
      OWN,
      ['Class cThing is a cObject', '    Procedure NeverCalled', '    End_Procedure', 'End_Class', ''].join('\n')
    ]);
    const byFile = deadMethodDiagnostics(
      findDeadMethods(index, ROOT),
      DiagnosticSeverity.Warning,
      (file) => `file:///${file.split('\\').join('/')}`
    );
    const entries = [...byFile.entries()];
    expect(entries).toHaveLength(1);
    expect(entries[0]![0].toLowerCase()).toContain('app.pkg');
    expect(entries[0]![1]).toHaveLength(1);
    expect(entries[0]![1][0]!.code).toBe('dead-procedure');
    expect(entries[0]![1][0]!.severity).toBe(DiagnosticSeverity.Warning);
  });

  it('produces nothing when nothing is dead', () => {
    const empty = { dead: [], sparedBy: { override: 0, published: 0, referenced: 0, dynamic: 0, framework: 0, 'entry-point': 0 }, candidates: 0 };
    expect(deadMethodDiagnostics(empty, DiagnosticSeverity.Warning, (f) => f).size).toBe(0);
  });
});
