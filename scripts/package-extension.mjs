/**
 * Packages the extension, in one of its two builds.
 *
 *   node scripts/package-extension.mjs           dataflex.vsix, no debugger
 *   node scripts/package-extension.mjs --debug   dataflex-debug.vsix, debugger and host
 *
 * Debugging is a build-time decision. It needs `dataflex-debug-host.exe`, a self-contained .NET
 * publish that costs 64 MB -- 29 MB of a 30 MB vsix -- and drives a Windows-only COM server, so
 * the standard build leaves it out entirely rather than shipping it switched off. `esbuild.mjs`
 * drops the code; `.vscodeignore` drops the binary; this drops the manifest contributions.
 *
 * The manifest has to be edited rather than selected, because vsce reads `package.json` from the
 * extension folder and takes no override for it. The committed manifest is the complete one, so
 * the F5 development host and `npm run build` need no ceremony to have the debugger; the standard
 * build is the one that subtracts. The original is written back in a `finally`, and a leftover
 * backup from a killed run is restored on the next one.
 *
 * Leaving the contributions in a build with no debug code would be worse than either: VS Code
 * would offer a `dataflex` debug type, activate the extension for it, find no adapter registered
 * and fail on F5 -- which is exactly the "offered but cannot finish" state this is here to avoid.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = join(here, '..', 'packages', 'vscode-dataflex');
const manifestPath = join(extensionDir, 'package.json');
// Kept at the repository root, not beside the manifest: anything in the extension folder has to be
// named in both `.vscodeignore` files or it ends up inside the vsix.
const backupPath = join(here, '..', '.package-extension-backup.json');

const withDebugger = process.argv.includes('--debug');

/** Commands that exist only in the debug build, and the menu entries that point at them. */
const DEBUG_COMMANDS = new Set(['dataflex.attach']);

/** Everything the debugger contributes to the manifest, removed for the standard build. */
function stripDebugContributions(manifest) {
  // `onDebugResolve`, `onDebugInitialConfigurations`, `onDebugDynamicConfigurations`.
  manifest.activationEvents = manifest.activationEvents.filter(
    (event) => !event.startsWith('onDebug')
  );

  const contributes = manifest.contributes;
  delete contributes.debuggers;
  delete contributes.breakpoints;
  contributes.commands = contributes.commands.filter(
    (command) => command.command !== 'dataflex.attach'
  );
  delete contributes.configuration.properties['dataflex.debuggerProgId'];

  // Menu entries for the commands just removed, and nothing else. Dropping the whole `menus` key
  // would be simpler and wrong: it is shared with every other command that contributes a menu, and
  // the loss would be silent -- a button present in the debug build and missing from the standard
  // one, with a manifest that is still perfectly valid.
  for (const [menu, entries] of Object.entries(contributes.menus ?? {})) {
    const kept = entries.filter((entry) => !DEBUG_COMMANDS.has(entry.command));
    if (kept.length > 0) {
      contributes.menus[menu] = kept;
    } else {
      delete contributes.menus[menu];
    }
  }
  if (Object.keys(contributes.menus ?? {}).length === 0) {
    delete contributes.menus;
  }

  return manifest;
}

/**
 * Runs vsce in the extension folder, inheriting its console.
 *
 * Its own JavaScript entry point rather than the `.bin` shim, because running a `.cmd` needs
 * `shell: true`, and passing arguments through a shell earns a deprecation warning about
 * unescaped concatenation. `node <script>` needs no shell on any platform.
 */
function pack(args) {
  const vsce = join(here, '..', 'node_modules', '@vscode', 'vsce', 'vsce');
  const result = spawnSync(process.execPath, [vsce, ...args], {
    cwd: extensionDir,
    stdio: 'inherit'
  });
  return result.status ?? 1;
}

// A previous run that was killed between the write and the restore leaves this behind.
if (existsSync(backupPath)) {
  console.error('Restoring packages/vscode-dataflex/package.json from a previous interrupted run.');
  writeFileSync(manifestPath, readFileSync(backupPath, 'utf8'));
  rmSync(backupPath);
}

if (withDebugger) {
  // Nothing to strip, and marked win32-x64: the host is a Windows COM client, so a macOS or Linux
  // VS Code should refuse this vsix rather than install a debugger that cannot start.
  process.exit(
    pack([
      'package',
      '--no-dependencies',
      '--target',
      'win32-x64',
      '--ignoreFile',
      '.vscodeignore.debug',
      '--out',
      'dataflex-debug.vsix'
    ])
  );
}

const original = readFileSync(manifestPath, 'utf8');
writeFileSync(backupPath, original);
try {
  const stripped = stripDebugContributions(JSON.parse(original));
  writeFileSync(manifestPath, `${JSON.stringify(stripped, undefined, 2)}\n`);
  process.exitCode = pack(['package', '--no-dependencies', '--out', 'dataflex.vsix']);
} finally {
  writeFileSync(manifestPath, original);
  rmSync(backupPath);
}
