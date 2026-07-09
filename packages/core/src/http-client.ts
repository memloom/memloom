import type { MemoryEngine } from "./engine.js";
import type {
  Conflict,
  ContextAddInput,
  ContextAddResult,
  ContextDocument,
  DocumentChunks,
  Graph,
  IndexResult,
  Memory,
  RecallOptions,
  ResolveDecision,
  SaveInput,
  SaveResult,
  UpdateInput,
  UpdateResult,
} from "./types.js";

// Structural fetch types so core needs neither DOM nor node lib types (it deliberately avoids
// ambient globals). Node's global fetch and Hono's app.request both satisfy these at runtime.
export interface HttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<HttpResponse>;

// A MemoryEngine backed by a running `memloom serve` over HTTP. Same shape as the local engine,
// so surfaces route through the single owner instead of opening the store themselves.
export class HttpMemloomClient implements MemoryEngine {
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;

  constructor(baseUrl: string, fetchImpl?: FetchLike) {
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#fetch = fetchImpl ?? (globalThis as unknown as { fetch: FetchLike }).fetch;
  }

  async #json<T>(path: string, init?: Parameters<FetchLike>[1]): Promise<T> {
    const res = await this.#fetch(`${this.#baseUrl}${path}`, init);
    if (!res.ok) throw new Error(`memloom server ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  #post<T>(path: string, body: unknown): Promise<T> {
    return this.#json<T>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  }

  save(input: SaveInput): Promise<SaveResult> {
    return this.#post<SaveResult>("/memory/save", input);
  }

  async memories(): Promise<Memory[]> {
    const { memories } = await this.#json<{ memories: Memory[] }>("/memory/list");
    return memories;
  }

  async recall(query: string, opts?: RecallOptions): Promise<Memory[]> {
    const { memories } = await this.#post<{ memories: Memory[] }>("/memory/query", {
      query,
      limit: opts?.limit,
    });
    return memories;
  }

  update(input: UpdateInput): Promise<UpdateResult> {
    return this.#post<UpdateResult>(`/memory/${input.id}/update`, {
      content: input.content,
      canonical: input.canonical,
    });
  }

  async history(memoryId: string): Promise<Memory[]> {
    const { versions } = await this.#json<{ versions: Memory[] }>(`/memory/${memoryId}/history`);
    return versions;
  }

  index(): Promise<IndexResult> {
    return this.#post<IndexResult>("/memory/index", {});
  }

  graph(): Promise<Graph> {
    return this.#json<Graph>("/memory/graph");
  }

  async conflicts(): Promise<Conflict[]> {
    const { conflicts } = await this.#json<{ conflicts: Conflict[] }>("/memory/conflicts");
    return conflicts;
  }

  async resolveConflict(conflictId: string, decision: ResolveDecision): Promise<void> {
    await this.#post(`/memory/conflicts/${conflictId}/resolve`, decision);
  }

  async revertConflict(conflictId: string): Promise<void> {
    await this.#post(`/memory/conflicts/${conflictId}/revert`, {});
  }

  contextAdd(input: ContextAddInput): Promise<ContextAddResult> {
    return this.#post<ContextAddResult>("/context/add", input);
  }

  async contextList(): Promise<ContextDocument[]> {
    const { documents } = await this.#json<{ documents: ContextDocument[] }>("/context/documents");
    return documents;
  }

  contextChunks(documentId: string): Promise<DocumentChunks> {
    return this.#json<DocumentChunks>(`/context/documents/${documentId}/chunks`);
  }

  async contextRemove(documentId: string): Promise<void> {
    await this.#json(`/context/documents/${documentId}`, { method: "DELETE" });
  }
}
