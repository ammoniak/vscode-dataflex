import { describe, expect, it } from 'vitest';
import { parseSource } from '@vscode-dataflex/parser';
import { SymbolIndex } from '@vscode-dataflex/workspace';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { hover } from '../src/providers/navigation';

/**
 * Hovering a struct, and hovering through one.
 *
 * Before this, `Struct tRow` rendered as the bare words "struct tRow" -- everything the reader
 * already knew from the name -- and `myRow.sName` produced no hover at all, because the index has
 * no entry for a struct member: it is not a workspace-wide name, only meaningful through the
 * struct that declares it.
 */

const SRC = [
  'Struct tInner',
  '    String sLabel',
  '    Integer iId',
  'End_Struct',
  '',
  'Struct tRow',
  '    String sName',
  '    tInner uInner',
  '    tInner[] uMany',
  'End_Struct',
  '',
  'Procedure DoIt tRow rParam',
  '    tRow myRow',
  '    tRow[] rows',
  '    String sName',
  '    Move "x" to myRow.sName',
  '    Move 1 to myRow.uInner.iId',
  '    Move 2 to rParam.uInner.sLabel',
  '    Move 3 to myRow.uInner.nope',
  '    Move 4 to rows[0].sName',
  'End_Procedure',
  ''
].join('\n');

const FILE = 'C:\\ws\\x.pkg';
const LINES = SRC.split('\n');

const unit = parseSource(SRC, { uri: FILE });
const index = new SymbolIndex();
index.indexFile(FILE, SRC);
const doc = TextDocument.create('file:///x.pkg', 'dataflex', 1, SRC);

/** Hovers just inside `needle`, on the first line containing `marker`. */
function hoverAt(marker: string, needle: string): string | undefined {
  const line = LINES.findIndex((text) => text.includes(marker));
  if (line < 0) {
    throw new Error(`no line containing ${JSON.stringify(marker)}`);
  }
  const character = LINES[line]!.indexOf(needle, LINES[line]!.indexOf(marker)) + 1;
  const result = hover(unit, doc, { line, character }, index, { root: 'C:\\ws' });
  return result === undefined ? undefined : (result.contents as { value: string }).value;
}

describe('hovering a struct', () => {
  it('shows the members, not just the name', () => {
    const text = hoverAt('tRow myRow', 'tRow');
    expect(text).toContain('Struct tRow');
    expect(text).toContain('String   sName');
    expect(text).toContain('tInner   uInner');
    expect(text).toContain('tInner[] uMany');
    expect(text).toContain('End_Struct');
  });

  it('aligns the member types, so the names line up', () => {
    // `String` is 6 characters and `tInner[]` is 8, so the short one is padded to match.
    expect(hoverAt('tRow myRow', 'tRow')).toContain('String   sName');
  });

  it('says Struct rather than falling back to the raw node kind', () => {
    expect(hoverAt('tRow myRow', 'tRow')).not.toContain('struct tRow');
  });
});

describe('hovering a struct member', () => {
  it('gives the member its declared type', () => {
    const text = hoverAt('to myRow.sName', 'sName');
    expect(text).toContain('String sName');
    expect(text).toContain('Struct field of `tRow`');
  });

  it('resolves through a nested struct', () => {
    const text = hoverAt('myRow.uInner.iId', 'iId');
    expect(text).toContain('Integer iId');
    expect(text).toContain('Struct field of `tInner`');
  });

  it('describes an intermediate member by its own struct type', () => {
    expect(hoverAt('myRow.uInner.iId', 'uInner')).toContain('tInner uInner');
  });

  it('resolves through a parameter as well as a local', () => {
    const text = hoverAt('rParam.uInner.sLabel', 'sLabel');
    expect(text).toContain('String sLabel');
    expect(text).toContain('Struct field of `tInner`');
  });

  /** `rows[0].sName` addresses the element's member; the subscript is not part of the name. */
  it('reaches through an array subscript', () => {
    expect(hoverAt('rows[0].sName', 'sName')).toContain('String sName');
  });

  it('still describes the variable when the cursor is on it rather than the member', () => {
    const text = hoverAt('to myRow.sName', 'myRow');
    expect(text).toContain('tRow myRow');
    expect(text).toContain('Local variable');
  });

  /**
   * The member is resolved through the struct, never by looking the bare word up.
   *
   * `sName` is also a local here. Answering with that local would be wrong -- and it is exactly
   * what a bare-name lookup would have done.
   */
  it('does not answer with an unrelated local of the same name', () => {
    expect(hoverAt('to myRow.sName', 'sName')).toContain('Struct field of `tRow`');
  });

  it('says nothing about a member the struct does not have', () => {
    expect(hoverAt('myRow.uInner.nope', 'nope')).toBeUndefined();
  });
});

