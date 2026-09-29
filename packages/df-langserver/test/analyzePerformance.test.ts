import { describe, expect, it } from 'vitest';
import { parseSource } from '@vscode-dataflex/parser';
import { analyze } from '../src/analysis/analyze';

/**
 * Guards the shape that made analysis unusable.
 *
 * Reference counting used to filter the whole file's token array once per declaration, which is
 * O(tokens x declarations). On a real 64k-line generated wrapper that took 214 *seconds* -- on a
 * 300 ms debounce after every keystroke. The fix tallies each scope once.
 *
 * The synthetic file below has the shape that triggers it: many procedures, each with several
 * locals. Anything quadratic here takes minutes rather than milliseconds, so the budget does not
 * need to be tight to catch a regression.
 */
function generate(procedures: number, localsEach: number): string {
  const lines: string[] = ['Class cGenerated is a cObject'];
  for (let p = 0; p < procedures; p++) {
    lines.push(`    Procedure Method${p} Integer iArg${p}`);
    for (let l = 0; l < localsEach; l++) {
      lines.push(`        String sLocal${l}`);
    }
    for (let l = 0; l < localsEach; l++) {
      // Use every local, so the run does the full lookup work rather than short-circuiting.
      lines.push(`        Move "x" to sLocal${l}`);
    }
    lines.push(`        Showln iArg${p}`);
    lines.push('    End_Procedure');
  }
  lines.push('End_Class');
  return lines.join('\n');
}

describe('analysis performance', () => {
  it('stays roughly linear on a file with many procedures', () => {
    const source = generate(2000, 8);
    const unit = parseSource(source, { uri: 'generated.pkg' });

    // Best of three; a single sample measures machine load as much as the analyser.
    let best = Infinity;
    let findings = analyze(unit);
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      findings = analyze(unit);
      best = Math.min(best, performance.now() - started);
    }

    // Every local is used and every parameter is read, so nothing should be reported.
    expect(findings).toEqual([]);
    // Comfortably met at ~50 ms; a reintroduced quadratic would take minutes.
    expect(best).toBeLessThan(4000);
  });

  it('scales sub-quadratically as the file grows', () => {
    const small = parseSource(generate(500, 8), { uri: 'small.pkg' });
    const large = parseSource(generate(2000, 8), { uri: 'large.pkg' });

    /**
     * Best of several runs.
     *
     * A single timing is not safe to divide by here: the suite runs test files in parallel
     * workers, so one run can absorb a GC pause or lose the CPU and come back three times its
     * true cost. That noise lands on whichever side of the ratio it hits and has flipped this
     * assertion on linear code. The minimum is the run that was not interrupted, and a genuinely
     * quadratic implementation cannot produce a fast one.
     */
    const time = (unit: ReturnType<typeof parseSource>): number => {
      let best = Infinity;
      for (let run = 0; run < 5; run++) {
        const started = performance.now();
        analyze(unit);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };

    // Warm up, so JIT cost does not land in the comparison.
    time(small);
    time(large);

    const smallMs = Math.max(time(small), 1);
    const largeMs = Math.max(time(large), 1);

    // 4x the procedures. Linear would be ~4x; quadratic would be ~16x and grow from there.
    expect(largeMs / smallMs).toBeLessThan(9);
  });
});
