import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findStudio } from '../src/cli';

/**
 * Locating the DataFlex Studio.
 *
 * The Studio owns the only documented DataFlex debugger, and it is not part of every installation:
 * a CLI-only install has `df-cli.exe`, `dfcomp.dll` and `dflink.dll` in `Bin` and no Studio at all.
 * So "not found" is an ordinary answer, not a failure, and callers must be able to tell the user
 * that rather than failing obscurely.
 */

let root: string;
let bin: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'df-studio-'));
  bin = join(root, 'Bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'df-cli.exe'), '');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const cli = (): string => join(bin, 'df-cli.exe');

describe('findStudio', () => {
  it('finds the Studio beside the CLI', () => {
    writeFileSync(join(bin, 'Studio.exe'), '');
    expect(findStudio(cli())).toBe(join(bin, 'Studio.exe'));
  });

  /** Older releases shipped it under other names. */
  it('accepts the older executable names', () => {
    writeFileSync(join(bin, 'VDFStudio.exe'), '');
    expect(findStudio(cli())).toBe(join(bin, 'VDFStudio.exe'));
  });

  it('prefers the current name when several are present', () => {
    writeFileSync(join(bin, 'VDFStudio.exe'), '');
    writeFileSync(join(bin, 'Studio.exe'), '');
    expect(findStudio(cli())).toBe(join(bin, 'Studio.exe'));
  });

  /** The case this exists for: a CLI-only installation, which is what CI and servers have. */
  it('answers nothing when the Studio is not installed', () => {
    expect(findStudio(cli())).toBeUndefined();
  });

  it('does not look outside the CLI s own directory', () => {
    mkdirSync(join(root, 'Other'), { recursive: true });
    writeFileSync(join(root, 'Other', 'Studio.exe'), '');
    expect(findStudio(cli())).toBeUndefined();
  });
});

/**
 * The Studio is a 64-bit application: it ships in `Bin64` while `df-cli.exe` is in `Bin`.
 *
 * Looking only beside the CLI found nothing on an installation that plainly has one, so the
 * "Debug in DataFlex Studio" command reported it missing on every machine.
 */
describe('the Bin / Bin64 split', () => {
  it('finds the Studio in Bin64 beside a CLI in Bin', () => {
    const bin64 = join(root, 'Bin64');
    mkdirSync(bin64, { recursive: true });
    writeFileSync(join(bin64, 'Studio.exe'), '');
    expect(findStudio(cli())).toBe(join(bin64, 'Studio.exe'));
  });

  it('prefers one beside the CLI over one in Bin64', () => {
    const bin64 = join(root, 'Bin64');
    mkdirSync(bin64, { recursive: true });
    writeFileSync(join(bin64, 'Studio.exe'), '');
    writeFileSync(join(bin, 'Studio.exe'), '');
    expect(findStudio(cli())).toBe(join(bin, 'Studio.exe'));
  });

  /** Several DataFlex versions are commonly installed side by side. */
  it('stays within the installation the CLI belongs to', () => {
    const other = join(root, '..', 'Other');
    mkdirSync(join(other, 'Bin64'), { recursive: true });
    writeFileSync(join(other, 'Bin64', 'Studio.exe'), '');
    expect(findStudio(cli())).toBeUndefined();
    rmSync(other, { recursive: true, force: true });
  });
});
