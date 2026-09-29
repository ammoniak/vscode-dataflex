import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Options } from './options.js';
import type { McpSession } from './session.js';
import { registerReload, registerStatus } from './tools/status.js';
import { registerSearchSymbols } from './tools/symbols.js';
import { registerDescribe, registerReferences } from './tools/navigate.js';
import { registerAnalyzeFile, registerAnalyzeWorkspace, registerDeadCode } from './tools/analyze.js';
import { registerClass, registerDefinition, registerTable } from './tools/structure.js';
import { registerPreviewModel } from './tools/preview.js';
import { registerPreviewRender } from './tools/previewRender.js';
import {
  registerCoverageTargets,
  registerDiscoverTests,
  registerRunTests
} from './tools/tests.js';

/**
 * Builds the server and registers the tools this invocation is allowed to offer.
 *
 * The executing tools are not merely hidden when `--allow-execute` is absent -- they are never
 * registered, so `tools/list` does not advertise them and the model cannot attempt one. A default
 * registration dropped into somebody's production library workspace is therefore incapable of
 * running a compiler or a built program.
 */
export function buildServer(session: McpSession, options: Options): McpServer {
  const server = new McpServer(
    { name: 'dataflex', version: '0.0.1' },
    {
      instructions:
        'DataFlex workspace tools backed by the same index, parser and analysis the VS Code ' +
        'extension uses. Reach for dataflex_search_symbols and dataflex_describe instead of Grep ' +
        'when looking for a declaration: they know the compiler\'s include path, which reaches ' +
        'outside the workspace folder into the DfPkg package cache and the runtime library. Check ' +
        'dataflex_references before deleting or renaming anything.'
    }
  );

  registerStatus(server, session);
  registerReload(server, session);
  registerSearchSymbols(server, session);
  registerDescribe(server, session);
  registerReferences(server, session);
  registerDefinition(server, session);
  registerClass(server, session);
  registerTable(server, session);
  registerAnalyzeFile(server, session);
  registerAnalyzeWorkspace(server, session);
  registerDeadCode(server, session);
  registerPreviewModel(server, session);
  registerDiscoverTests(server, session);
  registerCoverageTargets(server, session);

  if (options.allowExecute) {
    registerPreviewRender(server, session);
    registerRunTests(server, session);
  }

  return server;
}
