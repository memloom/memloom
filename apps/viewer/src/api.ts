// Thin client over the daemon's /memory/* API. Same-origin in production (the daemon serves
// this bundle); Vite's dev proxy routes to 127.0.0.1:4319 during `pnpm dev`.

export interface Memory {
  id: string;
  status: "active" | "stale";
  memoryType: string;
  canonical: string | null;
  content: string;
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
}

export interface Entity {
  id: string;
  name: string;
  entityType: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  relation: string;
}

export interface Graph {
  memories: GraphMemory[];
  entities: Entity[];
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
  outcome: "added" | "merged" | "conflict";
  conflictId?: string;
}

export type ResolveDecision =
  | { action: "keep_new" }
  | { action: "keep_existing"; candidateId: string }
  | { action: "keep_both" }
  | { action: "merge"; content: string; canonical?: string };

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
  save: (input: { content: string; canonical?: string }) => post<SaveResult>("/memory/save", input),
  recall: (query: string, limit?: number) =>
    post<{ memories: Memory[] }>("/memory/query", { query, limit }).then((r) => r.memories),
  index: () => post<{ indexed: number }>("/memory/index"),
  conflicts: () => json<{ conflicts: Conflict[] }>("/memory/conflicts").then((r) => r.conflicts),
  resolve: (id: string, decision: ResolveDecision) =>
    post<{ ok: boolean }>(`/memory/conflicts/${id}/resolve`, decision),
  revert: (id: string) => post<{ ok: boolean }>(`/memory/conflicts/${id}/revert`),
};
