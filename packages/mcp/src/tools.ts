import {
  type MemoryEngine,
  type MemoryType,
  PASSAGE_CHARS,
  type ResolveDecision,
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
