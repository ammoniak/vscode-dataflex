import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { SymbolIndex } from '@vscode-dataflex/workspace';
import { buildServer } from '../src/server';
import type { McpSession } from '../src/session';

/**
 * Driven against a real `SymbolIndex` over the repository's own fixtures.
 *
 * The stub in `protocol.test.ts` proves the wiring; this proves the answers, because hover facts,
 * the class chain and the reference counts all come from the index rather than from the tool.
 * Neither needs df-cli: the index is fed files directly, skipping workspace resolution.
 */
const ROOT = resolve('fixtures/dfunit');
const FILES = [resolve(ROOT, 'AppSrc/RunTests.src'), resolve(ROOT, 'AppSrc/Tests/SanityTests.pkg')];

let client: Client;

beforeAll(async () => {
  const index = new SymbolIndex();
  for (const file of FILES) {
    index.indexFile(file);
  }

  const session = {
    root: ROOT,
    candidates: () => [],
    ensureWorkspace: async () => ({ status: () => ({ projects: [] }) }),
    ensureIndex: async () => ({
      index,
      resolver: {},
      workspace: { root: ROOT },
      tables: undefined,
      refreshed: 2
    }),
    status: () => undefined
  } as unknown as McpSession;

  const server = buildServer(session, { root: ROOT, allowExecute: false });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  return (result.content as { type: string; text: string }[]).map((part) => part.text).join('\n');
}

describe('dataflex_describe', () => {
  it('renders the hover for something the fixtures declare', async () => {
    const declared = new SymbolIndex();
    for (const file of FILES) {
      declared.indexFile(file);
    }
    const name = declared.allDeclarations()[0]!.name;

    const text = await call('dataflex_describe', { name });

    expect(text).toContain(name);
    expect(text).toContain('declaration(s)');
    // A root-relative path, not the absolute one the index holds.
    expect(text).toContain('AppSrc/');
    expect(text).not.toContain(ROOT);
  });

  it('says so plainly when the name is not declared, and points at the search tool', async () => {
    const text = await call('dataflex_describe', { name: 'cNoSuchThingAnywhere' });

    expect(text).toContain('not declared anywhere');
    expect(text).toContain('dataflex_search_symbols');
  });

  it('notes files re-indexed since the last call', async () => {
    expect(await call('dataflex_describe', { name: 'cNoSuchThingAnywhere' })).not.toContain(
      're-indexed'
    );
    const text = await call('dataflex_search_symbols', { query: 'Test' });
    expect(text).toContain('2 file(s) re-indexed');
  });
});

describe('dataflex_references', () => {
  it('reports nothing referenced rather than an empty table', async () => {
    const text = await call('dataflex_references', { name: 'cNoSuchThingAnywhere' });

    expect(text).toContain('is not referenced anywhere');
  });

  it('lists locations with their source line once a limit is given', async () => {
    const index = new SymbolIndex();
    for (const file of FILES) {
      index.indexFile(file);
    }
    const name = index
      .allDeclarations()
      .map((declaration) => declaration.name)
      .find((candidate) => index.referenceCount(candidate) > 1)!;

    const summary = await call('dataflex_references', { name, limit: 0 });
    // includeDeclaration, because in this fixture every occurrence of a repeated name *is*
    // a declaration -- two `Procedure Test` in one file -- so excluding them lists nothing.
    const listed = await call('dataflex_references', { name, limit: 20, includeDeclaration: true });

    expect(summary).toContain('occurrence(s) in');
    expect(summary).toContain('pass limit:');
    expect(summary).not.toContain('locations 1-');

    // The locations section is the difference: a `file:line` row per occurrence, each with the
    // source line beside it, which is the whole point of asking for locations at all.
    expect(listed).toContain('locations 1-');
    expect(listed).toMatch(/AppSrc\/\S+:\d+/);
  });
});

describe('dataflex_search_symbols', () => {
  it('finds a fixture declaration and shows a root-relative location', async () => {
    const text = await call('dataflex_search_symbols', { query: 'Test' });

    expect(text).toContain('match(es) for "Test"');
    expect(text).toMatch(/AppSrc\/\S+:\d+/);
  });

  it('reports no match rather than an empty table', async () => {
    expect(await call('dataflex_search_symbols', { query: 'zzzznothing' })).toContain(
      'No declaration matches'
    );
  });
});
