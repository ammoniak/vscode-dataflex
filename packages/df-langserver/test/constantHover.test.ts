import { describe, expect, it } from 'vitest';
import { parseSource } from '@vscode-dataflex/parser';
import { SymbolIndex } from '@vscode-dataflex/workspace';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { hover } from '../src/providers/navigation';

/**
 * Hovering a constant where it is used shows what it is worth.
 *
 * Before this a `Define` rendered as the bare words "define C_WebDefault" -- the kind and the
 * name, and not the value, which is the only thing anyone hovers a constant to learn. An
 * `Enum_List` member was worse: its value is a position that the declaration does not even state.
 */

const CONSTANTS = 'C:\\ws\\DfPkg\\AppSrc\\Constants.pkg';
const CONSTANT_SOURCE = [
  'Define C_WebDefault for -1',
  '',
  'Enum_List',
  '    Define alignLeft',
  '    Define alignCenter',
  '    Define alignRight',
  'End_Enum_List',
  '',
  'Define C_IconHistory for "Images/History.png"',
  'Define C_IconDefault for C_IconHistory',
  'Define C_Computed for (C_WebDefault * 2)',
  '#REPLACE C_Replaced "Images/Replaced.png"',
  ''
].join('\n');

const SRC = [
  'Object oForm is a cWebForm',
  '    Set piColumnSpan to C_WebDefault',
  '    Set peAlign to alignRight',
  '    Set psImage to C_IconDefault',
  '    Set piWidth to C_Computed',
  '    Set psOther to C_Replaced',
  'End_Object',
  ''
].join('\n');

const FILE = 'C:\\ws\\AppSrc\\View.wo';
const LINES = SRC.split('\n');

const unit = parseSource(SRC, { uri: FILE });
const index = new SymbolIndex();
index.indexFile(CONSTANTS, CONSTANT_SOURCE);
index.indexFile(FILE, SRC);
const doc = TextDocument.create('file:///View.wo', 'dataflex', 1, SRC);

/** Hovers just inside `needle`, on the first line containing `marker`. */
function hoverAt(marker: string, needle: string): string {
  const line = LINES.findIndex((text) => text.includes(marker));
  if (line < 0) {
    throw new Error(`no line containing ${JSON.stringify(marker)}`);
  }
  const character = LINES[line]!.indexOf(needle, LINES[line]!.indexOf(marker)) + 1;
  const result = hover(unit, doc, { line, character }, index, { root: 'C:\\ws' });
  if (result === undefined) {
    throw new Error(`no hover on ${needle}`);
  }
  return (result.contents as { value: string }).value;
}

describe('hovering a constant', () => {
  it('shows a literal define as written, with its type', () => {
    const text = hoverAt('piColumnSpan', 'C_WebDefault');
    expect(text).toContain('```dataflex\nDefine C_WebDefault for -1\n```');
    expect(text).toContain('**Type** Integer');
    expect(text).not.toContain('**Value**');
    expect(text).toContain('`AppSrc/Constants.pkg`');
  });

  it('gives an enum member its position', () => {
    const text = hoverAt('peAlign', 'alignRight');
    expect(text).toContain('```dataflex\nDefine alignRight\n```');
    expect(text).toContain('**Value** `2` — position in its `Enum_List`');
    expect(text).toContain('**Type** Integer');
  });

  it('follows an alias to the value behind it', () => {
    const text = hoverAt('psImage', 'C_IconDefault');
    expect(text).toContain('Define C_IconDefault for C_IconHistory');
    expect(text).toContain('**Value** `"Images/History.png"`');
    expect(text).toContain('**Type** String');
  });

  it('shows an expression it cannot evaluate without claiming a value', () => {
    const text = hoverAt('piWidth', 'C_Computed');
    expect(text).toContain('Define C_Computed for (C_WebDefault * 2)');
    expect(text).not.toContain('**Value**');
    expect(text).not.toContain('**Type**');
  });

  it('renders a #REPLACE as the directive it is', () => {
    const text = hoverAt('psOther', 'C_Replaced');
    expect(text).toContain('```dataflex\n#REPLACE C_Replaced "Images/Replaced.png"\n```');
    expect(text).toContain('**Type** String');
  });
});
