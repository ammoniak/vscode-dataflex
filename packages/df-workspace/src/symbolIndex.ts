import { readFileSync, statSync } from 'node:fs';
import { DfNode, DfParam, Range, TokenKind, parseSource, walk } from '@vscode-dataflex/parser';
import { IncludeResolver } from './includeResolver';
import { findGlobalAssignments, valueAfterTo } from './globalHandles';
import type { GlobalAssignment } from './globalHandles';
import { valueTokensAfterTo } from './statementValues';

/** One member of a `Struct`. */
export interface StructField {
  name: string;
  /** Declared type, including `[]` for an array member. */
  type?: string;
  doc?: string;
}

/** A declaration found somewhere on the workspace search path. */
export interface Declaration {
  name: string;
  kind: DfNode['kind'];
  /** Absolute path of the file declaring it. */
  file: string;
  /** Full extent of the declaration. */
  range: Range;
  /** Extent of just the name, for a precise reveal. */
  nameRange: Range;
  /** `is a <X>` for a class. */
  superClass?: string;
  /** Enclosing class or struct name, when the declaration is a member. */
  container?: string;
  /**
   * For a method: the class whose ancestors decide whether it is an override.
   *
   * A method inside `Class cX is a cY` resolves against `cX`; one inside
   * `Object oX is a cWebForm` resolves against `cWebForm`. Overriding something an ancestor
   * declares means the framework may call it, which is the difference between dead code and a
   * hook.
   */
  ownerClass?: string;
  /** True when the owner is an object instance rather than a class declaration. */
  ownerIsObject?: boolean;
  /**
   * The table a data dictionary manages, from `Set Main_File to <Table>.File_Number`.
   *
   * Only the managed table, not every table the class opens. Set on the class or object that
   * declares it, so a hover on `cCustomerDataDictionary` can say `Customer`.
   */
  mainFile?: string;
  /**
   * True when a `{ Published=True }` or `{ WebProperty=... }` tag publishes this declaration to
   * something outside the code -- a DFUnit test, or the web client.
   */
  published?: boolean;
  /** Signature-ish summary for the symbol list. */
  detail?: string;
  /**
   * Parameter list of a procedure or function.
   *
   * Kept structured alongside `detail`, which is a rendered string: the hover formats one
   * parameter per line and needs the types and names apart. Both are set from the same node, so
   * they cannot drift.
   */
  params?: DfParam[];
  /** Return type of a function, or the declared type of a property. */
  type?: string;
  /** True for the `Procedure Set <Name>` property-setter form. */
  isSetter?: boolean;
  /** True for a variable declared with `Global_Variable`. */
  isGlobal?: boolean;
  /**
   * Members of a `Struct`, in declaration order.
   *
   * Carried on the declaration because a struct is useless without them: `Struct tRow` on its own
   * says nothing a reader did not already know from the name, and the members are not indexed
   * separately -- they are not workspace-wide names, only meaningful through their struct.
   */
  fields?: StructField[];
  doc?: string;
  /** Declared parameter count, for a procedure or function. */
  paramCount?: number;
  /**
   * `Client`, `Server` or `ServerSession` from a `{ WebProperty=... }` tag.
   *
   * Carried onto the declaration as well as the class member so a hover can show it without
   * having to resolve which class the name belongs to first.
   */
  webProperty?: string;
  /** The `{ Visibility=... }` tag, most often `Private` in the runtime library. */
  visibility?: string;
  /**
   * True when a `WebPublishProcedure` / `WebPublishFunction` statement in the same object or class
   * publishes this method to the web client.
   *
   * Distinct from `published`, which comes from a `{ Published=True }` tag: the two mechanisms are
   * unrelated, and a method may carry either, both, or neither.
   */
  webPublished?: boolean;
  /**
   * True when the body reads `num_arguments`.
   *
   * DataFlex has no optional-parameter syntax: a method that takes a variable number of arguments
   * tests `num_arguments` instead, and callers legitimately pass fewer. Call sites for such a
   * method cannot be arity-checked, which is exactly the distinction the `argument-count` rule
   * needs in order not to be wrong about the framework.
   */
  inspectsArgumentCount?: boolean;
  /**
   * What a constant is defined as, verbatim: the text after `for` in `Define X for <value>`, or
   * after the name in `#REPLACE X <value>`. Absent for an `Enum_List` member that has no `for`.
   *
   * Kept as source text rather than evaluated here so the hover can show the declaration as
   * written; `constantValues.ts` does the evaluating.
   */
  value?: string;
  /**
   * An `Enum_List` member's value: its position in the list, counting from zero, with an explicit
   * `Define X for <n>` restarting the count from `n`. The Web UI packages use both forms in the
   * same list.
   */
  ordinal?: number;
  /** `#REPLACE` or `#DEFINE` when the constant came from a directive rather than `Define`. */
  directive?: string;
}

/**
 * One member of a class: a published property, a property implemented as a setter/getter pair,
 * or a plain method.
 */
export interface ClassMember {
  name: string;
  kind: 'property' | 'setter' | 'getter' | 'method';
  type?: string;
  defaultValue?: string;
  /** `Client`, `Server` or `ServerSession` when a `{ WebProperty=... }` tag is present. */
  webProperty?: string;
  /** The `{ Category="..." }` tag, used to group completions. */
  category?: string;
  doc?: string;
  declaringClass: string;
  file: string;
  nameRange: Range;
}

