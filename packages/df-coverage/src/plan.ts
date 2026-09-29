import { parseSource } from '@vscode-dataflex/parser';
import { Injection, Probe, instrument } from './instrument';

/**
 * Builds the overlay that a coverage run compiles instead of the real source.
 *
 * Everything here is pure: it takes file text in and returns file text out, so the whole layout
 * of a run can be asserted in unit tests without DataFlex installed.
 *
 * The overlay exists because `df-cli build-file` accepts repeatable `-I` include paths that are
 * searched *before* the workspace's own, so instrumented copies shadow the originals with nothing
 * written into the user's workspace and no shadow copy of it either.
 */

/** One source file to instrument. */
export interface CoverageInput {
  /** Absolute path of the original file. Recorded on every probe, so the report needs no mapping. */
  file: string;
  /** Its decoded text. */
  text: string;
  /**
   * Where the instrumented copy goes inside the overlay: relative and `/`-separated.
   *
   * More than one path when the file is reachable through more than one search-path directory.
   * The compiler resolves `Use Platform\Common\cUtils.pkg` by joining that spelling onto each
   * directory in turn, so the overlay has to answer every spelling that could reach this file --
   * otherwise a file is silently compiled uninstrumented and reported as wholly uncovered.
   */
  overlayPaths: string[];
}

/** The `.src` that becomes the coverage program. */
export interface CoverageEntry extends CoverageInput {
  /**
   * Zero-based line of the test application object's header.
   *
   * `Use DfCoverageWrite.pkg` goes just above it: the writer needs the sequential-file runtime,
   * which does not exist at the top of the file, and by the application object every framework
   * package the program uses has been compiled.
   */
  applicationLine: number;
  /**
   * Zero-based line of the test application object's `End_Object`.
   *
   * The flush override is injected just above it. `TestDiscovery` already reports this range, so
   * nothing has to re-find the object.
   */
  flushBeforeLine: number;
}

export interface OverlayFile {
  /** Relative, `/`-separated path inside the overlay. */
  path: string;
  code: string;
}

export interface CoveragePlan {
  files: OverlayFile[];
  probes: Probe[];
  skipped: { file: string; line: number; reason: string }[];
  /** Files that produced no probes at all -- no executable code, or none of it probeable. */
  unprobed: string[];
}

/**
 * What the probes measure.
 *
 * The two modes share this whole pipeline and differ only in where probes go and what they call:
 * `coverage` puts one per basic block and counts it, `profile` puts one per method and times it.
 * Everything else -- the overlay, the include shadowing, the build -- is identical, which is why
 * they are a mode rather than two planners.
 */
export type RunMode = 'coverage' | 'profile';

/**
 * How the run is made to write its results out before it disappears.
 *
 * Neither DataFlex program shape has anything as convenient as an exit hook, and they fail
 * differently:
 *
 *  - `manualRunTests` -- a DFUnit suite leaves through Win32 `ExitProcess`, so no DataFlex
 *    finalization runs at all and the results have to be written from the last method that still
 *    returns normally.
 *  - `exitBroadcast` -- an ordinary Windows program ends *inside* `Start_UI`. Code written after
 *    it never runs; this was measured, not assumed, by compiling a program that wrote a file from
 *    the line below `Start_UI` and finding no file. What does run is the broadcast the desktop
 *    sends to every object immediately before it aborts, so the flush lives in an object that
 *    answers it.
 */
export type FlushStyle = 'manualRunTests' | 'exitBroadcast';

export interface PlanOptions {
  entry: CoverageEntry;
  /** Everything else reachable from the entry that is worth measuring. */
  sources: readonly CoverageInput[];
  /** Absolute path the run writes its counts to. */
  hitsPath: string;
  /** Overlay-relative name for the generated program, e.g. `UnitTest_DfCov.src`. */
  entryPath: string;
  /** Defaults to `coverage`, which is what every existing caller wants. */
  mode?: RunMode;
  /** Defaults to `manualRunTests`, the DFUnit case coverage was built for. */
  flushStyle?: FlushStyle;
  /** Package declaring the counters and `DfCovHit`; included first, so it must need nothing. */
  runtimePackage?: string;
  /** Package declaring `DfCovWrite`; included late, where the file runtime exists. */
  writerPackage?: string;
}

/** Package names and probe text for each mode, so nothing has to pair them up by hand. */
const MODES = {
  coverage: {
    runtimePackage: 'DfCoverage.pkg',
    writerPackage: 'DfCoverageWrite.pkg',
    writer: 'DfCovWrite'
  },
  profile: {
    runtimePackage: 'DfProfile.pkg',
    writerPackage: 'DfProfileWrite.pkg',
    writer: 'DfProfWrite'
  }
} as const;

/** Emitters for `instrument`, chosen by mode. Coverage keeps `instrument`'s own default. */
const PROFILE_EMITTERS = {
  enter: (id: number): string => `Send DfProfEnter ${id}`,
  exit: (id: number): string => `Send DfProfExit ${id}`
};

