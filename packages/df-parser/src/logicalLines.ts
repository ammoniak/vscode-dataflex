import { Token, TokenKind, Range } from './tokens';

/**
 * One DataFlex statement: the tokens of a physical line, plus any lines joined onto it by a
 * trailing `;` continuation (which the lexer has already folded in).
 */
export interface LogicalLine {
  /** Significant tokens, with comments and the terminating newline removed. */
  tokens: Token[];
  /** Comments that appeared on this line, in source order. */
  comments: Token[];
  range: Range;
}

/** Splits a token stream into logical lines. Blank and comment-only lines are preserved. */
export function toLogicalLines(tokens: Token[]): LogicalLine[] {
  const lines: LogicalLine[] = [];
  let current: Token[] = [];
  let comments: Token[] = [];
  let first: Token | undefined;
  let last: Token | undefined;

  const flush = (terminator: Token): void => {
    if (current.length === 0 && comments.length === 0) {
      return;
    }
    const start = first ?? terminator;
    const end = last ?? terminator;
    lines.push({
      tokens: current,
      comments,
      range: { start: start.range.start, end: end.range.end }
    });
    current = [];
    comments = [];
    first = undefined;
    last = undefined;
  };

  for (const token of tokens) {
    if (token.kind === TokenKind.EndOfLine || token.kind === TokenKind.EndOfFile) {
      flush(token);
      continue;
    }

    first ??= token;
    last = token;

    if (token.kind === TokenKind.Comment) {
      comments.push(token);
    } else {
      current.push(token);
    }
  }

  return lines;
}
