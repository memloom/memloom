import { acquireDataDirLock } from "@memloom/core";
import { storeDir } from "./config.js";

// `memloom pg`: serve the local store over the real Postgres wire protocol so any client
// (Drizzle Studio, TablePlus, DataGrip, psql) can browse it. Takes the single-owner lock, so
// `memloom save` in another terminal correctly waits until this stops. PGLite + the socket
// server are imported lazily so the common CLI paths stay light.

export async function runPgServer(port = 5432): Promise<void> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");
  const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");

  const dir = storeDir();
  const release = await acquireDataDirLock(dir);
  const db = await PGlite.create({ dataDir: dir, extensions: { vector } });
  const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1" });
  await server.start();

  console.log("memloom store served at:");
  console.log(`  postgresql://postgres@127.0.0.1:${port}/postgres`);
  console.log("");
  console.log("Connect Drizzle Studio, TablePlus, DataGrip, or psql. Tables: memory_objects,");
  console.log("memory_entities, memory_edges, memory_dedup_decisions. Ctrl+C to stop.");

  const shutdown = async () => {
    await server.stop();
    await db.close();
    await release();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
