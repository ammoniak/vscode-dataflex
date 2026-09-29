import { describe, expect, it } from 'vitest';
import { TableIndex, parseFieldDefinition, parseFieldLengths } from '../src/tableIndex';

/**
 * Reading tables out of `.fd` field-definition files.
 *
 * These are the compiler's own answer for what tables exist and what columns they have, which is
 * why the hover trusts them and does not go near the binary `Filelist.cfg`.
 */

const CUSTOMER = [
  '#REPLACE FILE25 Customer',
  '#REPLACE Customer.Recnum |FN25,0',
  '#REPLACE Customer.Customer_Number |FN25,1',
  '#REPLACE Customer.Name |FS25,2',
  '#REPLACE Customer.Created |FD25,3',
  '#REPLACE Customer.LastSeen |FM25,4',
  ''
].join('\n');

const FILE = 'C:\\ws\\DDSrc\\Customer.fd';

describe('parseFieldDefinition', () => {
  it('reads the table name and its filelist number', () => {
    const table = parseFieldDefinition(CUSTOMER, FILE);
    expect(table?.name).toBe('Customer');
    expect(table?.number).toBe(25);
    expect(table?.file).toBe(FILE);
  });

  it('reads every column with its number', () => {
    const table = parseFieldDefinition(CUSTOMER, FILE);
    expect(table?.fields.map((f) => `${f.name}#${f.number}`)).toEqual([
      'Recnum#0',
      'Customer_Number#1',
      'Name#2',
      'Created#3',
      'LastSeen#4'
    ]);
  });

  /**
   * `S`, `N` and `D` are documented. `M` is not, but the code settles it: a `D` field is assigned
   * `(Date(CurrentDateTime()))` while an `M` field beside it takes `(CurrentDateTime())` whole.
   */
  it('names the four type letters that occur', () => {
    const table = parseFieldDefinition(CUSTOMER, FILE);
    expect(table?.fields.map((f) => f.type)).toEqual([
      'Number',
      'Number',
      'String',
      'Date',
      'DateTime'
    ]);
  });

  it('shows an unknown type letter as itself rather than inventing a name', () => {
    const table = parseFieldDefinition(
      '#REPLACE FILE9 Odd\n#REPLACE Odd.Thing |FZ9,1\n',
      'C:\\ws\\Odd.fd'
    );
    expect(table?.fields[0]?.type).toBe('Z');
  });

  /** Without a `FILE<n>` header there is no table to attach columns to. */
  it('answers nothing for a file with no header', () => {
    expect(parseFieldDefinition('#REPLACE Customer.Name |FS25,2\n', FILE)).toBeUndefined();
  });

  it('ignores lines that are not field definitions', () => {
    const table = parseFieldDefinition(
      ['// a comment', '', '#REPLACE FILE7 Small', 'garbage', '#REPLACE Small.A |FS7,1'].join('\n'),
      'C:\\ws\\Small.fd'
    );
    expect(table?.fields).toHaveLength(1);
    expect(table?.fields[0]?.name).toBe('A');
  });

  it('answers nothing for an empty file', () => {
    expect(parseFieldDefinition('', FILE)).toBeUndefined();
  });
});

describe('TableIndex', () => {
  function indexed(): TableIndex {
    const index = new TableIndex();
    index.addFile(FILE, CUSTOMER);
    return index;
  }

  it('finds a table however it is cased', () => {
    // DataFlex source is case-insensitive, so `customer.name` means the same table.
    expect(indexed().table('CUSTOMER')?.number).toBe(25);
    expect(indexed().table('customer')?.number).toBe(25);
  });

  it('resolves a dotted reference, which is how the lexer hands them over', () => {
    const found = indexed().resolveDotted('Customer.Name');
    expect(found?.table.name).toBe('Customer');
    expect(found?.field.name).toBe('Name');
    expect(found?.field.type).toBe('String');
    expect(found?.field.number).toBe(2);
  });

  it('resolves a dotted reference case-insensitively', () => {
    expect(indexed().resolveDotted('customer.NAME')?.field.name).toBe('Name');
  });

  it('answers nothing for a column the table does not have', () => {
    expect(indexed().resolveDotted('Customer.NoSuchColumn')).toBeUndefined();
  });

  it('answers nothing for a table it has never seen', () => {
    expect(indexed().resolveDotted('Orders.Total')).toBeUndefined();
    expect(indexed().table('Orders')).toBeUndefined();
  });

  /** A dotted name is not always a table: `myRow.iValue` is a struct, and must not match. */
  it('answers nothing for a dotted name that is not a table at all', () => {
    expect(indexed().resolveDotted('myRow.iValue')).toBeUndefined();
  });

  it('answers nothing for text with no dot, or a trailing dot', () => {
    expect(indexed().resolveDotted('Customer')).toBeUndefined();
    expect(indexed().resolveDotted('Customer.')).toBeUndefined();
    expect(indexed().resolveDotted('')).toBeUndefined();
  });

  /** Re-reading a file must replace what it contributed, not add to it. */
  it('replaces a file rather than duplicating it', () => {
    const index = indexed();
    expect(index.size).toBe(1);

    index.addFile(FILE, '#REPLACE FILE25 Customer\n#REPLACE Customer.Only |FS25,1\n');
    expect(index.size).toBe(1);
    expect(index.table('Customer')?.fields).toHaveLength(1);
    expect(index.resolveDotted('Customer.Name')).toBeUndefined();
  });

  it('drops a file that no longer defines a table', () => {
    const index = indexed();
    index.addFile(FILE, '// emptied\n');
    expect(index.size).toBe(0);
  });
});

