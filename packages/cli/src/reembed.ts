import {
  Memloom,
  PgliteAdapter,
  type ReembedProgressEvent,
  storedEmbeddingDims,
} from "@memloom/core";
import { configPath, dataDir, ensureConfig, loadConfigEnv } from "./config.js";
import { HTTP_PORT } from "./daemon.js";
import { buildEngineDeps } from "./engine-config.js";

// `memloom reembed`: recompute every stored embedding with the provider currently configured
// in config.env, then stamp the store with its fingerprint. The offline half of switching
// embedding configs (the daemon refuses to start on a fingerprint mismatch and points here).
// Opens the store DIRECTLY, so the daemon must be stopped; the data-dir lock enforces that
// even if the health probe below races.

async function daemonIsRunning(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/health`, {
      signal: AbortSignal.timeout(600),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function runReembed(opts: { force: boolean }): Promise<void> {
  ensureConfig();
  loadConfigEnv();

  if (await daemonIsRunning()) {
    console.error(
      "a memloom daemon is running; stop it first (memloom stop). reembed needs exclusive store access.",
    );
    process.exitCode = 1;
    return;
  }

  const deps = buildEngineDeps();
  const storage = await PgliteAdapter.open({ dataDir: dataDir() });
  // Set AFTER close(): PGLite's WASM teardown resets process.exitCode, so setting it inside
  // the try/catch silently reports success on failure.
  let failed = false;
  try {
    // Column width check BEFORE init(): init runs pending migrations with the configured
    // dims, which must never happen against columns of a different width.
    const colDims = await storedEmbeddingDims(storage);
    if (colDims === null) {
      console.log("store is empty; nothing to re-embed. Just start the daemon (memloom serve).");
      return;
    }
    if (colDims !== deps.embedding.dims) {
      console.error(
        `store embeddings are vector(${colDims}) but the configured provider produces ` +
          `${deps.embedding.dims} dims ("${deps.embedding.fingerprint}").\n` +
          "Changing dimensions is not supported by reembed yet; set OPENROUTER_EMBED_DIMS=" +
          `${colDims} in ${configPath()}, or start fresh.`,
      );
      failed = true;
      return;
    }

    const engine = new Memloom({
      storage,
      embedding: deps.embedding,
      llm: deps.llm,
      dedup: false,
    });
    await engine.init({ fingerprint: "tolerate" });

    const [stored] = await storage.query<{ value: string }>(
      "SELECT value FROM _memloom_meta WHERE key = 'embedding_fingerprint'",
    );
    const [pending] = await storage.query<{
      memories: number;
      entities: number;
      chunks: number;
      messages: number;
    }>(
      `SELECT (SELECT count(*) FROM memory_objects)::int      AS memories,
              (SELECT count(*) FROM memory_entities)::int     AS entities,
              (SELECT count(*) FROM context_chunks)::int      AS chunks,
              (SELECT count(*) FROM assistant_messages)::int  AS messages`,
    );
    console.log(`store: ${stored?.value ?? "(unstamped)"}  ->  ${deps.embedding.fingerprint}`);

    // The counts line waits for the first progress event, so an up-to-date store doesn't
    // print "re-embedding ..." right before "nothing to do".
    let announced = false;
    const onProgress = (e: ReembedProgressEvent) => {
      if (!announced && pending) {
        announced = true;
        console.log(
          `re-embedding ${pending.memories} memories, ${pending.entities} entities, ` +
            `${pending.chunks} chunks, ${pending.messages} messages`,
        );
      }
      process.stdout.write(`\r${e.table.padEnd(9)} ${e.done}/${e.total}`);
      if (e.done >= e.total) process.stdout.write("\n");
    };
    const result = await engine.reembed({ force: opts.force, onProgress });
    if (result.outcome === "up-to-date") {
      console.log(
        `store already embedded with ${result.fingerprint} and nothing is missing; ` +
          "use --force to redo.",
      );
      return;
    }
    console.log(`done. store is now ${result.fingerprint}.`);
    // The offline-to-cloud migration has a step the user can't guess: extraction never ran
    // without an LLM, so the graph is empty until an index pass. Point at it only when it
    // applies (an LLM is configured and items are actually waiting).
    const [unindexed] = await storage.query<{ n: number }>(
      `SELECT ((SELECT count(*) FROM memory_objects WHERE status = 'active' AND indexed_at IS NULL)
             + (SELECT count(*) FROM context_chunks WHERE indexed_at IS NULL AND session_id IS NULL)
             )::int AS n`,
    );
    if (deps.apiKey && (unindexed?.n ?? 0) > 0) {
      console.log(
        `next: memloom serve, then memloom index to build the graph (${unindexed?.n} items pending).`,
      );
    } else {
      console.log("next: memloom serve.");
    }
  } catch (err) {
    console.error(`reembed failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error(
      "interrupting here is safe: run `memloom reembed` again to resume where it stopped.",
    );
    failed = true;
  } finally {
    await storage.close();
    if (failed) process.exitCode = 1;
  }
}
