/**
 * Entry point. The order of the first few statements matters -- see `guardStdout`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { guardStdout, parseArgv } from './options.js';
import { McpSession } from './session.js';
import { buildServer } from './server.js';

// Before anything else: the libraries below print freely, and stdout is the transport.
const channel = guardStdout();

const options = parseArgv(process.argv.slice(2), process.env);
const session = new McpSession({
  root: options.root,
  sws: options.sws,
  log: (message) => console.error(`[dataflex] ${message}`)
});

const server = buildServer(session, options);
await server.connect(new StdioServerTransport(process.stdin, channel));
console.error(`[dataflex] ready in ${options.root}`);

export type { McpServer };
