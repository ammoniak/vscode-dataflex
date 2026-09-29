import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // The VS Code integration suite imports the `vscode` module, which only exists inside an
    // extension host. It runs under `vscode-test`, not vitest.
    exclude: ['**/node_modules/**', '**/test/integration/**'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text'],
      /**
       * Floors, not targets. Set just under what the suite achieves today so a drop is caught,
       * without demanding a number that would push tests towards covering lines rather than
       * behaviour.
       */
      thresholds: {
        statements: 85,
        branches: 83,
        functions: 90,
        lines: 85
      },
      // Only the code that ships. Scripts are developer tooling, `out/` is build output, and the
      // generated documentation index is a megabyte of data with no branches to cover.
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        '**/out/**',
        '**/providers/docsIndex.ts',
        // Needs an extension host; covered by the integration suite instead.
        'packages/vscode-dataflex/src/extension.ts',
        'packages/vscode-dataflex/src/tasks.ts',
        'packages/vscode-dataflex/src/statusBar.ts',
        'packages/vscode-dataflex/src/testController.ts',
        'packages/vscode-dataflex/src/client.ts',
        'packages/vscode-dataflex/src/coverage.ts',
        'packages/vscode-dataflex/src/analysisReport.ts',
        // A webview panel: its whole job is generating HTML for a host that only exists inside an
        // extension host. What can be asserted without one -- the model it renders, and finding
        // the workspace's framework -- is tested in df-langserver and df-workspace. Whether the
        // page actually draws is `npm run preview-check`, which no unit test can stand in for.
        'packages/vscode-dataflex/src/preview.ts',
        // Spawns the compiler and the program being profiled, then drives quick picks. What can
        // be asserted without an extension host -- the planning, the overlay, reading a profile
        // back -- lives in `df-coverage` and is tested there.
        'packages/vscode-dataflex/src/profileCommand.ts',
        // Protocol wiring: a connection, a document store and request handlers. Exercised by the
        // integration suite in a real extension host; a unit test here would assert that the
        // handlers are registered, which the compiler already guarantees.
        'packages/df-langserver/src/server.ts',
        'packages/df-langserver/src/workspace.ts',
        'packages/df-langserver/src/protocol.ts',
        // Spawns the compiler and a built program.
        'packages/df-coverage/src/session.ts',
        'packages/df-coverage/src/run.ts',
        // Transport wiring and process launch: a connection over stdio and argv parsing
        // whose failure mode is the client seeing a server that never answers. What can be
        // asserted without a transport -- the tool surface, the gate, the ranking and the
        // token budget -- is tested against an in-memory transport instead.
        'packages/df-mcp/src/main.ts',
        'packages/df-mcp/src/session.ts',
        // Spawn a compiler, a built program, and a headless browser respectively. What can be
        // asserted without them -- the schemas, the summaries and the byte budget -- is covered
        // by the tool tests; that they actually work is `npm run mcp-check` and
        // `npm run preview-check`.
        'packages/df-mcp/src/tools/tests.ts',
        'packages/df-mcp/src/tools/previewRender.ts',
        'packages/df-langserver/src/preview/headless.ts',
        // Barrel files: re-exports only.
        'packages/*/src/index.ts',
        'packages/*/src/*/index.ts'
      ]
    }
  }
});
