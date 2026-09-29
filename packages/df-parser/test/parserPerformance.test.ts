import { describe, expect, it } from 'vitest';
import { parseSource } from '../src/parser';

/**
 * Guards parser throughput and its scaling.
 *
 * The parser is on the keystroke path: every edit reparses the file before analysis, hover or
 * completion can answer. A real workspace is 27 MB across 1,700 files and parses in about two
 * seconds, roughly 14 KB/ms; the budgets here are far looser than that, because the failure this
 * catches is a change of *shape* -- something quadratic -- not a few percent of drift.
 *
 * Two quadratics have already reached this codebase and neither was visible in a small test:
 * `ExpressionParser.textBetween` scanned the whole token array per node, and the lexer treated a
 * `"""` inside a macro header as a string opener and swallowed 1,900 lines. Both looked fine until
 * a file got large.
 */

/** A file with the shape real DataFlex has: nested blocks, expressions, many statements. */
function generate(procedures: number, statementsEach: number): string {
  const lines: string[] = ['Class cGenerated is a cObject'];
  for (let p = 0; p < procedures; p++) {
    lines.push(`    Procedure Method${p} String sArg${p}`);
    lines.push('        String sLocal');
    lines.push('        Integer iCount');
    for (let s = 0; s < statementsEach; s++) {
      lines.push(`        Move (Trim("value ${s}") + sArg${p}) to sLocal`);
      lines.push('        If (sLocal <> "") Begin');
      lines.push('            Increment iCount');
      lines.push('        End');
    }
    lines.push('    End_Procedure');
  }
  lines.push('End_Class');
  return lines.join('\n');
}

describe('parser performance', () => {
  it('parses a large file well inside the budget', () => {
    const source = generate(300, 4);

    // Best of three. A single sample makes this a load test of whatever else the machine is
    // doing: the suite runs files in parallel workers, and one unlucky run failed this budget
    // while the code was unchanged. The minimum is the run that was not interrupted.
    let best = Infinity;
    let unit = parseSource(source, { uri: 'generated.pkg' });
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      unit = parseSource(source, { uri: 'generated.pkg' });
      best = Math.min(best, performance.now() - started);
    }

    expect(unit.root.children?.length).toBeGreaterThan(0);
    // Around 1 MB. Comfortably met at a fraction of this; a quadratic takes minutes.
    expect(best).toBeLessThan(5000);
  });

  it('scales sub-quadratically as the file grows', () => {
    const small = generate(150, 4);
    const large = generate(600, 4);

    /**
     * Best of several runs. A single timing is not safe to divide by: the suite runs files in
     * parallel workers, so one run can absorb a GC pause and come back several times its true
     * cost, and that noise lands on whichever side of the ratio it hits.
     */
    const time = (source: string): number => {
      let best = Infinity;
      for (let run = 0; run < 3; run++) {
        const started = performance.now();
        parseSource(source, { uri: 'generated.pkg' });
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };

    time(small);
    time(large);

    const smallMs = Math.max(time(small), 1);
    const largeMs = Math.max(time(large), 1);

    // 4x the input. Linear would be ~4x; quadratic would be ~16x and climbing.
    expect(largeMs / smallMs).toBeLessThan(9);
  });

  /**
   * The macro library is the worst real input: 12,600 lines, 444 `#COMMAND` bodies of template
   * text, and quoted forms that are not strings. Its shape once cost 148 command definitions.
   */
  it('parses macro-heavy source without slowing down', () => {
    const lines: string[] = [];
    for (let i = 0; i < 400; i++) {
      lines.push(`#COMMAND CMD_${i} NDI """SEND""BEGIN_PULL_DOWN"`);
      lines.push('  #IF (!0<2)');
      lines.push('    Send Something !1');
      lines.push('  #ENDIF');
      lines.push('#ENDCOMMAND');
    }
    const source = lines.join('\n');

    let best = Infinity;
    let unit = parseSource(source, { uri: 'fmac' });
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      unit = parseSource(source, { uri: 'fmac' });
      best = Math.min(best, performance.now() - started);
    }

    // Every command must survive: a swallowed quote would lose all the ones that follow.
    const commands = (unit.root.children ?? []).filter((node) => node.kind === 'command');
    expect(commands).toHaveLength(400);
    expect(best).toBeLessThan(3000);
  });
});
