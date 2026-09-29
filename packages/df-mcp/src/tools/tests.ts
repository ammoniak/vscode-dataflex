import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TestDiscovery, coverageTargets } from '@vscode-dataflex/workspace';
import type { TestNode, TestProject } from '@vscode-dataflex/workspace';
import { isWorkspaceOwnedFile, isExcluded } from '@vscode-dataflex/langserver/analysis';
import { runTestProject, toLcov } from '@vscode-dataflex/coverage';
import type { CoverageReport } from '@vscode-dataflex/coverage';
import type { Loaded, McpSession } from '../session.js';
import {
  columns,
  compressRanges,
  narrow,
  oneBased,
  render,
  resolveOutPath,
  toolText,
  workspaceRelative
} from '../render.js';
import { resolveInWorkspace } from './analyze.js';

/**
 * Where the DataFlex-side coverage runtime sits.
 *
 * Beside the bundle when this is the shipped `dist/server.mjs`, and back in `df-coverage` when it
 * is running from source. These are `.pkg` files the compiler reads, not modules -- esbuild will
 * not bundle them, so the bundler copies them instead.
 */
function runtimeDirectory(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const beside = join(here, 'runtime');
  if (existsSync(beside)) {
    return beside;
  }
  return join(here, '..', '..', '..', 'df-coverage', 'runtime');
}

function discover(loaded: Loaded): TestProject[] {
  return new TestDiscovery(loaded.resolver, loaded.index).discoverProjects(loaded.workspace.projects);
}

function pick(projects: readonly TestProject[], wanted: string | undefined): TestProject | undefined {
  if (wanted === undefined) {
    return projects[0];
  }
  return projects.find((project) => project.project.toLowerCase() === wanted.toLowerCase());
}

function countNodes(nodes: readonly TestNode[], kind: TestNode['kind']): number {
  return nodes.reduce(
    (sum, node) => sum + (node.kind === kind ? 1 : 0) + countNodes(node.children, kind),
    0
  );
}

function treeRows(nodes: readonly TestNode[], depth = 0): string[][] {
  return nodes.flatMap((node) => [
    [`${'  '.repeat(depth)}${node.reportedName}`, node.kind],
    ...treeRows(node.children, depth + 1)
  ]);
}

export function registerDiscoverTests(server: McpServer, session: McpSession): void {
  server.registerTool(
    'dataflex_discover_tests',
    {
      title: 'Discover DFUnit tests',
      description:
        'The DFUnit suites this workspace declares, found by reading the object tree rather than ' +
        'by compiling -- so it costs nothing and works on a workspace that does not currently ' +
        'build. Names are reported as DFUnit itself would report them, which is how results map ' +
        'back to source.',
      inputSchema: {
        project: z.string().optional().describe('Limit to one test project, e.g. "UnitTest.src".'),
        detail: z
          .enum(['counts', 'full'])
          .default('counts')
          .describe('"full" lists the fixture and test tree.')
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ project, detail }) => {
      const loaded = await session.ensureIndex();
      const projects = discover(loaded);
      if (projects.length === 0) {
        return toolText('No DFUnit test applications are declared in this workspace.');
      }

      const wanted = project === undefined ? projects : projects.filter((p) => p.project === project);
      if (wanted.length === 0) {
        return toolText(
          `No test project named ${project}. Found: ${projects.map((p) => p.project).join(', ')}`
        );
      }

      const lines: string[] = [];
      for (const found of wanted) {
        lines.push(
          `${found.project} -- ${workspaceRelative(loaded.workspace.root, found.file)}`,
          `  ${found.applications.length} application(s), ` +
            `${countNodes(found.applications, 'fixture')} fixture(s), ` +
            `${countNodes(found.applications, 'test')} test(s)`
        );
        if (detail === 'full') {
          lines.push(...columns(treeRows(found.applications, 1)));
        }
        lines.push('');
      }
      if (detail === 'counts') {
        lines.push('pass detail:"full" for the fixture and test tree.');
      }
      return toolText(render(lines), loaded.refreshed);
    }
  );
}

