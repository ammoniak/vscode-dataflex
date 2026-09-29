import { describe, expect, it } from 'vitest';
import { walk } from '../src/ast';
import { callArguments, parseArgumentList, parseExpression } from '../src/expression';
import { lex } from '../src/lexer';
import { parseSource } from '../src/parser';
import type { DfNode } from '../src/ast';
import type { ExprNode } from '../src/expression';

function expr(source: string): ExprNode {
  const tokens = lex(source).tokens;
  return parseExpression(tokens, 0, tokens.length);
}

function args(source: string): ExprNode[] {
  const tokens = lex(source).tokens;
  return parseArgumentList(tokens, 0, tokens.length);
}

/** The first statement in a parsed file, with its arguments read back. */
function callIn(source: string) {
  const unit = parseSource(source, { uri: 'test.pkg' });
  let statement: DfNode | undefined;
  walk(unit.root, (node) => {
    if (statement === undefined && node.kind === 'statement') {
      statement = node;
    }
  });
  return callArguments(unit, statement!);
}

describe('parseExpression', () => {
  it('binds left to right, with no operator precedence', () => {
    // The Language Guide is explicit that `(1 + 2 * 4)` is 12, not 9: DataFlex has no precedence
    // table and parentheses are the only way to group. A conventional Pratt parser would build
    // `1 + (2 * 4)` here and silently disagree with the runtime.
    const node = expr('1 + 2 * 4');
    expect(node.kind).toBe('binary');
    expect(node.operator).toBe('*');
    expect(node.left!.kind).toBe('binary');
    expect(node.left!.operator).toBe('+');
    expect(node.left!.left!.name).toBe('1');
    expect(node.left!.right!.name).toBe('2');
    expect(node.right!.name).toBe('4');
  });

  it('lets parentheses regroup', () => {
    const node = expr('1 + (2 * 4)');
    expect(node.operator).toBe('+');
    expect(node.right!.kind).toBe('group');
    expect(node.right!.inner!.operator).toBe('*');
  });

  it('treats the word operators the same way', () => {
    const node = expr('a and b or c');
    expect(node.operator).toBe('or');
    expect(node.left!.operator).toBe('and');
  });

  it('reads a call in expression form', () => {
    const node = expr('Trim(sName)');
    expect(node.kind).toBe('call');
    expect(node.callee).toBe('Trim');
    expect(node.args!.map((arg) => arg.name)).toEqual(['sName']);
  });

  it('separates a call from a bare parenthesis by adjacency', () => {
    // `Foo(a)` is a call; `Foo (a)` is a name followed by a separate parenthesised term. Nothing
    // but the whitespace distinguishes them, and getting it wrong miscounts every call site.
    expect(expr('Foo(a)').kind).toBe('call');
    expect(args('Foo (a)').map((arg) => arg.kind)).toEqual(['identifier', 'group']);
  });

  it('reads a comma-separated argument list inside a call', () => {
    const node = expr('DateTimeByDate(dDate, iHour, 0)');
    expect(node.args!.map((arg) => arg.text)).toEqual(['dDate', 'iHour', '0']);
  });

  it('reads array subscripts', () => {
    const node = expr('aValues[iRow]');
    expect(node.kind).toBe('index');
    expect(node.target!.name).toBe('aValues');
    expect(node.subscript!.name).toBe('iRow');
  });

  it('keeps a dotted name whole', () => {
    // The lexer already produces `Customer.Name` as one identifier, so member access needs no
    // operator of its own.
    expect(expr('Customer.Name').kind).toBe('identifier');
    expect(expr('Customer.Name').name).toBe('Customer.Name');
  });

  it('reads a by-reference argument', () => {
    const node = expr('&sResult');
    expect(node.operator).toBe('&');
    expect(node.byRef).toBe(true);
    expect(node.operand!.name).toBe('sResult');
  });

  it('reads unary minus and not', () => {
    expect(expr('-1').operator).toBe('-');
    expect(expr('not bDone').operator).toBe('not');
  });

  it('does not throw on an unclosed parenthesis', () => {
    expect(() => expr('(a + ')).not.toThrow();
  });

  it('does not throw on an empty range', () => {
    expect(() => expr('')).not.toThrow();
  });
});

