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
  /** Folded-in spellings that still resolve to this entity. */
  aliases: string[];
}

/** One stated relationship between two entities, seen from the entity being asked about. */
export interface EntityLink {
  relation: string;
  direction: "out" | "in";
  confidence: number | null;
}

/** One entity connected to the entity being asked about, and how. */
export interface RelatedEntity extends Entity {
  mentions: number;
  aliases: string[];
  /** Empty means the connection is co-mention only: nothing stated how they relate. */
  links: EntityLink[];
  sharedSources: number;
}

/** The neighbourhood of one entity. `matchedAlias` is set when a folded spelling was asked for. */
export interface RelatedEntities {
  entity: EntityDetail;
  matchedAlias: string | null;
  related: RelatedEntity[];
  truncated: number;
}

/** A canonical an uncertain fold could go to. */
export interface EntityConflictCandidate {
  id: string;
  name: string;
  entityType: string;
  mentions: number;
  score: number;
  reason: string;
}

/** An uncertain entity fold awaiting arbitration, on the same surface as memory conflicts. */
export interface EntityConflict {
  id: string;
  createdAt: string;
  incoming: { id: string; name: string; entityType: string; mentions: number };
  candidates: EntityConflictCandidate[];
}

/** One reversible fold of a name variant into a canonical entity. */
export interface EntityMerge {
  id: string;
  canonicalId: string;
  canonicalName: string;
  sourceId: string;
  sourceName: string;
  sourceType: string;
  decidedBy: "auto" | "llm" | "human";
  score: number | null;
  reason: string | null;
  createdAt: string;
  revertedAt: string | null;
}

