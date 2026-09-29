/**
 * Reading the right-hand side of an assignment statement.
 *
 * The parser deliberately drops it: `Set psCaption to "Customer Maintenance"` reaches the AST as
 * `{ verb: 'set', target: 'psCaption' }`, because most consumers only care what is being assigned,
 * not to what. The value survives in the token stream, and anything that wants it -- the web view
 * previewer above all, since a view *is* its property values -- has to go and get it.
 *
 * `valueAfterTo` in `globalHandles.ts` does a narrower version of this: it answers only when the
 * value is a single identifier, because a data dictionary's `Set Main_File to Customer.File_Number`
 * is the only shape it was written for. A literal returns `undefined` there. This module answers
 * for every shape, and leaves the interpreting to the caller.
 */
import { DfNode, SourceUnit, Token, TokenKind } from '@vscode-dataflex/parser';

/**
 * Tokens between the statement's top-level `to` and the end of its logical line.
 *
 * Empty when the statement has no `to` clause. Paren depth is tracked so that the `to` inside
 * `Move (Foo(a to b)) to ghoX` is not mistaken for the real one, and only `Identifier` tokens are
 * considered as the keyword so a string containing the word "to" cannot end the search early.
 *
 * `of <object>` clauses need no special handling: `Set psLabel of oForm to "x"` puts `of oForm`
 * before the `to`, so scanning forward for the first top-level `to` lands in the right place.
 */
export function valueTokensAfterTo(unit: SourceUnit, node: DfNode): Token[] {
  const start = firstTokenIndex(unit, node);
  if (start < 0) {
    return [];
  }

  const tokens = unit.tokens;
  let depth = 0;
  for (let at = start; at < tokens.length; at++) {
    const token = tokens[at]!;
    if (token.kind === TokenKind.EndOfLine || token.kind === TokenKind.EndOfFile) {
      return [];
    }
    if (token.kind === TokenKind.Punct) {
      if (token.text === '(' || token.text === '[') {
        depth++;
      } else if (token.text === ')' || token.text === ']') {
        depth--;
      }
      continue;
    }
    if (depth === 0 && token.kind === TokenKind.Identifier && token.text.toLowerCase() === 'to') {
      return valueTail(tokens, at + 1);
    }
  }
  return [];
}

/**
 * The tokens between the verb and the statement's top-level `to`.
 *
 * `WebSetResponsive piColumnSpan rmTablet to 12` yields `[piColumnSpan, rmTablet]` -- the property
 * the rule is for and the responsive mode it applies at. The parser records the verb and the first
 * argument as `target` and drops the rest, the same way it drops the value, so a caller that needs
 * the middle of the statement has to read the token stream for it.
 *
 * Empty when there is no top-level `to`, matching `valueTokensAfterTo`.
 */
export function argumentTokensBeforeTo(unit: SourceUnit, node: DfNode): Token[] {
  const start = firstTokenIndex(unit, node);
  if (start < 0) {
    return [];
  }

  const tokens = unit.tokens;
  const args: Token[] = [];
  let depth = 0;
  // `start` is the verb itself, so collecting begins one past it.
  for (let at = start + 1; at < tokens.length; at++) {
    const token = tokens[at]!;
    if (token.kind === TokenKind.EndOfLine || token.kind === TokenKind.EndOfFile) {
      return [];
    }
    if (token.kind === TokenKind.Comment) {
      return [];
    }
    if (token.kind === TokenKind.Punct) {
      if (token.text === '(' || token.text === '[') {
        depth++;
      } else if (token.text === ')' || token.text === ']') {
        depth--;
      }
      continue;
    }
    if (depth === 0 && token.kind === TokenKind.Identifier && token.text.toLowerCase() === 'to') {
      return args;
    }
    args.push(token);
  }
  return [];
}

/** Everything from `from` up to the end of the logical line, comments excluded. */
function valueTail(tokens: readonly Token[], from: number): Token[] {
  const value: Token[] = [];
  for (let at = from; at < tokens.length; at++) {
    const token = tokens[at]!;
    if (token.kind === TokenKind.EndOfLine || token.kind === TokenKind.EndOfFile) {
      break;
    }
    // A trailing `// comment` is not part of the value, and DataFlex sources are full of them.
    if (token.kind === TokenKind.Comment) {
      break;
    }
    value.push(token);
  }
  return value;
}

/**
 * Index of the statement's first token.
 *
 * Statements occupy one logical line, so this scans for the first token on the header line at or
 * past the header's start column, and gives up as soon as the scan runs past that line.
 */
function firstTokenIndex(unit: SourceUnit, node: DfNode): number {
  const line = node.headerRange.start.line;
  const column = node.headerRange.start.character;

  for (let i = 0; i < unit.tokens.length; i++) {
    const token = unit.tokens[i]!;
    if (token.range.start.line < line) {
      continue;
    }
    if (token.range.start.line > line) {
      return -1;
    }
    if (token.range.start.character >= column) {
      return i;
    }
  }
  return -1;
}
