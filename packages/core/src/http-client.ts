import type { MemoryEngine } from "./engine.js";
import type { SchemaInfo } from "./schema.js";
import type {
  AgentMemoryFolderEvent,
  AgentMemoryImportOptions,
  AgentMemoryImportResult,
  Conflict,
  ConflictAutoEvent,
  ConflictAutoResult,
  ContextAddInput,
  ContextAddResult,
  ContextAddUrlInput,
  ContextDocument,
  ContextProgressEvent,
  DocumentChunks,
  ReconcileOptions,
  ReconcileReport,
  ReconcileRevertResult,
  ReconcileRun,
  ReconcileSettings,
  Graph,
  ImportCaptureScope,
  ImportOptions,
  ImportResult,
  ImportSessionEvent,
  ImportStatus,
  IndexProgressEvent,
  IndexResult,
  Memory,
  NotionListedPage,
  NotionScope,
  NotionStatus,
  NotionSyncEvent,
  NotionSyncOptions,
  NotionSyncResult,
  RecallOptions,
  RelatedEntities,
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

  async relatedEntities(
    target: string,
    opts: { entityType?: string; limit?: number } = {},
  ): Promise<RelatedEntities | null> {
    const params = new URLSearchParams({ q: target });
    if (opts.entityType) params.set("type", opts.entityType);
    if (opts.limit != null) params.set("limit", String(opts.limit));
    const res = await this.#fetch(`${this.#baseUrl}/memory/entities/related?${params}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`memloom server ${res.status}: ${await res.text()}`);
    return (await res.json()) as RelatedEntities;
  }

  importSessions(
    opts: ImportOptions = {},
    onProgress?: (event: ImportSessionEvent) => void,
  ): Promise<ImportResult> {
    // root/ownerId are daemon-side concerns; only the user-facing knobs cross the wire.
    const body = {
      agent: opts.agent,
      days: opts.days,
      maxSessions: opts.maxSessions,
      project: opts.project,
      dryRun: opts.dryRun,
      force: opts.force,
    };
    return this.#streamNdjson<ImportSessionEvent, ImportResult>(
      "/import/sessions/stream",
      body,
      onProgress,
    );
  }

  importAgentMemories(
    opts: AgentMemoryImportOptions = {},
    onProgress?: (event: AgentMemoryFolderEvent) => void,
  ): Promise<AgentMemoryImportResult> {
    // Root overrides and ownerId are daemon-side concerns; only user-facing knobs cross.
    const body = {
      agents: opts.agents,
      project: opts.project,
      dryRun: opts.dryRun,
      force: opts.force,
    };
    return this.#streamNdjson<AgentMemoryFolderEvent, AgentMemoryImportResult>(
      "/import/agent-memory/stream",
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

  notionListPages(): Promise<NotionListedPage[]> {
    return this.#json<NotionListedPage[]>("/notion/pages");
  }

  async setNotionScope(scope: NotionScope): Promise<void> {
    await this.#json("/notion/scope", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope }),
    });
  }

  notionSync(
    opts: NotionSyncOptions = {},
    onProgress?: (event: NotionSyncEvent) => void,
  ): Promise<NotionSyncResult> {
    return this.#streamNdjson<NotionSyncEvent, NotionSyncResult>(
      "/notion/sync/stream",
      { dryRun: opts.dryRun, force: opts.force, wait: opts.wait },
      onProgress,
    );
  }

  notionStatus(): Promise<NotionStatus> {
    return this.#json<NotionStatus>("/notion/status");
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
        // A stream cannot revise its status code once it has begun, so a run that failed
        // reports the reason in its done payload. Raising it here means the caller sees
        // that reason rather than crashing on whichever field it expected to find.
        const failure = (done as { error?: unknown }).error;
        if (typeof failure === "string") throw new Error(failure);
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

  reconcile(opts: ReconcileOptions = {}): Promise<ReconcileReport> {
    return this.#post<ReconcileReport>("/memory/reconcile", {
      mode: opts.mode ?? "dry_run",
      trigger: opts.trigger ?? "manual",
    });
  }

  revertReconcile(runId: string): Promise<ReconcileRevertResult> {
    return this.#post<ReconcileRevertResult>(`/memory/reconcile/${runId}/revert`, {});
  }

  reconcileSettings(): Promise<ReconcileSettings> {
    return this.#json<ReconcileSettings>("/memory/reconcile/settings");
  }

  setReconcileSettings(patch: Partial<ReconcileSettings>): Promise<ReconcileSettings> {
    return this.#post<ReconcileSettings>("/memory/reconcile/settings", patch);
  }

  async reconcileRuns(_ownerId?: string, limit?: number): Promise<ReconcileRun[]> {
    const query = limit ? `?limit=${limit}` : "";
    const { runs } = await this.#json<{ runs: ReconcileRun[] }>(`/memory/reconcile/runs${query}`);
    return runs;
  }

  contextAdd(
    input: ContextAddInput,
    onProgress?: (event: ContextProgressEvent) => void,
    _signal?: AbortSignal,
  ): Promise<ContextAddResult> {
    // Without a callback this stays a plain request, so every non-media format keeps the
    // simpler path and the response shape it already had.
    if (!onProgress) return this.#post<ContextAddResult>("/context/add", input);
    return this.#streamNdjson<ContextProgressEvent, ContextAddResult>(
      "/context/add/stream",
      input,
      onProgress,
    );
  }

  contextAddUrl(input: ContextAddUrlInput): Promise<ContextAddResult> {
    return this.#post<ContextAddResult>("/context/url", input);
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
