import type { DfParam } from '@vscode-dataflex/parser';
import type { ConstantValue } from '@vscode-dataflex/workspace';

/**
 * Builds hover markdown.
 *
 * Kept pure -- facts in, markdown out -- so every rule below can be asserted directly. The provider
 * around it needs a server, an index and a real workspace before it can say anything at all.
 *
 * The guiding rule is that a row appears only when it has something to say. A DataFlex hover has
 * many *possible* facts (hierarchy, overrides, publication, arity, counts) and showing empty
 * labels for the ones that do not apply would bury the one or two that matter.
 */

/** What the hover knows about a local, a parameter or a struct field. */
export interface LocalFacts {
  kind: 'local' | 'parameter' | 'field';
  name: string;
  type?: string;
  byRef?: boolean;
  /** Enclosing procedure, function or struct. */
  container?: string;
}

/** What the hover knows about an indexed declaration. */
export interface DeclarationFacts {
  kind: string;
  name: string;
  file: string;
  /** Shortened path, as the provider renders it. */
  where: string;
  params?: DfParam[];
  /** Return type of a function, or declared type of a property or variable. */
  type?: string;
  isSetter?: boolean;
  superClass?: string;
  doc?: string;

  /** Resolved `is a` chain, outermost last. Empty when the class is unknown. */
  hierarchy?: string[];
  /**
   * Protocols the class mixes in with `Import_Class_Protocol`.
   *
   * DataFlex composes as much by mixin as by inheritance -- 30% of the classes on a real search
   * path import at least one, and `cWebApp` pulls in fourteen that between them contribute over
   * three hundred members. None of that appears in the `is a` chain, so a hover that shows only
   * the chain is describing half the class.
   */
  mixins?: string[];
  /** The ancestor member this one overrides. */
  overrides?: { declaringClass: string; name: string };
  /** Token occurrences of the name across the workspace, declarations excluded. */
  uses?: number;
  /** True when the name has exactly one declaration and it is the workspace's own. */
  usesAreExact?: boolean;

  published?: boolean;
  webPublished?: boolean;
  webProperty?: string;
  visibility?: string;
  acceptsVariableArguments?: boolean;

  /** Absolute documentation URL, when one could be constructed with confidence. */
  docsUrl?: string;
  /**
   * One-line summary from the documentation page.
   *
   * Rendered above the link so the common case -- "what does `Save` actually do?" -- is answered
   * in the hover rather than one click away. Absent for the ~9% of pages that carry no prose.
   */
  docsSummary?: string;

  /**
   * The other declarations sharing this name.
   *
   * Summarised on one line rather than rendered as further cards. DataFlex has one flat namespace
   * and framework names repeat heavily -- `psCaption` is declared 18 times across the Web UI --
   * so a second full card is near-identical to the first and reads as the hover having duplicated
   * itself.
   */
  others?: { count: number; where: string[] };

  /**
   * The table a data dictionary manages.
   *
   * `number` and `fieldCount` are filled in only when the workspace has the table's `.fd` file;
   * without it the name is still worth showing, since it is what the DD itself declares.
   */
  manages?: { table: string; number?: number; fieldCount?: number };

  /**
   * Members of a `Struct`, in declaration order.
   *
   * Rendered in the signature block, aligned like a parameter list. `Struct tRow` alone tells the
   * reader nothing they could not read off the name; the members are the whole content.
   */
  fields?: { name: string; type?: string; doc?: string }[];

  /** True for a `Global_Variable` declaration. */
  isGlobal?: boolean;
  /**
   * Class a global handle was resolved to hold.
   *
   * A `Handle` says nothing on its own; the assignment says everything. Only set when every
   * assignment in the workspace agrees.
   */
  holdsClass?: string;
  /** Where that assignment is, quoted so the reader can judge it rather than trust it. */
  assignedAt?: { text: string; where: string; line: number };

