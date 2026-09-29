import {
  DfNode,
  ExprNode,
  SourceUnit,
  TokenKind,
  callArguments,
  parseArgumentList,
  walk
} from '@vscode-dataflex/parser';

/**
 * Works out what class a global handle points at.
 *
 * `Global_Variable Handle ghoMailInterface` says nothing on its own, but the assignment almost
 * always does. Measured across a 285k-line workspace, the shapes that occur are:
 *
 *   Move Self to ghoX                          13   the enclosing class
 *   Move oSomeObject to ghoX                    4   that object's `is a` class
 *   Move (Self) to ghoX                         1   the same, parenthesised
 *   Move 0 to ghoX                              1   nothing -- must not claim a class
 *
 * and from the runtime library, the `Create` idiom, which that workspace happens not to use:
 *
 *   Get Create U_cRegistry to hoRegistry
 *   Get Create (RefClass(cIniFile)) to hoIni
 *   Get Create of hoParent U_cCJCommandBar to hoBar
 */

/** One assignment to a global, as found in a file. */
export interface GlobalAssignment {
  /** Lower-cased name of the global being assigned. */
  global: string;
  /**
   * Class the source resolves to directly, when it can be read from the statement alone.
   *
   * `Self` and the `Create` forms answer here.
   */
  className?: string;
  /**
   * Object name the source referred to, when the class needs the index to resolve.
   *
   * Kept unresolved because the object is often declared in another file, which may not have been
   * indexed yet when this one is read.
   */
  objectName?: string;
  /** Where the assignment is, for the hover to cite. */
  file: string;
  line: number;
  /** The statement as written, trimmed, for the hover to quote. */
  text: string;
}

/**
 * First token index on each line, built once per file.
 *
 * Both helpers below need "where does this statement's line begin in the token array", and both
 * used to answer it with `tokens.findIndex` from zero. That is O(tokens) per statement, which is
 * quadratic over a file: indexing one generated ActiveX wrapper of ~4,500 methods spent 90 seconds
 * almost entirely in those two scans. Cached against the unit so re-parsing drops the entry.
 */
const LINE_STARTS = new WeakMap<SourceUnit, Map<number, number>>();

function lineStarts(unit: SourceUnit): Map<number, number> {
  const cached = LINE_STARTS.get(unit);
  if (cached !== undefined) {
    return cached;
  }
  const starts = new Map<number, number>();
  for (let i = 0; i < unit.tokens.length; i++) {
    const line = unit.tokens[i]!.range.start.line;
    if (!starts.has(line)) {
      starts.set(line, i);
    }
  }
  LINE_STARTS.set(unit, starts);
  return starts;
}

/**
 * Index of the first token at or after a node's header position.
 *
 * Starts from the line's first token rather than the file's, then steps forward over anything
 * before the header's column -- a handful of tokens, not a whole file.
 */
function tokenIndexAt(unit: SourceUnit, node: DfNode): number {
  const line = node.headerRange.start.line;
  const from = lineStarts(unit).get(line);
  if (from === undefined) {
    return -1;
  }
  for (let i = from; i < unit.tokens.length; i++) {
    const token = unit.tokens[i]!;
    if (token.range.start.line !== line) {
      return -1;
    }
    if (token.range.start.character >= node.headerRange.start.character) {
      return i;
    }
  }
  return -1;
}

/** Verbs that can assign to a global. */
const ASSIGNING_VERBS = new Set(['move', 'get']);

/**
 * Strips the `U_` prefix DataFlex puts on a class reference.
 *
 * `Get Create U_cRegistry to hoX` names the class as `U_cRegistry`; the class itself is `cRegistry`.
 */
function stripClassPrefix(name: string): string {
  return /^U_/i.test(name) ? name.slice(2) : name;
}

/**
 * The class named inside `RefClass(...)`.
 *
 * Its argument is a class by definition, so it must not go back through `classFromSource`, which
 * reads a bare identifier as an *object* name. `RefClass(cIniFile)` would then be looked up as an
 * object called `cIniFile`, find nothing, and the global would resolve to no class at all.
 */
function classInsideRefClass(expr: ExprNode): string | undefined {
  if (expr.kind === 'group') {
    return expr.inner === undefined ? undefined : classInsideRefClass(expr.inner);
  }
  return expr.kind === 'identifier' && expr.name !== undefined
    ? stripClassPrefix(expr.name)
    : undefined;
}

/**
 * Reads a class out of the expression being assigned.
 *
 * Returns `{}` when the source carries no class -- `Move 0 to ghoX` is a reset, not a binding, and
 * claiming a class for it would be worse than saying nothing.
 */
