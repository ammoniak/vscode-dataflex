import { DfNode, SourceUnit } from './ast';
import { Range, Token, TokenKind, eqi } from './tokens';

/**
 * Expression layer, parsed on demand over the statement parser's token stream.
 *
 * This is the second of the two parsers: the structure parser models declarations and blocks and
 * leaves anything inside a statement as text, and this fills that in only when a consumer asks.
 * Nothing pays for expression trees unless it wants one.
 *
 * **DataFlex has no operator precedence.** The Language Guide is explicit: `(1 + 2 * 4)` is 12,
 * not 9, because operators bind strictly left to right and parentheses are the only way to group.
 * So there is no precedence table here, and adding one would silently produce trees that disagree
 * with the runtime.
 */

export type ExprKind =
  | 'number'
  | 'string'
  | 'identifier'
  /** `Trim(sName)` -- an identifier applied to a parenthesised list. */
  | 'call'
  /** `aValues[i]`. */
  | 'index'
  /**
   * `Constraints[i].iFile`, or `Index.6`.
   *
   * The lexer already folds a plain dotted name into one identifier, so this only appears where
   * it cannot: after a subscript, or before a digit.
   */
  | 'member'
  | 'unary'
  | 'binary'
  /** A parenthesised subexpression, kept so the source can be reproduced faithfully. */
  | 'group'
  /** A fragment that could not be parsed. Never thrown -- incomplete code is normal while typing. */
  | 'error';

/**
 * One expression node.
 *
 * A single shape with optional fields, matching `DfNode`: consumers mostly walk generically, and a
 * uniform node keeps the tree cheap to cache.
 */
export interface ExprNode {
  kind: ExprKind;
  range: Range;
  /** Source text of the node, reassembled from its tokens. */
  text: string;

  /** Literal value or identifier spelling. */
  name?: string;
  /** `call`: the function name. */
  callee?: string;
  /** `call`: the argument list, comma-separated in this form. */
  args?: ExprNode[];
  /** `index` / `member`: what is being indexed or reached into, and by what. */
  target?: ExprNode;
  subscript?: ExprNode;
  /** `unary` / `binary`, lower-cased (`+`, `and`, `not`). */
  operator?: string;
  operand?: ExprNode;
  left?: ExprNode;
  right?: ExprNode;
  /** `group`: what was inside the parentheses. */
  inner?: ExprNode;
  /** True for `&sName`, which passes a variable by reference. */
  byRef?: boolean;
}

/**
 * Binary operators.
 *
 * All bind equally and associate left, so this is a membership test rather than a table.
 */
const BINARY = new Set([
  '+', '-', '*', '/', '^',
  '=', '==', '<>', '>', '<', '>=', '<=',
  'and', 'or', 'iand', 'ior', 'ixor',
  // `min` and `max` are infix in DataFlex: `(iHeight min iOrig)`.
  'min', 'max'
]);

// `#` prefixes a field or struct-member reference: `Send CreatePath #tDataPoint.sId`.
const UNARY = new Set(['-', '+', 'not', 'inot', '#']);

/** Words that end an argument list rather than forming part of one. */
const ARGUMENT_TERMINATORS = new Set(['to', 'of']);

function isOperatorWord(token: Token | undefined, set: ReadonlySet<string>): boolean {
  if (token === undefined) {
    return false;
  }
  if (token.kind === TokenKind.Punct) {
    return set.has(token.text);
  }
  return token.kind === TokenKind.Identifier && set.has(token.text.toLowerCase());
}

/** True when two tokens touch, with no whitespace between them. */
function adjacent(left: Token, right: Token): boolean {
  return left.end === right.start;
}

class ExpressionParser {
  private at: number;
  /**
   * Bracket nesting, which decides whether whitespace separates arguments or not.
   *
   * At the top level of a statement `Send Foo (a) (b)` passes two arguments, so an identifier
   * followed by a space and `(` is two terms. Inside parentheses the opposite holds:
   * `(RefClass (DfBaseEntry))` is one call, and DataFlex allows the space. Tracking depth is what
   * lets one parser answer both correctly.
   */
  private depth: number;

  constructor(
    private readonly tokens: readonly Token[],
    start: number,
    private readonly stop: number,
    initialDepth = 1
  ) {
    this.at = start;
    this.depth = initialDepth;
  }

  get position(): number {
    return this.at;
  }

  private peek(offset = 0): Token | undefined {
    const index = this.at + offset;
    return index < this.stop ? this.tokens[index] : undefined;
  }