  /** What a `Define` is defined as, verbatim, for the head line. */
  value?: string;
  /** `#REPLACE` or `#DEFINE` when the constant was written as a directive rather than `Define`. */
  directive?: string;
  /**
   * What the constant is actually worth, once aliases and enum positions are followed.
   *
   * The head shows the declaration as written, which for `Define alignRight` inside an
   * `Enum_List` or `Define C_IconDefault for C_Icon_ShowHistory` says nothing about the value;
   * this is the number or string behind it, and the type the reader would otherwise have to infer.
   */
  constant?: { value: ConstantValue; type: string; fromEnum?: boolean };
}

/** Longest chain rendered before it is elided; DataFlex hierarchies run deep. */
const MAX_CHAIN = 5;

export function localHover(facts: LocalFacts): string {
  const parts: string[] = [];
  const modifier = facts.byRef === true ? 'ByRef ' : '';
  const signature = `${facts.type ?? ''} ${modifier}${facts.name}`.trim();
  parts.push('```dataflex', signature, '```');

  const label =
    facts.kind === 'parameter'
      ? 'Parameter'
      : facts.kind === 'field'
        ? 'Struct field'
        : 'Local variable';
  parts.push(
    facts.container === undefined ? `_${label}_` : `_${label} of \`${facts.container}\`_`
  );

  return parts.join('\n');
}

/** What the hover can say about a database table or one of its columns. */
export interface TableFacts {
  table: string;
  /** Filelist number the compiler assigned. */
  tableNumber: number;
  /** Set for a column hover; absent when the cursor is on the table itself. */
  field?: { name: string; type: string; number: number; length?: number; isFileNumber?: boolean };
  /** How many columns the table has, shown when the hover is about the table. */
  fieldCount: number;
  /**
   * The columns themselves, listed when `dataflex.hover.tableFields` asks for them.
   *
   * Off by default: a table hover fires on every `Open Customer` and every DDO line, and a real workspace has
   * tables with 48 columns. The count alone is the right answer most of the time; the list is for
   * when someone is actually working out what a table holds.
   */
  fields?: { name: string; type: string; number: number; length?: number }[];
  /** Short path of the `.fd` file the facts came from, so the reader can check them. */
  where: string;
}

/**
 * The hover for `Customer` or `Customer.Name`.
 *
 * Says only what the `.fd` file states. Column length and the SQL type behind it live in the
 * database rather than in the field definition, so they are not claimed here.
 */
export function tableHover(facts: TableFacts): string {
  const parts: string[] = [];

  if (facts.field === undefined) {
    const listed = facts.fields ?? [];
    if (listed.length === 0) {
      parts.push('```dataflex', facts.table, '```');
    } else {
      const shown = listed.slice(0, MAX_FIELDS);
      const width = Math.max(...shown.map((field) => field.type.length));
      const lines = shown.map((field) => `    ${field.type.padEnd(width)} ${field.name}`);
      if (listed.length > shown.length) {
        lines.push(`    // ${listed.length - shown.length} more`);
      }
      parts.push('```dataflex', facts.table, ...lines, '```');
    }
    parts.push(
      `_Database table #${facts.tableNumber}, ${facts.fieldCount} ${
        facts.fieldCount === 1 ? 'field' : 'fields'
      }_`
    );
    if (listed.length === 0 && facts.fieldCount > 0) {
      // The setting is off by default and a reader has no way to discover it from the hover
      // itself, so the hover says where it is. One line, and only when the list is absent.
      parts.push('', '_Set `dataflex.hover.tableFields` to list them._');
    }
  } else if (facts.field.isFileNumber === true) {
    parts.push('```dataflex', `${facts.table}.File_Number`, '```');
    parts.push(`_The filelist number of table \`${facts.table}\` — ${facts.tableNumber}_`);
  } else {
    // The length is stated only when the workspace states it: `.fd` files carry none, and only a
    // `.int` connection file pins one, for the minority of columns that have it.
    const size = facts.field.length === undefined ? '' : `[${facts.field.length}]`;
    parts.push(
      '```dataflex',
      `${facts.field.type}${size} ${facts.table}.${facts.field.name}`,
      '```'
    );
    parts.push(
      `_Field ${facts.field.number} of table \`${facts.table}\` (#${facts.tableNumber})_`
    );
  }

  parts.push('', row('In', `\`${facts.where}\``));
  return parts.join('\n');
}

