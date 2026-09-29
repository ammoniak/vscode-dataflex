import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cliForWorkspace, installedVersionOf, workspaceDataFlexVersion } from '../src/cli';

/**
 * Which DataFlex a workspace asks for.
 *
 * This matters because several versions are routinely installed side by side. Picking the newest
 * instead of the one named resolves the whole include path against the wrong runtime library --
 * on one real workspace that was the difference between indexing 1,123 files and 1,718, with
 * every `Use` landing in the wrong `Pkg` directory. It fails quietly, which is what makes it worth
 * a test.
 */
const scratch = mkdtempSync(join(tmpdir(), 'df-sws-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function sws(name: string, body: unknown): string {
  const path = join(scratch, `${name}.sws`);
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  return path;
}

describe('workspaceDataFlexVersion', () => {
  it('reads the df key a real .sws carries', () => {
    expect(workspaceDataFlexVersion(sws('a', { df: 26.0, projects: ['WebApp.src'] }))).toBe('26.0');
  });

  it('normalises a bare major to <major>.0, since that is how installs are named', () => {
    expect(workspaceDataFlexVersion(sws('b', { df: 26 }))).toBe('26.0');
    expect(workspaceDataFlexVersion(sws('c', { df: '25' }))).toBe('25.0');
  });

  it('keeps a minor version as written', () => {
    expect(workspaceDataFlexVersion(sws('d', { df: '24.1' }))).toBe('24.1');
  });

  it('is undefined when the key is absent, so the caller falls back to newest', () => {
    expect(workspaceDataFlexVersion(sws('e', { projects: [] }))).toBeUndefined();
  });

  it('is undefined rather than throwing on a value that is not a version', () => {
    expect(workspaceDataFlexVersion(sws('f', { df: 'latest' }))).toBeUndefined();
    expect(workspaceDataFlexVersion(sws('g', { df: true }))).toBeUndefined();
  });

  it('is undefined rather than throwing on a file that is not JSON', () => {
    expect(workspaceDataFlexVersion(sws('h', 'this is not json'))).toBeUndefined();
  });

  it('is undefined rather than throwing when the file is not there', () => {
    expect(workspaceDataFlexVersion(join(scratch, 'nothing-here.sws'))).toBeUndefined();
  });
});

describe('installedVersionOf', () => {
  it('reads the version out of a conventional install path', () => {
    expect(installedVersionOf(join('C:', 'Program Files', 'DataFlex 26.0', 'Bin', 'df-cli.exe'))).toBe(
      '26.0'
    );
  });

  it('reports 0 when the path does not name a version, so no false mismatch is reported', () => {
    expect(installedVersionOf(join('C:', 'tools', 'df-cli.exe'))).toBe('0');
  });
});

/**
 * The one call every host should make.
 *
 * The language server got this right and nine corpus scripts did not, which meant a `"df": 26.0`
 * workspace was measured against the DataFlex 27 library by everything except the editor -- and
 * findings that cannot be reproduced in the editor are worse than no findings.
 */
describe('cliForWorkspace', () => {
  it('honours an explicit path without consulting the .sws version', async () => {
    const explicit = join('C:', 'Program Files', 'DataFlex 25.0', 'Bin', 'df-cli.exe');
    const resolved = await cliForWorkspace(sws('explicit', { df: 26.0 }), explicit);
    // Only a path that exists is accepted, so on a machine without 25.0 the answer is "none" --
    // never a silent fall back to a different version.
    if (resolved.cliPath !== undefined) {
      expect(resolved.cliPath).toBe(explicit);
      expect(resolved.using).toBe('25.0');
      expect(resolved.mismatch).toBe(true);
      expect(resolved.warning).toContain('26.0');
    } else {
      expect(resolved.mismatch).toBe(false);
    }
  });

  it('reports no mismatch and no warning when the .sws names no version', async () => {
    const resolved = await cliForWorkspace(sws('versionless', { projects: ['WebApp.src'] }));
    expect(resolved.wanted).toBeUndefined();
    expect(resolved.mismatch).toBe(false);
    expect(resolved.warning).toBeUndefined();
  });

  it('warns rather than refusing when the version asked for is not installed', async () => {
    // A version no machine has, so this is the fall-back path wherever the test runs.
    const resolved = await cliForWorkspace(sws('unobtainable', { df: 9.0 }));
    expect(resolved.wanted).toBe('9.0');
    if (resolved.cliPath === undefined) {
      // No DataFlex at all on this machine; there is nothing to mismatch against.
      expect(resolved.mismatch).toBe(false);
      return;
    }
    expect(resolved.mismatch).toBe(true);
    expect(resolved.warning).toContain('asks for DataFlex 9.0');
    expect(resolved.warning).toContain(resolved.using!);
  });
});
