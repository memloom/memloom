import type { MemoryEngine, MemoryType, ResolveDecision } from "@memloom/core";

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
    return `Already known — merged into memory ${result.id}, nothing duplicated.`;
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
      const lines = [
        title,
        `- ${m.content}`,
        `- saved ${saved} UTC`,
        `- similarity ${(m.similarity ?? 0).toFixed(2)}`,
      ];
      if (m.source) {
        // Context chunks carry provenance — always show where the text came from.
        const where = [
          `- from ${m.source.title}`,
          m.source.headingPath ? `› ${m.source.headingPath}` : "",
          m.source.page != null ? `(p. ${m.source.page})` : "",
        ]
          .filter(Boolean)
          .join(" ");
        lines.push(where);
      } else {
        // A saved memory — surface its id (and version, if edited) so memory_history can look
        // up how it changed.
        lines.push(`- id ${m.id}${m.version > 1 ? ` (v${m.version})` : ""}`);
      }
      return lines.join("\n");
    })
    .join("\n---\n");
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

export async function deleteSchemaEntry(
  memloom: MemoryEngine,
  args: { kind: "entity_type" | "predicate"; name: string },
): Promise<string> {
  const schema = await memloom.describeSchema();
  const pool = args.kind === "entity_type" ? schema.entityTypes : schema.predicates;
  const entry = pool.find((e) => e.name === args.name.toLowerCase());
  if (!entry) return `No ${args.kind} named "${args.name}" exists.`;
  // Mirror the engine guards with readable answers instead of raw errors — the calling
  // agent should relay these to the user, not retry.
  if (entry.tier === "system") {
    return `"${entry.name}" is a built-in ${args.kind}; it can be disabled but never deleted.`;
  }
  if (entry.status !== "disabled") {
    return `"${entry.name}" is still active. Disable it first (viewer schema tab), then delete.`;
  }
  await memloom.deleteSchemaEntry(entry.id);
  return `Deleted ${args.kind} "${entry.name}" from the vocabulary. Entities already extracted under it stay in the graph.`;
}