  private done(): boolean {
    const token = this.peek();
    return (
      token === undefined ||
      token.kind === TokenKind.EndOfLine ||
      token.kind === TokenKind.EndOfFile
    );
  }

  private take(): Token {
    return this.tokens[this.at++]!;
  }

  private node(kind: ExprKind, from: Token, to: Token, extra: Partial<ExprNode> = {}): ExprNode {
    return {
      kind,
      range: { start: from.range.start, end: to.range.end },
      text: this.textBetween(from, to),
      ...extra
    };
  }

  /**
   * Source text of a span, reassembled with a space wherever the original had whitespace.
   *
   * The span is located by binary search rather than by filtering the whole array. `this.tokens`
   * is the entire file's token stream, and this runs once per expression node, so scanning it was
   * quadratic over a file: a generated ActiveX wrapper spent most of a 90-second index here.
   */
  private textBetween(from: Token, to: Token): string {
    let low = 0;
    let high = this.tokens.length - 1;
    let first = this.tokens.length;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.tokens[mid]!.start >= from.start) {
        first = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    let text = '';
    for (let i = first; i < this.tokens.length; i++) {
      const token = this.tokens[i]!;
      if (token.start > to.start) {
        break;
      }
      if (text.length > 0 && token.start > (this.tokens[i - 1]?.end ?? token.start)) {
        text += ' ';
      }
      text += token.text;
    }
    return text;
  }

  /** A full expression: a chain of terms joined by equally-binding, left-associative operators. */
  expression(): ExprNode {
    let left = this.unary();
    while (!this.done() && isOperatorWord(this.peek(), BINARY)) {
      const operator = this.take();
      const right = this.unary();
      left = {
        kind: 'binary',
        range: { start: left.range.start, end: right.range.end },
        text: `${left.text} ${operator.text} ${right.text}`,
        operator: operator.text.toLowerCase(),
        left,
        right
      };
    }
    return left;
  }

  /** One argument-sized term: a primary with its postfixes, plus any leading unary operator. */
  term(): ExprNode {
    return this.unary();
  }

  private unary(): ExprNode {
    const token = this.peek();
    if (token !== undefined && isOperatorWord(token, UNARY)) {
      this.take();
      const operand = this.unary();
      return {
        kind: 'unary',
        range: { start: token.range.start, end: operand.range.end },
        text: `${token.text}${operand.text}`,
        operator: token.text.toLowerCase(),
        operand
      };
    }
    if (token !== undefined && token.kind === TokenKind.Punct && token.text === '&') {
      this.take();
      const operand = this.unary();
      return {
        kind: 'unary',
        range: { start: token.range.start, end: operand.range.end },
        text: `&${operand.text}`,
        operator: '&',
        operand,
        byRef: true
      };
    }
    return this.postfix();
  }

  /**
   * A primary with any trailing subscripts.
   *
   * Adjacency decides whether `(` opens a call or a new term, because DataFlex separates arguments
   * with whitespace rather than commas: `Foo(a)` is one call, `Foo (a)` is a message name followed
   * by a separate parenthesised argument. Getting this wrong would miscount every call site.
   */
  private postfix(): ExprNode {
    let node = this.primary();

    for (;;) {
      const token = this.peek();
      if (token === undefined || token.kind !== TokenKind.Punct || !this.touchesPrevious(token)) {
        return node;
      }

      if (token.text === '[') {
        this.take();
        this.depth++;
        const subscript = this.expression();
        this.depth--;
        const close = this.expect(']');
        node = {
          kind: 'index',
          range: { start: node.range.start, end: (close ?? token).range.end },
          text: `${node.text}[${subscript.text}]`,
          target: node,
          subscript
        };
        continue;
      }

      // `.` reaches this layer only where the lexer could not fold it into a dotted identifier:
      // after a subscript (`Constraints[i].iFile`) or before a digit (`Index.6`).
      if (token.text === '.') {
        const name = this.peek(1);
        if (
          name === undefined ||
          (name.kind !== TokenKind.Identifier && name.kind !== TokenKind.Number)
        ) {
          return node;
        }
        this.take();
        this.take();
        node = {
          kind: 'member',
          range: { start: node.range.start, end: name.range.end },
          text: `${node.text}.${name.text}`,
          target: node,
          name: name.text
        };
        continue;
      }

      return node;
    }
  }

