import { Range, Token } from './tokens';

/**
 * Node kinds produced by the structure parser.
 *
 * This layer is deliberately shallow: it models *declarations and blocks*, not expressions.
 * Everything the editor needs for outlining, folding, navigation and scope-ranked completion is
 * derivable from it, and anything it cannot classify degrades to `unknown` rather than an error.
 */
export type NodeKind =
  | 'sourceUnit'
  | 'object'
  | 'class'
  | 'procedure'
  | 'function'
  | 'struct'
  | 'enumList'
  | 'command'
  | 'block'
  /** One arm of a `Case Begin` block: its label condition plus the statements it guards. */
  | 'caseArm'
  | 'property'
  | 'variable'
  | 'field'
  | 'enumValue'
  | 'use'
  | 'include'
  | 'define'
  | 'statement'
  | 'directive'
  /** A line inside a `#COMMAND` body: macro template text, not a DataFlex statement. */
  | 'macroBody'
  | 'unknown';

/** Which construct opened a generic `block` node. */
export type BlockKind = 'if' | 'else' | 'for' | 'while' | 'repeat' | 'case' | 'begin' | 'conditional';

/**
 * How control leaves a statement, when it does so unconditionally.
 *
 * Modelled as a category rather than inferred from the verb string, so a control-flow graph can
 * ask the question directly.
 */
export type TransferKind = 'return' | 'break' | 'abort' | 'error';

/** A `{ Tag=Value }` annotation attached to the declaration that follows it. */
export interface DfMetadata {
  name: string;
  /** Raw value text with surrounding quotes stripped; `undefined` for a bare `{ Tag }`. */
  value?: string;
  range: Range;
}

export interface DfParam {
  type?: string;
  name: string;
  byRef: boolean;
  range: Range;
}

/**
 * A single node in the structure tree.
 *
 * One shape with optional fields is used rather than a discriminated union per kind: consumers
 * (outline, completion, instrumentation) mostly walk generically, and a uniform node keeps the
 * tree cheap to cache and serialize.
 */
export interface DfNode {
  kind: NodeKind;

  /** Declared name: object/class/procedure/property/variable/struct/define. */
  name?: string;
  nameRange?: Range;

  /** Right-hand side of `is a <X>` for objects and classes. */
  superClass?: string;
  superClassRange?: Range;

  /** Declared type of a property, variable or struct field; return type of a function. */
  type?: string;

  /** Raw source text of a property's or define's default value. */
  value?: string;

  /** Parameter list of a procedure or function. */
  params?: DfParam[];

  /** For `Procedure Set X` / `Function X for cY`: the class the method is grafted onto. */
  forClass?: string;

  /** True for the `Procedure Set <Name>` property-setter form. */
  isSetter?: boolean;

  /**
   * True for a `variable` declared with `Global_Variable`.
   *
   * A variable outside a method is a program-wide global whether or not it says so, which is what
   * the `implicit-global` rule reports. This flag is the difference between the deliberate form
   * and the accidental one, so that rule must not fire on nodes carrying it.
   */
  isGlobal?: boolean;

  /** Which construct opened a generic `block`. */
  blockKind?: BlockKind;

  /**
   * Raw source of the parenthesised condition on a conditional, loop or case arm.
   *
   * Left as text on purpose: the expression parser is a separate, opt-in pass, so nothing pays
   * for expression trees unless a consumer actually wants one.
   */
  condition?: string;

  /**
   * True when a block's body shares its header's line (`If (x) Send Foo`).
   *
   * Only conditional blocks carry this. It specifically means *a probe or statement cannot be
   * inserted before the body on its own line*, which is what coverage instrumentation needs to
   * know; it is not a general "was Begin used" flag. A `caseArm` records that distinction in
   * `closedBy` instead.
   *
   * The tree shape is identical either way, so control-flow analysis has one case to handle; this
   * flag preserves the distinction for consumers that must not insert a line into the body --
   * coverage instrumentation above all.
   */
  inline?: boolean;

  /** Keyword that closed a block (`end`, `loop`, `until`, `end_procedure`, ...). */
  closedBy?: string;

  /** How control leaves this statement, when it leaves unconditionally. */
  transfer?: TransferKind;

  /** Statement verb, lower-cased: `set`, `webset`, `get`, `webget`, `send`, `move`, ... */
  verb?: string;
  /** Statement subject: the property or message name that follows the verb. */
  target?: string;
  targetRange?: Range;
  /** Object named by an `of <obj>` or `to <obj>` clause. */
  ofObject?: string;
  ofObjectRange?: Range;

  /** `{ Tag=Value }` annotations that immediately preceded this node. */
  metadata?: DfMetadata[];
  /** Documentation gathered from the trailing `//` comment and any comment lines above. */
  doc?: string;

  /** Full extent, including children and the closing keyword. */
  range: Range;
  /** Extent of the opening (header) line only. */
  headerRange: Range;

  children?: DfNode[];

  /** Source text of the header line, kept for diagnostics and for the corpus checker. */
  text?: string;
}

export interface ParseDiagnostic {
  message: string;
  range: Range;
  severity: 'error' | 'warning' | 'hint';
}

export interface SourceUnit {
  /** Absolute path or URI this unit was parsed from, when known. */
  uri?: string;
  root: DfNode;
  /**
   * The token stream the tree was built from.
   *
   * Static analysis needs it to decide whether an identifier is *referenced*: scanning raw text
   * would count occurrences inside comments and string literals, and the tree alone does not
   * model expressions.
   */
  tokens: Token[];
  diagnostics: ParseDiagnostic[];
  /** Every `Use` / `#Include` in the file, in source order. */
  uses: DfNode[];
  /** Count of logical lines the parser could not classify -- the corpus quality metric. */
  unknownCount: number;
  /** Total number of logical lines (excluding blank and comment-only lines). */
  logicalLineCount: number;
}

/** Depth-first pre-order walk over the tree. Return `false` from `visit` to skip children. */
export function walk(node: DfNode, visit: (node: DfNode, parents: DfNode[]) => boolean | void): void {
  const parents: DfNode[] = [];
  const recurse = (current: DfNode): void => {
    if (visit(current, parents) === false) {
      return;
    }
    const children = current.children;
    if (children === undefined) {
      return;
    }
    parents.push(current);
    for (const child of children) {
      recurse(child);
    }
    parents.pop();
  };
  recurse(node);
}

function containsPosition(range: Range, line: number, character: number): boolean {
  if (line < range.start.line || line > range.end.line) {
    return false;
  }
  if (line === range.start.line && character < range.start.character) {
    return false;
  }
  if (line === range.end.line && character > range.end.character) {
    return false;
  }
  return true;
}

/**
 * Returns the chain of nodes containing the given position, outermost first.
 *
 * This is the primitive the completion ranker is built on: the last `object` in the chain is the
 * innermost enclosing object, and the ones before it are its ancestors.
 */
export function nodeChainAt(root: DfNode, line: number, character: number): DfNode[] {
  const chain: DfNode[] = [];
  let current: DfNode | undefined = root;

  while (current !== undefined) {
    chain.push(current);
    const next: DfNode | undefined = current.children?.find((child) =>
      containsPosition(child.range, line, character)
    );
    current = next;
  }

  return chain;
}
