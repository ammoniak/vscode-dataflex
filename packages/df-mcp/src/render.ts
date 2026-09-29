import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative as pathRelative, resolve, sep } from 'node:path';

/**
 * The ceiling on a single tool response, in bytes of UTF-8.
 *
 * This is the whole reason the server is usable. `unused-local` alone finds 2,272 results in
 * a 285k-line workspace and `dead-procedure` 6,246; a tool that returned them would spend an agent's context on
 * one call and leave nothing to think with. Every payload comes through `render`, which keeps
 * whole lines and then says, in the footer, which argument narrows the result -- so the agent's
 * next move is a smaller query rather than a re-read.
 */
export const MAX_BYTES = 16 * 1024;

/** Room kept back for the "... N more line(s)" note, so it cannot itself push past the ceiling. */
const OVERFLOW_NOTE_BYTES = 64;

/** The footer telling the agent how to get the rest. */
export function narrow(...parameters: readonly string[]): string {
  return `narrow with ${parameters.join(', ')}, or pass out:"<path>" to write the full report`;
}

/**
 * Joins lines, stopping before the byte ceiling.
 *
 * Truncation is by whole lines: half a row is worse than no row, because an agent will read the
 * remains as data.
 */
export function render(lines: readonly string[], hint?: string): string {
  // The footer counts against the ceiling too. Reserving it up front is the difference between
  // "at most 16 KB" and "16 KB plus however long the hint happened to be", and the hint is only
  // ever added when the result was already at the limit.
  const footer = hint === undefined ? 0 : Buffer.byteLength(hint, 'utf8') + 1;
  const ceiling = MAX_BYTES - footer - OVERFLOW_NOTE_BYTES;

  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const cost = Buffer.byteLength(line, 'utf8') + 1;
    if (bytes + cost > ceiling) {
      kept.push(`... ${(lines.length - kept.length).toLocaleString('en-US')} more line(s) not shown.`);
      if (hint !== undefined) {
        kept.push(hint);
      }
      return kept.join('\n');
    }
    kept.push(line);
    bytes += cost;
  }
  if (hint !== undefined) {
    kept.push(hint);
  }
  return kept.join('\n');
}

/**
 * A path as the agent should see it: relative to the workspace root, forward slashes.
 *
 * Worth the trouble -- in a real workspace an absolute path is about forty characters, every one of them
 * repeated on every row of every result. Paths outside the root (the runtime library, a `DfPkg`
 * dependency) stay absolute, because that difference is information.
 */
export function workspaceRelative(root: string, file: string): string {
  const relative = pathRelative(root, file);
  if (relative.length === 0 || relative.startsWith('..') || isAbsolute(relative)) {
    return file.split(sep).join('/');
  }
  return relative.split(sep).join('/');
}

/** Ranges and index lines are 0-based; everything an agent reads is 1-based. Converted here. */
export function oneBased(line: number): number {
  return line + 1;
}

/** Pads columns so a table scans, without a formatting dependency. */
export function columns(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd()
  );
}

/**
 * Consecutive line numbers as ranges: `44-51, 58, 90-97`.
 *
 * A missed-line list for one file is otherwise hundreds of comma-separated integers, which is
 * both unreadable and the single most compressible thing these tools produce.
 */
export function compressRanges(lines: readonly number[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start: number | undefined;
  let previous: number | undefined;
  const flush = (): void => {
    if (start === undefined || previous === undefined) {
      return;
    }
    parts.push(start === previous ? `${start}` : `${start}-${previous}`);
  };
  for (const line of sorted) {
    if (previous !== undefined && line === previous + 1) {
      previous = line;
      continue;
    }
    flush();
    start = line;
    previous = line;
  }
  flush();
  return parts.join(', ');
}

/**
 * Where a tool is allowed to write a full report.
 *
 * Inside the workspace or the temp directory, and nowhere else. `out` exists so a large result
 * can land somewhere the agent greps instead of somewhere it reads, not so a tool call can write
 * to an arbitrary path on the machine.
 */
export function resolveOutPath(candidate: string, root: string): string {
  const target = resolve(candidate);
  const permitted = [resolve(root), resolve(tmpdir())];
  const inside = permitted.some((base) => {
    const relative = pathRelative(base, target);
    return relative.length > 0 && !relative.startsWith('..') && !isAbsolute(relative);
  });
  if (!inside) {
    throw new Error(
      `out must be inside the workspace (${root}) or the temp directory (${tmpdir()}); got ${target}`
    );
  }
  return target;
}

/**
 * Writes rows as JSON Lines.
 *
 * One object per line, because what the agent does next is grep or head. A single pretty-printed
 * array defeats both, and a compact one is a single unreadable line.
 */
export function writeJsonl(path: string, rows: readonly unknown[]): number {
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  writeFileSync(path, rows.length === 0 ? '' : `${body}\n`, 'utf8');
  return rows.length;
}

/** The MCP content envelope every tool returns, with the freshness note tools share. */
export function toolText(body: string, refreshed = 0): {
  content: { type: 'text'; text: string }[];
} {
  const suffix = refreshed > 0 ? `\n\n(${refreshed} file(s) re-indexed since the last call)` : '';
  return { content: [{ type: 'text' as const, text: body + suffix }] };
}
