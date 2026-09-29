import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Where a default DataFlex installation puts its CLI, relative to the version directory. */
const CLI_RELATIVE_PATH = join('Bin', 'df-cli.exe');

/**
 * Executable names the DataFlex Studio has shipped under.
 *
 * Tried in order. The Studio is not part of every installation -- a CLI-only install has
 * `df-cli.exe`, `dfcomp.dll` and `dflink.dll` in `Bin` and no Studio at all -- so callers must
 * treat `undefined` as "this machine cannot do that" rather than as an error.
 */
const STUDIO_EXECUTABLES = ['Studio.exe', 'VDFStudio.exe', 'DFStudio.exe'];

/**
 * Directories to look in, relative to the one holding `df-cli.exe`.
 *
 * The Studio is a 64-bit application and lives in `Bin64`, while `df-cli.exe` is in `Bin`. Looking
 * only beside the CLI found nothing on an installation that plainly has a Studio, and the feature
 * reported it as "not installed" on every machine.
 */
const STUDIO_DIRECTORIES = ['.', '../Bin64', '../Bin'];

/**
 * Locates the DataFlex Studio, given a known `df-cli.exe`.
 *
 * The Studio owns the only documented DataFlex debugger, so "debug this project" means "hand it to
 * the Studio" until something better exists -- see `docs/DEBUGGING.md`. Taking the CLI path rather
 * than searching again keeps the two pointing at the same installation, which matters when several
 * DataFlex versions are installed side by side.
 */
export function findStudio(cliPath: string): string | undefined {
  const bin = dirname(cliPath);
  for (const directory of STUDIO_DIRECTORIES) {
    for (const name of STUDIO_EXECUTABLES) {
      const candidate = join(bin, directory, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/**
 * The DataFlex version a workspace asks for, from the `df` key in its `.sws`.
 *
 * Read straight out of the file rather than from `df-cli config --json`, because it is needed
 * *before* a CLI has been chosen -- which is the whole point. The `.sws` is plain JSON, so this
 * costs a file read and no process.
 *
 * Returned as it is written, normalised to `<major>.<minor>`: `26` and `26.0` both mean the
 * `DataFlex 26.0` installation.
 */
export function workspaceDataFlexVersion(swsPath: string): string | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(swsPath, 'utf8'));
  } catch {
    return undefined;
  }
  const value = (raw as { df?: unknown } | null)?.df;
  if (typeof value !== 'number' && typeof value !== 'string') {
    return undefined;
  }
  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    return undefined;
  }
  return text.includes('.') ? text : `${text}.0`;
}

/**
 * Locates `df-cli.exe`.
 *
 * DataFlex 26 has no standalone console compiler -- `dfcomp.dll` is only reachable through the
 * CLI -- so every build, run and workspace query in this extension goes through this binary.
 *
 * Search order: an explicit setting, then the version the workspace asks for, then `PATH`, then
 * the registry (which is authoritative for a non-default install location), then the conventional
 * `Program Files\DataFlex <version>` layout, newest version first.
 *
 * `preferVersion` matters because several DataFlex versions are routinely installed side by side
 * and a workspace names the one it wants. Taking the newest instead resolves the whole include
 * path -- and therefore the index, navigation and every build -- against the wrong runtime
 * library, which is wrong quietly rather than loudly.
 */
