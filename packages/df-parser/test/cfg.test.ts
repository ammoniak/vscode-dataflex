import { describe, expect, it } from 'vitest';
import { parseSource } from '../src/parser';
import { DfNode, walk } from '../src/ast';
import { buildCfg, reachableBlocks, unreachableStatements } from '../src/cfg';

/** Builds the CFG for the first procedure or function in `source`. */
function cfgOf(source: string) {
  const unit = parseSource(source, { uri: 'test.pkg' });
  let scope: DfNode | undefined;
  walk(unit.root, (node) => {
    if (scope === undefined && (node.kind === 'procedure' || node.kind === 'function')) {
      scope = node;
    }
  });
  if (scope === undefined) {
    throw new Error('no procedure found in fixture');
  }
  return buildCfg(scope);
}

/** Source text of every statement the graph says cannot run. */
function deadText(source: string): string[] {
  return unreachableStatements(cfgOf(source)).map((node) => (node.text ?? '').trim());
}

/**
 * Dead statements excluding case-arm terminators.
 *
 * A `Case Break` after a `Function_Return` genuinely cannot run, and the graph says so. Whether
 * that is worth *reporting* is a separate question -- DataFlex authors close every arm with one
 * out of habit -- so the filtering belongs in the rule, not in the graph.
 */
function deadRealText(source: string): string[] {
  return unreachableStatements(cfgOf(source))
    .filter((node) => node.verb !== 'case')
    .map((node) => (node.text ?? '').trim());
}

describe('buildCfg', () => {
  it('gives a straight-line body one path from entry to exit', () => {
    const cfg = cfgOf(
      ['Procedure Foo', '    Send A', '    Send B', '    Send C', 'End_Procedure'].join('\n')
    );
    expect(reachableBlocks(cfg).has(cfg.exit)).toBe(true);
    expect(unreachableStatements(cfg)).toEqual([]);
  });

  it('branches an If and rejoins after it', () => {
    const cfg = cfgOf(
      [
        'Procedure Foo',
        '    Send Before',
        '    If (x) Begin',
        '        Send Inside',
        '    End',
        '    Send After',
        'End_Procedure'
      ].join('\n')
    );
    // `Send After` runs whether or not the branch is taken.
    expect(unreachableStatements(cfg)).toEqual([]);
    expect(cfg.imprecise).toBe(false);
  });

  it('pairs a sibling Else with its If', () => {
    // DataFlex writes `Else` as a sibling of the `If` block, not nested inside it.
    const cfg = cfgOf(
      [
        'Procedure Foo',
        '    If (x) Begin',
        '        Send A',
        '    End',
        '    Else Begin',
        '        Send B',
        '    End',
        '    Send After',
        'End_Procedure'
      ].join('\n')
    );
    expect(unreachableStatements(cfg)).toEqual([]);
  });

  it('treats a return in one branch as leaving only that branch', () => {
    expect(
      deadText(
        [
          'Procedure Foo',
          '    If (x) Begin',
          '        Procedure_Return',
          '    End',
          '    Send StillReachable',
          'End_Procedure'
        ].join('\n')
      )
    ).toEqual([]);
  });

  it('finds code after an unconditional return', () => {
    expect(
      deadText(
        ['Procedure Foo', '    Procedure_Return', '    Send NeverRuns', 'End_Procedure'].join('\n')
      )
    ).toEqual(['Send NeverRuns']);
  });

  it('does not treat a single-line conditional return as unconditional', () => {
    // `If (bDone) Function_Return 0` guards the return; what follows is reachable.
    expect(
      deadText(
        [
          'Function Foo Returns Integer',
          '    If (bDone) Function_Return 0',
          '    Send DoWork',
          '    Function_Return 1',
          'End_Function'
        ].join('\n')
      )
    ).toEqual([]);
  });

  it('keeps code after an If / Else If chain reachable when no arm matches', () => {
    // Found as a false positive on real code: `Else If (c) Begin` is a *conditional* else, so if
    // neither test passes control falls past the whole chain. Treating it as an unconditional
    // else made everything after it look dead.
    expect(
      deadText(
        [
          'Procedure Foo',
          '    If (a) Begin',
          '        Procedure_Return',
          '    End',
          '    Else If (b) Begin',
          '        Procedure_Return',
          '    End',
          '    Send StillReachable',
          'End_Procedure'
        ].join('\n')
      )
    ).toEqual([]);
  });

  it('finds code after a chain whose final Else is unconditional', () => {
    // Every path returns here, so the trailing statement really is dead.
    expect(
      deadText(
        [
          'Function F Returns String',
          '    If (a) Begin',
          '        Function_Return "x"',
          '    End',
          '    Else Begin',
          '        Function_Return "y"',
          '    End',
          '    Function_Return "never"',
          'End_Function'
        ].join('\n')
      )
    ).toEqual(['Function_Return "never"']);
  });

  it('records the condition of an Else If written with Begin', () => {
    const unit = parseSource(
      ['Procedure Foo', '    Else If (bReady) Begin', '        Send A', '    End', 'End_Procedure'].join('\n'),
      { uri: 'test.pkg' }
    );
    let elseBlock: DfNode | undefined;
    walk(unit.root, (node) => {
      if (node.kind === 'block' && node.blockKind === 'else') {
        elseBlock = node;
      }
    });
    expect(elseBlock?.condition).toBe('(bReady)');
  });

  it('finds code after a return in both branches', () => {
    const dead = deadText(
      [
        'Function Foo Returns Integer',
        '    If (x) Begin',
        '        Function_Return 1',
        '    End',
        '    Else Begin',
        '        Function_Return 2',
        '    End',
        '    Send Unreachable',
        'End_Function'
      ].join('\n')
    );
    expect(dead).toEqual(['Send Unreachable']);
  });
});

