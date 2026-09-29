import { describe, expect, it } from 'vitest';
import { parseSource } from '@vscode-dataflex/parser';
import { SymbolIndex, TableIndex } from '@vscode-dataflex/workspace';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { hover } from '../src/providers/navigation';
import { docsEntryForCommand } from '../src/providers/docsLink';

/**
 * Hovering the language itself.
 *
 * `Begin`, `Object`, `String` and `Boolean` are not statement verbs -- the parser recognises them
 * positionally, while opening a node or reading a declaration -- so the command hover never fired
 * on them and they produced nothing at all. They are still keywords with documentation pages, and
 * a reader hovering one wants the same answer as one hovering `Move`.
 */

const SRC = [
  'Struct tRow',
  '    String sName',
  'End_Struct',
  '',
  'Object oThing is a cObject',
  'End_Object',
  '',
  'Procedure DoIt',
  '    Boolean bOk',
  '    Integer iCount',
  '    Begin',
  '    End',
  '    Move 1 to iCount',
  'End_Procedure',
  ''
].join('\n');

const FILE = 'C:\\ws\\x.pkg';
const LINES = SRC.split('\n');
const unit = parseSource(SRC, { uri: FILE });
const index = new SymbolIndex();
index.indexFile(FILE, SRC);
const doc = TextDocument.create('file:///x.pkg', 'dataflex', 1, SRC);

function hoverAt(marker: string, needle: string, tables?: TableIndex): string | undefined {
  const line = LINES.findIndex((text) => text.includes(marker));
  if (line < 0) {
    throw new Error(`no line containing ${JSON.stringify(marker)}`);
  }
  const character = LINES[line]!.indexOf(needle) + 1;
  const result = hover(unit, doc, { line, character }, index, { root: 'C:\\ws', tables });
  return result === undefined ? undefined : (result.contents as { value: string }).value;
}

describe('hovering a keyword', () => {
  it('describes a block keyword', () => {
    const text = hoverAt('    Begin', 'Begin');
    // A keyword, not a command: `Begin` opens a block, it does not lead a statement.
    expect(text).toContain('_DataFlex keyword_');
    expect(text).toContain('LanguageReference/Begin_Command/');
  });

  it('describes a declaration keyword', () => {
    expect(hoverAt('Object oThing', 'Object')).toContain('LanguageReference/Object_Command/');
  });

  it('describes a built-in type', () => {
    const text = hoverAt('Boolean bOk', 'Boolean');
    expect(text).toContain('Declares one or more Boolean variables.');
    // The stem is irregular -- lower-case `c` -- which is why it is looked up, not constructed.
    expect(text).toContain('LanguageReference/Boolean_command/');
  });

  it('describes String, which is both a type and a command page', () => {
    expect(hoverAt('String sName', 'String')).toContain('LanguageReference/String_Command/');
  });

  /**
   * The keyword answer is a last resort. Anything the workspace declares, or a local in scope,
   * still wins -- otherwise a variable called `Date` would report the built-in type.
   */
  it('does not displace a local variable of the same name', () => {
    expect(hoverAt('Boolean bOk', 'bOk')).toContain('Local variable');
  });

  it('does not displace a statement verb, which keeps its own hover', () => {
    expect(hoverAt('Move 1 to iCount', 'Move')).toContain('LanguageReference/Move_Command/');
  });

  /** `to` and `of` have no page anywhere on the site, so there is nothing to show. */
  it('says nothing about a keyword the documentation does not cover', () => {
    expect(hoverAt('Move 1 to iCount', 'to')).toBeUndefined();
  });

  it('says nothing when documentation links are turned off', () => {
    const line = LINES.findIndex((text) => text.includes('    Begin'));
    const result = hover(
      unit,
      doc,
      { line, character: LINES[line]!.indexOf('Begin') + 1 },
      index,
      { root: 'C:\\ws', docsBaseUrl: '' }
    );
    expect(result).toBeUndefined();
  });
});

