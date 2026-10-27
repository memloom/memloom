import { type FetchLike, HttpMemloomClient } from "@memloom/core";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Hono } from "hono";
import { buildServer } from "./server.js";

// The MCP endpoint of a hosted memloom: Streamable HTTP at /mcp, mounted into the server's own
// HTTP app so it sits behind the same token check as every other route.
//
// Stateless: each request gets a fresh MCP server and transport. Nothing is kept between
// calls, so a restart or a second machine never strands a client on a session that is gone.
//
// The tools reach the engine through the app itself, in process, with the caller's own token.
// That keeps one path for owner binding and access rules: an MCP tool call is exactly the
// HTTP request the CLI would have made, and gets exactly the same answer.

const INTERNAL_ORIGIN = "http://memloom.internal";

export function mountMcp(app: Hono): void {
  app.all("/mcp", async (c) => {
    // Streamable HTTP's GET opens a server-to-client stream; a stateless server has nothing
    // to push, and DELETE ends a session it never made.
    if (c.req.method !== "POST") {
      return c.json(
        { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
        405,
      );
    }
    const authorization = c.req.header("authorization");
    const inProcess: FetchLike = async (url, init) =>
      app.fetch(
        new Request(url, {
          ...init,
          headers: { ...init?.headers, ...(authorization ? { authorization } : {}) },
        }),
      );
    const engine = new HttpMemloomClient(INTERNAL_ORIGIN, inProcess);
    const server = buildServer(engine, { hosted: true });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      // The response is fully built (JSON mode), so closing cannot cut it short.
      void server.close();
    }
  });
}
