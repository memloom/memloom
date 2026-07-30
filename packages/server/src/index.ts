import { execFile, spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { serve as nodeServe } from "@hono/node-server";
import {
  AudioError,
  CATALOG,
  type ContextProgressEvent,
  detectKind,
  findModel,
  hasFfmpeg,
  type IndexProgressEvent,
  isChatProvider,
  isHttpUrl,
  LinkExtractionError,
  MEMORY_TYPES,
  type Memloom,
  modelStatus,
  selectModel,
  setupModels,
  supportedExtensions,
} from "@memloom/core";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
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
   * Graceful shutdown hook. When set, POST /admin/shutdown responds ok and then invokes it;
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
  /**
   * Shows the OS-native file/folder picker and resolves with the chosen absolute paths
   * ([] = cancelled, null = no picker on this system). Defaults to the platform dialog;
   * injectable so tests never open one.
   */
  pickPaths?: (mode: "file" | "folder") => Promise<string[] | null>;
  /**
   * The chat model the daemon is configured with (OPENROUTER_CHAT_MODEL fallback chain).
   * Reported by GET /assistant/models so the viewer's picker can label the default.
   */
  defaultChatModel?: string;
  /**
   * Fetches the OpenRouter model catalog; injectable so tests never hit the network.
   * Defaults to global fetch.
   */
  fetchModels?: typeof fetch;
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
  child.on("error", () => {}); // opener missing, nothing useful to report back
  child.unref();
}

// The OS-native file/folder dialog, shown on the daemon's own desktop (localhost tool:
// the daemon and the browser are the same machine). The request blocks until the user
// picks or cancels; [] = cancelled, null = this system has no picker we know.
const PICK_TIMEOUT_MS = 300_000;
const run = promisify(execFile);

async function nativePick(mode: "file" | "folder"): Promise<string[] | null> {
  if (process.platform === "win32") {
    const filter = supportedExtensions()
      .map((ext) => `*${ext}`)
      .join(";");
    // The common dialog positions itself relative to its OWNER and inherits its z-order,
    // so the owner must be a real, shown, ON-SCREEN window: centered, 1x1, near-invisible
    // (1% opacity), TopMost. An offscreen owner (-32000) sends the dialog to a clamped
    // corner with no taskbar button and no activation: invisible in practice. Verified on
    // Windows 11 through the detached-daemon chain.
    const owner =
      "$owner = New-Object System.Windows.Forms.Form; $owner.TopMost = $true; " +
      "$owner.ShowInTaskbar = $false; $owner.FormBorderStyle = 'None'; " +
      "$owner.StartPosition = 'CenterScreen'; $owner.Width = 1; $owner.Height = 1; " +
      "$owner.Opacity = 0.01; $owner.Show(); $owner.Activate(); ";
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; " +
      "[System.Windows.Forms.Application]::EnableVisualStyles(); " +
      owner +
      (mode === "folder"
        ? "$d = New-Object System.Windows.Forms.FolderBrowserDialog; " +
          "$d.Description = 'memloom - link a folder'; " +
          "$r = $d.ShowDialog($owner); $owner.Close(); " +
          "if ($r -eq 'OK') { [Console]::WriteLine($d.SelectedPath) }"
        : "$f = New-Object System.Windows.Forms.OpenFileDialog; $f.Multiselect = $true; " +
          "$f.Title = 'memloom - link files'; " +
          `$f.Filter = 'Supported files|${filter}|All files|*.*'; ` +
          "$r = $f.ShowDialog($owner); $owner.Close(); " +
          "if ($r -eq 'OK') { $f.FileNames | ForEach-Object { [Console]::WriteLine($_) } }");
    try {
      // -EncodedCommand removes every quoting variable between Node and PowerShell.
      const { stdout } = await run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-STA",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { windowsHide: true, timeout: PICK_TIMEOUT_MS },
      );
      return stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    } catch (err) {
      return (err as { code?: string }).code === "ENOENT" ? null : [];
    }
  }
  if (process.platform === "darwin") {
    const script =
      mode === "folder" ? "POSIX path of (choose folder)" : "POSIX path of (choose file)";
    try {
      const { stdout } = await run("osascript", ["-e", script], { timeout: PICK_TIMEOUT_MS });
      const picked = stdout.trim();
      return picked ? [picked] : [];
    } catch (err) {
      return (err as { code?: string }).code === "ENOENT" ? null : []; // non-zero exit = cancelled
    }
  }
  try {
    const args =
      mode === "folder"
        ? ["--file-selection", "--directory"]
        : ["--file-selection", "--multiple", "--separator=\n"];
    const { stdout } = await run("zenity", args, { timeout: PICK_TIMEOUT_MS });
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (err) {
    return (err as { code?: string }).code === "ENOENT" ? null : [];
  }
}

// Folder ingestion: walk for supported files, bounded so a mistaken "add C:\" cannot
// run away. Hidden dirs and dependency/VCS dirs are skipped.
const WALK_MAX_DEPTH = 5;
const WALK_MAX_FILES = 500;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "__pycache__", "target"]);