describe('parseArgumentList', () => {
  it('splits on whitespace, not commas', () => {
    expect(args('a b c').map((arg) => arg.text)).toEqual(['a', 'b', 'c']);
  });

  it('keeps a parenthesised expression as one argument', () => {
    expect(args('(sName + "!") (Foo(oX, 1)) 3').map((arg) => arg.kind)).toEqual([
      'group',
      'group',
      'number'
    ]);
  });

  it('counts a negative literal as one argument, not two', () => {
    expect(args('a -1').map((arg) => arg.text)).toEqual(['a', '-1']);
  });

  it('stops at a `to` clause', () => {
    expect(args('a b to sResult').map((arg) => arg.text)).toEqual(['a', 'b']);
  });

  it('returns nothing for an empty list', () => {
    expect(args('')).toEqual([]);
  });
});

describe('forms found in the corpus', () => {
  it('treats a spaced call as a call inside parentheses', () => {
    // `(RefClass (DfBaseEntry))` is one call: inside brackets a space before `(` does not
    // separate anything, and DataFlex code writes it both ways.
    const node = expr('(RefClass (DfBaseEntry))');
    expect(node.kind).toBe('group');
    expect(node.inner!.kind).toBe('call');
    expect(node.inner!.callee).toBe('RefClass');
  });

  it('still splits a spaced parenthesis at statement level', () => {
    // The same spelling outside brackets is a message name and a separate argument.
    expect(args('RefClass (DfBaseEntry)').map((arg) => arg.kind)).toEqual(['identifier', 'group']);
  });

  it('reads a member reached through a subscript', () => {
    const node = expr('Constraints[i].iFile');
    expect(node.kind).toBe('member');
    expect(node.name).toBe('iFile');
    expect(node.target!.kind).toBe('index');
  });

  it('reads a dotted name whose tail is a number', () => {
    // `Index.6` -- the lexer only folds a dot into an identifier when a letter follows.
    const node = expr('Index.6');
    expect(node.kind).toBe('member');
    expect(node.text).toBe('Index.6');
  });

  it('reads min and max as infix operators', () => {
    const node = expr('iHeight min iOrig');
    expect(node.kind).toBe('binary');
    expect(node.operator).toBe('min');
  });

  it('reads the # field prefix', () => {
    // Only mid-line: a `#` that starts a line is a preprocessor directive, so the prefix operator
    // is written the way it actually occurs, as an argument.
    const [, argument] = args('sPath #tDataPoint.sId');
    expect(argument!.operator).toBe('#');
    expect(argument!.operand!.text).toBe('tDataPoint.sId');
  });
});

describe('callArguments', () => {
  it('counts the arguments of a Send', () => {
    const call = callIn('Procedure Foo\n    Send PopDialogX "title" 3 oTarget\nEnd_Procedure');
    expect(call!.target).toBe('PopDialogX');
    expect(call!.args.map((arg) => arg.text)).toEqual(['"title"', '3', 'oTarget']);
    expect(call!.imprecise).toBe(false);
  });

  it('does not count the receiver of an `of` clause', () => {
    const call = callIn('Procedure Foo\n    Send Refresh of oGrid 1\nEnd_Procedure');
    expect(call!.ofObject).toBe('oGrid');
    expect(call!.args.map((arg) => arg.text)).toEqual(['1']);
  });

  it('does not count the destination of a Get', () => {
    const call = callIn('Procedure Foo\n    Get Sum 1 2 to iTotal\nEnd_Procedure');
    expect(call!.args.map((arg) => arg.text)).toEqual(['1', '2']);
  });

  it('counts a parenthesised expression as a single argument', () => {
    const call = callIn('Procedure Foo\n    Send Show (sA + sB) (Trim(sC))\nEnd_Procedure');
    expect(call!.args).toHaveLength(2);
    expect(call!.imprecise).toBe(false);
  });

  it('reports nothing for a statement that is not a call', () => {
    const call = callIn('Procedure Foo\n    Move 1 to iX\nEnd_Procedure');
    expect(call).toBeUndefined();
  });

  it('steps over an `of` receiver that is a whole expression', () => {
    // `of (phoWorkSpace(oApplication))` is ordinary DataFlex. Assuming the receiver is one token
    // lands mid-expression and turns the rest of the line into arguments.
    const call = callIn(
      'Procedure Foo\n    Get psDataPath of (phoWorkSpace(oApplication)) to sDataPath\nEnd_Procedure'
    );
    expect(call!.args).toEqual([]);
    expect(call!.imprecise).toBe(false);
  });

  it('steps over a subscripted message name and receiver', () => {
    const call = callIn('Procedure Foo\n    Send aMsg[i] of aObj[i] Self\nEnd_Procedure');
    expect(call!.args.map((arg) => arg.text)).toEqual(['Self']);
    expect(call!.imprecise).toBe(false);
  });

  it('reads a call with no arguments', () => {
    const call = callIn('Procedure Foo\n    Send Refresh\nEnd_Procedure');
    expect(call!.args).toEqual([]);
  });
});
