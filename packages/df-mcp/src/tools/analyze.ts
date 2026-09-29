import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { parseSource } from '@vscode-dataflex/parser';
import { readSourceFile } from '@vscode-dataflex/workspace';
import {
  RULES,
  analyze,
  analyzeWorkspace,
  defaultRuleSettings,
  fileSuppression,
  findArgumentCountMismatches,
  findDeadMethods,
  isWorkspaceOwnedFile,
  makeArityResolver,
  overridesAncestor,
  suppressionFor
} from '@vscode-dataflex/langserver/analysis';
import type { RuleSettings } from '@vscode-dataflex/langserver/analysis';
import { DiagnosticSeverity } from 'vscode-languageserver';
import type { Diagnostic } from 'vscode-languageserver';
import type { McpSession } from '../session.js';
import {
  columns,
  narrow,
  oneBased,
  render,
  resolveOutPath,
  toolText,
  workspaceRelative,
  writeJsonl
} from '../render.js';

const RULE_IDS = RULES.map((rule) => rule.id) as [string, ...string[]];

const SEVERITY_NAMES: Record<number, string> = {
  [DiagnosticSeverity.Error]: 'error',
  [DiagnosticSeverity.Warning]: 'warning',
  [DiagnosticSeverity.Information]: 'info',
  [DiagnosticSeverity.Hint]: 'hint'
};

/** One finding, flattened to the shape the JSON Lines report and the text rows both use. */
interface Finding {
  file: string;
  line: number;
  column: number;
  rule: string;
  severity: string;
  message: string;
}

/**
 * Turns an explicit rule list into settings.
 *
 * The list *sets* rather than narrows, matching the language server: asking for a rule by name is
 * a direct request to run it, and treating the list as a filter over already-enabled rules would
 * silently do nothing for the two that ship off -- exactly the ones worth asking for on demand.
 */
function settingsFor(rules: readonly string[] | undefined): RuleSettings {
  const settings = defaultRuleSettings();
  if (rules === undefined) {
    return settings;
  }
  const wanted = new Set(rules);
  for (const key of Object.keys(settings) as (keyof RuleSettings)[]) {
    settings[key] = wanted.has(key);
  }
  return settings;
}

function toFinding(root: string, file: string, diagnostic: Diagnostic): Finding {
  return {
    file: workspaceRelative(root, file),
    line: oneBased(diagnostic.range.start.line),
    column: oneBased(diagnostic.range.start.character),
    rule: String(diagnostic.code ?? 'unknown'),
    severity: SEVERITY_NAMES[diagnostic.severity ?? DiagnosticSeverity.Hint] ?? 'hint',
    message: diagnostic.message
  };
}

function findingRows(findings: readonly Finding[]): string[][] {
  return findings.map((finding) => [
    `${finding.file}:${finding.line}:${finding.column}`,
    finding.rule,
    finding.message
  ]);
}

