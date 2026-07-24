import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  detectKind,
  type ImportStatus,
  MEMORY_TYPES,
  type Memory,
  type MemoryType,
  supportedExtensions,
} from "@memloom/core";
import { configPath, dataDir, ensureConfig, memloomHome } from "./config.js";
import { connect } from "./connect.js";
import { startDaemon } from "./daemon.js";
import {
  claudeSettingsPath,
  hookInstalled,
  installHook,
  notifyDaemon,
  readNotifyPayload,
  removeHook,
} from "./hooks.js";
import { runImport } from "./import.js";
import { runReembed } from "./reembed.js";

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
  save <text...>       save a memory (--type fact|preference|episode|procedure)
  recall <text...>     recall memories AND context by meaning
  update <id> <text>   edit a memory into a new version (keeps the old one in history)
  history <id>         show a memory's full version chain (newest first)
  index [--rebuild]    extract entities from unindexed memories and context chunks;
                       --rebuild wipes all extracted entities/edges and re-runs from scratch
  reembed [--force]    re-embed the whole store with the currently configured embedding
                       provider (run after switching providers; daemon must be stopped)
  auto-index [on|off]  show or set background entity extraction after saves/ingests
  conflicts [auto]     list pending conflicts; auto resolves the obvious ones with the LLM
  import sessions      distill recent agent sessions into memories (--dry-run first)
  connect claude-code  capture future sessions automatically as they end (--project X | --all)
  disconnect claude-code  stop capturing; removes only memloom's hook
  status               daemon, capture scope, last hook activity, today's spend
  context add <path>   ingest files (or a directory) as context: ${supportedExtensions().join(" ")}
  context list         list ingested context documents
  context remove <id>  remove a context document and its chunks
  schema               show the graph vocabulary (entity types + predicates, usage, status)
  schema disable <entity_type|predicate> <name>
                       stop using an entry for future extraction (built-ins too)
  schema enable <entity_type|predicate> <name>
                       re-enable a disabled entry
  schema delete <entity_type|predicate> <name>
                       permanently remove a DISABLED user-tier entry (disable it first;
                       built-in entries can only be disabled)
  help [command]       show this help, or a command's own help (same as <command> --help)

The CLI and the MCP talk to the daemon over HTTP, so many clients share one store safely.
Any command auto-starts the daemon if it isn't running. Inspect the data by pointing Drizzle
Studio / psql at the daemon's Postgres wire: postgresql://postgres@127.0.0.1:54329/postgres

Configuration lives in ${configPath()} (created by init). Set OPENROUTER_API_KEY there for
real embeddings + LLM dedup/entities; restart the daemon after changing it.
Home: ${memloomHome()}
Data: ${dataDir()}`;

// Per-command help, printed by `<command> --help` and `help <command>`. Kept next to the
// implementations below; a new command is not done until it has an entry here.
const COMMAND_HELP: Record<string, string> = {
  serve: `memloom serve

Run the store daemon in the foreground: HTTP API on 4319, the viewer, and (on the
embedded tier) the Postgres wire on 54329. With MEMLOOM_PG_URL set, the daemon runs
on your Postgres server instead and starts no wire bridge. The daemon is the single
owner of the store; every other command talks to it over HTTP (and auto-starts it
when needed). Ctrl+C to stop.

Reads ${configPath()} at startup; real environment variables win over the file.`,

  stop: `memloom stop

Stop the running daemon gracefully: closes the HTTP and Postgres servers and
releases the store lock. Prints a notice when no daemon is running.`,

  ui: `memloom ui

Open the viewer in your browser (starting the daemon first if needed):
graph, assistant, memories, documents, schema, conflicts, console.`,

  init: `memloom init

First-run setup: creates ~/.memloom with a commented config.env template and
starts the daemon. Set OPENROUTER_API_KEY in the config for real embeddings,
dedup, and entity extraction, then restart the daemon.`,

  save: `memloom save [--type <type>] <text...>

Save a memory. With an API key configured, the belief pipeline runs: an exact or
reworded duplicate merges or versions instead of duplicating, and a contradiction
keeps both memories active and reports a conflict id to resolve.

  memloom save "the staging database runs on Postgres"
  memloom save --type procedure "to release: bump VERSION, tag, push"

  --type   fact (default), preference, episode, or procedure. The same taxonomy
           the viewer filters by:
             fact        a stable truth ("the staging DB runs on Postgres")
             preference  how you like things done ("prefers pnpm over npm")
             episode     a time-bound event ("shipped the viewer on 2026-07-05")
             procedure   reusable how-to steps ("to release: bump, tag, push")