export function registerCoverageTargets(server: McpServer, session: McpSession): void {
  server.registerTool(
    'dataflex_coverage_targets',
    {
      title: 'What a coverage run would instrument',
      description:
        'The files a coverage run would rewrite with probes: everything the test program reaches ' +
        'through Use directives that the workspace itself owns. Worth checking before running ' +
        'coverage, which compiles and executes -- this costs nothing and tells you the size of ' +
        'what you are about to ask for.',
      inputSchema: {
        project: z.string().optional().describe('Test project; defaults to the first discovered.'),
        exclude: z.array(z.string()).optional().describe('Glob patterns to leave uninstrumented.'),
        limit: z.number().int().min(0).max(500).default(50)
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ project, exclude, limit }) => {
      const loaded = await session.ensureIndex();
      const found = pick(discover(loaded), project);
      if (found === undefined) {
        return toolText(
          project === undefined
            ? 'No DFUnit test applications are declared in this workspace.'
            : `No test project named ${project}.`
        );
      }

      const patterns = exclude ?? [];
      const all = coverageTargets({
        entry: found.file,
        resolver: loaded.resolver,
        searchPath: loaded.workspace.searchPath,
        root: loaded.workspace.root,
        isOwned: isWorkspaceOwnedFile,
        isExcluded: (file) => isExcluded(file, patterns)
      });

      const lines = [
        `${found.project} -- ${all.length} file(s) would be instrumented`,
        '',
        ...columns(
          all
            .slice(0, limit)
            .map((target) => [workspaceRelative(loaded.workspace.root, target.file)])
        )
      ];
      return toolText(
        render(lines, all.length > limit ? narrow('exclude:', 'a larger limit:') : undefined),
        loaded.refreshed
      );
    }
  );
}

/** The per-file coverage table, worst ratio first, with no line data at all. */
function coverageRows(report: CoverageReport, root: string): string[][] {
  return [...report.files]
    .sort((a, b) => a.covered / a.total - b.covered / b.total)
    .slice(0, 20)
    .map((file) => [
      `${file.total === 0 ? 0 : Math.round((file.covered / file.total) * 100)}%`,
      `${file.covered}/${file.total}`,
      `${file.missed.length} missed`,
      workspaceRelative(root, file.file)
    ]);
}

