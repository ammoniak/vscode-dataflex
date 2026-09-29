import { readFileSync } from 'node:fs';

/**
 * What the workspace knows about database tables and their columns.
 *
 * The source is the `.fd` files the Studio generates beside the data dictionaries, which is the
 * same thing the compiler reads to make `Customer.Name` resolve. They are plain text and tiny --
 * one line per field:
 *
 *     #REPLACE FILE25 Customer
 *     #REPLACE Customer.Recnum |FN25,0
 *     #REPLACE Customer.Name   |FS25,2
 *
 * so the table's number, its columns, their types and their field numbers are all recoverable
 * without touching the database.
 *
 * `Filelist.cfg` is deliberately not read. It is the other place this information lives, but it is
 * a binary fixed-width format with no published layout, and it sits in `Data/`, which the indexer
 * skips. A table with no `.fd` file simply gets no hover -- the same discipline the documentation
 * links follow, where saying nothing beats saying something invented.
 */

/** One column of a table. */
export interface TableField {
  /** Field name as the `.fd` file spells it, without the table prefix. */
  name: string;
  /** `String`, `Number`, `Date`, `DateTime`, or the raw letter when it is one we do not know. */
  type: string;
  /** Position in the record, as DataFlex numbers it. Field 0 is the record number. */
  number: number;
  /**
   * Declared length, when the workspace states one.
   *
   * `.fd` files carry type, table and field number but never a length -- for a SQL-backed table
   * the length belongs to the database, and for an embedded one it is in the binary header. The
   * only place it appears in readable form is a `.int` connection file, and only for the columns
   * whose length was pinned by hand. Absent for most fields, which is why the hover omits the line
   * rather than guessing.
   */
  length?: number;
  /**
   * True for `<Table>.File_Number`, which is not a column at all.
   *
   * The `.fd` file spells it `#REPLACE Abo.File_Number |CI63` -- a compile-time constant holding
   * the table's filelist number. It matters because it is the expression every data dictionary
   * uses: `Set Main_File to Customer.File_Number`. Without this a hover on the most common dotted
   * name in a `.dd` file would find nothing.
   */
  isFileNumber?: boolean;
}

/** One table, as a `.fd` file describes it. */
export interface TableInfo {
  /** Table name as the `.fd` file spells it. */
  name: string;
  /** The filelist number the compiler assigned. */
  number: number;
  fields: TableField[];
  /** Absolute path of the `.fd` file, so a hover can cite it. */
  file: string;
}

/**
 * Type letters used in the `|F<letter><table>,<field>` encoding.
 *
 * `S`, `N` and `D` are confirmed by the documentation. `M` is not documented, but the code settles
 * it: a `D` field is assigned `(Date(CurrentDateTime()))` while an `M` field beside it takes
 * `(CurrentDateTime())` unwrapped, so `M` carries the time component too.
 */
const FIELD_TYPES: ReadonlyMap<string, string> = new Map([
  ['S', 'String'],
  ['N', 'Number'],
  ['D', 'Date'],
  ['M', 'DateTime']
]);

/** `#REPLACE FILE25 Customer` -- the table's number and name. */
const HEADER = /^#REPLACE\s+FILE(\d+)\s+(\S+)\s*$/i;

/** `FIELD_NUMBER 82` in a `.int` connection file, opening a per-field block. */
const INT_FIELD_NUMBER = /^FIELD_NUMBER\s+(\d+)\s*$/i;

/** `FIELD_LENGTH 6`, applying to the field number most recently opened. */
const INT_FIELD_LENGTH = /^FIELD_LENGTH\s+(\d+)\s*$/i;

/** `#REPLACE Customer.Name |FS25,2` -- one column. */
const FIELD = /^#REPLACE\s+([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s+\|F([A-Za-z])(\d+),(\d+)\s*$/i;

/**
 * Reads one `.fd` file.
 *
 * Returns `undefined` when the file carries no `FILE<n>` header. Without it there is no table name
 * to attach the columns to, and a file that far from the expected shape is not one to guess about.
 */
export function parseFieldDefinition(text: string, file: string): TableInfo | undefined {
  let table: TableInfo | undefined;
  const fields: TableField[] = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const header = HEADER.exec(trimmed);
    if (header !== null) {
      table = { name: header[2]!, number: Number(header[1]), fields, file };
      continue;
    }

    const field = FIELD.exec(trimmed);
    if (field !== null) {
      const letter = field[3]!.toUpperCase();
      fields.push({
        name: field[2]!,
        type: FIELD_TYPES.get(letter) ?? letter,
        number: Number(field[5])
      });
    }
  }

  return table;
}

