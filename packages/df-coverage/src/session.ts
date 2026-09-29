import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CoverageEntry, CoverageInput, CoveragePlan, FlushStyle, RunMode, planCoverage } from './plan';
import { CoverageReport, buildReport, parseHits } from './report';
import { ProfileReport, buildProfile, parseProfile } from './profileReport';

/**
 * The filesystem half of a coverage run: lay out the overlay, then read the counts back.
 *
 * Building and running are deliberately left to the caller. The extension already knows how to
 * invoke `df-cli` and spawn a test executable with a timeout and cancellation, and so does the
 * headless script; wrapping those again here would mean two divergent copies of the awkward part.
 */

/** One file to instrument, as `coverageTargets()` reports it. */
export interface SessionTarget {
  file: string;
  overlayPaths: string[];
}

export interface OverlayOptions {
  /** Absolute path of the project's `.src`. */
  entry: string;
  /**
   * Zero-based line of the test application's header, where the writer package is included.
   *
   * Not needed with `flushStyle: 'exitBroadcast'`, which finds `Start_UI` in the entry itself.
   */
  applicationLine?: number;
  /** Zero-based line of the test application's `End_Object`, where the flush override goes. */
  flushBeforeLine?: number;
  targets: readonly SessionTarget[];
  /** Scratch directory. Created if missing; the caller owns removing it. */
  scratch: string;
  /** Directory holding the runtime packages for this mode. */
  runtimeDirectory: string;
  /** Defaults to `coverage`. */
  mode?: RunMode;
  /** Defaults to `manualRunTests`. */
  flushStyle?: FlushStyle;
}

export interface Overlay {
  plan: CoveragePlan;
  /** Pass as `-I`, ahead of the runtime directory. */
  overlayDir: string;
  /** Pass as `-I`. Holds the two coverage runtime packages. */
  runtimeDir: string;
  /** The generated `.src` to hand to `df-cli build-file`. */
  entrySource: string;
  /** Where the run will write its counts. */
  hitsPath: string;
  /** Base name of the program that will be built, without extension. */
  programName: string;
}

/**
 * Name for the generated program.
 *
 * Distinct from the real one on purpose: the coverage executable is built into the workspace's own
 * `Programs` directory, because that is where a DataFlex program finds its workspace, data and
 * `filelist.cfg`. Sharing the name would overwrite the artifact a normal build produced.
 */
export function coverageProgramName(entry: string, mode: RunMode = 'coverage'): string {
  const stem = (entry.split(/[\\/]/).pop() ?? entry).replace(/\.[^.]+$/, '');
  return `${stem}${mode === 'profile' ? '_DfProf' : '_DfCov'}`;
}

/**
 * Finds the `Start_UI` that ends an ordinary DataFlex program.
 *
 * The **last** one, because a `.src` may mention it in a comment or a conditional earlier on, and
 * the flush belongs above the call that actually starts the program. Comments and string literals
 * are not parsed away here: `Start_UI` at the start of a line, with nothing but whitespace before
 * it, is unambiguous enough, and a wrong match would fail loudly at compile time rather than
 * silently mismeasure.
 */
export function findStartUi(text: string): number | undefined {
  const lines = text.split(/\r?\n/);
  for (let line = lines.length - 1; line >= 0; line--) {
    if (/^\s*Start_UI\b/i.test(lines[line]!)) {
      return line;
    }
  }
  return undefined;
}

/**
 * Reads a DataFlex source file, remembering how it was encoded.
 *
 * DataFlex source is Latin-1 unless it carries a UTF-8 BOM. Writing an instrumented copy back as
 * UTF-8 regardless would turn every umlaut in a German codebase into two bytes and break the
 * build somewhere far from the actual cause.
 */
function readWithEncoding(path: string): { text: string; bom: boolean } | undefined {
  let buffer: Buffer;
  try {
    buffer = readFileSync(path);
  } catch {
    return undefined;
  }
  const bom = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  return {
    text: bom ? buffer.subarray(3).toString('utf8') : buffer.toString('latin1'),
    bom
  };
}

function writeWithEncoding(path: string, code: string, bom: boolean): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = bom
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(code, 'utf8')])
    : Buffer.from(code, 'latin1');
  writeFileSync(path, body);
}

