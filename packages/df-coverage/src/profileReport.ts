import type { Probe } from './instrument';

/**
 * Turns what a profiling run wrote into something worth reading.
 *
 * Kept apart from `report.ts` because the two answer different questions from different files:
 * coverage asks whether a line ran, profiling asks how long a method took. Sharing a parser would
 * mean one format with optional columns, and a reader that cannot tell a missing column from a
 * zero.
 */

/** One method's timing, as the run measured it. */
export interface MethodProfile {
  probe: number;
  file: string;
  /** Zero-based line of the method's header. */
  line: number;
  method: string;
  calls: number;
  exits: number;
  /** Wall-clock milliseconds spent inside the method, including anything it called. */
  milliseconds: number;
  /** Milliseconds per call, or 0 when it was never entered. */
  mean: number;
  /**
   * False when the method was entered and left a different number of times.
   *
   * Its time is then understated: the run left by a path with no exit probe -- an error trap, or a
   * return the instrumenter could not reach -- so the elapsed time for those calls was never
   * added. Reported rather than hidden, because a plausible wrong number is worse than a flagged
   * one.
   */
  balanced: boolean;
}

export interface ProfileReport {
  /** Slowest first: the reason anyone opens a profile. */
  methods: MethodProfile[];
  /** Total measured time. Not the run's wall clock; nested calls are counted at every level. */
  totalMilliseconds: number;
  /** How many methods reported unbalanced enter/exit counts. */
  unbalanced: number;
}

/** One line of the file the runtime writes. */
export interface ProfileSample {
  calls: number;
  exits: number;
  milliseconds: number;
}

/**
 * Parses the `id<TAB>calls<TAB>exits<TAB>milliseconds` file.
 *
 * Tolerant of a truncated final line, like `parseHits`: a run that died still measured everything
 * up to the point it died, which is often exactly what is being investigated.
 */
export function parseProfile(text: string): Map<number, ProfileSample> {
  const samples = new Map<number, ProfileSample>();

  for (const line of text.split(/\r?\n/)) {
    const parts = line.split('\t');
    if (parts.length < 4) {
      continue;
    }
    const id = Number(parts[0]);
    const calls = Number(parts[1]);
    const exits = Number(parts[2]);
    const milliseconds = Number(parts[3]);
    if (
      !Number.isInteger(id) ||
      id < 0 ||
      !Number.isFinite(calls) ||
      !Number.isFinite(exits) ||
      !Number.isFinite(milliseconds)
    ) {
      continue;
    }
    samples.set(id, { calls, exits, milliseconds });
  }

  return samples;
}

/**
 * Joins the probe map to the measurements.
 *
 * Methods that never ran are left out entirely. A profile is a list of what the run did, and
 * padding it with every method in the workspace at zero would bury that.
 */
export function buildProfile(
  probes: readonly Probe[],
  samples: Map<number, ProfileSample>
): ProfileReport {
  const methods: MethodProfile[] = [];

  for (const probe of probes) {
    const sample = samples.get(probe.id);
    if (sample === undefined || sample.calls === 0) {
      continue;
    }
    methods.push({
      probe: probe.id,
      file: probe.file,
      line: probe.line,
      method: probe.method ?? '(file scope)',
      calls: sample.calls,
      exits: sample.exits,
      milliseconds: sample.milliseconds,
      mean: sample.calls === 0 ? 0 : sample.milliseconds / sample.calls,
      balanced: sample.calls === sample.exits
    });
  }

  methods.sort((a, b) => b.milliseconds - a.milliseconds || a.method.localeCompare(b.method));

  return {
    methods,
    totalMilliseconds: methods.reduce((sum, entry) => sum + entry.milliseconds, 0),
    unbalanced: methods.filter((entry) => !entry.balanced).length
  };
}

/**
 * Where a method was declared, as `file:line`.
 *
 * Not decoration. The first real profile of the Order Entry example listed five separate rows
 * called `Construct_Object`, which is a name every DataFlex class defines -- without the file
 * there is no way to tell which one is the slow one.
 */
function where(entry: MethodProfile): string {
  return `${entry.file.split(/[\\/]/).pop() ?? entry.file}:${entry.line + 1}`;
}

/** A fixed-width table, slowest first, for a terminal or an output channel. */
export function formatProfile(report: ProfileReport, limit = 30): string {
  if (report.methods.length === 0) {
    return 'No methods were entered.';
  }

  const shown = report.methods.slice(0, limit);
  const width = Math.max(...shown.map((entry) => entry.method.length), 'method'.length);
  const whereWidth = Math.max(...shown.map((entry) => where(entry).length), 'source'.length);
  const lines = [
    `${'method'.padEnd(width)}  ${'source'.padEnd(whereWidth)}  ` +
      `${'ms'.padStart(10)}  ${'calls'.padStart(8)}  ${'mean ms'.padStart(9)}`
  ];

  for (const entry of shown) {
    const flag = entry.balanced ? '' : '  (unbalanced)';
    lines.push(
      `${entry.method.padEnd(width)}  ${where(entry).padEnd(whereWidth)}  ` +
        `${entry.milliseconds.toFixed(0).padStart(10)}  ` +
        `${String(entry.calls).padStart(8)}  ${entry.mean.toFixed(2).padStart(9)}${flag}`
    );
  }

  if (report.methods.length > shown.length) {
    lines.push(`... ${report.methods.length - shown.length} more`);
  }
  if (report.unbalanced > 0) {
    lines.push(
      `${report.unbalanced} method(s) were entered and left a different number of times; ` +
        'their time is understated.'
    );
  }
  return lines.join('\n');
}
