import { describe, expect, it } from 'vitest';
import { SymbolKind } from 'vscode-languageserver';
import { parseSource } from '@vscode-dataflex/parser';
import { SYMBOL_KINDS, describe as describeNode, documentSymbols, foldingRanges } from '../src/providers/documentSymbols';

/**
 * The outline and the folding ranges.
 *
 * Both are pure functions of the parse tree, and both are the first thing a reader touches in an
 * unfamiliar file -- an outline that omits half a view is worse than none, because it looks
 * complete.
 */

const SRC = [
  'Use cWebView.pkg',
  '',
  'Struct tRow',
  '    String sName',
  '    Integer iCount',
  'End_Struct',
  '',
  'Class cCustomerView is a cWebView',
  '    Procedure Construct_Object',
  '        Forward Send Construct_Object',
  '    End_Procedure',
  '',
  '    Function Total Integer iA Returns Integer',
  '    End_Function',
  'End_Class',
  '',
  'Object oCustomer is a cCustomerView',
  '    Set psCaption to "Customer"',
  '',
  '    Object oInner is a cWebForm',
  '    End_Object',
  'End_Object',
  ''
].join('\n');

const unit = parseSource(SRC, { uri: 'C:\\ws\\x.wo' });

describe('documentSymbols', () => {
  const symbols = documentSymbols(unit);

  it('lists the top-level declarations', () => {
    expect(symbols.map((s) => s.name)).toEqual(['tRow', 'cCustomerView', 'oCustomer']);
  });

  it('nests members inside the class that declares them', () => {
    const cls = symbols.find((s) => s.name === 'cCustomerView');
    expect(cls?.children?.map((c) => c.name)).toEqual(['Construct_Object', 'Total']);
  });

  it('nests an object inside its parent object', () => {
    const object = symbols.find((s) => s.name === 'oCustomer');
    expect(object?.children?.map((c) => c.name)).toContain('oInner');
  });

  it('nests struct members', () => {
    const struct = symbols.find((s) => s.name === 'tRow');
    expect(struct?.children?.map((c) => c.name)).toEqual(['sName', 'iCount']);
  });

  it('gives each declaration a symbol kind the editor understands', () => {
    expect(symbols.find((s) => s.name === 'cCustomerView')?.kind).toBe(SymbolKind.Class);
    expect(symbols.find((s) => s.name === 'tRow')?.kind).toBe(SymbolKind.Struct);
    const cls = symbols.find((s) => s.name === 'cCustomerView');
    expect(cls?.children?.find((c) => c.name === 'Total')?.kind).toBe(SymbolKind.Function);
  });

  /** A range that does not contain its own selection makes the editor jump to the wrong line. */
  it('puts each selection range inside its full range', () => {
    const check = (list: typeof symbols): void => {
      for (const symbol of list) {
        expect(symbol.selectionRange.start.line).toBeGreaterThanOrEqual(symbol.range.start.line);
        expect(symbol.selectionRange.end.line).toBeLessThanOrEqual(symbol.range.end.line);
        if (symbol.children !== undefined) {
          check(symbol.children);
        }
      }
    };
    check(symbols);
  });

  it('answers nothing for an empty file', () => {
    expect(documentSymbols(parseSource('', { uri: 'x' }))).toEqual([]);
  });
});

describe('describe', () => {
  it('summarises a function with its parameters and return type', () => {
    const cls = documentSymbols(unit).find((s) => s.name === 'cCustomerView');
    const total = cls?.children?.find((c) => c.name === 'Total');
    expect(total?.detail).toContain('Integer');
  });

  it('summarises a class by what it inherits', () => {
    expect(documentSymbols(unit).find((s) => s.name === 'cCustomerView')?.detail).toContain(
      'cWebView'
    );
  });

  it('is defined for every kind the outline can contain', () => {
    for (const kind of SYMBOL_KINDS.keys()) {
      expect(typeof describeNode({ kind, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, headerRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } })).toBe('string');
    }
  });
});

describe('foldingRanges', () => {
  const folds = foldingRanges(unit);

  it('folds every multi-line block', () => {
    // Struct, class, two methods, two objects.
    expect(folds.length).toBeGreaterThanOrEqual(6);
  });

  it('never folds a single line', () => {
    for (const fold of folds) {
      expect(fold.endLine).toBeGreaterThan(fold.startLine);
    }
  });

  it('keeps every range inside the document', () => {
    const lines = SRC.split('\n').length;
    for (const fold of folds) {
      expect(fold.startLine).toBeGreaterThanOrEqual(0);
      expect(fold.endLine).toBeLessThan(lines);
    }
  });

  it('answers nothing for a file with no blocks', () => {
    expect(foldingRanges(parseSource('Use cWebView.pkg\n', { uri: 'x' }))).toEqual([]);
  });
});
