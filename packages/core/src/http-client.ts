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
  ContextRoot,
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
  MemoryAttachInput,
  MemoryAttachment,
  NotionListedPage,
  NotionScope,
  NotionStatus,
  NotionSyncEvent,
  NotionSyncOptions,
  NotionSyncResult,
  PossibleAnswer,
  PossibleContradiction,
  RecallOptions,
  ReconcileAction,
  ReconcileDecision,
  ReconcileOptions,
  ReconcileReport,
  ReconcileRevertResult,
  ReconcileRun,
  ReconcileSettings,
  RelatedEntities,
  ResolveDecision,
  ResolvedConflict,
  SaveInput,
  SaveResult,
  Scope,
  ScopeBackfillReport,
  ScopeNode,
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

/** The header that carries the owner from a client to the daemon. */
export const OWNER_HEADER = "x-memloom-owner";

// A MemoryEngine backed by a running `memloom serve` over HTTP. Same shape as the local engine.
//
// One client is bound to one owner, set once at construction and sent as a header on every
// request. Not per call: the engine contract lets an ownerId be passed to almost every method,
// and threading that across a wire meant either 100 body fields or 100 chances to forget one.
// A surface (the CLI, the MCP server) is one person for its whole life anyway.
//
// Omit the owner and the daemon falls back to the sentinel, which is what every single-owner
// install has always been. Nothing about an existing store changes.
export class HttpMemloomClient implements MemoryEngine {
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  /** The owner every request from this client carries, or undefined for the daemon default. */
  readonly ownerId: string | undefined;
  /** Bearer token for a server that requires one (a hosted memloom); none for the local daemon. */
  readonly #token: string | undefined;

  constructor(baseUrl: string, fetchImpl?: FetchLike, ownerId?: string, token?: string) {
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#fetch = fetchImpl ?? (globalThis as unknown as { fetch: FetchLike }).fetch;
    this.ownerId = ownerId;
    this.#token = token;
  }

  /**
   * The single fetch choke point, so the owner header cannot be forgotten at one call site.
   * Every request in this class goes through here.
   */
  #req(path: string, init?: Parameters<FetchLike>[1]): Promise<HttpResponse> {
    const headers = { ...init?.headers };
    if (this.ownerId !== undefined) headers[OWNER_HEADER] = this.ownerId;
    if (this.#token !== undefined) headers.authorization = `Bearer ${this.#token}`;
    return this.#fetch(`${this.#baseUrl}${path}`, { ...init, headers });
  }

