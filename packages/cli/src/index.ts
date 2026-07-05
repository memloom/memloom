import { serve } from "@memloom/server";
import { openStore, storeDir } from "./config.js";
import { runPgServer } from "./pg.js";

const HELP = `memloom — a memory engine you own, running on your machine

Usage: memloom <command> [args]

  init                 create the local store (${"~/.memloom"}) and run migrations
  save <text...>       save a memory
  recall <text...>     recall memories by meaning
  index                extract entities from unindexed memories
  conflicts            list pending conflicts
  serve [port]         run the local HTTP server (default 4319)
  pg [port]            serve the store over Postgres for a DB client (default 5432)
  help                 show this help

Set OPENROUTER_API_KEY for real embeddings + LLM dedup/entities. Without it, memloom runs
in offline mode (deterministic embeddings, no dedup) — good for populating and inspecting.

Store location: ${storeDir()}`;

export async function run(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;

    case "init": {
      const store = await openStore();
      console.log(`memloom store ready at ${storeDir()}${store.offline ? "  (offline mode)" : ""}`);
      await store.close();
      return;
    }

    case "save": {
      const content = rest.join(" ").trim();
      if (!content) throw new Error("usage: memloom save <text>");
      const store = await openStore();
      const result = await store.memloom.save({ content });
      console.log(
        `${result.outcome}  ${result.id}${result.conflictId ? `  conflict=${result.conflictId}` : ""}`,
      );
      await store.close();
      return;
    }

    case "recall": {
      const query = rest.join(" ").trim();
      if (!query) throw new Error("usage: memloom recall <text>");
      const store = await openStore();
      const results = await store.memloom.recall(query);
      if (results.length === 0) console.log("(no memories)");
      for (const m of results) {
        console.log(`[sim ${(m.similarity ?? 0).toFixed(2)}]  ${m.content}`);
      }
      await store.close();
      return;
    }

    case "index": {
      const store = await openStore();
      const { indexed } = await store.memloom.index();
      console.log(`indexed ${indexed} memories`);
      await store.close();
      return;
    }

    case "conflicts": {
      const store = await openStore();
      const conflicts = await store.memloom.conflicts();
      if (conflicts.length === 0) console.log("no pending conflicts");
      for (const c of conflicts) {
        console.log(`\nconflict ${c.id}`);
        console.log(`  NEW:      ${c.incoming.content}`);
        for (const cand of c.candidates) console.log(`  EXISTING: ${cand.content}`);
      }
      await store.close();
      return;
    }

    case "serve": {
      const port = rest[0] ? Number(rest[0]) : 4319;
      const store = await openStore(); // held for the server's lifetime (do not close)
      serve(store.memloom, port);
      console.log(`memloom server on http://127.0.0.1:${port}  (Ctrl+C to stop)`);
      return;
    }

    case "pg": {
      const port = rest[0] ? Number(rest[0]) : 5432;
      await runPgServer(port);
      return;
    }

    default:
      console.error(`unknown command: ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}
