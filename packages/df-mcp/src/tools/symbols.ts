import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isWorkspaceOwnedFile } from '@vscode-dataflex/langserver/analysis';
import type { Declaration } from '@vscode-dataflex/workspace';
import type { McpSession } from '../session.js';
import { columns, narrow, oneBased, render, toolText, workspaceRelative } from '../render.js';

export interface RankOptions {
  query: string;
  root: string;
  kind?: string;
  ownOnly?: boolean;
}

/**
 * Orders search results, because the index does not.
 *
 * `SymbolIndex.search` walks its name map and stops at a limit, so what comes back is insertion
 * order with an arbitrary cutoff -- fine for the editor's Ctrl+T, which shows everything and lets
 * a human read, and useless for an agent that will act on the first row. Ranking here rather than
 * in `SymbolIndex` deliberately: the LSP workspace-symbol provider depends on that method staying
 * cheap.
 */
export function rank(declarations: readonly Declaration[], options: RankOptions): Declaration[] {
  const query = options.query.toLowerCase();
  const wanted = options.kind?.toLowerCase();

  const scored = declarations
    .filter((declaration) => wanted === undefined || declaration.kind.toLowerCase() === wanted)
    .filter(
      (declaration) =>
        options.ownOnly !== true || isWorkspaceOwnedFile(declaration.file, options.root)
    )
    .map((declaration) => {
      const name = declaration.name.toLowerCase();
      const match = name === query ? 0 : name.startsWith(query) ? 1 : 2;
      const owned = isWorkspaceOwnedFile(declaration.file, options.root) ? 0 : 1;
      return { declaration, match, owned };
    });

  scored.sort(
    (a, b) =>
      a.match - b.match ||
      a.owned - b.owned ||
      a.declaration.name.length - b.declaration.name.length ||
      a.declaration.name.localeCompare(b.declaration.name) ||
      a.declaration.file.localeCompare(b.declaration.file)
  );
  return scored.map((entry) => entry.declaration);
}

export function registerSearchSymbols(server: McpServer, session: McpSession): void {
  server.registerTool(
    'dataflex_search_symbols',
    {
      title: 'Search DataFlex declarations',
      description:
        'Substring search over every class, procedure, function, property, struct and define the ' +
        'workspace and its dependencies declare -- the whole indexed search path, including the ' +
        'DfPkg package cache and the runtime library. Use this instead of Grep to find where ' +
        'something is declared: it knows the compiler\'s own include path, which a text search of ' +
        'the workspace folder does not.',
      inputSchema: {
        query: z.string().min(1).describe('Substring to match, case-insensitive.'),
        kind: z
          .string()
          .optional()
          .describe('Restrict to one declaration kind, e.g. "class", "procedure", "function".'),
        ownOnly: z
          .boolean()
          .optional()
          .describe('Only declarations in the workspace\'s own source, excluding dependencies.'),
        limit: z.number().int().min(1).max(500).default(50),
        offset: z.number().int().min(0).default(0)
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ query, kind, ownOnly, limit, offset }) => {
      const { index, workspace, refreshed } = await session.ensureIndex();

      // Over-fetch so the local ranking has something to rank. `search`'s own limit is a cutoff
      // in map order, so asking for exactly `limit` would rank an arbitrary slice.
      const pool = index.search(query, Math.max(500, offset + limit * 4));
      const ranked = rank(pool, { query, root: workspace.root, kind, ownOnly });
      const page = ranked.slice(offset, offset + limit);

      if (page.length === 0) {
        return toolText(`No declaration matches "${query}".`);
      }

      const rows = page.map((declaration) => [
        declaration.name,
        declaration.kind,
        declaration.container ?? declaration.ownerClass ?? '',
        `${workspaceRelative(workspace.root, declaration.file)}:${oneBased(declaration.nameRange.start.line)}`
      ]);

      const header = `${ranked.length} match(es) for "${query}", showing ${offset + 1}-${offset + page.length}`;
      const lines = [header, '', ...columns(rows)];
      const hint =
        ranked.length > offset + page.length
          ? narrow('a longer query', 'kind:', 'ownOnly:true', 'offset:')
          : undefined;
      return toolText(render(lines, hint), refreshed);
    }
  );
}
