import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import {
  Hover,
  Location,
  MarkupKind,
  Position,
  SymbolInformation
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  DfNode,
  Range as DfRange,
  STATEMENT_VERBS,
  SourceUnit,
  nodeChainAt
} from '@vscode-dataflex/parser';
import { constantType, declaredConstantValue } from '@vscode-dataflex/workspace';
import type {
  Declaration,
  IncludeResolver,
  ReferenceContext,
  SymbolIndex,
  TableIndex
} from '@vscode-dataflex/workspace';
import { SYMBOL_KINDS } from './documentSymbols';
import { commandHover, declarationHover, localHover, tableHover } from './hoverContent';
import type { DeclarationFacts, LocalFacts } from './hoverContent';
import { docsEntryFor, docsEntryForCommand, docsPlatform, documentsMember } from './docsLink';
import { findOverridden } from '../analysis/overrides';
import { isWorkspaceOwnedFile } from '../analysis/workspaceFiles';

/**
 * DataFlex identifiers may contain `_`, `$` and a trailing `#`.
 *
 * A default word pattern stops at `$`, which would look up `Is` instead of `Is$WebApp`. The
 * dotted form is deliberately excluded so clicking `Name` in `Customer.Name` searches for the
 * part under the cursor rather than the whole qualified name.
 */
const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*#?/g;

/** The identifier under `position`, with its range, or `undefined`. */
export function wordAt(
  document: TextDocument,
  position: Position
): { text: string; range: DfRange } | undefined {
  const line = document.getText({
    start: { line: position.line, character: 0 },
    end: { line: position.line, character: Number.MAX_SAFE_INTEGER }
  });

  IDENTIFIER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IDENTIFIER.exec(line)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (position.character >= start && position.character <= end) {
      return {
        text: match[0],
        range: {
          start: { line: position.line, character: start },
          end: { line: position.line, character: end }
        }
      };
    }
  }
  return undefined;
}

function withinLine(range: DfRange, position: Position): boolean {
  return (
    position.line === range.start.line &&
    position.character >= range.start.character &&
    position.character <= range.end.character
  );
}

/** Guesses what kind of declaration the cursor most likely refers to. */
function referenceContext(node: DfNode | undefined, position: Position): ReferenceContext {
  if (node === undefined) {
    return 'any';
  }
  if (node.superClassRange !== undefined && withinLine(node.superClassRange, position)) {
    return 'class';
  }
  if (
    node.kind === 'statement' &&
    node.targetRange !== undefined &&
    withinLine(node.targetRange, position)
  ) {
    return 'member';
  }
  return 'any';
}

/**
 * Go to definition.
 *
 * A `Use` / `#Include` name resolves through the compiler search path; anything else is looked up
 * in the workspace declaration index, which covers the workspace, its `DfPkg` package
 * dependencies and the runtime library.
 */
