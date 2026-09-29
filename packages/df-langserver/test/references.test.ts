import { describe, expect, it } from 'vitest';
import { DocumentHighlightKind } from 'vscode-languageserver';
import { parseSource } from '@vscode-dataflex/parser';
import { SymbolIndex } from '@vscode-dataflex/workspace';
import { documentHighlights, occurrencesIn, references } from '../src/providers/references';

/**
 * Find All References and Document Highlight.
 *
 * The index stores reference counts, not positions -- it exists to answer "is this used anywhere",
 * which the dead-code rule asks thousands of times. Positions are found on demand, filtered by the
 * same per-file tally so only files containing the word are re-read.
 *
 * Matching is by token. That is the whole point: a text search would find `sName` inside
 * `sNameAdditional` and inside comments, and the reference list would then disagree with the
 * "Uses" count the hover shows.
 */

const SRC = [
  'Procedure DoIt',
  '    String sName',
  '    String sNameAdditional',
  '    Move "x" to sName',
  '    Move sName to sNameAdditional',
  '    // sName in a comment',
  '    Move "sName in a literal" to sNameAdditional',
  'End_Procedure',
  ''
].join('\n');

const FILE = 'C:\\ws\\x.pkg';
const unit = parseSource(SRC, { uri: FILE });

describe('occurrencesIn', () => {
  it('finds every use of a name', () => {
    // Declaration, then three uses on lines 3, 4 and (not) 6.
    const found = occurrencesIn(unit, 'sName');
    expect(found.map((r) => r.start.line)).toEqual([1, 3, 4]);
  });

  it('does not match a longer identifier that contains the name', () => {
    const found = occurrencesIn(unit, 'sName');
    for (const range of found) {
      expect(range.end.character - range.start.character).toBe('sName'.length);
    }
  });

  it('ignores comments and string literals', () => {
    // Lines 5 and 6 mention `sName` in a comment and a literal; neither is a reference.
    const lines = occurrencesIn(unit, 'sName').map((r) => r.start.line);
    expect(lines).not.toContain(5);
    expect(lines).not.toContain(6);
  });

  it('matches however the name is cased', () => {
    expect(occurrencesIn(unit, 'SNAME')).toHaveLength(3);
  });

  it('finds nothing for a name that does not occur', () => {
    expect(occurrencesIn(unit, 'sNowhere')).toEqual([]);
  });

  /**
   * `Customer.Name` references the table and the field. The index counts it as both -- it splits
   * dotted tokens when tallying -- so the search has to agree, or the list would contradict the
   * count the hover prints.
   */
  it('reports each segment of a dotted name separately', () => {
    const dotted = parseSource('Procedure P\n    Move "x" to Customer.Name\nEnd_Procedure\n', {
      uri: FILE
    });

    const table = occurrencesIn(dotted, 'Customer');
    expect(table).toHaveLength(1);
    expect(table[0]!.end.character - table[0]!.start.character).toBe('Customer'.length);

    const field = occurrencesIn(dotted, 'Name');
    expect(field).toHaveLength(1);
    // The field starts after `Customer.`, so the highlight covers `Name` alone.
    expect(field[0]!.start.character).toBe(table[0]!.start.character + 'Customer.'.length);
  });
});

describe('documentHighlights', () => {
  it('marks the declaration as a write and the uses as reads', () => {
    const declaration = { start: { line: 1, character: 11 }, end: { line: 1, character: 16 } };
    const highlights = documentHighlights(unit, 'sName', [declaration]);

    expect(highlights).toHaveLength(3);
    expect(highlights[0]!.kind).toBe(DocumentHighlightKind.Write);
    expect(highlights[1]!.kind).toBe(DocumentHighlightKind.Read);
    expect(highlights[2]!.kind).toBe(DocumentHighlightKind.Read);
  });

  it('marks everything as a read when no declaration is in this file', () => {
    for (const highlight of documentHighlights(unit, 'sName')) {
      expect(highlight.kind).toBe(DocumentHighlightKind.Read);
    }
  });
});

