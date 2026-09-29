import { describe, expect, it } from 'vitest';
import { lex } from '../src/lexer';
import { TokenKind } from '../src/tokens';

/** Convenience: the significant (non-comment, non-EOL/EOF) token texts. */
function words(source: string): string[] {
  return lex(source)
    .tokens.filter(
      (t) =>
        t.kind !== TokenKind.EndOfLine &&
        t.kind !== TokenKind.EndOfFile &&
        t.kind !== TokenKind.Comment
    )
    .map((t) => t.text);
}

function logicalLineCount(source: string): number {
  return lex(source).tokens.filter((t) => t.kind === TokenKind.EndOfLine).length;
}

describe('lexer', () => {
  it('joins lines continued with a trailing semicolon and drops the marker', () => {
    const source = 'Send Initialize_StatusPanel to StatPnl ;\n    (Process_Caption(Self))\n';
    expect(words(source)).toEqual([
      'Send',
      'Initialize_StatusPanel',
      'to',
      'StatPnl',
      '(',
      'Process_Caption',
      '(',
      'Self',
      ')',
      ')'
    ]);
    expect(logicalLineCount(source)).toBe(1);
  });

  it('treats a trailing # as part of an identifier', () => {
    // The runtime library declares parameters named `Row#` and `Col#`.
    expect(words('Procedure Set Offset_Location Integer Row# Integer Col#')).toEqual([
      'Procedure',
      'Set',
      'Offset_Location',
      'Integer',
      'Row#',
      'Integer',
      'Col#'
    ]);
  });

  it('lexes a line-initial # as a preprocessor directive', () => {
    const tokens = lex('#IFDEF Is$WebApp\n').tokens;
    expect(tokens[0]!.kind).toBe(TokenKind.Directive);
    expect(tokens[0]!.text).toBe('#IFDEF');
    expect(tokens[1]!.text).toBe('Is$WebApp');
  });

  it('accepts $ inside identifiers', () => {
    expect(words('Define Is$WebApp')).toEqual(['Define', 'Is$WebApp']);
  });

  it('keeps a dotted name as one token', () => {
    expect(words('Entry_Item Customer.Customer_Number')).toEqual([
      'Entry_Item',
      'Customer.Customer_Number'
    ]);
  });

  it('does not mistake a decimal literal for a dotted name', () => {
    const tokens = lex('Define C_DFVersion for "26.0"\n').tokens;
    expect(tokens.find((t) => t.kind === TokenKind.String)!.text).toBe('"26.0"');
  });

  it('spans a block comment across lines without splitting the surrounding code', () => {
    const source = 'Struct tA\nEnd_Struct\n\n/*\nClass for processing ini files.\nMore prose.\n*/\nClass cIniProcessor is a cObject\n';
    expect(words(source)).toEqual([
      'Struct',
      'tA',
      'End_Struct',
      'Class',
      'cIniProcessor',
      'is',
      'a',
      'cObject'
    ]);
  });

  it('reports positions after a multi-line block comment', () => {
    const source = '/*\na\nb\n*/\nUse x.pkg\n';
    const use = lex(source).tokens.find((t) => t.text === 'Use')!;
    expect(use.range.start.line).toBe(4);
    expect(use.range.start.character).toBe(0);
  });

  it('skips a UTF-8 BOM', () => {
    expect(words('﻿Use Windows.pkg')).toEqual(['Use', 'Windows.pkg']);
  });

  it('ends an unterminated string at the line break rather than running away', () => {
    const tokens = lex('Set psLabel to "oops\nUse x.pkg\n').tokens;
    const strings = tokens.filter((t) => t.kind === TokenKind.String);
    expect(strings).toHaveLength(1);
    expect(strings[0]!.text).toBe('"oops');
    expect(tokens.some((t) => t.text === 'Use')).toBe(true);
  });

  describe('multi-line string literals', () => {
    it('spans lines for the @"..." form', () => {
      const source = 'Set psTooltipText to (@"[bold]Kunden\n● Total: {kunden}\n● A: {a}")\nEnd_Object\n';
      const strings = lex(source).tokens.filter((t) => t.kind === TokenKind.String);
      expect(strings).toHaveLength(1);
      expect(strings[0]!.text).toContain('Total');
      // The code after the literal must still be code.
      expect(words(source)).toContain('End_Object');
    });

    it('spans lines for the aligned triple-quoted form', () => {
      const source = 'Move """\nfunction hello() { window.alert("hi"); }\n""" to sJavaScript\n';
      const strings = lex(source).tokens.filter((t) => t.kind === TokenKind.String);
      expect(strings).toHaveLength(1);
      // Quotes inside an aligned literal are content, not terminators.
      expect(strings[0]!.text).toContain('window.alert("hi")');
      expect(words(source)).toEqual(['Move', strings[0]!.text, 'to', 'sJavaScript']);
    });

    it('handles the @SQL"..." single-quote form', () => {
      const source = 'Get SQLExecDirect of ghoExec @SQL"SELECT Name\nFROM Customer" to aRows\n';
      const strings = lex(source).tokens.filter((t) => t.kind === TokenKind.String);
      expect(strings).toHaveLength(1);
      expect(strings[0]!.text).toContain('FROM Customer');
      expect(words(source)).toContain('aRows');
    });

    it('handles the prefixed triple-quoted form', () => {
      // `@SQL"""` combines the prefix with the aligned form. Terminating on the opening quote's
      // second character lexes the remaining SQL -- and the rest of the file -- as code.
      const source = [
        '    Move @SQL"""',
        '        SELECT Betrag FROM Kassabuch',
        '        WHERE Datum > 0',
        '    """ to sSQLStatement',
        'End_Procedure'
      ].join('\n');
      const strings = lex(source).tokens.filter((t) => t.kind === TokenKind.String);
      expect(strings).toHaveLength(1);
      expect(strings[0]!.text).toContain('WHERE Datum');
      expect(words(source)).toEqual([
        'Move',
        strings[0]!.text,
        'to',
        'sSQLStatement',
        'End_Procedure'
      ]);
    });

    it('reports positions after a multi-line string', () => {
      const source = 'Move @"a\nb\nc" to s\nEnd_Procedure\n';
      const end = lex(source).tokens.find((t) => t.text === 'End_Procedure')!;
      expect(end.range.start.line).toBe(3);
      expect(end.range.start.character).toBe(0);
    });

    it('ends an unterminated multi-line string at EOF instead of hanging', () => {
      expect(() => lex('Move @"never closed\nmore text\n')).not.toThrow();
      expect(() => lex('Move """never closed\nmore text\n')).not.toThrow();
    });

    it('leaves a bare @ as punctuation', () => {
      expect(words('Move @foo to x')).toEqual(['Move', '@', 'foo', 'to', 'x']);
    });
  });

  it('never throws on binary-ish garbage', () => {
    // NUL, SOH and a stray high byte: what a mis-detected binary file looks like.
    expect(() => lex('\u0000\u0001\u00ff??>><<{}[]|~`')).not.toThrow();
  });
});

