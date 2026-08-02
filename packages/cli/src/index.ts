import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  type ContextProgressEvent,
  type ReconcileReport,
  detectKind,
  type ImportStatus,
  isHttpUrl,
  MEMORY_TYPES,
  type Memory,
  type MemoryType,
  type PossibleContradiction,
  supportedExtensions,
} from "@memloom/core";
import { runAgentMemoryImport } from "./agent-memory.js";
import { configPath, dataDir, ensureConfig, loadConfigEnv, memloomHome } from "./config.js";
import { connect } from "./connect.js";
import { pgWirePort, startDaemon } from "./daemon.js";
import {
  ALL_HOOKS,
  claudeSettingsPath,
  hookInstalled,
  installHooks,
  notifyDaemon,
  PROMPT_RECALL_HOOK,
  readNotifyPayload,
  removeHooks,
  SESSION_END_HOOK,
} from "./hooks.js";
import { runImport } from "./import.js";
import {
  NOTION_USAGE,
  runNotionConnect,
  runNotionDisconnect,
  runNotionStatus,
  runNotionSync,
} from "./notion.js";
import { promptRecall } from "./recall-hook.js";
import { runReembed } from "./reembed.js";

/** "12:30" for a progress line, so a long transcription reads against the recording. */
function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/** "from setup.md › Guide > Postgres (p. 3)" for context-chunk recall results. */
function describeSource(m: Memory): string | null {
  if (!m.source) return null;
  const parts = [`from ${m.source.title}`];
  if (m.source.headingPath) parts.push(`› ${m.source.headingPath}`);
  if (m.source.page != null) parts.push(`(p. ${m.source.page})`);
  return parts.join(" ");
}

function tokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/**
 * A run's report. Repairs first (what the run acted on), then folds, then what it asked the
 * user, then what it only noticed, then what the contradiction pass would have spent. The last
 * line says whether anything changed and names the run, so undoing it never requires going and
 * looking the id up.
 */
