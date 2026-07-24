import type { MemoryEngine } from "./engine.js";
import type { SchemaInfo } from "./schema.js";
import type {
  Conflict,
  ConflictAutoEvent,
  ConflictAutoResult,
  ContextAddInput,
  ContextAddResult,
  ContextDocument,
  DocumentChunks,
  Graph,
  ImportCaptureScope,
  ImportOptions,
  ImportResult,
  ImportSessionEvent,
  ImportStatus,
  IndexProgressEvent,
  IndexResult,
  Memory,
  RecallOptions,
  ResolveDecision,
  ResolvedConflict,
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
  /** Web-streams body (present on real fetch Responses): used by the index progress stream. */
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

  async deleteMemory(memoryId: string): Promise<void> {
    await this.#json(`/memory/${memoryId}`, { method: "DELETE" });
  }

  async passage(id: string): Promise<string | null> {
    const res = await this.#fetch(`${this.#baseUrl}/memory/passage/${id}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`memloom server ${res.status}: ${await res.text()}`);
    const { content } = (await res.json()) as { content: string };
    return content;
  }

  importClaudeCode(
    opts: ImportOptions = {},
    onProgress?: (event: ImportSessionEvent) => void,
  ): Promise<ImportResult> {
    // root/ownerId are daemon-side concerns; only the user-facing knobs cross the wire.
    const body = {
      days: opts.days,
      maxSessions: opts.maxSessions,
      project: opts.project,
      dryRun: opts.dryRun,
      force: opts.force,
    };
    return this.#streamNdjson<ImportSessionEvent, ImportResult>(
      "/import/claude-code/stream",
      body,
      onProgress,
    );
  }

  importStatus(): Promise<ImportStatus> {
    return this.#json<ImportStatus>("/import/claude-code/status");
  }

  async setImportScope(scope: ImportCaptureScope): Promise<void> {
    await this.#json("/import/claude-code/scope", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope }),
    });
  }

  index(_ownerId?: string, onProgress?: (event: IndexProgressEvent) => void): Promise<IndexResult> {
    if (!onProgress) return this.#post<IndexResult>("/memory/index", {});
    return this.#streamNdjson<IndexProgressEvent, IndexResult>(
      "/memory/index/stream",
      {},
      onProgress,
    );
  }

  reindex(
    _ownerId?: string,
    onProgress?: (event: IndexProgressEvent) => void,
  ): Promise<IndexResult> {
    if (!onProgress) return this.#post<IndexResult>("/memory/reindex", {});
    return this.#streamNdjson<IndexProgressEvent, IndexResult>(
      "/memory/reindex/stream",
      {},
      onProgress,
    );
  }

  // Consume an NDJSON progress stream ({type:"item"} per unit of work, one {type:"done"}
  // carrying the result, in-band {type:"error"}), forwarding item events as they land.
  async #streamNdjson<TItem, TDone>(
    path: string,
    body: unknown,
    onItem?: (event: TItem) => void,
  ): Promise<TDone> {
    const res = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) throw new Error(`memloom server ${res.status}: ${await res.text()}`);

    let result: TDone | null = null;
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line) as { type: string; error?: string };
      if (event.type === "item") {
        const { type: _type, ...item } = event;
        onItem?.(item as TItem);
      } else if (event.type === "done") {
        const { type: _type, ...done } = event;
        result = done as TDone;
      } else if (event.type === "error") {
        throw new Error(event.error ?? "memloom: stream error");
      }
      // Anything else (heartbeat pings, event kinds from a newer daemon) is skipped.
    };

    // The daemon finishes the run even when this stream dies underneath us (idle timeout,
    // network hiccup): say that instead of surfacing a bare "terminated".
    const streamLost = (err: unknown) =>
      new Error(
        `memloom: lost the daemon's progress stream (${err instanceof Error ? err.message : String(err)}). ` +
          "The run continues inside the daemon; check `memloom status` or the viewer for the result.",
      );

    const reader = res.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        let step: { done: boolean; value?: Uint8Array };
        try {
          step = await reader.read();
        } catch (err) {
          throw streamLost(err);
        }
        const { done, value } = step;
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

    if (!result) throw new Error(`memloom: stream ${path} ended without a done event`);
    return result;
  }

  graph(): Promise<Graph> {
    return this.#json<Graph>("/memory/graph");
  }

  async conflicts(): Promise<Conflict[]> {
    const { conflicts } = await this.#json<{ conflicts: Conflict[] }>("/memory/conflicts");
    return conflicts;
  }

  async resolvedConflicts(): Promise<ResolvedConflict[]> {
    const { conflicts } = await this.#json<{ conflicts: ResolvedConflict[] }>(
      "/memory/conflicts/resolved",
    );
    return conflicts;
  }

  async resolveConflict(conflictId: string, decision: ResolveDecision): Promise<void> {
    await this.#post(`/memory/conflicts/${conflictId}/resolve`, decision);
  }

  autoResolveConflicts(
    _ownerId?: string,
    onProgress?: (event: ConflictAutoEvent) => void,
  ): Promise<ConflictAutoResult> {
    return this.#streamNdjson<ConflictAutoEvent, ConflictAutoResult>(
      "/memory/conflicts/resolve-auto/stream",
      {},
      onProgress,
    );
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

  describeSchema(): Promise<SchemaInfo> {
    return this.#json<SchemaInfo>("/memory/schema");
  }

  async setSchemaStatus(id: string, status: "active" | "disabled"): Promise<void> {
    await this.#json(`/memory/schema/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
  }

  async deleteSchemaEntry(id: string): Promise<void> {
    await this.#json(`/memory/schema/${id}`, { method: "DELETE" });
  }

  getAutoIndex(): Promise<{ enabled: boolean; available: boolean }> {
    return this.#json<{ enabled: boolean; available: boolean }>("/memory/auto-index");
  }

  async setAutoIndex(enabled: boolean): Promise<void> {
    await this.#json("/memory/auto-index", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
  }
}
