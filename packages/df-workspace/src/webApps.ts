import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * WebApp Server applications, as the machine has them registered.
 *
 * The debugger engine's `StartProgram` takes the application id here, not a boolean: passing `true`
 * launches the program standalone, and the DataFlex runtime then refuses to run with "this program
 * is a WebApp program and cannot be run standalone" and sits on a modal dialog. Passing the id is
 * what makes the WebApp Server route a session to the debugged process instead.
 *
 * Nobody should have to know or type that id, and it is not in the workspace: it lives in the
 * registry, keyed by the program the application was registered with. Since that is the same
 * executable a debug session launches, it can be looked up from the launch configuration alone.
 *
 * `reg query` rather than a native binding, for the same reason `findDfCli` uses it: the extension
 * stays dependency-free and installable from a vsix with nothing to compile.
 */
export interface WebAppRegistration {
  /** The id the WebApp Server knows it by, e.g. `WebOrder`. */
  id: string;
  /** DataFlex version the registration lives under, e.g. `26.0`. */
  version: string;
  programPath: string;
  /** False when the registration carries `Disable=1`. */
  enabled: boolean;
}

const ROOT = 'HKLM\\SOFTWARE\\Data Access Worldwide\\DataFlex';

/**
 * `reg` is asked about `HKLM\...` and answers about `HKEY_LOCAL_MACHINE\...`, so a returned key
 * never starts with the key that was queried. Comparing the two directly finds nothing, which
 * looks exactly like a machine with no web applications registered rather than like a bug.
 */
function normalise(key: string): string {
  return key.trim().replace(/^HKEY_LOCAL_MACHINE/i, 'HKLM').toLowerCase();
}

function isChildOf(key: string, parent: string): boolean {
  return normalise(key).startsWith(normalise(parent) + '\\');
}

async function query(key: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('reg', ['query', key], { windowsHide: true });
    return stdout;
  } catch {
    return undefined;
  }
}

function valueOf(output: string, name: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\S+)\s+REG_\w+\s+(.*)$/);
    if (match !== null && match[1]?.toLowerCase() === name.toLowerCase()) {
      return match[2]?.trim();
    }
  }
  return undefined;
}

function leaf(key: string): string {
  const parts = key.trim().split('\\');
  return parts[parts.length - 1] ?? '';
}

/** Every registered web application, newest DataFlex version first. */
export async function webAppRegistrations(): Promise<WebAppRegistration[]> {
  const versions = await query(ROOT);
  if (versions === undefined) {
    return [];
  }

  const versionKeys = versions
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => isChildOf(line, ROOT))
    .sort()
    .reverse();

  const found: WebAppRegistration[] = [];
  for (const versionKey of versionKeys) {
    const applicationsKey = `${versionKey}\\WebApp Server\\Web Applications`;
    const applications = await query(applicationsKey);
    if (applications === undefined) {
      continue;
    }

    for (const line of applications.split(/\r?\n/)) {
      const key = line.trim();
      if (!isChildOf(key, applicationsKey)) {
        continue;
      }

      const details = await query(key);
      if (details === undefined) {
        continue;
      }

      const programPath = valueOf(details, 'ProgramPath');
      if (programPath === undefined) {
        continue;
      }

      found.push({
        id: leaf(key),
        version: leaf(versionKey),
        programPath,
        enabled: valueOf(details, 'Disable') !== '0x1'
      });
    }
  }

  return found;
}

/**
 * The application id a program is registered under, if any.
 *
 * Matched on the executable, because that is what a launch configuration names and what the
 * registration records. Several DataFlex versions can register the same program; the newest wins,
 * which is the same rule the engine ProgID probe follows.
 */
export async function findWebAppId(programPath: string): Promise<WebAppRegistration | undefined> {
  const wanted = programPath.replace(/\//g, '\\').toLowerCase();
  const registrations = await webAppRegistrations();
  return registrations.find((entry) => entry.programPath.replace(/\//g, '\\').toLowerCase() === wanted);
}