async function collectSupportedFiles(root: string, depth = 0, out: string[] = []) {
  if (depth > WALK_MAX_DEPTH || out.length >= WALK_MAX_FILES) return out;
  const supported = new Set(supportedExtensions());
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (out.length >= WALK_MAX_FILES) break;
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) await collectSupportedFiles(full, depth + 1, out);
    else if (supported.has(extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
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

// The html field is capped well under the page fetcher own 10 MB limit: a rendered DOM
// arrives as JSON here, and an unbounded string would be a memory hole on a local port.
const contextUrlSchema = z.object({
  url: z.string().refine(isHttpUrl, "url must start with http:// or https://"),
  html: z.string().max(10_000_000).optional(),
  ownerId: z.string().uuid().optional(),
});

const audioSelectSchema = z.object({
  id: z.string().min(1, "id must be a non-empty string"),
});

const audioSetupSchema = z.object({
  id: z.string().min(1).optional(),
});

const schemaEntrySchema = z.object({
  kind: z.enum(["entity_type", "predicate"]),
  name: z.string().min(2, "name must be at least 2 characters"),
  description: z.string().optional(),
});

const schemaStatusSchema = z.object({
  status: z.enum(["active", "disabled"]),
});

const entityPatchSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    entityType: z.string().min(2).max(30).optional(),
  })
  .refine((v) => v.name !== undefined || v.entityType !== undefined, {
    message: "provide name and/or entityType",
  });

const entityMergeSchema = z.object({
  into: z.string().uuid(),
});

const entityResolveSchema = z.object({
  dryRun: z.boolean().optional(),
});

const autoIndexSchema = z.object({
  enabled: z.boolean(),
});

const importSchema = z.object({
  // The engine validates agent support; the wire only constrains the shape.
  agent: z.string().min(1).max(100).optional(),
  days: z.number().int().positive().max(3650).optional(),
  maxSessions: z.number().int().positive().max(1000).optional(),
  project: z.string().min(1).max(300).optional(),
  dryRun: z.boolean().optional(),
  force: z.boolean().optional(),
});

const agentMemoryImportSchema = z.object({
  agents: z
    .array(z.enum(["claude-code", "copilot"]))
    .min(1)
    .max(10)
    .optional(),
  project: z.string().min(1).max(300).optional(),
  dryRun: z.boolean().optional(),
  force: z.boolean().optional(),
});

const importNotifySchema = z.object({
  path: z.string().min(1, "path must be a non-empty string").max(4096),
});

const importScopeSchema = z.object({
  scope: z.union([
    z.literal("all"),
    z.object({ projects: z.array(z.string().min(1).max(300)).min(1).max(200) }),
    z.null(),
  ]),
});

const notionScopeSchema = z.object({
  scope: z.union([
    z.object({
      items: z
        .array(
          z.object({
            id: z.string().min(1).max(100),
            object: z.enum(["page", "data_source"]),
            title: z.string().min(1).max(500),
          }),
        )
        .min(1)
        .max(500),
    }),
    z.null(),
  ]),
});

const notionSyncSchema = z.object({
  dryRun: z.boolean().optional(),
  force: z.boolean().optional(),
  wait: z.boolean().optional(),
});

const assistantChatSchema = z.object({
  sessionId: z.string().uuid().optional(),
  message: z.string().min(1, "message must be a non-empty string"),
  // Loosely validated on purpose: OpenRouter is the authority on what exists, and its
  // errors already surface through the SSE error event.
  model: z.string().min(1).max(200).optional(),
});

const assistantAttachSchema = z.object({
  sessionId: z.string().uuid().optional(),
  filename: z.string().min(1, "filename must be a non-empty string").max(255),
  contentBase64: z.string().min(1, "contentBase64 must be a non-empty string"),
});

