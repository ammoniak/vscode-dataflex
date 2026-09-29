import { describe, expect, it } from 'vitest';
import { SymbolIndex } from '../src/symbolIndex';

/**
 * Facts the index carries for the hover: web publication, metadata tags and structured parameters.
 */

const FILE = 'C:\\ws\\AppSrc\\Views.wo';

function indexed(source: string, name: string) {
  const index = new SymbolIndex();
  index.indexFile(FILE, source);
  return index.lookup(name);
}

describe('WebPublishProcedure', () => {
  /**
   * Two objects, each with a `ButtonCallback`, but only one publishing it.
   *
   * Scoping matters: a file-wide set would mark both, and the badge would then claim a method is
   * reachable from the browser when it is not.
   */
  const TWO_OBJECTS = [
    'Object oPublished is a cWebPanel',
    '    Procedure ButtonCallback',
    '    End_Procedure',
    '    WebPublishProcedure ButtonCallback',
    'End_Object',
    '',
    'Object oPrivate is a cWebPanel',
    '    Procedure ButtonCallback',
    '    End_Procedure',
    'End_Object'
  ].join('\n');

  it('marks only the method whose own object publishes it', () => {
    const found = indexed(TWO_OBJECTS, 'ButtonCallback');
    expect(found).toHaveLength(2);

    const published = found.filter((declaration) => declaration.webPublished === true);
    expect(published).toHaveLength(1);
    expect(published[0]!.ownerClass).toBe('cWebPanel');
    expect(found.filter((d) => d.webPublished !== true)).toHaveLength(1);
  });

  it('reads the statement even though it follows the method it names', () => {
    const source = [
      'Object oX is a cWebPanel',
      '    Procedure Later',
      '    End_Procedure',
      '    WebPublishProcedure Later',
      'End_Object'
    ].join('\n');
    expect(indexed(source, 'Later')[0]!.webPublished).toBe(true);
  });

  it('handles WebPublishFunction too', () => {
    const source = [
      'Object oX is a cWebPanel',
      '    Function Compute Returns Integer',
      '    End_Function',
      '    WebPublishFunction Compute',
      'End_Object'
    ].join('\n');
    expect(indexed(source, 'Compute')[0]!.webPublished).toBe(true);
  });

  it('leaves an unpublished method alone', () => {
    const source = [
      'Object oX is a cWebPanel',
      '    Procedure Quiet',
      '    End_Procedure',
      'End_Object'
    ].join('\n');
    expect(indexed(source, 'Quiet')[0]!.webPublished).toBe(false);
  });
});

describe('metadata carried onto declarations', () => {
  it('keeps WebProperty and Visibility', () => {
    const source = [
      'Class cThing is a cObject',
      '    { WebProperty=Client }',
      '    Property String psCaption',
      '    { Visibility=Private }',
      '    Procedure Internal',
      '    End_Procedure',
      'End_Class'
    ].join('\n');

    const index = new SymbolIndex();
    index.indexFile(FILE, source);
    expect(index.lookup('psCaption')[0]!.webProperty).toBe('Client');
    expect(index.lookup('Internal')[0]!.visibility).toBe('Private');
  });
});

describe('structured parameters', () => {
  it('keeps types and names apart, alongside the rendered detail', () => {
    const source = [
      'Procedure AdjustForMultiDisplay Integer iHeight Integer ByRef iCol',
      'End_Procedure'
    ].join('\n');
    const found = indexed(source, 'AdjustForMultiDisplay')[0]!;

    expect(found.params).toEqual([
      expect.objectContaining({ type: 'Integer', name: 'iHeight', byRef: false }),
      expect.objectContaining({ type: 'Integer', name: 'iCol', byRef: true })
    ]);
    // The two views of the same node must agree.
    expect(found.paramCount).toBe(found.params!.length);
  });

  it('keeps a function return type', () => {
    const source = ['Function IsValid Integer iId Returns Boolean', 'End_Function'].join('\n');
    expect(indexed(source, 'IsValid')[0]!.type).toBe('Boolean');
  });

  it('marks the property-setter form', () => {
    const source = [
      'Class cThing is a cObject',
      '    Procedure Set psCaption String sValue',
      '    End_Procedure',
      'End_Class'
    ].join('\n');
    expect(indexed(source, 'psCaption')[0]!.isSetter).toBe(true);
  });
});

/**
 * The table a data dictionary manages.
 *
 * The parser keeps `Set` and `Main_File` but drops the right-hand side, so this is recovered from
 * the token stream. It is the single most useful fact about a DD and the class name only hints at
 * it -- `cAboFeatureDataDictionary` manages `AboFeature`, but nothing guarantees that.
 */
