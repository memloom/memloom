import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { serve as nodeServe } from "@hono/node-server";
import {
  acquireDataDirLock,
  HashingEmbeddingProvider,
  Memloom,
  NullLLMProvider,
  OpenRouterEmbeddings,
  OpenRouterLLM,
  PgliteAdapter,
} from "@memloom/core";
import { createServer } from "@memloom/server";
import { configPath, dataDir, ensureConfig, loadConfigEnv } from "./config.js";

export const HTTP_PORT = 4319;
// A distinctive port so it never collides with a local Postgres on 5432.
export const PG_PORT = 54329;

// `memloom serve`: the single owner of the store. Holds the one PGLite connection (lock, D1)
// and exposes it two ways from one process — the HTTP API (CLI + MCP route here) and the
// Postgres wire protocol (Drizzle Studio / TablePlus / psql). Everything else is a client, so
// there are no more "store already open" conflicts.
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

export async function startDaemon(httpPort = HTTP_PORT, pgPort = PG_PORT): Promise<void> {
  // Fail fast and clearly if a daemon already owns the port, instead of a silent bind error.
  if (await alreadyServing(httpPort)) {
    console.log(`memloom is already serving on http://127.0.0.1:${httpPort}.`);
    return;
  }

  // Config lives in ~/.memloom/config.env — the ONE place the key/models need to be set,
  // regardless of which process spawned the daemon. Real env vars win over the file.
  ensureConfig();
  loadConfigEnv();

  const dir = dataDir();
  // waitMs rides out the stale window of a force-killed daemon's leftover lock (15s), so
  // "kill then serve" just works instead of erroring on a lock that's about to expire.
  const release = await acquireDataDirLock(dir, { waitMs: 20_000 });
  const db = await PGlite.create({ dataDir: dir, extensions: { vector } });
  const storage = PgliteAdapter.fromInstance(db);

  const apiKey = process.env.OPENROUTER_API_KEY;
  const embedModel = process.env.OPENROUTER_EMBED_MODEL;
  const embedDims = process.env.OPENROUTER_EMBED_DIMS
    ? Number(process.env.OPENROUTER_EMBED_DIMS)
    : undefined;
  // Prefer a specific OpenRouter host for embeddings (latency varies 20x between hosts of the
  // same model). Defaults to nebius for the default model (even when the config spells it out
  // explicitly) — mirrors OpenRouterEmbeddings.
  const embedProvider =
    process.env.OPENROUTER_EMBED_PROVIDER ??
    ((embedModel ?? "qwen/qwen3-embedding-8b") === "qwen/qwen3-embedding-8b"
      ? "nebius"
      : undefined);
  const llmModel = process.env.OPENROUTER_LLM_MODEL;

  const memloom = apiKey
    ? new Memloom({
        storage,
        embedding: new OpenRouterEmbeddings({
          apiKey,
          ...(embedModel ? { model: embedModel } : {}),
          ...(embedDims ? { dims: embedDims } : {}),
          ...(embedProvider ? { provider: embedProvider } : {}),
        }),
        llm: new OpenRouterLLM({ apiKey, ...(llmModel ? { model: llmModel } : {}) }),
      })
    : new Memloom({
        storage,
        embedding: new HashingEmbeddingProvider(1024),
        llm: new NullLLMProvider(),
        dedup: false,
      });
  try {
    await memloom.init();
  } catch (err) {
    // Most likely the embedding-fingerprint guard (store embedded under a different config).
    // Release everything so the next attempt isn't blocked by our lock.
    await db.close();
    await release();
    console.error(`memloom: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`  data dir: ${dir}`);
    console.error(`  config:   ${configPath()}`);
    process.exitCode = 1;
    return;
  }

  const shutdown = async () => {
    await pgServer.stop();
    httpServer.close();
    await db.close();
    await release();
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
    }).fetch,
    port: httpPort,
    hostname: "127.0.0.1",
  });
  const pgServer = new PGLiteSocketServer({ db, port: pgPort, host: "127.0.0.1" });
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
        "The HTTP API (Claude/MCP/CLI saves + recalls) is PAUSED until it disconnects — close Drizzle Studio/psql when done inspecting.",
    );
  });
  await pgServer.start();

  console.log("memloom serving:");
  console.log(`  HTTP API   http://127.0.0.1:${httpPort}          (CLI + MCP route here)`);
  if (staticDir) {
    console.log(`  Viewer     http://127.0.0.1:${httpPort}          (\`memloom ui\` opens it)`);
  }
  console.log(
    `  Postgres   postgresql://postgres@127.0.0.1:${pgPort}/postgres   (Drizzle Studio, psql)`,
  );
  console.log(`  data       ${dir}`);
  console.log(`  config     ${configPath()}`);
  if (apiKey) {
    console.log(
      `  mode       cloud (${embedModel ?? "qwen/qwen3-embedding-8b"} @ ${embedDims ?? 1024} dims${embedProvider ? ` via ${embedProvider}` : ""}, ${llmModel ?? "google/gemini-2.5-flash"})`,
    );
  } else {
    console.log(
      "  mode       OFFLINE — no OPENROUTER_API_KEY (deterministic embeddings, dedup off).",
    );
    console.log(`             Set it in ${configPath()} and restart to enable real recall.`);
  }
  console.log("Ctrl+C to stop.");

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
