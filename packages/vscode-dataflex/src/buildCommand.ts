/**
 * Moved to `@vscode-dataflex/workspace` so hosts that are not the extension can build the same
 * command line. Re-exported here because the task provider and its tests import it by this path.
 */
export { commandLine } from '@vscode-dataflex/workspace';
export type { TaskName } from '@vscode-dataflex/workspace';
