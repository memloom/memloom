// Thin client over the daemon's /memory/* API. Same-origin in production (the daemon serves
// this bundle); Vite's dev proxy routes to 127.0.0.1:4319 during `pnpm dev`.

// The saveable taxonomy (mirrors @memloom/core MEMORY_TYPES); recall results for context
// chunks carry the "context" sentinel instead.
export type MemoryType = "fact" | "preference" | "episode" | "procedure";

export interface Memory {
  id: string;
  status: "active" | "stale";
  memoryType: MemoryType | "context";
  canonical: string | null;
  content: string;
  rootId: string;
  version: number;
  assertedAt: string;
  createdAt: string;
  similarity?: number;
  rrfScore?: number;
  kind?: "memory" | "context";
  source?: {
    documentId: string;
    title: string;
    path: string;
    headingPath: string | null;
    page: number | null;
  };
}

export interface GraphMemory {
  id: string;
  canonical: string | null;
  content: string;
  memoryType: MemoryType;
}

export interface Entity {
  id: string;
  name: string;
  entityType: string;
}

export interface GraphDocument {
  id: string;
  title: string;
  path: string;
}

export interface ContextDocument {
  id: string;
  path: string;
  title: string;
  kind: string;
  chunkCount: number;
  updatedAt: string;
}

export interface ContextChunk {
  id: string;
  chunkIndex: number;
  content: string;
  headingPath: string | null;
  page: number | null;
}

// One document exploded to chunk granularity (fetched when a document node is expanded).
export interface DocumentChunks {
  chunks: ContextChunk[];
  edges: GraphEdge[];
}

export interface GraphEdge {
  from: string;
  to: string;
  relation: string;
  /** On document -> entity edges: how many of the document's chunks mention the entity. */
  weight?: number;
}

export interface Graph {
  memories: GraphMemory[];
  entities: Entity[];
  documents: GraphDocument[];
  edges: GraphEdge[];
}

export interface ConflictCandidate {
  id: string;
  canonical: string | null;
  content: string;
  relation: string;
  reason: string;
}

export interface Conflict {
  id: string;
  createdAt: string;
  incoming: { id: string; canonical: string | null; content: string };
  candidates: ConflictCandidate[];
}

export interface SaveResult {
  id: string;
  outcome: "added" | "merged" | "conflict" | "versioned";
  conflictId?: string;
  version?: number;
}

export interface UpdateResult {
  id: string;
  rootId: string;
  version: number;
}

export type ResolveDecision =
  | { action: "keep_new" }
  | { action: "keep_existing"; candidateId: string }
  | { action: "keep_both" }
  | { action: "merge"; content: string; canonical?: string };

/** A schema registry row: a vocabulary entry or a pending LLM proposal. */
export interface SchemaEntry {
  id: string;
  kind: "entity_type" | "predicate";
  name: string;
  description: string;
  tier: "system" | "user" | "proposed";
  status: "active" | "disabled" | "dismissed";
  occurrences: number;
}

export interface SchemaInfo {
  entityTypes: (SchemaEntry & { count: number })[];
  relations: { name: string; description: string; count: number }[];
  predicates: (SchemaEntry & { count: number })[];
  proposals: SchemaEntry[];
}

export type IndexRunStatus = "running" | "success" | "warning" | "error" | "interrupted";

/** One index/reindex pass — a session row in the Console's persistent log. */
export interface IndexRun {
  id: string;
  trigger: "index" | "rebuild";
  status: IndexRunStatus;
  batchSize: number;
  memoriesIndexed: number;
  chunksIndexed: number;
  itemsFailed: number;
  entitiesLinked: number;
  relationsCreated: number;
  startedAt: string;
  finishedAt: string | null;
}

export type IndexEventLevel = "info" | "success" | "warning" | "error";

/** One per-item log line under a run. */
export interface IndexRunEvent {
  id: string;
  level: IndexEventLevel;
  message: string;
  itemId: string | null;
  metadata: { entities?: string[]; relationships?: number; skipped?: string; error?: string };
  createdAt: string;
}

// assistant chat (docs/design/assistant-tab.md)

export interface AssistantSource {
  n: number;
  kind: "memory" | "context";
  id: string;
  title: string;
  snippet: string;
  similarity?: number;
}

export interface AssistantSession {
  id: string;
  title: string;
  isStarred: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantSessionHit extends AssistantSession {
  snippet: string;
}

export interface AssistantMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources: AssistantSource[];
  createdAt: string;
}

export type AssistantStreamEvent =
  | { type: "tool_call"; round: number; query: string }
  | { type: "tool_result"; round: number; hits: number }
  | { type: "delta"; text: string }
  | {
      type: "done";
      sessionId: string;
      messageId: string;
      answer: string;
      sources: AssistantSource[];
    }
  | { type: "error"; message: string };

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return json<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

