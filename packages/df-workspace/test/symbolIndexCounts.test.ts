import { describe, expect, it } from 'vitest';
import { SymbolIndex } from '../src/symbolIndex';

/**
 * Re-indexing a file must replace its contribution to the global tallies, not add to it.
 *
 * These counters drive the dead-procedure rule, which compares how often a name is referenced
 * against how often it is declared. If a save inflates the reference count, a procedure nothing
 * calls starts looking reachable -- silently, and more so the longer the session runs.
 */
const SOURCE = [
  'Class cThing is a cObject',
  '    Procedure DoWork',
  '        Send Helper',
  '        Send Helper',
  '    End_Procedure',
  '    Procedure Helper',
  '    End_Procedure',
  'End_Class'
].join('\n');

const FILE = 'C:\\ws\\thing.pkg';

describe('reference tallies', () => {
  it('counts references from an indexed file', () => {
    const index = new SymbolIndex();
    index.indexFile(FILE, SOURCE);

    // Two `Send Helper` calls plus the declaration.
    expect(index.referenceCount('Helper')).toBe(3);
    expect(index.declarationCount('Helper')).toBe(1);
  });

  it('does not inflate the count when the same file is re-indexed', () => {
    const index = new SymbolIndex();
    index.indexFile(FILE, SOURCE);
    const first = index.referenceCount('Helper');

    // Simulates saving the file repeatedly, which is what the language server does.
    for (let i = 0; i < 5; i++) {
      index.indexFile(FILE, SOURCE);
    }

    expect(index.referenceCount('Helper')).toBe(first);
    expect(index.declarationCount('Helper')).toBe(1);
  });

  it('drops a file\'s references when it is removed', () => {
    const index = new SymbolIndex();
    index.indexFile(FILE, SOURCE);
    index.removeFile(FILE);

    expect(index.referenceCount('Helper')).toBe(0);
    expect(index.declarationCount('Helper')).toBe(0);
  });

  it('reflects edits rather than accumulating them', () => {
    const index = new SymbolIndex();
    index.indexFile(FILE, SOURCE);

    // The user deletes both call sites.
    const edited = SOURCE.split('\n').filter((line) => !line.includes('Send Helper')).join('\n');
    index.indexFile(FILE, edited);

    // Only the declaration remains, which is what makes `Helper` look dead.
    expect(index.referenceCount('Helper')).toBe(1);
    expect(index.declarationCount('Helper')).toBe(1);
  });

  it('tracks literal words per file, so removing a file clears them', () => {
    const index = new SymbolIndex();
    index.indexFile(FILE, 'Procedure P\n    Send Info_Box "call Helper somehow"\nEnd_Procedure');
    expect(index.appearsInLiteral('Helper')).toBe(true);

    index.removeFile(FILE);
    expect(index.appearsInLiteral('Helper')).toBe(false);
  });

  it('keeps a literal word contributed by another file', () => {
    const index = new SymbolIndex();
    index.indexFile('C:\\ws\\a.pkg', 'Procedure P\n    Showln "Helper"\nEnd_Procedure');
    index.indexFile('C:\\ws\\b.pkg', 'Procedure Q\n    Showln "Helper"\nEnd_Procedure');

    index.removeFile('C:\\ws\\a.pkg');
    expect(index.appearsInLiteral('Helper')).toBe(true);

    index.removeFile('C:\\ws\\b.pkg');
    expect(index.appearsInLiteral('Helper')).toBe(false);
  });
});
