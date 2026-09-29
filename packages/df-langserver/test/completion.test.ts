import { describe, expect, it } from 'vitest';
import { parseSource } from '@vscode-dataflex/parser';
import { SymbolIndex } from '@vscode-dataflex/workspace';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { completion } from '../src/providers/completion';

/**
 * Completion.
 *
 * The headline feature: `WebSet ` should offer the properties of the object the cursor is inside,
 * ranked by how close the declaring class is. DataFlex gives no syntactic clue -- properties,
 * classes and objects are all bare identifiers -- so everything here depends on the index and on
 * where in the object tree the cursor sits.
 */

const LIB = 'C:\\DataFlex\\Pkg\\Web.pkg';
const LIBRARY = [
  'Class cWebObject is a cObject',
  '    { WebProperty=Client }',
  '    Property String psTooltip',
  'End_Class',
  '',
  'Class cWebForm is a cWebObject',
  '    { WebProperty=Client }',
  '    Property String psLabel',
  '    { WebProperty=Client }',
  '    Property Integer piColumnSpan',
  '    Procedure Refresh',
  '    End_Procedure',
  'End_Class',
  '',
  'Class cWebList is a cWebObject',
  '    { WebProperty=Client }',
  '    Property String psListOnly',
  'End_Class',
  ''
].join('\n');

const VIEW = [
  'Object oView is a cWebForm',
  '    WebSet ',
  '    Set ',
  '    Send ',
  '',
  '    Object oInner is a cWebList',
  '    End_Object',
  'End_Object',
  ''
].join('\n');

const FILE = 'C:\\ws\\AppSrc\\View.wo';

function index(): SymbolIndex {
  const symbols = new SymbolIndex();
  symbols.indexFile(LIB, LIBRARY);
  symbols.indexFile(FILE, VIEW);
  return symbols;
}

const unit = parseSource(VIEW, { uri: FILE });
const doc = TextDocument.create('file:///view.wo', 'dataflex', 1, VIEW);

/** Completion at the end of the line containing `marker`. */
function completeAt(marker: string, symbols: SymbolIndex = index()) {
  const lines = VIEW.split('\n');
  const line = lines.findIndex((text) => text.includes(marker));
  return completion(unit, doc, { line, character: lines[line]!.length }, symbols);
}

describe('WebSet completion', () => {
  it('offers the properties of the class the cursor is inside', () => {
    const labels = (completeAt('WebSet ')?.items ?? []).map((item) => item.label);
    expect(labels).toContain('psLabel');
    expect(labels).toContain('piColumnSpan');
  });

  it('offers inherited properties too', () => {
    expect((completeAt('WebSet ')?.items ?? []).map((i) => i.label)).toContain('psTooltip');
  });

  /**
   * Ranked, never filtered. DataFlex has one flat namespace and the indexer can miss a mixin, so
   * hiding a property the user can legitimately set would be worse than ordering it late.
   */
  it('ranks the nearest class first', () => {
    const labels = (completeAt('WebSet ')?.items ?? []).map((item) => item.label);
    expect(labels.indexOf('psLabel')).toBeLessThan(labels.indexOf('psTooltip'));
  });

  it('offers something for Set as well as WebSet', () => {
    expect((completeAt('    Set ')?.items ?? []).length).toBeGreaterThan(0);
  });
});

describe('Send completion', () => {
  it('offers methods rather than properties', () => {
    const labels = (completeAt('Send ')?.items ?? []).map((item) => item.label);
    expect(labels).toContain('Refresh');
  });
});

describe('when completion declines', () => {
  it('says nothing without an index', () => {
    // Called directly: a default parameter would fire on an explicit `undefined`.
    const lines = VIEW.split('\n');
    const line = lines.findIndex((t) => t.includes('WebSet '));
    expect(completion(unit, doc, { line, character: lines[line]!.length }, undefined)).toBeUndefined();
  });

  it('says nothing on a line that is not a completion request', () => {
    const lines = VIEW.split('\n');
    const line = lines.findIndex((t) => t.includes('End_Object'));
    expect(completion(unit, doc, { line, character: 4 }, index())).toBeUndefined();
  });
});

describe('class completion', () => {
  it('offers classes after "is a"', () => {
    const source = 'Object oNew is a \n';
    const classUnit = parseSource(source, { uri: FILE });
    const classDoc = TextDocument.create('file:///new.wo', 'dataflex', 1, source);
    const labels = (
      completion(classUnit, classDoc, { line: 0, character: 17 }, index())?.items ?? []
    ).map((item) => item.label);
    expect(labels).toContain('cWebForm');
    expect(labels).toContain('cWebList');
  });
});

/**
 * `Set` needs a setter, and only a `Property` or a `Procedure Set <Name>` provides one.
 *
 * The documentation is explicit: a bare `Function psX Returns String` supports `Get psX` and not
 * `Set psX to ...`. Offering getters after `Set` filled the list with things that cannot be set --
 * 71 of the 179 suggestions on `cWebForm`, including `GetColumnObject` and `LoadData`.
 */
describe('what each verb can address', () => {
  const CLASS = [
    'Class cMixed is a cObject',
    '    { WebProperty=Client }',
    '    Property String psBoth',
    '    Function fGetterOnly Returns String',
    '    End_Function',
    '    Procedure Set pSetterOnly String sValue',
    '    End_Procedure',
    '    Procedure DoWork',
    '    End_Procedure',
    'End_Class',
    ''
  ].join('\n');

  const VIEW2 = ['Object oX is a cMixed', '    Set ', '    Get ', '    Send ', 'End_Object', ''].join('\n');
  const file2 = 'C:\\ws\\v2.wo';

  function labelsFor(marker: string): string[] {
    const symbols = new SymbolIndex();
    symbols.indexFile('C:\\ws\\mixed.pkg', CLASS);
    symbols.indexFile(file2, VIEW2);
    const unit2 = parseSource(VIEW2, { uri: file2 });
    const doc2 = TextDocument.create('file:///v2.wo', 'dataflex', 1, VIEW2);
    const lines = VIEW2.split('\n');
    const line = lines.findIndex((t) => t.includes(marker));
    return (completion(unit2, doc2, { line, character: lines[line]!.length }, symbols)?.items ?? []).map(
      (i) => i.label
    );
  }

  it('offers a property to Set', () => {
    expect(labelsFor('    Set ')).toContain('psBoth');
  });

  it('offers a Procedure Set to Set', () => {
    expect(labelsFor('    Set ')).toContain('pSetterOnly');
  });

  /** The case that made the list unusable: a getter is not settable. */
  it('does not offer a getter-only name to Set', () => {
    expect(labelsFor('    Set ')).not.toContain('fGetterOnly');
  });

  it('offers a getter to Get', () => {
    expect(labelsFor('    Get ')).toContain('fGetterOnly');
  });

  it('offers a property to Get', () => {
    expect(labelsFor('    Get ')).toContain('psBoth');
  });

  /** The mirror image: a name that exists only as `Procedure Set` has no getter. */
  it('does not offer a setter-only name to Get', () => {
    expect(labelsFor('    Get ')).not.toContain('pSetterOnly');
  });

  it('offers neither properties nor getters to Send', () => {
    const labels = labelsFor('    Send ');
    expect(labels).toContain('DoWork');
    expect(labels).not.toContain('psBoth');
    expect(labels).not.toContain('fGetterOnly');
  });

  it('never offers a method to Set or Get', () => {
    expect(labelsFor('    Set ')).not.toContain('DoWork');
    expect(labelsFor('    Get ')).not.toContain('DoWork');
  });
});