describe('Main_File', () => {
  const DD = [
    'Open Customer',
    'Open OrderHeader',
    'Open DFLastID',
    '',
    'Class cCustomerDataDictionary is a DataDictionary',
    '    Procedure Construct_Object',
    '        Forward Send Construct_Object',
    '        Set Main_File to Customer.File_Number',
    '    End_Procedure',
    'End_Class'
  ].join('\n');

  it('records the managed table on the class', () => {
    const found = indexed(DD, 'cCustomerDataDictionary');
    expect(found).toHaveLength(1);
    expect(found[0]!.mainFile).toBe('Customer');
  });

  /**
   * A DD opens every table it touches but manages exactly one. Reading `Open` instead would name
   * whichever happened to come first -- here `Customer`, but only by luck.
   */
  it('reports the managed table, not the tables merely opened', () => {
    const found = indexed(DD, 'cCustomerDataDictionary');
    expect(found[0]!.mainFile).not.toBe('OrderHeader');
    expect(found[0]!.mainFile).not.toBe('DFLastID');
  });

  it('records it on an object as well as a class', () => {
    const source = [
      'Object oCustomer_DD is a cCustomerDataDictionary',
      '    Set Main_File to Customer.File_Number',
      'End_Object'
    ].join('\n');
    expect(indexed(source, 'oCustomer_DD')[0]!.mainFile).toBe('Customer');
  });

  it('scopes it to the declaring class, not the file', () => {
    const source = [
      'Class cA is a DataDictionary',
      '    Set Main_File to Alpha.File_Number',
      'End_Class',
      'Class cB is a DataDictionary',
      '    Set Main_File to Beta.File_Number',
      'End_Class'
    ].join('\n');
    expect(indexed(source, 'cA')[0]!.mainFile).toBe('Alpha');
    expect(indexed(source, 'cB')[0]!.mainFile).toBe('Beta');
  });

  it('leaves it unset on a class that declares none', () => {
    const source = ['Class cPlain is a cObject', 'End_Class'].join('\n');
    expect(indexed(source, 'cPlain')[0]!.mainFile).toBeUndefined();
  });
});

/**
 * A mixin declares methods but is never instantiated and has no documentation page. The class that
 * imports it is what the reference describes, so the index records that relationship both ways.
 */
describe('Import_Class_Protocol', () => {
  it('records a mixin imported inside a class body', () => {
    const index = new SymbolIndex();
    index.indexFile(
      FILE,
      [
        'Class cWebApp is a cWebBaseUIObject',
        '    Import_Class_Protocol cWebHostAPI_mixin',
        'End_Class'
      ].join('\n')
    );
    expect(index.mixinHost('cWebHostAPI_mixin')).toBe('cWebApp');
  });

  /**
   * The top-level form grafts a mixin onto a class declared elsewhere. It used to be dropped --
   * the parser keeps only the first token after the verb, which is the mixin -- so half the mixin
   * graph was invisible and `ShowInfoBox` linked nowhere.
   */
  it('records the top-level form that names its target class', () => {
    const index = new SymbolIndex();
    index.indexFile(
      FILE,
      ['Class cWebApp is a cWebBaseUIObject', 'End_Class', 'Import_Class_Protocol cAppWebApp_Mixin cWebApp All'].join('\n')
    );
    expect(index.mixinHost('cAppWebApp_Mixin')).toBe('cWebApp');
  });

  it('answers nothing for a mixin nothing imports', () => {
    const index = new SymbolIndex();
    index.indexFile(FILE, 'Class cPlain is a cObject\nEnd_Class');
    expect(index.mixinHost('cNobodyImportsThis')).toBeUndefined();
  });
});

describe('constants', () => {
  const SOURCE = [
    'Define C_Max for 100 // upper bound',
    'Define C_Bare',
    '#REPLACE C_Replaced "text"',
    'Enum_List',
    '    Define lpLeft',
    '    Define lpTop for 4',
    '    Define lpRight',
    'End_Enum_List'
  ].join('\n');

  it('keeps the value as written, without the trailing comment', () => {
    const [define] = indexed(SOURCE, 'C_Max');
    expect(define?.value).toBe('100');
    expect(define?.directive).toBeUndefined();
    expect(define?.detail).toBe('100');
    expect(indexed(SOURCE, 'C_Bare')[0]?.value).toBeUndefined();
  });

  it('remembers that a constant came from a directive', () => {
    const [replaced] = indexed(SOURCE, 'C_Replaced');
    expect(replaced?.directive).toBe('#REPLACE');
    expect(replaced?.value).toBe('"text"');
  });

  it('numbers enum members by position, restarting at an explicit value', () => {
    expect(indexed(SOURCE, 'lpLeft')[0]).toMatchObject({ kind: 'enumValue', ordinal: 0 });
    expect(indexed(SOURCE, 'lpTop')[0]).toMatchObject({ ordinal: 4, value: '4' });
    expect(indexed(SOURCE, 'lpRight')[0]).toMatchObject({ ordinal: 5 });
  });
});