export function registerRunTests(server: McpServer, session: McpSession): void {
  server.registerTool(
    'dataflex_run_tests',
    {
      title: 'Run the DFUnit suite',
      description:
        "Compiles the project with df-cli and runs the resulting executable, then reports which " +
        'tests passed. With coverage:true it additionally writes an instrumented program, named ' +
        'apart from your own build, into the workspace Programs directory and deletes it (and its ' +
        '.dbg) when the run finishes -- your own build artifacts are never touched. A run that ' +
        'hangs on a modal dialog is killed after timeoutSeconds. This takes minutes, not seconds.',
      inputSchema: {
        project: z.string().optional().describe('Test project; defaults to the first discovered.'),
        coverage: z.boolean().default(false).describe('Also measure line coverage.'),
        exclude: z.array(z.string()).optional().describe('Glob patterns to leave uninstrumented.'),
        timeoutSeconds: z.number().int().min(10).max(3600).default(300),
        file: z
          .string()
          .optional()
          .describe('Report the missed lines of this one file, as ranges.'),
        out: z.string().optional().describe('Write the coverage report to this path as LCOV.')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    async ({ project, coverage, exclude, timeoutSeconds, file, out }) => {
      const loaded = await session.ensureIndex();
      const found = pick(discover(loaded), project);
      if (found === undefined) {
        return toolText(
          project === undefined
            ? 'No DFUnit test applications are declared in this workspace.'
            : `No test project named ${project}.`
        );
      }
      const application = found.applications[0];
      if (application === undefined) {
        return toolText(`${found.project} declares no test application object.`);
      }
      const cliPath = session.cliPath();
      if (cliPath === undefined) {
        return toolText('df-cli.exe was not found, and building needs it.');
      }

      const patterns = exclude ?? [];
      const scratch = mkdtempSync(join(tmpdir(), 'df-mcp-tests-'));
      try {
        const result = await runTestProject({
          cliPath,
          swsPath: loaded.workspace.swsPath,
          workspaceRoot: loaded.workspace.root,
          project: found,
          scratch,
          timeoutSeconds,
          ...(coverage
            ? {
                coverage: {
                  targets: coverageTargets({
                    entry: found.file,
                    resolver: loaded.resolver,
                    searchPath: loaded.workspace.searchPath,
                    root: loaded.workspace.root,
                    isOwned: isWorkspaceOwnedFile,
                    isExcluded: (candidate) => isExcluded(candidate, patterns)
                  }),
                  runtimeDirectory: runtimeDirectory(),
                  applicationLine: application.range.start.line,
                  flushBeforeLine: application.range.end.line
                }
              }
            : {})
        });

        if (result.buildExitCode !== 0) {
          return toolText(
            render([
              `${found.project} did not build (exit ${result.buildExitCode}).`,
              '',
              result.buildOutput.slice(-4000)
            ])
          );
        }
        if (result.executable === undefined) {
          return toolText(`${found.project} built, but no executable appeared in Programs.`);
        }

        const cases = result.results?.cases ?? [];
        const failed = cases.filter((entry) => entry.status !== 'passed');
        const lines = [
          `${found.project} -- ${cases.length} test(s), ${cases.length - failed.length} passed, ` +
            `${failed.length} not passed` +
            (result.timedOut ? `, KILLED after ${timeoutSeconds}s` : ''),
          ''
        ];

        if (result.results === undefined) {
          lines.push(
            `The program exited with code ${result.exitCode} without writing a report. DFUnit only`,
            'writes results once the test application starts, so this usually means the program',
            'failed first -- a missing workspace configuration, a database login prompt, or an',
            'error dialog.',
            '',
            result.output.slice(-2000)
          );
          return toolText(render(lines));
        }

        if (failed.length > 0) {
          lines.push(
            'not passed',
            ...columns(
              failed
                .slice(0, 20)
                .map((entry) => [
                  [...entry.suitePath, entry.name].join('/'),
                  entry.status,
                  (entry.message ?? '').replace(/\s+/g, ' ').slice(0, 120)
                ])
            ),
            ''
          );
        }

        if (coverage) {
          if (result.coverage === undefined) {
            // Not the same as zero: a run that never reached its flush wrote nothing at all.
            lines.push(
              result.timedOut
                ? `The run was killed after ${timeoutSeconds}s, so there is no coverage data.`
                : 'The run wrote no counts, so there is no coverage data. DFUnit exits through',
              'Win32 ExitProcess, so a suite that dies before its flush produces no data rather',
              'than partial data.'
            );
          } else {
            const report = result.coverage;
            lines.push(
              `coverage  ${report.covered}/${report.total} probes hit ` +
                `(${(report.ratio * 100).toFixed(1)}%) across ${report.files.length} file(s)`,
              '',
              ...columns(coverageRows(report, loaded.workspace.root))
            );

            if (file !== undefined) {
              const wanted = resolveInWorkspace(file, loaded.workspace.root).toLowerCase();
              const one = report.files.find((entry) => entry.file.toLowerCase() === wanted);
              lines.push(
                '',
                one === undefined
                  ? `${file} was not instrumented, so it has no coverage.`
                  : `${workspaceRelative(loaded.workspace.root, one.file)} missed lines: ` +
                    compressRanges(one.missed.map(oneBased))
              );
            }

            if (out !== undefined) {
              const target = resolveOutPath(out, loaded.workspace.root);
              writeFileSync(target, toLcov(report), 'utf8');
              lines.push('', `wrote LCOV to ${target}`);
            } else if (file === undefined) {
              lines.push('', 'pass file:"<path>" for missed lines, or out:"<path>.lcov" for all.');
            }
          }
        }

        return toolText(render(lines));
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  );
}
