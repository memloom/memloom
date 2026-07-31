import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  AudioError,
  type ContextAddResult,
  detectKind,
  LinkExtractionError,
  type MemoryEngine,
  type MemoryType,
  mediaDurationSeconds,
  PASSAGE_CHARS,
  type ResolveDecision,
  supportedExtensions,
} from "@memloom/core";

// The MCP tool implementations, kept as pure functions over a Memloom so they're testable
// without an MCP transport. server.ts wires them to the protocol.

export async function saveMemory(
  memloom: MemoryEngine,
  args: { content: string; canonical?: string; type?: MemoryType },
): Promise<string> {
  const result = await memloom.save({
    content: args.content,
    ...(args.canonical ? { canonical: args.canonical } : {}),
    ...(args.type ? { memoryType: args.type } : {}),
  });
  if (result.outcome === "conflict") {
    return `Saved (id ${result.id}), but it CONTRADICTS an existing memory. Both are kept; the user should resolve conflict ${result.conflictId} (keep new / keep existing / keep both / merge).`;
  }
  if (result.outcome === "merged") {
    return `Already known: merged into memory ${result.id}, nothing duplicated.`;
  }
  return `Saved memory ${result.id}.`;
}

export async function recallMemory(
  memloom: MemoryEngine,
  args: { query: string; limit?: number },
): Promise<string> {
  const results = await memloom.recall(args.query, { limit: args.limit ?? 10 });
  if (results.length === 0) return "No memories found.";
  return results
    .map((m) => {
      // Title: the canonical form when the memory has one, else the content's first words.
      const title =
        m.canonical ?? (m.content.length > 60 ? `${m.content.slice(0, 57)}...` : m.content);
      const saved = new Date(m.createdAt).toISOString().slice(0, 16).replace("T", " ");
      // The same passage budget the viewer assistant uses: a markdown chunk is a whole
      // heading section (up to 16k chars), so a cut passage names the escape hatch.
      const passage =
        m.content.length > PASSAGE_CHARS
          ? `${m.content.slice(0, PASSAGE_CHARS)}... [truncated: call read_passage with id ${m.id} for the full text]`
          : m.content;
      const lines = [
        title,
        `- ${passage}`,
        `- saved ${saved} UTC`,
        `- similarity ${(m.similarity ?? 0).toFixed(2)}`,
      ];
      if (m.source) {
        // Context chunks carry provenance; always show where the text came from.
        const where = [
          `- from ${m.source.title}`,
          m.source.headingPath ? `› ${m.source.headingPath}` : "",
          m.source.page != null ? `(p. ${m.source.page})` : "",
        ]
          .filter(Boolean)
          .join(" ");
        lines.push(where);
      }
      // Every hit surfaces its id: memory_history looks up how a memory changed, and
      // read_passage fetches a truncated hit's full text (memories AND chunks).
      lines.push(`- id ${m.id}${!m.source && m.version > 1 ? ` (v${m.version})` : ""}`);
      return lines.join("\n");
    })
    .join("\n---\n");
}

/** The full text of one recall hit: the follow-up for a passage recall_memory truncated. */
export async function readPassage(memloom: MemoryEngine, args: { id: string }): Promise<string> {
  const content = await memloom.passage(args.id);
  if (content === null) {
    return `No memory or document passage with id ${args.id}. Use an id from recall_memory results.`;
  }
  return content;
}

// ---------------------------------------------------------------------------------------
// Ingestion: source material handed to memloom, stored as context documents
// ---------------------------------------------------------------------------------------

/**
 * How long a recording add_file will transcribe while the caller waits.
 *
 * Transcription runs at a measured real-time factor of 0.129 to 0.175 (see audio.ts), so
 * five minutes of media is 39 to 53 seconds of work plus a few seconds to load the model:
 * long enough to notice, short enough to sit inside the tool-call timeouts MCP clients
 * ship with. Anything longer is sent to the CLI, which streams progress, rather than
 * holding an agent's turn open for ten minutes with nothing to show.
 */
export const MAX_INLINE_MEDIA_SECONDS = 300;

