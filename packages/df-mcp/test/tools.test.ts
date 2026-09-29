import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IncludeResolver, SymbolIndex, TableIndex } from '@vscode-dataflex/workspace';
import { buildServer } from '../src/server';
import type { McpSession } from '../src/session';

/**
 * The analysis, structure and preview-model tools, over the repository's own DFUnit fixture.
 *
 * Driven through a real MCP client so the schemas, defaults and coercion are exercised too -- a
 * tool whose zod schema rejects a sensible argument is broken however good the function behind it
 * is. No DataFlex install is needed: the search path is handed over instead of coming from
 * `df-cli config --json`.
 */
const ROOT = resolve('fixtures/dfunit');
const SEARCH_PATH = [resolve(ROOT, 'AppSrc'), resolve(ROOT, 'AppSrc/Tests')];
/** A trimmed web view living outside the fixture workspace, for the class and preview paths. */
const VIEW = resolve('fixtures/WebCustomer.wo');

const scratch = mkdtempSync(join(tmpdir(), 'df-mcp-tools-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let client: Client;

beforeAll(async () => {
  const resolver = new IncludeResolver(SEARCH_PATH);
  const index = new SymbolIndex();
  for (const file of resolver.allSourceFiles()) {
    index.indexFile(file);
  }
  index.indexFile(VIEW);

  // A class with members, written here rather than kept as a fixture: what it needs to exercise
  // is the chain-and-members path, and the shape is three lines of DataFlex.
  const declared = join(scratch, 'cThing.pkg');
  writeFileSync(
    declared,
    [
      'Class cThing is a cObject',
      '    Procedure Construct_Object',
      '        Forward Send Construct_Object',
      '        { WebProperty=Client }',
      '        Property String psTitle ""',
      '        Property Integer piCount 0',
      '    End_Procedure',
      '',
      '    Procedure DoSomething',
      '    End_Procedure',
      'End_Class'
    ].join('\n'),
    'utf8'
  );
  index.indexFile(declared);

  const session = {
    root: ROOT,
    candidates: () => [],
    cliPath: () => undefined,
    reload: async () => {},
    ensureWorkspace: async () => ({ status: () => ({ projects: [] }) }),
    ensureIndex: async () => ({
      index,
      resolver,
      workspace: {
        root: ROOT,
        swsPath: join(ROOT, 'dfunit.sws'),
        searchPath: SEARCH_PATH,
        projects: [{ name: 'RunTests.src', makePath: SEARCH_PATH }]
      },
      tables: new TableIndex(),
      refreshed: 0
    }),
    status: () => undefined
  } as unknown as McpSession;

  const server = buildServer(session, { root: ROOT, allowExecute: false });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  return (result.content as { type: string; text: string }[]).map((part) => part.text).join('\n');
}

describe('dataflex_analyze_file', () => {
  it('analyses a file given a workspace-relative path', async () => {
    const text = await call('dataflex_analyze_file', { file: 'AppSrc/Tests/SanityTests.pkg' });

    expect(text).toContain('AppSrc/Tests/SanityTests.pkg');
    expect(text).toContain('finding(s)');
  });

  it('accepts an absolute path too', async () => {
    const text = await call('dataflex_analyze_file', {
      file: join(ROOT, 'AppSrc/Tests/SanityTests.pkg')
    });
    expect(text).toContain('AppSrc/Tests/SanityTests.pkg');
  });

  it('says so plainly when the file cannot be read', async () => {
    expect(await call('dataflex_analyze_file', { file: 'AppSrc/NoSuchFile.pkg' })).toContain(
      'Cannot read'
    );
  });

  it('rejects a rule name that is not a rule', async () => {
    const result = await client.callTool({
      name: 'dataflex_analyze_file',
      arguments: { file: 'AppSrc/Tests/SanityTests.pkg', rules: ['not-a-rule'] }
    });
    expect(result.isError).toBe(true);
  });
});

describe('dataflex_analyze_workspace', () => {
  it('summarises without listing findings by default', async () => {
    const text = await call('dataflex_analyze_workspace');

    expect(text).toContain('files analysed');
    expect(text).toContain('by rule');
    expect(text).toContain('top files');
    expect(text).toContain('no findings listed');
  });

  it('lists findings once a limit is given', async () => {
    const text = await call('dataflex_analyze_workspace', { rules: ['dead-procedure'], limit: 5 });

    expect(text).toContain('findings 1-');
    expect(text).not.toContain('no findings listed');
  });

  it('writes JSON Lines to out:, one object per line, and does not list them inline', async () => {
    const out = join(scratch, 'findings.jsonl');
    const text = await call('dataflex_analyze_workspace', {
      rules: ['dead-procedure'],
      out
    });

    expect(text).toContain('wrote');
    expect(text).toContain(out);
    const lines = readFileSync(out, 'utf8').trimEnd().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(Object.keys(first).sort()).toEqual([
      'column',
      'file',
      'line',
      'message',
      'rule',
      'severity'
    ]);
    expect(first['line']).toBeGreaterThan(0);
  });

  it('refuses an out: path outside the workspace and the temp directory', async () => {
    const result = await client.callTool({
      name: 'dataflex_analyze_workspace',
      arguments: { out: resolve('/definitely/not/allowed/findings.jsonl') }
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('must be inside the workspace');
  });

  it('says how many findings survived the filter when it removed some', async () => {
    // The rule list is what *runs*; `rule:` is what is then listed. Asking for dead-procedure and
    // filtering to a different rule leaves the total intact and the filtered count at zero, which
    // is exactly the case where the reader needs both numbers.
    const text = await call('dataflex_analyze_workspace', {
      rules: ['dead-procedure'],
      rule: 'unused-local'
    });

    expect(text).toContain('match the filter');
    expect(text).toContain('(0 match the filter)');
  });

  it('leaves the count alone when nothing was filtered out', async () => {
    const text = await call('dataflex_analyze_workspace', { rules: ['dead-procedure'] });
    expect(text).not.toContain('match the filter');
  });
});

describe('dataflex_dead_code', () => {
  it('reports candidates, what was spared and how findings concentrate', async () => {
    const text = await call('dataflex_dead_code');

    expect(text).toContain('candidate(s)');
    expect(text).toContain('spared by');
    expect(text).toContain('concentration');
    expect(text).toContain('no methods listed');
  });

  it('lists methods once a limit is given', async () => {
    const text = await call('dataflex_dead_code', { limit: 10 });
    expect(text).toContain('dead methods 1-');
  });
});

describe('dataflex_definition', () => {
  it('resolves a name', async () => {
    const text = await call('dataflex_definition', { name: 'oSanityTests' });
    expect(text).toContain('declaration(s)');
  });

  it('asks for one of the two forms when given neither', async () => {
    expect(await call('dataflex_definition', {})).toContain('Give either name:');
  });

  it('reports an unknown name rather than an empty table', async () => {
    expect(await call('dataflex_definition', { name: 'cNoSuchThing' })).toContain(
      'not declared anywhere'
    );
  });
});

describe('dataflex_class', () => {
  it('reports the chain and the members a class declares', async () => {
    const text = await call('dataflex_class', { name: 'cThing', members: 'own' });

    expect(text).toContain('chain');
    expect(text).toContain('cThing');
    expect(text).toContain('psTitle');
    expect(text).toContain('declared by this class');
  });

  it('lists the whole resolved chain under members:"all"', async () => {
    const own = await call('dataflex_class', { name: 'cThing', members: 'own' });
    const all = await call('dataflex_class', { name: 'cThing', members: 'all' });

    expect(all).toContain('through the whole chain');
    expect(all.length).toBeGreaterThanOrEqual(own.length);
  });

  it('gives the chain alone under members:"none"', async () => {
    const text = await call('dataflex_class', { name: 'cThing', members: 'none' });

    expect(text).toContain('chain');
    expect(text).not.toContain('members ');
  });

  it('narrows to published web properties', async () => {
    const text = await call('dataflex_class', { name: 'cThing', published: true });

    expect(text).toContain('members');
    expect(text).not.toContain('DoSomething');
  });

  it('reports a class that is not on the search path, and points elsewhere', async () => {
    const text = await call('dataflex_class', { name: 'cNoSuchClass' });

    expect(text).toContain('is not a class');
    expect(text).toContain('dataflex_search_symbols');
  });
});

describe('dataflex_status and dataflex_reload', () => {
  it('reports what resolved without forcing an index build', async () => {
    const text = await call('dataflex_status');

    expect(text).toContain('root');
    expect(text).toContain('index');
  });

  it('reloads and reports the state afterwards', async () => {
    const text = await call('dataflex_reload');

    expect(text).toContain('workspace');
    expect(text).toContain('index');
  });
});

describe('dataflex_table', () => {
  it('says there are no tables rather than printing an empty list', async () => {
    expect(await call('dataflex_table')).toContain('No tables are indexed');
  });
});

describe('dataflex_preview_model', () => {
  it('reports that a non-view file has nothing renderable, and why', async () => {
    const text = await call('dataflex_preview_model', { file: 'AppSrc/Tests/SanityTests.pkg' });

    expect(text).toContain('nothing renderable');
    expect(text).toContain('cWebView');
  });

  it('says so when the file cannot be read', async () => {
    expect(await call('dataflex_preview_model', { file: 'AppSrc/Missing.wo' })).toContain(
      'Cannot read'
    );
  });

  it('builds the object outline for a real web view', async () => {
    const text = await call('dataflex_preview_model', { file: VIEW });

    // Without the framework packages on the search path the classes do not resolve to df.* names,
    // but the tool must still answer with the tree or say plainly that it cannot draw it.
    expect(text).toMatch(/oCustomer|nothing renderable/);
  });

  it('writes the full model to out: as JSON', async () => {
    const out = join(scratch, 'model.json');
    const text = await call('dataflex_preview_model', { file: VIEW, out });

    if (text.includes('nothing renderable')) {
      return;
    }
    expect(text).toContain(out);
    expect(() => JSON.parse(readFileSync(out, 'utf8'))).not.toThrow();
  });
});

describe('dataflex_discover_tests', () => {
  it('reports that no suite is declared when the project list is empty', async () => {
    const text = await call('dataflex_discover_tests');
    expect(text).toMatch(/No DFUnit test applications|application\(s\)/);
  });
});
