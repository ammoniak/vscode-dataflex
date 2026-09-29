import { describe, expect, it } from 'vitest';
import { flushOverride, planCoverage } from '../src/plan';

const NL = '\n';

/** A minimal test program with the same shape as a real DFUnit `.src`. */
const ENTRY = [
  'Use Windows.pkg',      // 0
  'Use DFUnit.pkg',       // 1
  '',                     // 2
  'Object oTrap is a cObject', // 3
  '    Procedure Note',   // 4
  '        Send Something', // 5
  '    End_Procedure',    // 6
  'End_Object',           // 7
  '',                     // 8
  'Object oTestApp is a cDFUnitTestApplication', // 9
  '    Set psTestFixtureName to "x"',            // 10
  '    Use Tests\\SanityTests.pkg',              // 11
  'End_Object'                                   // 12
].join(NL);

const LIBRARY = [
  'Class cThing is a cObject',
  '    Procedure Work',
  '        Send Away',
  '    End_Procedure',
  'End_Class'
].join(NL);

function plan(overrides: Partial<Parameters<typeof planCoverage>[0]> = {}) {
  return planCoverage({
    entry: {
      file: 'C:\\ws\\AppSrc\\UnitTest.src',
      text: ENTRY,
      overlayPaths: ['UnitTest_DfCov.src'],
      applicationLine: 9,
      flushBeforeLine: 12
    },
    sources: [
      {
        file: 'C:\\ws\\AppSrc\\Platform\\cThing.pkg',
        text: LIBRARY,
        overlayPaths: ['Platform/cThing.pkg']
      }
    ],
    hitsPath: 'C:\\temp\\hits.txt',
    entryPath: 'UnitTest_DfCov.src',
    ...overrides
  });
}

function entryCode(): string[] {
  return plan()
    .files.find((file) => file.path === 'UnitTest_DfCov.src')!
    .code.split(NL);
}

describe('planCoverage', () => {
  it('includes the counter package on the very first line', () => {
    // Code near the top of a `.src` gets instrumented too, so DfCovHit has to be declared before
    // any of it. The package pulls in the base runtime itself, which is what lets it sit here.
    expect(entryCode()[0]).toBe('Use DfCoverage.pkg');
  });

  it('includes the writer package immediately before the application object', () => {
    // The writer needs the sequential-file runtime, which does not exist at the top of the file.
    const lines = entryCode();
    const writer = lines.indexOf('Use DfCoverageWrite.pkg');
    const application = lines.findIndex((line) => line.startsWith('Object oTestApp'));
    expect(writer).toBeGreaterThan(0);
    expect(application).toBe(writer + 1);
  });

  it('injects the flush override just above the application End_Object', () => {
    const lines = entryCode();
    const forward = lines.findIndex((line) => line.includes('Forward Send ManualRunTests'));
    expect(forward).toBeGreaterThan(0);
    expect(lines[forward + 1]).toContain('Send DfCovWrite "C:\\temp\\hits.txt"');
    // Nothing may follow the override inside the object but its own End_Procedure and End_Object.
    expect(lines.slice(forward + 2).map((line) => line.trim())).toEqual([
      'End_Procedure',
      'End_Object'
    ]);
  });

  it('still probes the code it injected around', () => {
    const lines = entryCode();
    expect(lines.filter((line) => line.trim().startsWith('Send DfCovHit'))).toHaveLength(1);
    // The probe belongs to Procedure Note, below the injected Use lines.
    const probe = lines.findIndex((line) => line.trim().startsWith('Send DfCovHit'));
    expect(lines[probe - 1]!.trim()).toBe('Procedure Note');
  });

  it('gives every probe a distinct id across files', () => {
    const ids = plan().probes.map((probe) => probe.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids.map((_, index) => index));
  });

  it('records original line numbers, not shifted ones', () => {
    // `Send Something` is line 5 of the original; the injected Use lines push it down in the copy.
    const entryProbe = plan().probes.find((probe) => probe.file.endsWith('UnitTest.src'));
    expect(entryProbe!.line).toBe(5);
  });

  it('writes a source to each of its overlay paths', () => {
    // A file reachable through two search-path directories is reachable by two `Use` spellings,
    // and only shadowing both keeps the original from being compiled uninstrumented.
    const result = plan({
      sources: [
        {
          file: 'C:\\ws\\AppSrc\\Platform\\cThing.pkg',
          text: LIBRARY,
          overlayPaths: ['Platform/cThing.pkg', 'cThing.pkg']
        }
      ]
    });
    const written = result.files.filter((file) => file.path.endsWith('cThing.pkg'));
    expect(written.map((file) => file.path).sort()).toEqual(['Platform/cThing.pkg', 'cThing.pkg']);
    expect(written[0]!.code).toBe(written[1]!.code);
  });

  it('never emits the entry under its original name', () => {
    expect(plan().files.map((file) => file.path)).not.toContain('UnitTest.src');
  });

  it('reports files that produced no probes', () => {
    const result = plan({
      sources: [
        {
          file: 'C:\\ws\\AppSrc\\Empty.pkg',
          text: 'Use cWebView.pkg',
          overlayPaths: ['Empty.pkg']
        }
      ]
    });
    expect(result.unprobed).toEqual(['C:\\ws\\AppSrc\\Empty.pkg']);
  });

  it('skips a source that repeats the entry', () => {
    const result = plan({
      sources: [
        {
          file: 'C:\\ws\\AppSrc\\UnitTest.src',
          text: ENTRY,
          overlayPaths: ['UnitTest.src']
        }
      ]
    });
    expect(result.files.map((file) => file.path)).toEqual(['UnitTest_DfCov.src']);
  });
});

describe('flushOverride', () => {
  it('forwards before writing, so the counts include the whole run', () => {
    const lines = flushOverride('C:\\temp\\hits.txt').split(NL).map((line) => line.trim());
    expect(lines.filter((line) => !line.startsWith('//'))).toEqual([
      'Procedure ManualRunTests',
      'Forward Send ManualRunTests',
      'Send DfCovWrite "C:\\temp\\hits.txt"',
      'End_Procedure'
    ]);
  });
});
