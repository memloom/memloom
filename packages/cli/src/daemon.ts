import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { serve as nodeServe } from "@hono/node-server";
import type { StorageAdapter } from "@memloom/core";
import {
  acquireDataDirLock,
  EmbeddingFingerprintError,
  Memloom,
  PgAdapter,
  PgliteAdapter,
} from "@memloom/core";
import { createServer } from "@memloom/server";
import { configPath, dataDir, ensureConfig, loadConfigEnv } from "./config.js";
import { buildEngineDeps } from "./engine-config.js";

export const HTTP_PORT = 4319;
// A distinctive port so it never collides with a local Postgres on 5432. It sits in the
// Windows ephemeral range, where Hyper-V/WSL2/Docker reserve random 100-port blocks at every
// boot, so a bind here can fail with EACCES through no fault of ours: MEMLOOM_PG_PORT moves it.
export const PG_PORT = 54329;

// Call only after loadConfigEnv(), so a port set in ~/.memloom/config.env is visible.
export function pgWirePort(): number {
  return Number(process.env.MEMLOOM_PG_PORT) || PG_PORT;
}

// `memloom serve`: the single owner of the store. Holds the one PGLite connection (lock, D1)
// and exposes it two ways from one process: the HTTP API (CLI + MCP route here) and the
// Postgres wire protocol (Drizzle Studio / TablePlus / psql). Everything else is a client, so
// there are no more "store already open" conflicts.
// Mask the password when echoing a connection URL to the console.
function maskPgUrl(url: string): string {
  return url.replace(/\/\/([^:@/]+):[^@]+@/, "//$1:***@");
}

