import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openStore } from "./config.js";
import { buildServer } from "./server.js";

// memloom MCP server over stdio. Register in an MCP client (e.g. Claude Desktop) as:
//   { "command": "node", "args": ["<path>/dist/bin.js"], "env": { "OPENROUTER_API_KEY": "..." } }

async function main() {
  const store = await openStore();
  const server = buildServer(store.memloom);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
