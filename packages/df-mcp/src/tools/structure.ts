import { fileURLToPath, pathToFileURL } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseSource } from '@vscode-dataflex/parser';
import { readSourceFile } from '@vscode-dataflex/workspace';
import { definition } from '@vscode-dataflex/langserver/providers';
import type { McpSession } from '../session.js';
import { columns, narrow, oneBased, render, toolText, workspaceRelative } from '../render.js';
import { resolveInWorkspace } from './analyze.js';

export function registerDefinition(server: McpServer, session: McpSession): void {
  server.registerTool(
    'dataflex_definition',
    {
      title: 'Jump to a DataFlex declaration',
      description:
        'Where a name is declared. Give a name on its own, or a file and a position to resolve ' +
        'whatever is under it -- the position form also follows `Use` directives to the resolved ' +
        'package, which is how you find a file that lives in the DfPkg cache rather than the ' +
        'workspace folder.',
      inputSchema: {
        name: z.string().optional().describe('The name to resolve. Omit when giving a position.'),
        file: z.string().optional().describe('File to resolve a position in.'),
        line: z.number().int().min(1).optional().describe('1-based line.'),
        character: z.number().int().min(1).default(1).describe('1-based column.')
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ name, file, line, character }) => {
      const { index, resolver, workspace, refreshed } = await session.ensureIndex();

      if (name !== undefined) {
        const found = index.lookup(name);
        if (found.length === 0) {
          return toolText(`"${name}" is not declared anywhere on the search path.`);
        }
        const rows = found.map((declaration) => [
          `${workspaceRelative(workspace.root, declaration.file)}:${oneBased(declaration.nameRange.start.line)}`,
          declaration.kind,
          declaration.container ?? declaration.ownerClass ?? ''
        ]);
        return toolText(
          render([`${name} -- ${found.length} declaration(s)`, '', ...columns(rows)]),
          refreshed
        );
      }

      if (file === undefined || line === undefined) {
        return toolText('Give either name:, or file: with line:.');
      }
      const path = resolveInWorkspace(file, workspace.root);
      const text = readSourceFile(path);
      if (text === undefined) {
        return toolText(`Cannot read ${file}.`);
      }

      const uri = pathToFileURL(path).toString();
      const document = TextDocument.create(uri, 'dataflex', 1, text);
      const position = { line: line - 1, character: character - 1 };
      const locations = definition(
        parseSource(text, { uri: path }),
        document,
        position,
        resolver,
        index
      );
      if (locations.length === 0) {
        return toolText(`Nothing to go to at ${file}:${line}:${character}.`);
      }

      const rows = locations.map((location) => [
        `${workspaceRelative(workspace.root, safePath(location.uri))}:${oneBased(location.range.start.line)}`
      ]);
      return toolText(render([`${locations.length} definition(s)`, '', ...columns(rows)]), refreshed);
    }
  );
}