  private touchesPrevious(token: Token): boolean {
    const previous = this.tokens[this.at - 1];
    return previous !== undefined && adjacent(previous, token);
  }

  private primary(): ExprNode {
    const token = this.peek();
    if (token === undefined || this.done()) {
      const last = this.tokens[Math.max(0, this.at - 1)]!;
      return this.node('error', last, last, { name: '' });
    }

    if (token.kind === TokenKind.Number) {
      this.take();
      return this.node('number', token, token, { name: token.text });
    }

    if (token.kind === TokenKind.String) {
      this.take();
      return this.node('string', token, token, { name: token.text });
    }

    if (token.kind === TokenKind.Identifier) {
      this.take();
      const next = this.peek();
      // Adjacent is always a call. A space before `(` is one too, but only inside brackets --
      // at statement level that space is what separates one argument from the next.
      if (
        next !== undefined &&
        next.kind === TokenKind.Punct &&
        next.text === '(' &&
        (adjacent(token, next) || this.depth > 0)
      ) {
        this.take();
        this.depth++;
        const args = this.commaSeparated();
        this.depth--;
        const close = this.expect(')');
        return {
          kind: 'call',
          range: { start: token.range.start, end: (close ?? next).range.end },
          text: `${token.text}(${args.map((arg) => arg.text).join(', ')})`,
          callee: token.text,
          args
        };
      }
      return this.node('identifier', token, token, { name: token.text });
    }

    if (token.kind === TokenKind.Punct && token.text === '(') {
      this.take();
      this.depth++;
      const inner = this.expression();
      this.depth--;
      const close = this.expect(')');
      return {
        kind: 'group',
        range: { start: token.range.start, end: (close ?? token).range.end },
        text: `(${inner.text})`,
        inner
      };
    }

    // Anything else is a fragment this layer does not model. One token is consumed so a caller
    // looping over an argument list always makes progress.
    this.take();
    return this.node('error', token, token, { name: token.text });
  }

  /** The comma-separated list inside `Func(a, b)`. */
  private commaSeparated(): ExprNode[] {
    const args: ExprNode[] = [];
    if (this.peek()?.text === ')') {
      return args;
    }
    for (;;) {
      args.push(this.expression());
      const next = this.peek();
      if (next?.kind === TokenKind.Punct && next.text === ',') {
        this.take();
        continue;
      }
      return args;
    }
  }

  private expect(text: string): Token | undefined {
    const token = this.peek();
    if (token?.kind === TokenKind.Punct && token.text === text) {
      return this.take();
    }
    // Unbalanced, which is normal in half-written code. The node keeps the range it has.
    return undefined;
  }

  /**
   * The whitespace-separated arguments of a statement.
   *
   * Each argument is a *term*, not a full expression: `Send Foo a b` passes two arguments, and an
   * operator may only appear inside parentheses. Parsing a whole expression here would fold
   * `Send Foo a -1` into one argument and undercount it.
   */
  arguments(): ExprNode[] {
    const args: ExprNode[] = [];
    this.depth = 0;
    while (!this.done()) {
      const token = this.peek()!;
      if (token.kind === TokenKind.Comment) {
        this.take();
        continue;
      }
      if (token.kind === TokenKind.Identifier && ARGUMENT_TERMINATORS.has(token.text.toLowerCase())) {
        return args;
      }
      const before = this.at;
      args.push(this.unary());
      if (this.at === before) {
        // Defensive: nothing consumed would loop forever on malformed input.
        this.take();
      }
    }
    return args;
  }
}

/** Parses one expression from a token range. */
export function parseExpression(
  tokens: readonly Token[],
  start: number,
  end: number
): ExprNode {
  return new ExpressionParser(tokens, start, end).expression();
}

/** Parses a whitespace-separated argument list from a token range. */
export function parseArgumentList(
  tokens: readonly Token[],
  start: number,
  end: number
): ExprNode[] {
  return new ExpressionParser(tokens, start, end, 0).arguments();
}

/**
 * Parses a single term and reports where it ended.
 *
 * Used to step over the receiver of an `of` clause, which is not always a bare identifier:
 * `Get psDataPath of (phoWorkSpace(oApplication)) to sDataPath` and `Send Refill of allCombos[i]`
 * are both ordinary DataFlex, and assuming one token there swallows the rest of the line.
 */
