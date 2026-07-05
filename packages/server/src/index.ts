// memloom local HTTP server (Hono). Wraps @memloom/core and owns the single PGLite
// connection so the CLI, MCP, and viewer can route through one owner (build-plan D1
// single-owner model). Implemented in Phase 5.

export function createServer(): never {
  throw new Error("@memloom/server is not implemented yet (build-plan Phase 5).");
}