/** Instruments every target into a fresh overlay and returns what the build needs. */
export function writeOverlay(options: OverlayOptions): Overlay {
  const mode = options.mode ?? 'coverage';
  const overlayDir = join(options.scratch, 'overlay');
  const runtimeDir = join(options.scratch, 'dfcov');
  const hitsPath = join(options.scratch, mode === 'profile' ? 'profile.txt' : 'hits.txt');
  const programName = coverageProgramName(options.entry, mode);
  const entryPath = `${programName}.src`;

  mkdirSync(overlayDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  const runtimePackages =
    mode === 'profile'
      ? ['DfProfile.pkg', 'DfProfileWrite.pkg']
      : ['DfCoverage.pkg', 'DfCoverageWrite.pkg'];
  for (const name of runtimePackages) {
    copyFileSync(join(options.runtimeDirectory, name), join(runtimeDir, name));
  }

  const entrySource = readWithEncoding(options.entry);
  if (entrySource === undefined) {
    throw new Error(`Cannot read the program: ${options.entry}`);
  }

  // Where the results get written from. For a DFUnit suite the caller already knows, because test
  // discovery reported the application object's range; for an ordinary program the flush object
  // goes just above `Start_UI`, which is in the entry text this function has just read.
  let applicationLine = options.applicationLine;
  let flushBeforeLine = options.flushBeforeLine;
  if (options.flushStyle === 'exitBroadcast') {
    const startUi = findStartUi(entrySource.text);
    if (startUi === undefined) {
      throw new Error(
        `${options.entry} has no Start_UI, so there is nowhere to write the results from. ` +
          'Only a program that starts its user interface that way can be instrumented like this.'
      );
    }
    // Both point at `Start_UI` itself: the flush object is injected immediately above it, which
    // is the last top-level position where every framework package has been compiled.
    applicationLine = startUi;
    flushBeforeLine = startUi;
  }
  if (applicationLine === undefined || flushBeforeLine === undefined) {
    throw new Error('writeOverlay needs applicationLine and flushBeforeLine, or flushStyle.');
  }

  const sources: CoverageInput[] = [];
  // Remembered per file so the instrumented copy is written back the way it came in.
  const bomByFile = new Map<string, boolean>([[options.entry.toLowerCase(), entrySource.bom]]);

  for (const target of options.targets) {
    if (target.file.toLowerCase() === options.entry.toLowerCase()) {
      continue;
    }
    const source = readWithEncoding(target.file);
    if (source === undefined) {
      continue;
    }
    bomByFile.set(target.file.toLowerCase(), source.bom);
    sources.push({ file: target.file, text: source.text, overlayPaths: target.overlayPaths });
  }

  const entry: CoverageEntry = {
    file: options.entry,
    text: entrySource.text,
    overlayPaths: [entryPath],
    applicationLine,
    flushBeforeLine
  };

  const plan = planCoverage({
    entry,
    sources,
    hitsPath,
    entryPath,
    mode,
    ...(options.flushStyle === undefined ? {} : { flushStyle: options.flushStyle })
  });

  // The plan reports overlay-relative paths; map each back to the file it came from so the right
  // encoding is used. The entry is the only renamed one.
  const fileByOverlayPath = new Map<string, string>([[entryPath, options.entry]]);
  for (const source of sources) {
    for (const path of source.overlayPaths) {
      fileByOverlayPath.set(path, source.file);
    }
  }

  for (const file of plan.files) {
    const origin = fileByOverlayPath.get(file.path);
    const bom = origin === undefined ? false : bomByFile.get(origin.toLowerCase()) === true;
    writeWithEncoding(join(overlayDir, file.path), file.code, bom);
  }

  return {
    plan,
    overlayDir,
    runtimeDir,
    entrySource: join(overlayDir, entryPath),
    hitsPath,
    programName
  };
}

/**
 * Turns the counts a run wrote into a report.
 *
 * A missing hits file is not an error here but an empty report: DFUnit leaves through
 * `ExitProcess`, so a suite that dies early never reaches the flush and produces no counts at all.
 * The caller says so rather than presenting nothing as zero coverage.
 */
export function collectReport(plan: CoveragePlan, hitsPath: string): CoverageReport | undefined {
  if (!existsSync(hitsPath)) {
    return undefined;
  }
  return buildReport(plan.probes, parseHits(readFileSync(hitsPath, 'utf8')));
}

/**
 * Turns the timings a profiling run wrote into a report.
 *
 * Undefined, like `collectReport`, when the file is not there at all: the program was closed by
 * the task manager, or it died before `Start_UI` returned, and neither is the same as "nothing
 * took any time".
 */
export function collectProfile(plan: CoveragePlan, profilePath: string): ProfileReport | undefined {
  if (!existsSync(profilePath)) {
    return undefined;
  }
  return buildProfile(plan.probes, parseProfile(readFileSync(profilePath, 'utf8')));
}
