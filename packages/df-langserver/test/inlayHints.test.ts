import { describe, expect, it } from 'vitest';
import { InlayHintKind } from 'vscode-languageserver';
import { parseSource } from '@vscode-dataflex/parser';
import { SymbolIndex } from '@vscode-dataflex/workspace';
import { inlayHints } from '../src/providers/inlayHints';

/**
 * Parameter-name hints.
 *
 * `Send PopupOrderCustomerLookup Self "" "" "" "" ""` is real code from a real workspace, and
 * nothing in it says what any of those arguments are. But hints are drawn *inside* the code, so
 * most of these tests are about the cases where a hint is deliberately withheld.
 */

const FILE = 'C:\\ws\\x.pkg';
const LIB = 'C:\\ws\\lib.pkg';

const LIBRARY = [
  'Class cThing is a cObject',
  '    Procedure Configure String sName Integer iCount Boolean bFlag',
  '    End_Procedure',
  '    Procedure OneArg String sOnly',
  '    End_Procedure',
  'End_Class',
  ''
].join('\n');

const WHOLE_FILE = {
  start: { line: 0, character: 0 },
  end: { line: 1000, character: 0 }
};

function index(extra?: [string, string]): SymbolIndex {
  const symbols = new SymbolIndex();
  symbols.indexFile(LIB, LIBRARY);
  if (extra !== undefined) {
    symbols.indexFile(extra[0], extra[1]);
  }
  return symbols;
}

function hintsFor(source: string, symbols = index(), range = WHOLE_FILE) {
  return inlayHints(parseSource(source, { uri: FILE }), symbols, range, { enabled: true });
}

describe('what gets a hint', () => {
  it('labels each argument with its parameter name', () => {
    const hints = hintsFor('Procedure P\n    Send Configure "a" 2 True\nEnd_Procedure\n');
    expect(hints.map((h) => h.label)).toEqual(['sName:', 'iCount:', 'bFlag:']);
  });

  it('places each hint at the argument it names', () => {
    const source = 'Procedure P\n    Send Configure "a" 2 True\nEnd_Procedure\n';
    const hints = hintsFor(source);
    const line = source.split('\n')[1]!;
    expect(hints[0]!.position.character).toBe(line.indexOf('"a"'));
    expect(hints[1]!.position.character).toBe(line.indexOf('2'));
  });

  it('marks them as parameter hints', () => {
    const hints = hintsFor('Procedure P\n    Send Configure "a" 2 True\nEnd_Procedure\n');
    expect(hints[0]!.kind).toBe(InlayHintKind.Parameter);
  });
});

describe('what is deliberately left unlabelled', () => {
  /** A hint that repeats the argument is noise drawn inside the code. */
  it('says nothing when the argument already carries the name', () => {
    const source = 'Procedure P String sName\n    Send Configure sName 2 True\nEnd_Procedure\n';
    expect(hintsFor(source).map((h) => h.label)).toEqual(['iCount:', 'bFlag:']);
  });

  it('matches a prefixed argument name too', () => {
    const source = 'Procedure P String psName\n    Send Configure psName 2 True\nEnd_Procedure\n';
    expect(hintsFor(source).map((h) => h.label)).not.toContain('sName:');
  });

  /** One argument is readable without help; hints there are pure clutter. */
  it('says nothing about a call with a single argument', () => {
    expect(hintsFor('Procedure P\n    Send OneArg "x"\nEnd_Procedure\n')).toEqual([]);
  });

  it('says nothing about a name the workspace does not declare', () => {
    expect(hintsFor('Procedure P\n    Send Unknown "a" "b"\nEnd_Procedure\n')).toEqual([]);
  });

  /**
   * DataFlex declares a name many times over. Two signatures that disagree cannot both be right,
   * and a wrong label is worse than none -- the reader cannot tell it is wrong.
   */
  it('says nothing when two declarations disagree about the names', () => {
    const symbols = index([
      'C:\\ws\\other.pkg',
      [
        'Class cOther is a cObject',
        '    Procedure Configure String sDifferent Integer iOther Boolean bElse',
        '    End_Procedure',
        'End_Class',
        ''
      ].join('\n')
    ]);
    expect(hintsFor('Procedure P\n    Send Configure "a" 2 True\nEnd_Procedure\n', symbols)).toEqual([]);
  });

  it('still labels when the declarations agree', () => {
    const symbols = index([
      'C:\\ws\\other.pkg',
      [
        'Class cOther is a cObject',
        '    Procedure Configure String sName Integer iCount Boolean bFlag',
        '    End_Procedure',
        'End_Class',
        ''
      ].join('\n')
    ]);
    expect(hintsFor('Procedure P\n    Send Configure "a" 2 True\nEnd_Procedure\n', symbols)).toHaveLength(3);
  });

  it('says nothing when the feature is switched off', () => {
    const unit = parseSource('Procedure P\n    Send Configure "a" 2 True\nEnd_Procedure\n', { uri: FILE });
    expect(inlayHints(unit, index(), WHOLE_FILE)).toEqual([]);
    expect(inlayHints(unit, index(), WHOLE_FILE, { enabled: false })).toEqual([]);
  });

  it('says nothing without an index', () => {
    const unit = parseSource('Procedure P\n    Send Configure "a" 2 True\nEnd_Procedure\n', { uri: FILE });
    expect(inlayHints(unit, undefined, WHOLE_FILE, { enabled: true })).toEqual([]);
  });
});