/**
 * The override that writes the counters out.
 *
 * DFUnit leaves through `DFUnit_ConsoleExit`, which calls Win32 `ExitProcess` directly, so no
 * DataFlex finalization runs and there is no exit hook to use. `ManualRunTests` is the last thing
 * that returns normally before that call, which makes an override of it the only place the counts
 * can still be written -- and it goes on the user's own application object rather than patching a
 * file inside the DFUnit package.
 */
export function flushOverride(hitsPath: string, indent = '    ', writer = 'DfCovWrite'): string {
  return [
    `${indent}// Added for this instrumented run only. DFUnit exits through Win32 ExitProcess,`,
    `${indent}// which runs no DataFlex finalization, so the results have to be written while`,
    `${indent}// ManualRunTests is still on the stack.`,
    `${indent}Procedure ManualRunTests`,
    `${indent}    Forward Send ManualRunTests`,
    `${indent}    Send ${writer} "${hitsPath}"`,
    `${indent}End_Procedure`
  ].join('\n');
}

/**
 * The flush for an ordinary Windows program: an object that answers the shutdown broadcast.
 *
 * `Exit_Application` on the desktop asks every object to confirm, broadcasts
 * `Broadcast_Notify_Exit_Application` to all of them, and then calls `Abort` -- so that broadcast
 * is the last DataFlex code that runs, and it runs however the program was closed. It goes just
 * above `Start_UI`, together with the writer package, because by that point every framework
 * package the program uses has been compiled.
 *
 * Two things here are the result of a run that failed rather than a guess:
 *
 *  - Nothing after `Start_UI` executes, so this cannot be a plain statement.
 *  - There is no `Forward Send`. `cObject` does not define this message, and forwarding one the
 *    superclass has never heard of raises error 98, "Invalid message", in a dialog at shutdown.
 */
export function flushObject(
  hitsPath: string,
  writer = 'DfProfWrite',
  writerPackage = 'DfProfileWrite.pkg'
): string {
  return [
    '// Added for this instrumented run only. A DataFlex program ends inside Start_UI, so the',
    '// results are written from the broadcast the desktop sends immediately before it aborts.',
    `Use ${writerPackage}`,
    'Object oDfInstrumentedFlush is a cObject',
    '    // No Forward Send: cObject does not define this message, and forwarding it is error 98.',
    '    Procedure Broadcast_Notify_Exit_Application',
    `        Send ${writer} "${hitsPath}"`,
    '    End_Procedure',
    'End_Object'
  ].join('\n');
}

/**
 * Plans a coverage build.
 *
 * Probe ids run consecutively across the whole set so the runtime can key its counter array on
 * them directly; inputs are sorted by path first so the same workspace always plans identically.
 */
export function planCoverage(options: PlanOptions): CoveragePlan {
  const mode = MODES[options.mode ?? 'coverage'];
  const runtime = options.runtimePackage ?? mode.runtimePackage;
  const writer = options.writerPackage ?? mode.writerPackage;
  const files: OverlayFile[] = [];
  const probes: Probe[] = [];
  const skipped: { file: string; line: number; reason: string }[] = [];
  const unprobed: string[] = [];
  let nextId = 0;

  const add = (input: CoverageInput, paths: string[], inject: Injection[]): void => {
    const unit = parseSource(input.text, { uri: input.file });
    const result = instrument(input.text, unit, {
      file: input.file,
      firstId: nextId,
      inject,
      ...(options.mode === 'profile' ? { method: PROFILE_EMITTERS } : {})
    });
    nextId += result.probes.length;
    probes.push(...result.probes);
    for (const entry of result.skipped) {
      skipped.push({ file: input.file, line: entry.line, reason: entry.reason });
    }
    if (result.probes.length === 0) {
      unprobed.push(input.file);
    }
    for (const path of paths) {
      files.push({ path, code: result.code });
    }
  };

  // The entry goes first so its probes take the lowest ids, which makes a hand-read hits file
  // easier to follow when something needs debugging.
  // Line 0, before anything else in the file: code near the top of a `.src` gets instrumented too
  // -- an error trap object, say -- so the probe procedure has to be declared before any of it.
  const entryInjections: Injection[] = [{ line: 0, text: `Use ${runtime}` }];
  if (options.flushStyle === 'exitBroadcast') {
    // One injection, not two: the writer package and the object that uses it have to stay in that
    // order, and two injections addressing the same line would end up in the other one.
    entryInjections.push({
      line: options.entry.flushBeforeLine,
      text: flushObject(options.hitsPath, mode.writer, writer)
    });
  } else {
    // The writer needs the sequential-file runtime, which does not exist that early.
    entryInjections.push({ line: options.entry.applicationLine, text: `Use ${writer}` });
    entryInjections.push({
      line: options.entry.flushBeforeLine,
      text: flushOverride(options.hitsPath, '    ', mode.writer)
    });
  }

  add(options.entry, [options.entryPath], entryInjections);

  const rest = [...options.sources]
    .filter((source) => source.file.toLowerCase() !== options.entry.file.toLowerCase())
    .sort((a, b) => a.file.toLowerCase().localeCompare(b.file.toLowerCase()));

  for (const source of rest) {
    add(source, source.overlayPaths, []);
  }

  return { files, probes, skipped, unprobed };
}
