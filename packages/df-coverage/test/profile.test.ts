import { describe, expect, it } from 'vitest';
import { parseSource } from '@vscode-dataflex/parser';
import { instrument } from '../src/instrument';
import { buildProfile, formatProfile, parseProfile } from '../src/profileReport';

/**
 * Method-level profiling.
 *
 * Timing every basic block is not an option: DataFlex's clock resolves to a millisecond, so a
 * block running in microseconds measures zero, and asking the clock that often would cost more
 * than the code being measured. So one probe per method, entered once and left once -- which makes
 * *leaving* the hard part, because a DataFlex method can return from several places.
 */

const FILE = 'C:\\ws\\x.pkg';

const EMITTERS = {
  enter: (id: number) => `Send DfProfEnter ${id}`,
  exit: (id: number) => `Send DfProfExit ${id}`
};

function profileInstrument(source: string) {
  return instrument(source, parseSource(source, { uri: FILE }), { file: FILE, method: EMITTERS });
}

describe('instrumenting a method', () => {
  const SIMPLE = [
    'Procedure DoIt',
    '    String sName',
    '    Move "x" to sName',
    '    Showln sName',
    'End_Procedure',
    ''
  ].join('\n');

  it('produces one probe for the whole method, not one per block', () => {
    const result = profileInstrument(SIMPLE);
    expect(result.probes).toHaveLength(1);
    expect(result.probes[0]!.method).toBe('DoIt');
    expect(result.probes[0]!.kind).toBe('entry');
  });

  it('enters at the first executable statement, after the declarations', () => {
    const lines = profileInstrument(SIMPLE).code.split('\n');
    const enter = lines.findIndex((line) => line.includes('DfProfEnter'));
    // `String sName` is a declaration; DataFlex requires those before any executable statement.
    expect(lines[enter - 1]).toContain('String sName');
    expect(lines[enter + 1]).toContain('Move "x" to sName');
  });

  it('leaves before the closing keyword', () => {
    const lines = profileInstrument(SIMPLE).code.split('\n');
    const exit = lines.findIndex((line) => line.includes('DfProfExit'));
    expect(lines[exit + 1]).toContain('End_Procedure');
  });

  it('keeps the indentation of the code it sits among', () => {
    const lines = profileInstrument(SIMPLE).code.split('\n');
    const enter = lines.find((line) => line.includes('DfProfEnter'))!;
    expect(enter.startsWith('    Send')).toBe(true);
  });
});

describe('methods that leave from several places', () => {
  /** An unmatched enter does not merely lose that method: it charges the caller's time to it. */
  it('leaves before every early return as well as the end', () => {
    const source = [
      'Procedure DoIt Boolean bSkip',
      '    Move 1 to giCount',
      '    If (bSkip) Begin',
      '        Procedure_Return',
      '    End',
      '    Showln "work"',
      'End_Procedure',
      ''
    ].join('\n');
    const code = profileInstrument(source).code;
    expect(code.split('DfProfExit').length - 1).toBe(2);
  });

  it('handles a function returning a value', () => {
    const source = [
      'Function Total Integer iA Returns Integer',
      '    Move 1 to giCount',
      '    Function_Return iA',
      'End_Function',
      ''
    ].join('\n');
    const code = profileInstrument(source).code;
    const lines = code.split('\n');
    const at = lines.findIndex((line) => line.includes('Function_Return'));
    // The exit must come before the return, or it never runs.
    expect(lines[at - 1]).toContain('DfProfExit');
  });

  /**
   * `If (bDone) Procedure_Return` has nowhere to put an exit line: a probe above the `If` fires
   * whether or not the return is taken. Such a method is skipped whole rather than measured wrong.
   */
  it('skips a method whose return cannot be probed, and says why', () => {
    const source = [
      'Procedure DoIt Boolean bSkip',
      '    Move 1 to giCount',
      '    If (bSkip) Procedure_Return',
      '    Showln "work"',
      'End_Procedure',
      ''
    ].join('\n');
    const result = profileInstrument(source);
    expect(result.probes).toHaveLength(0);
    expect(result.code).not.toContain('DfProfEnter');
    expect(result.skipped[0]!.reason).toContain('not profiled');
  });
});