async function alreadyServing(httpPort: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${httpPort}/health`, {
      signal: AbortSignal.timeout(600),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function startDaemon(httpPort = HTTP_PORT, pgPort?: number): Promise<void> {
  // Fail fast and clearly if a daemon already owns the port, instead of a silent bind error.
  if (await alreadyServing(httpPort)) {
    console.log(`memloom is already serving on http://127.0.0.1:${httpPort}.`);
    return;
  }

  // Config lives in ~/.memloom/config.env, the ONE place the key/models need to be set,
  // regardless of which process spawned the daemon. Real env vars win over the file.
  ensureConfig();
  loadConfigEnv();

  // Resolved after loadConfigEnv so MEMLOOM_PG_PORT works from ~/.memloom/config.env too,
  // not just a real env var. An explicit argument still wins.
  const wirePort = pgPort ?? pgWirePort();

  const deps = buildEngineDeps();
  const { apiKey, embedModel, embedDims, embedProvider, llmModel, chatModel, autoIndex, pgUrl } =
    deps;

  // Storage tier switch (MEMLOOM_PG_URL): an external Postgres gets the pooled adapter and
  // needs neither the data-dir lock nor the wire socket (inspect the server directly).
  // Default: the embedded PGLite dir, single-owner, guarded by the advisory lock.
  const dir = dataDir();
  let db: PGlite | undefined;
  let release: (() => Promise<void>) | undefined;
  let storage: StorageAdapter;
  if (pgUrl) {
    try {
      storage = await PgAdapter.connect(pgUrl);
    } catch (err) {
      console.error(
        `memloom: cannot reach Postgres at MEMLOOM_PG_URL: ${err instanceof Error ? err.message : String(err)}`,
      );
      console.error(`  url:    ${maskPgUrl(pgUrl)}`);
      console.error(`  config: ${configPath()}`);
      process.exitCode = 1;
      return;
    }
  } else {
    // waitMs rides out the stale window of a force-killed daemon's leftover lock (15s), so
    // "kill then serve" works instead of erroring on a lock that's about to expire.
    release = await acquireDataDirLock(dir, { waitMs: 20_000 });
    db = await PGlite.create({ dataDir: dir, extensions: { vector } });
    storage = PgliteAdapter.fromInstance(db);
  }

  const memloom = apiKey
    ? new Memloom({ storage, embedding: deps.embedding, llm: deps.llm, autoIndex })
    : new Memloom({ storage, embedding: deps.embedding, llm: deps.llm, dedup: false });
  try {
    await memloom.init();
  } catch (err) {
    // Most likely the embedding-fingerprint guard (store embedded under a different config).
    // Release everything so the next attempt isn't blocked by our lock.
    if (db) await db.close();
    else await storage.close();
    await release?.();
    console.error(`memloom: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof EmbeddingFingerprintError) {
      console.error(
        "  hint: run `memloom reembed` (with the daemon stopped) to migrate the store to the new embedding config.",
      );
    }
    console.error(pgUrl ? `  storage:  ${maskPgUrl(pgUrl)}` : `  data dir: ${dir}`);
    console.error(`  config:   ${configPath()}`);
    process.exitCode = 1;
    return;
  }

  const shutdown = async () => {
    await pgServer?.stop();
    httpServer.close();
    if (db) await db.close();
    else await storage.close();
    await release?.();
    process.exit(0);
  };

  // The viewer bundle ships inside this package (copied from apps/viewer at build time);
  // when present the daemon serves it at / so `memloom ui` is one process, one port.
  const viewerDir = fileURLToPath(new URL("../viewer", import.meta.url));
  const staticDir = existsSync(viewerDir) ? viewerDir : undefined;

  const httpServer = nodeServe({
    fetch: createServer(memloom, {
      log: true,
      onShutdown: shutdown,
      ...(staticDir ? { staticDir } : {}),
      // Mirrors OpenRouterLLM's own chat-model fallback chain, for the picker's label.
      ...(apiKey ? { defaultChatModel: chatModel ?? llmModel ?? "google/gemini-2.5-flash" } : {}),
    }).fetch,
    port: httpPort,
    hostname: "127.0.0.1",
  });
  // The wire socket is a PGLite-only concern: it exists so DB tools can inspect the embedded
  // store. On an external Postgres, tools connect to the server directly.
  let pgServer: PGLiteSocketServer | undefined;
  let wireError: string | undefined;
  if (db) {
    pgServer = new PGLiteSocketServer({ db, port: wirePort, host: "127.0.0.1" });
    // PGLite is single-connection: while a wire client (Drizzle Studio, psql) is attached it holds
    // an exclusive lock, and every HTTP API call silently queues behind it. Warn loudly, because
    // from the outside this looks like memloom hanging.
    const warnedClients = new Set<string>();
    pgServer.addEventListener("connection", (event) => {
      const info = (event as CustomEvent<{ clientAddress: string; clientPort: number }>).detail;
      // pglite-socket dispatches the connection event twice on the direct-attach path; warn once.
      const key = `${info.clientAddress}:${info.clientPort}`;
      if (warnedClients.has(key)) return;
      warnedClients.add(key);
      console.log(
        `${new Date().toISOString()}  ⚠ Postgres client connected (${key}). ` +
          "The HTTP API (Claude/MCP/CLI saves + recalls) is PAUSED until it disconnects; close Drizzle Studio/psql when done inspecting.",
      );
    });
    // The wire socket is a convenience for DB tools, not the product. A port that is taken or
    // blocked (on Windows, Hyper-V/WSL reserve blocks inside the ephemeral range) must not take
    // the HTTP API down with it, and must not strand the data-dir lock we already hold.
    try {
      await pgServer.start();
    } catch (err) {
      wireError = err instanceof Error ? err.message : String(err);
      pgServer = undefined;
    }
  }

  console.log("memloom serving:");
  console.log(`  HTTP API   http://127.0.0.1:${httpPort}          (CLI + MCP route here)`);
  if (staticDir) {
    console.log(`  Viewer     http://127.0.0.1:${httpPort}          (\`memloom ui\` opens it)`);
  }
  if (db && pgServer) {
    console.log(
      `  Postgres   postgresql://postgres@127.0.0.1:${wirePort}/postgres   (Drizzle Studio, psql)`,
    );
    console.log(`  data       ${dir}`);
  } else if (db) {
    console.log(`  Postgres   OFF, port ${wirePort} would not bind: ${wireError}`);
    console.log("             Set MEMLOOM_PG_PORT to a free port and restart to get it back.");
    console.log(`  data       ${dir}`);
  } else {
    console.log(
      `  storage    ${maskPgUrl(pgUrl ?? "")}   (external Postgres; inspect the server directly)`,
    );
  }
  console.log(`  config     ${configPath()}`);
  if (apiKey) {
    console.log(
      `  mode       cloud (${embedModel ?? "qwen/qwen3-embedding-8b"} @ ${embedDims ?? 1024} dims${embedProvider ? ` via ${embedProvider}` : ""}, ${llmModel ?? "google/gemini-2.5-flash"}, auto-index ${autoIndex ? "on" : "off"})`,
    );
  } else {
    console.log(
      "  mode       OFFLINE, no OPENROUTER_API_KEY (deterministic embeddings, dedup off).",
    );
    console.log(`             Set it in ${configPath()} and restart to enable real recall.`);
  }
  console.log("Ctrl+C to stop.");

  // The startup sweep: catch sessions the hook missed (daemon down at session end, a crash,
  // the fire-and-forget hook killed early). The ledger makes it cheap: up-to-date sessions
  // cost zero LLM calls, and the unattended daily budget bounds the rest. Only runs when
  // capture was configured via `memloom connect claude-code`.
  const sweep = setTimeout(async () => {
    try {
      const scope = await memloom.importScope();
      if (scope === null) return;
      const result = await memloom.importSessions({
        unattended: true,
        ...(scope === "all" ? {} : { projects: scope.projects }),
      });
      if (result.saved + result.versioned + result.conflicts > 0 || result.error) {
        console.log(
          `${new Date().toISOString()}  sweep: ${result.sessions} sessions, ` +
            `${result.saved} saved, ${result.versioned} versioned, ${result.conflicts} conflicts` +
            (result.error ? `  (stopped early: ${result.error})` : ""),
        );
      }
    } catch (err) {
      console.log(
        `${new Date().toISOString()}  sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, 3_000);
  sweep.unref?.();

  // The Notion poll: webhooks need a public endpoint, a localhost daemon polls instead.
  // Each tick is one search call when nothing changed (watermarks skip unchanged pages),
  // so the default 5 minutes is cheap. Silent unless something synced or failed; failures
  // also land in `memloom notion status`. Only runs when a token and a selection exist.
  const notionPollMs = Math.max(60_000, Number(process.env.NOTION_POLL_MS) || 300_000);
  let notionTickBusy = false;
  const notionTick = async () => {
    if (notionTickBusy || !process.env.NOTION_TOKEN) return;
    notionTickBusy = true;
    try {
      const scope = await memloom.notionScope();
      if (scope === null) return;
      const result = await memloom.notionSync({});
      if (result.added + result.updated > 0 || result.errors > 0) {
        console.log(
          `${new Date().toISOString()}  notion: ${result.added} new, ${result.updated} updated` +
            (result.errors > 0 ? `, ${result.errors} FAILED (${result.error})` : ""),
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A manual `memloom notion sync` holds the single-flight lock; that is not a failure.
      if (!message.includes("already running")) {
        console.log(`${new Date().toISOString()}  notion poll failed: ${message}`);
      }
    } finally {
      notionTickBusy = false;
    }
  };
  // First tick soon after start (edits made while the daemon was down), then the interval.
  const notionFirst = setTimeout(notionTick, 5_000);
  notionFirst.unref?.();
  const notionPoll = setInterval(notionTick, notionPollMs);
  notionPoll.unref?.();

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