export function formatReconcileReport(report: ReconcileReport): string {
  const dry = report.run.mode === "dry_run";
  const would = dry ? "would " : "";
  const retire = report.actions.filter((a) => a.kind === "retire");
  const folds = report.actions.filter((a) => a.kind === "fold");
  const questions = report.actions.filter((a) => a.kind === "question" && a.surfaced);
  // Pairs a model settled are named under arbitration below, so this is what the run put to
  // the user and left there.
  const arbitrated = new Set((report.arbitration?.settled ?? []).map((s) => s.conflictId));
  const raised = report.actions.filter(
    (a) => a.kind === "conflict" && !arbitrated.has(a.conflictId ?? ""),
  );
  const lines: string[] = [];

  lines.push(dry ? "reconcile (dry run)" : "reconcile");
  lines.push(`scanned ${report.run.scanned} active memories`, "");

  lines.push(retire.length === 0 ? "nothing to retire" : `${would}retire ${retire.length}:`);
  for (const action of retire.filter((a) => a.surfaced)) {
    lines.push(`  ${action.memoryId?.slice(0, 8)}  ${action.reason}`);
  }
  if (report.heldBack.retire > 0) {
    lines.push(`  ...and ${report.heldBack.retire} more, held back by this run's cap`);
  }

  // The entity pass reports counts on a dry run (nothing was folded, so there is nothing to
  // name) and one line per fold once it has actually run.
  if (report.entities) {
    const { merged, queued, deferred } = report.entities;
    lines.push("", "entities:");
    if (merged === 0 && queued === 0) lines.push("  no duplicate names found");
    if (merged > 0 && dry) lines.push(`  would fold ${merged} name variants (certain)`);
    for (const fold of folds) lines.push(`  ${fold.reason}`);
    if (queued > 0) {
      lines.push(`  ${queued} uncertain pairs ${dry ? "would go" : "went"} to the conflicts tab`);
    }
    if (deferred > 0) lines.push(`  ${deferred} more are waiting for that queue to drain`);
  }

  // What the paid passes did, when they are on. Their calls are the only thing a run spends,
  // so the count is part of the report rather than something to go and look up.
  if (report.arbitration) {
    const { calls, folded, rejected, unsure } = report.arbitration;
    lines.push("", `a model settled ${folded + rejected} uncertain pairs in ${calls} calls:`);
    lines.push(`  ${folded} folded, ${rejected} kept apart, ${unsure} left for you`);
  }
  // The re-check is the only pass that sweeps, so its report says what it cost and what it left.
  if (report.recheck) {
    const { calls, claimed, verified, remaining } = report.recheck;
    lines.push("", `contradiction re-check: swept ${calls} beliefs against their 20 nearest`);
    lines.push(`  kept ${verified} of ${claimed} the model claimed`);
    if (claimed > verified) {
      lines.push(
        `  ${claimed - verified} dropped: no verbatim quote for the clashing claim on both sides`,
      );
    }
    if (remaining > 0) lines.push(`  ${remaining} beliefs left for the next run`);
    if (verified > 0) lines.push("  waiting for you in the conflicts tab");
  }
  if (report.autoResolved) {
    const { examined, resolved } = report.autoResolved;
    lines.push("", `a model re-judged ${examined} pending conflicts and resolved ${resolved}`);
  }

  if (raised.length > 0) {
    lines.push("", `asked in the conflicts tab (${raised.length}):`);
    for (const action of raised) {
      const id = action.memoryId ? `${action.memoryId.slice(0, 8)}  ` : "";
      lines.push(`  ${id}${action.reason}`);
    }
    if (report.heldBack.conflict > 0) {
      lines.push(`  ...and ${report.heldBack.conflict} more, left for a later run`);
    }
  }

  if (questions.length > 0) {
    lines.push("", "noticed, not fixed:");
    for (const action of questions) {
      const id = action.memoryId ? `${action.memoryId.slice(0, 8)}  ` : "";
      lines.push(`  ${id}${action.reason}`);
    }
    if (report.heldBack.question > 0) {
      lines.push(`  ...and ${report.heldBack.question} more, held back so this stays readable`);
    }
  }

  // Priced only when the pass did not run, since a run that swept reports what it actually did.
  // A dry run always lands here, which is the point: the bill is stated before it can be spent.
  const { estimate } = report;
  if (!report.recheck) {
    lines.push("", `${estimate.window} memories are due a contradiction re-check`);
    if (estimate.window > 0) {
      const price = estimate.usd === null ? "" : `, about $${estimate.usd.toFixed(2)}`;
      lines.push(
        `  re-checking all of them would make ${estimate.llmCalls} LLM calls, about ` +
          `${tokens(estimate.inputTokens)} in / ${tokens(estimate.outputTokens)} out ` +
          `with ${estimate.model}${price}`,
        "  one run takes the 200 that have waited longest, so the backlog drains over several",
      );
    }
  }

  const changed = report.run.retired + report.run.folded;
  lines.push(
    "",
    dry || changed === 0
      ? `no memory was changed. this run is logged as ${report.run.id}`
      : `changed ${changed}. undo it all with: memloom reconcile undo ${report.run.id}`,
  );
  return lines.join("\n");
}

/**
 * The unconfirmed contradictions, one block each.
 *
 * The two quotes were verified against both memories when the finding was written, so they are
 * the whole question: reading them is faster than opening two beliefs and comparing them. The
 * precision warning leads because most of this list is wrong, and answering as if it were not
 * is how a real conflict queue fills with noise.
 */