describe('what is left alone', () => {
  it('does not probe a method with no executable statements', () => {
    const source = 'Procedure Empty\nEnd_Procedure\n';
    expect(profileInstrument(source).probes).toHaveLength(0);
  });

  it('gives every method in a file its own probe id', () => {
    const source = [
      'Procedure One',
      '    Showln "1"',
      'End_Procedure',
      'Procedure Two',
      '    Showln "2"',
      'End_Procedure',
      ''
    ].join('\n');
    const ids = profileInstrument(source).probes.map((probe) => probe.id);
    expect(new Set(ids).size).toBe(2);
  });

  /** Block-mode instrumentation must be untouched by any of this. */
  it('still probes blocks when no method emitters are given', () => {
    const source = [
      'Procedure DoIt Boolean bX',
      '    Showln "a"',
      '    If (bX) Begin',
      '        Showln "b"',
      '    End',
      'End_Procedure',
      ''
    ].join('\n');
    const blocks = instrument(source, parseSource(source, { uri: FILE }), { file: FILE });
    expect(blocks.probes.length).toBeGreaterThan(1);
    expect(blocks.code).toContain('DfCovHit');
  });
});

describe('reading a profile back', () => {
  /** Exactly what a real run wrote: Outer called Inner twice, and their times agree. */
  const REAL = ['0\t1\t1\t3542', '1\t2\t2\t3542', ''].join('\n');

  it('parses the file the runtime writes', () => {
    const samples = parseProfile(REAL);
    expect(samples.get(0)).toEqual({ calls: 1, exits: 1, milliseconds: 3542 });
    expect(samples.get(1)).toEqual({ calls: 2, exits: 2, milliseconds: 3542 });
  });

  it('ignores a truncated final line rather than failing', () => {
    expect(parseProfile('0\t1\t1\t10\n1\t2').size).toBe(1);
  });

  it('ignores a line that is not numeric', () => {
    expect(parseProfile('nonsense\ta\tb\tc\n0\t1\t1\t10').size).toBe(1);
  });

  const PROBES = [
    { id: 0, file: FILE, line: 0, kind: 'entry' as const, method: 'Outer' },
    { id: 1, file: FILE, line: 10, kind: 'entry' as const, method: 'Inner' },
    { id: 2, file: FILE, line: 20, kind: 'entry' as const, method: 'NeverRan' }
  ];

  it('reports slowest first', () => {
    const report = buildProfile(PROBES, parseProfile('0\t1\t1\t100\n1\t5\t5\t900'));
    expect(report.methods.map((entry) => entry.method)).toEqual(['Inner', 'Outer']);
  });

  it('computes the mean per call', () => {
    const report = buildProfile(PROBES, parseProfile('1\t4\t4\t900'));
    expect(report.methods[0]!.mean).toBe(225);
  });

  /** A profile is a list of what the run did; padding it with zeros would bury that. */
  it('leaves out methods that never ran', () => {
    const report = buildProfile(PROBES, parseProfile(REAL));
    expect(report.methods.map((entry) => entry.method)).not.toContain('NeverRan');
  });

  it('flags a method that was entered and left a different number of times', () => {
    const report = buildProfile(PROBES, parseProfile('0\t3\t1\t100'));
    expect(report.methods[0]!.balanced).toBe(false);
    expect(report.unbalanced).toBe(1);
  });

  it('treats matching counts as balanced', () => {
    expect(buildProfile(PROBES, parseProfile(REAL)).unbalanced).toBe(0);
  });
});

describe('formatting', () => {
  const PROBES = [
    { id: 0, file: FILE, line: 0, kind: 'entry' as const, method: 'Outer' },
    { id: 1, file: FILE, line: 10, kind: 'entry' as const, method: 'Inner' }
  ];

  it('renders a table, slowest first', () => {
    const text = formatProfile(buildProfile(PROBES, parseProfile('0\t1\t1\t100\n1\t5\t5\t900')));
    expect(text.indexOf('Inner')).toBeLessThan(text.indexOf('Outer'));
    expect(text).toContain('mean ms');
  });

  /**
   * `Construct_Object` is defined by every DataFlex class, so a real profile lists several rows
   * with that same name. Without the file they cannot be told apart.
   */
  it('says which file each method came from', () => {
    const text = formatProfile(buildProfile(PROBES, parseProfile('0\t1\t1\t100\n1\t5\t5\t900')));
    expect(text).toContain('x.pkg:1');
    expect(text).toContain('x.pkg:11');
  });

  it('says so when nothing ran', () => {
    expect(formatProfile(buildProfile(PROBES, new Map()))).toBe('No methods were entered.');
  });

  it('warns about unbalanced methods rather than hiding them', () => {
    const text = formatProfile(buildProfile(PROBES, parseProfile('0\t3\t1\t100')));
    expect(text).toContain('unbalanced');
    expect(text).toContain('understated');
  });
});