describe('the requested range', () => {
  it('only answers for lines the editor asked about', () => {
    const source = [
      'Procedure P',
      '    Send Configure "a" 2 True',
      'End_Procedure',
      'Procedure Q',
      '    Send Configure "b" 3 False',
      'End_Procedure',
      ''
    ].join('\n');
    const firstOnly = hintsFor(source, index(), {
      start: { line: 0, character: 0 },
      end: { line: 2, character: 0 }
    });
    expect(firstOnly).toHaveLength(3);
    for (const hint of firstOnly) {
      expect(hint.position.line).toBe(1);
    }
  });
});

/**
 * A call may pass more arguments than the signature declares -- that is what `argument-count`
 * reports, and a real workspace has one passing seven to a two-parameter method.
 *
 * Requiring the signature to cover every argument refused exactly those calls, which are the ones
 * a reader most needs help with. Naming the parameters that *are* declared is what makes the
 * mistake visible.
 */
describe('a call with more arguments than parameters', () => {
  const OVERFULL = [
    'Class cThing is a cObject',
    '    Procedure PopupLookup Handle hReturnObj String sCustomerName',
    '    End_Procedure',
    'End_Class',
    ''
  ].join('\n');

  function symbols(): SymbolIndex {
    const s2 = new SymbolIndex();
    s2.indexFile(LIB, OVERFULL);
    return s2;
  }

  it('labels the parameters the method does declare', () => {
    const hints = hintsFor(
      'Procedure P\n    Send PopupLookup Self "" "" "" ""\nEnd_Procedure\n',
      symbols()
    );
    expect(hints.map((h) => h.label)).toEqual(['hReturnObj:', 'sCustomerName:']);
  });

  it('labels no more arguments than there are parameters', () => {
    const hints = hintsFor(
      'Procedure P\n    Send PopupLookup Self "" "" "" ""\nEnd_Procedure\n',
      symbols()
    );
    expect(hints).toHaveLength(2);
  });
});

/**
 * Suppression is a preference, not a law.
 *
 * A real call reads `Send PopupCustomerContactLookup of oLookup Self sCustomerAccount sSearchName`
 * against `hReturnObj sCustomerAccount sSearchName`. Only the first argument differs from its
 * parameter, so only it gets a hint -- correct, and indistinguishable from the feature half
 * failing. The setting exists so the asymmetry can be turned off, as TypeScript's
 * `suppressWhenArgumentMatchesName` does.
 */
describe('suppressWhenArgumentMatchesName', () => {
  const LOOKUP = [
    'Class cThing is a cObject',
    '    Procedure PopupLookup Handle hReturnObj String sCustomerAccount String sSearchName',
    '    End_Procedure',
    'End_Class',
    ''
  ].join('\n');

  const CALL = [
    'Procedure P Handle hSelf String sCustomerAccount String sSearchName',
    '    Send PopupLookup Self sCustomerAccount sSearchName',
    'End_Procedure',
    ''
  ].join('\n');

  function symbols(): SymbolIndex {
    const s2 = new SymbolIndex();
    s2.indexFile(LIB, LOOKUP);
    return s2;
  }

  function labels(suppress: boolean): string[] {
    return inlayHints(parseSource(CALL, { uri: FILE }), symbols(), WHOLE_FILE, {
      enabled: true,
      suppressWhenArgumentMatchesName: suppress
    }).map((h) => h.label);
  }

  it('labels only the argument that differs, by default', () => {
    expect(labels(true)).toEqual(['hReturnObj:']);
  });

  it('labels every argument when suppression is turned off', () => {
    expect(labels(false)).toEqual(['hReturnObj:', 'sCustomerAccount:', 'sSearchName:']);
  });

  it('suppresses by default when the option is not given at all', () => {
    const hints = inlayHints(parseSource(CALL, { uri: FILE }), symbols(), WHOLE_FILE, {
      enabled: true
    });
    expect(hints.map((h) => h.label)).toEqual(['hReturnObj:']);
  });

  /**
   * `Self` is not special to this feature. It gets a hint because `hReturnObj` differs from it,
   * and it is suppressed like anything else when the parameter is called `self`.
   */
  it('treats Self like any other argument', () => {
    const s2 = new SymbolIndex();
    s2.indexFile(
      LIB,
      [
        'Class cThing is a cObject',
        '    Procedure TakesSelf Handle self String sOther',
        '    End_Procedure',
        'End_Class',
        ''
      ].join('\n')
    );
    const source = 'Procedure P String sOther\n    Send TakesSelf Self sOther\nEnd_Procedure\n';
    const hints = inlayHints(parseSource(source, { uri: FILE }), s2, WHOLE_FILE, { enabled: true });
    // Both arguments match their parameter names, so neither is labelled.
    expect(hints).toEqual([]);
  });
});
