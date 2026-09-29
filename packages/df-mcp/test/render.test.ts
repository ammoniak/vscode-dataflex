import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  MAX_BYTES,
  columns,
  compressRanges,
  narrow,
  oneBased,
  render,
  resolveOutPath,
  toolText,
  workspaceRelative,
  writeJsonl
} from '../src/render';

const scratch = mkdtempSync(join(tmpdir(), 'df-mcp-render-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('render', () => {
  it('passes a small payload through untouched', () => {
    expect(render(['one', 'two'])).toBe('one\ntwo');
  });

  it('appends the hint when there is one', () => {
    expect(render(['one'], 'narrow with rule:')).toBe('one\nnarrow with rule:');
  });

  it('stops before the ceiling and says how much it dropped', () => {
    const row = 'x'.repeat(200);
    const lines = Array.from({ length: 500 }, () => row);
    const out = render(lines, narrow('rule:'));

    expect(Buffer.byteLength(out, 'utf8')).toBeLessThan(MAX_BYTES + 200);
    expect(out).toContain('more line(s) not shown');
    expect(out).toContain('narrow with rule:');
  });

  it('truncates by whole lines, never mid-row', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `${i}:${'y'.repeat(120)}`);
    const kept = render(lines).split('\n').filter((line) => line.includes(':'));
    for (const line of kept) {
      expect(line).toMatch(/^\d+:y+$/);
    }
  });
});

describe('workspaceRelative', () => {
  const root = resolve('/ws/MyApp');

  it('makes a path under the root relative, with forward slashes', () => {
    const file = join(root, 'AppSrc', 'Customer.wo');
    expect(workspaceRelative(root, file)).toBe('AppSrc/Customer.wo');
  });

  it('leaves a path outside the root absolute, because that difference is information', () => {
    const outside = resolve('/opt/df/Pkg/cWebForm.pkg');
    expect(workspaceRelative(root, outside)).toContain('cWebForm.pkg');
    expect(workspaceRelative(root, outside).startsWith('AppSrc')).toBe(false);
  });
});

describe('oneBased', () => {
  it('shifts a 0-based range line to what a reader counts', () => {
    expect(oneBased(0)).toBe(1);
    expect(oneBased(411)).toBe(412);
  });
});

describe('columns', () => {
  it('pads every column but the last', () => {
    expect(columns([['a', 'bbb', 'c'], ['aaaa', 'b', 'dd']])).toEqual([
      'a     bbb  c',
      'aaaa  b    dd'
    ]);
  });

  it('trims trailing padding so blank cells cost nothing', () => {
    expect(columns([['aaaa', ''], ['b', '']])).toEqual(['aaaa', 'b']);
  });
});

describe('compressRanges', () => {
  it('collapses runs and keeps singletons', () => {
    expect(compressRanges([44, 45, 46, 47, 48, 49, 50, 51, 58, 90, 91])).toBe('44-51, 58, 90-91');
  });

  it('sorts and de-duplicates first', () => {
    expect(compressRanges([9, 7, 8, 7])).toBe('7-9');
  });

  it('is empty for no lines', () => {
    expect(compressRanges([])).toBe('');
  });
});

describe('resolveOutPath', () => {
  it('accepts a path inside the workspace', () => {
    const inside = join(scratch, 'report.jsonl');
    expect(resolveOutPath(inside, scratch)).toBe(join(scratch, 'report.jsonl'));
  });

  it('accepts a path in the temp directory', () => {
    const inTemp = join(tmpdir(), 'df-report.jsonl');
    expect(resolveOutPath(inTemp, scratch)).toBe(inTemp);
  });

  it('refuses anywhere else', () => {
    const elsewhere = resolve('/definitely/not/the/workspace/evil.txt');
    expect(() => resolveOutPath(elsewhere, scratch)).toThrow(/must be inside the workspace/);
  });
});

describe('writeJsonl', () => {
  it('writes one object per line', () => {
    const path = join(scratch, 'findings.jsonl');
    const count = writeJsonl(path, [{ rule: 'unused-local', line: 1 }, { rule: 'unreachable-code', line: 9 }]);

    expect(count).toBe(2);
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ rule: 'unused-local', line: 1 });
  });

  it('writes an empty file for no rows rather than a stray newline', () => {
    const path = join(scratch, 'empty.jsonl');
    expect(writeJsonl(path, [])).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe('');
  });
});

describe('toolText', () => {
  it('is a bare text envelope when nothing was re-indexed', () => {
    expect(toolText('hello')).toEqual({ content: [{ type: 'text', text: 'hello' }] });
  });

  it('notes re-indexed files so the agent can see its own edit landed', () => {
    expect(toolText('hello', 3).content[0]!.text).toContain('3 file(s) re-indexed');
  });
});

describe('the ceiling includes the footer', () => {
  it('never exceeds MAX_BYTES, hint and overflow note included', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `${i}:${'z'.repeat(120)}`);
    const hint = narrow('a longer query', 'kind:', 'ownOnly:true', 'offset:');

    const out = render(lines, hint);

    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(MAX_BYTES);
    expect(out.endsWith(hint)).toBe(true);
    expect(out).toContain('more line(s) not shown');
  });
});