export function parseTerm(
  tokens: readonly Token[],
  start: number,
  end: number
): { node: ExprNode; next: number } {
  // Depth 0: a term at statement level, where `oGrid (a)` is a receiver followed by an argument
  // rather than a call.
  const parser = new ExpressionParser(tokens, start, end, 0);
  const node = parser.term();
  return { node, next: parser.position };
}

/** The arguments a call-site statement passes. */
export interface CallArguments {
  args: ExprNode[];
  /** Message or property name being addressed. */
  target: string;
  /** Object named by an `of` / `to` clause, when there is one. */
  ofObject?: string;
  /** True when a fragment did not parse, so the count must not be trusted for diagnostics. */
  imprecise: boolean;
}

/** Verbs whose statement shape is `<verb> <name> [of <obj>] <args...> [to <dest>]`. */
const CALL_VERBS = new Set(['send', 'get', 'set', 'webset', 'webget', 'broadcast', 'delegate']);

/**
 * Verbs for which a bare `to` names the *receiver* rather than a destination.
 *
 * This is the same rule the structure parser applies when it fills in `ofObject`.
 */
const RECEIVER_TO_VERBS = new Set(['send', 'broadcast', 'delegate']);

/**
 * Reads the argument list of a call-site statement.
 *
 * Tokens are located by binary search over the unit's stream rather than stored on every node:
 * the structure parser produces hundreds of thousands of statements on a large workspace, and
 * almost none of them are ever asked for their arguments.
 */
export function callArguments(unit: SourceUnit, node: DfNode): CallArguments | undefined {
  if (node.kind !== 'statement' || node.verb === undefined || !CALL_VERBS.has(node.verb)) {
    return undefined;
  }
  if (node.target === undefined) {
    return undefined;
  }

  const start = firstTokenIndex(unit.tokens, node.headerRange);
  if (start === undefined) {
    return undefined;
  }
  const end = lastTokenIndex(unit.tokens, node.headerRange, start);

  // Skip the verb, then the name it addresses. The name is parsed rather than assumed to be one
  // token: `Send aMsg[i] of aObj[i] Self` sends a message chosen at runtime, and treating the
  // subscript as an argument would both miscount and corrupt the rest of the line.
  let at = parseTerm(unit.tokens, start + 1, end).next;

  // Step over the receiver so it is not counted as an argument. It is parsed rather than assumed
  // to be one token, because it may be a whole expression: `of (phoWorkSpace(oApplication))` and
  // `of allCombos[i]` are both ordinary.
  //
  // `to` is the subtle one, because it means opposite things either side of the verb:
  //
  //   Send DefineParam to hDriver OLE_VT_I4 llDays   -- receiver, arguments come *after*
  //   Get Sum 1 2 to iTotal                          -- destination, arguments come *before*
  //
  // Reading the first form the second way finds no arguments at all, which is what made a
  // generated OLE wrapper look like 4,486 separate defects.
  const next = unit.tokens[at];
  const introducesReceiver =
    next !== undefined &&
    next.kind === TokenKind.Identifier &&
    (eqi(next.text, 'of') || (RECEIVER_TO_VERBS.has(node.verb) && eqi(next.text, 'to')));
  if (introducesReceiver) {
    at = parseTerm(unit.tokens, at + 1, end).next;
  }

  const args = parseArgumentList(unit.tokens, at, end);
  return {
    args,
    target: node.target,
    ofObject: node.ofObject,
    imprecise: args.some(containsError)
  };
}

function containsError(node: ExprNode): boolean {
  if (node.kind === 'error') {
    return true;
  }
  for (const child of [node.left, node.right, node.operand, node.inner, node.target, node.subscript]) {
    if (child !== undefined && containsError(child)) {
      return true;
    }
  }
  return node.args?.some(containsError) === true;
}

/** Index of the first token at or after a range's start. */
function firstTokenIndex(tokens: readonly Token[], range: Range): number | undefined {
  let low = 0;
  let high = tokens.length - 1;
  let found: number | undefined;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const token = tokens[mid]!;
    if (before(token.range.start, range.start)) {
      low = mid + 1;
    } else {
      found = mid;
      high = mid - 1;
    }
  }
  return found;
}

/** Index one past the last token inside the range. */
function lastTokenIndex(tokens: readonly Token[], range: Range, from: number): number {
  let at = from;
  while (at < tokens.length && !before(range.end, tokens[at]!.range.end)) {
    at++;
  }
  return at;
}

function before(a: { line: number; character: number }, b: { line: number; character: number }): boolean {
  return a.line < b.line || (a.line === b.line && a.character < b.character);
}
