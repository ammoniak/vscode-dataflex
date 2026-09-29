import { describe, expect, it } from 'vitest';
import { parseSource, walk } from '@vscode-dataflex/parser';
import { SymbolIndex, valueTokensAfterTo } from '@vscode-dataflex/workspace';
import { ValueResolver, coerce } from '../src/preview/values';

/**
 * Reading a value out of a `Set` statement, and forcing it to the type the property was declared
 * with.
 *
 * The coercion is not tidiness. The framework casts by the type its JavaScript class registered
 * and assigns anything else raw, so a number on a String property gets as far as rendering and
 * then throws `e.trim is not a function` from inside the framework -- and the whole view is blank
 * rather than one control being wrong.
 */

const CONSTANTS = 'C:\\DfPkg\\AppSrc\\Constants.pkg';
const CONSTANT_SOURCE = [
  'Define C_WebDefault for -1',
  '',
  'Enum_List',
  '    Define alignLeft',
  '    Define alignCenter',
  '    Define alignRight',
  'End_Enum_List',
  '',
  'Enum_List',
  '    Define ltInherit',
  '    Define ltFlow for 7',
  '    Define ltGrid',
  'End_Enum_List',
  '',
  '// How a view names its pictures: a constant for a string, and aliases of it.',
  'Define C_IconHistory for "Images/History.png"',
  'Define C_IconDefault for C_IconHistory',
  'Define C_Loop for C_Loop',
  'Define C_Wide for 5000',
  'Define C_Yes for True',
  'Define C_Computed for (C_Wide * 2)',
  '#REPLACE C_Replaced "Images/Replaced.png"',
  ''
].join('\n');

const FILE = 'C:\\ws\\AppSrc\\View.wo';

/** Resolves the right-hand side of the one `Set` statement in `line`. */
function resolve(line: string) {
  const source = ['Object oX is a cWebForm', `    ${line}`, 'End_Object', ''].join('\n');
  const unit = parseSource(source, { uri: FILE });

  const index = new SymbolIndex();
  index.indexFile(CONSTANTS, CONSTANT_SOURCE);
  const resolver = new ValueResolver(index, (path) =>
    path === CONSTANTS ? CONSTANT_SOURCE : undefined
  );

  let value: unknown;
  walk(unit.root, (node) => {
    if (node.kind === 'statement' && node.verb === 'set') {
      value = resolver.resolve(valueTokensAfterTo(unit, node));
    }
  });
  return value;
}

describe('reading a value', () => {
  it('reads a string without its quotes', () => {
    expect(resolve('Set psLabel to "Name:"')).toBe('Name:');
  });

  it('reads a single-quoted string, which is how DataFlex embeds a double quote', () => {
    // The language has no escape character: a literal may contain the other quote freely, and to
    // embed a `"` you switch delimiters. So there is nothing to unescape.
    expect(resolve('Set psLabel to \'say "hi"\'')).toBe('say "hi"');
  });

  it('reads a triple-quoted string, which is how HTML and script get embedded', () => {
    expect(resolve('Set psHtml to """<b class="x">hi</b>"""')).toBe('<b class="x">hi</b>');
  });

  it('reads an integer', () => {
    expect(resolve('Set piColumnСount to 10'.replace('С', 'C'))).toBe(10);
  });

  it('reads a negative number, whose sign is its own token', () => {
    expect(resolve('Set piWidth to -1')).toBe(-1);
  });

  it('reads True and False', () => {
    expect(resolve('Set pbRender to True')).toBe(true);
    expect(resolve('Set pbRender to False')).toBe(false);
  });

  it('resolves an Enum_List member to its position', () => {
    expect(resolve('Set peLabelAlign to alignLeft')).toBe(0);
    expect(resolve('Set peLabelAlign to alignRight')).toBe(2);
  });

  it('continues an Enum_List from an explicit value', () => {
    // `Define ltFlow for 7` moves the counter, and the next bare Define follows it.
    expect(resolve('Set peLayoutType to ltFlow')).toBe(7);
    expect(resolve('Set peLayoutType to ltGrid')).toBe(8);
  });

  it('reads a standalone Define with an explicit value', () => {
    expect(resolve('Set peAlign to C_WebDefault')).toBe(-1);
  });

  it('gives up on an expression rather than guessing', () => {
    expect(resolve('Set psLabel to (Trim(sName))')).toBeUndefined();
  });

  it('gives up on an identifier that is not a constant', () => {
    expect(resolve('Set psLabel to sSomeVariable')).toBeUndefined();
  });

  it('gives up on a statement with no `to` at all', () => {
    expect(resolve('Set psLabel')).toBeUndefined();
  });

  it('is not fooled by the word "to" inside a string', () => {
    expect(resolve('Set psLabel to "go to order"')).toBe('go to order');
  });

  it('ignores a trailing comment', () => {
    expect(resolve('Set piWidth to 40 // as wide as the label')).toBe(40);
  });
});

