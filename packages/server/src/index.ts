import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { serve as nodeServe } from "@hono/node-server";
import { type IndexProgressEvent, isChatProvider, MEMORY_TYPES, type Memloom } from "@memloom/core";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { stream, streamSSE } from "hono/streaming";
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
  /**
   * Opens a file with the OS default application (the viewer's "Open file" button). Defaults
   * to the platform opener; injectable so tests never actually launch anything.
   */
  openPath?: (path: string) => void;
}

// Fire-and-forget OS opener. The daemon runs on the file owner's machine, so "open" means
// their own default app; the HTTP response never waits on it.
function platformOpen(path: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["explorer.exe", [path]]
      : process.platform === "darwin"
        ? ["open", [path]]
        : ["xdg-open", [path]];
  const child = spawn(cmd, args as string[], { detached: true, stdio: "ignore" });
  child.on("error", () => {}); // opener missing — nothing useful to report back
  child.unref();
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

const updateSchema = z.object({
  content: z.string().min(1, "content must be a non-empty string"),
  canonical: z.string().optional(),
});

const contextAddSchema = z.object({
  path: z.string().min(1, "path must be a non-empty string"),
  ownerId: z.string().uuid().optional(),
});

const schemaEntrySchema = z.object({
  kind: z.enum(["entity_type", "predicate"]),
  name: z.string().min(2, "name must be at least 2 characters"),
  description: z.string().optional(),
});

const schemaStatusSchema = z.object({
  status: z.enum(["active", "disabled"]),
});

const assistantChatSchema = z.object({
  sessionId: z.string().uuid().optional(),
  message: z.string().min(1, "message must be a non-empty string"),
});

const assistantSessionPatchSchema = z.object({
  title: z.string().min(1).optional(),
  starred: z.boolean().optional(),
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
        c.req.path.startsWith("/assistant") ||
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
  app.use("/assistant/*", probeStore);

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

  // Browsing counterpart to /memory/query: all active memories, newest first.
  app.get("/memory/list", async (c) => c.json({ memories: await memloom.memories() }));

  app.post("/memory/query", async (c) => {
    const body = await parseBody(c, querySchema);
    if (!body.ok) return body.res;
    const memories = await memloom.recall(body.data.query, { limit: body.data.limit });
    return c.json({ memories });
  });

  app.post("/memory/:id/update", async (c) => {
    const body = await parseBody(c, updateSchema);
    if (!body.ok) return body.res;
    return c.json(
      await memloom.update({
        id: c.req.param("id"),
        content: body.data.content,
        canonical: body.data.canonical,
      }),
    );
  });

  app.get("/memory/:id/history", async (c) =>
    c.json({ versions: await memloom.history(c.req.param("id")) }),
  );

  app.post("/memory/index", async (c) => c.json(await memloom.index()));

  // Indexing runs one LLM call per unindexed row — minutes for a big PDF. The stream
  // variants respond with NDJSON progress ({type:"item"} per row, {type:"done"} with the
  // totals) so clients can show what's happening in real time instead of a spinner.
  type ProgressRun = (
    onProgress: (event: IndexProgressEvent) => void,
  ) => Promise<{ indexed: number; chunksIndexed: number }>;
  const streamRun = (c: Context, run: ProgressRun) => {
    c.header("content-type", "application/x-ndjson");
    return stream(c, async (s) => {
      // onProgress is sync; serialize writes through a promise chain so lines never interleave.
      let chain = Promise.resolve();
      const write = (payload: unknown) => {
        chain = chain.then(async () => {
          await s.write(`${JSON.stringify(payload)}\n`);
        });
      };
      try {
        const result = await run((event) => write({ type: "item", ...event }));
        write({ type: "done", ...result });
      } catch (err) {
        // Mid-stream failures can't become an HTTP error status — surface them in-band.
        write({ type: "error", error: err instanceof Error ? err.message : String(err) });
      }
      await chain;
    });
  };

  app.post("/memory/index/stream", (c) => streamRun(c, (p) => memloom.index(undefined, p)));

  // Index sessions: the persistent, session-grouped log the Console tab renders. Runs are
  // listed newest-first; a run's per-item events load on expand. History is user-managed —
  // per-run delete and clear-all instead of an automatic cap.
  app.get("/memory/index/runs", async (c) => c.json({ runs: await memloom.listIndexRuns() }));
  app.get("/memory/index/runs/:id/events", async (c) =>
    c.json({ events: await memloom.indexRunEvents(c.req.param("id")) }),
  );
  app.delete("/memory/index/runs/:id", async (c) => {
    await memloom.deleteIndexRun(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.delete("/memory/index/runs", async (c) => {
    await memloom.clearIndexRuns();
    return c.json({ ok: true });
  });

  // Recovery: wipe every extracted entity/edge and re-run indexing from scratch.
  app.post("/memory/reindex", async (c) => c.json(await memloom.reindex()));
  app.post("/memory/reindex/stream", (c) => streamRun(c, (p) => memloom.reindex(undefined, p)));

  // The graph schema registry: vocabularies with live usage counts + the proposal queue.
  app.get("/memory/schema", async (c) => c.json(await memloom.describeSchema()));

  // Add a user-tier vocabulary entry (entity type or predicate).
  app.post("/memory/schema", async (c) => {
    const body = await parseBody(c, schemaEntrySchema);
    if (!body.ok) return body.res;
    return c.json(
      await memloom.addSchemaEntry(body.data.kind, body.data.name, body.data.description ?? ""),
    );
  });

  // Review a proposal: approve promotes it to the user tier; dismiss blocklists the name.
  app.post("/memory/schema/:id/approve", async (c) => {
    await memloom.approveProposal(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/memory/schema/:id/dismiss", async (c) => {
    await memloom.dismissProposal(c.req.param("id"));
    return c.json({ ok: true });
  });

  // Enable/disable a vocabulary entry.
  app.patch("/memory/schema/:id", async (c) => {
    const body = await parseBody(c, schemaStatusSchema);
    if (!body.ok) return body.res;
    await memloom.setSchemaStatus(c.req.param("id"), body.data.status);
    return c.json({ ok: true });
  });

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

  // The assistant tab: one agentic turn streamed as SSE (tool activity + answer deltas +
  // a terminal done/error event). Offline mode (no chat-capable LLM) fails fast with a
  // setup hint BEFORE the stream starts, so the client gets a real 503.
  app.post("/assistant/chat", async (c) => {
    const body = await parseBody(c, assistantChatSchema);
    if (!body.ok) return body.res;
    if (!isChatProvider(memloom.deps.llm)) {
      return c.json(
        {
          error:
            "the assistant needs an LLM: add OPENROUTER_API_KEY to ~/.memloom/config.env " +
            "and restart the daemon",
        },
        503,
      );
    }
    return streamSSE(c, async (s) => {
      // onEvent is sync; serialize writes through a promise chain so events never interleave.
      let chain = Promise.resolve();
      const send = (payload: unknown) => {
        chain = chain.then(async () => {
          await s.writeSSE({ data: JSON.stringify(payload) });
        });
      };
      try {
        const result = await memloom.assistantChat(body.data, send);
        send({ type: "done", ...result });
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
      await chain;
    });
  });

  app.get("/assistant/sessions", async (c) =>
    c.json({ sessions: await memloom.assistantSessions() }),
  );
  app.get("/assistant/sessions/search", async (c) =>
    c.json({ sessions: await memloom.searchAssistantSessions(c.req.query("q") ?? "") }),
  );
  app.get("/assistant/sessions/:id/messages", async (c) =>
    c.json({ messages: await memloom.assistantMessages(c.req.param("id")) }),
  );
  app.patch("/assistant/sessions/:id", async (c) => {
    const body = await parseBody(c, assistantSessionPatchSchema);
    if (!body.ok) return body.res;
    const id = c.req.param("id");
    if (body.data.title !== undefined) await memloom.renameAssistantSession(id, body.data.title);
    if (body.data.starred !== undefined) await memloom.starAssistantSession(id, body.data.starred);
    return c.json({ ok: true });
  });
  app.delete("/assistant/sessions/:id", async (c) => {
    await memloom.deleteAssistantSession(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.delete("/assistant/sessions", async (c) => {
    await memloom.clearAssistantSessions();
    return c.json({ ok: true });
  });

  app.post("/context/add", async (c) => {
    const body = await parseBody(c, contextAddSchema);
    if (!body.ok) return body.res;
    return c.json(await memloom.contextAdd(body.data));
  });

  app.get("/context/documents", async (c) => c.json({ documents: await memloom.contextList() }));

  // Drill-down for an expanded document node in the viewer: chunks + chunk-level edges.
  app.get("/context/documents/:id/chunks", async (c) =>
    c.json(await memloom.contextChunks(c.req.param("id"))),
  );

  // Open the source file with the OS default app. Only paths already ingested by the owner
  // can be opened — the id lookup is the gate; no arbitrary path ever reaches the opener.
  const openPath = opts.openPath ?? platformOpen;
  app.post("/context/documents/:id/open", async (c) => {
    const id = c.req.param("id");
    const doc = (await memloom.contextList()).find((d) => d.id === id);
    if (!doc) return c.json({ error: `no context document ${id}` }, 404);
    openPath(doc.path);
    return c.json({ ok: true });
  });

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