export function formatPossibleContradictions(possible: PossibleContradiction[]): string {
  if (possible.length === 0) {
    return "no unconfirmed contradictions. the contradiction re-check pass raises them when it runs.";
  }
  const lines = [
    `${possible.length} unconfirmed ${possible.length === 1 ? "contradiction" : "contradictions"}. ` +
      "about 2 in 5 are real, so read both quotes before answering.",
  ];
  for (const p of possible) {
    const similarity =
      p.similarity === null
        ? "similarity unknown"
        : `similarity ${Math.round(p.similarity * 100)}%`;
    lines.push(
      "",
      `${similarity}${p.model ? `, judged by ${p.model}` : ""}`,
      `  NEW:      ${p.newQuote}`,
      `  EXISTING: ${p.oldQuote}`,
      `  why:      ${p.reason}`,
      `  id:       ${p.id}`,
    );
  }
  lines.push(
    "",
    "answer one with: memloom reconcile yes <id> (a real conflict) or memloom reconcile no <id> (never ask again)",
  );
  return lines.join("\n");
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
  reconcile                consolidation pass: repair, fold, and ask about the rest,
                       changing no memories and spending nothing
  reconcile possible       the unconfirmed contradictions it found; answer one with
                       reconcile yes <id> or reconcile no <id>
  import sessions      distill recent agent sessions into memories (--dry-run first)
  import agent-memory  bring in memories your agents already saved on disk (Claude Code
                       memory folders, Copilot); no distillation step
  connect claude-code  capture sessions as they end (--project X | --all) and recall
                       memories into every Claude Code prompt (--no-recall to skip)
  disconnect claude-code  stop capturing and recalling; removes only memloom's hooks
  status               daemon, hooks, capture scope, last hook activity, today's spend
  notion connect       pick Notion pages to sync as context (needs NOTION_TOKEN)
  notion sync          sync the selected Notion pages now (--dry-run | --force)
  notion status        Notion token, selection, last sync, synced documents
  notion disconnect    stop syncing Notion (synced documents stay)
  context add <target> ingest files, a directory, or a web page URL as context:
                       ${supportedExtensions().join(" ")} and http(s) links
  context list         list ingested context documents
  context remove <id>  remove a context document and its chunks
  audio models         the speech models you can transcribe with, and their sizes
  audio setup [id]     download a speech model, once per machine (default: 465 MB)
  audio use <id>       transcribe with a different model from now on
  audio status         which model is selected, what is installed, whether ffmpeg is found
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
(default port; MEMLOOM_PG_PORT moves it, and memloom serve prints the live one)

Configuration lives in ${configPath()} (created by init). Set OPENROUTER_API_KEY there for
real embeddings + LLM dedup/entities; restart the daemon after changing it.
Home: ${memloomHome()}
Data: ${dataDir()}`;

// Per-command help, printed by `<command> --help` and `help <command>`. Kept next to the
// implementations below; a new command is not done until it has an entry here.
const COMMAND_HELP: Record<string, string> = {
  serve: `memloom serve

Run the store daemon in the foreground: HTTP API on 4319, the viewer, and (on the
embedded tier) the Postgres wire on 54329 (MEMLOOM_PG_PORT moves it; if the port will
not bind the daemon says so and serves on without the wire). With MEMLOOM_PG_URL set,
the daemon runs on your Postgres server instead and starts no wire bridge. The daemon
is the single owner of the store; every command talks to it over HTTP (and auto-starts it
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
  --project X  only sessions whose project folder name contains X

memloom import agent-memory [--dry-run] [--force] [--agent <name>] [--project <name>]

Bring in the memories your agents already saved on disk. Claude Code keeps one
markdown file per memory under ~/.claude/projects/<project>/memory/; Copilot
keeps topic files in VS Code's globalStorage whose ## sections are memories.
Those files are distilled already, so there is no LLM extraction step: each
memory is redacted, embedded, and saved through the belief pipeline (dedup
classification and entity indexing still spend LLM calls), and keeps provenance
back to its file. Re-running is free for unchanged files (a content-hash ledger
skips them). Read-only: memloom never writes into the agents' folders.

  memloom import agent-memory --dry-run          what would be imported
  memloom import agent-memory                    the real run
  memloom import agent-memory --agent claude-code --project memloom

  --dry-run    list folders and memory counts; no provider calls, writes nothing
  --force      reimport everything, ignoring the content-hash ledger
  --agent X    only one agent: claude-code or copilot (repeatable)
  --project X  only Claude Code projects whose folder name contains X`,

  connect: `memloom connect claude-code (--project <name> ... | --all) [--no-recall]

Two hooks are added to your Claude Code settings.

Capture: a session-end hook notifies the daemon, and each finished session is
distilled into memories in the background. The hook is a thin notifier; if the
daemon is down when a session ends, the next daemon start sweeps the gap, so
nothing is lost.

Recall: a prompt-time hook injects the memories relevant to each prompt you
type, so Claude uses your memory without being told to search it. It is silent
when nothing relevant is found or the daemon is down, and it never blocks or
slows a prompt beyond a short timeout. --no-recall skips this hook (and removes
it if a previous connect installed it).

Capture scope is an allowlist and it is EMPTY by default: nothing is captured
until you name it. That is deliberate. The hooks fire for every project on this
machine, including ones whose code should never reach an LLM provider; recall
only reads your store, capture is what the allowlist gates.

  memloom connect claude-code --project memloom --project my-app
  memloom connect claude-code --all
  memloom connect claude-code --all --no-recall

The edit to your Claude Code settings merges with your existing hooks and a
one-time backup is written next to the file first. Unattended distillation
runs against a daily call budget; when it is spent, capture pauses loudly in
memloom status and resumes the next day.`,

  disconnect: `memloom disconnect claude-code

Stop capturing and recalling: removes memloom's hook entries from your Claude
Code settings (only memloom's; your own hooks are untouched) and clears the
capture scope. Already-imported memories stay.`,

  status: `memloom status

The capture dashboard: whether the daemon is up, which hooks are installed
(session-end capture, prompt-time recall), the capture scope, when the capture
hook last fired and whether it failed, today's unattended distillation spend
against the daily budget, and how much the ledger has imported in total.`,

  notion: `memloom notion <connect|sync|status|disconnect>

Sync selected Notion pages into memloom as context documents and keep them
fresh. Pages become recallable alongside your memories and files: your diary,
project notes, whatever you choose. No LLM extraction calls; sync costs only
embeddings, and only for pages that changed.

Setup once: create an internal integration at notion.so/profile/integrations,
share your pages with it (page menu, Connections), and start the daemon with
NOTION_TOKEN set. Then:

  memloom notion connect                   list visible pages, pick interactively
  memloom notion connect --page Diary      pick by title (or id); repeatable
  memloom notion connect --all             sync everything the integration sees
  memloom notion sync [--dry-run|--force]  sync now (the daemon also polls every
                                           5 minutes; NOTION_POLL_MS to change)
  memloom notion status                    token, selection, last sync, documents
  memloom notion disconnect                stop syncing; synced documents stay

Notion webhooks need a public HTTPS endpoint, so a local daemon polls instead.
Edits land within one poll interval.`,

  conflicts: `memloom conflicts [auto]

List pending contradictions (first 5): the new memory and the existing ones it
clashes with. Resolve them in the viewer (Conflicts tab) or over MCP; every
resolution is reversible.

  auto   re-judge every pending conflict with an LLM that also sees when each
         memory was recorded and the transcript excerpt it came from. Decisive
         verdicts are applied (one LLM call per conflict, all revertable);
         anything the model is unsure about stays pending for you.`,

  reconcile: `memloom reconcile [--dry-run]
       memloom reconcile possible
       memloom reconcile yes <id> | memloom reconcile no <id>
       memloom reconcile stop <run id>
       memloom reconcile undo <run id>
       memloom reconcile settings

The consolidation pass: memloom goes over its own store, repairs what it can
prove is wrong, folds duplicate entity names, and asks about the rest.

  --dry-run   report everything and change nothing
  possible    the unconfirmed contradictions the re-check found, with the two
              quotes that make each one answerable
  yes <id>    confirm one: it becomes a real conflict you can resolve
  no <id>     dismiss one: that pair is never raised again
  stop <id>   stop a run that is still going
  undo        put back exactly what one run did, and only that run
  settings    print which passes are on

What it repairs on its own, because SQL proves it and the undo is exact:
  duplicate content   two identical active memories (the older one is kept)
  superseded, live    a memory something replaced that is still being recalled
  entity variants     "Claude Code" and "claude-code" as two entities

What it only asks about, because the fix is a judgment call:
  live heads          one belief with more than one current version
  retired, no trail   a memory that is stale with nothing recording why
  entity invariants   folds the store half-applied

Retiring a memory means status 'stale', never deletion: it stops showing up in
recall, stays in its version history, and undo puts it back.

The contradiction re-check is right about 2 times in 5, so what it finds never
touches the conflict queue on its own. Each finding waits in "reconcile possible"
until you answer it: "yes" promotes it into a real conflict, "no" retires the
pair for good. A rejection is not waste, it is a labelled example of what you
do not consider a contradiction.

Two passes can use a model to resolve uncertain entity pairs and pending
contradictions. They cost money and are off until you turn them on in the
viewer's Settings tab. Set RECONCILE_ENABLED=0 to stop any run from acting at all.`,

  context: `memloom context <add|list|remove>

  add <target...> ingest files, folders, or web pages as searchable context
                  (${supportedExtensions().join(" ")}; folders recurse; http(s) URLs are fetched)
  list            ingested documents with ids and chunk counts
  remove <id>     delete a document and its chunks (the file on disk is untouched)

  memloom context add ./notes ./spec.pdf https://example.com/post

A page is fetched and parsed on this machine, never through a reader service, and is
stored under its own URL so citations link back to the heading they came from. A page
that renders in the browser (a single-page app, or anything behind a login) yields
little to a plain fetch and is reported rather than saved half-empty.

Re-adding unchanged content is a no-op; changed content replaces its chunks.`,

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

  audio: `memloom audio <models|setup|use|status>

Local speech-to-text for audio and video files. Everything runs on this machine:
ffmpeg normalizes the audio, silero finds the speech, and the selected model
transcribes it. Nothing is uploaded.

  memloom audio models          what you can choose from, with sizes and languages
  memloom audio setup           download the default (Parakeet v3, 465 MB)
  memloom audio setup <id>      download a specific one
  memloom audio use <id>        transcribe with it from now on
  memloom audio status          selected model, what is installed, ffmpeg

Models are shared across projects in ~/.memloom/models. Transcripts are cached by
file hash, so re-adding a recording costs nothing.

An hour of audio takes roughly 8 to 11 minutes on a recent laptop CPU. Progress
streams while "context add" runs. MEMLOOM_ASR_MODEL pins a model for one run.`,

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
      loadConfigEnv(); // so the wire URL we print reflects a MEMLOOM_PG_PORT override
      await connect(); // starts the daemon if needed
      console.log(`memloom is running. data: ${dataDir()}`);
      console.log(
        `config: ${config}  (set OPENROUTER_API_KEY there, then: memloom stop && memloom reembed && memloom serve)`,
      );
      console.log("HTTP api http://127.0.0.1:4319");
      console.log(`Postgres postgresql://postgres@127.0.0.1:${pgWirePort()}/postgres`);
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
        if (args.length === 0) throw new Error("usage: memloom context add <path-or-url...>");
        // A URL is not a path: it never touches resolve() or the directory walk.
        const urls = args.filter(isHttpUrl);
        const targets = args.filter((a) => !isHttpUrl(a)).map((a) => resolve(a));

        for (const url of urls) {
          try {
            const result = await engine.contextAddUrl({ url });
            console.log(
              `${result.outcome.padEnd(9)}  ${result.title}  (${result.chunks} chunks)\n  ${url}`,
            );
          } catch (err) {
            // One bad URL should not abandon the rest of the batch.
            console.error(`failed     ${url}\n  ${err instanceof Error ? err.message : err}`);
          }
        }

        const files = targets.flatMap(collectContextFiles);
        if (files.length === 0) {
          if (urls.length === 0) {
            console.log(`no ingestible files found (${supportedExtensions().join(", ")}).`);
          }
          return;
        }
        for (const file of files) {
          // Only media gets the streaming path. Everything else finishes before it would
          // emit anything, and asking for a stream would just add a second round trip.
          const kind = detectKind(file);
          const isMedia = kind === "audio" || kind === "video";
          let progress: ((event: ContextProgressEvent) => void) | undefined;

          if (isMedia) {
            const { modelStatus } = await import("@memloom/core");
            const status = await modelStatus();
            if (!status.installed) {
              console.error(
                `skipped    ${basename(file)}\n  ${status.selected.label} is not installed. ` +
                  "Run: memloom audio setup",
              );
              continue;
            }
            // Every stage prints, not only transcription. On a large recording the work
            // before the first word is minutes long, and a blank terminal for that stretch
            // is indistinguishable from a hang.
            progress = (event) => {
              const show = (line: string) =>
                process.stderr.write(`\r  ${basename(file)}: ${line}${" ".repeat(12)}`);
              const pct = () =>
                event.total > 0 ? ` ${Math.round((event.done / event.total) * 100)}%` : "";
              switch (event.stage) {
                case "hashing":
                  return show(
                    `reading the file${event.total > 0 ? ` (${Math.round(event.total / 1048576)} MB)` : ""}${pct()}`,
                  );
                case "decoding":
                  return show("extracting the audio track...");
                case "detecting":
                  return show(`finding speech${pct()}`);
                case "loading":
                  return show("loading the speech model...");
                case "diarizing":
                  return show(`telling the voices apart${pct()}`);
                case "checking":
                  return show("checking the transcript...");
                case "repairing":
                  return show(`re-checking a rough stretch at ${formatClock(event.seconds)}`);
                case "transcribing":
                  return show(
                    `transcribing ${formatClock(event.seconds)} of ${formatClock(event.audioSeconds)}${pct()}`,
                  );
                default:
                  return show(event.stage);
              }
            };
          }

          const result = await engine.contextAdd({ path: file }, progress);
          // Clear the progress line so the result is not printed onto it.
          if (isMedia) process.stderr.write(`\r${" ".repeat(72)}\r`);
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

    // Model management only, so it deliberately does not connect to the daemon: setting up
    // transcription should work before anything is running.
    case "audio": {
      const [sub, arg] = rest;
      const { CATALOG, hasFfmpeg, modelStatus, selectModel, setupModels } = await import(
        "@memloom/core"
      );

      if (sub === "models") {
        const status = await modelStatus();
        for (const m of CATALOG) {
          const marks = [
            m.id === status.selected.id ? "selected" : "",
            status.installedIds.includes(m.id) ? "installed" : `${m.downloadMb} MB download`,
          ].filter(Boolean);
          console.log(`${m.id.padEnd(15)} ${m.label}  [${marks.join(", ")}]`);
          console.log(`${" ".repeat(16)}${m.languages}`);
          console.log(`${" ".repeat(16)}${m.note}\n`);
        }
        console.log("memloom audio setup <id>   download one");
        console.log("memloom audio use <id>     transcribe with it from now on");
        return;
      }

      if (sub === "status") {
        const status = await modelStatus();
        console.log(`models     ${status.dir}`);
        console.log(`selected   ${status.selected.label} (${status.selected.id})`);
        console.log(`state      ${status.installed ? "installed" : "NOT installed"}`);
        console.log(`installed  ${status.installedIds.join(", ") || "(none)"}`);
        console.log(
          `speakers   ${status.speakersInstalled ? "installed (transcripts label who is speaking)" : "not installed; run: memloom audio setup"}`,
        );
        console.log(`ffmpeg     ${(await hasFfmpeg()) ? "found" : "NOT FOUND, install it first"}`);
        return;
      }

      if (sub === "use") {
        if (!arg) throw new Error("usage: memloom audio use <model-id>");
        const model = await selectModel(arg);
        const status = await modelStatus();
        console.log(`selected ${model.label}`);
        if (!status.installed) console.log(`not downloaded yet. Run: memloom audio setup ${arg}`);
        return;
      }

      if (sub === "setup") {
        let lastPercent = -1;
        const status = await setupModels({
          modelId: arg,
          onStage: (stage) => {
            process.stderr.write("\r          \r");
            console.log(stage);
            lastPercent = -1;
          },
          onProgress: ({ receivedBytes, totalBytes }) => {
            if (!totalBytes) return;
            const percent = Math.floor((receivedBytes / totalBytes) * 100);
            // Redrawing every chunk would flood a piped log; every whole percent is enough.
            if (percent === lastPercent) return;
            lastPercent = percent;
            process.stderr.write(`\r  ${percent}%`);
          },
        });
        process.stderr.write("\r          \r");
        console.log(`ready: ${status.selected.label} in ${status.dir}`);
        return;
      }

      throw new Error("usage: memloom audio <models|setup|use|status>");
    }

    case "notion": {
      const [sub, ...args] = rest;
      const engine = await connect();
      if (sub === "connect") await runNotionConnect(engine, args);
      else if (sub === "sync") await runNotionSync(engine, args);
      else if (sub === "status") await runNotionStatus(engine);
      else if (sub === "disconnect") await runNotionDisconnect(engine);
      else throw new Error(NOTION_USAGE);
      return;
    }

    case "import": {
      const [source, ...args] = rest;
      // "claude-code" is a quiet alias from before the sessions rename; not documented.
      if (source === "sessions" || source === "claude-code") {
        const engine = await connect();
        await runImport(engine, args);
        return;
      }
      if (source === "agent-memory") {
        const engine = await connect();
        await runAgentMemoryImport(engine, args);
        return;
      }
      throw new Error(
        "usage: memloom import <sessions|agent-memory> [flags]. " +
          "sessions distills transcripts (--agent claude-code); agent-memory brings in " +
          "memories your agents already saved on disk.",
      );
    }

    case "connect": {
      const [source, ...args] = rest;
      if (source !== "claude-code") {
        throw new Error("usage: memloom connect claude-code (--project <name> ... | --all)");
      }
      const projects: string[] = [];
      let all = false;
      let noRecall = false;
      const words = [...args];
      while (words.length > 0) {
        const word = words.shift() as string;
        if (word === "--all") all = true;
        else if (word === "--no-recall") noRecall = true;
        else if (word === "--project" || word.startsWith("--project=")) {
          const value = word.includes("=") ? word.slice(word.indexOf("=") + 1) : words.shift();
          if (!value) throw new Error("--project needs a value");
          projects.push(value);
        } else
          throw new Error(
            `unknown flag ${word}. usage: memloom connect claude-code (--project <name> ... | --all) [--no-recall]`,
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
      const edit = noRecall ? installHooks([SESSION_END_HOOK]) : installHooks(ALL_HOOKS);
      // --no-recall converges: it also removes a recall hook a previous connect installed.
      const removal = noRecall ? removeHooks([PROMPT_RECALL_HOOK]) : { changed: false, edited: [] };
      const backupPath = edit.backupPath ?? removal.backupPath;
      if (backupPath) console.log(`backed up your Claude Code settings to ${backupPath}`);
      const names = {
        "notify claude-code": "session-end capture",
        "prompt-recall claude-code": "prompt-time recall",
      };
      console.log(
        edit.changed
          ? `hooks installed in ${claudeSettingsPath()}: ${edit.edited.map((i) => names[i as keyof typeof names]).join(", ")}`
          : "hooks were already installed; capture scope updated",
      );
      if (removal.changed) console.log("prompt-time recall hook removed (--no-recall)");
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
      const edit = removeHooks(ALL_HOOKS);
      const engine = await connect();
      await engine.setImportScope(null);
      console.log(
        edit.changed
          ? "hooks removed; your other hooks are untouched."
          : "no memloom hooks were installed.",
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
        `hook        ${hookInstalled(SESSION_END_HOOK) ? `session-end capture installed (${claudeSettingsPath()})` : "session-end capture not installed"}`,
      );
      console.log(
        `recall      ${hookInstalled(PROMPT_RECALL_HOOK) ? "prompt-time recall installed" : "not installed (memloom connect claude-code adds it)"}`,
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

    // The UserPromptSubmit hook's entry point: recall memories for the prompt and print
    // them as context, or print nothing. Wrapped in its own catch: an error escaping to
    // bin.ts means exit 1 and stderr surfacing as noise on every prompt the user types.
    case "prompt-recall": {
      if (rest[0] !== "claude-code") return;
      try {
        const block = await promptRecall(process.stdin);
        if (block) console.log(block);
      } catch {
        // silence over blocking, always
      }
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

    case "reconcile": {
      const [sub, ...args] = rest;
      const id = args[0] ?? "";
      // Missing arguments are caught before connect(), so a typo never starts a daemon.
      if ((sub === "undo" || sub === "stop") && !id) {
        console.log(`usage: memloom reconcile ${sub} <run id>`);
        return;
      }
      if ((sub === "yes" || sub === "no") && !id) {
        console.log(`usage: memloom reconcile ${sub} <id>`);
        return;
      }
      const engine = await connect();

      // The subcommands come first: each takes an id, so none of them may be mistaken for a
      // mode flag.
      if (sub === "undo") {
        const result = await engine.revertReconcile(id);
        console.log(
          `restored ${result.restored} memories, unfolded ${result.unfolded} entities` +
            (result.skipped > 0 ? `, skipped ${result.skipped} the store moved on from` : ""),
        );
        return;
      }
      if (sub === "stop") {
        const { stopped } = await engine.stopReconcile(id);
        console.log(
          stopped
            ? `stopped run ${id}. what it already checked stays checked`
            : `run ${id} was not running, so nothing was stopped`,
        );
        return;
      }
      if (sub === "possible") {
        console.log(formatPossibleContradictions(await engine.possibleContradictions()));
        return;
      }
      if (sub === "yes" || sub === "no") {
        try {
          const answer = await engine.answerPossible(id, sub === "yes" ? "approved" : "rejected");
          console.log(
            answer.conflictId
              ? `confirmed. it is conflict ${answer.conflictId} now: resolve it in the viewer ` +
                  "(memloom ui) or over MCP"
              : "dismissed. that pair will never be raised again",
          );
        } catch (err) {
          // An id that was already answered, or one whose beliefs the store has moved on from,
          // is a stale copy-paste rather than a failure worth a stack trace.
          const message = err instanceof Error ? err.message : String(err);
          if (!/no unanswered/.test(message)) throw err;
          console.log(
            `nothing unconfirmed with id ${id}. list what is waiting: memloom reconcile possible`,
          );
        }
        return;
      }
      if (sub === "settings") {
        console.log(JSON.stringify(await engine.reconcileSettings(), null, 2));
        return;
      }
      const mode = rest.includes("--dry-run") ? "dry_run" : "apply";
      console.log(formatReconcileReport(await engine.reconcile({ mode, trigger: "manual" })));
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
