import { describe, expect, it } from 'vitest';
import { SymbolIndex } from '../src/symbolIndex';
import { constantType, constantValue, literalValue } from '../src/constantValues';

/**
 * Constant values read off the index alone: literals in every spelling, aliases followed through
 * other constants, and enum members by position.
 */

const FILE = 'C:\\DfPkg\\AppSrc\\Constants.pkg';
const SOURCE = [
  'Define C_WebDefault for -1',
  'Define C_Ratio for 0.5',
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
  'Define C_IconHistory for "Images/History.png"',
  'Define C_IconDefault for C_IconHistory',
  'Define C_IconAlias for C_IconDefault',
  'Define C_Loop for C_Loop',
  'Define C_Ping for C_Pong',
  'Define C_Pong for C_Ping',
  'Define C_Yes for True',
  'Define C_Computed for (C_Wide * 2)',
  'Define C_Flags for |CI$FF',
  'Define C_Unknown for C_NotDeclared',
  '#REPLACE C_Replaced "Images/Replaced.png"',
  '#DEFINE C_Defined 42',
  ''
].join('\n');

const index = new SymbolIndex();
index.indexFile(FILE, SOURCE);

describe('constantValue', () => {
  it.each([
    ['C_WebDefault', -1],
    ['C_Ratio', 0.5],
    ['C_IconHistory', 'Images/History.png'],
    ['C_Yes', true],
    ['C_Flags', 255],
    ['C_Replaced', 'Images/Replaced.png'],
    ['C_Defined', 42]
  ])('reads %s as a literal', (name, expected) => {
    expect(constantValue(index, name)).toBe(expected);
  });

  it('follows an alias through as many constants as it names', () => {
    expect(constantValue(index, 'C_IconDefault')).toBe('Images/History.png');
    expect(constantValue(index, 'C_IconAlias')).toBe('Images/History.png');
  });

  it('is case-insensitive, like the language', () => {
    expect(constantValue(index, 'c_iconalias')).toBe('Images/History.png');
  });

  it('gives an enum member its position, restarting at an explicit value', () => {
    expect(constantValue(index, 'alignLeft')).toBe(0);
    expect(constantValue(index, 'alignRight')).toBe(2);
    expect(constantValue(index, 'ltInherit')).toBe(0);
    expect(constantValue(index, 'ltFlow')).toBe(7);
    expect(constantValue(index, 'ltGrid')).toBe(8);
  });

  it('stops on a cycle rather than recursing', () => {
    expect(constantValue(index, 'C_Loop')).toBeUndefined();
    expect(constantValue(index, 'C_Ping')).toBeUndefined();
  });

  it('leaves an expression and an unknown name alone', () => {
    expect(constantValue(index, 'C_Computed')).toBeUndefined();
    expect(constantValue(index, 'C_Unknown')).toBeUndefined();
    expect(constantValue(index, 'C_Nope')).toBeUndefined();
  });
});

describe('literalValue', () => {
  it.each([
    ['"quoted"', 'quoted'],
    ["'single'", 'single'],
    ['"""block"""', 'block'],
    ['@"verbatim"', 'verbatim'],
    ['12', 12],
    ['-3', -3],
    ['2.75', 2.75],
    ['True', true],
    ['false', false],
    ['|CI1', 1],
    ['|CI-4', -4],
    ['|CI$1F', 31],
    ["|CS'USA'", 'USA'],
    ['|CS"USA"', 'USA']
  ])('%s', (text, expected) => {
    expect(literalValue(text)).toBe(expected);
  });

  it.each(['', 'C_Other', '(1 + 2)', '|CI$', '|CI$123456789', '|CX1'])(
    'is undefined for %j',
    (text) => {
      expect(literalValue(text)).toBeUndefined();
    }
  );
});

describe('constantType', () => {
  it.each([
    ['text', 'String'],
    [1, 'Integer'],
    [-1, 'Integer'],
    [0.5, 'Number'],
    [true, 'Boolean']
  ])('%j is %s', (value, expected) => {
    expect(constantType(value)).toBe(expected);
  });
});