export async function findDfCli(
  explicitPath?: string,
  preferVersion?: string
): Promise<string | undefined> {
  if (explicitPath !== undefined && explicitPath.length > 0) {
    return existsSync(explicitPath) ? explicitPath : undefined;
  }

  if (preferVersion !== undefined) {
    const wanted = await findVersion(preferVersion);
    if (wanted !== undefined) {
      return wanted;
    }
    // Fall through: a workspace asking for a version this machine does not have is better served
    // by the newest one with a warning than by refusing to open at all.
  }

  const onPath = await which('df-cli.exe');
  if (onPath !== undefined) {
    return onPath;
  }

  for (const root of await registryInstallRoots()) {
    const candidate = join(root, CLI_RELATIVE_PATH);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  for (const root of conventionalInstallRoots()) {
    const candidate = join(root, CLI_RELATIVE_PATH);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

/** What `cliForWorkspace` resolved, and whether it is the version the workspace asked for. */
export interface WorkspaceCli {
  /** The chosen `df-cli.exe`, or `undefined` when the machine has none. */
  cliPath?: string;
  /** The version the `.sws` asks for, when it says. */
  wanted?: string;
  /** The version actually resolved, or `'0'` when the path does not say. */
  using?: string;
  /** True when a version was asked for and a different one was resolved. */
  mismatch: boolean;
  /** A ready-made line to log or print when `mismatch` is true. */
  warning?: string;
}

/**
 * Resolves the compiler a `.sws` asks for.
 *
 * The workspace is what says which compiler it wants, and several DataFlex versions are routinely
 * installed side by side -- this machine has six. Resolving a `"df": 26.0` workspace with the 27
 * CLI resolves its whole include path, and therefore its index, its navigation and every build,
 * against the wrong runtime library: wrong quietly rather than loudly.
 *
 * One function rather than the same three calls repeated, because every host has to get this right
 * -- the language server, the MCP server and the corpus scripts alike -- and the one that forgets
 * is the one that reports findings nobody can reproduce.
 */
export async function cliForWorkspace(
  swsPath: string,
  explicitPath?: string
): Promise<WorkspaceCli> {
  const wanted = workspaceDataFlexVersion(swsPath);
  const cliPath = await findDfCli(explicitPath, wanted);
  if (cliPath === undefined) {
    return { wanted, mismatch: false };
  }

  const using = installedVersionOf(cliPath);
  const mismatch = wanted !== undefined && using !== '0' && using !== wanted;
  return {
    cliPath,
    wanted,
    using,
    mismatch,
    ...(mismatch
      ? {
          warning:
            `This workspace asks for DataFlex ${wanted} but only ${using} was found, so the ` +
            `include path and the index will come from that instead. Install DataFlex ${wanted}, ` +
            'or point "dataflex.cliPath" at the one you want.'
        }
      : {})
  };
}

/** The `df-cli.exe` of one specific installed version, or `undefined` if it is not installed. */
async function findVersion(version: string): Promise<string | undefined> {
  for (const root of [...(await registryInstallRoots()), ...conventionalInstallRoots()]) {
    if (compareVersions(versionOf(root), version) !== 0) {
      continue;
    }
    const candidate = join(root, CLI_RELATIVE_PATH);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** The version an install root is for, e.g. `26.0`, or `0` when the path does not say. */
export function installedVersionOf(cliPath: string): string {
  return versionOf(cliPath);
}

async function which(command: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('where', [command], { windowsHide: true });
    const first = stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
    return first?.trim();
  } catch {
    return undefined;
  }
}

/**
 * Reads DataFlex install roots from the registry.
 *
 * Uses `reg query` rather than a native binding so the extension stays dependency-free and
 * needs no per-Electron-ABI rebuild.
 */
async function registryInstallRoots(): Promise<string[]> {
  const roots: string[] = [];
  const key = 'HKLM\\SOFTWARE\\Data Access Worldwide\\DataFlex';
  try {
    const { stdout } = await execFileAsync('reg', ['query', key], { windowsHide: true });
    const versionKeys = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith(key + '\\'));

    // Newest version first.
    versionKeys.sort((a, b) => compareVersions(b.slice(key.length + 1), a.slice(key.length + 1)));

    for (const versionKey of versionKeys) {
      try {
        const result = await execFileAsync('reg', ['query', versionKey, '/v', 'RootDirectory'], {
          windowsHide: true
        });
        const match = /RootDirectory\s+REG_\w+\s+(.+)/.exec(result.stdout);
        if (match?.[1] !== undefined) {
          roots.push(match[1].trim());
        }
      } catch {
        // Version key without a RootDirectory value; skip it.
      }
    }
  } catch {
    // No registry entry (or a non-Windows host); fall through to the conventional layout.
  }
  return roots;
}

function conventionalInstallRoots(): string[] {
  const bases = [process.env['ProgramFiles'], process.env['ProgramW6432']].filter(
    (value): value is string => value !== undefined
  );

  const roots: string[] = [];
  for (const base of new Set(bases)) {
    let entries: string[];
    try {
      entries = readdirSync(base);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (/^DataFlex \d+(\.\d+)?$/i.test(entry)) {
        roots.push(join(base, entry));
      }
    }
  }

  roots.sort((a, b) => compareVersions(versionOf(b), versionOf(a)));
  return roots;
}

function versionOf(path: string): string {
  return /DataFlex (\d+(?:\.\d+)?)/i.exec(path)?.[1] ?? '0';
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Runs `df-cli` and returns its output without throwing on a non-zero exit. */
export async function runDfCli(
  cliPath: string,
  args: string[],
  cwd?: string
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cliPath, args, {
      cwd,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message ?? '',
      exitCode: err.code ?? 1
    };
  }
}
