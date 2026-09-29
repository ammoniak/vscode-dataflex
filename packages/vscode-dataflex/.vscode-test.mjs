import { pathToFileURL } from 'node:url';
import { defineConfig } from '@vscode/test-cli';

/**
 * Runs the integration suite against the real DataFlex 26 WebOrder example, which is what makes
 * the df-cli round-trip and the DfPkg package-cache resolution testable at all. The suite skips
 * itself when that example is not installed.
 *
 * The folder is passed as an explicit `--folder-uri` rather than through `workspaceFolder`: that
 * option is forwarded to VS Code as a bare positional argument, and the default example path
 * contains spaces ("DataFlex 26.0 Examples"), which splits into several nonexistent paths and
 * leaves the test host with no workspace folder at all.
 */
const WORKSPACE = 'C:/DataFlex 26.0 Examples/WebOrder';

export default defineConfig({
  files: 'out-test/**/*.test.js',
  launchArgs: ['--folder-uri', pathToFileURL(WORKSPACE).toString()],
  mocha: {
    ui: 'tdd',
    timeout: 120000
  }
});