Outcomes: added | merged | versioned | conflict.`,

  recall: `memloom recall <text...>

Recall memories AND ingested files by meaning, exact keywords, and entities,
fused into one ranking. Results from files carry their source (file › section,
PDF page).

  memloom recall "staging database"
  memloom recall "ECONNREFUSED 54329"     (exact identifiers work well)`,

  update: `memloom update <memory-id> <text...>

Edit a memory into a new version. The old version stays in history; recall only
returns the current one. Get ids from recall output or the viewer.`,

  history: `memloom history <memory-id>

Show a memory's full version chain, newest first. The * marks the current
version. Any version's id works.`,

  index: `memloom index [--rebuild]

Extract entities from unindexed memories and context chunks into the graph (one
LLM call per item; needs an API key). Prints one line per item with the entities
found. With auto-index on (the default in cloud mode) new items are indexed in
the background and this command usually reports nothing pending.

  --rebuild   wipe extracted entities and their edges (mentions + relationships found
              in your content), then re-extract from scratch. Does not touch memories,
              conflicts, or the replaces/distinct edges from resolving them.`,

  reembed: `memloom reembed [--force]

Recompute every stored embedding with the embedding provider currently
configured in ${configPath()}, then stamp the store with the new fingerprint.
Run this after switching providers or models, e.g. after adding
OPENROUTER_API_KEY to leave offline mode: without it the daemon refuses to
start because old and new vectors live in incompatible spaces.

The daemon must be stopped first (memloom stop); reembed opens the store
directly. Interrupting is safe: memories and files are never touched, only
their vectors, and running the command again resumes where it stopped.
Costs one embedding API call per 64 items.

  --force   re-embed even when the store already matches the configured
            provider and nothing is missing`,

  import: `memloom import sessions [--agent claude-code] [--dry-run] [--force] [--days N] [--sessions N] [--project <name>]

Distill your agent's session transcripts into typed, searchable memories.
Claude Code (~/.claude/projects) is the only supported agent today and the
default. Each session is redacted (best-effort secret scrubbing), distilled by
your configured LLM, and saved through the belief pipeline, so duplicates merge
and contradictions become reviewable conflicts. Every imported memory keeps
provenance: which session and lines it came from.

Bounded by default: sessions modified in the last 14 days, newest first, at most
20. Skipped sessions are announced; widen with the flags. Re-running is cheap:
a ledger tracks what was already distilled and only new session content is
processed. Needs an API key; offline mode cannot distill.

  memloom import sessions --dry-run     what would be processed, zero LLM calls
  memloom import sessions               the real run, with a cost summary
  memloom import sessions --project myapp --days 60

  --agent X    which agent's sessions (default and only option: claude-code)
  --dry-run    list sessions and chunk counts; makes no LLM calls, writes nothing
  --force      reprocess from scratch, ignoring the ledger
  --days N     widen the day window (default 14)
  --sessions N raise the session cap (default 20)
  --project X  only sessions whose project folder name contains X`,

  connect: `memloom connect claude-code (--project <name> ... | --all)

Capture sessions automatically: a session-end hook is added to your Claude Code
settings, and each finished session is distilled into memories by the daemon in
the background. The hook is a thin notifier; if the daemon is down when a
session ends, the next daemon start sweeps the gap, so nothing is lost.

Capture scope is an allowlist and it is EMPTY by default: nothing is captured
until you name it. That is deliberate. The hook fires for every project on this
machine, including ones whose code should never reach an LLM provider.

  memloom connect claude-code --project memloom --project my-app
  memloom connect claude-code --all

The edit to your Claude Code settings merges with your existing hooks and a
one-time backup is written next to the file first. Unattended distillation
runs against a daily call budget; when it is spent, capture pauses loudly in
memloom status and resumes the next day.`,

  disconnect: `memloom disconnect claude-code

Stop capturing sessions: removes memloom's entry from your Claude Code settings
(only memloom's; your own hooks are untouched) and clears the capture scope.
Already-imported memories stay.`,

  status: `memloom status

The capture dashboard: whether the daemon is up, whether the session-end hook
is installed, the capture scope, when the hook last fired and whether it
failed, today's unattended distillation spend against the daily budget, and
how much the ledger has imported in total.`,

  conflicts: `memloom conflicts [auto]

List pending contradictions (first 5): the new memory and the existing ones it
clashes with. Resolve them in the viewer (Conflicts tab) or over MCP; every
resolution is reversible.

  auto   re-judge every pending conflict with an LLM that also sees when each
         memory was recorded and the transcript excerpt it came from. Decisive
         verdicts are applied (one LLM call per conflict, all revertable);
         anything the model is unsure about stays pending for you.`,

  context: `memloom context <add|list|remove>

  add <path...>   ingest files or folders as searchable context
                  (${supportedExtensions().join(" ")}; folders recurse)
  list            ingested documents with ids and chunk counts
  remove <id>     delete a document and its chunks (the file on disk is untouched)

Re-adding an unchanged file is a no-op; a changed file replaces its chunks.`,

  schema: `memloom schema [list|disable|enable|delete]

  (no args)                          the extraction vocabulary with usage counts
  disable <entity_type|predicate> <name>
                                     stop using an entry for future extraction.
                                     Entities already extracted under it stay in
                                     the graph. Works on built-ins and user-tier
                                     entries alike.
  enable <entity_type|predicate> <name>
                                     re-enable a disabled entry.
  delete <entity_type|predicate> <name>
                                     permanently remove a DISABLED user-tier
                                     entry. Built-ins can only be disabled, and
                                     an active entry must be disabled first
                                     (schema disable).`,

  "auto-index": `memloom auto-index [on|off]

Show or set background entity extraction. When on, new memories and files are
indexed a few seconds after they land (debounced into batched runs, visible in
the Console). The setting persists across daemon restarts; MEMLOOM_AUTO_INDEX in
config.env is only the default before the first use of this switch. Needs an
API key; offline mode cannot enable it.

  memloom auto-index        show the current state
  memloom auto-index off    index only via 'memloom index' / the Console`,
};

