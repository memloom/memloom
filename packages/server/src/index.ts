import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { serve as nodeServe } from "@hono/node-server";
import { MEMORY_TYPES, type Memloom } from "@memloom/core";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";

// The local HTTP server: a thin wrapper around @memloom/core so the browser-based viewer (and
// any HTTP client) can reach the engine. The CLI/MCP route through this when it holds the
// store, giving one owner of the single PGLite connection (D1). Same request/response shapes
// as the hosted public API, so clients can point at local or cloud.

export interface ServerOptions {
  /** Log each request (method, path, status, timing) to stdout. Off by default (tests). */
  log?: boolean;
  /**
   * Graceful shutdown hook. When set, POST /admin/shutdown responds ok and then invokes it —
   * this is how `memloom stop` stops the daemon cleanly (releasing the data-dir lock) instead
   * of the user force-killing the process and leaving a stale lock behind.
   */
  onShutdown?: () => Promise<void>;
  /**
   * Absolute directory of the viewer bundle (index.html + assets). When set, GET requests that
   * no API route claims are served from it, so the daemon is API + viewer on one port.
   */
  staticDir?: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

// How long the store probe waits before declaring the store locked. `select 1` on a free store
// answers in single-digit milliseconds; anything slower means something is holding the lock.
const STORE_PROBE_TIMEOUT_MS = 1_500;

// Request-body schemas. Bad input fails here with a 400 that names the offending field, instead
// of leaking through to the store or an embeddings call as a confusing 500.
const saveSchema = z.object({
  content: z.string().min(1, "content must be a non-empty string"),
  canonical: z.string().optional(),
  memoryType: z.enum(MEMORY_TYPES).optional(),
  ownerId: z.string().uuid().optional(),
});

const querySchema = z.object({
  query: z.string().min(1, "query must be a non-empty string"),
  limit: z.number().int().positive().optional(),
});

const contextAddSchema = z.object({
  path: z.string().min(1, "path must be a non-empty string"),
  ownerId: z.string().uuid().optional(),
});

const resolveSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("keep_new") }),
  z.object({ action: z.literal("keep_existing"), candidateId: z.string().min(1) }),
  z.object({ action: z.literal("keep_both") }),
  z.object({
    action: z.literal("merge"),
    content: z.string().min(1, "merge needs the reconciled content"),
    canonical: z.string().optional(),
  }),
]);

/** Parse + validate a JSON body; returns the typed value or a 400 JSON response. */
async function parseBody<S extends z.ZodTypeAny>(
  c: Context,
  schema: S,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; res: Response }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, res: c.json({ error: "request body must be valid JSON" }, 400) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      res: c.json(
        {
          error: "invalid request body",
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join(".") || "(body)",
            message: i.message,
          })),
        },
        400,
      ),
    };
  }
  return { ok: true, data: parsed.data };
}