describe('loops', () => {
  it('lets a While body run zero times, so code after it is reachable', () => {
    expect(
      deadText(
        [
          'Procedure Foo',
          '    While (x)',
          '        Send Inside',
          '    Loop',
          '    Send After',
          'End_Procedure'
        ].join('\n')
      )
    ).toEqual([]);
  });

  it('keeps code after a Repeat reachable', () => {
    expect(
      deadText(
        [
          'Procedure Foo',
          '    Repeat',
          '        Send Inside',
          '    Until (x)',
          '    Send After',
          'End_Procedure'
        ].join('\n')
      )
    ).toEqual([]);
  });

  it('routes Break out of the loop rather than out of the procedure', () => {
    expect(
      deadText(
        [
          'Procedure Foo',
          '    For i from 1 to 10',
          '        Break',
          '    Loop',
          '    Send After',
          'End_Procedure'
        ].join('\n')
      )
    ).toEqual([]);
  });
});

describe('case blocks', () => {
  it('treats each arm as its own path', () => {
    // Every arm returns, but the next arm's label is still an entry point.
    expect(
      deadRealText(
        [
          'Function F Returns String',
          '    Case Begin',
          '        Case (x=1)',
          '            Function_Return "a"',
          '            Case Break',
          '        Case (x=2)',
          '            Function_Return "b"',
          '            Case Break',
          '    Case End',
          'End_Function'
        ].join('\n')
      )
    ).toEqual([]);
  });

  it('finds dead code inside an arm', () => {
    expect(
      deadText(
        [
          'Function F Returns String',
          '    Case Begin',
          '        Case (x=1)',
          '            Function_Return "a"',
          '            Send NeverRuns',
          '            Case Break',
          '    Case End',
          'End_Function'
        ].join('\n')
      )
    ).toContain('Send NeverRuns');
  });

  it('reports an arm terminator that follows a return, truthfully', () => {
    // The graph does not soften this: `Case Break` after `Function_Return` cannot run. The
    // unreachable-code rule filters arm terminators out; the graph reports what is true.
    const dead = deadText(
      [
        'Function F Returns String',
        '    Case Begin',
        '        Case (x=1)',
        '            Function_Return "a"',
        '            Case Break',
        '    Case End',
        'End_Function'
      ].join('\n')
    );
    expect(dead).toEqual(['Case Break']);
  });

  it('keeps code after a case block reachable when no arm matches', () => {
    expect(
      deadText(
        [
          'Procedure Foo',
          '    Case Begin',
          '        Case (x=1)',
          '            Send A',
          '            Case Break',
          '    Case End',
          '    Send After',
          'End_Procedure'
        ].join('\n')
      )
    ).toEqual([]);
  });
});

describe('tolerance', () => {
  it('builds a graph for an unterminated procedure', () => {
    expect(() => cfgOf('Procedure Foo\n    Send A\n')).not.toThrow();
  });

  it('handles an empty body', () => {
    const cfg = cfgOf('Procedure Foo\nEnd_Procedure\n');
    expect(reachableBlocks(cfg).has(cfg.exit)).toBe(true);
    expect(unreachableStatements(cfg)).toEqual([]);
  });

  it('reports nothing once the graph is imprecise', () => {
    // An unmodelled jump could reach anything; claiming code is dead would be worse than silence.
    const cfg = cfgOf(
      ['Procedure Foo', '    Goto SomeLabel', '    Send Maybe', 'End_Procedure'].join('\n')
    );
    expect(cfg.imprecise).toBe(true);
    expect(unreachableStatements(cfg)).toEqual([]);
  });
});
