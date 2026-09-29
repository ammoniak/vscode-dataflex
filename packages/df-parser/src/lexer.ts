import { Token, TokenKind } from './tokens';

const TAB = 9;
const LF = 10;
const CR = 13;
const SPACE = 32;

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/**
 * Characters that may start an identifier.
 *
 * `$` is included on purpose: the DataFlex runtime library uses it inside generated and
 * reserved names (`Is$WebApp`, `C_$WebAppPropertyNotPublished`), so excluding it would split
 * those names into three tokens.
 */
function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$';
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

/**
 * `#` is a legal *trailing* identifier character in DataFlex -- the runtime library declares
 * parameters named `Row#` and `Col#`. It is only a preprocessor sigil when it introduces a
 * directive name, so absorb it into the identifier unless a letter follows.
 */
function isIdentTail(ch: string, next: string | undefined): boolean {
  if (isIdentPart(ch)) {
    return true;
  }
  return ch === '#' && !(next !== undefined && (isIdentStart(next) || isDigit(next)));
}

const TWO_CHAR_OPERATORS = new Set(['>=', '<=', '<>', '==', '++', '--', '+=', '-=']);

export interface LexResult {
  tokens: Token[];
  /** Offset of the first character of each line, for offset<->position conversion by callers. */
  lineStarts: number[];
}

/**
 * Turns DataFlex source into a token stream.
 *
 * The lexer never throws and never rejects input: anything it cannot classify becomes a
 * single-character `Punct` token. Physical lines whose last significant token is `;` are joined
 * into the following line (DataFlex's line-continuation rule), so `EndOfLine` tokens delimit
 * *logical* lines rather than physical ones.
 */
/**
 * Is this `"""` really an aligned multi-line string, or just quotes that happen to touch?
 *
 * The 2023 form either opens at the end of a line and closes on a later one, or opens and closes
 * on the same line. Anything else is three separate quote characters -- and the compiler's own
 * macro library relies on that reading:
 *
 *     #COMMAND ON_ITEM NDI """SEND""BEGIN_PULL_DOWN"
 *
 * is an empty string followed by `"SEND"`, not the start of a literal. Treating it as one swallowed
 * the remaining 1,900 lines of the macro library and cost 148 of the 444 `#COMMAND` definitions
 * that DataFlex's own statement vocabulary is built from.
 */
function opensTripleString(text: string, at: number): boolean {
  const after = at + 3;
  let end = text.indexOf('\n', after);
  if (end < 0) {
    end = text.length;
  }
  const rest = text.slice(after, end);

  // Closes on this line: a single-line triple-quoted string.
  if (rest.includes('"""')) {
    return true;
  }
  // Opens at end of line: the multi-line form. A trailing comment still counts as end of line.
  const beforeComment = rest.split('//')[0] ?? rest;
  return beforeComment.trim().length === 0;
}

