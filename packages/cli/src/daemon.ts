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
  const llmModel = process.env.OPENROUTER_LLM_MODEL;

  const memloom = apiKey
    ? new Memloom({
        storage,
        embedding: new OpenRouterEmbeddings({
          apiKey,
          ...(embedModel ? { model: embedModel } : {}),
          ...(embedDims ? { dims: embedDims } : {}),
        }),
        llm: new OpenRouterLLM({ apiKey, ...(llmModel ? { model: llmModel } : {}) }),
      })
    : new Memloom({
        storage,
        embedding: new HashingEmbeddingProvider(1024),
        llm: new NullLLMProvider(),
        dedup: false,
      });
  await memloom.init();

  const shutdown = async () => {
    await pgServer.stop();
    httpServer.close();
    await db.close();
    await release();
    process.exit(0);
  };

  const httpServer = nodeServe({
    fetch: createServer(memloom, { log: true, onShutdown: shutdown }).fetch,
    port: httpPort,
    hostname: "127.0.0.1",
  });
  const pgServer = new PGLiteSocketServer({ db, port: pgPort, host: "127.0.0.1" });
  await pgServer.start();

  console.log("memloom serving:");
  console.log(`  HTTP API   http://127.0.0.1:${httpPort}          (CLI + MCP route here)`);
  console.log(
    `  Postgres   postgresql://postgres@127.0.0.1:${pgPort}/postgres   (Drizzle Studio, psql)`,
  );
  console.log(`  data       ${dir}`);
  console.log(`  config     ${configPath()}`);
  if (apiKey) {
    console.log(
      `  mode       cloud (${embedModel ?? "qwen/qwen3-embedding-8b"} @ ${embedDims ?? 1024} dims, ${llmModel ?? "google/gemini-2.5-flash"})`,
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