export function registerClass(server: McpServer, session: McpSession): void {
  server.registerTool(
    'dataflex_class',
    {
      title: 'Inspect a DataFlex class',
      description:
        'The resolved inheritance chain of a class and the members it has, including everything ' +
        'inherited from ancestors and mixed in. This is the question a DataFlex codebase makes ' +
        'hardest to answer by reading source: a control like cWebForm reaches three hundred ' +
        'members through eight ancestors and four mixins, spread across as many files.',
      inputSchema: {
        name: z.string().min(1).describe('Class name, e.g. "cWebForm".'),
        members: z
          .enum(['own', 'all', 'none'])
          .default('own')
          .describe('"own" lists what the class itself declares, "all" the whole resolved chain.'),
        published: z
          .boolean()
          .optional()
          .describe(
            'Only members carrying a { WebProperty=... } tag, which is all WebSet and WebGet accept.'
          ),
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).default(0)
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ name, members, published, limit, offset }) => {
      const { index, workspace, refreshed } = await session.ensureIndex();
      const record = index.getClass(name);
      if (record === undefined) {
        return toolText(
          `"${name}" is not a class on the search path. ` +
            'Try dataflex_search_symbols, or dataflex_describe if it is not a class.'
        );
      }

      const chain = index.resolveChain(name);
      const lines = [
        `${name} -- declared in ${workspaceRelative(workspace.root, record.file)}`,
        '',
        `chain  ${chain.map((entry) => entry.name).join(' -> ')}`
      ];

      if (members === 'none') {
        return toolText(render(lines), refreshed);
      }

      let resolved = index.membersOf(name);
      if (members === 'own') {
        resolved = resolved.filter(
          (member) => member.declaringClass.toLowerCase() === name.toLowerCase()
        );
      }
      if (published === true) {
        resolved = resolved.filter((member) => member.webProperty !== undefined);
      }

      lines.push(
        `members  ${resolved.length}` +
          (members === 'own' ? ' declared by this class' : ' through the whole chain'),
        ''
      );

      resolved = [...resolved].sort(
        (a, b) => a.inheritanceDepth - b.inheritanceDepth || a.name.localeCompare(b.name)
      );
      const page = resolved.slice(offset, offset + limit);
      lines.push(
        ...columns(
          page.map((member) => [
            member.name,
            member.kind,
            member.type ?? '',
            member.declaringClass,
            member.webProperty === undefined ? '' : `WebProperty=${member.webProperty}`,
            `${workspaceRelative(workspace.root, member.file)}:${oneBased(member.nameRange.start.line)}`
          ])
        )
      );
      const hint =
        resolved.length > offset + page.length
          ? narrow('members:"own"', 'published:true', 'offset:')
          : undefined;
      return toolText(render(lines, hint), refreshed);
    }
  );
}

export function registerTable(server: McpServer, session: McpSession): void {
  server.registerTool(
    'dataflex_table',
    {
      title: 'Inspect the workspace tables',
      description:
        'The tables the workspace defines, from its own .fd files, and the columns of one of them. ' +
        'Answers "what columns does Customer have" and "what is Customer.File_Number", which ' +
        'otherwise means finding and decoding a field-definition file by hand. Column length and ' +
        'SQL type live in the database, not the .fd, so they are reported only where stated.',
      inputSchema: {
        name: z.string().optional().describe('Table name. Omit to list every table.'),
        limit: z.number().int().min(1).max(500).default(100)
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ name, limit }) => {
      const { workspace, tables, refreshed } = await session.ensureIndex();
      if (tables === undefined || tables.size === 0) {
        return toolText('No tables are indexed: this workspace has no readable .fd files.');
      }

      if (name === undefined) {
        const all = tables.all().sort((a, b) => a.name.localeCompare(b.name));
        const page = all.slice(0, limit);
        const lines = [
          `${all.length} table(s)`,
          '',
          ...columns(
            page.map((table) => [
              table.name,
              `#${table.number}`,
              `${table.fields.filter((field) => field.isFileNumber !== true).length} column(s)`,
              workspaceRelative(workspace.root, table.file)
            ])
          )
        ];
        return toolText(render(lines, all.length > page.length ? narrow('name:') : undefined), refreshed);
      }

      const table = tables.table(name);
      if (table === undefined) {
        return toolText(`No table called "${name}" is defined by this workspace.`);
      }

      const fields = table.fields.filter((field) => field.isFileNumber !== true);
      const lines = [
        `${table.name} -- filelist #${table.number}, ${fields.length} column(s)`,
        `from ${workspaceRelative(workspace.root, table.file)}`,
        '',
        ...columns(
          fields.map((field) => [
            String(field.number),
            field.name,
            field.type,
            field.length === undefined ? '' : `length ${field.length}`
          ])
        )
      ];
      return toolText(render(lines), refreshed);
    }
  );
}

function safePath(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
}
