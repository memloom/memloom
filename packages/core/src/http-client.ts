import type { MemoryEngine } from "./engine.js";
import type {
  Conflict,
  ContextAddInput,
  ContextAddResult,
  ContextDocument,
  DocumentChunks,
  Graph,
  IndexProgressEvent,
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
  /** Web-streams body (present on real fetch Responses) — used by the index progress stream. */
  body?: {
    getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> };
  } | null;
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

  index(_ownerId?: string, onProgress?: (event: IndexProgressEvent) => void): Promise<IndexResult> {
    if (!onProgress) return this.#post<IndexResult>("/memory/index", {});
    return this.#streamRun("/memory/index/stream", onProgress);
  }

  reindex(
    _ownerId?: string,
    onProgress?: (event: IndexProgressEvent) => void,
  ): Promise<IndexResult> {
    if (!onProgress) return this.#post<IndexResult>("/memory/reindex", {});
    return this.#streamRun("/memory/reindex/stream", onProgress);
  }

  // Consume an NDJSON progress stream, forwarding item events as they land.
  async #streamRun(
    path: string,
    onProgress: (event: IndexProgressEvent) => void,
  ): Promise<IndexResult> {
    const res = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!res.ok) throw new Error(`memloom server ${res.status}: ${await res.text()}`);

    let result: IndexResult | null = null;
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line) as
        | ({ type: "item" } & IndexProgressEvent)
        | ({ type: "done" } & IndexResult)
        | { type: "error"; error: string };
      if (event.type === "item") onProgress(event);
      else if (event.type === "done")
        result = { indexed: event.indexed, chunksIndexed: event.chunksIndexed };
      else throw new Error(event.error);
    };

    const reader = res.body?.getReader();
    if (reader) {
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
    } else {
      // Fetch impls without body streaming (test doubles): parse the full text at once.
      for (const line of (await res.text()).split("\n")) handleLine(line);
    }

    if (!result) throw new Error("memloom: index stream ended without a done event");
    return result;
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
