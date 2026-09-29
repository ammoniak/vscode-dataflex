import { describe, expect, it } from 'vitest';
import { parseSource } from '@vscode-dataflex/parser';
import type { DfNode } from '@vscode-dataflex/parser';
import { argumentTokensBeforeTo, valueTokensAfterTo } from '../src/statementValues';

/**
 * The middle of a statement, which the parser drops along with the value.
 *
 * `WebSetResponsive piColumnSpan rmTablet to 12` reaches the AST as verb plus `target`, so the
 * mode -- the part that decides when the rule applies -- survives only in the token stream.
 */
function statement(source: string): { unit: ReturnType<typeof parseSource>; node: DfNode } {
  const unit = parseSource(source, { uri: 'x.wo' });
  let found: DfNode | undefined;
  const walk = (node: DfNode): void => {
    if (found === undefined && node.verb !== undefined) {
      found = node;
    }
    for (const child of node.children ?? []) {
      walk(child);
    }
  };
  for (const child of unit.root.children ?? []) {
    walk(child);
  }
  return { unit, node: found! };
}

function args(source: string): string[] {
  const { unit, node } = statement(source);
  return argumentTokensBeforeTo(unit, node).map((token) => token.text);
}

describe('argumentTokensBeforeTo', () => {
  it('returns the arguments between the verb and the top-level to', () => {
    expect(args('WebSetResponsive piColumnSpan rmTablet to 12')).toEqual([
      'piColumnSpan',
      'rmTablet'
    ]);
  });

  it('stops at the to, leaving the value to valueTokensAfterTo', () => {
    const source = 'WebSetResponsive peRegion rmMobile to prTop';
    const { unit, node } = statement(source);

    expect(argumentTokensBeforeTo(unit, node).map((t) => t.text)).toEqual(['peRegion', 'rmMobile']);
    expect(valueTokensAfterTo(unit, node).map((t) => t.text)).toEqual(['prTop']);
  });

  it('is a single argument for an ordinary Set', () => {
    expect(args('Set psCaption to "Customer"')).toEqual(['psCaption']);
  });

  it('keeps an of clause, which belongs to the arguments', () => {
    expect(args('Set psLabel of oInner to "x"')).toEqual(['psLabel', 'of', 'oInner']);
  });

  it('is empty when the statement has no to at all', () => {
    expect(args('Send Refresh')).toEqual([]);
  });

  it('ignores a to inside parentheses, as the value reader does', () => {
    expect(args('Set piValue to (Foo(a to b))')).toEqual(['piValue']);
  });

  it('is empty rather than wrong when a comment interrupts before the to', () => {
    expect(args('Send Something // note about to something')).toEqual([]);
  });
});
