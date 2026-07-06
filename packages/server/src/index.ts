import { serve as nodeServe } from "@hono/node-server";
import type { Memloom, ResolveDecision } from "@memloom/core";
import { Hono } from "hono";

// The local HTTP server: a thin wrapper around @memloom/core so the browser-based viewer (and
// any HTTP client) can reach the engine. The CLI/MCP route through this when it holds the
// store, giving one owner of the single PGLite connection (D1). Same request/response shapes
// as the hosted public API, so clients can point at local or cloud.

export interface ServerOptions {
  /** Log each request (method, path, status, timing) to stdout. Off by default (tests). */
  log?: boolean;
}

export function createServer(memloom: Memloom, opts: ServerOptions = {}): Hono {
  const app = new Hono();

  if (opts.log) {
    app.use("*", async (c, next) => {
      const start = Date.now();
      await next();
      if (c.req.path !== "/health") {
        console.log(
          `${new Date().toISOString()}  ${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - start}ms`,
        );
      }
    });
  }

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/memory/save", async (c) => {
    const body = await c.req.json<{ content: string; canonical?: string }>();
    return c.json(await memloom.save(body));
  });

  app.post("/memory/query", async (c) => {
    const body = await c.req.json<{ query: string; limit?: number }>();
    const memories = await memloom.recall(body.query, { limit: body.limit });
    return c.json({ memories });
  });

  app.post("/memory/index", async (c) => c.json(await memloom.index()));

  app.get("/memory/graph", async (c) => c.json(await memloom.graph()));

  app.get("/memory/conflicts", async (c) => c.json({ conflicts: await memloom.conflicts() }));

  app.post("/memory/conflicts/:id/resolve", async (c) => {
    const decision = await c.req.json<ResolveDecision>();
    await memloom.resolveConflict(c.req.param("id"), decision);
    return c.json({ ok: true });
  });

  app.post("/memory/conflicts/:id/revert", async (c) => {
    await memloom.revertConflict(c.req.param("id"));
    return c.json({ ok: true });
  });

  return app;
}

/** Start the server on localhost. Returns the underlying node server handle. */
export function serve(memloom: Memloom, port = 4319) {
  const app = createServer(memloom);
  return nodeServe({ fetch: app.fetch, port, hostname: "127.0.0.1" });
}
