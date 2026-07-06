import { configPath, dataDir, ensureConfig, memloomHome } from "./config.js";
import { connect } from "./connect.js";
import { startDaemon } from "./daemon.js";

const HELP = `memloom — a memory engine you own, running on your machine

Usage: memloom <command> [args]

  serve                run the store daemon (HTTP API + Postgres wire). The single owner.
  stop                 stop the running daemon gracefully (releases the store cleanly)
  init                 ensure the daemon is running and the store is ready
  save <text...>       save a memory
  recall <text...>     recall memories by meaning
  index                extract entities from unindexed memories
  conflicts            list pending conflicts
  help                 show this help

The CLI and the MCP talk to the daemon over HTTP, so many clients share one store safely.
Any command auto-starts the daemon if it isn't running. Inspect the data by pointing Drizzle
Studio / psql at the daemon's Postgres wire: postgresql://postgres@127.0.0.1:54329/postgres

Configuration lives in ${configPath()} (created by init). Set OPENROUTER_API_KEY there for
real embeddings + LLM dedup/entities; restart the daemon after changing it.
Home: ${memloomHome()}  ·  data: ${memloomHome()}/data`;

export async function run(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;

    case "serve":
      await startDaemon();
      return; // runs until Ctrl+C

    case "stop": {
      try {
        const res = await fetch("http://127.0.0.1:4319/admin/shutdown", {
          method: "POST",
          signal: AbortSignal.timeout(3000),
        });
        console.log(res.ok ? "memloom daemon stopped." : `daemon answered ${res.status}.`);
      } catch {
        console.log("no daemon running on http://127.0.0.1:4319.");
      }
      return;
    }

    case "init": {
      const config = ensureConfig(); // create ~/.memloom + config.env template first
      await connect(); // starts the daemon if needed
      console.log(`memloom is running. data: ${dataDir()}`);
      console.log(`config: ${config}  (set OPENROUTER_API_KEY there, then restart the daemon)`);
      console.log(
        "HTTP api http://127.0.0.1:4319 · Postgres postgresql://postgres@127.0.0.1:54329/postgres",
      );
      return;
    }

    case "save": {
      const content = rest.join(" ").trim();
      if (!content) throw new Error("usage: memloom save <text>");
      const engine = await connect();
      const result = await engine.save({ content });
      console.log(
        `${result.outcome}  ${result.id}${result.conflictId ? `  conflict=${result.conflictId}` : ""}`,
      );
      return;
    }

    case "recall": {
      const query = rest.join(" ").trim();
      if (!query) throw new Error("usage: memloom recall <text>");
      const engine = await connect();
      const results = await engine.recall(query);
      if (results.length === 0) console.log("(no memories)");
      for (const m of results) console.log(`[sim ${(m.similarity ?? 0).toFixed(2)}]  ${m.content}`);
      return;
    }

    case "index": {
      const engine = await connect();
      const { indexed } = await engine.index();
      console.log(`indexed ${indexed} memories`);
      return;
    }

    case "conflicts": {
      const engine = await connect();
      const conflicts = await engine.conflicts();
      if (conflicts.length === 0) console.log("no pending conflicts");
      for (const c of conflicts) {
        console.log(`\nconflict ${c.id}`);
        console.log(`  NEW:      ${c.incoming.content}`);
        for (const cand of c.candidates) console.log(`  EXISTING: ${cand.content}`);
      }
      return;
    }

    default:
      console.error(`unknown command: ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

export { connect } from "./connect.js";
