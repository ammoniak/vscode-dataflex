import { describe, expect, it } from 'vitest';
import { parseJUnit } from '../src/junit';

/** The document shape `cDFUnitXMLReporter` writes, with nested fixtures. */
const REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
<testsuite name="Probe" errors="0" failures="1">
<testsuite name="OuterFixture" errors="0" failures="1">
<testsuite name="InnerFixture" errors="0" failures="1">
<testcase name="InnerPasses" assertions="1" 0.000>
</testcase>
<testcase name="InnerFails" assertions="1" 0.001>
<failure message="deliberate failure"></failure>
</testcase>
</testsuite>
<testcase name="OuterPasses" assertions="1" 0.000>
</testcase>
</testsuite>
<testcase name="TopLevelPasses" assertions="1" 0.000>
</testcase>
</testsuite>
</testsuites>`;

describe('parseJUnit', () => {
  it('reads every test case', () => {
    const { cases } = parseJUnit(REPORT);
    expect(cases.map((c) => c.name)).toEqual([
      'InnerPasses',
      'InnerFails',
      'OuterPasses',
      'TopLevelPasses'
    ]);
  });

  it('records the fixture path so results map back to the discovered tree', () => {
    const { cases } = parseJUnit(REPORT);
    const byName = new Map(cases.map((c) => [c.name, c]));

    expect(byName.get('InnerPasses')!.suitePath).toEqual(['Probe', 'OuterFixture', 'InnerFixture']);
    expect(byName.get('OuterPasses')!.suitePath).toEqual(['Probe', 'OuterFixture']);
    expect(byName.get('TopLevelPasses')!.suitePath).toEqual(['Probe']);
  });

  it('marks failures and keeps their message', () => {
    const byName = new Map(parseJUnit(REPORT).cases.map((c) => [c.name, c]));

    expect(byName.get('InnerFails')!.status).toBe('failed');
    expect(byName.get('InnerFails')!.message).toBe('deliberate failure');
    expect(byName.get('InnerPasses')!.status).toBe('passed');
    expect(byName.get('InnerPasses')!.message).toBeUndefined();
  });

  it('distinguishes an error from a failure', () => {
    const { cases } = parseJUnit(
      `<testsuites><testsuite name="S">
       <testcase name="Boom" assertions="0"><error message="unexpected error 42"></error></testcase>
       </testsuite></testsuites>`
    );
    expect(cases[0]!.status).toBe('errored');
    expect(cases[0]!.message).toBe('unexpected error 42');
  });

  it('reads assertion counts', () => {
    const byName = new Map(parseJUnit(REPORT).cases.map((c) => [c.name, c]));
    expect(byName.get('InnerPasses')!.assertions).toBe(1);
  });

  it('survives an unescaped message, which the reporter can emit', () => {
    // The reporter formats `message="%1"` without escaping, so an assertion message containing
    // a quote or an angle bracket produces XML a strict parser would reject. A partial result
    // beats no result.
    const { cases } = parseJUnit(
      `<testsuites><testsuite name="S">
       <testcase name="Quoted" assertions="1"><failure message="expected "a" but got <b>"></failure></testcase>
       <testcase name="After" assertions="1"></testcase>
       </testsuite></testsuites>`
    );
    const names = cases.map((c) => c.name);
    expect(names).toContain('Quoted');
    // The case following the malformed one must still be reported.
    expect(names).toContain('After');
    expect(cases.find((c) => c.name === 'Quoted')!.status).toBe('failed');
  });

  it('decodes XML entities in a message', () => {
    const { cases } = parseJUnit(
      `<testsuites><testsuite name="S">
       <testcase name="T"><failure message="a &lt; b &amp;&amp; c &gt; d"></failure></testcase>
       </testsuite></testsuites>`
    );
    expect(cases[0]!.message).toBe('a < b && c > d');
  });

  it('handles a self-closing test case', () => {
    const { cases } = parseJUnit(
      `<testsuites><testsuite name="S"><testcase name="Quick" assertions="1"/></testsuite></testsuites>`
    );
    expect(cases).toHaveLength(1);
    expect(cases[0]!.status).toBe('passed');
    expect(cases[0]!.suitePath).toEqual(['S']);
  });

  it('returns what it can from a truncated report', () => {
    // A crashed run leaves the document unterminated; the tests that did report should show.
    const truncated = REPORT.slice(0, REPORT.indexOf('OuterPasses'));
    const { cases } = parseJUnit(truncated);
    expect(cases.map((c) => c.name)).toContain('InnerPasses');
    expect(cases.map((c) => c.name)).toContain('InnerFails');
  });

  it('returns nothing for empty input rather than throwing', () => {
    expect(parseJUnit('').cases).toEqual([]);
    expect(() => parseJUnit('not xml at all')).not.toThrow();
  });
});