export function createServer(memloom: Memloom, opts: ServerOptions = {}): Hono {
  const app = new Hono();

  // Browser clients (the viewer in dev, docs playground) run on another localhost port. Allow
  // only local origins — a permissive `*` would let any public web page drive the daemon.
  app.use(
    "*",
    cors({
      origin: (origin) =>
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? origin : null,
    }),
  );

  if (opts.log) {
    app.use("*", async (c, next) => {
      const start = Date.now();
      // Log API traffic only (viewer asset requests are noise). Log on arrival AND on
      // completion: a request stuck on a hung provider call or a locked store would otherwise
      // be invisible ("no requests in the terminal" while it hangs).
      const isApi =
        c.req.path.startsWith("/memory") ||
        c.req.path.startsWith("/context") ||
        c.req.path.startsWith("/admin");
      if (isApi) {
        console.log(`${new Date().toISOString()}  → ${c.req.method} ${c.req.path}`);
      }
      await next();
      if (isApi) {
        console.log(
          `${new Date().toISOString()}  ← ${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - start}ms`,
        );
      }
    });
  }

  app.get("/health", (c) => c.json({ ok: true }));

  // Fail fast when the store is unreachable: a connected Postgres wire client (Drizzle Studio,
  // psql) holds PGLite's exclusive lock and every query queues behind it. Probing BEFORE the
  // handler turns an indefinite silent hang into an actionable 503 — and skips paying for an
  // embedding call whose result would only sit in the queue.
  const probeStore = async (c: Context, next: () => Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const locked = await Promise.race([
      memloom.ping().then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), STORE_PROBE_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    if (locked) {
      return c.json(
        {
          error:
            "the store is locked by a connected Postgres wire client (Drizzle Studio, psql, a DB panel). " +
            "PGLite is single-connection — disconnect that client and retry.",
        },
        503,
      );
    }
    await next();
  };
  app.use("/memory/*", probeStore);
  app.use("/context/*", probeStore);

  if (opts.onShutdown) {
    const shutdown = opts.onShutdown;
    app.post("/admin/shutdown", (c) => {
      // Respond first, then shut down so the client gets its ack.
      setTimeout(() => void shutdown(), 100);
      return c.json({ ok: true, stopping: true });
    });
  }

  app.post("/memory/save", async (c) => {
    const body = await parseBody(c, saveSchema);
    if (!body.ok) return body.res;
    return c.json(await memloom.save(body.data));
  });

  app.post("/memory/query", async (c) => {
    const body = await parseBody(c, querySchema);
    if (!body.ok) return body.res;
    const memories = await memloom.recall(body.data.query, { limit: body.data.limit });
    return c.json({ memories });
  });

  app.post("/memory/index", async (c) => c.json(await memloom.index()));

  app.get("/memory/graph", async (c) => c.json(await memloom.graph()));

  app.get("/memory/conflicts", async (c) => c.json({ conflicts: await memloom.conflicts() }));

  app.post("/memory/conflicts/:id/resolve", async (c) => {
    const body = await parseBody(c, resolveSchema);
    if (!body.ok) return body.res;
    await memloom.resolveConflict(c.req.param("id"), body.data);
    return c.json({ ok: true });
  });

  app.post("/memory/conflicts/:id/revert", async (c) => {
    await memloom.revertConflict(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/context/add", async (c) => {
    const body = await parseBody(c, contextAddSchema);
    if (!body.ok) return body.res;
    return c.json(await memloom.contextAdd(body.data));
  });

  app.get("/context/documents", async (c) => c.json({ documents: await memloom.contextList() }));

  app.delete("/context/documents/:id", async (c) => {
    await memloom.contextRemove(c.req.param("id"));
    return c.json({ ok: true });
  });

  // The viewer bundle, mounted last so every API route wins first. Unknown paths fall back to
  // index.html (the shell handles them) — standard single-page-app serving.
  if (opts.staticDir) {
    const root = resolve(opts.staticDir);
    app.get("*", async (c) => {
      const reqPath = c.req.path === "/" ? "/index.html" : c.req.path;
      const file = normalize(join(root, reqPath));
      // Path traversal guard: whatever the URL says, we only ever read inside the bundle dir.
      if (file !== root && !file.startsWith(root + sep)) return c.notFound();
      try {
        const data = await readFile(file);
        return c.body(data, 200, {
          "content-type": MIME[extname(file)] ?? "application/octet-stream",
        });
      } catch {
        try {
          const index = await readFile(join(root, "index.html"));
          return c.html(index.toString("utf8"));
        } catch {
          return c.notFound();
        }
      }
    });
  }

  // Engine/provider failures come back as JSON with the real message instead of Hono's bare
  // "Internal Server Error" text (they still land in the request log via the ← line).
  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.log)
      console.error(`${new Date().toISOString()}  ✖ ${c.req.method} ${c.req.path} — ${message}`);
    return c.json({ error: message }, 500);
  });

  return app;
}

/** Start the server on localhost. Returns the underlying node server handle. */
export function serve(memloom: Memloom, port = 4319) {
  const app = createServer(memloom);
  return nodeServe({ fetch: app.fetch, port, hostname: "127.0.0.1" });
}