/** A tool argument may be absolute or workspace-relative; both must reach the same file. */
export function resolveInWorkspace(file: string, root: string): string {
  return isAbsolute(file) ? file : join(root, file);
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = key(item);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function byCount(counts: ReadonlyMap<string, number>): [string, number][] {
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function countRows(counts: readonly [string, number][]): string[][] {
  return counts.map(([name, count]) => [name, count.toLocaleString('en-US')]);
}

export function registerAnalyzeFile(server: McpServer, session: McpSession): void {
  server.registerTool(
    'dataflex_analyze_file',
    {
      title: 'Analyse one DataFlex file',
      description:
        'Runs the static analysis rules over a single file: unused locals and parameters, ' +
        'unreachable code, duplicate declarations, implicit globals, and wrong argument counts at ' +
        'call sites. Honours the same `// df-ignore:<rule>` comments the editor does. Worth calling ' +
        'after editing a file, before building or running anything.',
      inputSchema: {
        file: z
          .string()
          .min(1)
          .describe('Path to the file, absolute or relative to the workspace root.'),
        rules: z
          .array(z.enum(RULE_IDS))
          .optional()
          .describe(
            'Run exactly these rules. An explicit list turns rules on, including the ones that ship off.'
          )
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ file, rules }) => {
      const { index, workspace, refreshed } = await session.ensureIndex();
      const path = resolveInWorkspace(file, workspace.root);
      const text = readSourceFile(path);
      if (text === undefined) {
        return toolText(`Cannot read ${file}.`);
      }

      const settings = settingsFor(rules);
      // The same vocabulary the index was built with, so this parse and the indexed one agree
      // about what a workspace `#COMMAND` verb is.
      const unit = parseSource(text, {
        uri: path,
        knownTypes: index.typeNames,
        knownCommands: index.commandNames
      });
      const diagnostics = analyze(unit, {
        settings,
        severity: DiagnosticSeverity.Hint,
        overridesAncestor: (name, owner) => overridesAncestor(index, name, owner)
      });

      // Needs the index to know what a message name resolves to, which is why it is answered
      // here rather than inside `analyze()`, which sees one file at a time.
      if (settings['argument-count'] === true) {
        const resolve = makeArityResolver(index, (candidate) =>
          isWorkspaceOwnedFile(candidate, workspace.root)
        );
        const silenced = suppressionFor(unit);
        for (const finding of findArgumentCountMismatches(unit, resolve)) {
          if (silenced('argument-count', finding.range)) {
            continue;
          }
          diagnostics.push({
            range: finding.range,
            message: finding.message,
            severity: DiagnosticSeverity.Warning,
            source: 'dataflex',
            code: 'argument-count'
          });
        }
      }

      const suppressed = fileSuppression(unit);
      const findings = diagnostics.map((diagnostic) => toFinding(workspace.root, path, diagnostic));
      const lines = [
        `${workspaceRelative(workspace.root, path)} -- ${findings.length} finding(s)` +
          (suppressed === 'all' ? ' (this file suppresses every rule)' : ''),
        ''
      ];
      lines.push(
        ...(findings.length === 0 ? ['nothing to report.'] : columns(findingRows(findings)))
      );
      return toolText(render(lines), refreshed);
    }
  );
}

export function registerAnalyzeWorkspace(server: McpServer, session: McpSession): void {
  server.registerTool(
    'dataflex_analyze_workspace',
    {
      title: 'Analyse the whole DataFlex workspace',
      description:
        'Runs the analysis rules over every file the workspace owns, excluding its DfPkg ' +
        'dependencies and the runtime library. Answers with counts by rule and by file. Findings ' +
        'run into the thousands on a real codebase, so start with this summary, then pass rule:, ' +
        'file: and limit: to drill into one slice, or out: to write them all to a JSON Lines file ' +
        'you can grep.',
      inputSchema: {
        rules: z
          .array(z.enum(RULE_IDS))
          .optional()
          .describe('Run exactly these rules. Turns rules on, including the two that ship off.'),
        exclude: z.array(z.string()).optional().describe('Glob patterns of files to skip.'),
        rule: z.string().optional().describe('List only findings of this rule.'),
        file: z.string().optional().describe('List only findings in this file.'),
        limit: z
          .number()
          .int()
          .min(0)
          .max(500)
          .default(0)
          .describe('How many findings to list. 0, the default, is the summary alone.'),
        offset: z.number().int().min(0).default(0),
        out: z
          .string()
          .optional()
          .describe('Write every matching finding to this path as JSON Lines, one per line.')
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ rules, exclude, rule, file, limit, offset, out }) => {
      const { index, resolver, workspace, refreshed } = await session.ensureIndex();

      const response = analyzeWorkspace({
        resolver,
        index,
        root: workspace.root,
        settings: settingsFor(rules),
        severity: DiagnosticSeverity.Hint,
        severityOverrides: {},
        exclude: exclude ?? [],
        ...(rules === undefined ? {} : { rules })
      });

      // Filtering happens after the analysis -- it is a whole-workspace pass either way -- but
      // before rendering, which is where the cost that matters to the agent is.
      let findings: Finding[] = response.files.flatMap((analysed) =>
        analysed.diagnostics.map((diagnostic) =>
          toFinding(workspace.root, fileURLToPath(analysed.uri), diagnostic)
        )
      );
      if (rule !== undefined) {
        findings = findings.filter((finding) => finding.rule === rule);
      }
      if (file !== undefined) {
        const wanted = workspaceRelative(
          workspace.root,
          resolveInWorkspace(file, workspace.root)
        ).toLowerCase();
        findings = findings.filter((finding) => finding.file.toLowerCase() === wanted);
      }

      const lines = [
        `files analysed ${response.filesAnalyzed}, skipped ${response.filesSkipped}, ` +
          `findings ${response.findings.toLocaleString('en-US')}` +
          (findings.length === response.findings
            ? ''
            : ` (${findings.length.toLocaleString('en-US')} match the filter)`),
        '',
        'by rule',
        ...columns(countRows(byCount(countBy(findings, (finding) => finding.rule)))),
        '',
        'top files',
        ...columns(countRows(byCount(countBy(findings, (finding) => finding.file)).slice(0, 20))),
        ''
      ];

      if (out !== undefined) {
        const path = resolveOutPath(out, workspace.root);
        writeJsonl(path, findings);
        lines.push(`wrote ${findings.length.toLocaleString('en-US')} finding(s) to ${path}`);
        return toolText(render(lines), refreshed);
      }

      if (limit === 0) {
        lines.push(
          'no findings listed. add rule:"<rule>" limit:50, file:"<path>" limit:50, ' +
            'or out:"<path>" for all of them.'
        );
        return toolText(render(lines), refreshed);
      }

      const page = findings.slice(offset, offset + limit);
      lines.push(`findings ${offset + 1}-${offset + page.length} of ${findings.length}:`);
      lines.push(...columns(findingRows(page)));
      const hint =
        findings.length > offset + page.length ? narrow('rule:', 'file:', 'offset:') : undefined;
      return toolText(render(lines, hint), refreshed);
    }
  );
}

export function registerDeadCode(server: McpServer, session: McpSession): void {
  server.registerTool(
    'dataflex_dead_code',
    {
      title: 'Find unreachable DataFlex procedures',
      description:
        'Methods nothing appears to call, across the whole workspace. Reports how many candidates ' +
        'were spared and why -- an override of an ancestor, published, referenced, or named in a ' +
        'string literal, since DataFlex dispatches dynamically -- and how the findings concentrate ' +
        'by file. That concentration is usually the point: generated wrapper files dominate the ' +
        'raw count, so treat a large number as a question about one file before believing it.',
      inputSchema: {
        file: z.string().optional().describe('List only dead methods in this file.'),
        limit: z.number().int().min(0).max(500).default(0),
        offset: z.number().int().min(0).default(0),
        out: z.string().optional().describe('Write every dead method to this path as JSON Lines.')
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ file, limit, offset, out }) => {
      const { index, workspace, refreshed } = await session.ensureIndex();
      const result = findDeadMethods(index, workspace.root);

      let dead = result.dead.map(({ declaration }) => ({
        name: declaration.name,
        kind: declaration.kind,
        ownerClass: declaration.ownerClass ?? '',
        file: workspaceRelative(workspace.root, declaration.file),
        line: oneBased(declaration.nameRange.start.line)
      }));
      if (file !== undefined) {
        const wanted = workspaceRelative(
          workspace.root,
          resolveInWorkspace(file, workspace.root)
        ).toLowerCase();
        dead = dead.filter((entry) => entry.file.toLowerCase() === wanted);
      }

      const perFile = countBy(dead, (entry) => entry.file);
      const ranked = byCount(perFile);
      const lines = [
        `${result.candidates.toLocaleString('en-US')} candidate(s), ` +
          `${dead.length.toLocaleString('en-US')} dead across ${perFile.size} file(s)`,
        '',
        'spared by',
        ...columns(
          countRows(
            Object.entries(result.sparedBy)
              .filter(([, count]) => count > 0)
              .sort((a, b) => b[1] - a[1])
          )
        ),
        ''
      ];

      const top = ranked.slice(0, 15);
      lines.push('concentration', ...columns(countRows(top)));
      if (dead.length > 0) {
        const inTop = top.reduce((sum, [, count]) => sum + count, 0);
        const thin = [...perFile.values()].filter((count) => count <= 3).length;
        lines.push(
          `the top ${top.length} file(s) hold ${Math.round((inTop / dead.length) * 100)}% of them; ` +
            `${thin} file(s) hold 3 or fewer`
        );
      }
      lines.push('');

      if (out !== undefined) {
        const path = resolveOutPath(out, workspace.root);
        writeJsonl(path, dead);
        lines.push(`wrote ${dead.length.toLocaleString('en-US')} entr(ies) to ${path}`);
        return toolText(render(lines), refreshed);
      }

      if (limit === 0) {
        lines.push('no methods listed. add limit:50, file:"<path>", or out:"<path>".');
        return toolText(render(lines), refreshed);
      }

      const page = dead.slice(offset, offset + limit);
      lines.push(`dead methods ${offset + 1}-${offset + page.length} of ${dead.length}:`);
      lines.push(
        ...columns(
          page.map((entry) => [
            `${entry.file}:${entry.line}`,
            entry.kind,
            entry.ownerClass,
            entry.name
          ])
        )
      );
      const hint = dead.length > offset + page.length ? narrow('file:', 'offset:') : undefined;
      return toolText(render(lines, hint), refreshed);
    }
  );
}
