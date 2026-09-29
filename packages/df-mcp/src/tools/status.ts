import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { installedVersionOf, workspaceDataFlexVersion } from '@vscode-dataflex/workspace';
import type { McpSession } from '../session.js';
import { columns, render } from '../render.js';

/**
 * What the server resolved, and what it could not.
 *
 * Deliberately the one tool that never forces an index build: it is what an agent calls to find
 * out whether this workspace is a DataFlex workspace at all, and that answer must be cheap.
 */
export function registerStatus(server: McpServer, session: McpSession): void {
  server.registerTool(
    'dataflex_status',
    {
      title: 'DataFlex workspace status',
      description:
        'What the DataFlex tooling resolved for this workspace: the df-cli it found, the .sws it ' +
        'picked (and any others it could have), the projects, and the size of the declaration ' +
        'index. Call this first when a DataFlex tool fails -- it names the reason.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => {
      const workspace = await session.ensureWorkspace();
      const status = workspace.status();
      const candidates = session.candidates();

      // Which DataFlex the workspace asked for, and which one answered. Several versions are
      // routinely installed side by side, and a mismatch means the include path -- and so the
      // whole index -- came from the wrong runtime library.
      const wanted =
        status.swsPath === undefined ? undefined : workspaceDataFlexVersion(status.swsPath);
      const using = status.cliPath === undefined ? undefined : installedVersionOf(status.cliPath);

      const rows: string[][] = [
        ['root', session.root],
        [
          'df-cli',
          status.cliPath === undefined
            ? '(not found)'
            : `${status.cliPath}${wanted === undefined || using === '0' || using === wanted ? '' : `   *** the workspace asks for DataFlex ${wanted} ***`}`
        ],
        ['dataflex', wanted === undefined ? '(the .sws names no version)' : wanted],
        ['workspace', status.workspaceName ?? '(none)'],
        ['sws', status.swsPath ?? '(none)']
      ];
      if (status.projects.length > 0) {
        rows.push([
          'projects',
          status.projects.map((project) => project.name).join(', ')
        ]);
      }
      rows.push(['search path', `${status.searchPathCount} directories`]);
      rows.push(['dependencies', String(status.dependencyCount)]);
      rows.push([
        'index',
        status.indexReady
          ? `${status.indexedFiles} files, ${status.indexedNames} names, ${status.indexedClasses} classes`
          : 'not ready'
      ]);

      const lines = columns(rows);
      if (status.swsPath === undefined && candidates.length > 0) {
        lines.push(
          '',
          `${candidates.length} workspace(s) found below this folder. Pick one with ` +
            'dataflex_reload { sws: "<path>" }:',
          ...candidates.map((candidate) => `  ${candidate}`)
        );
      } else if (candidates.length > 1) {
        lines.push(
          '',
          'other .sws found: ' + candidates.filter((c) => c !== status.swsPath).join(', ')
        );
      }
      if (status.lastError !== undefined) {
        lines.push('', `error: ${status.lastError}`);
      }

      return {
        content: [{ type: 'text' as const, text: render(lines) }],
        structuredContent: { ...status, candidates }
      };
    }
  );
}

export function registerReload(server: McpServer, session: McpSession): void {
  server.registerTool(
    'dataflex_reload',
    {
      title: 'Reload the DataFlex workspace',
      description:
        'Resolves the workspace and rebuilds the declaration index from scratch. Edits to existing ' +
        'files are picked up automatically, so this is for the cases that are not: a file you just ' +
        'created, a changed .sws or project configuration, or switching to a different .sws in a ' +
        'folder that holds several. Costs a df-cli call and a full index build.',
      inputSchema: {
        sws: z
          .string()
          .optional()
          .describe('Switch to this .sws. Absolute, or relative to the workspace root.')
      },
      // Read-only towards the workspace: it rebuilds the index, it writes no files. The hint keeps
      // the tool usable while an agent is in plan mode.
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ sws }) => {
      await session.reload(sws);
      const status = (await session.ensureWorkspace()).status();
      const lines = columns([
        ['workspace', status.workspaceName ?? '(none)'],
        ['sws', status.swsPath ?? '(none)'],
        [
          'index',
          status.indexReady
            ? `${status.indexedFiles} files, ${status.indexedNames} names, ${status.indexedClasses} classes`
            : 'not ready'
        ]
      ]);
      if (status.lastError !== undefined) {
        lines.push('', `error: ${status.lastError}`);
      }
      return { content: [{ type: 'text' as const, text: render(lines) }] };
    }
  );
}

/** Declared so the response shape is part of the contract rather than incidental. */
export const statusOutputShape = {
  cliPath: z.string().optional(),
  workspaceName: z.string().optional(),
  swsPath: z.string().optional(),
  root: z.string().optional(),
  indexReady: z.boolean(),
  candidates: z.array(z.string())
};