const contextUploadSchema = z.object({
  filename: z.string().min(1, "filename must be a non-empty string").max(255),
  contentBase64: z.string().min(1, "contentBase64 must be a non-empty string"),
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

/**
 * The speech-model catalog with everything a picker needs to render it in one call: which
 * models are on disk, which one transcription would use, and whether ffmpeg is there to feed
 * them. Shaped this way because a list where each row needs its own request is a list that
 * renders wrong while it loads.
 */
async function audioCatalog() {
  const status = await modelStatus();
  return {
    dir: status.dir,
    ffmpeg: await hasFfmpeg(),
    selected: status.selected.id,
    installed: status.installed,
    models: CATALOG.map((m) => ({
      ...m,
      installed: status.installedIds.includes(m.id),
      selected: m.id === status.selected.id,
    })),
  };
}

/**
 * An AudioError is the caller's problem to act on (download the model, install ffmpeg), so it
 * answers 400 with its stable code, the same contract /context/url gives extraction failures.
 * A model nobody has downloaded yet is not a server fault.
 */
function audioFailure(c: Context, err: unknown): Response {
  if (err instanceof AudioError) return c.json({ error: err.message, code: err.code }, 400);
  throw err;
}

// A local browser Origin: the viewer served from the daemon, or a dev viewer on another
// localhost port. Anything else is a cross-site caller.
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

// True when the Host header names the loopback interface. Accepts an optional port and
// bracketed IPv6 (`[::1]:4319`). The daemon only binds 127.0.0.1, so a real same-machine
// client always sends one of these; a DNS-rebound page sends its attacker hostname instead.
function isLoopbackHost(host: string): boolean {
  const hostname = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

export function createServer(memloom: Memloom, opts: ServerOptions = {}): Hono {
  const app = new Hono();

  // Browser clients (the viewer in dev, docs playground) run on another localhost port. Allow
  // only local origins; a permissive `*` would let any public web page drive the daemon.
  app.use(
    "*",
    cors({
      origin: (origin) => (LOCAL_ORIGIN.test(origin) ? origin : null),
    }),
  );

  // Access-control gate. cors() only sets response headers; it never blocks the request, so
  // without this a cross-site page could still fire a handler's side effects (e.g. a
  // no-preflight POST /admin/shutdown that kills the daemon, its response merely unreadable).
  // Two independent checks close two attacks:
  //  - Host allowlist: a browser cannot forge the Host header, so requiring a loopback Host
  //    defeats DNS rebinding, where a rebound page reaches 127.0.0.1 but still sends its own
  //    hostname as Host.
  //  - Origin check: a genuine cross-site request carries a non-local Origin. Same-origin
  //    viewer requests and non-browser clients (CLI, MCP, curl) send no Origin (or a local
  //    one), so they pass untouched.
  app.use("*", async (c, next) => {
    const host = c.req.header("host");
    if (host && !isLoopbackHost(host)) {
      return c.json({ error: "forbidden: requests must target the loopback interface" }, 403);
    }
    const origin = c.req.header("origin");
    if (origin && !LOCAL_ORIGIN.test(origin)) {
      return c.json({ error: "forbidden: cross-origin request rejected" }, 403);
    }
    await next();
  });

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
        c.req.path.startsWith("/audio") ||
        c.req.path.startsWith("/import") ||
        c.req.path.startsWith("/notion") ||
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
  // handler turns an indefinite silent hang into an actionable 503, and skips paying for an
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
            "PGLite is single-connection; disconnect that client and retry.",
        },
        503,
      );
    }
    await next();
  };
  app.use("/memory/*", probeStore);
  app.use("/context/*", probeStore);
  app.use("/assistant/*", probeStore);
  app.use("/import/*", probeStore);
  app.use("/notion/*", probeStore);

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

  // Deletes the whole belief: every version, its edges, and pending conflicts naming it.
  app.delete("/memory/:id", async (c) => {
    try {
      await memloom.deleteMemory(c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, /no memory/.test(message) ? 404 : 400);
    }
  });

  // The full text of one recall hit (memory or context chunk): the fetch-the-rest path
  // behind truncated recall passages (MCP read_passage, assistant read_source).
  app.get("/memory/passage/:id", async (c) => {
    const content = await memloom.passage(c.req.param("id"));
    if (content === null) return c.json({ error: "no such passage" }, 404);
    return c.json({ content });
  });

  app.post("/memory/index", async (c) => c.json(await memloom.index()));

  // Indexing runs one LLM call per unindexed row (minutes for a big PDF). The stream
  // variants respond with NDJSON progress ({type:"item"} per row, {type:"done"} with the
  // totals) so clients can show what's happening in real time instead of a spinner.
  // Node's fetch kills a response body that stays silent for ~300s (undici bodyTimeout),
  // and one session or one big PDF can distill for longer than that without emitting an
  // event. Pings keep the pipe alive; clients skip any event type they don't know.
  const STREAM_HEARTBEAT_MS = 15_000;
  const streamNdjson = <TEvent>(
    c: Context,
    run: (emit: (event: TEvent) => void, signal: AbortSignal) => Promise<object>,
  ) => {
    c.header("content-type", "application/x-ndjson");
    return stream(c, async (s) => {
      // onProgress is sync; serialize writes through a promise chain so lines never interleave.
      let chain = Promise.resolve();
      const write = (payload: unknown) => {
        chain = chain.then(async () => {
          await s.write(`${JSON.stringify(payload)}\n`);
        });
      };
      // The client hanging up means "stop", and a long run must honour that rather than
      // burn a core for minutes with nobody listening. This comes from the stream rather
      // than from c.req.raw.signal, which does not fire on disconnect under the Node
      // adapter: verified by watching a cancelled transcription keep running.
      const cancel = new AbortController();
      s.onAbort(() => cancel.abort());
      const heartbeat = setInterval(() => write({ type: "ping" }), STREAM_HEARTBEAT_MS);
      try {
        const result = await run((event) => write({ type: "item", ...event }), cancel.signal);
        write({ type: "done", ...result });
      } catch (err) {
        // Mid-stream failures can't become an HTTP error status: surface them in-band.
        write({ type: "error", error: err instanceof Error ? err.message : String(err) });
      } finally {
        clearInterval(heartbeat);
      }
      await chain;
    });
  };
  type ProgressRun = (
    onProgress: (event: IndexProgressEvent) => void,
  ) => Promise<{ indexed: number; chunksIndexed: number }>;
  const streamRun = (c: Context, run: ProgressRun) => streamNdjson(c, run);

  app.post("/memory/index/stream", (c) => streamRun(c, (p) => memloom.index(undefined, p)));

  // Hook capture surface. The notify endpoint takes only a transcript path and must confine
  // it: any local process can reach the daemon, and without this check one could make the
  // daemon read an arbitrary file, ship it to the LLM provider, and write derived content
  // into the store. The path must resolve inside ~/.claude/projects, on top of the global
  // Host + Origin gate above.
  const sessionsRoot = resolve(join(homedir(), ".claude", "projects"));
  app.post("/import/claude-code/notify", async (c) => {
    const body = await parseBody(c, importNotifySchema);
    if (!body.ok) return body.res;
    const target = resolve(normalize(body.data.path));
    if (target !== sessionsRoot && !target.startsWith(sessionsRoot + sep)) {
      return c.json(
        { error: "forbidden: path is outside the Claude Code sessions directory" },
        400,
      );
    }
    if (!target.endsWith(".jsonl")) {
      return c.json({ error: "path must be a .jsonl session transcript" }, 400);
    }
    // Fire and forget: the hook must never wait on distillation. handleSessionNotify records
    // every failure in status, so nothing here is silently lost.
    void memloom.handleSessionNotify(target).catch(() => {});
    return c.json({ accepted: true }, 202);
  });

  app.get("/import/claude-code/status", async (c) => c.json(await memloom.importStatus()));

  app.put("/import/claude-code/scope", async (c) => {
    const body = await parseBody(c, importScopeSchema);
    if (!body.ok) return body.res;
    await memloom.setImportScope(body.data.scope);
    return c.json({ ok: true });
  });

  // Session import runs daemon-side (the single store writer owns the ledger) and streams
  // NDJSON progress: one {type:"item"} per session, {type:"done"} with the totals and the
  // cost line. Discovery is fixed to ~/.claude/projects; the client never supplies a path.
  app.post("/import/sessions/stream", async (c) => {
    const body = await parseBody(c, importSchema);
    if (!body.ok) return body.res;
    const opts = body.data as Parameters<typeof memloom.importSessions>[0];
    return streamNdjson(c, (emit) => memloom.importSessions(opts, emit));
  });

  // Agent memory folder import: same daemon-side NDJSON contract as the session stream,
  // one {type:"item"} per folder. Discovery is fixed to the agents' own well-known paths;
  // the client never supplies a filesystem path.
  app.post("/import/agent-memory/stream", async (c) => {
    const body = await parseBody(c, agentMemoryImportSchema);
    if (!body.ok) return body.res;
    const opts = body.data;
    return streamNdjson(c, (emit) => memloom.importAgentMemories(opts, emit));
  });

  // The Notion connector. Sync runs daemon-side (the single store writer owns the
  // watermarks) and streams NDJSON progress like import. The token never crosses this
  // API: the daemon reads NOTION_TOKEN from its own environment.
  app.get("/notion/pages", async (c) => c.json(await memloom.notionListPages()));

  app.get("/notion/status", async (c) => c.json(await memloom.notionStatus()));

  app.put("/notion/scope", async (c) => {
    const body = await parseBody(c, notionScopeSchema);
    if (!body.ok) return body.res;
    await memloom.setNotionScope(body.data.scope);
    return c.json({ ok: true });
  });

  app.post("/notion/sync/stream", async (c) => {
    const body = await parseBody(c, notionSyncSchema);
    if (!body.ok) return body.res;
    const opts = body.data;
    return streamNdjson(c, (emit) => memloom.notionSync(opts, emit));
  });

  // Index sessions: the persistent, session-grouped log the Console tab renders. Runs are
  // listed newest-first; a run's per-item events load on expand. History is user-managed:
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

  // Review a proposal: approve promotes it to the user tier AND links its saved
  // occurrences into the graph (no re-index); dismiss blocklists the name.
  app.post("/memory/schema/:id/approve", async (c) => {
    const linked = await memloom.approveProposal(c.req.param("id"));
    return c.json({ ok: true, ...linked });
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

  // Permanently remove a disabled user-tier entry (the engine enforces the guards).
  app.delete("/memory/schema/:id", async (c) => {
    try {
      await memloom.deleteSchemaEntry(c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, /no schema entry/.test(message) ? 404 : 409);
    }
  });

  // The Console's auto-index toggle. `available` is false in offline mode (no LLM means
  // enabling it would only produce failing runs), and the setter refuses there too.
  app.get("/memory/auto-index", (c) =>
    c.json({ enabled: memloom.autoIndexEnabled, available: memloom.autoIndexAvailable }),
  );
  app.patch("/memory/auto-index", async (c) => {
    const body = await parseBody(c, autoIndexSchema);
    if (!body.ok) return body.res;
    try {
      await memloom.setAutoIndex(body.data.enabled);
      return c.json({ enabled: memloom.autoIndexEnabled });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  });

  // Entity instances (the schema tab's management list): rename/retype, merge, delete.
  app.get("/memory/entities", async (c) => c.json({ entities: await memloom.listEntities() }));

  // Entity resolution. These sit ABOVE the /:id routes on purpose: Hono matches in
  // registration order, so "conflicts" would otherwise be read as an entity id.
  app.get("/memory/entities/conflicts", async (c) =>
    c.json({ conflicts: await memloom.entityConflicts() }),
  );

  app.get("/memory/entities/merges", async (c) => c.json({ merges: await memloom.entityMerges() }));

  app.post("/memory/entities/resolve", async (c) => {
    const body = await parseBody(c, entityResolveSchema);
    if (!body.ok) return body.res;
    return c.json(await memloom.resolveEntities({ dryRun: body.data.dryRun }));
  });

  // "Which people is this person connected to." Query rather than path parameter because the
  // target may be a NAME, and real entity names carry slashes and dots ("@memloom/cli").
  app.get("/memory/entities/related", async (c) => {
    const target = c.req.query("q");
    if (!target) return c.json({ error: "q is required (an entity id, name, or alias)" }, 400);
    const limit = Number(c.req.query("limit") ?? 50);
    const result = await memloom.relatedEntities(target, {
      ...(c.req.query("type") ? { entityType: c.req.query("type") as string } : {}),
      ...(Number.isFinite(limit) ? { limit } : {}),
    });
    if (!result) return c.json({ error: `no entity matching "${target}"` }, 404);
    return c.json(result);
  });

  app.post("/memory/entities/merges/:id/revert", async (c) => {
    try {
      await memloom.revertEntityMerge(c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, /no entity merge/.test(message) ? 404 : 400);
    }
  });

  app.patch("/memory/entities/:id", async (c) => {
    const body = await parseBody(c, entityPatchSchema);
    if (!body.ok) return body.res;
    try {
      await memloom.updateEntity(c.req.param("id"), body.data);
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/no entity/.test(message)) return c.json({ error: message }, 404);
      return c.json({ error: message }, /already exists/.test(message) ? 409 : 400);
    }
  });

  app.post("/memory/entities/:id/merge", async (c) => {
    const body = await parseBody(c, entityMergeSchema);
    if (!body.ok) return body.res;
    try {
      await memloom.mergeEntities(c.req.param("id"), body.data.into);
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, /no entity/.test(message) ? 404 : 400);
    }
  });

  app.delete("/memory/entities/:id", async (c) => {
    try {
      await memloom.deleteEntity(c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, /no entity/.test(message) ? 404 : 400);
    }
  });

  app.get("/memory/graph", async (c) => c.json(await memloom.graph()));

  app.get("/memory/conflicts", async (c) => c.json({ conflicts: await memloom.conflicts() }));

  // The revertable history behind the pending queue: resolved conflicts, newest first.
  app.get("/memory/conflicts/resolved", async (c) =>
    c.json({ conflicts: await memloom.resolvedConflicts() }),
  );

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

  // The auto-resolver: an LLM re-judges every pending conflict with provenance context and
  // applies the decisive verdicts (revertably). Streams one item per conflict.
  app.post("/memory/conflicts/resolve-auto/stream", (c) =>
    streamNdjson(c, (emit) => memloom.autoResolveConflicts(undefined, emit)),
  );

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

  // The model catalog for the composer's picker: tool-capable OpenRouter models (the
  // harness needs native tool calling), shaped for display and cached for an hour. On a
  // refresh failure the stale copy keeps serving; a model list is never worth an outage.
  const MODELS_TTL_MS = 60 * 60 * 1000;
  let modelsCache: { at: number; payload: unknown } | null = null;
  app.get("/assistant/models", async (c) => {
    if (modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) {
      return c.json(modelsCache.payload as object);
    }
    const doFetch = opts.fetchModels ?? fetch;
    try {
      const res = await doFetch("https://openrouter.ai/api/v1/models?supported_parameters=tools");
      if (!res.ok) throw new Error(`OpenRouter models: ${res.status}`);
      const json = (await res.json()) as {
        data: {
          id: string;
          name: string;
          description?: string;
          context_length?: number;
          pricing?: { prompt?: string; completion?: string };
        }[];
      };
      const perMillion = (v: string | undefined) => {
        const n = Number(v);
        return Number.isFinite(n) ? n * 1_000_000 : null;
      };
      const models = json.data
        .map((m) => ({
          id: m.id,
          name: m.name,
          description: m.description ?? "",
          contextLength: m.context_length ?? null,
          promptPer1M: perMillion(m.pricing?.prompt),
          completionPer1M: perMillion(m.pricing?.completion),
          provider: m.id.split("/")[0] ?? "other",
        }))
        .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
      modelsCache = {
        at: Date.now(),
        payload: { defaultModel: opts.defaultChatModel ?? null, models },
      };
      return c.json(modelsCache.payload as object);
    } catch (err) {
      if (modelsCache) return c.json(modelsCache.payload as object);
      return c.json(
        { error: `could not load models: ${err instanceof Error ? err.message : String(err)}` },
        502,
      );
    }
  });

  // Attach a file to a chat: the browser uploads the bytes (base64 JSON; the daemon is
  // localhost, simplicity beats multipart), the engine chunks/embeds them scoped to the
  // session. No sessionId creates the session, so attaching can precede the first message.
  app.post(
    "/assistant/attachments",
    bodyLimit({
      maxSize: 48 * 1024 * 1024, // base64 inflates 4/3: ~36MB of real file
      onError: (c) => c.json({ error: "attachment too large (max ~36MB)" }, 413),
    }),
    async (c) => {
      const body = await parseBody(c, assistantAttachSchema);
      if (!body.ok) return body.res;
      // The filename only picks the extractor and titles the document, never a disk path.
      const filename = body.data.filename.replace(/[/\\]/g, "_");
      if (!detectKind(filename)) {
        return c.json(
          { error: `unsupported file type (supported: ${supportedExtensions().join(", ")})` },
          400,
        );
      }
      const bytes = new Uint8Array(Buffer.from(body.data.contentBase64, "base64"));
      if (bytes.length === 0) return c.json({ error: "empty file" }, 400);
      try {
        const result = await memloom.contextAttach({
          filename,
          bytes,
          ...(body.data.sessionId ? { sessionId: body.data.sessionId } : {}),
        });
        return c.json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: message }, /no assistant session/.test(message) ? 404 : 500);
      }
    },
  );

  app.get("/assistant/sessions/:id/attachments", async (c) =>
    c.json({ attachments: await memloom.sessionAttachments(c.req.param("id")) }),
  );

  // Ingest bytes uploaded from the browser's own file dialog (the viewer's Browse/Folder
  // buttons) as a global document. Same shape as the chat-attach upload, session-free.
  app.post(
    "/context/upload",
    bodyLimit({
      maxSize: 48 * 1024 * 1024, // base64 inflates 4/3: ~36MB of real file
      onError: (c) => c.json({ error: "file too large (max ~36MB)" }, 413),
    }),
    async (c) => {
      const body = await parseBody(c, contextUploadSchema);
      if (!body.ok) return body.res;
      const filename = body.data.filename.replace(/[/\\]/g, "_");
      if (!detectKind(filename)) {
        return c.json(
          { error: `unsupported file type (supported: ${supportedExtensions().join(", ")})` },
          400,
        );
      }
      const bytes = new Uint8Array(Buffer.from(body.data.contentBase64, "base64"));
      if (bytes.length === 0) return c.json({ error: "empty file" }, 400);
      try {
        return c.json(await memloom.contextUpload({ filename, bytes }));
      } catch (err) {
        // An uploaded recording transcribes too, so it hits the same setup wall.
        return audioFailure(c, err);
      }
    },
  );

  // Ingest a web page. The daemon fetches and parses it locally, so nothing about the page
  // reaches a third party. `html` lets a caller that already rendered the page hand over
  // its DOM instead, which is what a browser extension would send: no fetch, and pages
  // behind a login or built as single-page apps work because the caller was signed in.
  app.post("/context/url", async (c) => {
    const body = await parseBody(c, contextUrlSchema);
    if (!body.ok) return body.res;
    try {
      return c.json(await memloom.contextAddUrl(body.data));
    } catch (err) {
      // Extraction failures are the caller's problem to act on (try the extension, the page
      // is a PDF, the site blocked us), so they answer 400 with a stable code, not a 500.
      if (err instanceof LinkExtractionError) {
        return c.json({ error: err.message, code: err.code, url: err.url }, 400);
      }
      throw err;
    }
  });

  // Ingest a file, or a whole folder: directories are walked (bounded depth, hidden and
  // node_modules-style dirs skipped) and every supported file is added.
  app.post("/context/add", async (c) => {
    const body = await parseBody(c, contextAddSchema);
    if (!body.ok) return body.res;
    const target = resolve(body.data.path);
    const info = await stat(target).catch(() => null);
    if (!info) return c.json({ error: `no such file or directory: ${target}` }, 400);
    if (!info.isDirectory()) {
      try {
        return c.json(await memloom.contextAdd({ path: target }));
      } catch (err) {
        // A recording whose model was never downloaded, or a machine without ffmpeg, is a
        // setup step the caller has to take, so it answers 400 with its code like
        // /context/url does. The folder branch below already collects per-file failures.
        return audioFailure(c, err);
      }
    }

    const files = await collectSupportedFiles(target);
    if (files.length === 0) {
      return c.json(
        { error: `no supported files (${supportedExtensions().join(", ")}) under ${target}` },
        400,
      );
    }
    let added = 0;
    let unchanged = 0;
    let chunks = 0;
    let absorbed = 0;
    const errors: string[] = [];
    for (const file of files) {
      try {
        const r = await memloom.contextAdd({ path: file });
        chunks += r.chunks;
        absorbed += r.absorbed ?? 0;
        if (r.outcome === "unchanged") unchanged += 1;
        else added += 1; // "converted" counts as processed: an upload became a link
      } catch (err) {
        errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return c.json({
      outcome: "added",
      title: target,
      documents: added,
      unchanged,
      chunks,
      ...(absorbed > 0 ? { absorbed } : {}),
      ...(errors.length > 0 ? { errors } : {}),
    });
  });

  // The same ingest, streamed. Transcribing an hour of audio takes 8 to 11 minutes, which
  // is far past what a plain request can hold open without looking hung, so the media path
  // reports per decode chunk. Every other format finishes before it emits anything, which
  // is why this is an additional route rather than a replacement for /context/add.
  app.post("/context/add/stream", async (c) => {
    const body = await parseBody(c, contextAddSchema);
    if (!body.ok) return body.res;
    const target = resolve(body.data.path);
    const info = await stat(target).catch(() => null);
    if (!info) return c.json({ error: `no such file or directory: ${target}` }, 400);
    const files = info.isDirectory() ? await collectSupportedFiles(target) : [target];
    if (files.length === 0) {
      return c.json(
        { error: `no supported files (${supportedExtensions().join(", ")}) under ${target}` },
        400,
      );
    }

    // Both event shapes carry `stage`, so a consumer discriminates on one field instead of
    // guessing from which properties happen to be present.
    type FileDone = { stage: "file"; path: string; outcome: string; chunks: number };

    // One file in, one ContextAddResult out, exactly as /context/add answers. Clients type
    // this route's result as ContextAddResult, so returning only folder-shaped totals left
    // them holding an undefined `outcome`. A directory still reports totals, because there
    // is no single result to report.
    const single = !info.isDirectory();

    // Closing the stream cancels the work. Transcribing an hour takes 8 to 11 minutes, and
    // the common reason to stop is having picked the wrong file.
    return streamNdjson<ContextProgressEvent | FileDone>(c, async (emit, signal) => {
      let added = 0;
      let unchanged = 0;
      let chunks = 0;
      let lastResult: Awaited<ReturnType<typeof memloom.contextAdd>> | null = null;
      const errors: string[] = [];
      for (const file of files) {
        if (signal.aborted) break;
        try {
          const r = await memloom.contextAdd({ path: file }, emit, signal);
          lastResult = r;
          chunks += r.chunks;
          if (r.outcome === "unchanged") unchanged += 1;
          else added += 1;
          // A per-file completion line, so a folder of recordings reports as it goes
          // rather than only at the end.
          emit({ stage: "file", path: file, outcome: r.outcome, chunks: r.chunks });
        } catch (err) {
          errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // A single file that failed has only its failure to report, and a stream cannot go
      // back and change its status code, so it travels in band.
      //
      // On success the payload is a superset: the file's own ContextAddResult, which the CLI
      // reads `outcome` and `title` from, plus the same totals a folder reports, which the
      // viewer counts. One shape satisfying both beats making each caller guess which it got.
      if (single) {
        if (!lastResult) return { error: errors[0] ?? `could not ingest ${target}` };
        return { ...lastResult, documents: added, unchanged, chunks };
      }
      return {
        documents: added,
        unchanged,
        chunks,
        ...(errors.length > 0 ? { errors } : {}),
      };
    });
  });

  // Open the OS-native file/folder dialog and return the chosen absolute paths. 501 when
  // the platform has no picker (headless Linux without zenity); the viewer then falls
  // back to the in-app /context/browse panel.
  const pickPaths = opts.pickPaths ?? nativePick;
  app.post("/context/pick", async (c) => {
    const body = await parseBody(c, z.object({ mode: z.enum(["file", "folder"]).default("file") }));
    if (!body.ok) return body.res;
    const paths = await pickPaths(body.data.mode);
    if (paths === null) {
      return c.json({ error: "no native file picker available on this system" }, 501);
    }
    return c.json({ paths });
  });

  // Server-side filesystem listing for the viewer's file/folder picker (the browser never
  // sees absolute paths from its own file inputs). Directory names only, no file reads.
  app.get("/context/browse", async (c) => {
    const supported = new Set(supportedExtensions());
    const dir = resolve(c.req.query("path")?.trim() || homedir());
    let list: { name: string; path: string; kind: "dir" | "file" }[];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      list = entries
        .filter((e) => !e.name.startsWith("."))
        .map((e) => ({
          name: e.name,
          path: join(dir, e.name),
          kind: e.isDirectory() ? ("dir" as const) : ("file" as const),
        }))
        .filter((e) => e.kind === "dir" || supported.has(extname(e.name).toLowerCase()))
        .sort((a, b) =>
          a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
        );
    } catch {
      return c.json({ error: `cannot read directory: ${dir}` }, 400);
    }
    const parent = dirname(dir);
    return c.json({ path: dir, parent: parent === dir ? null : parent, entries: list });
  });

  app.get("/context/documents", async (c) => c.json({ documents: await memloom.contextList() }));

  // Drill-down for an expanded document node in the viewer: chunks + chunk-level edges.
  app.get("/context/documents/:id/chunks", async (c) =>
    c.json(await memloom.contextChunks(c.req.param("id"))),
  );

  // Open the source file with the OS default app. Only paths already ingested by the owner
  // can be opened: the id lookup is the gate; no arbitrary path ever reaches the opener.
  const openPath = opts.openPath ?? platformOpen;
  app.post("/context/documents/:id/open", async (c) => {
    const id = c.req.param("id");
    const doc = (await memloom.contextList()).find((d) => d.id === id);
    if (!doc) return c.json({ error: `no context document ${id}` }, 404);
    if (doc.path.startsWith("upload://")) {
      return c.json({ error: "this document was uploaded from the browser; no file on disk" }, 400);
    }
    openPath(doc.path);
    return c.json({ ok: true });
  });

  app.delete("/context/documents/:id", async (c) => {
    await memloom.contextRemove(c.req.param("id"));
    return c.json({ ok: true });
  });

  // Speech models. Outside the store probe on purpose: transcription is set up before
  // anything has been ingested, and a locked store has no bearing on a download.
  app.get("/audio/models", async (c) => {
    try {
      return c.json(await audioCatalog());
    } catch (err) {
      // MEMLOOM_ASR_MODEL can pin an id that is no longer in the catalog, which is a
      // configuration mistake to report rather than an outage.
      return audioFailure(c, err);
    }
  });

  app.post("/audio/select", async (c) => {
    const body = await parseBody(c, audioSelectSchema);
    if (!body.ok) return body.res;
    try {
      const model = await selectModel(body.data.id);
      const status = await modelStatus();
      return c.json({ ok: true, selected: model.id, installed: status.installed });
    } catch (err) {
      return audioFailure(c, err);
    }
  });

  // The default model is a 465 MB download, so this streams rather than holding a request
  // open in silence: a line per stage, and a line per whole percent while bytes arrive.
  app.post("/audio/setup/stream", async (c) => {
    const body = await parseBody(c, audioSetupSchema);
    if (!body.ok) return body.res;
    const id = body.data.id;
    // Checked BEFORE the stream opens. Once the response is a 200 stream, every failure can
    // only be an in-band error line, and an unknown id deserves a real status code.
    if (id !== undefined) {
      try {
        findModel(id);
      } catch (err) {
        return audioFailure(c, err);
      }
    }
    // Both shapes carry `stage`, so a consumer discriminates on one field rather than
    // guessing from which properties happen to be present.
    type StageEvent = { stage: "stage"; message: string };
    type DownloadEvent = {
      stage: "download";
      file: string;
      receivedBytes: number;
      totalBytes: number | null;
      percent: number | null;
    };
    return streamNdjson<StageEvent | DownloadEvent>(c, async (emit) => {
      // 465 MB arrives as thousands of chunks and a progress bar can only use whole
      // percents, so anything finer is bytes on the wire for nothing. When the server
      // declares no length there is no percent to throttle on, so one line per 5 MB keeps
      // the bar moving instead of freezing after the first event.
      let last = "";
      await setupModels({
        ...(id ? { modelId: id } : {}),
        onStage: (message) => emit({ stage: "stage", message }),
        onProgress: ({ file, receivedBytes, totalBytes }) => {
          const percent = totalBytes ? Math.floor((receivedBytes / totalBytes) * 100) : null;
          const key = `${file}:${percent ?? Math.floor(receivedBytes / 5_000_000)}`;
          if (key === last) return;
          last = key;
          emit({ stage: "download", file, receivedBytes, totalBytes, percent });
        },
      });
      // The same payload GET /audio/models serves, so a client re-renders its picker from
      // the done event instead of following up with another request.
      return audioCatalog();
    });
  });

  // The viewer bundle, mounted last so every API route wins first. Unknown paths fall back to
  // index.html (the shell handles them). Standard single-page-app serving.
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
      console.error(`${new Date().toISOString()}  ✖ ${c.req.method} ${c.req.path}: ${message}`);
    return c.json({ error: message }, 500);
  });

  return app;
}

/** Start the server on localhost. Returns the underlying node server handle. */
export function serve(memloom: Memloom, port = 4319) {
  const app = createServer(memloom);
  return nodeServe({ fetch: app.fetch, port, hostname: "127.0.0.1" });
}
