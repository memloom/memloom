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

/** An entity with usage counts: the schema tab's management list. */
export interface EntityDetail extends Entity {
  mentions: number;
  memories: number;
  documents: number;
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

/**
 * One saved occurrence behind a proposal: the entity (entity_type) or relationship endpoints
 * (predicate) the extractor held out. Approval links these into the graph directly.
 */
export interface ProposalExample {
  entity?: string;
  from?: string;
  to?: string;
  confidence?: number;
  sourceId?: string;
}

/** A schema registry row: a vocabulary entry or a pending LLM proposal. */
export interface SchemaEntry {
  id: string;
  kind: "entity_type" | "predicate";
  name: string;
  description: string;
  tier: "system" | "user" | "proposed";
  status: "active" | "disabled" | "dismissed";
  occurrences: number;
  examples?: ProposalExample[];
}

export interface SchemaInfo {
  entityTypes: (SchemaEntry & { count: number })[];
  relations: { name: string; description: string; count: number }[];
  predicates: (SchemaEntry & { count: number })[];
  proposals: SchemaEntry[];
}

export type IndexRunStatus = "running" | "success" | "warning" | "error" | "interrupted";

/** One index/reindex pass: a session row in the Console's persistent log. */
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
  date?: string;
  memoryType?: MemoryType;
  rrfScore?: number;
  graphNodeId?: string;
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
  | { type: "tool_call"; round: number; query: string; onDate?: string }
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

/** One tool-capable OpenRouter model, shaped by the daemon for the composer's picker. */
export interface AssistantModel {
  id: string;
  name: string;
  description: string;
  contextLength: number | null;
  /** USD per 1M input tokens; null when OpenRouter reports no price. */
  promptPer1M: number | null;
  completionPer1M: number | null;
  provider: string;
}

export interface AssistantModels {
  /** The daemon's configured chat model; null in offline mode. */
  defaultModel: string | null;
  models: AssistantModel[];
}

/** A file attached to one chat session (same shape as a context document). */
export interface SessionAttachment {
  id: string;
  path: string;
  title: string;
  kind: string;
  chunkCount: number;
  updatedAt: string;
}

/** Encode a picked File's bytes for the JSON upload endpoints (base64, sliced btoa). */
export async function fileToBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

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
  contextAdd: (path: string) =>
    post<{
      documentId?: string;
      outcome: "added" | "updated" | "unchanged" | "converted";
      title: string;
      chunks: number;
      /** "converted": false when the upload's chunks were kept as-is (content matched). */
      rechunked?: boolean;
      /** Duplicate upload snapshots removed while linking. */
      absorbed?: number;
      /** Present when a folder was ingested: how many files were added/updated. */
      documents?: number;
      unchanged?: number;
      errors?: string[];
    }>("/context/add", { path }),
  // Opens the OS-native picker on the daemon's desktop; resolves when the user picks or
  // cancels ([] = cancelled). 501 when the platform has no picker. Picks return absolute
  // paths, so linked documents stay openable and change-trackable (the sync roadmap).
  pick: (mode: "file" | "folder") => post<{ paths: string[] }>("/context/pick", { mode }),
  // Upload a browser-picked file's bytes as a global document (upload:// provenance).
  // "exists" = the content or filename already lives here (often as a linked file, see
  // `path`): nothing new is created; a link stays the single source of truth.
  contextUpload: (filename: string, contentBase64: string) =>
    post<{
      documentId: string;
      outcome: "added" | "updated" | "unchanged" | "exists";
      title: string;
      chunks: number;
      path?: string;
    }>("/context/upload", { filename, contentBase64 }),
  save: (input: { content: string; canonical?: string }) => post<SaveResult>("/memory/save", input),
  recall: (query: string, limit?: number) =>
    post<{ memories: Memory[] }>("/memory/query", { query, limit }).then((r) => r.memories),
  update: (id: string, input: { content: string; canonical?: string }) =>
    post<UpdateResult>(`/memory/${id}/update`, input),
  history: (id: string) =>
    json<{ versions: Memory[] }>(`/memory/${id}/history`).then((r) => r.versions),
  index: () => post<{ indexed: number; chunksIndexed: number }>("/memory/index"),
  // The Console's auto-index toggle; `available` is false in offline mode.
  autoIndex: () => json<{ enabled: boolean; available: boolean }>("/memory/auto-index"),
  setAutoIndex: (enabled: boolean) =>
    json<{ enabled: boolean }>("/memory/auto-index", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    }),
  // Recovery: wipe all extracted entities/edges, then re-run indexing from scratch.
  reindex: () => post<{ indexed: number; chunksIndexed: number }>("/memory/reindex"),
  // Index sessions: the engine writes a run row + per-item events to the store during a
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
  // Only disabled user-tier entries are deletable; the daemon explains any refusal.
  deleteSchemaEntry: (id: string) =>
    json<{ ok: boolean }>(`/memory/schema/${id}`, { method: "DELETE" }),
  entities: () => json<{ entities: EntityDetail[] }>("/memory/entities").then((r) => r.entities),
  updateEntity: (id: string, patch: { name?: string; entityType?: string }) =>
    json<{ ok: boolean }>(`/memory/entities/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  mergeEntity: (id: string, into: string) =>
    post<{ ok: boolean }>(`/memory/entities/${id}/merge`, { into }),
  deleteEntity: (id: string) =>
    json<{ ok: boolean }>(`/memory/entities/${id}`, { method: "DELETE" }),
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
  assistantModels: () => json<AssistantModels>("/assistant/models"),
  // Attach a file's bytes to a chat; no sessionId creates the session and returns it.
  assistantAttach: (input: { sessionId?: string; filename: string; contentBase64: string }) =>
    post<{
      sessionId: string;
      documentId: string;
      outcome: "added" | "updated" | "unchanged";
      title: string;
      chunks: number;
    }>("/assistant/attachments", input),
  sessionAttachments: (sessionId: string) =>
    json<{ attachments: SessionAttachment[] }>(`/assistant/sessions/${sessionId}/attachments`).then(
      (r) => r.attachments,
    ),
  // One agentic turn over SSE. Resolves with the done payload; onEvent fires per event.
  assistantChat: async (
    input: { sessionId?: string; message: string; model?: string },
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
