import { describe, expect, it } from 'vitest';
import { buildReport, parseHits, toLcov } from '../src/report';
import type { Probe } from '../src/instrument';

const TAB = String.fromCharCode(9);

function probe(id: number, line: number, file = 'C:/ws/a.pkg'): Probe {
  return { id, file, line, kind: 'block' };
}

describe('parseHits', () => {
  it('reads the id/count pairs the runtime writes', () => {
    const hits = parseHits([`0${TAB}3`, `5${TAB}1`].join('\n'));
    expect(hits.get(0)).toBe(3);
    expect(hits.get(5)).toBe(1);
    expect(hits.size).toBe(2);
  });

  it('survives a truncated final line', () => {
    // A crashed run still tells you what ran before it died.
    const hits = parseHits([`0${TAB}3`, `5${TAB}1`, '7'].join('\n'));
    expect(hits.get(0)).toBe(3);
    expect(hits.has(7)).toBe(false);
  });

  it('sums repeated ids rather than overwriting', () => {
    expect(parseHits([`2${TAB}1`, `2${TAB}4`].join('\n')).get(2)).toBe(5);
  });

  it('returns nothing for empty or malformed input', () => {
    expect(parseHits('').size).toBe(0);
    expect(parseHits('not a report').size).toBe(0);
  });
});

describe('buildReport', () => {
  it('counts covered and missed probes', () => {
    const report = buildReport(
      [probe(0, 10), probe(1, 20), probe(2, 30)],
      parseHits([`0${TAB}2`, `2${TAB}1`].join('\n'))
    );
    expect(report.covered).toBe(2);
    expect(report.total).toBe(3);
    expect(report.ratio).toBeCloseTo(2 / 3);
    expect(report.files[0]!.missed).toEqual([20]);
  });

  it('distinguishes an unhit line from one that is not code', () => {
    // A missed probe records its line with a zero count, so a reader can tell the difference.
    const report = buildReport([probe(0, 10), probe(1, 20)], parseHits(`0${TAB}1`));
    expect(report.files[0]!.hits.get(20)).toBe(0);
    expect(report.files[0]!.hits.has(15)).toBe(false);
  });

  it('groups by file', () => {
    const report = buildReport(
      [probe(0, 1, 'C:/ws/a.pkg'), probe(1, 1, 'C:/ws/b.pkg')],
      parseHits(`0${TAB}1`)
    );
    expect(report.files.map((f) => f.file).sort()).toEqual(['C:/ws/a.pkg', 'C:/ws/b.pkg']);
  });

  it('reports full coverage when there was nothing to measure', () => {
    expect(buildReport([], new Map()).ratio).toBe(1);
  });

  it('adds up several probes landing on one line', () => {
    const report = buildReport(
      [probe(0, 7), probe(1, 7)],
      parseHits([`0${TAB}2`, `1${TAB}3`].join('\n'))
    );
    expect(report.files[0]!.hits.get(7)).toBe(5);
  });
});

describe('toLcov', () => {
  it('emits one-based line numbers', () => {
    // Probes are zero-based internally; LCOV is one-based.
    const lcov = toLcov(buildReport([probe(0, 9)], parseHits(`0${TAB}4`)));
    expect(lcov).toContain('DA:10,4');
  });

  it('emits a record per file with totals', () => {
    const lcov = toLcov(
      buildReport([probe(0, 0), probe(1, 5)], parseHits(`0${TAB}1`))
    );
    expect(lcov).toContain('SF:C:/ws/a.pkg');
    expect(lcov).toContain('LF:2');
    expect(lcov).toContain('LH:1');
    expect(lcov.trimEnd().endsWith('end_of_record')).toBe(true);
  });
});