  /**
   * Guard the per-call ownerId the engine contract carries. This client is already bound, so a
   * caller naming a DIFFERENT owner is asking for something the connection cannot do. Silently
   * serving them the bound owner's memories instead is the exact failure this design exists to
   * remove, so it fails loudly. Undefined means "whoever this client is", which is the norm.
   */
  #owned(ownerId: string | undefined): void {
    if (ownerId !== undefined && ownerId !== this.ownerId) {
      throw new Error(
        `memloom: this connection is bound to owner ${this.ownerId ?? "(daemon default)"}, ` +
          `so it cannot act for ${ownerId}. Open a client for that owner instead.`,
      );
    }
  }

  async #json<T>(path: string, init?: Parameters<FetchLike>[1]): Promise<T> {
    const res = await this.#req(path, init);
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
    this.#owned(input.ownerId);
    // The owner rides the header, not the body. Sending both would let a stale body field
    // disagree with the connection, and the daemon rejects that rather than guess.
    const { ownerId: _owner, ...body } = input;
    return this.#post<SaveResult>("/memory/save", body);
  }

  async memories(ownerId?: string, opts?: { scope?: string; tags?: string[] }): Promise<Memory[]> {
    this.#owned(ownerId);
    const params = new URLSearchParams();
    if (opts?.scope) params.set("scope", opts.scope);
    if (opts?.tags?.length) params.set("tags", opts.tags.join(","));
    const qs = params.size > 0 ? `?${params}` : "";
    const { memories } = await this.#json<{ memories: Memory[] }>(`/memory/list${qs}`);
    return memories;
  }

  async recall(query: string, opts?: RecallOptions): Promise<Memory[]> {
    this.#owned(opts?.ownerId);
    const { memories } = await this.#post<{ memories: Memory[] }>("/memory/query", {
      query,
      limit: opts?.limit,
      scope: opts?.scope,
      tags: opts?.tags,
    });
    return memories;
  }

  async listScopes(ownerId?: string): Promise<ScopeNode[]> {
    this.#owned(ownerId);
    const { scopes } = await this.#json<{ scopes: ScopeNode[] }>("/scopes");
    return scopes;
  }

  createScope(path: string, opts: { ownerId?: string; description?: string } = {}): Promise<Scope> {
    this.#owned(opts.ownerId);
    return this.#post<Scope>("/scopes", { path, description: opts.description });
  }

  updateScope(
    scopeId: string,
    changes: { name?: string; description?: string | null },
    ownerId?: string,
  ): Promise<Scope> {
    this.#owned(ownerId);
    return this.#post<Scope>(`/scopes/${scopeId}/update`, changes);
  }

  async moveScope(scopeId: string, newParentId: string | null, ownerId?: string): Promise<void> {
    this.#owned(ownerId);
    await this.#post(`/scopes/${scopeId}/move`, { parentId: newParentId });
  }

  async deleteScope(scopeId: string, ownerId?: string): Promise<void> {
    this.#owned(ownerId);
    await this.#json(`/scopes/${scopeId}`, { method: "DELETE" });
  }

  async setMemoryScopes(memoryIds: string[], scope: string, ownerId?: string): Promise<number> {
    this.#owned(ownerId);
    const { moved } = await this.#post<{ moved: number }>("/memory/scope", {
      ids: memoryIds,
      scope,
    });
    return moved;
  }

  async setDocumentScope(documentId: string, scope: string, ownerId?: string): Promise<void> {
    this.#owned(ownerId);
    await this.#post(`/context/documents/${documentId}/scope`, { scope });
  }

  backfillScopes(opts: { dryRun?: boolean; ownerId?: string } = {}): Promise<ScopeBackfillReport> {
    this.#owned(opts.ownerId);
    return this.#post<ScopeBackfillReport>("/scopes/backfill", { dryRun: opts.dryRun ?? false });
  }

  update(input: UpdateInput): Promise<UpdateResult> {
    return this.#post<UpdateResult>(`/memory/${input.id}/update`, {
      content: input.content,
      canonical: input.canonical,
    });
  }

  async history(memoryId: string, ownerId?: string): Promise<Memory[]> {
    this.#owned(ownerId);
    const { versions } = await this.#json<{ versions: Memory[] }>(`/memory/${memoryId}/history`);
    return versions;
  }

  async deleteMemory(memoryId: string, ownerId?: string): Promise<void> {
    this.#owned(ownerId);
    await this.#json(`/memory/${memoryId}`, { method: "DELETE" });
  }

  /**
   * The bytes go over as base64, which is the same trade `contextAttach` makes.
   *
   * A multipart upload would save a third of the transfer and cost a body parser on a route
   * that is otherwise pure JSON. This is a daemon on localhost taking phone photos; a
   * megabyte becoming 1.4 is not the constraint.
   */
  async memoryAttach(input: MemoryAttachInput): Promise<MemoryAttachment> {
    this.#owned(input.ownerId);
    return this.#post<MemoryAttachment>(`/memory/${input.memoryId}/attachments`, {
      filename: input.filename,
      bytes: Buffer.from(input.bytes).toString("base64"),
      mediaType: input.mediaType,
    });
  }

  async memoryAttachments(memoryId: string, ownerId?: string): Promise<MemoryAttachment[]> {
    this.#owned(ownerId);
    const { attachments } = await this.#json<{ attachments: MemoryAttachment[] }>(
      `/memory/${memoryId}/attachments`,
    );
    return attachments;
  }

  async memoryDetach(attachmentId: string, ownerId?: string): Promise<void> {
    this.#owned(ownerId);
    await this.#json(`/memory/attachments/${attachmentId}`, { method: "DELETE" });
  }

  async passage(id: string, ownerId?: string): Promise<string | null> {
    this.#owned(ownerId);
    const res = await this.#req(`/memory/passage/${id}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`memloom server ${res.status}: ${await res.text()}`);
    const { content } = (await res.json()) as { content: string };
    return content;
  }

  async relatedEntities(
    target: string,
    opts: { ownerId?: string; entityType?: string; limit?: number } = {},
  ): Promise<RelatedEntities | null> {
    this.#owned(opts.ownerId);
    const params = new URLSearchParams({ q: target });
    if (opts.entityType) params.set("type", opts.entityType);
    if (opts.limit != null) params.set("limit", String(opts.limit));
    const res = await this.#req(`/memory/entities/related?${params}`);
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

  index(ownerId?: string, onProgress?: (event: IndexProgressEvent) => void): Promise<IndexResult> {
    this.#owned(ownerId);
    if (!onProgress) return this.#post<IndexResult>("/memory/index", {});
    return this.#streamNdjson<IndexProgressEvent, IndexResult>(
      "/memory/index/stream",
      {},
      onProgress,
    );
  }

  reindex(
    ownerId?: string,
    onProgress?: (event: IndexProgressEvent) => void,
  ): Promise<IndexResult> {
    this.#owned(ownerId);
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
    const res = await this.#req(path, {
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

  graph(ownerId?: string): Promise<Graph> {
    this.#owned(ownerId);
    return this.#json<Graph>("/memory/graph");
  }

  async conflicts(ownerId?: string): Promise<Conflict[]> {
    this.#owned(ownerId);
    const { conflicts } = await this.#json<{ conflicts: Conflict[] }>("/memory/conflicts");
    return conflicts;
  }

  async resolvedConflicts(ownerId?: string): Promise<ResolvedConflict[]> {
    this.#owned(ownerId);
    const { conflicts } = await this.#json<{ conflicts: ResolvedConflict[] }>(
      "/memory/conflicts/resolved",
    );
    return conflicts;
  }

  async resolveConflict(conflictId: string, decision: ResolveDecision): Promise<void> {
    await this.#post(`/memory/conflicts/${conflictId}/resolve`, decision);
  }

  autoResolveConflicts(
    ownerId?: string,
    onProgress?: (event: ConflictAutoEvent) => void,
  ): Promise<ConflictAutoResult> {
    this.#owned(ownerId);
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
      // Forwarded, or the same call would run different passes for a different price depending
      // on which implementation of the interface it reached.
      ...(opts.passes ? { passes: opts.passes } : {}),
      ...(opts.budgetUsd != null ? { budgetUsd: opts.budgetUsd } : {}),
    });
  }

  revertReconcile(runId: string, ownerId?: string): Promise<ReconcileRevertResult> {
    this.#owned(ownerId);
    return this.#post<ReconcileRevertResult>(`/memory/reconcile/${runId}/revert`, {});
  }

  stopReconcile(runId: string, ownerId?: string): Promise<{ stopped: boolean }> {
    this.#owned(ownerId);
    return this.#post<{ stopped: boolean }>(`/memory/reconcile/${runId}/stop`, {});
  }

  reconcileSettings(): Promise<ReconcileSettings> {
    return this.#json<ReconcileSettings>("/memory/reconcile/settings");
  }

  setReconcileSettings(patch: Partial<ReconcileSettings>): Promise<ReconcileSettings> {
    return this.#post<ReconcileSettings>("/memory/reconcile/settings", patch);
  }

  async reconcileRuns(ownerId?: string, limit?: number): Promise<ReconcileRun[]> {
    this.#owned(ownerId);
    const query = limit ? `?limit=${limit}` : "";
    const { runs } = await this.#json<{ runs: ReconcileRun[] }>(`/memory/reconcile/runs${query}`);
    return runs;
  }

  async reconcileActions(runId: string, ownerId?: string): Promise<ReconcileAction[]> {
    this.#owned(ownerId);
    const { actions } = await this.#json<{ actions: ReconcileAction[] }>(
      `/memory/reconcile/runs/${runId}/actions`,
    );
    return actions;
  }

  // The route serves the daemon's own page size, so a limit here would only describe a cap the
  // wire does not carry.
  async possibleContradictions(
    ownerId?: string,
    _limit?: number,
  ): Promise<PossibleContradiction[]> {
    this.#owned(ownerId);
    const { possible } = await this.#json<{ possible: PossibleContradiction[] }>(
      "/memory/reconcile/possible",
    );
    return possible;
  }

  answerPossible(
    actionId: string,
    decision: Extract<ReconcileDecision, "approved" | "rejected">,
    ownerId?: string,
  ): Promise<PossibleAnswer> {
    this.#owned(ownerId);
    return this.#post<PossibleAnswer>(`/memory/reconcile/possible/${actionId}/answer`, {
      decision,
    });
  }

  contextAdd(
    input: ContextAddInput,
    onProgress?: (event: ContextProgressEvent) => void,
    _signal?: AbortSignal,
  ): Promise<ContextAddResult> {
    this.#owned(input.ownerId);
    const { ownerId: _owner, ...body } = input;
    // Without a callback this stays a plain request, so every non-media format keeps the
    // simpler path and the response shape it already had.
    if (!onProgress) return this.#post<ContextAddResult>("/context/add", body);
    return this.#streamNdjson<ContextProgressEvent, ContextAddResult>(
      "/context/add/stream",
      body,
      onProgress,
    );
  }

  contextAddUrl(input: ContextAddUrlInput): Promise<ContextAddResult> {
    this.#owned(input.ownerId);
    const { ownerId: _owner, ...body } = input;
    return this.#post<ContextAddResult>("/context/url", body);
  }

  async contextList(ownerId?: string): Promise<ContextDocument[]> {
    this.#owned(ownerId);
    const { documents } = await this.#json<{ documents: ContextDocument[] }>("/context/documents");
    return documents;
  }

  contextChunks(documentId: string, ownerId?: string): Promise<DocumentChunks> {
    this.#owned(ownerId);
    return this.#json<DocumentChunks>(`/context/documents/${documentId}/chunks`);
  }

  async contextRemove(documentId: string, ownerId?: string): Promise<void> {
    this.#owned(ownerId);
    await this.#json(`/context/documents/${documentId}`, { method: "DELETE" });
  }

  contextRootAdd(path: string, ownerId?: string): Promise<ContextRoot> {
    this.#owned(ownerId);
    return this.#post<ContextRoot>("/context/roots", { path });
  }

  async contextRoots(ownerId?: string): Promise<ContextRoot[]> {
    this.#owned(ownerId);
    const { roots } = await this.#json<{ roots: ContextRoot[] }>("/context/roots");
    return roots;
  }

  // The routes answer 404 when the id is not there and #json throws on that, so "did anything
  // change" comes back as a boolean here, matching what the engine returns in process.
  async contextRootWatch(rootId: string, watching: boolean, ownerId?: string): Promise<boolean> {
    this.#owned(ownerId);
    return await this.#ok(`/context/roots/${rootId}/watch`, { watching });
  }

  async contextRootRemove(rootId: string, ownerId?: string): Promise<boolean> {
    this.#owned(ownerId);
    try {
      await this.#json(`/context/roots/${rootId}`, { method: "DELETE" });
      return true;
    } catch {
      return false;
    }
  }

  async contextWatch(documentId: string, watching: boolean, ownerId?: string): Promise<boolean> {
    this.#owned(ownerId);
    return await this.#ok(`/context/documents/${documentId}/watch`, { watching });
  }

  async #ok(path: string, body: unknown): Promise<boolean> {
    try {
      await this.#post(path, body);
      return true;
    } catch {
      return false;
    }
  }

  describeSchema(ownerId?: string): Promise<SchemaInfo> {
    this.#owned(ownerId);
    return this.#json<SchemaInfo>("/memory/schema");
  }

  async setSchemaStatus(
    id: string,
    status: "active" | "disabled",
    ownerId?: string,
  ): Promise<void> {
    this.#owned(ownerId);
    await this.#json(`/memory/schema/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
  }

  async deleteSchemaEntry(id: string, ownerId?: string): Promise<void> {
    this.#owned(ownerId);
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
