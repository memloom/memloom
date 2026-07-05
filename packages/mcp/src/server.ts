import type { Memloom } from "@memloom/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listConflicts, recallMemory, resolveConflict, saveMemory } from "./tools.js";

// Wire the tool functions to the MCP protocol. Descriptions tell the calling agent when to
// reach for each tool and how memloom behaves (dedup + human-in-the-loop conflicts).

export function buildServer(memloom: Memloom): McpServer {
  const server = new McpServer({ name: "memloom", version: "0.0.0" });

  server.tool(
    "save_memory",
    "Save a durable memory the user owns (a fact, preference, decision, or procedure). " +
      "memloom dedupes automatically and flags contradictions instead of overwriting, so just " +
      "save what is worth remembering; the response says if it created a conflict to resolve.",
    { content: z.string(), canonical: z.string().optional() },
    async (args) => ({ content: [{ type: "text", text: await saveMemory(memloom, args) }] }),
  );

  server.tool(
    "recall_memory",
    "Recall the user's memories by meaning, ranked by hybrid retrieval (semantic + exact " +
      "keyword + entity). Exact identifiers like file paths, config keys, or error codes make " +
      "excellent queries. Only active (non-superseded) memories are returned.",
    { query: z.string(), limit: z.number().optional() },
    async (args) => ({ content: [{ type: "text", text: await recallMemory(memloom, args) }] }),
  );

  server.tool(
    "list_conflicts",
    "List pending memory conflicts (contradictions the user has not resolved yet).",
    {},
    async () => ({ content: [{ type: "text", text: await listConflicts(memloom) }] }),
  );

  server.tool(
    "resolve_conflict",
    "Resolve a memory conflict. Actions: keep_new, keep_existing (needs candidateId), " +
      "keep_both, or merge (needs reconciled content). Every resolution is reversible.",
    {
      conflictId: z.string(),
      action: z.enum(["keep_new", "keep_existing", "keep_both", "merge"]),
      candidateId: z.string().optional(),
      content: z.string().optional(),
    },
    async (args) => ({ content: [{ type: "text", text: await resolveConflict(memloom, args) }] }),
  );

  return server;
}
