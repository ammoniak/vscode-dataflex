import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server';
import type { McpSession } from '../src/session';

/**
 * A session that answers without a DataFlex install.
 *
 * The point of these tests is the protocol surface -- which tools exist, what they are called,
 * what the gate does -- and none of that needs df-cli, a workspace or an index.
 */
function stubSession(): McpSession {
  const zero = { line: 0, character: 0 };
  const declaration = {
    name: 'cWebForm',
    kind: 'class',
    file: '/ws/MyApp/AppSrc/cWebForm.pkg',
    range: { start: zero, end: zero },
    nameRange: { start: zero, end: zero }
  };
  const index = {
    search: () => [declaration],
    lookup: () => [declaration],
    declarationCount: () => 1,
    referenceCount: () => 7,
    appearsInLiteral: () => false,
    filesReferencing: () => ['/ws/MyApp/AppSrc/Customer.wo']
  };
  return {
    root: '/ws/MyApp',
    candidates: () => ['/ws/MyApp/MyApp.sws'],
    ensureWorkspace: async () => ({
      status: () => ({
        cliPath: '/df/df-cli.exe',
        workspaceName: 'MyApp',
        swsPath: '/ws/MyApp/MyApp.sws',
        root: '/ws/MyApp',
        projects: [{ name: 'MyApp.src', searchPathCount: 46 }],
        dependencyCount: 2,
        searchPathCount: 46,
        loadedSuccessfully: true,
        indexedFiles: 910,
        indexedNames: 25179,
        indexedClasses: 1200,
        indexReady: true
      })
    }),
    ensureIndex: async () => ({
      index,
      resolver: {},
      workspace: { root: '/ws/MyApp' },
      tables: undefined,
      refreshed: 0
    }),
    cliPath: () => undefined,
    reload: async () => {},
    status: () => undefined
  } as unknown as McpSession;
}

async function connect(allowExecute: boolean): Promise<Client> {
  const server = buildServer(stubSession(), { root: '/ws/MyApp', allowExecute });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

afterEach(() => vi.restoreAllMocks());

describe('tool surface', () => {
  it('registers exactly the read-only tools by default', async () => {
    const client = await connect(false);
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();

    expect(names).toEqual([
      'dataflex_analyze_file',
      'dataflex_analyze_workspace',
      'dataflex_class',
      'dataflex_coverage_targets',
      'dataflex_dead_code',
      'dataflex_definition',
      'dataflex_describe',
      'dataflex_discover_tests',
      'dataflex_preview_model',
      'dataflex_references',
      'dataflex_reload',
      'dataflex_search_symbols',
      'dataflex_status',
      'dataflex_table'
    ]);
  });

  it('marks every default tool closed-world, and all but reload read-only', async () => {
    const client = await connect(false);
    const tools = (await client.listTools()).tools;

    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      // Nothing here touches the network.
      expect(tool.annotations?.openWorldHint, tool.name).toBe(false);
      if (tool.name === 'dataflex_reload') {
        // It changes this process's state and nothing on disk.
        expect(tool.annotations?.readOnlyHint).toBe(false);
        expect(tool.annotations?.destructiveHint).toBe(false);
        expect(tool.annotations?.idempotentHint).toBe(true);
        continue;
      }
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
    }
  });

  it('describes every tool, since the description is what the agent chooses on', async () => {
    const client = await connect(false);
    for (const tool of (await client.listTools()).tools) {
      expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(40);
    }
  });

  it('adds the executing tools only when execution is allowed', async () => {
    const gated = (await (await connect(true)).listTools()).tools.map((tool) => tool.name);
    const plain = (await (await connect(false)).listTools()).tools.map((tool) => tool.name);

    // Not hidden -- not registered. A default registration cannot be talked into running a
    // compiler or a browser, because the model is never told those tools exist.
    expect(gated.filter((name) => !plain.includes(name)).sort()).toEqual([
      'dataflex_preview_render',
      'dataflex_run_tests'
    ]);
    for (const name of ['dataflex_preview_render', 'dataflex_run_tests']) {
      expect(plain).not.toContain(name);
    }
  });

  it('marks the executing tools as neither read-only nor safe', async () => {
    const tools = (await (await connect(true)).listTools()).tools;
    const executing = tools.filter((tool) => tool.annotations?.destructiveHint === true);

    expect(executing.map((tool) => tool.name).sort()).toEqual([
      'dataflex_preview_render',
      'dataflex_run_tests'
    ]);
    for (const tool of executing) {
      expect(tool.annotations?.readOnlyHint, tool.name).not.toBe(true);
    }
  });
});

describe('tool calls', () => {
  it('answers dataflex_status with text and a structured payload', async () => {
    const client = await connect(false);
    const result = await client.callTool({ name: 'dataflex_status', arguments: {} });

    const text = (result.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain('MyApp');
    expect(text).toContain('910 files');
    expect((result.structuredContent as { candidates: string[] }).candidates).toHaveLength(1);
  });

  it('answers dataflex_search_symbols with ranked rows', async () => {
    const client = await connect(false);
    const result = await client.callTool({
      name: 'dataflex_search_symbols',
      arguments: { query: 'cWebForm' }
    });

    const text = (result.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain('cWebForm');
    expect(text).toContain('AppSrc/cWebForm.pkg');
  });

  it('summarises dataflex_references without listing locations by default', async () => {
    const client = await connect(false);
    const result = await client.callTool({
      name: 'dataflex_references',
      arguments: { name: 'cWebForm', limit: 0 }
    });

    const text = (result.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain('7 occurrence(s) in 1 file(s)');
    expect(text).toContain('pass limit:');
  });

  it('reports a failed load as a tool error rather than crashing the server', async () => {
    const session = stubSession();
    vi.spyOn(session, 'ensureIndex').mockRejectedValue(new Error('df-cli.exe not found.'));
    const server = buildServer(session, { root: '/ws/MyApp', allowExecute: false });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

    const result = await client.callTool({
      name: 'dataflex_search_symbols',
      arguments: { query: 'x' }
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('df-cli.exe not found.');
  });
});