describe('coercing to the declared type', () => {
  it('makes a number into a string for a String property', () => {
    // WebOrder's own OrderListSample.wo does `Set psValue to 5000`, and the framework then calls
    // .trim() on it.
    expect(coerce(5000, 'String')).toBe('5000');
  });

  it('makes a string into a number for an Integer property', () => {
    expect(coerce('10', 'Integer')).toBe(10);
  });

  it('leaves a number alone for a numeric property', () => {
    expect(coerce(2, 'Integer')).toBe(2);
    expect(coerce(1.5, 'Number')).toBe(1.5);
  });

  it('follows the framework on what counts as false', () => {
    // df.toBool: "0", "-1" and "false" are false, and -1 because that is C_WebDefault.
    expect(coerce(-1, 'Boolean')).toBe(false);
    expect(coerce(0, 'Boolean')).toBe(false);
    expect(coerce('false', 'Boolean')).toBe(false);
    expect(coerce(1, 'Boolean')).toBe(true);
    expect(coerce(true, 'Boolean')).toBe(true);
  });

  it('writes a boolean the DataFlex way when a String property is given one', () => {
    expect(coerce(true, 'String')).toBe('1');
    expect(coerce(false, 'String')).toBe('0');
  });

  it('turns a boolean into a number for a numeric property', () => {
    expect(coerce(true, 'Integer')).toBe(1);
  });

  it('leaves a value alone when the type means nothing here', () => {
    // A Handle or a RowID has no browser equivalent, and guessing at one is how the last bug got
    // in.
    expect(coerce('ghoThing', 'Handle')).toBe('ghoThing');
    expect(coerce('x', undefined)).toBe('x');
  });

  it('leaves an unparseable number alone rather than sending NaN', () => {
    expect(coerce('later', 'Integer')).toBe('later');
  });
});

describe('a Define that is not a number', () => {
  it('reads a string constant, which is how a cWebImage usually names its picture', () => {
    expect(resolve('Set psUrl to C_IconHistory')).toBe('Images/History.png');
  });

  it('follows a Define that names another Define', () => {
    expect(resolve('Set psUrl to C_IconDefault')).toBe('Images/History.png');
  });

  it('gives up on a Define that names itself rather than recursing', () => {
    expect(resolve('Set psUrl to C_Loop')).toBeUndefined();
  });

  it('reads numbers and booleans by the same route', () => {
    expect(resolve('Set piWidth to C_Wide')).toBe(5000);
    expect(resolve('Set pbVisible to C_Yes')).toBe(true);
  });

  it('leaves an expression alone', () => {
    expect(resolve('Set piWidth to C_Computed')).toBeUndefined();
  });

  it('reads a #REPLACE the same way', () => {
    expect(resolve('Set psUrl to C_Replaced')).toBe('Images/Replaced.png');
  });
});