describe('references across the workspace', () => {
  const DECLARING = 'C:\\ws\\lib\\Helper.pkg';
  const USING = 'C:\\ws\\app\\View.wo';
  const UNRELATED = 'C:\\ws\\app\\Other.wo';

  const SOURCES: Record<string, string> = {
    [DECLARING]: ['Class cHelper is a cObject', '    Procedure Refresh', '    End_Procedure', 'End_Class', ''].join('\n'),
    [USING]: ['Procedure Use1', '    Send Refresh', '    Send Refresh', 'End_Procedure', ''].join('\n'),
    [UNRELATED]: ['Procedure Nothing', 'End_Procedure', ''].join('\n')
  };

  /** Reads from the fixture above rather than the disk; records what was opened. */
  function reader(opened: string[]): (file: string) => string | undefined {
    return (file) => {
      opened.push(file);
      return SOURCES[file];
    };
  }

  function workspace(): SymbolIndex {
    const index = new SymbolIndex();
    for (const [file, text] of Object.entries(SOURCES)) {
      index.indexFile(file, text);
    }
    return index;
  }

  it('finds uses in every file that has them', () => {
    const found = references(workspace(), 'Refresh', { includeDeclaration: true, readFile: reader([]) });
    const byFile = new Map<string, number>();
    for (const location of found) {
      byFile.set(location.uri, (byFile.get(location.uri) ?? 0) + 1);
    }
    expect([...byFile.values()].reduce((a, b) => a + b, 0)).toBe(3);
    expect([...byFile.keys()].some((u) => u.toLowerCase().includes('helper.pkg'))).toBe(true);
    expect([...byFile.keys()].some((u) => u.toLowerCase().includes('view.wo'))).toBe(true);
  });

  it('leaves out the declaration when asked to', () => {
    const withIt = references(workspace(), 'Refresh', { includeDeclaration: true, readFile: reader([]) });
    const without = references(workspace(), 'Refresh', { includeDeclaration: false, readFile: reader([]) });
    expect(without).toHaveLength(withIt.length - 1);
  });

  it('does not open files that cannot contain the name', () => {
    // The unrelated file has no `Refresh` token, so the per-file tally excludes it and the search
    // never opens it. This is what keeps the feature affordable on a thousand-file workspace.
    const opened: string[] = [];
    references(workspace(), 'Refresh', { includeDeclaration: true, readFile: reader(opened) });
    expect(opened).toHaveLength(2);
    expect(opened).not.toContain(UNRELATED);
  });

  it('names files the way they were indexed, not lower-cased', () => {
    // A lower-cased URI makes the editor open a second tab for the same file.
    const found = references(workspace(), 'Refresh', { includeDeclaration: true, readFile: reader([]) });
    expect(found.some((l) => l.uri.includes('Helper.pkg'))).toBe(true);
  });

  it('agrees with the count the hover shows', () => {
    const index = workspace();
    const found = references(index, 'Refresh', {
      includeDeclaration: true,
      readFile: reader([])
    });
    expect(found).toHaveLength(index.referenceCount('Refresh'));
  });

  it('answers nothing without an index, or for an empty name', () => {
    expect(references(undefined, 'Refresh', { includeDeclaration: true })).toEqual([]);
    expect(references(workspace(), '', { includeDeclaration: true })).toEqual([]);
  });

  /**
   * A file open with unsaved changes must be searched as it appears on screen. Reading from disk
   * instead would omit the reference the user just typed, which is worse than being slow.
   */
  it('searches the caller s text rather than the disk', () => {
    const edited = ['Procedure Use1', '    Send Refresh', '    Send Refresh', '    Send Refresh', 'End_Procedure', ''].join('\n');
    const found = references(workspace(), 'Refresh', {
      includeDeclaration: true,
      readFile: (file) => (file === USING ? edited : SOURCES[file])
    });
    // Three in the edited buffer plus the declaration.
    expect(found).toHaveLength(4);
  });

  it('skips a file it cannot read rather than losing the rest', () => {
    const found = references(workspace(), 'Refresh', {
      includeDeclaration: true,
      readFile: (file) => (file === USING ? undefined : SOURCES[file])
    });
    expect(found).toHaveLength(1);
  });
});

/**
 * A cap on how many files the search opens truncated the result silently.
 *
 * `psCaption` occurs in 499 files of a real workspace; a 400-file limit reported 4,731 of its
 * 5,208 uses and looked exactly like a complete answer. A reference list that quietly omits a
 * fifth of the answers is worse than a slow one.
 */
describe('references does not truncate', () => {
  const FILE_COUNT = 600;

  const sources: Record<string, string> = {};
  for (let i = 0; i < FILE_COUNT; i++) {
    sources[`C:\\ws\\f${i}.pkg`] = ['Procedure P', '    Send Widespread', 'End_Procedure', ''].join('\n');
  }

  it('finds every use however many files hold them', () => {
    const index = new SymbolIndex();
    for (const [file, text] of Object.entries(sources)) {
      index.indexFile(file, text);
    }
    const found = references(index, 'Widespread', {
      includeDeclaration: true,
      readFile: (file) => sources[file]
    });
    expect(found).toHaveLength(FILE_COUNT);
    expect(found).toHaveLength(index.referenceCount('Widespread'));
  });
});
