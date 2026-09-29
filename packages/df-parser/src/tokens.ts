/**
 * Token model for the DataFlex lexer.
 *
 * DataFlex is case-insensitive and line-oriented: with very few exceptions one statement
 * occupies one physical line, and a trailing `;` continues the statement onto the next line.
 * The lexer therefore records, per token, both its absolute offset and its line/character
 * position so downstream layers can build LSP ranges without re-scanning the text.
 */

/**
 * Deliberately a plain `enum`, not a `const enum`.
 *
 * A const enum is inlined at compile time and emits no runtime object, so importing it from
 * another package resolves to `undefined` -- silently, until something dereferences it.
 */
export enum TokenKind {
  /** Identifier, keyword or dotted name (`Customer.Name`). Keywords are not distinguished here. */
  Identifier = 'identifier',
  /** Numeric literal. */
  Number = 'number',
  /** String literal, including its delimiters. */
  String = 'string',
  /** `//` comment, or a `#REM` comment directive, up to the end of the physical line. */
  Comment = 'comment',
  /** A preprocessor directive name, including the leading `#` (`#IFDEF`, `#COMMAND`, ...). */
  Directive = 'directive',
  /** Operator or punctuation. */
  Punct = 'punct',
  /** End of a physical line that is *not* continued (i.e. it terminates a logical line). */
  EndOfLine = 'eol',
  /** End of input. */
  EndOfFile = 'eof'
}

export interface Position {
  /** Zero-based line index. */
  line: number;
  /** Zero-based UTF-16 code-unit offset within the line. */
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Token {
  kind: TokenKind;
  /** Source text of the token exactly as written. */
  text: string;
  /** Absolute offset of the first character. */
  start: number;
  /** Absolute offset one past the last character. */
  end: number;
  range: Range;
  /** True when this token is the first non-whitespace token on its physical line. */
  firstOnLine: boolean;
}

/** Case-insensitive equality, the default for every DataFlex identifier comparison. */
export function eqi(a: string | undefined, b: string): boolean {
  return a !== undefined && a.toLowerCase() === b.toLowerCase();
}

/** True when `token` is an identifier equal (case-insensitively) to `word`. */
export function isWord(token: Token | undefined, word: string): boolean {
  return token !== undefined && token.kind === TokenKind.Identifier && eqi(token.text, word);
}

/** True when `token` is an identifier equal to any of `words`. */
export function isAnyWord(token: Token | undefined, ...words: string[]): boolean {
  if (token === undefined || token.kind !== TokenKind.Identifier) {
    return false;
  }
  const lower = token.text.toLowerCase();
  return words.some((w) => w.toLowerCase() === lower);
}

export function rangeOf(from: Token, to: Token = from): Range {
  return { start: from.range.start, end: to.range.end };
}