export interface EntityResolutionResult {
  examined: number;
  pairs: number;
  merged: number;
  queued: number;
  deferred: number;
  skipped: number;
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

/** Why a page could not be turned into a document. Stable, so the UI can branch on it. */
export type LinkErrorCode =
  | "not_html"
  | "too_large"
  | "too_many_redirects"
  | "http_error"
  | "empty"
  | "likely_rendered";

/**
 * A refused page. The code is carried rather than flattened into the message, because the
 * difference between "try another way" and "this is broken" is the whole point of showing
 * the failure at all.
 */
export class LinkIngestError extends Error {
  constructor(
    message: string,
    readonly code: LinkErrorCode | null,
    readonly url: string,
  ) {
    super(message);
    this.name = "LinkIngestError";
  }
}

/**
 * One step of a slow ingest. Only media emits these: transcribing an hour of audio takes
 * minutes, and every other format finishes before it would emit anything.
 */
export interface ContextProgress {
  path: string;
  /** "decoding" | "transcribing" | "checking" | "repairing"; an open set. */
  stage: string;
  /** 1-based position within the stage; both 0 when the stage has nothing to count. */
  done: number;
  total: number;
  /** How far into the recording this step reached, and how long the recording runs. */
  seconds: number;
  audioSeconds: number;
}

/** One file finished inside a streamed ingest, so a folder reports as it goes. */
export interface ContextFileDone {
  stage: "file";
  path: string;
  outcome: string;
  chunks: number;
}

export type ContextStreamEvent = ContextProgress | ContextFileDone;

/** The streamed ingest's summary: the same totals /context/add reports for a folder. */
export interface ContextAddStreamResult {
  documents: number;
  unchanged: number;
  chunks: number;
  errors?: string[];
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

/** A resolved conflict from the decision log: the revertable history behind the pending queue. */
export interface ResolvedConflict extends Conflict {
  resolution: "keep_new" | "keep_existing" | "keep_both" | "merge";
  resolvedAt: string;
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

/** Progress from the conflict auto-resolver: one event per examined conflict. */
export interface ConflictAutoEvent {
  conflictId: string;
  index: number;
  total: number;
  verdict: "keep_new" | "keep_existing" | "keep_both" | "unsure";
  reason: string;
  content: string;
}

export interface ConflictAutoResult {
  examined: number;
  resolved: number;
  keepNew: number;
  keepExisting: number;
  keepBoth: number;
  unsure: number;
}

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

// notion connector

/** One Notion item the integration can see (a page or a database's data source). */
export interface NotionItemRef {
  id: string;
  object: "page" | "data_source";
  title: string;
}

/** The pages and data sources selected for sync; null = connector off. */
export type NotionScope = { items: NotionItemRef[] } | null;

/** One row of the Notion listing: a visible item plus its place in the tree. */
export interface NotionListedPage extends NotionItemRef {
  lastEdited: string;
  url: string | null;
  selected: boolean;
  /** The listed item this one lives under, when that item is also listed; null at top level. */
  parentId: string | null;
  /** What kind of item parentId points at; "data_source" marks a database row-page. */
  parentType: "page" | "data_source" | null;
}

export type NotionSyncOutcome =
  | "waiting"
  | "fetching"
  | "added"
  | "updated"
  | "unchanged"
  | "fresh"
  | "would-sync"
  | "error";

/** Per-item progress during a sync run. */
export interface NotionSyncEvent {
  id: string;
  title: string;
  object: "page" | "data_source";
  index: number;
  total: number;
  outcome: NotionSyncOutcome;
  chunks: number;
  error?: string;
  truncated?: boolean;
  sections?: number;
  refetched?: number;
}

export interface NotionSyncResult {
  items: number;
  added: number;
  updated: number;
  unchanged: number;
  fresh: number;
  errors: number;
  truncated: number;
  dryRun: boolean;
  error?: string;
}

export interface NotionStatus {
  tokenPresent: boolean;
  syncing: boolean;
  scope: NotionScope;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  documents: number;
  chunks: number;
}

// The NDJSON lines the sync stream emits: per-item progress, a final summary, or a failure.
export type NotionSyncStreamEvent =
  | ({ type: "item" } & NotionSyncEvent)
  | ({ type: "done" } & NotionSyncResult)
  | { type: "error"; error: string };

// assistant chat

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

/**
 * Read one of the daemon's NDJSON progress streams. Every line is a JSON object with a
 * `type`: "item" per step, one "done" carrying the summary, "error" for a failure that
 * happened after the headers went out, and "ping" keepalives. Unknown types are skipped, so
 * a newer daemon never breaks an older viewer.
 */
async function readNdjson<TItem, TDone>(
  path: string,
  body: unknown,
  onItem: (item: TItem) => void,
): Promise<TDone> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok || !res.body) {
    const failure = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(failure?.error ?? `${res.status} ${res.statusText}`);
  }
  let done: TDone | null = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handleLine = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as { type: string; error?: string };
    if (event.type === "error") throw new Error(event.error ?? "stream error");
    if (event.type === "done") {
      const { type: _t, ...result } = event;
      done = result as unknown as TDone;
      return;
    }
    if (event.type !== "item") return;
    const { type: _t, ...item } = event;
    onItem(item as unknown as TItem);
  };
  for (;;) {
    const { done: eof, value } = await reader.read();
    if (eof) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      handleLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) handleLine(buffer);
  if (!done) throw new Error("the stream ended without a result");
  return done;
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
  // The same ingest, streamed. Media transcribes for minutes, which is far past what a plain
  // request can hold open without looking hung, so the media and folder paths report as they
  // go. Progress events and per-file completions both arrive here; `stage` tells them apart.
  contextAddStream: (path: string, onProgress: (event: ContextStreamEvent) => void) =>
    readNdjson<ContextStreamEvent, ContextAddStreamResult>(
      "/context/add/stream",
      { path },
      onProgress,
    ),
  // Ingest a web page. The daemon fetches and parses it in its own process, so the URL never
  // reaches a third party. Not json(): a refusal answers 400 with a stable code, and losing
  // that code would leave the UI with nothing but prose to act on.
  contextAddUrl: async (url: string) => {
    const res = await fetch("/context/url", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const body = (await res.json().catch(() => null)) as {
      error?: string;
      code?: LinkErrorCode;
      url?: string;
    } | null;
    if (!res.ok) {
      throw new LinkIngestError(
        body?.error ?? `${res.status} ${res.statusText}`,
        body?.code ?? null,
        body?.url ?? url,
      );
    }
    return body as unknown as {
      documentId?: string;
      outcome: "added" | "updated" | "unchanged" | "converted";
      title: string;
      chunks: number;
    };
  },
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
  deleteMemory: (id: string) => json<{ ok: boolean }>(`/memory/${id}`, { method: "DELETE" }),
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
  // Entity resolution. Uncertain folds are resolved through the same resolve/revert calls as
  // memory conflicts (the daemon dispatches on the decision's kind), so only the reads and
  // the fold history are separate.
  entityConflicts: () =>
    json<{ conflicts: EntityConflict[] }>("/memory/entities/conflicts").then((r) => r.conflicts),
  entityMerges: () =>
    json<{ merges: EntityMerge[] }>("/memory/entities/merges").then((r) => r.merges),
  resolveEntities: (dryRun = false) =>
    post<EntityResolutionResult>("/memory/entities/resolve", { dryRun }),
  revertEntityMerge: (id: string) =>
    post<{ ok: boolean }>(`/memory/entities/merges/${id}/revert`, {}),
  /**
   * Walk the graph from one entity. `target` may be a name, an id, or a folded-away spelling;
   * null means nothing matched, which is different from an entity with no neighbours.
   */
  relatedEntities: async (target: string, entityType?: string): Promise<RelatedEntities | null> => {
    const params = new URLSearchParams({ q: target });
    if (entityType) params.set("type", entityType);
    // Not json(): a 404 here means "no such entity", which is an answer rather than a failure.
    const res = await fetch(`/memory/entities/related?${params}`);
    if (res.status === 404) return null;
    const body = (await res.json().catch(() => null)) as
      | ({ error?: string } & RelatedEntities)
      | null;
    if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
    return body as RelatedEntities;
  },
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
  // The Notion connector. The daemon holds NOTION_TOKEN and owns the watermarks; the UI
  // only reads status, edits the selection, and streams sync progress.
  notionStatus: () => json<NotionStatus>("/notion/status"),
  notionPages: () => json<NotionListedPage[]>("/notion/pages"),
  setNotionScope: (scope: NotionScope) =>
    json<{ ok: boolean }>("/notion/scope", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope }),
    }),
  // One sync run over NDJSON (one JSON object per line). Resolves with the done summary;
  // onEvent fires per item. Pass wait so a running daemon poll queues instead of refusing.
  notionSync: async (
    input: { dryRun?: boolean; force?: boolean; wait?: boolean },
    onEvent: (e: NotionSyncEvent) => void,
  ): Promise<NotionSyncResult> => {
    const res = await fetch("/notion/sync/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
    }
    let done: NotionSyncResult | null = null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      // Parsed loose: the stream may carry heartbeat pings and event kinds from a newer
      // daemon, which are skipped rather than rendered.
      const event = JSON.parse(line) as { type: string; error?: string };
      if (event.type === "error") throw new Error(event.error ?? "notion sync stream error");
      if (event.type === "done") {
        const { type: _t, ...result } = event;
        done = result as unknown as NotionSyncResult;
        return;
      }
      if (event.type !== "item") return;
      const { type: _t, ...item } = event;
      onEvent(item as unknown as NotionSyncEvent);
    };
    for (;;) {
      const { done: eof, value } = await reader.read();
      if (eof) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    }
    if (buffer.trim()) handleLine(buffer);
    if (!done) throw new Error("notion sync stream ended without a done event");
    return done;
  },
  conflicts: () => json<{ conflicts: Conflict[] }>("/memory/conflicts").then((r) => r.conflicts),
  resolvedConflicts: () =>
    json<{ conflicts: ResolvedConflict[] }>("/memory/conflicts/resolved").then((r) => r.conflicts),
  resolve: (id: string, decision: ResolveDecision) =>
    post<{ ok: boolean }>(`/memory/conflicts/${id}/resolve`, decision),
  revert: (id: string) => post<{ ok: boolean }>(`/memory/conflicts/${id}/revert`),
  // NDJSON progress stream: {type:"item"} per conflict, {type:"done"} with the totals,
  // heartbeat pings in between (skipped).
  autoResolveConflicts: async (
    onEvent: (e: ConflictAutoEvent) => void,
  ): Promise<ConflictAutoResult> => {
    const res = await fetch("/memory/conflicts/resolve-auto/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);
    let result: ConflictAutoResult | null = null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line) as { type: string; error?: string };
      if (event.type === "item") onEvent(event as unknown as ConflictAutoEvent);
      else if (event.type === "done") result = event as unknown as ConflictAutoResult;
      else if (event.type === "error") throw new Error(event.error ?? "stream error");
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    handleLine(buffer);
    if (!result) throw new Error("auto-resolve stream ended without a result");
    return result;
  },
};
