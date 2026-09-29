import { describe, expect, it } from 'vitest';
import { parseSource } from '@vscode-dataflex/parser';
import { SymbolIndex } from '@vscode-dataflex/workspace';
import {
  SEMANTIC_TOKENS_LEGEND,
  SEMANTIC_TOKEN_TYPES,
  encode,
  semanticTokens
} from '../src/providers/semanticTokens';

/**
 * Semantic tokens.
 *
 * The grammar decides by shape and cannot tell a class from a struct from a property, because in
 * DataFlex they are all bare identifiers in one flat namespace. The index can. The rule here is
 * that a wrong token is worse than none -- it makes correct code look like something else -- so
 * anything ambiguous is left to the grammar.
 */

const ROOT = 'C:\\ws';
const OWN = 'C:\\ws\\AppSrc\\App.pkg';
const LIBRARY = 'C:\\DataFlex\\Pkg\\Lib.pkg';

const typeOf = (name: (typeof SEMANTIC_TOKEN_TYPES)[number]): number =>
  SEMANTIC_TOKEN_TYPES.indexOf(name);

/** Decodes the flat protocol array back into readable tuples. */
function decode(data: number[]): { line: number; character: number; length: number; type: number; modifiers: number }[] {
  const out = [];
  let line = 0;
  let character = 0;
  for (let i = 0; i < data.length; i += 5) {
    const deltaLine = data[i]!;
    const deltaCharacter = data[i + 1]!;
    line += deltaLine;
    character = deltaLine === 0 ? character + deltaCharacter : deltaCharacter;
    out.push({ line, character, length: data[i + 2]!, type: data[i + 3]!, modifiers: data[i + 4]! });
  }
  return out;
}

describe('the legend', () => {
  it('lists a type for every name the provider can emit', () => {
    expect(SEMANTIC_TOKENS_LEGEND.tokenTypes).toEqual([...SEMANTIC_TOKEN_TYPES]);
  });

  /** The protocol names it `defaultLibrary`; the internal constant must not leak a typo. */
  it('uses the protocol s modifier names', () => {
    expect(SEMANTIC_TOKENS_LEGEND.tokenModifiers).toEqual(['declaration', 'defaultLibrary']);
  });
});

describe('encoding', () => {
  it('writes each token relative to the one before it', () => {
    const data = encode([
      { line: 0, character: 4, length: 3, type: 1, modifiers: 0 },
      { line: 0, character: 10, length: 5, type: 2, modifiers: 0 },
      { line: 3, character: 2, length: 4, type: 0, modifiers: 1 }
    ]);
    expect(data).toEqual([0, 4, 3, 1, 0, 0, 6, 5, 2, 0, 3, 2, 4, 0, 1]);
  });

  /** Deltas are meaningless out of order, and the walk that produces them is not sorted. */
  it('sorts into document order first', () => {
    const data = encode([
      { line: 5, character: 0, length: 1, type: 0, modifiers: 0 },
      { line: 1, character: 0, length: 1, type: 0, modifiers: 0 }
    ]);
    expect(decode(data).map((t) => t.line)).toEqual([1, 5]);
  });

  it('encodes nothing for no tokens', () => {
    expect(encode([])).toEqual([]);
  });
});

describe('classifying identifiers', () => {
  function index(): SymbolIndex {
    const symbols = new SymbolIndex();
    symbols.indexFile(
      LIBRARY,
      [
        'Class cWebForm is a cObject',
        '    Procedure Refresh',
        '    End_Procedure',
        'End_Class',
        'Struct tRow',
        '    String sName',
        'End_Struct',
        ''
      ].join('\n')
    );
    return symbols;
  }

  function tokensFor(source: string) {
    const unit = parseSource(source, { uri: OWN });
    return decode(semanticTokens(unit, index(), { root: ROOT }));
  }

  it('colours a class as a class', () => {
    const found = tokensFor('Object oX is a cWebForm\nEnd_Object\n');
    const cls = found.find((t) => t.length === 'cWebForm'.length);
    expect(cls?.type).toBe(typeOf('class'));
  });

  it('colours a struct as a struct, which no grammar rule can tell apart', () => {
    const found = tokensFor('Procedure P\n    tRow myRow\nEnd_Procedure\n');
    const struct = found.find((t) => t.length === 'tRow'.length);
    expect(struct?.type).toBe(typeOf('struct'));
  });

  it('colours a procedure as a method', () => {
    const found = tokensFor('Procedure P\n    Send Refresh\nEnd_Procedure\n');
    const method = found.find((t) => t.length === 'Refresh'.length);
    expect(method?.type).toBe(typeOf('method'));
  });

  it('marks a name declared outside the workspace as library code', () => {
    const found = tokensFor('Object oX is a cWebForm\nEnd_Object\n');
    const cls = found.find((t) => t.length === 'cWebForm'.length);
    // Bit 1 is `defaultLibrary`.
    expect((cls!.modifiers & 0b10) !== 0).toBe(true);
  });

  it('says nothing about a name the index does not know', () => {
    expect(tokensFor('Procedure P\n    Send NoSuchName\nEnd_Procedure\n')).toEqual([]);
  });

  /**
   * A name that means two different things cannot be coloured either way without being wrong half
   * the time, and the grammar's shape-based guess is no worse.
   */
  it('says nothing about a name that is both a class and a struct', () => {
    const symbols = new SymbolIndex();
    symbols.indexFile(LIBRARY, 'Class Ambiguous is a cObject\nEnd_Class\n');
    symbols.indexFile('C:\\ws\\Other.pkg', 'Struct Ambiguous\n    String sX\nEnd_Struct\n');

    const unit = parseSource('Procedure P\n    Send Ambiguous\nEnd_Procedure\n', { uri: OWN });
    expect(semanticTokens(unit, symbols, { root: ROOT })).toEqual([]);
  });

  it('leaves a dotted name to the table and struct hovers', () => {
    const unit = parseSource('Procedure P\n    Move "x" to Customer.Name\nEnd_Procedure\n', {
      uri: OWN
    });
    expect(semanticTokens(unit, index(), { root: ROOT })).toEqual([]);
  });

  it('says nothing at all without an index', () => {
    const unit = parseSource('Object oX is a cWebForm\nEnd_Object\n', { uri: OWN });
    expect(semanticTokens(unit, undefined)).toEqual([]);
  });

  it('marks a declaration site with the declaration modifier', () => {
    const symbols = new SymbolIndex();
    const source = 'Struct tLocal\n    String sX\nEnd_Struct\n';
    symbols.indexFile(OWN, source);
    const unit = parseSource(source, { uri: OWN });
    const found = decode(semanticTokens(unit, symbols, { root: ROOT }));
    const declaration = found.find((t) => t.line === 0);
    expect((declaration!.modifiers & 0b01) !== 0).toBe(true);
  });
});
