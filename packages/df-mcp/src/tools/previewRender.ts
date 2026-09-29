import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { parseSource } from '@vscode-dataflex/parser';
import { findWebAssets, readSourceFile } from '@vscode-dataflex/workspace';
import {
  MODE_DESCRIPTION,
  MODE_NAMES,
  buildPreviewModel,
  failures,
  findBrowser,
  modeValue,
  renderOnce,
  viewportFor
} from '@vscode-dataflex/langserver/preview';
import type { McpSession } from '../session.js';
import { render, toolText, workspaceRelative } from '../render.js';
import { resolveInWorkspace } from './analyze.js';

/**
 * Where the extension's preview bootstrap is, whichever way this server was started.
 *
 * Beside the bundle when it is the shipped `dist/server.mjs`, and back in the repository when it
 * is running from source under tsx or vitest. Copied rather than bundled because the page loads
 * it by URL: it is not a module this code imports.
 */
function bootstrapPath(): string {
  const beside = join(dirname(fileURLToPath(import.meta.url)), 'preview', 'bootstrap.js');
  if (existsSync(beside)) {
    return beside;
  }
  return join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'vscode-dataflex',
    'media',
    'preview',
    'bootstrap.js'
  );
}

export function registerPreviewRender(server: McpServer, session: McpSession): void {
  server.registerTool(
    'dataflex_preview_render',
    {
      title: 'Draw a DataFlex web view',
      description:
        'Renders a .wo in a headless browser using the workspace\'s own copy of the DataFlex web ' +
        'framework, and returns a screenshot plus the page\'s self-check. This is what the view ' +
        'actually looks like, not a description of it. Needs Chrome or Edge installed. There is ' +
        'still no data -- lists and grids draw their real columns and no rows, because rows come ' +
        'from a server that is not running.',
      inputSchema: {
        file: z.string().min(1).describe('Path to the .wo file, absolute or workspace-relative.'),
        theme: z.string().optional().describe('Theme folder name; defaults to the workspace theme.'),
        mode: z.enum(MODE_NAMES).optional().describe(MODE_DESCRIPTION),
        screenshot: z
          .boolean()
          .default(true)
          .describe('Return a PNG of the drawn view. Turn off for the text report alone.'),
        width: z
          .number()
          .int()
          .min(320)
          .max(3840)
          .optional()
          .describe('Viewport width. Defaults to something the chosen mode would run at.'),
        height: z.number().int().min(240).max(2160).optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    async ({ file, theme, mode, screenshot, width, height }) => {
      const { index, workspace, refreshed } = await session.ensureIndex();
      const path = resolveInWorkspace(file, workspace.root);
      const text = readSourceFile(path);
      if (text === undefined) {
        return toolText(`Cannot read ${file}.`);
      }

      const browserPath = findBrowser();
      if (browserPath === undefined) {
        return toolText(
          'No Chrome or Edge found, and rendering needs one. dataflex_preview_model gives the ' +
            'control tree without a browser.'
        );
      }

      const assets = findWebAssets(workspace.root);
      if (assets === undefined) {
        return toolText(
          `No AppHtml with the DataFlex web framework under ${workspace.root}, so there is ` +
            'nothing to draw the view with.'
        );
      }

      const wanted = modeValue(mode);
      const model = buildPreviewModel(parseSource(text, { uri: path }), index, {
        ...(wanted === undefined ? {} : { mode: wanted })
      });
      if (model.view === undefined) {
        return toolText(
          `${workspaceRelative(workspace.root, path)} has nothing renderable. ` +
            'Only a cWebView, or a single custom control that can be hosted in one, draws.'
        );
      }

      const shotDir = screenshot ? mkdtempSync(join(tmpdir(), 'df-mcp-shot-')) : undefined;
      const rendered = renderOnce(model, assets, {
        bootstrapPath: bootstrapPath(),
        browserPath,
        ...(theme === undefined ? {} : { theme }),
        ...(shotDir === undefined ? {} : { screenshotPath: join(shotDir, 'preview.png') }),
        windowSize: {
          width: width ?? viewportFor(mode).width,
          height: height ?? viewportFor(mode).height
        }
      });

      const broke = failures(rendered.report);
      const lines = [
        `${workspaceRelative(workspace.root, path)} -- view ${model.view}` +
          (mode === undefined ? '' : `, laid out for ${mode}`) +
          (broke.length === 0 ? '' : `, FAILED: ${broke.join('; ')}`),
        '',
        rendered.report.length > 0
          ? rendered.report
          : '(the page produced no report -- it did not run)'
      ];

      const body = toolText(render(lines), refreshed);
      if (rendered.screenshot === undefined) {
        return body;
      }
      return {
        content: [
          ...body.content,
          {
            type: 'image' as const,
            data: readFileSync(rendered.screenshot).toString('base64'),
            mimeType: 'image/png'
          }
        ]
      };
    }
  );
}