export function lex(text: string): LexResult {
  const tokens: Token[] = [];
  const lineStarts: number[] = [0];

  // A UTF-8 BOM decoded as a single character would otherwise be lexed as an identifier and
  // glue itself onto the first token of the file.
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 0;
  let lineStart = 0;
  let firstOnLine = true;

  const len = text.length;

  /** Advances one character, keeping line bookkeeping correct across newlines. */
  const advance = (): void => {
    if (text.charCodeAt(pos) === LF) {
      line++;
      lineStart = pos + 1;
      lineStarts.push(lineStart);
    }
    pos++;
  };

  const push = (kind: TokenKind, start: number, end: number): Token => {
    const token: Token = {
      kind,
      text: text.slice(start, end),
      start,
      end,
      range: {
        start: { line, character: start - lineStart },
        end: { line, character: end - lineStart }
      },
      firstOnLine
    };
    tokens.push(token);
    firstOnLine = false;
    return token;
  };

  /**
   * Pushes a token that may span physical lines (a block comment or a multi-line string). The
   * caller has already advanced `pos` past the token, so the *current* line/lineStart describe
   * its end and the captured ones describe its start.
   */
  const pushSpanning = (
    kind: TokenKind,
    start: number,
    startLine: number,
    startLineStart: number
  ): void => {
    tokens.push({
      kind,
      text: text.slice(start, pos),
      start,
      end: pos,
      range: {
        start: { line: startLine, character: start - startLineStart },
        end: { line, character: pos - lineStart }
      },
      firstOnLine
    });
    firstOnLine = false;
  };

  /** The last token that can terminate a statement, ignoring comments. */
  const lastSignificant = (): Token | undefined => {
    for (let i = tokens.length - 1; i >= 0; i--) {
      const t = tokens[i]!;
      if (t.kind !== TokenKind.Comment) {
        return t;
      }
    }
    return undefined;
  };

  /**
   * Scans a literal that runs until `closer`, consuming newlines on the way.
   *
   * Used for `/* ... *​/`, `@"..."`, `@SQL"..."` and `"""..."""`. An unterminated one ends at
   * end of file rather than throwing.
   */
  const scanUntil = (closer: string): void => {
    while (pos < len && !text.startsWith(closer, pos)) {
      advance();
    }
    for (let i = 0; i < closer.length && pos < len; i++) {
      advance();
    }
  };

  while (pos < len) {
    const code = text.charCodeAt(pos);

    // --- whitespace -------------------------------------------------------
    if (code === SPACE || code === TAB) {
      pos++;
      continue;
    }

    // --- newline ----------------------------------------------------------
    if (code === CR || code === LF) {
      const nlStart = pos;
      if (code === CR && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
      } else {
        pos += 1;
      }

      // A trailing `;` continues the statement onto the next physical line. The marker itself
      // carries no other meaning, so drop it and suppress the logical line break.
      const last = lastSignificant();
      const continued = last !== undefined && last.kind === TokenKind.Punct && last.text === ';';
      if (continued) {
        tokens.splice(tokens.indexOf(last), 1);
      } else if (tokens.length > 0 && tokens[tokens.length - 1]!.kind !== TokenKind.EndOfLine) {
        push(TokenKind.EndOfLine, nlStart, nlStart);
      }

      line++;
      lineStart = pos;
      lineStarts.push(pos);
      firstOnLine = true;
      continue;
    }

    const ch = text[pos]!;

    // --- block comment ----------------------------------------------------
    // Spans physical lines; consuming the newlines here is what makes the whole comment a
    // single token, so it does not split the statement it is embedded in.
    if (ch === '/' && text[pos + 1] === '*') {
      const start = pos;
      const startLine = line;
      const startLineStart = lineStart;
      pos += 2;
      scanUntil('*/');
      pushSpanning(TokenKind.Comment, start, startLine, startLineStart);
      continue;
    }

    // --- line comment -----------------------------------------------------
    if (ch === '/' && text[pos + 1] === '/') {
      const start = pos;
      while (pos < len && text.charCodeAt(pos) !== LF && text.charCodeAt(pos) !== CR) {
        pos++;
      }
      push(TokenKind.Comment, start, pos);
      continue;
    }

    // --- preprocessor directive ------------------------------------------
    if (ch === '#' && firstOnLine) {
      const start = pos;
      pos++;
      while (pos < len && isIdentPart(text[pos]!)) {
        pos++;
      }
      const token = push(TokenKind.Directive, start, pos);

      // `#REM` comments out the remainder of the physical line.
      if (token.text.toLowerCase() === '#rem') {
        const commentStart = pos;
        while (pos < len && text.charCodeAt(pos) !== LF && text.charCodeAt(pos) !== CR) {
          pos++;
        }
        if (pos > commentStart) {
          push(TokenKind.Comment, commentStart, pos);
        }
      }
      continue;
    }

    // --- aligned multi-line string: """ ... """ ---------------------------
    // Introduced in DataFlex 2023 for embedding SQL, JavaScript and HTML; quotes may appear
    // freely inside, so the terminator is the triple quote and nothing else.
    if (ch === '"' && text[pos + 1] === '"' && text[pos + 2] === '"' && opensTripleString(text, pos)) {
      const start = pos;
      const startLine = line;
      const startLineStart = lineStart;
      pos += 3;
      scanUntil('"""');
      pushSpanning(TokenKind.String, start, startLine, startLineStart);
      continue;
    }

    // --- prefixed multi-line string: @"..." and @SQL"..." -----------------
    // Both span physical lines. Missing this makes every subsequent line of the literal lex as
    // code -- which is how embedded SQL turns into a stream of `Select` / `From` statements.
    if (ch === '@') {
      let lookahead = pos + 1;
      while (lookahead < len && isIdentPart(text[lookahead]!)) {
        lookahead++;
      }
      if (text[lookahead] === '"') {
        // The prefix combines with either quote style: `@SQL"..."` and `@SQL"""..."""` are
        // both real, and picking the wrong terminator ends the literal on the opening quote and
        // lexes the rest of the file as code.
        const triple = text[lookahead + 1] === '"' && text[lookahead + 2] === '"';
        const start = pos;
        const startLine = line;
        const startLineStart = lineStart;
        pos = lookahead + (triple ? 3 : 1);
        scanUntil(triple ? '"""' : '"');
        pushSpanning(TokenKind.String, start, startLine, startLineStart);
        continue;
      }
      // Not a string prefix; fall through and emit `@` as punctuation.
    }

    // --- single-line string literal ---------------------------------------
    // DataFlex has no escape sequences; a literal containing one quote character is written
    // using the other one. An unterminated literal ends at the line break.
    if (ch === '"' || ch === "'") {
      const start = pos;
      const quote = ch;
      pos++;
      while (pos < len) {
        const c = text.charCodeAt(pos);
        if (c === LF || c === CR) {
          break;
        }
        pos++;
        if (text[pos - 1] === quote) {
          break;
        }
      }
      push(TokenKind.String, start, pos);
      continue;
    }

    // --- number -----------------------------------------------------------
    if (isDigit(ch)) {
      const start = pos;
      while (pos < len && isDigit(text[pos]!)) {
        pos++;
      }
      if (text[pos] === '.' && isDigit(text[pos + 1] ?? '')) {
        pos++;
        while (pos < len && isDigit(text[pos]!)) {
          pos++;
        }
      }
      push(TokenKind.Number, start, pos);
      continue;
    }

    // --- identifier, possibly dotted (`Customer.Name`, `oObj.psValue`) ----
    if (isIdentStart(ch)) {
      const start = pos;
      while (pos < len && isIdentTail(text[pos]!, text[pos + 1])) {
        pos++;
      }
      while (text[pos] === '.' && isIdentStart(text[pos + 1] ?? '')) {
        pos++;
        while (pos < len && isIdentTail(text[pos]!, text[pos + 1])) {
          pos++;
        }
      }
      push(TokenKind.Identifier, start, pos);
      continue;
    }

    // --- operators and punctuation ---------------------------------------
    const two = text.slice(pos, pos + 2);
    if (TWO_CHAR_OPERATORS.has(two)) {
      push(TokenKind.Punct, pos, pos + 2);
      pos += 2;
      continue;
    }

    push(TokenKind.Punct, pos, pos + 1);
    pos += 1;
  }

  if (tokens.length > 0 && tokens[tokens.length - 1]!.kind !== TokenKind.EndOfLine) {
    push(TokenKind.EndOfLine, pos, pos);
  }
  push(TokenKind.EndOfFile, pos, pos);

  return { tokens, lineStarts };
}
