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

/** One item finished during a streamed index run. */
export interface IndexProgressEvent {
  kind: "memory" | "chunk";
  id: string;
  label: string;
  index: number;
  total: number;
  entities: string[];
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
  save: (input: { content: string; canonical?: string }) => post<SaveResult>("/memory/save", input),
  recall: (query: string, limit?: number) =>
    post<{ memories: Memory[] }>("/memory/query", { query, limit }).then((r) => r.memories),
  update: (id: string, input: { content: string; canonical?: string }) =>
    post<UpdateResult>(`/memory/${id}/update`, input),
  history: (id: string) =>
    json<{ versions: Memory[] }>(`/memory/${id}/history`).then((r) => r.versions),
  index: () => post<{ indexed: number; chunksIndexed: number }>("/memory/index"),
  // Streamed indexing: NDJSON progress per item, resolves with the totals. The callback
  // fires as each memory/chunk finishes, so the console can log in real time.
  indexStream: async (
    onEvent: (event: IndexProgressEvent) => void,
  ): Promise<{ indexed: number; chunksIndexed: number }> => {
    const res = await fetch("/memory/index/stream", { method: "POST" });
    if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);
    let result: { indexed: number; chunksIndexed: number } | null = null;
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line) as
        | ({ type: "item" } & IndexProgressEvent)
        | { type: "done"; indexed: number; chunksIndexed: number }
        | { type: "error"; error: string };
      if (event.type === "item") onEvent(event);
      else if (event.type === "done")
        result = { indexed: event.indexed, chunksIndexed: event.chunksIndexed };
      else throw new Error(event.error);
    };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
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
    if (!result) throw new Error("index stream ended without a done event");
    return result;
  },
  conflicts: () => json<{ conflicts: Conflict[] }>("/memory/conflicts").then((r) => r.conflicts),
  resolve: (id: string, decision: ResolveDecision) =>
    post<{ ok: boolean }>(`/memory/conflicts/${id}/resolve`, decision),
  revert: (id: string) => post<{ ok: boolean }>(`/memory/conflicts/${id}/revert`),
};