/**
 * A DataDictionary *object* almost never declares `Main_File` itself -- the class it is an
 * instance of does -- so the hover on a DDO in view code stayed blank while the class hover
 * worked. That is exactly backwards: the DDO is what a reader meets.
 */
describe('a DataDictionary object', () => {
  const DD = [
    'Class cCustomerDataDictionary is a DataDictionary',
    '    Procedure Construct_Object',
    '        Set Main_File to Customer.File_Number',
    '    End_Procedure',
    'End_Class',
    '',
    'Object oCustomer_DD is a cCustomerDataDictionary',
    'End_Object',
    ''
  ].join('\n');

  const ddFile = 'C:\\ws\\dd.pkg';
  const ddUnit = parseSource(DD, { uri: ddFile });
  const ddIndex = new SymbolIndex();
  ddIndex.indexFile(ddFile, DD);
  const ddDoc = TextDocument.create('file:///dd.pkg', 'dataflex', 1, DD);
  const ddLines = DD.split('\n');

  function ddHover(marker: string, needle: string): string | undefined {
    const line = ddLines.findIndex((t) => t.includes(marker));
    const character = ddLines[line]!.indexOf(needle) + 1;
    const result = hover(ddUnit, ddDoc, { line, character }, ddIndex, { root: 'C:\\ws' });
    return result === undefined ? undefined : (result.contents as { value: string }).value;
  }

  it('names the table the object inherits from its class', () => {
    expect(ddHover('Object oCustomer_DD', 'oCustomer_DD')).toContain('**Manages** `Customer`');
  });

  it('still names it on the class itself', () => {
    expect(ddHover('Class cCustomerDataDictionary', 'cCustomerDataDictionary')).toContain(
      '**Manages** `Customer`'
    );
  });

  it('says nothing about a table for an object that is not a data dictionary', () => {
    const source = ['Object oPlain is a cObject', 'End_Object', ''].join('\n');
    const plainFile = 'C:\\ws\\p.pkg';
    const plainUnit = parseSource(source, { uri: plainFile });
    const plainIndex = new SymbolIndex();
    plainIndex.indexFile(plainFile, source);
    const plainDoc = TextDocument.create('file:///p.pkg', 'dataflex', 1, source);
    const result = hover(plainUnit, plainDoc, { line: 0, character: 8 }, plainIndex, {
      root: 'C:\\ws'
    });
    expect((result!.contents as { value: string }).value).not.toContain('Manages');
  });
});

describe('mixins reach the hover from the index', () => {
  const SOURCE = [
    'Class cWebHostAPI_mixin is a Mixin',
    'End_Class',
    '',
    'Class cWebApp is a cWebBaseUIObject',
    '    Import_Class_Protocol cWebHostAPI_mixin',
    'End_Class',
    '',
    'Object oApp is a cWebApp',
    'End_Object',
    ''
  ].join('\n');

  const file = 'C:\\ws\\app.pkg';
  const appUnit = parseSource(SOURCE, { uri: file });
  const appIndex = new SymbolIndex();
  appIndex.indexFile(file, SOURCE);
  const appDoc = TextDocument.create('file:///app.pkg', 'dataflex', 1, SOURCE);
  const appLines = SOURCE.split('\n');

  function appHover(marker: string, needle: string): string | undefined {
    const line = appLines.findIndex((t) => t.includes(marker));
    const character = appLines[line]!.indexOf(needle) + 1;
    const result = hover(appUnit, appDoc, { line, character }, appIndex, { root: 'C:\\ws' });
    return result === undefined ? undefined : (result.contents as { value: string }).value;
  }

  it('lists a class own mixins', () => {
    expect(appHover('Class cWebApp', 'cWebApp')).toContain('**Mixes in** `cWebHostAPI_mixin`');
  });

  /** An object is described by the class it instantiates, mixins included. */
  it('lists them for an object through the class it is a', () => {
    expect(appHover('Object oApp', 'oApp')).toContain('**Mixes in** `cWebHostAPI_mixin`');
  });
});