/** What the hover can say about a language command, as opposed to a declared symbol. */
export interface CommandFacts {
  /** The word as written in the source, so the hover echoes the author's casing. */
  name: string;
  /** One-line summary from the documentation page. */
  summary?: string;
  docsUrl: string;
  /**
   * What to call it.
   *
   * `Save` is a command; `Self` and `File_Field` are keywords and calling them commands would be
   * wrong in a way a DataFlex reader would notice.
   */
  label?: string;
}

/**
 * The hover for a built-in command.
 *
 * Deliberately small. A command is not a declaration -- there is no file to cite, no signature to
 * render and no use count worth counting, since `Move` appears tens of thousands of times in any
 * workspace. What a reader wants is what it does and where to read more.
 */
export function commandHover(facts: CommandFacts): string {
  const parts: string[] = ['```dataflex', facts.name, '```', `_${facts.label ?? 'DataFlex command'}_`];
  if (facts.summary !== undefined && facts.summary.length > 0) {
    parts.push('', facts.summary);
  }
  parts.push('', `[${facts.name} in the DataFlex documentation](${facts.docsUrl})`);
  return parts.join('\n');
}

export function declarationHover(facts: DeclarationFacts): string {
  const parts: string[] = [];

  parts.push('```dataflex', signatureBlock(facts), '```');

  const call = callSyntax(facts);
  if (call !== undefined) {
    parts.push('```dataflex', call, '```');
  }

  const rows: string[] = [];
  const chain = renderHierarchy(facts);
  if (chain !== undefined) {
    rows.push(row('Inherits', chain));
  }
  const mixins = renderMixins(facts);
  if (mixins !== undefined) {
    rows.push(row('Mixes in', mixins));
  }
  if (facts.overrides !== undefined) {
    rows.push(row('Overrides', `\`${facts.overrides.declaringClass}.${facts.overrides.name}\``));
  }
  if (facts.manages !== undefined) {
    const detail =
      facts.manages.number === undefined
        ? ''
        : ` — table #${facts.manages.number}, ${facts.manages.fieldCount} ${
            facts.manages.fieldCount === 1 ? 'field' : 'fields'
          }`;
    rows.push(row('Manages', `\`${facts.manages.table}\`${detail}`));
  }
  if (facts.holdsClass !== undefined) {
    rows.push(row('Holds', `\`${facts.holdsClass}\``));
  }
  if (facts.assignedAt !== undefined) {
    rows.push(
      row(
        'Assigned',
        `\`${facts.assignedAt.text}\` — \`${facts.assignedAt.where}:${facts.assignedAt.line + 1}\``
      )
    );
  }
  if (facts.constant !== undefined) {
    const rendered = renderConstant(facts.constant.value);
    // `Define C_Max for 100` already says 100 in the head; only an alias, an enum member or a
    // `|CI$FF` has a value the head does not show.
    if (rendered !== facts.value?.trim()) {
      const note = facts.constant.fromEnum === true ? ' — position in its `Enum_List`' : '';
      rows.push(row('Value', `\`${rendered}\`${note}`));
    }
    rows.push(row('Type', facts.constant.type));
  }
  const uses = renderUses(facts);
  if (uses !== undefined) {
    rows.push(row('Uses', uses));
  }
  rows.push(row('In', `\`${facts.where}\``));
  const others = renderOthers(facts);
  if (others !== undefined) {
    rows.push(row('Also in', others));
  }
  parts.push(rows.join('\n'));

  const badges = renderBadges(facts);
  if (badges.length > 0) {
    parts.push('', badges.join(' · '));
  }

  if (facts.doc !== undefined && facts.doc.trim().length > 0) {
    parts.push('', facts.doc.trim());
  }

  if (facts.docsSummary !== undefined && facts.docsSummary.length > 0) {
    parts.push('', facts.docsSummary);
  }

  if (facts.docsUrl !== undefined) {
    parts.push('', `[${facts.name} in the DataFlex documentation](${facts.docsUrl})`);
  }

  return parts.join('\n');
}