export async function run(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;

  // `<command> --help` prints that command's help without touching the daemon.
  if (command && (rest.includes("--help") || rest.includes("-h"))) {
    console.log(COMMAND_HELP[command] ?? HELP);
    return;
  }

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h": {
      const topic = rest[0];
      console.log(topic && COMMAND_HELP[topic] ? COMMAND_HELP[topic] : HELP);
      return;
    }

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
      console.log(
        `config: ${config}  (set OPENROUTER_API_KEY there, then: memloom stop && memloom reembed && memloom serve)`,
      );
      console.log("HTTP api http://127.0.0.1:4319");
      console.log("Postgres postgresql://postgres@127.0.0.1:54329/postgres");
      return;
    }

    case "save": {
      // --type=episode or --type episode; everything else is the memory text.
      const words = [...rest];
      let memoryType: MemoryType | undefined;
      const flagAt = words.findIndex((w) => w === "--type" || w.startsWith("--type="));
      if (flagAt !== -1) {
        const flag = words[flagAt] ?? "";
        const value = flag.includes("=") ? flag.slice(flag.indexOf("=") + 1) : words[flagAt + 1];
        words.splice(flagAt, flag.includes("=") ? 1 : 2);
        if (!value || !(MEMORY_TYPES as readonly string[]).includes(value)) {
          throw new Error(`--type must be one of: ${MEMORY_TYPES.join(", ")}`);
        }
        memoryType = value as MemoryType;
      }
      const content = words.join(" ").trim();
      if (!content) throw new Error("usage: memloom save [--type <type>] <text>");
      const engine = await connect();
      const result = await engine.save({ content, ...(memoryType ? { memoryType } : {}) });
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
          const extras = [
            result.outcome === "converted"
              ? result.rechunked
                ? "replaced the uploaded snapshot, re-chunked"
                : "replaced the uploaded snapshot, chunks kept"
              : "",
            result.absorbed
              ? `removed ${result.absorbed} duplicate upload${result.absorbed === 1 ? "" : "s"}`
              : "",
          ]
            .filter(Boolean)
            .join("; ");
          console.log(
            `${result.outcome.padEnd(9)}  ${result.title}  (${result.chunks} chunks)` +
              (extras ? `  [${extras}]` : ""),
          );
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

    case "import": {
      const [source, ...args] = rest;
      // "claude-code" is a quiet alias from before the rename; not documented.
      if (source !== "sessions" && source !== "claude-code") {
        throw new Error(
          "usage: memloom import sessions [--agent claude-code] [--dry-run] [--force] [--days N] [--sessions N] [--project <name>]",
        );
      }
      const engine = await connect();
      await runImport(engine, args);
      return;
    }

    case "connect": {
      const [source, ...args] = rest;
      if (source !== "claude-code") {
        throw new Error("usage: memloom connect claude-code (--project <name> ... | --all)");
      }
      const projects: string[] = [];
      let all = false;
      const words = [...args];
      while (words.length > 0) {
        const word = words.shift() as string;
        if (word === "--all") all = true;
        else if (word === "--project" || word.startsWith("--project=")) {
          const value = word.includes("=") ? word.slice(word.indexOf("=") + 1) : words.shift();
          if (!value) throw new Error("--project needs a value");
          projects.push(value);
        } else
          throw new Error(
            `unknown flag ${word}. usage: memloom connect claude-code (--project <name> ... | --all)`,
          );
      }
      // The allowlist is empty by default on purpose: naming the scope is the consent step.
      if (!all && projects.length === 0) {
        throw new Error(
          "name what to capture: --project <name> (repeatable) or --all for every project. " +
            "Nothing is captured until you choose.",
        );
      }
      const engine = await connect();
      await engine.setImportScope(all ? "all" : { projects });
      const edit = installHook();
      if (edit.backupPath) console.log(`backed up your Claude Code settings to ${edit.backupPath}`);
      console.log(
        edit.changed
          ? `hook installed in ${claudeSettingsPath()}`
          : "hook was already installed; capture scope updated",
      );
      console.log(
        all
          ? "capturing: every project, as sessions end"
          : `capturing: ${projects.join(", ")} (sessions elsewhere are ignored)`,
      );
      console.log("check on it anytime with: memloom status");
      return;
    }

    case "disconnect": {
      const [source] = rest;
      if (source !== "claude-code") throw new Error("usage: memloom disconnect claude-code");
      const edit = removeHook();
      const engine = await connect();
      await engine.setImportScope(null);
      console.log(
        edit.changed
          ? "hook removed; your other hooks are untouched."
          : "no memloom hook was installed.",
      );
      console.log("capture scope cleared. Imported memories stay.");
      return;
    }

    case "status": {
      let daemonUp = true;
      let status: ImportStatus | null = null;
      try {
        const res = await fetch("http://127.0.0.1:4319/health", {
          signal: AbortSignal.timeout(600),
        });
        daemonUp = res.ok;
      } catch {
        daemonUp = false;
      }
      console.log(`daemon      ${daemonUp ? "running on http://127.0.0.1:4319" : "not running"}`);
      console.log(
        `hook        ${hookInstalled() ? `installed (${claudeSettingsPath()})` : "not installed"}`,
      );
      if (daemonUp) {
        const engine = await connect();
        status = await engine.importStatus();
      }
      if (!status) {
        console.log(
          "capture     unknown (start the daemon for scope, spend, and totals: memloom serve)",
        );
        return;
      }
      const scope =
        status.scope === null
          ? "off (memloom connect claude-code to enable)"
          : status.scope === "all"
            ? "all projects"
            : status.scope.projects.join(", ");
      console.log(`capture     ${scope}`);
      console.log(
        `last hook   ${status.lastNotifyAt ?? "never fired"}${status.lastNotifyError ? `  FAILED: ${status.lastNotifyError}` : ""}`,
      );
      console.log(
        `today       ${status.todayUnattendedCalls}/${status.unattendedDailyCap} unattended distillation calls${
          status.todayUnattendedCalls >= status.unattendedDailyCap ? "  (PAUSED at cap)" : ""
        }`,
      );
      console.log(
        `imported    ${status.sessionsImported} sessions, ${status.memoriesSaved} memories all-time`,
      );
      return;
    }

    // The hook's entry point: read the session-end payload, poke the daemon, exit 0 always.
    // Never auto-starts the daemon (a session ending must not spawn one) and never prints:
    // hook output would surface inside Claude Code as noise.
    case "notify": {
      const [source] = rest;
      if (source !== "claude-code") return;
      const path = await readNotifyPayload(process.stdin);
      if (path) await notifyDaemon(path);
      return;
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

    // No connect(): reembed opens the store directly and must NOT auto-start the daemon.
    case "reembed":
      await runReembed({ force: rest.includes("--force") });
      return;

    case "conflicts": {
      const engine = await connect();
      if (rest[0] === "auto") {
        const result = await engine.autoResolveConflicts(undefined, (e) => {
          const mark = e.verdict === "unsure" ? "left for you" : e.verdict.replace("_", " ");
          console.log(`[${e.index}/${e.total}] ${mark}: ${e.content}  (${e.reason})`);
        });
        console.log(
          `resolved ${result.resolved} of ${result.examined}: ` +
            `${result.keepNew} keep new, ${result.keepExisting} keep existing, ` +
            `${result.keepBoth} keep both; ${result.unsure} left for you`,
        );
        if (result.resolved > 0) {
          console.log("every auto-resolution is revertable from the viewer's conflicts tab.");
        }
        return;
      }
      const conflicts = await engine.conflicts();
      if (conflicts.length === 0) console.log("no pending conflicts");
      // A big queue would scroll the terminal into uselessness; show a page and point at
      // the tools that handle bulk.
      const shown = conflicts.slice(0, 5);
      for (const c of shown) {
        console.log(`\nconflict ${c.id}`);
        console.log(`  NEW:      ${c.incoming.content}`);
        for (const cand of c.candidates) console.log(`  EXISTING: ${cand.content}`);
      }
      if (conflicts.length > shown.length) {
        console.log(
          `\n...and ${conflicts.length - shown.length} more pending. ` +
            "Browse them all in the viewer (memloom ui), or let the LLM take a pass: memloom conflicts auto",
        );
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
          console.log(`\nproposals pending review (${schema.proposals.length})`);
          for (const p of schema.proposals) {
            const kind = p.kind === "entity_type" ? "entity type" : "predicate";
            const finds = (p.examples ?? [])
              .map((e) =>
                e.entity ? e.entity : e.from && e.to ? `${e.from} ${p.name} ${e.to}` : "",
              )
              .filter(Boolean)
              .join(", ");
            console.log(
              `  ${p.name.padEnd(22)} ${kind}, suggested ${p.occurrences}x` +
                (finds ? `  will add: ${finds}` : ""),
            );
          }
          console.log("  approve or dismiss in the viewer (memloom ui, schema tab)");
        }
        return;
      }

      if (sub === "disable" || sub === "enable") {
        const [kind, name] = args;
        if ((kind !== "entity_type" && kind !== "predicate") || !name) {
          throw new Error(`usage: memloom schema ${sub} <entity_type|predicate> <name>`);
        }
        const schema = await engine.describeSchema();
        const pool = kind === "entity_type" ? schema.entityTypes : schema.predicates;
        const entry = pool.find((e) => e.name === name.toLowerCase());
        if (!entry) throw new Error(`no ${kind} named "${name}"`);
        await engine.setSchemaStatus(entry.id, sub === "disable" ? "disabled" : "active");
        console.log(`${sub}d ${kind} "${entry.name}"`);
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

      throw new Error("usage: memloom schema [list|disable|enable|delete]");
    }

    case "auto-index": {
      const arg = rest[0];
      if (arg !== undefined && arg !== "on" && arg !== "off") {
        throw new Error("usage: memloom auto-index [on|off]");
      }
      const engine = await connect();
      let state = await engine.getAutoIndex();
      if (!state.available) {
        console.log(
          "auto-index unavailable: extraction needs an LLM. Set OPENROUTER_API_KEY in " +
            `${configPath()} and restart the daemon.`,
        );
        return;
      }
      if (arg !== undefined) {
        await engine.setAutoIndex(arg === "on");
        state = await engine.getAutoIndex();
      }
      console.log(
        `auto-index ${state.enabled ? "on" : "off"}` +
          (arg === undefined
            ? ""
            : state.enabled
              ? "  (new memories and files are indexed in the background)"
              : "  (index manually with 'memloom index' or the Console)"),
      );
      return;
    }

    default:
      console.error(`unknown command: ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

export { connect } from "./connect.js";