/**
 * Field lengths from a `.int` connection file, by field number.
 *
 * The file is a flat list of keyword/value lines; a `FIELD_NUMBER` opens a block and the keys
 * after it belong to that field until the next one.
 */
export function parseFieldLengths(text: string): Map<number, number> {
  const lengths = new Map<number, number>();
  let current: number | undefined;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const opens = INT_FIELD_NUMBER.exec(trimmed);
    if (opens !== null) {
      current = Number(opens[1]);
      continue;
    }
    const length = INT_FIELD_LENGTH.exec(trimmed);
    if (length !== null && current !== undefined) {
      lengths.set(current, Number(length[1]));
    }
  }
  return lengths;
}

/**
 * Tables in the workspace, by name.
 *
 * Kept apart from `SymbolIndex` on purpose. A table is not a declaration: it has no `Class` or
 * `Procedure` behind it, nothing overrides it, and counting `Customer` as a declared symbol would
 * distort the reference tallies the dead-code rule depends on.
 */
export class TableIndex {
  private readonly tables = new Map<string, TableInfo>();
  private readonly byFile = new Map<string, string>();
  /** Lengths read from `.int` files, held until the matching `.fd` has been read. */
  private readonly lengthsByTable = new Map<string, Map<number, number>>();

  /**
   * Reads one `.fd` or `.int` file into the index, replacing anything it contributed before.
   *
   * A `.int` carries no column list, only lengths for the columns that have one, so it is applied
   * to a table the `.fd` already described -- and remembered, because the two are read in whatever
   * order the directory walk produced.
   */
  addFile(file: string, text?: string): void {
    this.removeFile(file);

    let source = text;
    if (source === undefined) {
      try {
        source = readFileSync(file, 'latin1');
      } catch {
        return;
      }
    }

    if (/\.int$/i.test(file)) {
      // The table is named by the file, since a `.int` never names it inside.
      const name = (file.split(/[\\/]/).pop() ?? '').replace(/\.int$/i, '').toLowerCase();
      const lengths = parseFieldLengths(source);
      if (lengths.size > 0) {
        this.lengthsByTable.set(name, lengths);
        this.applyLengths(name);
      }
      return;
    }

    const table = parseFieldDefinition(source, file);
    if (table === undefined) {
      return;
    }
    this.tables.set(table.name.toLowerCase(), table);
    this.byFile.set(file.toLowerCase(), table.name.toLowerCase());
    this.applyLengths(table.name.toLowerCase());
  }

  /** Copies any known lengths onto a table's columns, whichever file arrived first. */
  private applyLengths(tableKey: string): void {
    const table = this.tables.get(tableKey);
    const lengths = this.lengthsByTable.get(tableKey);
    if (table === undefined || lengths === undefined) {
      return;
    }
    for (const field of table.fields) {
      const length = lengths.get(field.number);
      if (length !== undefined) {
        field.length = length;
      }
    }
  }

  removeFile(file: string): void {
    const key = file.toLowerCase();
    const table = this.byFile.get(key);
    if (table !== undefined) {
      this.tables.delete(table);
      this.byFile.delete(key);
    }
  }

  /** The table of that name, or `undefined`. */
  table(name: string): TableInfo | undefined {
    return this.tables.get(name.toLowerCase());
  }

  /** One column, addressed as `Customer` / `Name`. */
  field(table: string, field: string): { table: TableInfo; field: TableField } | undefined {
    const found = this.table(table);
    if (found === undefined) {
      return undefined;
    }
    const key = field.toLowerCase();
    const column = found.fields.find((entry) => entry.name.toLowerCase() === key);
    if (column !== undefined) {
      return { table: found, field: column };
    }
    if (key === 'file_number') {
      // Synthesised rather than stored: it is the same fact as `TableInfo.number`, and older `.fd`
      // files (the shipped WebOrder example among them) omit the line while the constant still
      // works.
      return {
        table: found,
        field: { name: 'File_Number', type: 'Integer', number: found.number, isFileNumber: true }
      };
    }
    return undefined;
  }

  /** Resolves a dotted `Customer.Name`, which is how the lexer hands them over. */
  resolveDotted(text: string): { table: TableInfo; field: TableField } | undefined {
    const dot = text.indexOf('.');
    if (dot <= 0 || dot === text.length - 1) {
      return undefined;
    }
    return this.field(text.slice(0, dot), text.slice(dot + 1));
  }

  get size(): number {
    return this.tables.size;
  }

  /** Every table, for reporting how much of the workspace this covers. */
  all(): TableInfo[] {
    return [...this.tables.values()];
  }
}
