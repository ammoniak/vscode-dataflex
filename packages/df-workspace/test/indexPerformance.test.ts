import { describe, expect, it } from 'vitest';
import { SymbolIndex } from '../src/symbolIndex';

/**
 * Guards the shape that made indexing unusable.
 *
 * Two separate scans walked the whole file's token array once per statement:
 * `ExpressionParser.textBetween`, reassembling the source text of every expression node, and
 * `valueAfterTo`, locating a statement's first token. Both are O(tokens) per statement, so both
 * are quadratic over a file.
 *
 * On a real generated ActiveX wrapper that cost **91 seconds for one file**, and 100 seconds for
 * the whole workspace index. It never showed up in the parser benchmarks because parsing that same
 * file takes 141 ms -- the cost was entirely in what the index asked of it afterwards.
 *
 * The budget below is loose on purpose. Anything quadratic here takes minutes, not milliseconds.
 */

/**
 * A file with many assigning statements, which is what triggers both scans.
 *
 * `Move ... to ...` is the shape `valueAfterTo` inspects, and each one builds expression nodes.
 */
function generate(procedures: number, statementsEach: number): string {
  const lines: string[] = ['Class cGenerated is a cObject'];
  for (let p = 0; p < procedures; p++) {
    lines.push(`    Procedure Method${p}`);
    lines.push('        Handle hoLocal');
    for (let s = 0; s < statementsEach; s++) {
      lines.push(`        Move (Trim("value ${s}") + "x") to hoLocal`);
    }
    lines.push('    End_Procedure');
  }
  lines.push('End_Class');
  return lines.join('\n');
}

const FILE = 'C:\\ws\\Generated.pkg';

describe('index performance', () => {
  it('indexes a large file in reasonable time', () => {
    const source = generate(400, 10);

    // Best of three, so this measures the index rather than whatever else the machine is doing.
    let best = Infinity;
    let index = new SymbolIndex();
    for (let run = 0; run < 3; run++) {
      index = new SymbolIndex();
      const started = performance.now();
      index.indexFile(FILE, source);
      best = Math.min(best, performance.now() - started);
    }

    expect(index.classCount).toBe(1);
    // Comfortably met at well under a second; the quadratic version took minutes.
    expect(best).toBeLessThan(8000);
  });

  it('scales sub-quadratically as the file grows', () => {
    const small = generate(200, 10);
    const large = generate(800, 10);

    /**
     * Best of several runs. A single timing is not safe to divide by: the suite runs files in
     * parallel workers, so one run can absorb a GC pause and come back several times its true
     * cost, and that noise lands on whichever side of the ratio it hits.
     */
    const time = (source: string): number => {
      let best = Infinity;
      for (let run = 0; run < 3; run++) {
        const started = performance.now();
        new SymbolIndex().indexFile(FILE, source);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };

    time(small);
    time(large);

    const smallMs = Math.max(time(small), 1);
    const largeMs = Math.max(time(large), 1);

    // 4x the statements. Linear would be ~4x; the quadratic version was ~16x and climbing.
    expect(largeMs / smallMs).toBeLessThan(9);
  });
});