/**
 * `Customer.File_Number` is not a column but a compile-time constant, and it is the single most
 * common dotted name in a `.dd` file: `Set Main_File to Customer.File_Number`.
 */
describe('File_Number', () => {
  function indexed(): TableIndex {
    const index = new TableIndex();
    index.addFile(FILE, CUSTOMER);
    return index;
  }

  it('resolves to the table number', () => {
    const found = indexed().resolveDotted('Customer.File_Number');
    expect(found?.field.isFileNumber).toBe(true);
    expect(found?.field.number).toBe(25);
    expect(found?.table.name).toBe('Customer');
  });

  it('resolves however it is cased', () => {
    expect(indexed().resolveDotted('customer.file_number')?.field.isFileNumber).toBe(true);
  });

  it('is not counted among the table columns', () => {
    expect(indexed().table('Customer')?.fields.some((f) => f.name === 'File_Number')).toBe(false);
  });

  /** The newer `.fd` format spells it out; the older one does not, and both must work. */
  it('works whether or not the file declares the |CI line', () => {
    const withLine = new TableIndex();
    withLine.addFile(FILE, CUSTOMER.replace('#REPLACE FILE25 Customer', '#REPLACE FILE25 Customer\n#REPLACE Customer.File_Number |CI25'));
    expect(withLine.resolveDotted('Customer.File_Number')?.field.number).toBe(25);
    expect(withLine.table('Customer')?.fields).toHaveLength(5);
  });

  it('says nothing for a table that does not exist', () => {
    expect(indexed().resolveDotted('Nope.File_Number')).toBeUndefined();
  });
});

/**
 * Field lengths, from the `.int` connection files.
 *
 * A `.fd` carries type, table and field number but never a length -- for a SQL-backed table the
 * length belongs to the database. The only readable place it appears is a `.int`, and only for the
 * columns whose length was pinned by hand: 139 of 3,033 fields on a real workspace. Everything
 * else shows no length rather than a guessed one.
 */
describe('field lengths', () => {
  const INT = [
    'DRIVER_NAME MSSQLDRV',
    'DATABASE_NAME Customer',
    '',
    'FIELD_NUMBER 2',
    'FIELD_LENGTH 60',
    '',
    'FIELD_NUMBER 3',
    'FIELD_INDEX 1',
    '',
    'INDEX_NUMBER 1',
    ''
  ].join('\n');

  it('reads a length out of the per-field block', () => {
    const lengths = parseFieldLengths(INT);
    expect(lengths.get(2)).toBe(60);
  });

  it('ignores a field block that states no length', () => {
    expect(parseFieldLengths(INT).has(3)).toBe(false);
  });

  it('reads nothing from a file with no field blocks', () => {
    expect(parseFieldLengths('DRIVER_NAME MSSQLDRV\n').size).toBe(0);
  });

  /** The two files are read in whatever order the directory walk produced. */
  it('applies the length when the .int is read after the .fd', () => {
    const index = new TableIndex();
    index.addFile(FILE, CUSTOMER);
    index.addFile('C:\\ws\\Data\\Customer.int', INT);
    expect(index.resolveDotted('Customer.Name')?.field.length).toBe(60);
  });

  it('applies it when the .int is read first', () => {
    const index = new TableIndex();
    index.addFile('C:\\ws\\Data\\Customer.int', INT);
    index.addFile(FILE, CUSTOMER);
    expect(index.resolveDotted('Customer.Name')?.field.length).toBe(60);
  });

  /** A Windows path is split on backslashes; getting that wrong names the table after the path. */
  it('takes the table name from the file, not the whole path', () => {
    const index = new TableIndex();
    index.addFile(FILE, CUSTOMER);
    index.addFile('C:\\deep\\nested\\Data\\Customer.int', INT);
    expect(index.resolveDotted('Customer.Name')?.field.length).toBe(60);
  });

  it('leaves a field with no stated length alone', () => {
    const index = new TableIndex();
    index.addFile(FILE, CUSTOMER);
    index.addFile('C:\\ws\\Data\\Customer.int', INT);
    expect(index.resolveDotted('Customer.Recnum')?.field.length).toBeUndefined();
  });
});