/** A class declaration plus what it directly contributes and inherits. */
export interface ClassRecord {
  name: string;
  superClass?: string;
  /** Mixin protocol names pulled in with `Import_Class_Protocol`. */
  mixins: string[];
  /** Members declared directly in this class (or grafted onto it with `for <Class>`). */
  members: ClassMember[];
  file: string;
  nameRange: Range;
  doc?: string;
  /**
   * JavaScript class the web framework instantiates for this class, e.g. `df.WebButton`.
   *
   * A web control is two halves: the DataFlex class here, and a class in the browser that draws it.
   * The Web UI packages name that second half twice, and only one of the two is usable.
   * `Set psJSClass to "df.WebButton"` in `Construct_Object` is the runtime mapping, and it is the
   * one read here. The class-level `{ DesignerJSClass=... }` tag is deliberately ignored:
   *
   *   - It covers less. Of the 160 Web UI packages, 79 set the property and 65 carry the tag, and
   *     the only two classes with a tag and no property are `cWebObject` and `cWebBaseControl`,
   *     both abstract.
   *   - Where both exist they never disagree, so it adds nothing.
   *   - `cWebBaseControl`'s tag is `df.WebDesignerControl`, a class that exists only inside
   *     `Studio.exe` and not in the shipped framework. Since that class is an ancestor of every
   *     control, preferring the tag would hand out a constructor that does not exist to any
   *     control class that declares neither -- turning a control that would have drawn as its
   *     parent into a hard "could not find class" failure.
   *
   * Absent on classes that are not web controls at all, which is most of them.
   */
  jsClass?: string;
}

/** A member as seen from a particular class, with where it came from. */
export interface ResolvedMember extends ClassMember {
  /** 0 for the class itself, 1 for its parent, and so on. Mixins share their host's depth. */
  inheritanceDepth: number;
}

/** Declaration kinds worth indexing across the workspace. */
const INDEXED_KINDS: ReadonlySet<DfNode['kind']> = new Set([
  'class',
  'procedure',
  'function',
  'struct',
  'enumList',
  'enumValue',
  'define',
  'command',
  'property',
  'object'
]);

/**
 * Kinds a declaration reference is most likely to mean, given what the cursor sits on.
 *
 * Used to rank, never to filter: DataFlex has one flat namespace per file and the same name can
 * legitimately be a class in one place and a define in another, so hiding candidates would make
 * navigation worse, not better.
 */
export type ReferenceContext = 'class' | 'member' | 'any';

/**
 * Reads a DataFlex source file.
 *
 * Sources are a mix of UTF-8 (usually with a BOM) and Windows-1252; sniffing the BOM avoids
 * mojibake showing up as parse noise.
 */
export function readSourceFile(path: string): string | undefined {
  try {
    const buffer = readFileSync(path);
    const hasBom = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
    return hasBom ? buffer.subarray(3).toString('utf8') : buffer.toString('latin1');
  } catch {
    return undefined;
  }
}