export function definition(
  unit: SourceUnit,
  document: TextDocument,
  position: Position,
  resolver: IncludeResolver | undefined,
  index: SymbolIndex | undefined
): Location[] {
  const chain = nodeChainAt(unit.root, position.line, position.character);
  const node = chain[chain.length - 1];

  if (node !== undefined && (node.kind === 'use' || node.kind === 'include') && node.name !== undefined) {
    let fromDirectory: string | undefined;
    try {
      fromDirectory = dirname(new URL(document.uri).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    } catch {
      fromDirectory = undefined;
    }
    const resolved = resolver?.resolve(node.name, fromDirectory);
    return resolved === undefined
      ? []
      : [
          {
            uri: pathToFileURL(resolved).toString(),
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
          }
        ];
  }

  const word = wordAt(document, position);
  if (word === undefined || index === undefined) {
    return [];
  }

  return index.lookup(word.text, referenceContext(node, position)).map((declaration) => ({
    uri: pathToFileURL(declaration.file).toString(),
    range: declaration.nameRange
  }));
}

function shorten(file: string): string {
  const parts = file.split(/[\\/]/);
  return parts.slice(-2).join('/');
}

export interface HoverOptions {
  /** Base URL for documentation links; empty disables them. */
  docsBaseUrl?: string;
  /** Workspace root, for deciding whether a declaration is the user's own code. */
  root?: string;
  /** Tables read from the workspace's `.fd` files, when they have been indexed. */
  tables?: TableIndex;
  /** List a table's columns in its hover, rather than only counting them. */
  tableFields?: boolean;
}

/**
 * The identifier under the cursor, including any dots.
 *
 * `wordAt` deliberately stops at a dot so that clicking `Name` in `Customer.Name` looks up `Name`.
 * That is right for a symbol, and wrong for a table column, where the qualified pair is the whole
 * point -- `Name` alone belongs to no table. Both are needed, so this is a second reader rather
 * than a change to the first.
 */
const DOTTED = /[A-Za-z_$][A-Za-z0-9_$#]*(?:\[[^\]]*\])?(?:\.[A-Za-z_$][A-Za-z0-9_$#]*(?:\[[^\]]*\])?)+/g;

/** A dotted name under the cursor, and which of its segments the cursor is actually on. */
interface DottedWord {
  text: string;
  segments: string[];
  /** 0 for the head. Anything higher means the cursor is on a member, not on the thing it is in. */
  segment: number;
}

function dottedWordAt(document: TextDocument, position: Position): DottedWord | undefined {
  const line = document.getText({
    start: { line: position.line, character: 0 },
    end: { line: position.line, character: Number.MAX_SAFE_INTEGER }
  });
  DOTTED.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DOTTED.exec(line)) !== null) {
    const start = match.index;
    if (position.character < start || position.character > start + match[0].length) {
      continue;
    }
    // Which segment the cursor sits in, counted by the dots before it.
    const before = match[0].slice(0, position.character - start);
    return {
      text: match[0],
      // Subscripts come off the names: `rows[0].sName` addresses the same member as `rows.sName`,
      // because the element type is what carries it either way.
      segments: match[0].split('.').map((part) => part.replace(/\[[^\]]*\]/g, '')),
      segment: before.split('.').length - 1
    };
  }
  return undefined;
}

/**
 * The declared type of the leading name in a dotted expression.
 *
 * A local or parameter first -- that is what the code at this point refers to -- then the index,
 * for a property or a global holding a struct.
 */
function typeOfHead(
  chain: readonly DfNode[],
  index: SymbolIndex | undefined,
  name: string
): string | undefined {
  const local = findLocal(chain, name);
  if (local !== undefined) {
    return local.type;
  }
  return index
    ?.lookup(name)
    .find((entry) => entry.type !== undefined && (entry.kind === 'property' || entry.kind === 'variable'))?.type;
}

/**
 * Resolves `myRow.sName` -- and `outer.inner.sName` -- to the struct member the cursor is on.
 *
 * Walks the chain a segment at a time: the head's declared type names a struct, that struct's
 * member names the next type, and so on. Returns nothing the moment a step cannot be resolved,
 * because a half-resolved chain says nothing trustworthy about the member at the end of it.
 */
function structMemberAt(
  chain: readonly DfNode[],
  index: SymbolIndex | undefined,
  dotted: DottedWord
): LocalFacts | undefined {
  if (index === undefined || dotted.segment < 1) {
    return undefined;
  }

  let type = typeOfHead(chain, index, dotted.segments[0]!);
  for (let at = 1; at <= dotted.segment; at++) {
    if (type === undefined) {
      return undefined;
    }
    // `tRow[] rows` makes `rows` an array of `tRow`; a member reaches through the subscript.
    const structName = type.replace(/\[\]$/, '');
    const struct = index.lookup(structName).find((entry) => entry.kind === 'struct');
    const wanted = dotted.segments[at]!.toLowerCase();
    const field = struct?.fields?.find((entry) => entry.name.toLowerCase() === wanted);
    if (struct === undefined || field === undefined) {
      return undefined;
    }
    if (at === dotted.segment) {
      return { kind: 'field', name: field.name, type: field.type, container: struct.name };
    }
    type = field.type;
  }
  return undefined;
}

/**
 * Describes the symbol under the cursor.
 *
 * Resolution runs local-scope first and only then falls back to the index. That order is what
 * makes a hover work on a parameter or a local at all -- neither is indexed, by design -- and it
 * means the hover keeps working in an untitled buffer and while the index is still building.
 */