export const api = {
  graph: () => json<Graph>("/memory/graph"),
  memories: () => json<{ memories: Memory[] }>("/memory/list").then((r) => r.memories),
  documents: () =>
    json<{ documents: ContextDocument[] }>("/context/documents").then((r) => r.documents),
  documentChunks: (id: string) => json<DocumentChunks>(`/context/documents/${id}/chunks`),
  openDocument: (id: string) =>
    json<{ ok: boolean }>(`/context/documents/${id}/open`, { method: "POST" }),
  removeDocument: (id: string) =>
    json<{ ok: boolean }>(`/context/documents/${id}`, { method: "DELETE" }),
  save: (input: { content: string; canonical?: string }) => post<SaveResult>("/memory/save", input),
  recall: (query: string, limit?: number) =>
    post<{ memories: Memory[] }>("/memory/query", { query, limit }).then((r) => r.memories),
  update: (id: string, input: { content: string; canonical?: string }) =>
    post<UpdateResult>(`/memory/${id}/update`, input),
  history: (id: string) =>
    json<{ versions: Memory[] }>(`/memory/${id}/history`).then((r) => r.versions),
  index: () => post<{ indexed: number; chunksIndexed: number }>("/memory/index"),
  // Recovery: wipe all extracted entities/edges, then re-run indexing from scratch.
  reindex: () => post<{ indexed: number; chunksIndexed: number }>("/memory/reindex"),
  // Index sessions — the engine writes a run row + per-item events to the store during a
  // run, so the Console polls these while a run is live and history survives everything.
  indexRuns: () => json<{ runs: IndexRun[] }>("/memory/index/runs").then((r) => r.runs),
  runEvents: (runId: string) =>
    json<{ events: IndexRunEvent[] }>(`/memory/index/runs/${runId}/events`).then((r) => r.events),
  deleteRun: (runId: string) =>
    json<{ ok: boolean }>(`/memory/index/runs/${runId}`, { method: "DELETE" }),
  clearRuns: () => json<{ ok: boolean }>("/memory/index/runs", { method: "DELETE" }),
  schema: () => json<SchemaInfo>("/memory/schema"),
  addSchemaEntry: (input: {
    kind: "entity_type" | "predicate";
    name: string;
    description?: string;
  }) => post<SchemaEntry>("/memory/schema", input),
  approveProposal: (id: string) => post<{ ok: boolean }>(`/memory/schema/${id}/approve`),
  dismissProposal: (id: string) => post<{ ok: boolean }>(`/memory/schema/${id}/dismiss`),
  setSchemaStatus: (id: string, status: "active" | "disabled") =>
    json<{ ok: boolean }>(`/memory/schema/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    }),
  assistantSessions: () =>
    json<{ sessions: AssistantSession[] }>("/assistant/sessions").then((r) => r.sessions),
  assistantSearch: (q: string) =>
    json<{ sessions: AssistantSessionHit[] }>(
      `/assistant/sessions/search?q=${encodeURIComponent(q)}`,
    ).then((r) => r.sessions),
  assistantMessages: (sessionId: string) =>
    json<{ messages: AssistantMessage[] }>(`/assistant/sessions/${sessionId}/messages`).then(
      (r) => r.messages,
    ),
  assistantPatch: (sessionId: string, patch: { title?: string; starred?: boolean }) =>
    json<{ ok: boolean }>(`/assistant/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  assistantDelete: (sessionId: string) =>
    json<{ ok: boolean }>(`/assistant/sessions/${sessionId}`, { method: "DELETE" }),
  // One agentic turn over SSE. Resolves with the done payload; onEvent fires per event.
  assistantChat: async (
    input: { sessionId?: string; message: string },
    onEvent: (e: AssistantStreamEvent) => void,
  ): Promise<Extract<AssistantStreamEvent, { type: "done" }>> => {
    const res = await fetch("/assistant/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
    }
    let done: Extract<AssistantStreamEvent, { type: "done" }> | null = null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const handleBlock = (block: string) => {
      const line = block.split("\n").find((l) => l.startsWith("data: "));
      if (!line) return;
      const event = JSON.parse(line.slice(6)) as AssistantStreamEvent;
      if (event.type === "error") throw new Error(event.message);
      if (event.type === "done") done = event;
      onEvent(event);
    };
    for (;;) {
      const { done: eof, value } = await reader.read();
      if (eof) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf("\n\n");
      while (sep >= 0) {
        handleBlock(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
        sep = buffer.indexOf("\n\n");
      }
    }
    if (buffer.trim()) handleBlock(buffer);
    if (!done) throw new Error("assistant stream ended without a done event");
    return done;
  },
  conflicts: () => json<{ conflicts: Conflict[] }>("/memory/conflicts").then((r) => r.conflicts),
  resolve: (id: string, decision: ResolveDecision) =>
    post<{ ok: boolean }>(`/memory/conflicts/${id}/resolve`, decision),
  revert: (id: string) => post<{ ok: boolean }>(`/memory/conflicts/${id}/revert`),
};
