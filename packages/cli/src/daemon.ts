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
import { storeDir } from "./config.js";

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

  const dir = storeDir();
  const release = await acquireDataDirLock(dir);
  const db = await PGlite.create({ dataDir: dir, extensions: { vector } });
  const storage = PgliteAdapter.fromInstance(db);

  const apiKey = process.env.OPENROUTER_API_KEY;
  const memloom = apiKey
    ? new Memloom({
        storage,
        embedding: new OpenRouterEmbeddings({ apiKey }),
        llm: new OpenRouterLLM({ apiKey }),
      })
    : new Memloom({
        storage,
        embedding: new HashingEmbeddingProvider(1024),
        llm: new NullLLMProvider(),
        dedup: false,
      });
  await memloom.init();

  const httpServer = nodeServe({
    fetch: createServer(memloom, { log: true }).fetch,
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
  console.log(`  store      ${dir}`);
  if (!apiKey)
    console.log(
      "  mode       offline (no OPENROUTER_API_KEY): deterministic embeddings, dedup off",
    );
  console.log("Ctrl+C to stop.");

  const shutdown = async () => {
    await pgServer.stop();
    httpServer.close();
    await db.close();
    await release();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