export function hover(
  unit: SourceUnit,
  document: TextDocument,
  position: Position,
  index: SymbolIndex | undefined,
  options: HoverOptions = {}
): Hover | undefined {
  const word = wordAt(document, position);
  if (word === undefined) {
    return undefined;
  }

  const chain = nodeChainAt(unit.root, position.line, position.character);
  const dotted = dottedWordAt(document, position);

  // A member -- `myRow.sName`, `Customer.Name` -- is resolved through what it is a member *of*,
  // which is settled by the text before the dot. Looking the bare word up instead would find
  // whatever else in the workspace happens to share the name. Only when the cursor is past a dot:
  // on `myRow` itself the answer is the variable, handled below.
  if (dotted !== undefined && dotted.segment > 0) {
    const member = structMemberAt(chain, index, dotted);
    if (member !== undefined) {
      return {
        contents: { kind: MarkupKind.Markdown, value: localHover(member) },
        range: word.range
      };
    }

    const column = options.tables?.resolveDotted(dotted.text);
    if (column !== undefined) {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: tableHover({
            table: column.table.name,
            tableNumber: column.table.number,
            field: column.field,
            fieldCount: column.table.fields.length,
            where: shorten(column.table.file)
          })
        },
        range: word.range
      };
    }
  }

  const local = findLocal(chain, word.text);
  if (local !== undefined) {
    return {
      contents: { kind: MarkupKind.Markdown, value: localHover(local) },
      range: word.range
    };
  }

  // A command is checked before the index, and only when the word actually leads its statement.
  // That position is unambiguous -- `Save Customer` is the Save command, whatever else in the
  // workspace happens to be called Save -- while `Send Save to oDD` is a message and falls
  // through to the lookup below, which is what should answer it.
  const command = commandAt(chain, word, options);
  if (command !== undefined) {
    return command;
  }

  if (index === undefined) {
    return keywordAt(word, options, document);
  }

  const declarations = index.lookup(word.text, referenceContext(chain[chain.length - 1], position));
  if (declarations.length === 0) {
    // A bare table name, last: a table is not declared anywhere, so anything the index does know
    // by that name is the better answer.
    const table = options.tables?.table(word.text);
    if (table !== undefined) {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: tableHover({
            table: table.name,
            tableNumber: table.number,
            fields: options.tableFields === true ? table.fields : undefined,
            fieldCount: table.fields.length,
            where: shorten(table.file)
          })
        },
        range: word.range
      };
    }
    return keywordAt(word, options, document);
  }

  // One card, for the best-ranked declaration. The rest are summarised on a line inside it:
  // framework names repeat heavily in DataFlex's flat namespace, and a second card is so nearly
  // identical to the first that it reads as the hover having duplicated itself.
  const best = declarations[0]!;
  const facts = factsFor(best, index, options);
  const rest = declarations.slice(1);
  if (rest.length > 0) {
    facts.others = { count: rest.length, where: rest.map((entry) => shorten(entry.file)) };
  }

  return {
    contents: { kind: MarkupKind.Markdown, value: declarationHover(facts) },
    range: word.range
  };
}

/**
 * What to call a language element: command, function or keyword.
 *
 * A statement verb is a command. Anything immediately followed by `(` is being called, which is
 * what makes `SizeOfArray` a function and not a keyword -- the documentation page name cannot be
 * relied on for this, since `SizeOfArray` has no `_Function` suffix while `Abs_Function` does.
 */
function languageLabel(
  word: { text: string; range: DfRange },
  document: TextDocument | undefined
): string {
  if (STATEMENT_VERBS.has(word.text.toLowerCase())) {
    return 'DataFlex command';
  }
  if (document !== undefined) {
    const after = document.getText({
      start: word.range.end,
      end: { line: word.range.end.line, character: word.range.end.character + 1 }
    });
    if (after === '(') {
      return 'DataFlex function';
    }
  }
  return 'DataFlex keyword';
}

