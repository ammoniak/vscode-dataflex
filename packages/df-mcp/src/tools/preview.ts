import { writeFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { parseSource } from '@vscode-dataflex/parser';
import { readSourceFile } from '@vscode-dataflex/workspace';
import { buildPreviewModel } from '@vscode-dataflex/langserver/preview';
import type { PreviewModel, PreviewObject } from '@vscode-dataflex/langserver/preview';
import type { McpSession } from '../session.js';
import {
  columns,
  oneBased,
  render,
  resolveOutPath,
  toolText,
  workspaceRelative
} from '../render.js';
import { resolveInWorkspace } from './analyze.js';
import { MODE_DESCRIPTION, MODE_NAMES, modeValue } from '@vscode-dataflex/langserver/preview';

/**
 * One row per object in the tree, indented, so the shape survives being flattened to text.
 *
 * The nested JSON is available with detail:"full"; this is the form that answers "what is in this
 * view and what draws it" without spending a thousand tokens on braces.
 */
function outline(object: PreviewObject, classes: Map<number, string>, depth = 0): string[][] {
  const rows: string[][] = [
    [
      // The root the framework builds the tree under carries no name of its own.
      `${'  '.repeat(depth)}${object.sName === '' ? '(app)' : object.sName}`,
      classes.get(object.hClassId) ?? `#${object.hClassId}`,
      String(Object.keys(object.props).length + Object.keys(object.advProps).length)
    ]
  ];
  for (const child of object.aObjs) {
    rows.push(...outline(child, classes, depth + 1));
  }
  return rows;
}

function countObjects(object: PreviewObject): number {
  return 1 + object.aObjs.reduce((sum, child) => sum + countObjects(child), 0);
}

export function registerPreviewModel(server: McpServer, session: McpSession): void {
  server.registerTool(
    'dataflex_preview_model',
    {
      title: 'Model a DataFlex web view',
      description:
        'The control tree a .wo web view would draw: every object, the df.* JavaScript class that ' +
        'renders it, and the property values resolved statically -- `is a cWebForm` resolved to ' +
        'df.WebForm through psJSClass, `Set peLabelAlign to alignRight` resolved to the 2 the ' +
        'framework wants. No build, no server, no DataFlex process. Values that cannot be read ' +
        'from the source are listed as problems rather than guessed at, and there is no data: ' +
        'lists and grids have their real columns and no rows.',
      inputSchema: {
        file: z.string().min(1).describe('Path to the .wo file, absolute or workspace-relative.'),
        detail: z
          .enum(['summary', 'full'])
          .default('summary')
          .describe('"summary" is the object outline; "full" adds the whole JSON definition.'),
        mode: z.enum(MODE_NAMES).optional().describe(MODE_DESCRIPTION),
        out: z.string().optional().describe('Write the full model to this path as JSON.')
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ file, detail, mode, out }) => {
      const { index, workspace, refreshed } = await session.ensureIndex();
      const path = resolveInWorkspace(file, workspace.root);
      const text = readSourceFile(path);
      if (text === undefined) {
        return toolText(`Cannot read ${file}.`);
      }

      const wanted = modeValue(mode);
      const model: PreviewModel = buildPreviewModel(parseSource(text, { uri: path }), index, {
        ...(wanted === undefined ? {} : { mode: wanted })
      });
      const classes = new Map(
        model.definition.aClasses.map((entry) => [entry.hClassId, entry.sType])
      );

      const shown = workspaceRelative(workspace.root, path);
      if (model.view === undefined) {
        const lines = [
          `${shown} -- nothing renderable.`,
          '',
          'A view previews only when it declares a cWebView, or a single custom control that can ' +
            'be hosted in one. Windows views (.vw) have no client-side counterpart at all.'
        ];
        if (model.problems.length > 0) {
          lines.push('', 'problems', ...model.problems.map((problem) => `  ${problem.message}`));
        }
        return toolText(render(lines), refreshed);
      }

      const objects = countObjects(model.definition.obj);
      const lines = [
        `${shown} -- view ${model.view}, ${objects} object(s), ${classes.size} class(es)` +
          (mode === undefined ? ', desktop base layout' : `, laid out for ${mode}`),
        ''
      ];
      lines.push('object', ...columns(outline(model.definition.obj, classes)), '');

      if (model.problems.length > 0) {
        lines.push(
          `${model.problems.length} value(s) could not be read statically and were left at the ` +
            'class default:',
          ...model.problems
            .slice(0, 20)
            .map((problem) => `  ${oneBased(problem.range.start.line)}: ${problem.message}`)
        );
        if (model.problems.length > 20) {
          lines.push(`  ... ${model.problems.length - 20} more`);
        }
        lines.push('');
      }

      if (out !== undefined) {
        const target = resolveOutPath(out, workspace.root);
        writeFileSync(target, JSON.stringify(model, undefined, 2), 'utf8');
        lines.push(`wrote the full model to ${target}`);
        return toolText(render(lines), refreshed);
      }

      if (detail === 'full') {
        return {
          ...toolText(render(lines), refreshed),
          structuredContent: model as unknown as Record<string, unknown>
        };
      }

      lines.push(
        'pass detail:"full" for the property values, or out:"<path>" to write the JSON.' +
          (mode === undefined
            ? ' Pass mode:"tablet" or mode:"mobile" for the responsive layout.'
            : '')
      );
      return toolText(render(lines), refreshed);
    }
  );
}
