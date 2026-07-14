import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { detectKind, type Memory, supportedExtensions } from "@memloom/core";
import { configPath, dataDir, ensureConfig, memloomHome } from "./config.js";
import { connect } from "./connect.js";
import { startDaemon } from "./daemon.js";

/** "from setup.md › Guide > Postgres (p. 3)" for context-chunk recall results. */
function describeSource(m: Memory): string | null {
  if (!m.source) return null;
  const parts = [`from ${m.source.title}`];
  if (m.source.headingPath) parts.push(`› ${m.source.headingPath}`);
  if (m.source.page != null) parts.push(`(p. ${m.source.page})`);
  return parts.join(" ");
}

// A path argument may be a file or a directory: directories are scanned recursively for
// extensions the extractor registry supports; everything else is ignored.
function collectContextFiles(path: string): string[] {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    return readdirSync(path)
      .filter((name) => name !== "node_modules" && !name.startsWith("."))
      .flatMap((name) => collectContextFiles(join(path, name)));
  }
  return detectKind(path) ? [path] : [];
}

// Best-effort browser open; the printed URL is the fallback on exotic setups.
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  spawn(cmd, args as string[], { detached: true, stdio: "ignore" }).unref();
}

const HELP = `memloom: a memory engine you own, running on your machine

Usage: memloom <command> [args]

  serve                run the store daemon (HTTP API + viewer + Postgres wire). The single owner.
  stop                 stop the running daemon gracefully (releases the store cleanly)
  ui                   open the viewer (graph, conflicts, console) in your browser
  init                 ensure the daemon is running and the store is ready
  save <text...>       save a memory
  recall <text...>     recall memories AND context by meaning
  update <id> <text>   edit a memory into a new version (keeps the old one in history)
  history <id>         show a memory's full version chain (newest first)
  index [--rebuild]    extract entities from unindexed memories and context chunks;
                       --rebuild wipes all extracted entities/edges and re-runs from scratch
  conflicts            list pending conflicts
  context add <path>   ingest files (or a directory) as context: ${supportedExtensions().join(" ")}
  context list         list ingested context documents
  context remove <id>  remove a context document and its chunks
  schema               show the graph vocabulary (entity types + predicates, usage, status)
  schema delete <entity_type|predicate> <name>
                       permanently remove a DISABLED user-tier entry (disable it first;
                       built-in entries can only be disabled)
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

    case "ui": {
      await connect(); // make sure the daemon (which serves the viewer) is up
      const url = "http://127.0.0.1:4319";
      openBrowser(url);
      console.log(`viewer: ${url}`);
      return;
    }

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
      const extra = result.version
        ? `  v${result.version}`
        : result.conflictId
          ? `  conflict=${result.conflictId}`
          : "";
      console.log(`${result.outcome}  ${result.id}${extra}`);
      return;
    }

    case "recall": {
      const query = rest.join(" ").trim();
      if (!query) throw new Error("usage: memloom recall <text>");
      const engine = await connect();
      const results = await engine.recall(query);
      if (results.length === 0) console.log("(no memories)");
      for (const m of results) {
        console.log(`[sim ${(m.similarity ?? 0).toFixed(2)}]  ${m.content}`);
        const source = describeSource(m);
        if (source) console.log(`            ${source}`);
      }
      return;
    }

    case "update": {
      const [id, ...text] = rest;
      const content = text.join(" ").trim();
      if (!id || !content) throw new Error("usage: memloom update <memory-id> <text>");
      const engine = await connect();
      const result = await engine.update({ id, content });
      console.log(`updated ${result.id}  v${result.version}`);
      return;
    }

    case "history": {
      const id = rest[0];
      if (!id) throw new Error("usage: memloom history <memory-id>");
      const engine = await connect();
      const versions = await engine.history(id);
      if (versions.length === 0) console.log("(no history)");
      for (const v of versions) {
        const marker = v.status === "active" ? "*" : " ";
        console.log(`${marker} v${v.version}  ${v.assertedAt}  ${v.content}`);
      }
      return;
    }

    case "context": {
      const [sub, ...args] = rest;
      const engine = await connect();

      if (sub === "add") {
        const targets = args.map((a) => resolve(a));
        if (targets.length === 0) throw new Error("usage: memloom context add <path...>");
        const files = targets.flatMap(collectContextFiles);
        if (files.length === 0) {
          console.log(`no ingestible files found (${supportedExtensions().join(", ")}).`);
          return;
        }
        for (const file of files) {
          const result = await engine.contextAdd({ path: file });
          console.log(`${result.outcome.padEnd(9)}  ${result.title}  (${result.chunks} chunks)`);
        }
        return;
      }

      if (sub === "list") {
        const documents = await engine.contextList();
        if (documents.length === 0) console.log("(no context documents)");
        for (const d of documents) {
          console.log(`${d.id}  [${d.kind}]  ${d.title}  ${d.chunkCount} chunks\n  ${d.path}`);
        }
        return;
      }

      if (sub === "remove") {
        const id = args[0];
        if (!id) throw new Error("usage: memloom context remove <document-id>");
        await engine.contextRemove(id);
        console.log(`removed ${id}`);
        return;
      }

      throw new Error("usage: memloom context <add|list|remove>");
    }

    case "index": {
      const engine = await connect();
      const rebuild = rest.includes("--rebuild");
      const progress = (e: {
        index: number;
        total: number;
        kind: string;
        label: string;
        entities: string[];
        relationships?: number;
        skipped?: string;
        error?: string;
      }) => {
        const outcome = e.error
          ? `FAILED: ${e.error}`
          : e.skipped
            ? `(skipped: ${e.skipped})`
            : e.entities.length > 0
              ? e.entities.join(", ") +
                (e.relationships ? `  (+${e.relationships} relationships)` : "")
              : "(no entities)";
        console.log(`[${e.index}/${e.total}] ${e.kind.padEnd(6)} ${e.label}  ->  ${outcome}`);
      };
      const { indexed, chunksIndexed } = rebuild
        ? await engine.reindex(undefined, progress)
        : await engine.index(undefined, progress);
      console.log(`indexed ${indexed} memories, ${chunksIndexed} context chunks`);
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

    case "schema": {
      const [sub, ...args] = rest;
      const engine = await connect();

      if (sub === undefined || sub === "list") {
        const schema = await engine.describeSchema();
        const line = (e: { name: string; tier: string; status: string; count: number }) => {
          const marks = [e.tier === "user" ? "user" : "", e.status === "disabled" ? "disabled" : ""]
            .filter(Boolean)
            .join(", ");
          const used = e.count > 0 ? `${e.count} in graph` : "unused";
          console.log(`  ${e.name.padEnd(22)} ${used}${marks ? `  [${marks}]` : ""}`);
        };
        console.log(`entity types (${schema.entityTypes.length})`);
        for (const e of schema.entityTypes) line(e);
        console.log(`\npredicates (${schema.predicates.length})`);
        for (const p of schema.predicates) line(p);
        if (schema.proposals.length > 0) {
          console.log(`\nproposals pending review: ${schema.proposals.length} (see the viewer)`);
        }
        return;
      }

      if (sub === "delete") {
        const [kind, name] = args;
        if ((kind !== "entity_type" && kind !== "predicate") || !name) {
          throw new Error("usage: memloom schema delete <entity_type|predicate> <name>");
        }
        const schema = await engine.describeSchema();
        const pool = kind === "entity_type" ? schema.entityTypes : schema.predicates;
        const entry = pool.find((e) => e.name === name.toLowerCase());
        if (!entry) throw new Error(`no ${kind} named "${name}"`);
        await engine.deleteSchemaEntry(entry.id);
        console.log(`deleted ${kind} "${entry.name}"`);
        return;
      }

      throw new Error("usage: memloom schema [list|delete]");
    }

    default:
      console.error(`unknown command: ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

export { connect } from "./connect.js";