describe('listing a table s columns', () => {
  const tables = new TableIndex();
  tables.addFile(
    'C:\\ws\\DDSrc\\Abo.fd',
    [
      '#REPLACE FILE63 Abo',
      '#REPLACE Abo.AboID |FN63,1',
      '#REPLACE Abo.Name |FS63,2',
      ''
    ].join('\n')
  );

  const SOURCE = ['Procedure DoIt', '    Open Abo', 'End_Procedure', ''].join('\n');
  const tableUnit = parseSource(SOURCE, { uri: FILE });
  const tableDoc = TextDocument.create('file:///t.pkg', 'dataflex', 1, SOURCE);
  const at = { line: 1, character: SOURCE.split('\n')[1]!.indexOf('Abo') + 1 };

  function render(tableFields: boolean): string {
    const result = hover(tableUnit, tableDoc, at, index, { root: 'C:\\ws', tables, tableFields });
    return (result!.contents as { value: string }).value;
  }

  it('counts the columns by default', () => {
    const text = render(false);
    expect(text).toContain('Database table #63, 2 fields');
    expect(text).not.toContain('AboID');
  });

  /** The setting is off by default and invisible from the hover, so the hover names it. */
  it('says how to see them when they are hidden', () => {
    expect(render(false)).toContain('dataflex.hover.tableFields');
  });

  it('drops the hint once they are listed', () => {
    expect(render(true)).not.toContain('dataflex.hover.tableFields');
  });

  it('lists them when asked', () => {
    const text = render(true);
    expect(text).toContain('Number AboID');
    expect(text).toContain('String Name');
    expect(text).toContain('Database table #63, 2 fields');
  });
});

/**
 * A few keywords are documented in the guides rather than the language reference.
 *
 * The index originally read only `VdfClassRef` and `LanguageReference`, so `File_Field` and `Self`
 * -- both ordinary words to hover -- resolved to nothing. There are exactly three `The X Keyword`
 * pages site-wide, which is why this is a narrow rule and not an attempt to mine the guides.
 */
describe('keywords documented in the guides', () => {
  const SOURCE = [
    'Procedure DoIt',
    '    Integer iNr',
    '    Get File_Field_Current_Value of oX_DD File_Field FinanzBuch.Buchnummer to iNr',
    '    Move Self to ghoX',
    'End_Procedure',
    ''
  ].join('\n');

  const guideFile = 'C:\\ws\\g.pkg';
  const guideUnit = parseSource(SOURCE, { uri: guideFile });
  const guideIndex = new SymbolIndex();
  guideIndex.indexFile(guideFile, SOURCE);
  const guideDoc = TextDocument.create('file:///g.pkg', 'dataflex', 1, SOURCE);
  const guideLines = SOURCE.split('\n');

  function guideHover(marker: string, needle: string): string | undefined {
    const line = guideLines.findIndex((t) => t.includes(marker));
    const character = guideLines[line]!.indexOf(needle) + 1;
    const result = hover(guideUnit, guideDoc, { line, character }, guideIndex, {
      root: 'C:\\ws'
    });
    return result === undefined ? undefined : (result.contents as { value: string }).value;
  }

  it('links File_Field to its guide page', () => {
    const text = guideHover('File_Field FinanzBuch', 'File_Field FinanzBuch');
    expect(text).toContain('DevelopmentGuide/The_File_Field_Keyword/');
    expect(text).toContain('file number and a field number');
  });

  it('links Self to its guide page', () => {
    const text = guideHover('Move Self', 'Self');
    expect(text).toContain('LanguageGuide/The_Self_Keyword/');
  });

  /** These are keywords, not commands, and a DataFlex reader would notice the difference. */
  it('calls them keywords rather than commands', () => {
    expect(guideHover('Move Self', 'Self')).toContain('_DataFlex keyword_');
  });

  it('still calls a statement verb a command', () => {
    expect(hoverAt('Move 1 to iCount', 'Move')).toContain('_DataFlex command_');
  });

  /** `Field` is documented in both places; the reference states the syntax, so it wins. */
  it('prefers the language reference when a word is documented in both', () => {
    expect(docsEntryForCommand('Field')?.url).toBe(
      'https://docs.dataflex.dev/LanguageReference/Field_Command/'
    );
  });
});

