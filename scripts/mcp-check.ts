/**
 * Drives the MCP server as a real child process against a real workspace.
 *
 * The unit tests prove the tool surface against a stub; this proves the answers, and above all
 * their *size*. Every default response has to fit the budget the whole design rests on -- an agent
 * that spends its context on one call has nothing left to think with -- and a budget nothing
 * checks is a budget that rots. So the sizes are printed and the check fails if any default
 * response exceeds MAX_BYTES.
 *
 * Needs a DataFlex installation and one of the two example workspaces, so it is not part of
 * `npm test`, exactly like `preview-check` and `debug-host-check`.
 *
 * Usage: npm run mcp-check -- [workspace] [--verbose]
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MAX_BYTES } from '../packages/df-mcp/src/render';

const CANDIDATES = ['C:/DataFlex 26.0 Examples/WebOrder'];
const SERVER = join(__dirname, '..', 'packages', 'df-mcp', 'dist', 'server.mjs');

interface Call {
  name: string;
  args: Record<string, unknown>;
  /** A response that is meant to be large, so the ceiling is the only assertion. */
  expect?: (text: string) => string | undefined;
}

const CALLS: Call[] = [
  {
    name: 'dataflex_status',
    args: {},
    expect: (text) => (text.includes('index') ? undefined : 'no index line')
  },
  {
    name: 'dataflex_search_symbols',
    args: { query: 'cWebForm' },
    expect: (text) => (text.includes('cWebForm') ? undefined : 'did not find cWebForm')
  },
  { name: 'dataflex_search_symbols', args: { query: 'e', limit: 200 } },
  {
    name: 'dataflex_describe',
    args: { name: 'cWebForm' },
    expect: (text) => (text.includes('declaration(s)') ? undefined : 'no declaration count')
  },
  {
    name: 'dataflex_class',
    args: { name: 'cWebForm', members: 'all' },
    expect: (text) => (text.includes('chain') ? undefined : 'no inheritance chain')
  },
  { name: 'dataflex_references', args: { name: 'Refresh' } },
  { name: 'dataflex_definition', args: { name: 'cWebForm' } },
  { name: 'dataflex_table', args: {} },
  { name: 'dataflex_dead_code', args: {} },
  { name: 'dataflex_discover_tests', args: {} },
  {
    name: 'dataflex_analyze_workspace',
    args: {},
    expect: (text) => (text.includes('files analysed') ? undefined : 'no summary line')
  },
  { name: 'dataflex_analyze_workspace', args: { rule: 'unused-local', limit: 50 } }
];

async function main(): Promise<number> {
  const wanted = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  const root = wanted ?? CANDIDATES.find((candidate) => existsSync(candidate));
  if (root === undefined || !existsSync(root)) {
    console.error(
      `No DataFlex workspace to check against. Tried:\n  ${CANDIDATES.join('\n  ')}\n` +
        'Pass one: npm run mcp-check -- "<workspace folder>"'
    );
    return 2;
  }
  if (!existsSync(SERVER)) {
    console.error(`${SERVER} is not built. Run: npm run build --workspace packages/df-mcp`);
    return 2;
  }

  const verbose = process.argv.includes('--verbose');
  console.log(`workspace  ${root}`);
  console.log(`server     ${SERVER}\n`);

  const client = new Client({ name: 'mcp-check', version: '0' });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [SERVER], cwd: root })
  );

  const tools = (await client.listTools()).tools;
  console.log(`tools      ${tools.length} registered, none of them executing (no --allow-execute)`);
  const executing = tools.filter((tool) => tool.annotations?.destructiveHint === true);
  if (executing.length > 0) {
    console.error(`  FAIL: ${executing.map((t) => t.name).join(', ')} offered without the gate`);
    await client.close();
    return 1;
  }
  console.log('');

  let failures = 0;
  for (const call of CALLS) {
    const started = Date.now();
    const result = await client.callTool({ name: call.name, arguments: call.args }, undefined, {
      timeout: 600_000
    });
    const text = (result.content as { type: string; text?: string }[])
      .map((part) => part.text ?? '')
      .join('\n');
    const bytes = Buffer.byteLength(text, 'utf8');
    const elapsed = Date.now() - started;

    const problems: string[] = [];
    if (bytes > MAX_BYTES) {
      problems.push(`OVER BUDGET by ${bytes - MAX_BYTES} bytes`);
    }
    if (result.isError === true) {
      problems.push('tool reported an error');
    }
    const assertion = call.expect?.(text);
    if (assertion !== undefined) {
      problems.push(assertion);
    }

    const label = `${call.name} ${JSON.stringify(call.args)}`;
    console.log(
      `  ${problems.length === 0 ? 'ok  ' : 'FAIL'} ${label.padEnd(58)} ` +
        `${String(elapsed).padStart(6)} ms  ${String(bytes).padStart(6)} bytes` +
        (problems.length === 0 ? '' : `  -- ${problems.join('; ')}`)
    );
    if (problems.length > 0) {
      failures++;
    }
    if (verbose) {
      console.log(text.replace(/^/gm, '      '));
    }
  }

  await client.close();
  console.log(
    `\n${CALLS.length - failures}/${CALLS.length} calls within the ${MAX_BYTES} byte ceiling.`
  );
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