export interface AddFileDeps {
  /** How long a media file is. Injected in tests; defaults to the ffprobe probe in core. */
  mediaSeconds?: (path: string) => Promise<number | null>;
}

/**
 * The stable code behind an ingest failure, from either kind of engine.
 *
 * bin.ts connects through `memloom serve`, so in production these tools hold an
 * HttpMemloomClient and every failure arrives as a plain Error carrying the daemon's JSON
 * body. An instanceof check alone passes in-process and then silently stops matching in the
 * only configuration that ships, so both shapes are read here. Null means the failure is not
 * one the daemon gave a code to, and the caller rethrows.
 */
function failureCode(err: unknown): string | null {
  if (err instanceof AudioError || err instanceof LinkExtractionError) return err.code;
  const message = err instanceof Error ? err.message : "";
  return /"code"\s*:\s*"([a-z_]+)"/.exec(message)?.[1] ?? null;
}

/** The daemon's own error text, unwrapped from the "memloom server 400: {...}" envelope. */
function failureMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const body = /^memloom server \d+: (.*)$/s.exec(raw)?.[1];
  if (body === undefined) return raw;
  try {
    return (JSON.parse(body) as { error?: string }).error ?? body;
  } catch {
    return body;
  }
}

/** One ingest result, said the same way whether the source was a page or a file. */
function describeIngest(result: ContextAddResult, source: string): string {
  const chunks = `${result.chunks} ${result.chunks === 1 ? "chunk" : "chunks"}`;
  switch (result.outcome) {
    case "unchanged":
      return `Already ingested and unchanged: "${result.title}" (${chunks}). Nothing was re-read or re-embedded.`;
    case "updated":
      return `Updated "${result.title}" (${chunks}): ${source} changed since it was last ingested, so its chunks were replaced.`;
    case "converted":
      return `Ingested ${result.path ?? source} as "${result.title}" (${chunks}), replacing an uploaded copy of it.`;
    case "exists":
      return `Already ingested as ${result.path ?? "another document"}: "${result.title}". Nothing was added.`;
    case "added":
      return `Ingested ${source} as the context document "${result.title}" (${chunks}). It is source material, not a memory; recall_memory will return its passages with a citation.`;
  }
}

/**
 * Save a web page as a context document. memloom fetches and parses it in the daemon, so
 * nothing about the page reaches a third party.
 */
export async function addLink(memloom: MemoryEngine, args: { url: string }): Promise<string> {
  try {
    return describeIngest(await memloom.contextAddUrl({ url: args.url }), args.url);
  } catch (err) {
    // Extraction failures are the caller's to act on (the page renders in a browser, it is a
    // PDF, the site refused us), so they are answered rather than thrown: an agent should
    // relay the reason and move on instead of retrying the same URL. Extraction is the only
    // coded failure /context/url produces, so a code here is always one of those.
    const code = failureCode(err);
    if (code) return `Could not save ${args.url}: ${failureMessage(err)} [${code}]`;
    throw err;
  }
}

/**
 * Ingest a local file as a context document. Media is refused past
 * MAX_INLINE_MEDIA_SECONDS rather than transcribed while the caller blocks.
 */
export async function addFile(
  memloom: MemoryEngine,
  args: { path: string },
  deps: AddFileDeps = {},
): Promise<string> {
  const path = resolve(args.path);
  const info = await stat(path).catch(() => null);
  if (!info) {
    return `No such file: ${path}. Pass an absolute path on the machine running memloom.`;
  }
  if (!info.isFile()) {
    return `${path} is not a file. A whole folder is a CLI job: memloom context add "${path}".`;
  }
  const kind = detectKind(path);
  if (!kind) {
    return `Cannot ingest ${basename(path)}: memloom reads ${supportedExtensions().join(", ")}.`;
  }

  if (kind === "audio" || kind === "video") {
    const seconds = await (deps.mediaSeconds ?? mediaDurationSeconds)(path);
    if (seconds !== null && seconds > MAX_INLINE_MEDIA_SECONDS) {
      const minutes = Math.round(seconds / 60);
      return (
        `${basename(path)} is about ${minutes} minutes long. Transcribing it takes roughly ` +
        `${Math.max(1, Math.round((minutes * 10) / 60))} minutes, which is too long to hold this tool call open. ` +
        "Ask the user to run: memloom context add " +
        `"${path}"\nThat streams progress, and if the file was transcribed before it finishes instantly. ` +
        "Once it is in, recall_memory reaches its passages the same way."
      );
    }
  }

  try {
    return describeIngest(await memloom.contextAdd({ path }), path);
  } catch (err) {
    // A missing speech model, a missing ffmpeg or a file ffmpeg cannot read all carry their
    // own fix in the message, so they are relayed rather than thrown as a tool failure.
    const code = failureCode(err);
    if (code) return `Could not ingest ${basename(path)}: ${failureMessage(err)} [${code}]`;
    throw err;
  }
}

