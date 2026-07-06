import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { connect } from "memloom";
import { buildServer } from "./server.js";

// memloom MCP server over stdio. Routes through the `memloom serve` daemon (auto-started by
// connect() if needed), so it never opens the store directly — no lock conflicts with the CLI
// or a DB client. Register in Claude Desktop as:
//   { "command": "node", "args": ["<path>/dist/bin.js"], "env": { "OPENROUTER_API_KEY": "..." } }

async function main() {
  const engine = await connect();
  const server = buildServer(engine);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