/**
 * A member's documentation lives on the class that declares it, which is rarely the class the
 * code names.
 *
 * `Procedure OnShow` inside `Object oDlg is a cWebModalDialog` is an override of an event declared
 * further up the chain: only `cWebWindow` and `cWebCard` have a page for `OnShow`. Looking only at
 * the named class found nothing, so every inherited event -- which is most of them -- linked
 * nowhere.
 */
describe('an inherited member finds the class that documents it', () => {
  const SOURCE = [
    'Class cWebWindow is a cWebBaseUIObject',
    '    Procedure OnShow',
    '    End_Procedure',
    'End_Class',
    '',
    'Class cWebModalDialog is a cWebWindow',
    'End_Class',
    '',
    'Object oDlg is a cWebModalDialog',
    '    Procedure OnShow',
    '    End_Procedure',
    'End_Object',
    ''
  ].join('\n');

  const file = 'C:\\ws\\v.wo';
  const viewUnit = parseSource(SOURCE, { uri: file });
  const viewIndex = new SymbolIndex();
  viewIndex.indexFile(file, SOURCE);
  const viewDoc = TextDocument.create('file:///v.wo', 'dataflex', 1, SOURCE);
  const viewLines = SOURCE.split('\n');

  /** The `OnShow` inside the object, not the one in the base class. */
  function overrideHover(): string | undefined {
    const line = viewLines.lastIndexOf('    Procedure OnShow');
    const character = viewLines[line]!.indexOf('OnShow') + 1;
    const result = hover(viewUnit, viewDoc, { line, character }, viewIndex, { root: 'C:\\ws' });
    return result === undefined ? undefined : (result.contents as { value: string }).value;
  }

  it('links the ancestor page rather than nothing', () => {
    expect(overrideHover()).toContain('cWebWindow-Event-OnShow/');
  });

  it('carries the one-line summary from that page', () => {
    expect(overrideHover()).toContain('Fires when a window is shown');
  });
});

/**
 * Built-in functions.
 *
 * `SizeOfArray` is a documented language element with no `_Function` suffix on its page and no
 * place in any of the parser's keyword tables -- it is not a statement verb, a block word, a
 * declaration word or a type. Gating the hover on those tables refused every built-in function in
 * the language; the documentation index is the authority on what the language contains.
 */
describe('built-in functions', () => {
  const SOURCE = [
    'Struct tSearchResult',
    '    String sName',
    'End_Struct',
    '',
    'Procedure DoIt',
    '    tSearchResult[] tsSearchResult',
    '    Integer iSize',
    '    Move (SizeOfArray(tsSearchResult)) to iSize',
    '    Move (Trim("x")) to iSize',
    'End_Procedure',
    ''
  ].join('\n');

  const fnFile = 'C:\\ws\\f.pkg';
  const fnUnit = parseSource(SOURCE, { uri: fnFile });
  const fnIndex = new SymbolIndex();
  fnIndex.indexFile(fnFile, SOURCE);
  const fnDoc = TextDocument.create('file:///f.pkg', 'dataflex', 1, SOURCE);
  const fnLines = SOURCE.split('\n');

  function fnHover(needle: string): string | undefined {
    const line = fnLines.findIndex((t) => t.includes(needle));
    const character = fnLines[line]!.indexOf(needle) + 1;
    const result = hover(fnUnit, fnDoc, { line, character }, fnIndex, { root: 'C:\\ws' });
    return result === undefined ? undefined : (result.contents as { value: string }).value;
  }

  it('describes SizeOfArray, with its documentation', () => {
    const text = fnHover('SizeOfArray');
    expect(text).toContain('LanguageReference/SizeOfArray/');
    expect(text).toContain('number of elements in an array');
  });

  /** Called, so it is a function -- the page name cannot say so, since it carries no suffix. */
  it('calls it a function rather than a keyword', () => {
    expect(fnHover('SizeOfArray')).toContain('_DataFlex function_');
  });

  it('describes other built-ins the same way', () => {
    expect(fnHover('Trim')).toContain('LanguageReference/');
  });

  /** The local passed to it keeps its own hover; the function name does not take it over. */
  it('leaves the argument to the local hover', () => {
    expect(fnHover('tsSearchResult')).toContain('Local variable');
  });
});
