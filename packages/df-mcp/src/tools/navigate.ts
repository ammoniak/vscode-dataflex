import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isWorkspaceOwnedFile } from '@vscode-dataflex/langserver/analysis';
import { declarationHover, factsFor, references } from '@vscode-dataflex/langserver/providers';
import { readSourceFile } from '@vscode-dataflex/workspace';
import type { McpSession } from '../session.js';
import { columns, narrow, oneBased, render, toolText, workspaceRelative } from '../render.js';

export function registerDescribe(server: McpServer, session: McpSession): void {
  server.registerTool(
    'dataflex_describe',
    {
      title: 'Describe a DataFlex symbol',
      description:
        'Everything the editor would show on hover for a name: the declaration, its class chain, ' +
        'the table a data dictionary manages, a constant\'s value and the Enum_List it belongs to, ' +
        'call syntax, and how widely it is used. Prefer this over reading the declaring file -- it ' +
        'resolves inheritance and constant aliases, which reading one file does not.',
      inputSchema: {
        name: z.string().min(1).describe('The exact declaration name, e.g. "cWebForm", "psCaption".'),
        context: z
          .enum(['class', 'member', 'any'])
          .default('any')
          .describe('Disambiguate when a name is declared as both a class and a member.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(3)
          .describe('How many declarations of the name to describe when it is declared more than once.')
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ name, context, limit }) => {
      const { index, workspace, tables, refreshed } = await session.ensureIndex();
      const found = index.lookup(name, context);
      if (found.length === 0) {
        return toolText(
          `"${name}" is not declared anywhere on the search path. ` +
            'Try dataflex_search_symbols for a substring match.'
        );
      }

      const declarations = index.declarationCount(name);
      const uses = Math.max(0, index.referenceCount(name) - declarations);
      const lines: string[] = [
        `${name} -- ${declarations} declaration(s), ${uses} use(s)` +
          (index.appearsInLiteral(name) ? ', and it appears in a string literal' : ''),
        ''
      ];

      for (const declaration of found.slice(0, limit)) {
        lines.push(
          `--- ${workspaceRelative(workspace.root, declaration.file)}:${oneBased(declaration.nameRange.start.line)} ---`
        );
        lines.push(
          declarationHover(factsFor(declaration, index, { root: workspace.root, tables })).trimEnd()
        );
        lines.push('');
      }

      const hint =
        found.length > limit
          ? `... ${found.length - limit} further declaration(s). Raise limit: to see them.`
          : undefined;
      return toolText(render(lines, hint), refreshed);
    }
  );
}

export function registerReferences(server: McpServer, session: McpSession): void {
  server.registerTool(
    'dataflex_references',
    {
      title: 'Find references to a DataFlex symbol',
      description:
        'Where a name is used across the whole indexed search path. Answers with a count and a ' +
        'per-file histogram first, then locations. Call this before deleting or renaming anything ' +
        '-- DataFlex dispatches dynamically, so it also reports whether the name appears in a ' +
        'string literal, which a call-graph search would miss.',
      inputSchema: {
        name: z.string().min(1),
        includeDeclaration: z.boolean().default(false),
        limit: z
          .number()
          .int()
          .min(0)
          .max(200)
          .default(20)
          .describe('How many individual locations to list. 0 for the summary alone.'),
        offset: z.number().int().min(0).default(0)
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ name, includeDeclaration, limit, offset }) => {
      const { index, workspace, refreshed } = await session.ensureIndex();

      // The summary comes from the index's own counters, which never build the location list.
      // On a name like `Refresh` that is the difference between a table and thousands of objects.
      const total = index.referenceCount(name);
      if (total === 0) {
        return toolText(`"${name}" is not referenced anywhere on the search path.`);
      }
      const files = index.filesReferencing(name);
      const lines: string[] = [
        `${name} -- ${total} occurrence(s) in ${files.length} file(s)` +
          (index.appearsInLiteral(name) ? '; it also appears in a string literal' : ''),
        ''
      ];

      // The workspace's own files first: those are the ones the agent can change. Alphabetical
      // order would put a truncated list at the mercy of whatever the runtime library is called.
      const histogram = files
        .map((file) => ({ shown: workspaceRelative(workspace.root, file), own: isWorkspaceOwnedFile(file, workspace.root) }))
        .sort((a, b) => Number(b.own) - Number(a.own) || a.shown.localeCompare(b.shown))
        .slice(0, 30)
        .map((entry) => [entry.shown]);
      lines.push(...columns(histogram));
      if (files.length > histogram.length) {
        lines.push(`... ${files.length - histogram.length} further file(s)`);
      }

      if (limit > 0) {
        const found = references(index, name, { includeDeclaration, readFile: readSourceFile });
        const page = found.slice(offset, offset + limit);
        lines.push('', `locations ${offset + 1}-${offset + page.length} of ${found.length}:`);
        const sources = new Map<string, string[] | undefined>();
        const rows = page.map((location) => {
          const path = toPath(location.uri);
          if (!sources.has(path)) {
            sources.set(path, readSourceFile(path)?.split(/\r?\n/));
          }
          const line = sources.get(path)?.[location.range.start.line]?.trim() ?? '';
          return [
            `${workspaceRelative(workspace.root, path)}:${oneBased(location.range.start.line)}`,
            line.length > 100 ? `${line.slice(0, 100)}...` : line
          ];
        });
        lines.push(...columns(rows));
        const hint =
          found.length > offset + page.length ? narrow('offset:', 'a smaller limit:') : undefined;
        return toolText(render(lines, hint), refreshed);
      }

      lines.push('', 'pass limit: to list individual locations.');
      return toolText(render(lines), refreshed);
    }
  );
}

function toPath(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
}