function classFromSource(
  source: ExprNode,
  enclosingClass: string | undefined
): { className?: string; objectName?: string } {
  switch (source.kind) {
    case 'group':
      // `Move (Self) to ghoX`.
      return source.inner === undefined ? {} : classFromSource(source.inner, enclosingClass);

    case 'call': {
      // `RefClass(cIniFile)` names its class as the first argument.
      const first = source.args?.[0];
      if (source.callee !== undefined && /^RefClass$/i.test(source.callee) && first !== undefined) {
        const className = classInsideRefClass(first);
        return className === undefined ? {} : { className };
      }
      return {};
    }

    case 'identifier': {
      const name = source.name;
      if (name === undefined) {
        return {};
      }
      if (/^Self$/i.test(name)) {
        return enclosingClass === undefined ? {} : { className: enclosingClass };
      }
      if (/^U_/i.test(name)) {
        return { className: stripClassPrefix(name) };
      }
      // A plain identifier is an object; which class it is needs the index.
      return { objectName: name };
    }

    default:
      // Literals, arithmetic, subscripts: nothing a class can be read out of.
      return {};
  }
}

/**
 * The class an enclosing `Object` / `Class` stands for.
 *
 * Inside `Class cX is a cY`, `Self` is a `cX`. Inside `Object oX is a cWebForm`, `Self` is a
 * `cWebForm`. Same rule the index already applies when it fills in `Declaration.ownerClass`.
 */
function selfClass(parents: readonly DfNode[]): string | undefined {
  const owner = [...parents].reverse().find((p) => p.kind === 'class' || p.kind === 'object');
  if (owner === undefined) {
    return undefined;
  }
  return owner.kind === 'object' ? owner.superClass : owner.name;
}

/**
 * Identifier introduced by a top-level `to` clause, or `undefined`.
 *
 * Exported because the parser drops it. `Set Main_File to Customer.File_Number` reaches the AST as
 * `{verb:'set', target:'Main_File'}` with the right-hand side surviving only in the token stream,
 * and a data dictionary's table is exactly that right-hand side. Scanning at paren depth zero is
 * what keeps `Move (Foo(a to b)) to ghoX` from confusing the two.
 */
export function valueAfterTo(unit: SourceUnit, node: DfNode): string | undefined {
  const tokens = unit.tokens;
  // The statement occupies one logical line, so the scan from here is bounded and cheap.
  let at = tokenIndexAt(unit, node);
  if (at < 0) {
    return undefined;
  }

  let depth = 0;
  for (; at < tokens.length; at++) {
    const token = tokens[at]!;
    if (token.kind === TokenKind.EndOfLine || token.kind === TokenKind.EndOfFile) {
      return undefined;
    }
    if (token.kind === TokenKind.Punct) {
      if (token.text === '(' || token.text === '[') {
        depth++;
      } else if (token.text === ')' || token.text === ']') {
        depth--;
      }
      continue;
    }
    if (
      depth === 0 &&
      token.kind === TokenKind.Identifier &&
      token.text.toLowerCase() === 'to' &&
      tokens[at + 1]?.kind === TokenKind.Identifier
    ) {
      return tokens[at + 1]!.text;
    }
  }
  return undefined;
}

/** Index of the first token of a statement. */
function firstTokenOf(unit: SourceUnit, node: DfNode): number {
  return tokenIndexAt(unit, node);
}

/**
 * Collects every assignment to a global handle in one file.
 *
 * The caller decides which destinations are actually globals; this reports all of them, because a
 * global is very often declared in a different file from the one that assigns it.
 */
export function findGlobalAssignments(unit: SourceUnit, file: string): GlobalAssignment[] {
  const found: GlobalAssignment[] = [];

  walk(unit.root, (node, parents) => {
    if (node.kind !== 'statement' || node.verb === undefined || !ASSIGNING_VERBS.has(node.verb)) {
      return;
    }

    const destination = valueAfterTo(unit, node);
    if (destination === undefined) {
      return;
    }

    const enclosing = selfClass(parents);
    let resolved: { className?: string; objectName?: string } = {};

    if (node.verb === 'get') {
      // Only `Get Create ...` binds a class; every other Get returns a value.
      const call = callArguments(unit, node);
      if (call === undefined || !/^Create$/i.test(call.target) || call.imprecise) {
        return;
      }
      const first = call.args[0];
      if (first === undefined) {
        return;
      }
      resolved = classFromSource(first, enclosing);
    } else {
      const start = firstTokenOf(unit, node);
      if (start < 0) {
        return;
      }
      // `parseArgumentList` stops at `to`, which is exactly the source/destination boundary.
      const source = parseArgumentList(unit.tokens, start + 1, unit.tokens.length)[0];
      if (source === undefined) {
        return;
      }
      resolved = classFromSource(source, enclosing);
    }

    if (resolved.className === undefined && resolved.objectName === undefined) {
      return;
    }

    found.push({
      global: destination.toLowerCase(),
      ...resolved,
      file,
      line: node.headerRange.start.line,
      text: (node.text ?? '').trim()
    });
  });

  return found;
}