/**
 * The hover for a word that belongs to the language rather than to the workspace.
 *
 * Covers commands (`Save`), block and declaration keywords (`Begin`, `Object`), built-in types
 * (`String`) and built-in functions (`SizeOfArray`, `Trim`) alike. The documentation index decides
 * membership, not a hand-kept list: it has a page for 1,100 language elements, and the earlier
 * version -- which required the word to be in one of the parser's keyword tables -- silently
 * refused every built-in *function*, because functions are not statement verbs and appear in no
 * such table.
 *
 * A last resort, deliberately: it runs only once locals, struct members, tables, commands and the
 * index have all declined, so anything the workspace actually declares still wins. That ordering
 * is what makes it safe to accept any word the documentation knows, rather than having to prove
 * the cursor sits in a keyword position.
 *
 * Words the documentation does not cover -- `to`, `of` -- still answer nothing, which is honest.
 */
function keywordAt(
  word: { text: string; range: DfRange },
  options: HoverOptions,
  document?: TextDocument
): Hover | undefined {
  const docs = docsEntryForCommand(word.text, options.docsBaseUrl);
  if (docs === undefined) {
    return undefined;
  }
  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: commandHover({
        name: word.text,
        summary: docs.description,
        docsUrl: docs.url,
        label: languageLabel(word, document)
      })
    },
    range: word.range
  };
}

/**
 * The hover for a statement's leading verb, when the documentation covers it.
 *
 * Gated on the word being this statement's verb rather than merely being a known command word, so
 * a local named `Print` or a property called `Delete` is never mistaken for the built-in.
 */
function commandAt(
  chain: readonly DfNode[],
  word: { text: string; range: DfRange },
  options: HoverOptions
): Hover | undefined {
  const node = chain[chain.length - 1];
  if (node?.kind !== 'statement' || node.verb !== word.text.toLowerCase()) {
    return undefined;
  }
  const docs = docsEntryForCommand(word.text, options.docsBaseUrl);
  if (docs === undefined) {
    return undefined;
  }
  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: commandHover({ name: word.text, summary: docs.description, docsUrl: docs.url })
    },
    range: word.range
  };
}

/**
 * The nearest class in the chain whose documentation covers this member.
 *
 * DataFlex code names the class it instantiates; the reference documents the class that declares
 * the member, which is usually an ancestor. `cWebModalDialog` inherits `OnShow` and has no page
 * for it, so a reader hovering `Procedure OnShow` gets nothing unless the chain is walked.
 *
 * Nearest first, so a class that re-documents an inherited member wins over the one it inherited
 * it from.
 */
function documentingClass(
  index: SymbolIndex,
  ownerClass: string,
  member: string
): string | undefined {
  if (documentsMember(ownerClass, member)) {
    return ownerClass;
  }
  for (const record of index.resolveChain(ownerClass)) {
    if (documentsMember(record.name, member)) {
      return record.name;
    }
  }
  return undefined;
}

/**
 * The `Main_File` a class or object inherits from its ancestors.
 *
 * Nearest first: a subclass may re-point an inherited data dictionary at a different table, and
 * the closest declaration is the one in effect.
 */