/** What is already ingested, so an agent can check before re-adding something. */
export async function listDocuments(
  memloom: MemoryEngine,
  args: { filter?: string; limit?: number } = {},
): Promise<string> {
  const documents = await memloom.contextList();
  if (documents.length === 0) {
    return "No context documents yet. add_link saves a web page; add_file ingests a local file.";
  }
  const needle = args.filter?.trim().toLowerCase();
  const matched = needle
    ? documents.filter(
        (d) => d.title.toLowerCase().includes(needle) || d.path.toLowerCase().includes(needle),
      )
    : documents;
  if (matched.length === 0) {
    return `None of the ${documents.length} context documents match "${args.filter}".`;
  }
  const limit = args.limit ?? 50;
  const shown = matched.slice(0, limit);
  const lines = shown.map((d) => {
    const updated = new Date(d.updatedAt).toISOString().slice(0, 10);
    // The path is the identity a re-add is keyed on, so it leads rather than the id: an id
    // is not something add_link or add_file can be given.
    return `- ${d.title} [${d.kind}, ${d.chunkCount} ${d.chunkCount === 1 ? "chunk" : "chunks"}, updated ${updated}]\n  ${d.path}`;
  });
  if (matched.length > shown.length) {
    lines.push(`... and ${matched.length - shown.length} more; raise limit or narrow filter.`);
  }
  return lines.join("\n");
}

/**
 * The graph neighbourhood of one entity, rendered for an agent to read aloud.
 *
 * Stated relationships and co-mentions are printed as separate groups rather than one ranked
 * list: "Robert works_on memloom" is something the graph asserted, and "these two turn up
 * in the same nine memories" is not, and an agent relaying the answer should not present the
 * second as the first.
 */
export async function relatedEntities(
  memloom: MemoryEngine,
  args: { entity: string; type?: string; limit?: number },
): Promise<string> {
  const result = await memloom.relatedEntities(args.entity, {
    ...(args.type ? { entityType: args.type } : {}),
    ...(args.limit ? { limit: args.limit } : {}),
  });
  if (!result) {
    return `No entity matching "${args.entity}". Names are matched exactly (aliases included), not by meaning.`;
  }
  const { entity, matchedAlias, related, truncated } = result;
  const header = matchedAlias
    ? `${entity.name} (${entity.entityType}); "${matchedAlias}" is a known alias for it`
    : `${entity.name} (${entity.entityType})`;
  if (related.length === 0) {
    const scope = args.type ? ` of type ${args.type}` : "";
    return `${header}\nNothing${scope} is connected to it in the graph yet.`;
  }
  const stated = related.filter((r) => r.links.length > 0);
  const coOnly = related.filter((r) => r.links.length === 0);
  const describe = (r: (typeof related)[number]) => {
    const also = r.aliases.length > 0 ? ` (also: ${r.aliases.join(", ")})` : "";
    const links = r.links
      .map((l) => (l.direction === "out" ? `${l.relation} ->` : `<- ${l.relation}`))
      .join(", ");
    const shared = `${r.sharedSources} shared ${r.sharedSources === 1 ? "source" : "sources"}`;
    return `- ${r.name} [${r.entityType}]${also}${links ? `; ${links}` : ""}; ${shared}`;
  };
  const sections = [header];
  if (stated.length > 0) {
    sections.push("Stated relationships:", ...stated.map(describe));
  }
  if (coOnly.length > 0) {
    sections.push(
      "Appears together with (no relationship stated):",
      ...coOnly.map((r) => describe(r)),
    );
  }
  if (truncated > 0) sections.push(`... and ${truncated} more; raise limit to see them.`);
  return sections.join("\n");
}

