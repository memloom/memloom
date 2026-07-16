import { MEMORY_TYPES, type MemoryEngine } from "@memloom/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  deleteSchemaEntry,
  listConflicts,
  memoryHistory,
  readPassage,
  recallMemory,
  resolveConflict,
  saveMemory,
  setSchemaEntryStatus,
} from "./tools.js";

// Wire the tool functions to the MCP protocol. Descriptions tell the calling agent when to
// reach for each tool and how memloom behaves (dedup + human-in-the-loop conflicts).

export function buildServer(memloom: MemoryEngine): McpServer {
  const server = new McpServer({ name: "memloom", version: "0.1.0" });

  server.tool(
    "save_memory",
    "Save a durable memory the user owns. Set `type` to classify it: fact (a stable truth), " +
      "preference (how the user likes things), episode (a time-bound event or decision), or " +
      "procedure (reusable how-to steps); defaults to fact. memloom dedupes automatically and " +
      "flags contradictions instead of overwriting, so save what is worth remembering; the " +
      "response says if it created a conflict to resolve.",
    {
      content: z.string(),
      canonical: z.string().optional(),
      type: z.enum(MEMORY_TYPES).optional(),
    },
    async (args) => ({ content: [{ type: "text", text: await saveMemory(memloom, args) }] }),
  );

  server.tool(
    "recall_memory",
    "Recall the user's memories AND ingested context documents by meaning, ranked by hybrid " +
      "retrieval (semantic + exact keyword + entity). Exact identifiers like file paths, " +
      "config keys, or error codes make excellent queries. Document results say which file " +
      "and section they came from. Only active (non-superseded) memories are returned. Very " +
      "long results are truncated with a marker; read_passage fetches the full text by id.",
    { query: z.string(), limit: z.number().optional() },
    async (args) => ({ content: [{ type: "text", text: await recallMemory(memloom, args) }] }),
  );

  server.tool(
    "read_passage",
    "The full text of one recall_memory result, by the `id` shown with it. Call ONLY when " +
      "a result ended with a truncation marker and the answer may be in the cut part.",
    { id: z.string() },
    async (args) => ({ content: [{ type: "text", text: await readPassage(memloom, args) }] }),
  );

  server.tool(
    "memory_history",
    "Show how a memory changed over time: its full version chain, newest first, with the " +
      "current version and every superseded one. Pass the `id` shown by recall_memory. Read-only: " +
      "editing memories is a human action in the viewer or CLI.",
    { memoryId: z.string() },
    async (args) => ({ content: [{ type: "text", text: await memoryHistory(memloom, args) }] }),
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

  server.tool(
    "set_schema_entry_status",
    "Enable or disable a graph schema entry (an entity type or predicate). A disabled entry " +
      "stops being used by future extraction, but entities already extracted under it stay " +
      "in the graph. Built-in entries can only be disabled, never deleted; user-defined " +
      "entries must be disabled before delete_schema_entry will remove them.",
    {
      kind: z.enum(["entity_type", "predicate"]),
      name: z.string(),
      status: z.enum(["active", "disabled"]),
    },
    async (args) => ({
      content: [{ type: "text", text: await setSchemaEntryStatus(memloom, args) }],
    }),
  );

  server.tool(
    "delete_schema_entry",
    "Permanently remove a DISABLED user-defined vocabulary entry (an entity type or " +
      "predicate) from the graph schema. Built-in entries can only be disabled, and an " +
      "active entry must be disabled before deletion; the response explains any refusal. " +
      "Entities already extracted under the deleted type stay in the graph.",
    {
      kind: z.enum(["entity_type", "predicate"]),
      name: z.string(),
    },
    async (args) => ({ content: [{ type: "text", text: await deleteSchemaEntry(memloom, args) }] }),
  );

  return server;
}
