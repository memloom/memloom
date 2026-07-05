// memloom MCP server (stdio): exposes save_memory, recall_memory, resolve_conflict to
// coding agents. Owns @memloom/core directly, or routes to a running @memloom/server when
// one holds the store (build-plan D1). Implemented in Phase 5.

export function createMcpServer(): never {
  throw new Error("@memloom/mcp is not implemented yet (build-plan Phase 5).");
}