/**
 * Longest mixin list rendered before it is elided.
 *
 * Shorter than the inheritance chain because the names are long -- `cWebFileUploadPathHelper_mixin`
 * is thirty characters -- and the count carries most of the meaning once there are several.
 */
const MAX_MIXINS = 3;

function renderMixins(facts: DeclarationFacts): string | undefined {
  const mixins = facts.mixins ?? [];
  if (mixins.length === 0) {
    return undefined;
  }
  const shown = mixins.slice(0, MAX_MIXINS).map((name) => `\`${name}\``);
  const rest = mixins.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} … ${rest} more` : shown.join(', ');
}

/** A labelled line. Two spaces at the end make VS Code honour the break inside a paragraph. */
function row(label: string, value: string): string {
  return `**${label}** ${value}  `;
}

/** A constant's value as DataFlex source would spell it, so it compares with the head. */
function renderConstant(value: ConstantValue): string {
  switch (typeof value) {
    case 'string':
      return `"${value}"`;
    case 'boolean':
      return value ? 'True' : 'False';
    default:
      return String(value);
  }
}

/**
 * The declaration itself, one parameter per line.
 *
 * A DataFlex parameter list has no separators, so running it inline reads as a single long string
 * of type/name pairs; a line each is what makes an eight-parameter framework event legible.
 */
/** Longest member list rendered in full before it is elided. */
const MAX_FIELDS = 12;

function signatureBlock(facts: DeclarationFacts): string {
  const head = headOf(facts);

  const fields = facts.fields ?? [];
  if (fields.length > 0) {
    const shown = fields.slice(0, MAX_FIELDS);
    const width = Math.max(...shown.map((field) => (field.type ?? '').length));
    const lines = shown.map(
      (field) => `    ${(field.type ?? '').padEnd(width)} ${field.name}`.trimEnd()
    );
    if (fields.length > shown.length) {
      lines.push(`    // ${fields.length - shown.length} more`);
    }
    return [head, ...lines, 'End_Struct'].join('\n');
  }

  const params = facts.params ?? [];
  if (params.length === 0) {
    return head;
  }

  const width = Math.max(...params.map((param) => (param.type ?? '').length));
  const lines = params.map((param) => {
    const type = (param.type ?? '').padEnd(width);
    return `    ${type} ${param.byRef ? 'ByRef ' : ''}${param.name}`.trimEnd();
  });
  return [head, ...lines].join('\n');
}

function headOf(facts: DeclarationFacts): string {
  switch (facts.kind) {
    case 'procedure':
      return facts.isSetter === true
        ? `Procedure Set ${facts.name}`
        : `Procedure ${facts.name}`;
    case 'function':
      return facts.type === undefined
        ? `Function ${facts.name}`
        : `Function ${facts.name} Returns ${facts.type}`;
    case 'class':
      return facts.superClass === undefined
        ? `Class ${facts.name}`
        : `Class ${facts.name} is a ${facts.superClass}`;
    case 'object':
      return facts.superClass === undefined
        ? `Object ${facts.name}`
        : `Object ${facts.name} is a ${facts.superClass}`;
    case 'struct':
      return `Struct ${facts.name}`;
    case 'property':
      return `Property ${facts.type ?? ''} ${facts.name}`.replace(/\s+/g, ' ').trim();
    case 'variable':
      return facts.isGlobal === true
        ? `Global_Variable ${facts.type ?? ''} ${facts.name}`.replace(/\s+/g, ' ').trim()
        : `${facts.type ?? ''} ${facts.name}`.replace(/\s+/g, ' ').trim();
    case 'define':
      // As written: `Define X for <value>`, or `#REPLACE X <value>`, which has no `for`.
      if (facts.value === undefined) {
        return `${facts.directive ?? 'Define'} ${facts.name}`;
      }
      return facts.directive === undefined
        ? `Define ${facts.name} for ${facts.value}`
        : `${facts.directive} ${facts.name} ${facts.value}`;
    case 'enumValue':
      return facts.value === undefined
        ? `Define ${facts.name}`
        : `Define ${facts.name} for ${facts.value}`;
    default:
      return `${facts.kind} ${facts.name}`;
  }
}