/** Modification time in milliseconds, or `undefined` for a file that cannot be stat'ed. */
function mtimeOf(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * The class named as the target of a top-level `Import_Class_Protocol <Mixin> <Class> All`.
 *
 * The parser keeps only the first token after the verb, which is the mixin; the class it is being
 * grafted onto is the token after that, and it survives only in the raw header text.
 */
function namedHostOf(node: DfNode): string | undefined {
  const words = (node.text ?? '').trim().split(/\s+/);
  // `Import_Class_Protocol` `<Mixin>` `<Class>` ...
  return words.length >= 3 ? words[2] : undefined;
}

/** Value of a `{ Tag=Value }` annotation, matched case-insensitively. */
function metadataValue(node: DfNode, tag: string): string | undefined {
  return node.metadata?.find((entry) => entry.name.toLowerCase() === tag)?.value;
}

function summarize(node: DfNode): string | undefined {
  switch (node.kind) {
    case 'class':
      return node.superClass === undefined ? undefined : `is a ${node.superClass}`;
    case 'procedure':
    case 'function': {
      const params = (node.params ?? [])
        .map((p) => `${p.byRef ? 'ByRef ' : ''}${p.type ?? ''} ${p.name}`.trim())
        .join(', ');
      const returns = node.type === undefined ? '' : ` Returns ${node.type}`;
      return `(${params})${returns}`;
    }
    case 'property':
      return node.type;
    case 'define':
      return node.value;
    default:
      return undefined;
  }
}

/** `#REPLACE` / `#DEFINE`, upper-cased, when a `define` node was written as a directive. */
function directiveOf(node: DfNode): string | undefined {
  const head = node.text?.trimStart().split(/\s/, 1)[0];
  return head?.startsWith('#') === true ? head.toUpperCase() : undefined;
}

/**
 * A workspace-wide index of DataFlex declarations, keyed by lower-cased name.
 *
 * This is what turns "peek definition on `cCustomerDataDictionary`" from nothing into a jump to
 * `DDSrc\cCustomerDataDictionary.dd`. It indexes every file on the compiler's search path -- so
 * the workspace, every DataFlex 26 package dependency under `DfPkg`, and the runtime library --
 * because a class reference in application code routinely resolves into one of those.
 */
export class SymbolIndex {
  private readonly byName = new Map<string, Declaration[]>();
  /**
   * Mixin name to the class it is imported into.
   *
   * A mixin declares methods but is never instantiated; the class that imports it is what the
   * documentation describes. `cWebHostAPI_mixin` declares `ShowInfoBox`, and only `cWebApp` --
   * the class importing it -- has a page saying what `ShowInfoBox` does.
   */
  private readonly mixinHosts = new Map<string, string>();
  private readonly byFile = new Map<string, Declaration[]>();
  private readonly classes = new Map<string, ClassRecord>();
  /** Members grafted with `for <Class>` onto a class not indexed yet. */
  private readonly pendingMembers = new Map<string, ClassMember[]>();
  private readonly memberCache = new Map<string, ResolvedMember[]>();
  private allMembersCache: ResolvedMember[] | undefined;

  /** Names of every `#COMMAND` seen, for the parser's `knownCommands` option. */
  readonly commandNames = new Set<string>();
  /** Names of every struct / legacy `Type`, for the parser's `knownTypes` option. */
  readonly typeNames = new Set<string>();
  /**
   * How often each lower-cased identifier appears as a token across every indexed file.
   *
   * Dead-code detection compares this against how many times the name is *declared*: a name that
   * never appears beyond its own declarations is referenced nowhere.
   */
  private readonly referenceCounts = new Map<string, number>();
  /**
   * Per-file tallies, so re-indexing one file can subtract its previous contribution.
   *
   * Without this the counts only ever grow: every save re-adds the file, inflating the reference
   * count and silently sparing dead procedures that nothing actually calls.
   */
  private readonly fileReferenceCounts = new Map<string, Map<string, number>>();
  /**
   * Lower-cased path back to the path as it was indexed.
   *
   * Every per-file map is keyed case-insensitively, because Windows paths reach us in whatever
   * casing the caller used. A reference result has to name the file the way the filesystem does,
   * or the editor opens a second, differently-spelled tab for the same file.
   */
  private readonly filePaths = new Map<string, string>();
  /**
   * Files that parsed with at least one `unknown` node.
   *
   * A type or command declared in another file cannot be recognised the first time that file is
   * read -- the vocabulary is still being collected. These are the files worth reading again once
   * it is complete, which is a small fraction of the workspace.
   */
  private readonly filesWithUnknowns = new Set<string>();
  /**
   * Lower-cased words found inside string literals anywhere in the workspace.
   *
   * DataFlex dispatches dynamically (`Send (RefProc(...))`, message names built at runtime), so a
   * method whose name appears in any literal is assumed reachable rather than reported.
   */
  private readonly literalWords = new Map<string, number>();
  private readonly fileLiteralWords = new Map<string, Set<string>>();
  /**
   * Assignments to global handles, per file.
   *
   * Kept per file so `removeFile` can drop them again. The reference tallies beside this once
   * lacked that and every save inflated them until a dead procedure looked reachable; the same
   * mistake here would leave a hover naming a class the code no longer assigns.
   */
  private readonly fileGlobalAssignments = new Map<string, GlobalAssignment[]>();
  /**
   * Modification time of each file as it was indexed, in milliseconds.
   *
   * This is what lets `refreshStale` tell an index that is still true from one that has been
   * overtaken. The index is otherwise only ever corrected file-by-file on an editor save, so a
   * `git checkout`, a Studio write or anything else touching disk behind the editor's back leaves
   * stale declarations in place -- and a stale declaration is not a missing answer but a wrong
   * one: a method that has since gained a parameter goes on reporting its old arity, and every
   * call site is flagged against a signature that no longer exists.
   */
  private readonly fileMtimes = new Map<string, number>();

  get size(): number {
    return this.byName.size;
  }

  get fileCount(): number {
    return this.byFile.size;
  }

  get classCount(): number {
    return this.classes.size;
  }

  /**
   * Indexes every source file on the search path.
   *
   * `onProgress` is called every `batchSize` files so the caller can drive a progress
   * indicator, and awaiting between batches keeps the extension host responsive on a large
   * workspace (a large workspace's search path runs to a few thousand files).
   */
  async build(
    resolver: IncludeResolver,
    options: {
      onProgress?: (done: number, total: number) => void;
      isCancelled?: () => boolean;
      batchSize?: number;
    } = {}
  ): Promise<void> {
    this.byName.clear();
    this.byFile.clear();
    this.classes.clear();
    this.pendingMembers.clear();
    this.referenceCounts.clear();
    this.fileReferenceCounts.clear();
    this.filePaths.clear();
    this.filesWithUnknowns.clear();
    this.literalWords.clear();
    this.fileLiteralWords.clear();
    this.fileGlobalAssignments.clear();
    this.fileMtimes.clear();
    this.invalidateMemberCaches();
    this.commandNames.clear();
    this.typeNames.clear();

    const files = resolver.allSourceFiles();
    const batchSize = options.batchSize ?? 50;

    for (let i = 0; i < files.length; i++) {
      if (options.isCancelled?.() === true) {
        return;
      }
      this.indexFile(files[i]!);

      if (i % batchSize === batchSize - 1) {
        options.onProgress?.(i + 1, files.length);
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    // Second pass: re-read the files that could not be fully understood the first time.
    //
    // DataFlex declares types and commands across files, and the compiler sees them all before it
    // sees any use. A single pass cannot: `tAmEntries entry` is unparseable until the file
    // declaring `Struct tAmEntries` has been read, and the workspace's own `#COMMAND` verbs are in
    // the same position. Revisiting only the files that produced an `unknown` keeps this cheap --
    // it is a few percent of the workspace, not another full build.
    const revisit = [...this.filesWithUnknowns];
    for (let i = 0; i < revisit.length; i++) {
      if (options.isCancelled?.() === true) {
        return;
      }
      this.indexFile(revisit[i]!);
      if (i % batchSize === batchSize - 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    options.onProgress?.(files.length, files.length);
  }

  /**
   * Re-reads every file whose modification time has moved, and drops the ones that are gone.
   *
   * A `statSync` per file over the search path costs a few milliseconds against the seconds a
   * rebuild takes, so a host that cannot watch the filesystem -- the MCP server, a script -- can
   * afford to ask before every answer that depends on cross-file truth.
   *
   * Reports no change on an index that was never built: there is no baseline to compare against,
   * and reading the whole search path for the first time is `build`'s job, not this one's.
   */
  refreshStale(resolver: IncludeResolver): { reindexed: number; removed: number } {
    if (this.fileMtimes.size === 0) {
      return { reindexed: 0, removed: 0 };
    }

    let reindexed = 0;
    let removed = 0;
    const seen = new Set<string>();

    for (const file of resolver.allSourceFiles()) {
      const key = file.toLowerCase();
      seen.add(key);
      const mtime = mtimeOf(file);
      if (mtime === undefined) {
        continue;
      }
      if (this.fileMtimes.get(key) !== mtime) {
        this.indexFile(file);
        // Only counted once it took: a file that stats but cannot be read records no mtime, and
        // reporting it as re-indexed on every call would make a quiet workspace look busy.
        if (this.fileMtimes.has(key)) {
          reindexed++;
        }
      }
    }

    // A file the search path no longer offers, or that was deleted outright. Its declarations
    // would otherwise answer lookups forever.
    for (const key of [...this.fileMtimes.keys()]) {
      if (!seen.has(key)) {
        this.removeFile(this.filePaths.get(key) ?? key);
        removed++;
      }
    }

    return { reindexed, removed };
  }

  /** Re-indexes one file, replacing whatever it contributed before. */
  indexFile(file: string, text?: string): void {
    const source = text ?? readSourceFile(file);
    if (source === undefined) {
      return;
    }

    this.removeFile(file);

    // Recorded from disk even when the text came from an editor buffer: `indexFile` is called
    // with text on save, by which point the buffer *is* what is on disk.
    const mtime = mtimeOf(file);
    if (mtime !== undefined) {
      this.fileMtimes.set(file.toLowerCase(), mtime);
    }

    let unit;
    try {
      unit = parseSource(source, {
        uri: file,
        knownTypes: this.typeNames,
        knownCommands: this.commandNames
      });
    } catch {
      // The parser is not supposed to throw; if it ever does, one bad file must not take the
      // whole index down.
      return;
    }

    const declarations: Declaration[] = [];
    this.invalidateMemberCaches();

    // Lines mentioning `num_arguments`, gathered once. Asking per method would rescan the token
    // stream for every declaration in the file, which is what made analysis quadratic before.
    const argumentCountLines: number[] = [];
    for (const token of unit.tokens) {
      if (token.kind === TokenKind.Identifier && token.text.toLowerCase() === 'num_arguments') {
        argumentCountLines.push(token.range.start.line);
      }
    }
    /**
     * Does this method's body mention `num_arguments`?
     *
     * Binary search, not a scan. The lines arrive in token order and so are already sorted, and a
     * linear `.some()` per method is quadratic in a file that has many of both: the generated
     * ActiveX wrapper in one workspace declares ~4,500 methods that nearly all test
     * `num_arguments`, and indexing that one file took 61 of the build's 76 seconds.
     */
    const inspectsArguments = (node: DfNode): boolean => {
      const from = node.range.start.line;
      const to = node.range.end.line;
      let low = 0;
      let high = argumentCountLines.length - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const line = argumentCountLines[mid]!;
        if (line < from) {
          low = mid + 1;
        } else if (line > to) {
          high = mid - 1;
        } else {
          return true;
        }
      }
      return false;
    };

    // `WebPublishProcedure ButtonCallback` publishes a method to the web client. It is written as
    // a statement in the object body, usually *after* the method it names, so it cannot be read
    // during the main walk -- hence a pre-pass.
    //
    // Scoped to the enclosing object or class rather than the file: one file often holds several
    // objects, and only one of them may publish a `ButtonCallback`.
    const webPublishedByContainer = new Map<DfNode | undefined, Set<string>>();
    walk(unit.root, (node, parents) => {
      if (
        node.kind !== 'statement' ||
        node.target === undefined ||
        (node.verb !== 'webpublishprocedure' && node.verb !== 'webpublishfunction')
      ) {
        return;
      }
      const container = [...parents].reverse().find((p) => p.kind === 'object' || p.kind === 'class');
      const names = webPublishedByContainer.get(container);
      if (names === undefined) {
        webPublishedByContainer.set(container, new Set([node.target.toLowerCase()]));
      } else {
        names.add(node.target.toLowerCase());
      }
    });

    /**
     * The table each class or object declares as its `Main_File`.
     *
     * `Set Main_File to Customer.File_Number` is how a data dictionary says which table it
     * manages, and it is the one fact a reader most wants from a DD. The parser keeps the verb and
     * `Main_File` but drops the right-hand side, so it is recovered from the tokens.
     *
     * `Main_File`, deliberately, and not `Open`: a DD opens every table it touches -- the WebOrder
     * customer DD opens `Customer`, `OrderHeader` and `DFLastID` -- but manages only one.
     */
    const mainFileByContainer = new Map<DfNode | undefined, string>();
    walk(unit.root, (node, parents) => {
      if (
        node.kind !== 'statement' ||
        node.verb !== 'set' ||
        node.target?.toLowerCase() !== 'main_file'
      ) {
        return;
      }
      const value = valueAfterTo(unit, node);
      if (value === undefined) {
        return;
      }
      // `Customer.File_Number` -- the table is the part before the dot.
      const table = value.split('.')[0];
      if (table === undefined || table.length === 0) {
        return;
      }
      const container = [...parents].reverse().find((p) => p.kind === 'object' || p.kind === 'class');
      if (!mainFileByContainer.has(container)) {
        mainFileByContainer.set(container, table);
      }
    });

    // Tally this file separately, then merge, so `removeFile` can subtract it again later.
    const fileCounts = new Map<string, number>();
    const fileLiterals = new Set<string>();

    for (const token of unit.tokens) {
      if (token.kind === TokenKind.Identifier) {
        // A dotted name references its leading segment (`myRow.iValue` uses `myRow`), but the
        // trailing segment matters too for `Customer.Name`-style references.
        for (const part of token.text.toLowerCase().split('.')) {
          if (part.length > 0) {
            fileCounts.set(part, (fileCounts.get(part) ?? 0) + 1);
          }
        }
      } else if (token.kind === TokenKind.String) {
        for (const word of token.text.toLowerCase().split(/[^a-z0-9_$#]+/)) {
          if (word.length > 1) {
            fileLiterals.add(word);
          }
        }
      }
    }

    const fileKey = file.toLowerCase();
    this.fileReferenceCounts.set(fileKey, fileCounts);
    this.filePaths.set(fileKey, file);

    // Files that could not be fully understood are revisited once the workspace vocabulary is
    // complete; see the second pass in `build`.
    let sawUnknown = false;
    walk(unit.root, (node) => {
      if (node.kind === 'unknown') {
        sawUnknown = true;
        return false;
      }
      return undefined;
    });
    if (sawUnknown) {
      this.filesWithUnknowns.add(file);
    } else {
      this.filesWithUnknowns.delete(file);
    }
    this.fileLiteralWords.set(fileKey, fileLiterals);

    const assignments = findGlobalAssignments(unit, file);
    if (assignments.length > 0) {
      this.fileGlobalAssignments.set(fileKey, assignments);
    }
    for (const [name, count] of fileCounts) {
      this.referenceCounts.set(name, (this.referenceCounts.get(name) ?? 0) + count);
    }
    for (const word of fileLiterals) {
      this.literalWords.set(word, (this.literalWords.get(word) ?? 0) + 1);
    }

    // Next value for each `Enum_List` being walked. Members arrive in source order, so a running
    // count per list is all that is needed to give each its position.
    const nextOrdinal = new Map<DfNode, number>();

    walk(unit.root, (node, parents) => {
      // The nearest enclosing class, however deeply nested. This matters for mixins: their
      // properties sit inside a `Procedure Define_<mixin>` rather than directly in the class
      // body, so anything shallower than a full ancestor search would miss them.
      const enclosingClass = [...parents].reverse().find((p) => p.kind === 'class');

      if (node.kind === 'class' && node.name !== undefined) {
        const record: ClassRecord = {
          name: node.name,
          superClass: node.superClass,
          mixins: [],
          members: [],
          file,
          nameRange: node.nameRange ?? node.headerRange,
          doc: node.doc
        };
        this.classes.set(node.name.toLowerCase(), record);
      }

      // `Set psJSClass to "df.WebWidget"`, which sits in Construct_Object rather than in the class
      // header, hence a separate branch from the record above. The enclosing-class walk is the same
      // one the mixin properties rely on, so a class body of any depth is reached.
      if (
        node.kind === 'statement' &&
        node.verb === 'set' &&
        node.target?.toLowerCase() === 'psjsclass' &&
        enclosingClass?.name !== undefined
      ) {
        const record = this.classes.get(enclosingClass.name.toLowerCase());
        if (record !== undefined) {
          const tokens = valueTokensAfterTo(unit, node);
          const only = tokens.length === 1 ? tokens[0] : undefined;
          if (only?.kind === TokenKind.String) {
            record.jsClass = only.text.slice(1, -1);
          }
        }
      }

      // `Import_Class_Protocol <mixin>` inside a class body, and the top-level
      // `Import_Class_Protocol <mixin> <Class> All` form, which grafts a mixin onto a class
      // declared elsewhere. Both are used in the wild -- the Web UI library writes the first
      // inside `Class cWebApp`, application code writes the second to extend it -- and only the
      // first used to be recorded, so half the mixin graph was invisible.
      if (
        node.kind === 'statement' &&
        node.verb === 'import_class_protocol' &&
        node.target !== undefined
      ) {
        const host = enclosingClass?.name ?? namedHostOf(node);
        if (host !== undefined) {
          this.classes.get(host.toLowerCase())?.mixins.push(node.target);
          this.mixinHosts.set(node.target.toLowerCase(), host);
        }
      }

      const member = this.toMember(node, enclosingClass, file);
      if (member !== undefined) {
        // `Function X for cY` / `Procedure Set X for cY` graft onto a class declared elsewhere.
        const owner = this.classes.get(member.declaringClass.toLowerCase());
        if (owner !== undefined) {
          owner.members.push(member);
        } else {
          (this.pendingMembers.get(member.declaringClass.toLowerCase()) ?? this.newPending(member.declaringClass)).push(member);
        }
      }

      if (node.name === undefined || node.name.length === 0) {
        return;
      }
      if (node.kind === 'struct') {
        this.typeNames.add(node.name.toLowerCase());
      } else if (node.kind === 'command') {
        this.commandNames.add(node.name.toLowerCase());
      }
      // Globals are indexed; locals are not. `'variable'` is deliberately absent from
      // INDEXED_KINDS, because adding it would index every local in the workspace -- hundreds of
      // thousands of names nothing can navigate to -- so the exception is made here instead.
      const isIndexedGlobal = node.kind === 'variable' && node.isGlobal === true;
      if (!INDEXED_KINDS.has(node.kind) && !isIndexedGlobal) {
        return;
      }

      const container = [...parents]
        .reverse()
        .find((p) => p.kind === 'class' || p.kind === 'struct');
      const owner = [...parents]
        .reverse()
        .find((p) => p.kind === 'class' || p.kind === 'object');

      let ordinal: number | undefined;
      if (node.kind === 'enumValue') {
        const list = parents[parents.length - 1];
        if (list !== undefined) {
          const explicit = node.value === undefined ? NaN : Number(node.value.trim());
          ordinal = Number.isFinite(explicit) ? explicit : (nextOrdinal.get(list) ?? 0);
          nextOrdinal.set(list, ordinal + 1);
        }
      }

      declarations.push({
        name: node.name,
        kind: node.kind,
        file,
        range: node.range,
        nameRange: node.nameRange ?? node.headerRange,
        superClass: node.superClass,
        container: container?.name,
        ownerClass:
          node.forClass ?? (owner?.kind === 'object' ? owner.superClass : owner?.name),
        ownerIsObject: owner?.kind === 'object',
        // Only a class or object declares a `Main_File`; for anything else this is undefined.
        mainFile:
          node.kind === 'class' || node.kind === 'object'
            ? mainFileByContainer.get(node)
            : undefined,
        published: node.metadata?.some((tag) => {
          const tagName = tag.name.toLowerCase();
          if (tagName === 'webproperty') {
            return true;
          }
          return tagName === 'published' && (tag.value ?? 'true').toLowerCase() !== 'false';
        }),
        fields:
          node.kind === 'struct'
            ? (node.children ?? [])
                .filter((child) => child.kind === 'field' && child.name !== undefined)
                .map((child) => ({ name: child.name!, type: child.type, doc: child.doc }))
            : undefined,
        detail: summarize(node),
        doc: node.doc,
        params: node.params,
        type: node.type,
        isSetter: node.isSetter,
        isGlobal: node.isGlobal,
        paramCount: node.params?.length,
        inspectsArgumentCount:
          (node.kind === 'procedure' || node.kind === 'function') && inspectsArguments(node),
        value: node.kind === 'define' || node.kind === 'enumValue' ? node.value : undefined,
        ordinal,
        directive: node.kind === 'define' ? directiveOf(node) : undefined,
        webProperty: metadataValue(node, 'webproperty'),
        visibility: metadataValue(node, 'visibility'),
        webPublished:
          (node.kind === 'procedure' || node.kind === 'function') &&
          webPublishedByContainer.get(owner)?.has(node.name.toLowerCase()) === true
      });
    });

    // Adopt any members that were grafted onto classes before those classes were indexed.
    for (const [key, record] of this.classes) {
      const pending = this.pendingMembers.get(key);
      if (pending !== undefined && pending.length > 0) {
        record.members.push(...pending);
        this.pendingMembers.delete(key);
      }
    }

    this.byFile.set(file.toLowerCase(), declarations);
    for (const declaration of declarations) {
      const key = declaration.name.toLowerCase();
      const bucket = this.byName.get(key);
      if (bucket === undefined) {
        this.byName.set(key, [declaration]);
      } else {
        bucket.push(declaration);
      }
    }
  }

  private invalidateMemberCaches(): void {
    this.memberCache.clear();
    this.allMembersCache = undefined;
  }

  removeFile(file: string): void {
    const key = file.toLowerCase();

    // Before the early return below: a file with no declarations and no references still has a
    // recorded mtime, and leaving it behind would make `refreshStale` report it as removed on
    // every call.
    this.fileMtimes.delete(key);

    // Nothing to remove for a file that was never indexed, which is every file during a fresh
    // build. Without this the class sweep below runs once per file over every class already
    // indexed -- 1,918 classes x 1,697 files -- and dominates the build: 95 seconds, against 1.5
    // for parsing all of them.
    if (!this.byFile.has(key) && !this.fileReferenceCounts.has(key)) {
      return;
    }

    // Subtract this file's previous contribution to the global tallies.
    const previousCounts = this.fileReferenceCounts.get(key);
    if (previousCounts !== undefined) {
      for (const [name, count] of previousCounts) {
        const remaining = (this.referenceCounts.get(name) ?? 0) - count;
        if (remaining > 0) {
          this.referenceCounts.set(name, remaining);
        } else {
          this.referenceCounts.delete(name);
        }
      }
      this.fileReferenceCounts.delete(key);
    }
    this.filePaths.delete(key);
    this.filesWithUnknowns.delete(this.filePaths.get(key) ?? key);

    const previousLiterals = this.fileLiteralWords.get(key);
    if (previousLiterals !== undefined) {
      for (const word of previousLiterals) {
        const remaining = (this.literalWords.get(word) ?? 0) - 1;
        if (remaining > 0) {
          this.literalWords.set(word, remaining);
        } else {
          this.literalWords.delete(word);
        }
      }
      this.fileLiteralWords.delete(key);
    }

    this.fileGlobalAssignments.delete(key);

    // Drop classes declared here, and members this file grafted onto classes declared elsewhere.
    for (const [className, record] of [...this.classes]) {
      if (record.file.toLowerCase() === key) {
        this.classes.delete(className);
      } else {
        record.members = record.members.filter((m) => m.file.toLowerCase() !== key);
      }
    }
    this.invalidateMemberCaches();

    const existing = this.byFile.get(key);
    if (existing === undefined) {
      return;
    }
    for (const declaration of existing) {
      const nameKey = declaration.name.toLowerCase();
      const bucket = this.byName.get(nameKey);
      if (bucket === undefined) {
        continue;
      }
      const remaining = bucket.filter((d) => d.file.toLowerCase() !== key);
      if (remaining.length === 0) {
        this.byName.delete(nameKey);
      } else {
        this.byName.set(nameKey, remaining);
      }
    }
    this.byFile.delete(key);
  }

  /**
   * Looks a name up, most-likely-first.
   *
   * `context` only reorders the results. A `.dd` class and a `Define` of the same name are both
   * legitimate answers, and VS Code shows them all in a peek window.
   */
  lookup(name: string, context: ReferenceContext = 'any'): Declaration[] {
    const found = this.byName.get(name.toLowerCase());
    if (found === undefined) {
      return [];
    }

    const rank = (declaration: Declaration): number => {
      if (context === 'class') {
        return declaration.kind === 'class' ? 0 : declaration.kind === 'struct' ? 1 : 2;
      }
      if (context === 'member') {
        return declaration.kind === 'procedure' || declaration.kind === 'function'
          ? 0
          : declaration.kind === 'property'
            ? 1
            : 2;
      }
      return declaration.kind === 'class' ? 0 : 1;
    };

    return [...found].sort((a, b) => rank(a) - rank(b));
  }

  /** Turns a declaration node into a class member, or `undefined` if it is not one. */
  private toMember(
    node: DfNode,
    enclosingClass: DfNode | undefined,
    file: string
  ): ClassMember | undefined {
    if (node.name === undefined || node.name.length === 0) {
      return undefined;
    }
    // `for <Class>` grafts a member onto a class other than the enclosing one.
    const declaringClass = node.forClass ?? enclosingClass?.name;
    if (declaringClass === undefined) {
      return undefined;
    }

    const nameRange = node.nameRange ?? node.headerRange;
    const tag = (name: string): string | undefined =>
      node.metadata?.find((m) => m.name.toLowerCase() === name)?.value;

    if (node.kind === 'property') {
      return {
        name: node.name,
        kind: 'property',
        type: node.type,
        defaultValue: node.value,
        // A bare `{ WebProperty }` with no value means Client.
        webProperty:
          node.metadata?.some((m) => m.name.toLowerCase() === 'webproperty') === true
            ? (tag('webproperty') ?? 'Client')
            : undefined,
        category: tag('category'),
        doc: node.doc,
        declaringClass,
        file,
        nameRange
      };
    }

    if (node.kind === 'procedure' || node.kind === 'function') {
      // `Procedure Set X` and `Function X Returns T` are how a large share of DataFlex
      // properties are actually declared -- `Set X to ...` works on them exactly as it does on a
      // `Property`, so completion must offer them too.
      const kind: ClassMember['kind'] =
        node.isSetter === true ? 'setter' : node.kind === 'function' ? 'getter' : 'method';
      return {
        name: node.name,
        kind,
        type: node.type,
        // A setter/getter pair can be web-published just like a `Property`.
        webProperty:
          node.metadata?.some((m) => m.name.toLowerCase() === 'webproperty') === true
            ? (tag('webproperty') ?? 'Client')
            : undefined,
        category: tag('category'),
        doc: node.doc,
        declaringClass,
        file,
        nameRange
      };
    }

    return undefined;
  }

  private newPending(className: string): ClassMember[] {
    const list: ClassMember[] = [];
    this.pendingMembers.set(className.toLowerCase(), list);
    return list;
  }

  /**
   * The class a mixin is imported into, or `undefined`.
   *
   * A mixin is never instantiated and has no documentation page of its own; the class importing it
   * is what the reference describes. `cWebHostAPI_mixin` declares `ShowInfoBox`, and it is
   * `cWebApp` -- the importer -- whose page documents it.
   */
  mixinHost(name: string): string | undefined {
    return this.mixinHosts.get(name.toLowerCase());
  }

  getClass(name: string): ClassRecord | undefined {
    return this.classes.get(name.toLowerCase());
  }

  /**
   * What class a global handle holds, from the assignments made to it anywhere in the workspace.
   *
   * `Global_Variable Handle ghoMailInterface` says nothing on its own; `Move Self to
   * ghoMailInterface` inside `Class cMailInterface` says everything.
   *
   * Answers `undefined` unless every assignment agrees. A global assigned `Self` from two
   * different classes has no single answer, and naming one of them would be a guess presented as
   * a fact -- the same discipline the `argument-count` rule applies to dynamic dispatch.
   */
  globalHandleClass(name: string): { className: string; assignment: GlobalAssignment } | undefined {
    const key = name.toLowerCase();
    const resolved: { className: string; assignment: GlobalAssignment }[] = [];

    for (const assignments of this.fileGlobalAssignments.values()) {
      for (const assignment of assignments) {
        if (assignment.global !== key) {
          continue;
        }
        // An object name is resolved now rather than at index time: the object is often declared
        // in a file that had not been indexed yet when the assignment was read.
        const className =
          assignment.className ??
          (assignment.objectName === undefined
            ? undefined
            : this.lookup(assignment.objectName).find((d) => d.kind === 'object')?.superClass);
        if (className !== undefined) {
          resolved.push({ className, assignment });
        }
      }
    }

    if (resolved.length === 0) {
      return undefined;
    }
    const distinct = new Set(resolved.map((entry) => entry.className.toLowerCase()));
    return distinct.size === 1 ? resolved[0] : undefined;
  }

  /**
   * Every declared global that resolves to a class, for measuring how much this covers.
   *
   * Filtered against the declarations on purpose. The collector records the destination of every
   * `Move ... to <name>`, because a global is usually assigned in a different file from the one
   * declaring it and there is no way to tell at collection time; most of those destinations are
   * ordinary locals, and counting them here would have reported 146 "globals" in a workspace that
   * declares 81.
   */
  resolvedGlobalHandles(): { global: string; className: string }[] {
    const resolved: { global: string; className: string }[] = [];
    for (const declaration of this.allDeclarations()) {
      if (declaration.isGlobal !== true) {
        continue;
      }
      const found = this.globalHandleClass(declaration.name);
      if (found !== undefined) {
        resolved.push({ global: declaration.name, className: found.className });
      }
    }
    return resolved;
  }

  /** How many assignments are being tracked, for weighing the memory this costs. */
  globalAssignmentCount(): number {
    let total = 0;
    for (const assignments of this.fileGlobalAssignments.values()) {
      total += assignments.length;
    }
    return total;
  }

  /**
   * The class and its ancestors, nearest first.
   *
   * Cycle-safe: a malformed `Class cA is a cA` in a half-typed file must not hang the editor.
   */
  resolveChain(className: string): ClassRecord[] {
    const chain: ClassRecord[] = [];
    const seen = new Set<string>();
    let current = this.classes.get(className.toLowerCase());

    while (current !== undefined && !seen.has(current.name.toLowerCase())) {
      seen.add(current.name.toLowerCase());
      chain.push(current);
      current =
        current.superClass === undefined
          ? undefined
          : this.classes.get(current.superClass.toLowerCase());
    }
    return chain;
  }

  /**
   * Every member visible on a class: its own, its mixins', and everything it inherits.
   *
   * Nearest declaration wins, so an override reported by a subclass hides the base version.
   * Results are cached per class because completion asks for this on every keystroke.
   */
  membersOf(className: string): ResolvedMember[] {
    const key = className.toLowerCase();
    const cached = this.memberCache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const byName = new Map<string, ResolvedMember>();
    const addAll = (record: ClassRecord, depth: number, visitedMixins: Set<string>): void => {
      for (const member of record.members) {
        const memberKey = member.name.toLowerCase();
        if (!byName.has(memberKey)) {
          byName.set(memberKey, { ...member, inheritanceDepth: depth });
        }
      }
      for (const mixinName of record.mixins) {
        const mixinKey = mixinName.toLowerCase();
        if (visitedMixins.has(mixinKey)) {
          continue;
        }
        visitedMixins.add(mixinKey);
        const mixin = this.classes.get(mixinKey);
        if (mixin !== undefined) {
          // A mixin's members are as close as the class that imported it.
          addAll(mixin, depth, visitedMixins);
        }
      }
    };

    const visitedMixins = new Set<string>();
    this.resolveChain(className).forEach((record, depth) => {
      addAll(record, depth, visitedMixins);
    });

    const members = [...byName.values()];
    this.memberCache.set(key, members);
    return members;
  }

  /**
   * Every distinct member name in the workspace, deduped, as the last-resort completion tier.
   *
   * Built once per index because it is the same for every request.
   */
  allMembers(): ResolvedMember[] {
    if (this.allMembersCache !== undefined) {
      return this.allMembersCache;
    }
    const byName = new Map<string, ResolvedMember>();
    for (const record of this.classes.values()) {
      for (const member of record.members) {
        const key = member.name.toLowerCase();
        if (!byName.has(key)) {
          byName.set(key, { ...member, inheritanceDepth: Number.MAX_SAFE_INTEGER });
        }
      }
    }
    this.allMembersCache = [...byName.values()];
    return this.allMembersCache;
  }

  /** How many times a name appears as an identifier token across the whole index. */
  /**
   * Files whose token stream contains this name, for a reference search to open.
   *
   * The per-file tallies already exist to keep `referenceCount` correct across re-indexing; using
   * them as a filter is what makes "find all references" affordable. On a real workspace a name
   * appears in a few dozen of the thousand-odd files, so the search re-reads those and skips the
   * rest rather than tokenising everything on every request.
   */
  filesReferencing(name: string): string[] {
    const key = name.toLowerCase();
    const files: string[] = [];
    for (const [fileKey, counts] of this.fileReferenceCounts) {
      if (counts.has(key)) {
        files.push(this.filePaths.get(fileKey) ?? fileKey);
      }
    }
    return files;
  }

  referenceCount(name: string): number {
    return this.referenceCounts.get(name.toLowerCase()) ?? 0;
  }

  /** How many indexed declarations share this name. Each contributes one token occurrence. */
  declarationCount(name: string): number {
    return this.byName.get(name.toLowerCase())?.length ?? 0;
  }

  /** True when the name appears inside a string literal, hinting at dynamic dispatch. */
  appearsInLiteral(name: string): boolean {
    return this.literalWords.has(name.toLowerCase());
  }

  /** Every indexed declaration, for whole-workspace analyses. */
  allDeclarations(): Declaration[] {
    return [...this.byFile.values()].flat();
  }

  /** Case-insensitive substring search over every indexed name, for workspace symbol search. */
  search(query: string, limit = 500): Declaration[] {
    const needle = query.toLowerCase();
    const results: Declaration[] = [];
    for (const [key, bucket] of this.byName) {
      if (needle.length > 0 && !key.includes(needle)) {
        continue;
      }
      for (const declaration of bucket) {
        results.push(declaration);
        if (results.length >= limit) {
          return results;
        }
      }
    }
    return results;
  }
}
