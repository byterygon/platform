#!/usr/bin/env node
// by-ui-mcp: the Byterygon UI MCP server over stdio (JSON-RPC on stdin and stdout, logs on
// stderr). No listener and no network. See packages/mcp/README.md.
//
//   by-ui-mcp [--registry <folder>]                         serve over stdio (for an MCP client)
//   by-ui-mcp [--registry <folder>] tools                   print the tools and their input schemas
//   by-ui-mcp [--registry <folder>] call <tool> [<json>]    call one tool, print its result
//   by-ui-mcp --help | --version
//
// `tools` and `call` connect an MCP client to the server in process (the SDK's in-memory
// transport): the same requests and answers as over stdio, for agents and scripts without an
// MCP client. `call` exits 1 when the tool reports an error.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { NAME, VERSION, createServer } from "../src/server.js";

const usage = `usage: by-ui-mcp [--registry <folder>] [tools | call <tool> [<json arguments>]]
Without a command: a stdio MCP server, started by an MCP client
(Claude Code: claude mcp add byterygon-ui -- node <path>/packages/mcp/bin/by-ui-mcp.js).
  tools                        list the tools with their input schemas (JSON)
  call <tool> [<json>]         call a tool, e.g. call search_tokens '{"query":"hover background"}'`;

const argv = process.argv.slice(2);
let registryDir = process.env.BYTERYGON_REGISTRY;
/** @type {string[]} */
const rest = [];
for (let i = 0; i < argv.length; i += 1) {
  const arg = String(argv[i]);
  if (arg === "--registry" && argv[i + 1]) registryDir = argv[++i];
  else if (arg.startsWith("--registry=")) registryDir = arg.slice("--registry=".length);
  else rest.push(arg);
}

/** Exits with a usage error. */
function fail(/** @type {string} */ message) {
  process.stderr.write(`by-ui-mcp: ${message}\n${usage}\n`);
  process.exit(2);
}

/** A client connected in process to a new server. */
async function connect() {
  const server = createServer(registryDir ? { registryDir } : {});
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "by-ui-mcp-cli", version: VERSION });
  await client.connect(clientSide);
  return client;
}

if (rest.includes("--help") || rest.includes("-h")) {
  process.stdout.write(`${usage}\n`);
} else if (rest.includes("--version")) {
  process.stdout.write(`${NAME} ${VERSION}\n`);
} else if (rest[0] === "tools") {
  if (rest.length > 1) fail(`tools takes no argument (got ${rest[1]})`);
  const client = await connect();
  const { tools } = await client.listTools();
  process.stdout.write(`${JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })), null, 2)}\n`);
  await client.close();
} else if (rest[0] === "call") {
  const [, tool, json = "{}", ...extra] = rest;
  if (!tool || extra.length > 0) fail("call takes a tool name and at most one JSON argument object");
  /** @type {Record<string, unknown>} */
  let args = {};
  try {
    args = JSON.parse(json);
  } catch (error) {
    fail(`the arguments are not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const client = await connect();
  const result = await client.callTool({ name: String(tool), arguments: args });
  const content = /** @type {{ type: string; text?: string }[]} */ (result.content ?? []);
  process.stdout.write(`${content.map((c) => c.text ?? "").join("\n")}\n`);
  await client.close();
  process.exitCode = result.isError ? 1 : 0;
} else if (rest.length > 0) {
  fail(`unknown command ${rest[0]}`);
} else {
  try {
    const server = createServer(registryDir ? { registryDir } : {});
    await server.connect(new StdioServerTransport());
  } catch (error) {
    process.stderr.write(`by-ui-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
