import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planCoverage } from '../src/plan';
import { coverageProgramName, findStartUi, writeOverlay } from '../src/session';

/**
 * Planning and laying out a *profiling* run.
 *
 * Profiling shares the whole coverage pipeline and differs in three places, each of which can go
 * wrong quietly: which runtime packages are included, what a probe calls, and where the results
 * are written from. That last one is a different flush entirely -- an ordinary program has no
 * DFUnit `ManualRunTests` to override, and it ends *inside* `Start_UI`, so there is no line after
 * it to write from either. Both of those were established by compiling and running, not assumed.
 */

const NL = '\n';

/** A minimal Windows program, shaped like a real `.src`. */
const PROGRAM = [
  'Use AllWinClasses.pkg', // 0
  '', // 1
  'Object oApp is a cApplication', // 2
  '    Set psCompany to "x"', // 3
  'End_Object', // 4
  '', // 5
  'Procedure DoWork', // 6
  '    Showln "working"', // 7
  'End_Procedure', // 8
  '', // 9
  'Start_UI' // 10
].join(NL);

function planProfile(text = PROGRAM) {
  const startUi = findStartUi(text)!;
  return planCoverage({
    entry: {
      file: 'C:\\ws\\AppSrc\\Order.src',
      text,
      overlayPaths: ['Order_DfProf.src'],
      applicationLine: startUi,
      flushBeforeLine: startUi
    },
    sources: [],
    hitsPath: 'C:\\temp\\profile.txt',
    entryPath: 'Order_DfProf.src',
    mode: 'profile',
    flushStyle: 'exitBroadcast'
  });
}

function entryCode(): string {
  return planProfile().files.find((file) => file.path === 'Order_DfProf.src')!.code;
}

describe('finding where an ordinary program ends', () => {
  it('finds Start_UI', () => {
    expect(findStartUi(PROGRAM)).toBe(10);
  });

  it('matches whatever case it was written in', () => {
    expect(findStartUi('Use x.pkg\nSTART_UI\n')).toBe(1);
  });

  /** An earlier mention -- in a comment, or a conditional -- is not the call that starts it. */
  it('takes the last one', () => {
    expect(findStartUi('// Start_UI ends it\nStart_UI\n')).toBe(1);
  });

  it('reports none rather than guessing', () => {
    expect(findStartUi('Use x.pkg\nSend Something\n')).toBeUndefined();
  });
});

