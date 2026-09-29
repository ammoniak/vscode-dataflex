import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpSession } from '../src/session';

/**
 * Finding the workspace when the agent's working directory is not the workspace.
 *
 * A folder holding several DataFlex workspaces side by side, plus shared docs and libraries, is an
 * ordinary layout and a deliberate place to start an agent -- one real one has nine workspaces
 * across seven subfolders. Looking only at the root made that a dead end.
 */
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'df-discovery-'));
  for (const [folder, files] of [
    ['MyApp', ['MyApp.sws']],
    ['AppFroala', ['AppFroala.sws', 'Froala_24_0.sws']],
    ['docs', []],
    ['nested/deep', ['Deep.sws']],
    // The same workspace name in two places: a real ambiguity, unlike a folder and the file in it.
    ['siteA', ['Shared.sws']],
    ['siteB', ['Shared.sws']]
  ] as [string, string[]][]) {
    mkdirSync(join(root, folder), { recursive: true });
    for (const file of files) {
      writeFileSync(join(root, folder, file), JSON.stringify({ df: 26.0, projects: [] }), 'utf8');
    }
  }
  // Never scanned: large and never holds a workspace.
  mkdirSync(join(root, 'MyApp', 'AppHtml'), { recursive: true });
  writeFileSync(join(root, 'MyApp', 'AppHtml', 'Decoy.sws'), '{}', 'utf8');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function session(at: string): McpSession {
  return new McpSession({ root: at });
}

describe('candidates', () => {
  it('finds the workspaces below a folder that has none of its own', () => {
    const found = session(root).candidates();

    expect(found.some((path) => path.endsWith('MyApp.sws'))).toBe(true);
    expect(found.some((path) => path.endsWith('AppFroala.sws'))).toBe(true);
    expect(found.some((path) => path.endsWith('Deep.sws'))).toBe(true);
  });

  it('skips directories that never hold a workspace', () => {
    expect(session(root).candidates().some((path) => path.includes('AppHtml'))).toBe(false);
  });

  it('returns only the root when the root itself has one, without descending', () => {
    const found = session(join(root, 'MyApp')).candidates();

    expect(found).toHaveLength(1);
    expect(found[0]!.endsWith('MyApp.sws')).toBe(true);
  });

  it('is empty for a folder with nothing under it, rather than throwing', () => {
    expect(session(join(root, 'docs')).candidates()).toEqual([]);
  });
});

describe('resolveCandidate', () => {
  it('accepts the containing folder name, which is the shortest thing an agent knows', () => {
    const match = session(root).resolveCandidate('MyApp');
    expect(match).toBeDefined();
    expect('path' in match! && match.path.endsWith('MyApp.sws')).toBe(true);
  });

  it('accepts the file name, with or without the extension', () => {
    for (const wanted of ['AppFroala.sws', 'AppFroala']) {
      const match = session(root).resolveCandidate(wanted);
      expect('path' in match! && match.path.endsWith('AppFroala.sws'), wanted).toBe(true);
    }
  });

  it('accepts a relative path with either separator', () => {
    for (const wanted of ['MyApp/MyApp.sws', join('MyApp', 'MyApp.sws')]) {
      const match = session(root).resolveCandidate(wanted);
      expect('path' in match! && match.path.endsWith('MyApp.sws'), wanted).toBe(true);
    }
  });

  it('accepts the absolute path it reported', () => {
    const listed = session(root).candidates().find((path) => path.endsWith('MyApp.sws'))!;
    const match = session(root).resolveCandidate(listed);

    expect('path' in match! && match.path).toBe(listed);
  });

  it('prefers the file over the folder that holds it, which is not a real ambiguity', () => {
    const match = session(root).resolveCandidate('AppFroala');
    expect('path' in match! && match.path.endsWith('AppFroala.sws')).toBe(true);
  });

  it('refuses to choose when the same name really does exist twice', () => {
    const match = session(root).resolveCandidate('Shared');

    expect(match).toBeDefined();
    expect('ambiguous' in match!).toBe(true);
    if ('ambiguous' in match!) {
      expect(match.ambiguous).toHaveLength(2);
    }
  });

  it('names the folder to disambiguate', () => {
    const match = session(root).resolveCandidate('siteB/Shared.sws');
    expect('path' in match! && match.path.includes('siteB')).toBe(true);
  });

  it('is undefined for a name that matches nothing', () => {
    expect(session(root).resolveCandidate('NoSuchWorkspace')).toBeUndefined();
  });
});