function inheritedMainFile(index: SymbolIndex, declaration: Declaration): string | undefined {
  if (declaration.kind !== 'object' && declaration.kind !== 'class') {
    return undefined;
  }
  const start = declaration.kind === 'object' ? declaration.superClass : declaration.name;
  if (start === undefined) {
    return undefined;
  }
  for (const record of index.resolveChain(start)) {
    const found = index
      .lookup(record.name)
      .find((entry) => entry.kind === 'class' && entry.mainFile !== undefined)?.mainFile;
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/**
 * Gathers everything the index can say about one declaration.
 *
 * Exported so `scripts/hover-preview.ts` renders exactly what the editor renders. It used to keep
 * a hand-copied version, which silently fell behind twice -- once for the documentation summary
 * and once for struct members -- and a preview that quietly omits a fact is worse than no preview,
 * because it reads as evidence the fact is missing.
 */
export function factsFor(
  declaration: Declaration,
  index: SymbolIndex,
  options: HoverOptions
): DeclarationFacts {
  const owned =
    options.root === undefined ? false : isWorkspaceOwnedFile(declaration.file, options.root);

  // Occurrences minus the declarations themselves, so the number reads as uses.
  const declarations = index.declarationCount(declaration.name);
  const uses = Math.max(0, index.referenceCount(declaration.name) - declarations);

  const facts: DeclarationFacts = {
    kind: declaration.kind,
    name: declaration.name,
    file: declaration.file,
    where: shorten(declaration.file),
    params: declaration.params,
    type: declaration.type,
    isSetter: declaration.isSetter,
    superClass: declaration.superClass,
    doc: declaration.doc,
    uses,
    usesAreExact: declarations === 1 && owned,
    published: declaration.published,
    webPublished: declaration.webPublished,
    webProperty: declaration.webProperty,
    visibility: declaration.visibility,
    acceptsVariableArguments: declaration.inspectsArgumentCount,
    fields: declaration.fields,
    value: declaration.value,
    directive: declaration.directive,
  };

  // A constant's value is the one thing worth knowing about it, and for an alias or an
  // `Enum_List` member the declaration line does not say it.
  if (declaration.kind === 'define' || declaration.kind === 'enumValue') {
    const value = declaredConstantValue(index, declaration);
    if (value !== undefined) {
      facts.constant = {
        value,
        type: constantType(value),
        fromEnum: declaration.kind === 'enumValue'
      };
    }
  }

  // A method's documentation page is keyed by the class that declares it, so `ownerClass` is what
  // makes a procedure or property linkable at all.
  //
  // A mixin is a special case worth handling: it declares methods but has no page of its own, and
  // the class importing it is what the reference documents. `ShowInfoBox` is declared in
  // `cWebHostAPI_mixin` and documented under `cWebApp`, so without this it linked nowhere.
  const declared = declaration.ownerClass;
  const hosted =
    declared !== undefined && docsPlatform(declared) === undefined
      ? (index.mixinHost(declared) ?? declared)
      : declared;

  // The class the *documentation* attaches the member to, which is rarely the one the code names.
  // `Procedure OnShow` inside `Object oX is a cWebModalDialog` is an override of an event declared
  // further up: only `cWebWindow` and `cWebCard` have a page for `OnShow`. Looking only at
  // `cWebModalDialog` found nothing and the hover linked nowhere.
  const owner = hosted === undefined ? undefined : (documentingClass(index, hosted, declaration.name) ?? hosted);

  // The workspace's own code normally links nowhere -- a user class sharing a framework name must
  // not borrow its page. A member is the exception, and only when the resolved class documents
  // that exact name: then it is the same method, and its page is what the reader wants.
  const sameMethod = owner !== undefined && documentsMember(owner, declaration.name);
  const docs = docsEntryFor({
    kind: declaration.kind,
    name: declaration.name,
    file: declaration.file,
    workspaceOwned: owned && !sameMethod,
    ownerClass: owner,
    baseUrl: options.docsBaseUrl
  });
  if (docs !== undefined) {
    facts.docsUrl = docs.url;
    facts.docsSummary = docs.description;
  }

  // The table a data dictionary manages: the single most useful fact about a DD, and one the
  // class name only hints at.
  //
  // An *object* almost never declares `Main_File` itself -- `Object oCustomer_DD is a
  // cCustomerDataDictionary` inherits it -- so the `is a` chain is walked to find the class that
  // does. Without that the hover stayed blank on exactly the DDOs a reader meets in view code.
  const managed = declaration.mainFile ?? inheritedMainFile(index, declaration);
  if (managed !== undefined) {
    const table = options.tables?.table(managed);
    facts.manages =
      table === undefined
        ? { table: managed }
        : { table: table.name, number: table.number, fieldCount: table.fields.length };
  }

  if (declaration.kind === 'class' || declaration.kind === 'object') {
    // Ancestors only, nearest first. The header line already says `is a <Parent>`, so repeating
    // the declaration's own name here would spend two of the five slots saying nothing.
    const chain =
      declaration.kind === 'class'
        ? index.resolveChain(declaration.name).slice(1)
        : declaration.superClass === undefined
          ? []
          : index.resolveChain(declaration.superClass);
    if (chain.length > 0) {
      facts.hierarchy = chain.map((record) => record.name);
    }

    // The class's own mixins. Not its ancestors' as well: `Inherits` already names the ancestors,
    // and a reader who wants their mixins can hover one -- whereas merging them here would put
    // twenty names on a class that imports none of them itself.
    const owner =
      declaration.kind === 'object' ? declaration.superClass : declaration.name;
    const mixins = owner === undefined ? [] : (index.getClass(owner)?.mixins ?? []);
    if (mixins.length > 0) {
      facts.mixins = mixins;
    }
  }

  // A global handle says nothing on its own; the assignment made to it says what it holds.
  if (declaration.isGlobal === true) {
    facts.isGlobal = true;
    const held = index.globalHandleClass(declaration.name);
    if (held !== undefined) {
      facts.holdsClass = held.className;
      facts.assignedAt = {
        text: held.assignment.text,
        where: shorten(held.assignment.file),
        line: held.assignment.line
      };
    }
  }

  if (declaration.kind === 'procedure' || declaration.kind === 'function') {
    const overridden = findOverridden(index, declaration.name, {
      ownerClass: declaration.ownerClass,
      ownerIsObject: declaration.ownerIsObject
    });
    if (overridden !== undefined) {
      facts.overrides = overridden;
    }
  }

  return facts;
}

/**
 * Finds a parameter, local variable or struct field by name in the enclosing scope.
 *
 * Innermost first, so a local shadowing a parameter reports the local -- which is what the code at
 * that point actually refers to.
 */
export function findLocal(chain: readonly DfNode[], name: string): LocalFacts | undefined {
  const key = name.toLowerCase();

  for (let i = chain.length - 1; i >= 0; i--) {
    const node = chain[i]!;

    if (node.kind === 'procedure' || node.kind === 'function') {
      const local = node.children?.find(
        (child) => child.kind === 'variable' && child.name?.toLowerCase() === key
      );
      if (local !== undefined) {
        return { kind: 'local', name: local.name!, type: local.type, container: node.name };
      }
      const param = node.params?.find((entry) => entry.name.toLowerCase() === key);
      if (param !== undefined) {
        return {
          kind: 'parameter',
          name: param.name,
          type: param.type,
          byRef: param.byRef,
          container: node.name
        };
      }
    }

    if (node.kind === 'struct') {
      const field = node.children?.find(
        (child) => child.kind === 'field' && child.name?.toLowerCase() === key
      );
      if (field !== undefined) {
        return { kind: 'field', name: field.name!, type: field.type, container: node.name };
      }
    }
  }

  return undefined;
}

/**
 * Every parameter and local visible at a point, innermost scope first.
 *
 * The counterpart of `findLocal`, which answers "what is this name". The debugger needs the
 * opposite question -- "what names are there" -- because the DataFlex debugger engine can evaluate
 * an expression but has no way to enumerate a frame's variables: its locals window is an ActiveX
 * grid with no data on its interface. The parser is the only thing that knows, so this is what
 * fills the Variables pane.
 *
 * Parameters come before locals because that is the order they are written in, and a name declared
 * in an inner scope hides an outer one, as `findLocal` resolves it.
 */
export function localsInScope(chain: readonly DfNode[]): LocalFacts[] {
  const found: LocalFacts[] = [];
  const seen = new Set<string>();

  const take = (facts: LocalFacts): void => {
    const key = facts.name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      found.push(facts);
    }
  };

  for (let i = chain.length - 1; i >= 0; i--) {
    const node = chain[i]!;
    if (node.kind !== 'procedure' && node.kind !== 'function') {
      continue;
    }

    for (const param of node.params ?? []) {
      take({
        kind: 'parameter',
        name: param.name,
        type: param.type,
        byRef: param.byRef,
        container: node.name
      });
    }

    for (const child of node.children ?? []) {
      if (child.kind === 'variable' && child.name !== undefined) {
        take({ kind: 'local', name: child.name, type: child.type, container: node.name });
      }
    }
  }

  return found;
}

/** Powers workspace symbol search across the workspace, its dependencies and the library. */
export function workspaceSymbols(
  query: string,
  index: SymbolIndex | undefined
): SymbolInformation[] {
  if (index === undefined) {
    return [];
  }
  return index.search(query).map((declaration) => ({
    name: declaration.name,
    kind: SYMBOL_KINDS.get(declaration.kind) ?? 1,
    containerName: declaration.container ?? shorten(declaration.file),
    location: {
      uri: pathToFileURL(declaration.file).toString(),
      range: declaration.nameRange
    }
  }));
}