describe('planning in profile mode', () => {
  it('includes the profile runtime, not the coverage one', () => {
    const code = entryCode();
    expect(code).toContain('Use DfProfile.pkg');
    expect(code).not.toContain('Use DfCoverage.pkg');
  });

  it('probes methods with the profile emitters', () => {
    const code = entryCode();
    expect(code).toContain('Send DfProfEnter 0');
    expect(code).toContain('Send DfProfExit 0');
    expect(code).not.toContain('DfCovHit');
  });

  it('produces one probe per method rather than one per block', () => {
    expect(planProfile().probes).toHaveLength(1);
    expect(planProfile().probes[0]!.kind).toBe('entry');
  });

  /**
   * Measured, not assumed: a program compiled with a file write on the line below `Start_UI`
   * produced no file, because the process ends inside `Start_UI`. So the flush is an object that
   * answers the desktop's shutdown broadcast, and it has to sit *above* `Start_UI` to be declared.
   */
  it('writes the results from the shutdown broadcast, above Start_UI', () => {
    const lines = entryCode().split(NL);
    const flush = lines.findIndex((line) => line.includes('Send DfProfWrite'));
    const startUi = lines.findIndex((line) => /^\s*Start_UI\b/.test(line));
    expect(flush).toBeGreaterThan(0);
    expect(flush).toBeLessThan(startUi);
    expect(entryCode()).toContain('Procedure Broadcast_Notify_Exit_Application');
    expect(entryCode()).not.toContain('Procedure ManualRunTests');
  });

  /**
   * `cObject` does not define `Broadcast_Notify_Exit_Application`, so forwarding it raises error
   * 98, "Invalid message" -- in a dialog, at shutdown, after the run is already over. Found by
   * running it.
   */
  it('does not forward the broadcast', () => {
    expect(entryCode()).not.toContain('Forward Send Broadcast_Notify_Exit_Application');
  });

  it('names the output file the run will write', () => {
    expect(entryCode()).toContain('Send DfProfWrite "C:\\temp\\profile.txt"');
  });

  /** The object calls into the writer package, so the `Use` has to come first, not merely exist. */
  it('includes the writer package above the object that uses it', () => {
    const lines = entryCode().split(NL);
    const use = lines.findIndex((line) => line.includes('Use DfProfileWrite.pkg'));
    const object = lines.findIndex((line) => line.includes('Object oDfInstrumentedFlush'));
    expect(use).toBeGreaterThan(0);
    expect(use).toBeLessThan(object);
  });

  /** Coverage must be untouched by any of this: it is the mode every existing caller uses. */
  it('still plans coverage when no mode is given', () => {
    const plan = planCoverage({
      entry: {
        file: 'C:\\ws\\AppSrc\\Order.src',
        text: PROGRAM,
        overlayPaths: ['Order_DfCov.src'],
        applicationLine: 2,
        flushBeforeLine: 4
      },
      sources: [],
      hitsPath: 'C:\\temp\\hits.txt',
      entryPath: 'Order_DfCov.src'
    });
    const code = plan.files[0]!.code;
    expect(code).toContain('Use DfCoverage.pkg');
    expect(code).toContain('DfCovHit');
    expect(code).toContain('Procedure ManualRunTests');
  });
});

describe('the generated program name', () => {
  it('is distinct per mode, so neither overwrites the other', () => {
    expect(coverageProgramName('C:\\ws\\Order.src')).toBe('Order_DfCov');
    expect(coverageProgramName('C:\\ws\\Order.src', 'profile')).toBe('Order_DfProf');
  });
});

describe('laying out a profiling overlay', () => {
  let scratch: string;
  let source: string;
  const runtime = resolve(__dirname, '..', 'runtime');

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'df-profile-'));
    source = join(scratch, 'src');
    mkdirSync(source, { recursive: true });
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  function overlay(text = PROGRAM) {
    const entry = join(source, 'Order.src');
    writeFileSync(entry, text, 'latin1');
    return writeOverlay({
      entry,
      targets: [{ file: entry, overlayPaths: ['Order.src'] }],
      scratch: join(scratch, 'work'),
      runtimeDirectory: runtime,
      mode: 'profile',
      flushStyle: 'exitBroadcast'
    });
  }

  it('copies the profile runtime packages, not the coverage ones', () => {
    const result = overlay();
    expect(existsSync(join(result.runtimeDir, 'DfProfile.pkg'))).toBe(true);
    expect(existsSync(join(result.runtimeDir, 'DfProfileWrite.pkg'))).toBe(true);
    expect(existsSync(join(result.runtimeDir, 'DfCoverage.pkg'))).toBe(false);
  });

  it('finds Start_UI itself, so the caller needs no line numbers', () => {
    const code = readFileSync(overlay().entrySource, 'latin1');
    expect(code).toContain('Send DfProfWrite');
    expect(code.indexOf('Send DfProfWrite')).toBeLessThan(code.lastIndexOf('Start_UI'));
  });

  it('writes the timings somewhere other than the coverage counts', () => {
    expect(overlay().hitsPath.endsWith('profile.txt')).toBe(true);
  });

  /**
   * A program with no `Start_UI` -- a web application, or a console utility -- has nowhere to
   * write from. Saying which is the difference between a fixable message and "instrumentation
   * failed".
   */
  it('refuses a program it cannot write results from, and says why', () => {
    expect(() => overlay('Use x.pkg\nProcedure Foo\n    Showln "x"\nEnd_Procedure\n')).toThrow(
      /Start_UI/
    );
  });
});
