import * as vscode from 'vscode';
import type { CoverageReport, Probe } from '@vscode-dataflex/coverage';

/**
 * Turns a coverage report into what the editor's coverage view renders.
 *
 * Kept pure and separate from the test controller so the mapping can be asserted directly; the
 * controller around it needs a real workspace and a compiler to say anything at all.
 */

/** Per-file details, keyed by the file's lower-cased path. */
export type DetailsByFile = Map<string, vscode.FileCoverageDetail[]>;

/**
 * Builds the detail lists.
 *
 * Two kinds are emitted, because the probes carry enough to justify both:
 *
 *  - **Statement coverage** from every probe, using the line it guards. Probes sit at the entry
 *    of each basic block, so a branch that never ran is distinguishable from one that did rather
 *    than the whole procedure counting as covered because its first line executed.
 *  - **Declaration coverage** from the entry probe of each procedure or function, which is what
 *    lets the view report "3 of 8 procedures covered" alongside the line figure.
 */
export function coverageDetails(report: CoverageReport, probes: readonly Probe[]): DetailsByFile {
  const byFile: DetailsByFile = new Map();

  for (const file of report.files) {
    const details: vscode.FileCoverageDetail[] = [];
    for (const [line, count] of [...file.hits].sort((a, b) => a[0] - b[0])) {
      details.push(new vscode.StatementCoverage(count, new vscode.Position(line, 0)));
    }
    byFile.set(file.file.toLowerCase(), details);
  }

  // One declaration per method, counted from its entry probe. A method may own several entry
  // probes only if the graph enters it more than once, so the highest count is the honest one.
  const methods = new Map<string, { name: string; line: number; count: number }>();
  for (const probe of probes) {
    if (probe.kind !== 'entry' || probe.method === undefined) {
      continue;
    }
    const key = `${probe.file.toLowerCase()}\0${probe.method}`;
    const hits = hitCount(report, probe);
    const existing = methods.get(key);
    if (existing === undefined) {
      methods.set(key, { name: probe.method, line: probe.line, count: hits });
    } else if (hits > existing.count) {
      existing.count = hits;
      existing.line = probe.line;
    }
  }

  for (const [key, method] of methods) {
    const file = key.split('\0')[0]!;
    byFile
      .get(file)
      ?.push(
        new vscode.DeclarationCoverage(
          method.name,
          method.count,
          new vscode.Position(method.line, 0)
        )
      );
  }

  return byFile;
}

/** How often the line this probe guards ran. */
function hitCount(report: CoverageReport, probe: Probe): number {
  const file = report.files.find((entry) => entry.file.toLowerCase() === probe.file.toLowerCase());
  return file?.hits.get(probe.line) ?? 0;
}

/** The per-file summaries the coverage view lists, with counts derived from the details. */
export function fileCoverage(details: DetailsByFile, paths: readonly string[]): vscode.FileCoverage[] {
  const coverage: vscode.FileCoverage[] = [];
  for (const path of paths) {
    const entries = details.get(path.toLowerCase());
    if (entries !== undefined) {
      coverage.push(vscode.FileCoverage.fromDetails(vscode.Uri.file(path), entries));
    }
  }
  return coverage;
}
