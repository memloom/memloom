import type { MemoryEngine, ResolveDecision } from "@memloom/core";

// The MCP tool implementations, kept as pure functions over a Memloom so they're testable
// without an MCP transport. server.ts wires them to the protocol.

export async function saveMemory(
  memloom: MemoryEngine,
  args: { content: string; canonical?: string },
): Promise<string> {
  const result = await memloom.save({
    content: args.content,
    ...(args.canonical ? { canonical: args.canonical } : {}),
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
      return [
        title,
        `- ${m.content}`,
        `- saved ${saved} UTC`,
        `- similarity ${(m.similarity ?? 0).toFixed(2)}`,
      ].join("\n");
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
