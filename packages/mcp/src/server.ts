import { MEMORY_TYPES, type MemoryEngine } from "@memloom/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  addFile,
  addLink,
  answerPossibleContradiction,
  deleteSchemaEntry,
  listConflicts,
  listDocuments,
  listPossibleContradictions,
  MAX_INLINE_MEDIA_SECONDS,
  memoryHistory,
  readPassage,
  recallMemory,
  relatedEntities,
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
    "add_link",
    "Save a web page into memloom permanently, as a CONTEXT DOCUMENT rather than a memory: " +
      "the page's own text, chunked and citable, kept next to the user's memories and " +
      "returned by recall_memory with the URL and section it came from. Reach for this the " +
      "moment a page is worth more than this conversation (documentation you just read, an " +
      "article the user shared, a spec you will need again), instead of pasting it into your " +
      "own notes. The daemon fetches and parses the page itself, so nothing about it reaches " +
      "a third party. Documents are versioned by content hash: re-adding an unchanged page " +
      "costs nothing and creates no duplicate, so calling this again is always safe. A page " +
      "that renders in the browser or sits behind a login answers with the reason instead of " +
      "a document; relay it rather than retrying.",
    { url: z.string() },
    async (args) => ({ content: [{ type: "text", text: await addLink(memloom, args) }] }),
  );

  server.tool(
    "add_file",
    "Ingest a file from the machine running memloom as a CONTEXT DOCUMENT (source material, " +
      "citable, chunked), not as a memory. Takes an absolute path. Handles markdown, text, " +
      "PDF, and audio or video, which is transcribed locally with timestamps so a recalled " +
      "line cites the moment it was said. Like add_link, documents are versioned by content " +
      "hash: re-adding an unchanged file is a cheap no-op, and an edited file replaces its " +
      "own chunks rather than piling up a second copy. Recordings longer than " +
      `${MAX_INLINE_MEDIA_SECONDS / 60} minutes are REFUSED with an instruction to relay, ` +
      "because transcribing an hour of audio takes 8 to 11 minutes and no tool call should " +
      "block that long. Whole folders are a CLI job (memloom context add <folder>).",
    { path: z.string() },
    async (args) => ({ content: [{ type: "text", text: await addFile(memloom, args) }] }),
  );

  server.tool(
    "list_documents",
    "The context documents already ingested: title, kind, chunk count and the path or URL " +
      "each came from. Call it before add_link or add_file when you want to know whether a " +
      "source is already in (re-adding is harmless, so this is for answering the user, not " +
      "for guarding the call), and to see what source material recall_memory can draw on. " +
      "`filter` matches a substring of the title or path; `limit` defaults to 50.",
    { filter: z.string().optional(), limit: z.number().optional() },
    async (args) => ({ content: [{ type: "text", text: await listDocuments(memloom, args) }] }),
  );

  server.tool(
    "related_entities",
    "Walk the memory GRAPH from one entity: who and what it is connected to. Use for " +
      'questions about connections rather than content ("which people are related to X", ' +
      '"what does X work on"), where recall_memory would return prose you still have to ' +
      "read. `entity` is a name, an id, or a known alias, matched exactly rather than by " +
      "meaning; a folded-away spelling resolves to its canonical entity and the answer says " +
      "so. Filter with `type` (person, organization, project, tool, technology, agent, " +
      "place, event, concept). Relationships the graph actually asserted are listed " +
      "separately from entities that merely appear in the same memories.",
    {
      entity: z.string(),
      type: z.string().optional(),
      limit: z.number().optional(),
    },
    async (args) => ({ content: [{ type: "text", text: await relatedEntities(memloom, args) }] }),
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
    "list_possible_contradictions",
    "List UNCONFIRMED possible contradictions: pairs of memories that memloom's consolidation " +
      "pass thinks clash, each with a verbatim quote from both sides and the reason a model gave. " +
      "These are NOT conflicts and they are NOT facts about the store. The pass runs at roughly " +
      "40 percent precision, so most of what this returns is wrong. Treat each one as a question " +
      "for the user: show it, let them decide, and answer it with " +
      "answer_possible_contradiction using the id shown. Do not work through the list on your " +
      "own unless the user asked you to.",
    {},
    async () => ({
      content: [{ type: "text", text: await listPossibleContradictions(memloom) }],
    }),
  );

  server.tool(
    "answer_possible_contradiction",
    "Answer one finding from list_possible_contradictions. `confirm` turns it into a real " +
      "conflict, which then has to be resolved with resolve_conflict (keep_new, keep_existing, " +
      "keep_both, or merge). `dismiss` records that pair as not a contradiction PERMANENTLY: it " +
      "is never raised again and there is no undo. Because a finding is only about 40 percent " +
      "likely to be real, ask the user rather than guessing. A wrong confirm puts noise in a " +
      "queue they have to clear; a wrong dismiss loses a real contradiction for good.",
    {
      id: z.string(),
      answer: z.enum(["confirm", "dismiss"]),
    },
    async (args) => ({
      content: [{ type: "text", text: await answerPossibleContradiction(memloom, args) }],
    }),
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
