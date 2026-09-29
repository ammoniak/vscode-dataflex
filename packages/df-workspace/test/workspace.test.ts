import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findDfCli, findWorkspaceFiles, IncludeResolver, loadWorkspace } from '../src/index';

/**
 * These tests talk to a real DataFlex installation. They are skipped rather than failed when one
 * is absent, so the suite still runs on a machine (or CI box) without DataFlex -- but where it
 * *is* installed they are the real contract check for the `df-cli` integration.
 */
const WEBORDER = 'C:\\DataFlex 26.0 Examples\\WebOrder';
const hasWebOrder = existsSync(WEBORDER);

describe.skipIf(!hasWebOrder)('df-cli integration', () => {
  it('finds df-cli.exe', async () => {
    const cli = await findDfCli();
    expect(cli).toBeDefined();
    expect(cli!.toLowerCase()).toContain('df-cli.exe');
  });

  it('finds the .sws file in a workspace folder', () => {
    expect(findWorkspaceFiles(WEBORDER).map((p) => p.toLowerCase())).toContain(
      `${WEBORDER}\\weborder.sws`.toLowerCase()
    );
  });

  it('resolves the workspace, its projects and its search path', async () => {
    const cli = await findDfCli();
    const workspace = await loadWorkspace(cli!, `${WEBORDER}\\WebOrder.sws`);

    expect(workspace).toBeDefined();
    expect(workspace!.loadedSuccessfully).toBe(true);
    expect(workspace!.isLegacySws).toBe(false);
    expect(workspace!.projects.map((p) => p.name)).toContain('WebApp.src');

    // DataFlex 26+ materialises dependencies into <workspace>/DfPkg. The Web UI class library --
    // which used to live in Program Files -- is one of them, and an indexer that misses it finds
    // zero web classes.
    expect(workspace!.searchPath.some((p) => /DfPkg\\DataFlex_dev_Web_UI-/i.test(p))).toBe(true);
    // The version is not pinned: the install directory is whatever DataFlex is on this
    // machine, and pinning it made the suite fail the day 27 was installed alongside.
    expect(workspace!.searchPath.some((p) => /DataFlex \d+\.\d+\\Pkg$/i.test(p))).toBe(true);
    expect(workspace!.dependencies.map((d) => d.id)).toContain('DataFlex-dev/Web UI Server');
  }, 60_000);

  it('resolves a Use name to a file inside the package cache', async () => {
    const cli = await findDfCli();
    const workspace = await loadWorkspace(cli!, `${WEBORDER}\\WebOrder.sws`);
    const resolver = new IncludeResolver(workspace!.searchPath);

    // The acceptance case: `Use cWebForm.pkg` in a .wo must land in the Web UI package.
    const resolved = resolver.resolve('cWebForm.pkg');
    expect(resolved).toBeDefined();
    expect(resolved!).toMatch(/DfPkg\\DataFlex_dev_Web_UI-[\d.]+\\AppSrc\\cWebForm\.pkg$/i);

    // A name given without an extension still resolves.
    expect(resolver.resolve('cWebForm')?.toLowerCase()).toBe(resolved!.toLowerCase());

    // A core runtime package resolves out of the install directory.
    expect(resolver.resolve('Windows.pkg')).toMatch(
      /DataFlex \d+\.\d+\\Pkg\\Windows\.pkg$/i
    );

    // A name that is not on the search path resolves to nothing rather than guessing.
    expect(resolver.resolve('NoSuchPackage.pkg')).toBeUndefined();
  }, 60_000);

  it('indexes the search path as a flat file set', async () => {
    const cli = await findDfCli();
    const workspace = await loadWorkspace(cli!, `${WEBORDER}\\WebOrder.sws`);
    const files = new IncludeResolver(workspace!.searchPath).allSourceFiles();

    expect(files.length).toBeGreaterThan(500);
    expect(files.some((f) => /cWebForm\.pkg$/i.test(f))).toBe(true);
  }, 60_000);
});
