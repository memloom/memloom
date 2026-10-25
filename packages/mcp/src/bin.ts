import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { connect } from "memloom";
import { lazyEngine } from "./lazy-engine.js";
import { buildServer } from "./server.js";

// memloom MCP server over stdio. Routes through the `memloom serve` daemon (auto-started by
// connect() if needed), so it never opens the store directly: no lock conflicts with the CLI
// or a DB client. Register in Claude Desktop as:
//   { "command": "node", "args": ["<path>/dist/bin.js"], "env": { "OPENROUTER_API_KEY": "..." } }
//
// One process serves one person, so the owner comes from the environment that launched it and
// binds the whole connection. Add MEMLOOM_OWNER_ID to that env block to give this agent its own
// memories on a machine more than one person or agent shares:
//   "env": { "OPENROUTER_API_KEY": "...", "MEMLOOM_OWNER_ID": "<uuid>" }
// Leave it out and everything shares the daemon's default owner, exactly as it always has.
//
// Deliberately not a tool argument: the calling model would then be choosing whose memories to
// read, and there is no answer to that it could be trusted to get right every time.

async function main() {
  // Connected lazily: if the daemon cannot start, tool calls say why instead of the client
  // reporting a closed connection.
  const server = buildServer(lazyEngine(connect));
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
