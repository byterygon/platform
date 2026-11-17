#!/usr/bin/env node
// by-ui-mcp: the Byterygon UI MCP server over stdio (JSON-RPC on stdin and stdout, logs on
// stderr). No listener and no network. See packages/mcp/README.md.
//
//   by-ui-mcp [--registry <folder>]     serve; the registry defaults to @byterygon/ui's registry/
//   by-ui-mcp --help | --version
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { NAME, VERSION, createServer } from "../src/server.js";

const argv = process.argv.slice(2);
const usage = "usage: by-ui-mcp [--registry <folder>]\nA stdio MCP server: start it from an MCP client (Claude Code: claude mcp add byterygon-ui -- by-ui-mcp).";
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(`${usage}\n`);
} else if (argv.includes("--version")) {
  process.stdout.write(`${NAME} ${VERSION}\n`);
} else {
  let registryDir = process.env.BYTERYGON_REGISTRY;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--registry" && argv[i + 1]) registryDir = argv[++i];
    else if (argv[i]?.startsWith("--registry=")) registryDir = String(argv[i]).slice("--registry=".length);
    else {
      process.stderr.write(`by-ui-mcp: unknown argument ${argv[i]}\n${usage}\n`);
      process.exit(2);
    }
  }
  try {
    const server = createServer(registryDir ? { registryDir } : {});
    await server.connect(new StdioServerTransport());
  } catch (error) {
    process.stderr.write(`by-ui-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