export async function memoryHistory(
  memloom: MemoryEngine,
  args: { memoryId: string },
): Promise<string> {
  const versions = await memloom.history(args.memoryId);
  if (versions.length === 0) return "No such memory.";
  return versions
    .map((v) => {
      const when = new Date(v.assertedAt).toISOString().slice(0, 16).replace("T", " ");
      const marker = v.status === "active" ? "current" : "superseded";
      return `v${v.version} (${marker}, since ${when} UTC)\n- ${v.content}`;
    })
    .join("\n---\n");
}

export async function listConflicts(memloom: MemoryEngine): Promise<string> {
  const conflicts = await memloom.conflicts();
  if (conflicts.length === 0) return "No pending conflicts.";
  return conflicts
    .map(
      (c) =>
        `Conflict ${c.id}\n  NEW:      ${c.incoming.content}\n  EXISTING: ${c.candidates
          .map((x) => x.content)
          .join("; ")}`,
    )
    .join("\n\n");
}

export async function resolveConflict(
  memloom: MemoryEngine,
  args: {
    conflictId: string;
    action: "keep_new" | "keep_existing" | "keep_both" | "merge";
    candidateId?: string;
    content?: string;
  },
): Promise<string> {
  let decision: ResolveDecision;
  switch (args.action) {
    case "keep_existing":
      if (!args.candidateId) throw new Error("keep_existing requires candidateId");
      decision = { action: "keep_existing", candidateId: args.candidateId };
      break;
    case "merge":
      if (!args.content) throw new Error("merge requires the reconciled content");
      decision = { action: "merge", content: args.content };
      break;
    case "keep_new":
      decision = { action: "keep_new" };
      break;
    case "keep_both":
      decision = { action: "keep_both" };
      break;
  }
  await memloom.resolveConflict(args.conflictId, decision);
  return `Resolved conflict ${args.conflictId} with "${args.action}" (reversible).`;
}

export async function setSchemaEntryStatus(
  memloom: MemoryEngine,
  args: { kind: "entity_type" | "predicate"; name: string; status: "active" | "disabled" },
): Promise<string> {
  const schema = await memloom.describeSchema();
  const pool = args.kind === "entity_type" ? schema.entityTypes : schema.predicates;
  const entry = pool.find((e) => e.name === args.name.toLowerCase());
  if (!entry) return `No ${args.kind} named "${args.name}" exists.`;
  if (entry.status === args.status) {
    return `"${entry.name}" is already ${args.status}.`;
  }
  await memloom.setSchemaStatus(entry.id, args.status);
  return `${args.status === "disabled" ? "Disabled" : "Enabled"} ${args.kind} "${entry.name}".`;
}

export async function deleteSchemaEntry(
  memloom: MemoryEngine,
  args: { kind: "entity_type" | "predicate"; name: string },
): Promise<string> {
  const schema = await memloom.describeSchema();
  const pool = args.kind === "entity_type" ? schema.entityTypes : schema.predicates;
  const entry = pool.find((e) => e.name === args.name.toLowerCase());
  if (!entry) return `No ${args.kind} named "${args.name}" exists.`;
  // Mirror the engine guards with readable answers instead of raw errors: the calling
  // agent should relay these to the user rather than retry.
  if (entry.tier === "system") {
    return `"${entry.name}" is a built-in ${args.kind}; it can be disabled but never deleted.`;
  }
  if (entry.status !== "disabled") {
    return `"${entry.name}" is still active. Disable it first (set_schema_entry_status), then delete.`;
  }
  await memloom.deleteSchemaEntry(entry.id);
  return `Deleted ${args.kind} "${entry.name}" from the vocabulary. Entities already extracted under it stay in the graph.`;
}