/**
 * How the thing is actually invoked.
 *
 * DataFlex splits invocation three ways by what is being called, and a C-style signature says none
 * of it: you cannot tell from `(String sTitle, Integer iMode)` whether to write `Send`, `Get ... to`
 * or `Set ... to`. Parameter names double as the placeholders, which is what makes the line
 * readable as an example rather than a grammar.
 */
export function callSyntax(facts: DeclarationFacts): string | undefined {
  const names = (facts.params ?? []).map((param) => param.name);
  const args = names.length === 0 ? '' : ` ${names.join(' ')}`;

  if (facts.kind === 'procedure') {
    return facts.isSetter === true
      ? `Set ${facts.name} to ${names[0] ?? 'value'}`
      : `Send ${facts.name}${args}`;
  }
  if (facts.kind === 'function') {
    return `Get ${facts.name}${args} to ${resultName(facts.type)}`;
  }
  if (facts.kind === 'property') {
    return `Get ${facts.name} to ${resultName(facts.type)}`;
  }
  return undefined;
}

/** A plausible destination variable, so the example line reads like real code. */
function resultName(type: string | undefined): string {
  switch ((type ?? '').toLowerCase()) {
    case 'string':
      return 'sResult';
    case 'integer':
    case 'number':
      return 'iResult';
    case 'boolean':
      return 'bResult';
    case 'handle':
      return 'hoResult';
    case 'date':
    case 'datetime':
      return 'dResult';
    default:
      return 'result';
  }
}

function renderHierarchy(facts: DeclarationFacts): string | undefined {
  const chain = facts.hierarchy ?? [];
  if (chain.length < 2) {
    return undefined;
  }
  const shown = chain.slice(0, MAX_CHAIN).map((name) => `\`${name}\``);
  const rest = chain.length - MAX_CHAIN;
  return rest > 0 ? `${shown.join(' → ')} → … (${rest} more)` : shown.join(' → ');
}

/**
 * The reference count, worded to match what was actually counted.
 *
 * Counting is by name, not by resolved target: DataFlex dispatches dynamically, so every
 * `Send Refresh` in the workspace counts toward every `Refresh` declared anywhere. Only when the
 * name has a single declaration, and it is the workspace's own, is "references" the honest word.
 */
function renderUses(facts: DeclarationFacts): string | undefined {
  const uses = facts.uses;
  if (uses === undefined || uses <= 0) {
    return undefined;
  }
  return facts.usesAreExact === true
    ? `${uses} ${uses === 1 ? 'reference' : 'references'}`
    : `${uses} occurrences of this name`;
}

/** Where else the name is declared, named for the first few and counted for the rest. */
function renderOthers(facts: DeclarationFacts): string | undefined {
  const others = facts.others;
  if (others === undefined || others.count <= 0) {
    return undefined;
  }
  const named = others.where.slice(0, 3).map((where) => `\`${where}\``);
  const rest = others.count - named.length;
  return rest > 0 ? `${named.join(', ')} and ${rest} more` : named.join(', ');
}

function renderBadges(facts: DeclarationFacts): string[] {
  const badges: string[] = [];
  if (facts.published === true) {
    badges.push('_published_');
  }
  if (facts.webPublished === true) {
    badges.push('_web-published_');
  }
  if (facts.webProperty !== undefined) {
    badges.push(`_web property (${facts.webProperty})_`);
  }
  if (facts.visibility !== undefined) {
    badges.push(`_${facts.visibility.toLowerCase()}_`);
  }
  if (facts.acceptsVariableArguments === true) {
    badges.push('_accepts a variable number of arguments_');
  }
  return badges;
}