/**
 * `"""` is an aligned multi-line string only in the two shapes DataFlex actually writes.
 *
 * The compiler's own macro library depends on the distinction:
 *
 *     #COMMAND ON_ITEM NDI """SEND""BEGIN_PULL_DOWN"
 *
 * is an empty string followed by `"SEND"`. Reading it as a literal swallowed the remaining 1,900
 * lines of `Lib/FMAC` and lost 148 of the 444 `#COMMAND` definitions that DataFlex's statement
 * vocabulary is built from -- so `WebSetResponsive` and its kin parsed as unknown everywhere.
 */
describe('triple-quoted strings', () => {
  /** The whole span the lexer treated as one string token, if any. */
  function stringTokens(text: string): string[] {
    return lex(text)
      .tokens.filter((token) => token.kind === TokenKind.String)
      .map((token) => token.text);
  }

  it('opens a multi-line string when the line ends after the quotes', () => {
    const text = 'Move """\nline one\nline two\n""" to sX\n';
    const strings = stringTokens(text);
    expect(strings).toHaveLength(1);
    expect(strings[0]).toContain('line one');
    expect(strings[0]).toContain('line two');
  });

  it('allows a trailing comment after the opening quotes', () => {
    const strings = stringTokens('Move """ // sql\nSELECT 1\n""" to sX\n');
    expect(strings[0]).toContain('SELECT 1');
  });

  it('handles a triple-quoted string opened and closed on one line', () => {
    const strings = stringTokens('Move """text""" to sX\n');
    expect(strings).toHaveLength(1);
    expect(strings[0]).toBe('"""text"""');
  });

  /** The macro-library case: quotes that merely touch, with no closing triple on the line. */
  it('does not swallow the file when quotes merely touch', () => {
    const text = '#COMMAND ON_ITEM NDI """SEND""BEGIN_PULL_DOWN"\n#ENDCOMMAND\n#COMMAND OTHER\n#ENDCOMMAND\n';
    const strings = stringTokens(text);
    // Several short strings on the first line, not one spanning the whole file.
    for (const value of strings) {
      expect(value).not.toContain('#ENDCOMMAND');
    }
  });

  it('leaves the following lines to be lexed as code', () => {
    const text = '#COMMAND X NDI """A""B"\n#ENDCOMMAND\n';
    const directives = lex(text).tokens.filter((t) => t.text.toLowerCase() === '#endcommand');
    expect(directives).toHaveLength(1);
  });
});
