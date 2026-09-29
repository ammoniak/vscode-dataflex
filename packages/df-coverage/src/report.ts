import type { Probe } from './instrument';

/** Per-line coverage for one file. */
export interface FileCoverage {
  file: string;
  /** Zero-based line -> how many times a probe on it ran. */
  hits: Map<number, number>;
  /** Lines carrying a probe that never ran. */
  missed: number[];
  covered: number;
  total: number;
}

export interface CoverageReport {
  files: FileCoverage[];
  covered: number;
  total: number;
  /** Covered probes as a fraction, or 1 when there was nothing to measure. */
  ratio: number;
}

/**
 * Parses the `id<TAB>count` file the runtime writes.
 *
 * Tolerant of a truncated final line: a run that crashed still reports the probes that fired
 * before it did, which is exactly when coverage is most worth looking at.
 */
export function parseHits(text: string): Map<number, number> {
  const hits = new Map<number, number>();

  for (const line of text.split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    if (tab <= 0) {
      continue;
    }
    const id = Number.parseInt(line.slice(0, tab), 10);
    const count = Number.parseInt(line.slice(tab + 1), 10);
    if (Number.isNaN(id) || Number.isNaN(count)) {
      continue;
    }
    hits.set(id, (hits.get(id) ?? 0) + count);
  }

  return hits;
}

/**
 * Joins the probe map with the recorded hits.
 *
 * The probe map holds *original* line numbers, so nothing has to be remapped even though the
 * instrumented copy that produced the hits had different line numbering.
 */
export function buildReport(probes: readonly Probe[], hits: Map<number, number>): CoverageReport {
  const byFile = new Map<string, FileCoverage>();

  for (const probe of probes) {
    let file = byFile.get(probe.file);
    if (file === undefined) {
      file = { file: probe.file, hits: new Map(), missed: [], covered: 0, total: 0 };
      byFile.set(probe.file, file);
    }

    const count = hits.get(probe.id) ?? 0;
    file.total++;
    if (count > 0) {
      file.covered++;
      file.hits.set(probe.line, (file.hits.get(probe.line) ?? 0) + count);
    } else {
      file.missed.push(probe.line);
      // Record the line as seen-but-unhit, so a reader can tell "not covered" from "not code".
      if (!file.hits.has(probe.line)) {
        file.hits.set(probe.line, 0);
      }
    }
  }

  const files = [...byFile.values()];
  for (const file of files) {
    file.missed.sort((a, b) => a - b);
  }

  const covered = files.reduce((total, file) => total + file.covered, 0);
  const total = files.reduce((sum, file) => sum + file.total, 0);

  return { files, covered, total, ratio: total === 0 ? 1 : covered / total };
}

/**
 * Renders the report as LCOV.
 *
 * LCOV is what CI tooling reads, and it is also what the editor's coverage view consumes most
 * easily. Only `DA` records are emitted: probes are per basic block, so line data is honest while
 * function and branch records would imply a precision this does not have.
 */
export function toLcov(report: CoverageReport): string {
  const lines: string[] = [];

  for (const file of report.files) {
    lines.push(`SF:${file.file}`);
    for (const [line, count] of [...file.hits].sort((a, b) => a[0] - b[0])) {
      // LCOV line numbers are one-based.
      lines.push(`DA:${line + 1},${count}`);
    }
    lines.push(`LF:${file.hits.size}`);
    lines.push(`LH:${[...file.hits.values()].filter((count) => count > 0).length}`);
    lines.push('end_of_record');
  }

  return lines.join('\n');
}
