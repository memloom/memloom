import { createHash, randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import {
  AGENT_MEMORY_SOURCES,
  type AgentMemorySource,
  type AgentMemoryUnit,
  locateAgentMemoryFolders,
  parseAgentMemoryFolder,
} from "./agent-memories.js";
import { type AssistantEvent, runAssistantTurn } from "./assistant.js";
import { chunkMarkdown, chunkOutline } from "./chunker.js";
import {
  chunkUnits,
  discoverSessions,
  hashPrefix,
  parseSession,
  type SessionChunk,
  type SessionUnit,
} from "./claude-sessions.js";
import { type ResolverSide, resolveConflictWithContext } from "./conflict-resolver.js";
import { type Candidate, classify } from "./dedup.js";
import { type DistilledMemory, distillChunk } from "./distill.js";
import type { MemoryEngine } from "./engine.js";
import { type ExtractionContext, entityNameKey, extractGraph, isMathDense } from "./entities.js";
import { type ExtractedFile, extractBytes, extractFile } from "./extract.js";
import { NullLLMProvider } from "./hashing-provider.js";
import { migrate } from "./migrate.js";
import { dataSourceTitle, expandsInline, NotionClient, pageTitle } from "./notion.js";
import type { NotionBlockNode } from "./notion.js";
import { blocksToMarkdown, rowsToMarkdown } from "./notion-markdown.js";
import { type EmbeddingProvider, isChatProvider, type LLMProvider } from "./providers.js";
import { redact } from "./redact.js";
import {
  addEdge,
  addEdgeIfAbsent,
  deactivateEdgesTouching,
  markStale,
  reactivate,
} from "./resolve.js";
import {
  type ActiveSchema,
  EDGE_RELATIONS,
  ENTITY_TYPES,
  normalizeSchemaName,
  PREDICATES,
  PROPOSAL_MIN_OCCURRENCES,
  type ProposalExample,
  type SchemaEntry,
  type SchemaInfo,
  type SchemaKind,
} from "./schema.js";
import type { StorageAdapter } from "./storage.js";
import type {
  AgentMemoryFolderEvent,
  AgentMemoryImportOptions,
  AgentMemoryImportResult,
  AssistantChatResult,
  AssistantMessage,
  AssistantSession,
  AssistantSessionHit,
  AssistantSource,
  Conflict,
  ConflictAutoEvent,
  ConflictAutoResult,
  ConflictCandidate,
  ContextAddInput,
  ContextAddResult,
  ContextAttachInput,
  ContextAttachResult,
  ContextDocument,
  DocumentChunks,
  Entity,
  EntityDetail,
  Graph,
  GraphDocument,
  GraphEdge,
  GraphMemory,
  ImportCaptureScope,
  ImportOptions,
  ImportResult,
  ImportSessionEvent,
  ImportStatus,
  NotionListedPage,
  NotionScope,
  NotionStatus,
  NotionSyncEvent,
  NotionSyncOptions,
  NotionSyncResult,
  IndexProgressEvent,
  IndexResult,
  IndexRun,
  IndexRunEvent,
  Memory,
  MemoryType,
  RecallOptions,
  ReembedOptions,
  ReembedProgressEvent,
  ReembedResult,
  ResolveDecision,
  ResolvedConflict,
  SaveInput,
  SaveResult,
  UpdateInput,
  UpdateResult,
} from "./types.js";
import { toVectorLiteral } from "./vector.js";

// The fixed owner for the single-user embedded tier. Multi-tenant hosts pass a real
// ownerId per call; the column exists everywhere so the schema is sync/cloud-ready.
export const SENTINEL_OWNER = "00000000-0000-0000-0000-000000000000";

// Dedup only considers existing memories at least this similar to the incoming one.
const CANDIDATE_THRESHOLD = 0.5;
const CANDIDATE_LIMIT = 5;

// Session import: how many lines before a ledger watermark a tail run re-reads (context for
// decisions cut mid-thought), and how much source text one provenance excerpt keeps.
const IMPORT_OVERLAP_LINES = 40;
const PROVENANCE_EXCERPT_CHARS = 500;

// The transcript lines a distilled memory came from: stored as provenance and handed to the
// save-time conflict resolver as evidence.
function excerptOf(memory: DistilledMemory, chunk: SessionChunk): string {
  return chunk.units
    .filter((unit) => unit.line >= memory.startLine && unit.line <= memory.endLine)
    .map((unit) => unit.text)
    .join("\n")
    .slice(0, PROVENANCE_EXCERPT_CHARS);
}

/** The daemon host's IANA timezone: the user's calendar day for date-scoped recall. */
function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// Unattended capture (the session-end hook, the startup sweep) spends provider credits with
// nobody watching, so it runs against a per-day distillation call budget. Hitting the cap
// pauses capture loudly in `memloom status`; attended `memloom import` runs are never capped.
const UNATTENDED_DAILY_CALL_CAP = 200;

// _memloom_meta keys for hook capture state. The scope is what `connect` configured
// (project allowlist or "all"); the notify keys are what `memloom status` renders.
// The import_ledger/import_provenance source value for agent memory folders. Session import
// owns "claude-code"; keeping the sources distinct keeps status counts and provenance honest.
const AGENT_MEMORY_LEDGER_SOURCE = "agent-memory";

/** Narrow a wire-level agent list to the supported sources; unknown names are an input error. */
function normalizeAgentSelection(agents?: string[]): AgentMemorySource[] | undefined {
  if (!agents || agents.length === 0) return undefined;
  return agents.map((agent) => {
    if (!(AGENT_MEMORY_SOURCES as readonly string[]).includes(agent)) {
      throw new Error(
        `memloom: unknown agent "${agent}" (expected ${AGENT_MEMORY_SOURCES.join(" | ")})`,
      );
    }
    return agent as AgentMemorySource;
  });
}

const IMPORT_SCOPE_KEY = "import_capture_scope";
const IMPORT_NOTIFY_AT_KEY = "import_last_notify_at";
const IMPORT_NOTIFY_ERROR_KEY = "import_last_notify_error";
const importCallsKey = () => `import_unattended_calls_${new Date().toLocaleDateString("en-CA")}`;

// Notion connector state: the selection, the run bookkeeping, and one last_edited_time
// watermark per selected item so unchanged pages cost one metadata request, zero fetches.
const NOTION_SCOPE_KEY = "notion_scope";
const NOTION_SYNC_AT_KEY = "notion_last_sync_at";
const NOTION_SYNC_ERROR_KEY = "notion_last_sync_error";
const notionEditedKey = (id: string) => `notion_edited_${id}`;
// The block tree from the last successful sync, JSON. Lets the next sync list only the
// page's top level and refetch just the sections whose last_edited_time moved, instead
// of re-downloading thousands of blocks to pick up one day's diary entry.
const notionTreeKey = (id: string) => `notion_tree_${id}`;
const NOTION_TREE_CACHE_VERSION = 1;

interface NotionTreeCache {
  v: number;
  truncated: boolean;
  nodes: NotionBlockNode[];
}

// Salted into every synced document's content hash; bump when the block-to-markdown
// pipeline changes so existing documents re-chunk instead of no-oping on stale content.
// v2: signed Notion-hosted file URLs dropped; block cap raised and truncation reported.
const NOTION_PIPELINE_VERSION = 2;

// _memloom_meta key set while a reembed() is underway; its presence means the store's vectors
// are partially NULL and must not be served until the migration finishes.
const REEMBED_MARKER_KEY = "embedding_migration_target";

/**
 * The fingerprint guard's refusal, as a typed error so hosts (the CLI daemon) can attach the
 * `memloom reembed` hint. `reembedInProgress` distinguishes "config changed" from "a re-embed
 * was started but never finished".
 */
export class EmbeddingFingerprintError extends Error {
  constructor(
    readonly stored: string | null,
    readonly current: string,
    readonly reembedInProgress: boolean,
    message: string,
  ) {
    super(message);
    this.name = "EmbeddingFingerprintError";
  }
}

export interface InitOptions {
  /**
   * "require" (default) refuses to open a store whose vectors came from a different embedding
   * config. "tolerate" skips the refusal without ever overwriting the stored fingerprint: the
   * reembed() maintenance path, which is ABOUT to replace those vectors.
   */
  fingerprint?: "require" | "tolerate";
}

// All config is injected: core never reads process.env or global state (build-plan
// architectural rule 2).
export interface MemloomConfig {
  storage: StorageAdapter;
  embedding: EmbeddingProvider;
  llm: LLMProvider;
  /** Run the belief pipeline (dedup + conflict detection) on save. Default true. */
  dedup?: boolean;
  /** Fetch used by the Notion connector; tests inject a fake. Default globalThis.fetch. */
  notionFetch?: typeof globalThis.fetch;
  /**
   * Index new memories and chunks automatically, in the background, shortly after a
   * save/ingest, so the entity arm of recall works without an explicit `memloom index`.
   * Debounced (a folder ingest becomes one run) and single-flight. Default false; the
   * daemon turns it on when an LLM is configured (extraction needs one).
   */
  autoIndex?: boolean;
  /** Debounce window before an auto index run starts. Default 1500ms; tests shrink it. */
  autoIndexDelayMs?: number;
}

interface MemoryRow {
  id: string;
  owner_id: string;
  status: Memory["status"];
  memory_type: Memory["memoryType"];
  canonical: string | null;
  content: string;
  summary: string | null;
  root_id: string;
  version: number;
  asserted_at: string;
  created_at: string;
  similarity?: number;
  rrf_score?: number;
}

// A dedup candidate enriched with its lineage, so an "identical" restatement can append a new
// version to the right belief. Structurally a Candidate, so it still feeds classify().
interface CandidateRow extends Candidate {
  rootId: string;
  version: number;
}

interface RecallRow extends Partial<MemoryRow> {
  id: string;
  src: "memory" | "chunk";
  rrf_score: number;
  similarity: number;
  c_owner_id: string | null;
  c_content: string | null;
  c_heading_path: string | null;
  c_page: number | null;
  c_created_at: string | null;
  d_id: string | null;
  d_title: string | null;
  d_path: string | null;
}

function mapRecallRow(row: RecallRow): Memory {
  if (row.src === "chunk") {
    return {
      id: row.id,
      ownerId: row.c_owner_id ?? "",
      status: "active",
      memoryType: "context",
      canonical: null,
      content: row.c_content ?? "",
      summary: null,
      rootId: row.id,
      version: 1,
      assertedAt: row.c_created_at ?? "",
      createdAt: row.c_created_at ?? "",
      similarity: Number(row.similarity),
      rrfScore: Number(row.rrf_score),
      kind: "context",
      source: {
        documentId: row.d_id ?? "",
        title: row.d_title ?? "",
        path: row.d_path ?? "",
        headingPath: row.c_heading_path,
        page: row.c_page,
      },
    };
  }
  return { ...mapRow(row as MemoryRow), rrfScore: Number(row.rrf_score), kind: "memory" };
}

function mapRow(row: MemoryRow): Memory {
  return {
    id: row.id,
    ownerId: row.owner_id,
    status: row.status,
    memoryType: row.memory_type,
    canonical: row.canonical,
    content: row.content,
    summary: row.summary,
    rootId: row.root_id,
    version: Number(row.version),
    assertedAt: row.asserted_at,
    createdAt: row.created_at,
    ...(row.similarity !== undefined ? { similarity: Number(row.similarity) } : {}),
    ...(row.rrf_score !== undefined ? { rrfScore: Number(row.rrf_score) } : {}),
  };
}

export class Memloom implements MemoryEngine {
  readonly #storage: StorageAdapter;
  readonly #embedding: EmbeddingProvider;
  readonly #llm: LLMProvider;
  readonly #dedup: boolean;
  readonly #notionFetch: typeof globalThis.fetch;
  // Dedup classifier calls made since construction; the import path reads the delta so its
  // cost line reports classifier spend exactly, not an estimate.
  #classifyCalls = 0;
  #autoIndex: boolean;
  // Toggling only makes sense where the host declared a stance (the daemon passes the
  // flag whenever an LLM is configured). Hosts that never mention autoIndex (library
  // embedders, offline mode) have no toggle: enabling it would only produce failing runs.
  readonly #autoIndexCapable: boolean;
  readonly #autoIndexDelay: number;
  #autoIndexTimer: ReturnType<typeof setTimeout> | undefined;
  #autoIndexRunning = false;
  #autoIndexAgain = false;

  constructor(config: MemloomConfig) {
    this.#storage = config.storage;
    this.#embedding = config.embedding;
    this.#llm = config.llm;
    this.#dedup = config.dedup ?? true;
    this.#notionFetch = config.notionFetch ?? globalThis.fetch;
    this.#autoIndex = config.autoIndex ?? false;
    this.#autoIndexCapable = config.autoIndex !== undefined;
    this.#autoIndexDelay = config.autoIndexDelayMs ?? 1500;
  }

  /** Whether the host supports toggling auto-index at all (an LLM is configured). */
  get autoIndexAvailable(): boolean {
    return this.#autoIndexCapable;
  }

  /** MemoryEngine shape of the two getters, for HTTP-routed surfaces (CLI, MCP). */
  async getAutoIndex(): Promise<{ enabled: boolean; available: boolean }> {
    return { enabled: this.#autoIndex, available: this.#autoIndexCapable };
  }

  get autoIndexEnabled(): boolean {
    return this.#autoIndex;
  }

  /**
   * Turn auto-indexing on or off at runtime (the Console toggle). Persisted in the store's
   * meta table, so the choice survives daemon restarts; the config/env value is only the
   * default before the toggle is ever used.
   */
  async setAutoIndex(enabled: boolean): Promise<void> {
    if (!this.#autoIndexCapable) {
      throw new Error("memloom: auto-index needs an LLM; configure OPENROUTER_API_KEY first");
    }
    await this.#storage.query(
      `INSERT INTO _memloom_meta (key, value) VALUES ('auto_index', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [enabled ? "on" : "off"],
    );
    this.#autoIndex = enabled;
    if (!enabled) clearTimeout(this.#autoIndexTimer);
  }

  /**
   * Auto-index: schedule a background entity-extraction run after a write. Debounced so a
   * burst of saves (a folder ingest) collapses into one run; single-flight so overlapping
   * runs never double-process pending rows (a write DURING a run queues one trailing
   * re-run). Failures are logged, never thrown: the write that triggered this already
   * succeeded, and failed items stay unindexed for the next run to retry.
   */
  #scheduleAutoIndex(owner: string): void {
    if (!this.#autoIndex) return;
    clearTimeout(this.#autoIndexTimer);
    this.#autoIndexTimer = setTimeout(() => void this.#runAutoIndex(owner), this.#autoIndexDelay);
    // Never hold the process open for a pending background run.
    this.#autoIndexTimer.unref?.();
  }

  async #runAutoIndex(owner: string): Promise<void> {
    if (this.#autoIndexRunning) {
      this.#autoIndexAgain = true;
      return;
    }
    this.#autoIndexRunning = true;
    try {
      await this.index(owner);
    } catch (err) {
      console.error(
        `memloom: auto-index failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.#autoIndexRunning = false;
      if (this.#autoIndexAgain) {
        this.#autoIndexAgain = false;
        this.#scheduleAutoIndex(owner);
      }
    }
  }

  /** The injected dependencies, exposed read-only for host wiring and tests. */
  get deps(): Readonly<Omit<MemloomConfig, "dedup">> {
    return { storage: this.#storage, embedding: this.#embedding, llm: this.#llm };
  }

  /** Run pending migrations. Idempotent; call once after constructing. */
  async init(opts: InitOptions = {}): Promise<void> {
    await migrate(this.#storage, this.#embedding.dims);
    await this.#checkEmbeddingFingerprint(opts.fingerprint ?? "require");
    // A persisted Console toggle beats the config/env default, but only where the host
    // supports auto-indexing at all (see #autoIndexCapable).
    if (this.#autoIndexCapable) {
      const [row] = await this.#storage.query<{ value: string }>(
        "SELECT value FROM _memloom_meta WHERE key = 'auto_index'",
      );
      if (row) this.#autoIndex = row.value === "on";
    }
  }

  // A store's vectors are only comparable to vectors from the same provider+model+dims. The
  // first init stamps the store; any later init with a different fingerprint is refused:
  // otherwise recall degrades silently (offline-embedded and cloud-embedded memories look
  // fine individually but never match each other). "tolerate" is reembed()'s way in.
  async #checkEmbeddingFingerprint(mode: "require" | "tolerate"): Promise<void> {
    const current = this.#embedding.fingerprint;
    const rows = await this.#storage.query<{ key: string; value: string }>(
      `SELECT key, value FROM _memloom_meta
       WHERE key IN ('embedding_fingerprint', '${REEMBED_MARKER_KEY}')`,
    );
    const stored = rows.find((r) => r.key === "embedding_fingerprint")?.value;
    const marker = rows.find((r) => r.key === REEMBED_MARKER_KEY)?.value;
    if (mode === "tolerate") return;
    // A half-finished reembed leaves NULL vectors behind; refuse to serve even when the
    // fingerprint matches (the user may have restored the old config after interrupting).
    if (marker !== undefined) {
      throw new EmbeddingFingerprintError(
        stored ?? null,
        current,
        true,
        `a re-embed of this store (to "${marker}") was started but not finished, so some ` +
          "embeddings are missing. Run `memloom reembed` to finish it.",
      );
    }
    if (stored === undefined) {
      await this.#storage.query(
        `INSERT INTO _memloom_meta (key, value) VALUES ('embedding_fingerprint', $1)
         ON CONFLICT (key) DO NOTHING`,
        [current],
      );
      return;
    }
    if (stored !== current) {
      throw new EmbeddingFingerprintError(
        stored,
        current,
        false,
        `this store's memories were embedded with "${stored}", but the engine is now configured ` +
          `with "${current}". Different embedding providers/models produce incompatible vector ` +
          "spaces, so recall would silently return garbage. Either restore the previous embedding " +
          "config, run `memloom reembed` with the new one, or start fresh by deleting the data " +
          "directory.",
      );
    }
  }

  /**
   * Cheap liveness probe of the store. When a Postgres wire client (Drizzle Studio, psql) is
   * attached to the daemon it holds PGLite's exclusive lock and this queues: the server races
   * it against a timeout to fail fast instead of hanging every request.
   */
  async ping(): Promise<void> {
    await this.#storage.query("select 1");
  }

  /**
   * Ingest a file as context (any registered extractor's format): extract, chunk, embed,
   * store. Documents are
   * MIRRORS of files: no belief pipeline, no conflicts; re-adding a changed file replaces
   * its chunks in one transaction, and an unchanged file (same content hash) is a no-op.
   */
  async contextAdd(input: ContextAddInput): Promise<ContextAddResult> {
    const owner = input.ownerId ?? SENTINEL_OWNER;
    const file = await extractFile(input.path, (bytes) =>
      createHash("sha256").update(bytes).digest("hex"),
    );
    const result = await this.#ingestDocument(owner, input.path, file, null);
    if (result.outcome !== "unchanged") this.#scheduleAutoIndex(owner);
    return result;
  }

  /**
   * Attach an uploaded file to one assistant chat: the same extract/chunk/embed pipeline
   * as contextAdd, but the document and its chunks carry the session id, so only that
   * chat's recall sees them and deleting the chat deletes them. No file touches disk:
   * the synthetic attachment:// path exists only to key the UNIQUE(owner, path) dedup
   * (re-attaching the same bytes to the same chat is a no-op).
   */
  async contextAttach(input: ContextAttachInput): Promise<ContextAttachResult> {
    const owner = input.ownerId ?? SENTINEL_OWNER;
    const file = await extractBytes(input.bytes, input.filename, (bytes) =>
      createHash("sha256").update(bytes).digest("hex"),
    );

    let sessionId = input.sessionId;
    if (sessionId) {
      const found = await this.#storage.query(
        "SELECT id FROM assistant_sessions WHERE owner_id = $1 AND id = $2",
        [owner, sessionId],
      );
      if (found.length === 0) throw new Error(`no assistant session ${sessionId}`);
    } else {
      // Attach-before-first-message: the session exists from the attach on. It keeps the
      // 'New chat' default title; assistantChat retitles it from the first message.
      const [row] = await this.#storage.query<{ id: string }>(
        "INSERT INTO assistant_sessions (owner_id) VALUES ($1) RETURNING id",
        [owner],
      );
      if (!row) throw new Error("memloom: could not create assistant session");
      sessionId = row.id;
    }

    const path = `attachment://${sessionId}/${input.filename}`;
    const result = await this.#ingestDocument(owner, path, file, sessionId);
    return { ...result, sessionId };
  }

  /**
   * Ingest an uploaded file's bytes as a GLOBAL document: the browser file dialog gives
   * bytes, never disk paths. Provenance is upload://<filename>, so re-uploading the same
   * name replaces it (hash short-circuit applies); there is no disk file to "open".
   * Unlike contextAttach, the result is a first-class document: listed, graphed, indexed.
   */
  async contextUpload(input: {
    filename: string;
    bytes: Uint8Array;
    ownerId?: string;
  }): Promise<ContextAddResult> {
    const owner = input.ownerId ?? SENTINEL_OWNER;
    const file = await extractBytes(input.bytes, input.filename, (bytes) =>
      createHash("sha256").update(bytes).digest("hex"),
    );
    const result = await this.#ingestDocument(owner, `upload://${input.filename}`, file, null);
    if (result.outcome !== "unchanged" && result.outcome !== "exists") {
      this.#scheduleAutoIndex(owner);
    }
    return result;
  }

  /** The files attached to one assistant chat, newest first. */
  async sessionAttachments(
    sessionId: string,
    ownerId: string = SENTINEL_OWNER,
  ): Promise<ContextDocument[]> {
    const rows = await this.#storage.query<{
      id: string;
      path: string;
      title: string;
      kind: string;
      chunk_count: number;
      updated_at: string;
    }>(
      `SELECT id, path, title, kind, chunk_count, updated_at
       FROM context_documents WHERE owner_id = $1 AND session_id = $2 ORDER BY updated_at DESC`,
      [ownerId, sessionId],
    );
    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      title: r.title,
      kind: r.kind,
      chunkCount: Number(r.chunk_count),
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Shared ingest: hash short-circuit, replace-or-insert document, insert chunks. For
   * global docs it also enforces ONE document per file across the upload:// and linked
   * namespaces: a link absorbs matching upload snapshots (same content, or same filename
   * when the file evolved since the snapshot), and an upload whose content or filename
   * already lives here creates nothing ("exists"). A link is the stronger identity: it can
   * refresh from disk; an upload is a one-time snapshot.
   */
  async #ingestDocument(
    owner: string,
    path: string,
    file: ExtractedFile,
    sessionId: string | null,
  ): Promise<ContextAddResult> {
    const isUpload = path.startsWith("upload://");
    const basenameOf = (p: string) => p.toLowerCase().split(/[/\\]/).pop() ?? "";

    const existing = await this.#storage.query<{
      id: string;
      content_hash: string;
      chunk_count: number;
    }>(
      "SELECT id, content_hash, chunk_count FROM context_documents WHERE owner_id = $1 AND path = $2",
      [owner, path],
    );
    const prior = existing[0];

    // The cross-namespace dedup (global docs only; chat attachments are session-scoped
    // copies on purpose).
    let convert: { id: string; keepChunks: boolean; chunkCount: number } | null = null;
    let absorbTargets: Array<{ id: string }> = [];
    if (sessionId === null && !isUpload) {
      // Linking: this link takes over any upload snapshot of the same file: identical
      // content, or the same filename when the content moved on since the snapshot.
      const uploads = await this.#storage.query<{
        id: string;
        path: string;
        content_hash: string;
        chunk_count: number;
      }>(
        `SELECT id, path, content_hash, chunk_count FROM context_documents
         WHERE owner_id = $1 AND session_id IS NULL AND path LIKE 'upload://%'
         ORDER BY created_at`,
        [owner],
      );
      const base = basenameOf(path);
      const twins = uploads.filter(
        (u) => u.content_hash === file.contentHash || basenameOf(u.path) === base,
      );
      if (!prior && twins.length > 0) {
        const hashTwin = twins.find((t) => t.content_hash === file.contentHash);
        const primary = hashTwin ?? twins[0];
        if (primary) {
          convert = {
            id: primary.id,
            keepChunks: primary.content_hash === file.contentHash,
            chunkCount: Number(primary.chunk_count),
          };
          absorbTargets = twins.filter((t) => t.id !== primary.id);
        }
      } else {
        absorbTargets = twins; // the link already exists; stray snapshots just go
      }
    } else if (sessionId === null && isUpload && !prior) {
      // Uploading something new: refuse when the content already lives here (any global
      // doc) or a linked file with the same name exists; the link syncs from disk and
      // must stay the single source of truth.
      const globals = await this.#storage.query<{
        id: string;
        path: string;
        title: string;
        content_hash: string;
        chunk_count: number;
      }>(
        `SELECT id, path, title, content_hash, chunk_count FROM context_documents
         WHERE owner_id = $1 AND session_id IS NULL ORDER BY created_at`,
        [owner],
      );
      const base = basenameOf(path);
      const twin =
        globals.find((g) => g.content_hash === file.contentHash) ??
        globals.find((g) => !g.path.startsWith("upload://") && basenameOf(g.path) === base);
      if (twin) {
        return {
          documentId: twin.id,
          outcome: "exists",
          title: twin.title,
          chunks: Number(twin.chunk_count),
          path: twin.path,
        };
      }
    }

    const absorb = async (tx: StorageAdapter): Promise<number> => {
      for (const t of absorbTargets) {
        await this.#deleteDocumentChunks(tx, t.id, owner);
        await tx.query("DELETE FROM context_documents WHERE id = $1 AND owner_id = $2", [
          t.id,
          owner,
        ]);
      }
      return absorbTargets.length;
    };

    if (prior && prior.content_hash === file.contentHash) {
      // Unchanged, but stray upload duplicates (from before this dedup existed) still get
      // absorbed, so a plain re-link heals an already-duplicated store.
      const absorbed = absorbTargets.length > 0 ? await this.#storage.tx((tx) => absorb(tx)) : 0;
      return {
        documentId: prior.id,
        outcome: "unchanged",
        title: file.title,
        chunks: prior.chunk_count,
        ...(absorbed > 0 ? { absorbed } : {}),
      };
    }

    // Same bytes as the snapshot: adopt it in place. Chunks, embeddings, and any entities
    // already extracted from them survive untouched; only the identity (path) upgrades.
    if (convert?.keepChunks) {
      const converted = convert;
      const absorbed = await this.#storage.tx(async (tx) => {
        await tx.query(
          `UPDATE context_documents SET path = $2, title = $3, kind = $4, updated_at = now()
           WHERE id = $1`,
          [converted.id, path, file.title, file.kind],
        );
        return absorb(tx);
      });
      return {
        documentId: converted.id,
        outcome: "converted",
        title: file.title,
        chunks: converted.chunkCount,
        path,
        rechunked: false,
        ...(absorbed > 0 ? { absorbed } : {}),
      };
    }

    // The extractor declares its section strategy: markdown splits at headings, outline at
    // ALL-CAPS titles and numbered points: either way a chunk never starts mid-section and
    // carries a citable breadcrumb.
    const sectionize = file.chunker === "markdown" ? chunkMarkdown : chunkOutline;
    const chunks = file.units.flatMap((unit) =>
      sectionize(unit.text).map((c) => ({ ...c, page: unit.page })),
    );

    // Chunk-stable replacement: a re-ingest keeps every chunk whose content is identical
    // to a prior row (same id, embedding, indexed_at, and mention edges), and only the
    // actually-changed chunks are embedded, inserted, and left for the indexer. Without
    // this, one edited diary day re-embeds and re-extracts the whole page: a mirror
    // update must cost what changed, not what exists.
    const replaceId = prior?.id ?? convert?.id;
    const keyOf = (content: string, headingPath: string | null, page: number | null) =>
      `${content}\u0000${headingPath ?? ""}\u0000${page ?? ""}`;
    // key -> reusable prior row ids, a multiset so repeated identical sections pair up.
    const reusable = new Map<string, string[]>();
    if (replaceId) {
      const priorChunks = await this.#storage.query<{
        id: string;
        content: string;
        heading_path: string | null;
        page: number | null;
      }>(
        `SELECT id, content, heading_path, page FROM context_chunks
         WHERE document_id = $1 AND owner_id = $2 ORDER BY chunk_index`,
        [replaceId, owner],
      );
      for (const row of priorChunks) {
        const key = keyOf(
          row.content,
          row.heading_path,
          row.page === null ? null : Number(row.page),
        );
        const list = reusable.get(key);
        if (list) list.push(row.id);
        else reusable.set(key, [row.id]);
      }
    }
    const plan = chunks.map((chunk) => {
      const ids = reusable.get(keyOf(chunk.content, chunk.headingPath, chunk.page));
      const keptId = ids?.shift() ?? null;
      return { chunk, keptId };
    });
    const doomed = [...reusable.values()].flat();
    const freshChunks = plan.filter((p) => p.keptId === null).map((p) => p.chunk);
    // Embed before the transaction: provider calls are slow and can fail; the store swap
    // below stays a short, all-or-nothing write. Only changed content is embedded.
    const embeddings =
      freshChunks.length > 0
        ? await this.#embedding.embed(freshChunks.map((c) => c.content))
        : [];
    if (embeddings.length !== freshChunks.length) {
      throw new Error("memloom: embedding count mismatch during ingest");
    }

    return await this.#storage.tx(async (tx) => {
      let documentId: string;
      // Replacement target: the same path re-added with new content, OR an upload snapshot
      // being converted to this link with the file's newer content (path moves too).
      if (replaceId) {
        // Chunks that no longer exist take their mention edges and stated relationships
        // with them (a document is a mirror; its claims leave with it). memory_edges has
        // no FK to context_chunks, so the edges never ride a cascade.
        for (const id of doomed) {
          await tx.query(
            "DELETE FROM memory_edges WHERE owner_id = $2 AND (source_id = $1 OR from_id = $1)",
            [id, owner],
          );
          await tx.query("DELETE FROM context_chunks WHERE id = $1 AND owner_id = $2", [
            id,
            owner,
          ]);
        }
        // Surviving rows move clear of the target range first: chunk_index is UNIQUE per
        // document, and a section that shifted position would otherwise collide with a
        // row still sitting at its old index.
        if (plan.some((p) => p.keptId !== null)) {
          await tx.query(
            "UPDATE context_chunks SET chunk_index = chunk_index + 1000000 WHERE document_id = $1",
            [replaceId],
          );
        }
        await tx.query(
          `UPDATE context_documents
           SET path = $2, title = $3, kind = $4, content_hash = $5, chunk_count = $6, updated_at = now()
           WHERE id = $1`,
          [replaceId, path, file.title, file.kind, file.contentHash, chunks.length],
        );
        documentId = replaceId;
      } else {
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO context_documents (owner_id, path, title, kind, content_hash, chunk_count, session_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [owner, path, file.title, file.kind, file.contentHash, chunks.length, sessionId],
        );
        const row = inserted[0];
        if (!row) throw new Error("memloom: context document insert returned no id");
        documentId = row.id;
      }

      let embIndex = 0;
      for (let i = 0; i < plan.length; i++) {
        const entry = plan[i];
        if (!entry) throw new Error("memloom: chunk plan mismatch during ingest");
        if (entry.keptId !== null) {
          await tx.query("UPDATE context_chunks SET chunk_index = $2 WHERE id = $1", [
            entry.keptId,
            i,
          ]);
          continue;
        }
        const emb = embeddings[embIndex++];
        if (!emb) throw new Error("memloom: embedding count mismatch during ingest");
        await tx.query(
          `INSERT INTO context_chunks (document_id, owner_id, chunk_index, content, heading_path, page, embedding, session_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8)`,
          [
            documentId,
            owner,
            i,
            entry.chunk.content,
            entry.chunk.headingPath,
            entry.chunk.page,
            toVectorLiteral(emb),
            sessionId,
          ],
        );
      }

      const absorbed = await absorb(tx);
      return {
        documentId,
        outcome: prior
          ? ("updated" as const)
          : convert
            ? ("converted" as const)
            : ("added" as const),
        title: file.title,
        chunks: chunks.length,
        ...(convert ? { path, rechunked: true } : {}),
        ...(absorbed > 0 ? { absorbed } : {}),
      };
    });
  }

  async contextList(ownerId: string = SENTINEL_OWNER): Promise<ContextDocument[]> {
    const rows = await this.#storage.query<{
      id: string;
      path: string;
      title: string;
      kind: string;
      chunk_count: number;
      updated_at: string;
    }>(
      `SELECT id, path, title, kind, chunk_count, updated_at
       FROM context_documents WHERE owner_id = $1 AND session_id IS NULL
       ORDER BY updated_at DESC`,
      [ownerId],
    );
    return rows.map((r) => ({
      id: r.id,
      path: r.path,
      title: r.title,
      kind: r.kind,
      chunkCount: Number(r.chunk_count),
      updatedAt: r.updated_at,
    }));
  }

  /**
   * One document at chunk granularity: its chunks in order, plus their chunk -> entity
   * mention edges. The graph() rollup keeps documents to one node; this is the drill-down
   * the viewer fetches when a document node is expanded.
   */
  async contextChunks(
    documentId: string,
    ownerId: string = SENTINEL_OWNER,
  ): Promise<DocumentChunks> {
    const doc = await this.#storage.query<{ id: string }>(
      "SELECT id FROM context_documents WHERE id = $1 AND owner_id = $2",
      [documentId, ownerId],
    );
    if (!doc[0]) throw new Error(`no context document ${documentId}`);

    const chunkRows = await this.#storage.query<{
      id: string;
      chunk_index: number;
      content: string;
      heading_path: string | null;
      page: number | null;
    }>(
      `SELECT id, chunk_index, content, heading_path, page
       FROM context_chunks WHERE document_id = $1 ORDER BY chunk_index`,
      [documentId],
    );
    const edgeRows = await this.#storage.query<{
      from_id: string;
      to_id: string;
      relation: string;
    }>(
      `SELECT e.from_id, e.to_id, e.relation
       FROM memory_edges e
       JOIN context_chunks cc ON cc.id = e.from_id
       WHERE cc.document_id = $1 AND e.relation = 'mention' AND e.active`,
      [documentId],
    );

    return {
      chunks: chunkRows.map((c) => ({
        id: c.id,
        chunkIndex: Number(c.chunk_index),
        content: c.content,
        headingPath: c.heading_path,
        page: c.page,
      })),
      edges: edgeRows.map((e) => ({ from: e.from_id, to: e.to_id, relation: e.relation })),
    };
  }

  // The single guarantee for the no-FK invariant: memory_edges has no foreign key to
  // context_chunks, so neither the document cascade nor a chunk delete ever cleans mention
  // edges: every chunk removal must clear the edges by hand. Delete a document's chunks ONLY
  // through here (mention edges first, then the chunks), so no call site has to remember it.
  // Entities are intentionally left: they may be mentioned by other documents.
  async #deleteDocumentChunks(
    tx: StorageAdapter,
    documentId: string,
    owner: string,
  ): Promise<void> {
    // Relationships STATED BY these chunks go too (a document is a mirror; its claims
    // leave with it); entity nodes themselves intentionally survive.
    await tx.query(
      `DELETE FROM memory_edges
       WHERE owner_id = $2 AND source_id IN (
         SELECT id FROM context_chunks WHERE document_id = $1 AND owner_id = $2)`,
      [documentId, owner],
    );
    await tx.query(
      `DELETE FROM memory_edges
       WHERE owner_id = $2 AND from_id IN (
         SELECT id FROM context_chunks WHERE document_id = $1 AND owner_id = $2)`,
      [documentId, owner],
    );
    await tx.query("DELETE FROM context_chunks WHERE document_id = $1 AND owner_id = $2", [
      documentId,
      owner,
    ]);
  }

  async contextRemove(documentId: string, ownerId: string = SENTINEL_OWNER): Promise<void> {
    await this.#storage.tx(async (tx) => {
      // Chunks + their mention edges go together (owner-scoped: this runs before the ownership
      // check on the document row itself). The document delete then removes only the doc row.
      await this.#deleteDocumentChunks(tx, documentId, ownerId);
      const deleted = await tx.query<{ id: string }>(
        "DELETE FROM context_documents WHERE id = $1 AND owner_id = $2 RETURNING id",
        [documentId, ownerId],
      );
      if (deleted.length === 0) throw new Error(`no context document ${documentId}`);
    });
  }

  /**
   * Save a memory. With dedup on (default), the belief pipeline runs: an exact or classified
   * duplicate is merged (nothing new stored), a contradiction keeps both memories active and
   * records a conflict for the owner to resolve, and anything else is added.
   */
  async save(input: SaveInput): Promise<SaveResult> {
    const result = await this.#save(input);
    // A merge wrote nothing new; every other outcome left an unindexed row behind.
    if (result.outcome !== "merged") this.#scheduleAutoIndex(input.ownerId ?? SENTINEL_OWNER);
    return result;
  }

  /**
   * Import Claude Code sessions as distilled memories. Discovery is bounded (recent sessions,
   * capped, main-session files only), transcripts are redacted before any chunk reaches the
   * LLM provider, distilled memories go through the ordinary belief pipeline (batch-embedded
   * first), and a per-session ledger watermark makes re-runs idempotent. Runs inside the
   * daemon: the store's single writer, so import and future hook capture can never race.
   */
  async importSessions(
    opts: ImportOptions = {},
    onProgress?: (event: ImportSessionEvent) => void,
  ): Promise<ImportResult> {
    if (opts.agent !== undefined && opts.agent !== "claude-code") {
      throw new Error(
        `memloom: unknown agent "${opts.agent}". Claude Code is the only supported ` +
          "session source today (--agent claude-code).",
      );
    }
    if (this.#llm instanceof NullLLMProvider) {
      throw new Error(
        "memloom: session import distills transcripts with an LLM and none is configured. " +
          "Set OPENROUTER_API_KEY in your memloom config and restart the daemon.",
      );
    }
    const owner = opts.ownerId ?? SENTINEL_OWNER;
    // Explicit paths (the hook's just-ended transcript) skip discovery entirely: no window,
    // no cap, no quiet check. A session-end signal is definitive.
    const discovery = opts.paths?.length
      ? {
          sessions: opts.paths.map((path) => ({
            path,
            project: basename(dirname(path)),
            mtimeMs: 0,
          })),
          skipped: { sidecars: 0, active: 0, outsideWindow: 0, overCap: 0 },
        }
      : await discoverSessions({
          ...(opts.root ? { root: opts.root } : {}),
          ...(opts.days !== undefined ? { days: opts.days } : {}),
          ...(opts.maxSessions !== undefined ? { maxSessions: opts.maxSessions } : {}),
          ...(opts.project ? { project: opts.project } : {}),
          ...(opts.projects ? { projects: opts.projects } : {}),
        });

    const result: ImportResult = {
      sessions: 0,
      skipped: { ...discovery.skipped, upToDate: 0 },
      saved: 0,
      merged: 0,
      versioned: 0,
      conflicts: 0,
      autoResolved: 0,
      dropped: 0,
      truncated: 0,
      redactions: 0,
      malformed: 0,
      calls: { extraction: 0, embedding: 0, classifier: 0 },
      dryRun: opts.dryRun ?? false,
    };
    const classifyBefore = this.#classifyCalls;
    const total = discovery.sessions.length;

    for (const [i, session] of discovery.sessions.entries()) {
      const event: ImportSessionEvent = {
        path: session.path,
        project: session.project,
        sessionId: "",
        index: i + 1,
        total,
        outcome: opts.dryRun ? "dry-run" : "imported",
        chunks: 0,
        saved: 0,
        merged: 0,
        versioned: 0,
        conflicts: 0,
        autoResolved: 0,
        dropped: 0,
        truncated: 0,
        redactions: 0,
        malformed: 0,
      };

      // Full read regardless of watermark: the session id lives inside the file, and the
      // prefix hash for the NEW watermark must cover everything read this run.
      const parsed = await parseSession(session.path);
      event.sessionId = parsed.sessionId;
      event.malformed = parsed.malformed;
      result.malformed += parsed.malformed;

      // Ledger check: skip what a prior run (or the future hook) already distilled. A hash
      // mismatch means the file was rewritten above the watermark (compaction, resume), so
      // the resume offset points at different content: reprocess from zero.
      let fromLine = 0;
      if (!opts.force) {
        const [row] = await this.#storage.query<{ line_offset: number; prefix_hash: string }>(
          "SELECT line_offset, prefix_hash FROM import_ledger WHERE owner_id = $1 AND source = $2 AND session_id = $3",
          [owner, "claude-code", parsed.sessionId],
        );
        if (row) {
          const offset = Number(row.line_offset);
          if (offset >= parsed.lineCount && row.prefix_hash === parsed.prefixHash) {
            event.outcome = "up-to-date";
            result.skipped.upToDate++;
            onProgress?.(event);
            continue;
          }
          if (offset < parsed.lineCount) {
            const prefix = await hashPrefix(session.path, offset);
            if (prefix === row.prefix_hash) fromLine = offset;
          }
        }
      }

      // Tail runs keep a bounded overlap window before the watermark so a decision whose
      // rationale sits just above the cut keeps its context; the pipeline dedupes the overlap.
      const overlapFrom = fromLine > 0 ? Math.max(0, fromLine - IMPORT_OVERLAP_LINES) : 0;
      const units = parsed.units.filter((unit) => unit.line > overlapFrom);
      const redacted: SessionUnit[] = units.map((unit) => {
        const scrub = redact(unit.text);
        event.redactions += scrub.hits;
        return scrub.hits > 0 ? { ...unit, text: scrub.text } : unit;
      });
      result.redactions += event.redactions;

      const chunked = chunkUnits(redacted);
      event.chunks = chunked.chunks.length;
      event.truncated = chunked.truncated;
      result.truncated += chunked.truncated;

      if (opts.dryRun) {
        result.sessions++;
        onProgress?.(event);
        continue;
      }

      // Each chunk is processed end-to-end (distill, batch-embed its memories, save) and the
      // in-memory watermark advances only past chunks whose memories are fully saved. A
      // provider failure (out of credits, rate limit) then loses at most one chunk's calls:
      // everything before it is already in the store, the ledger records how far we got, and
      // a re-run resumes from there instead of re-spending. Batching is per chunk rather than
      // per session for exactly this isolation; a chunk still batches all its memories into
      // one embed call.
      let watermark = 0;
      let sessionError: string | undefined;
      for (const [chunkIndex, chunk] of chunked.chunks.entries()) {
        // Announce each chunk before spending up to minutes on it: a chunk distills, embeds,
        // and dedup-classifies serially, and without this the client sees nothing between
        // the previous session's result and this one's.
        onProgress?.({ ...event, outcome: "distilling", chunk: chunkIndex + 1 });
        try {
          if (
            opts.unattended &&
            (await this.#unattendedCallsToday()) >= UNATTENDED_DAILY_CALL_CAP
          ) {
            sessionError =
              `paused: the daily unattended distillation budget (${UNATTENDED_DAILY_CALL_CAP} calls) is spent. ` +
              "Capture resumes tomorrow; run `memloom import sessions` yourself to continue now.";
            break;
          }
          result.calls.extraction++;
          if (opts.unattended) await this.#bumpUnattendedCalls();
          const output = await distillChunk(this.#llm, chunk);
          event.dropped += output.dropped;
          let vectors: number[][] = [];
          if (output.memories.length > 0) {
            result.calls.embedding++;
            vectors = await this.#embedding.embed(output.memories.map((m) => m.content));
          }
          for (const [j, memory] of output.memories.entries()) {
            const saveResult = await this.#save(
              {
                content: memory.content,
                ...(memory.canonical ? { canonical: memory.canonical } : {}),
                memoryType: memory.memoryType,
                ownerId: owner,
                // The excerpt lets a flagged contradiction be judged right now, with the
                // transcript as evidence, instead of waiting in the conflict queue.
                context: { excerpt: excerptOf(memory, chunk) },
              },
              vectors[j],
            );
            if (saveResult.outcome === "merged") {
              event.merged++;
            } else {
              if (saveResult.outcome === "versioned") event.versioned++;
              else if (saveResult.outcome === "conflict") {
                if (saveResult.autoResolution) event.autoResolved++;
                else event.conflicts++;
              } else event.saved++;
              await this.#insertProvenance(
                owner,
                saveResult.id,
                parsed.sessionId,
                session.path,
                memory,
                chunk,
              );
            }
          }
          watermark = chunk.endLine;
        } catch (err) {
          sessionError = err instanceof Error ? err.message : String(err);
          break;
        }
      }
      result.dropped += event.dropped;
      result.saved += event.saved;
      result.merged += event.merged;
      result.versioned += event.versioned;
      result.conflicts += event.conflicts;
      result.autoResolved += event.autoResolved;

      // Clean finish covers the whole file (trailing non-text lines included); a stopped
      // session is watermarked at its last fully saved chunk. No progress, no write: the
      // prior ledger row (if any) stays authoritative.
      const finished = sessionError === undefined;
      const offset = finished ? parsed.lineCount : watermark;
      if (finished || watermark > fromLine) {
        await this.#storage.query(
          `INSERT INTO import_ledger (owner_id, source, session_id, file_path, line_offset, prefix_hash, memories_saved)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (owner_id, source, session_id) DO UPDATE SET
             file_path = EXCLUDED.file_path,
             line_offset = EXCLUDED.line_offset,
             prefix_hash = EXCLUDED.prefix_hash,
             memories_saved = import_ledger.memories_saved + EXCLUDED.memories_saved,
             updated_at = now()`,
          [
            owner,
            "claude-code",
            parsed.sessionId,
            session.path,
            offset,
            finished ? parsed.prefixHash : await hashPrefix(session.path, offset),
            event.saved + event.versioned + event.conflicts,
          ],
        );
      }

      result.sessions++;
      if (sessionError !== undefined) {
        event.outcome = "partial";
        event.error = sessionError;
        result.error = sessionError;
        onProgress?.(event);
        break;
      }
      onProgress?.(event);
    }

    result.calls.classifier = this.#classifyCalls - classifyBefore;
    if (!opts.dryRun && result.sessions > 0) this.#scheduleAutoIndex(owner);
    return result;
  }

  /**
   * Import memories agents already saved on disk: Claude Code's per-project memory folders
   * and Copilot's global memory-tool folder. Those files are distilled memories already, so
   * unlike session import there is no LLM extraction step: parse, redact, batch-embed per
   * folder, and run every memory through the ordinary belief pipeline. A per-memory ledger
   * row keyed by content hash makes re-runs idempotent: an unchanged file costs zero
   * provider calls. Read-only on the agents' folders; memloom never writes back into them.
   */
  async importAgentMemories(
    opts: AgentMemoryImportOptions = {},
    onProgress?: (event: AgentMemoryFolderEvent) => void,
  ): Promise<AgentMemoryImportResult> {
    const owner = opts.ownerId ?? SENTINEL_OWNER;
    const agents = normalizeAgentSelection(opts.agents);
    const folders = await locateAgentMemoryFolders({
      ...(agents ? { agents } : {}),
      ...(opts.project ? { project: opts.project } : {}),
      ...(opts.claudeRoot ? { claudeRoot: opts.claudeRoot } : {}),
      ...(opts.copilotRoots ? { copilotRoots: opts.copilotRoots } : {}),
    });

    const result: AgentMemoryImportResult = {
      folders: 0,
      files: 0,
      memories: 0,
      unchanged: 0,
      saved: 0,
      merged: 0,
      versioned: 0,
      conflicts: 0,
      redactions: 0,
      calls: { embedding: 0, classifier: 0 },
      dryRun: opts.dryRun ?? false,
    };
    const classifyBefore = this.#classifyCalls;

    for (const [i, folder] of folders.entries()) {
      const event: AgentMemoryFolderEvent = {
        agent: folder.agent,
        label: folder.label,
        path: folder.path,
        index: i + 1,
        total: folders.length,
        outcome: opts.dryRun ? "dry-run" : "imported",
        files: 0,
        memories: 0,
        unchanged: 0,
        saved: 0,
        merged: 0,
        versioned: 0,
        conflicts: 0,
        redactions: 0,
      };
      const parsed = await parseAgentMemoryFolder(folder);
      event.files = parsed.files;
      event.memories = parsed.units.length;
      result.files += parsed.files;
      result.memories += parsed.units.length;

      // Ledger check per memory: an unchanged content hash skips the unit before any
      // provider call. The hash is the watermark analog for files that are rewritten in
      // place rather than appended to; there is no line offset to resume from.
      const changed: AgentMemoryUnit[] = [];
      for (const unit of parsed.units) {
        if (!opts.force) {
          const [row] = await this.#storage.query<{ prefix_hash: string }>(
            "SELECT prefix_hash FROM import_ledger WHERE owner_id = $1 AND source = $2 AND session_id = $3",
            [owner, AGENT_MEMORY_LEDGER_SOURCE, unit.identity],
          );
          if (row && row.prefix_hash === unit.contentHash) {
            event.unchanged++;
            continue;
          }
        }
        changed.push(unit);
      }
      result.unchanged += event.unchanged;

      if (opts.dryRun) {
        result.folders++;
        onProgress?.(event);
        continue;
      }
      if (changed.length === 0) {
        event.outcome = "up-to-date";
        result.folders++;
        onProgress?.(event);
        continue;
      }

      // Agent notes should not carry secrets, but one that does must never reach a
      // provider or the store: same redaction as session import.
      const units = changed.map((unit) => {
        const scrub = redact(unit.content);
        event.redactions += scrub.hits;
        return scrub.hits > 0 ? { ...unit, content: scrub.text } : unit;
      });
      result.redactions += event.redactions;

      // One embed call per folder; each save and its ledger row land together, so a
      // provider failure mid-folder keeps everything already saved and a re-run only
      // reprocesses the remainder.
      let folderError: string | undefined;
      try {
        result.calls.embedding++;
        const vectors = await this.#embedding.embed(units.map((unit) => unit.content));
        for (const [j, unit] of units.entries()) {
          const saveResult = await this.#save(
            {
              content: unit.content,
              ...(unit.canonical ? { canonical: unit.canonical } : {}),
              memoryType: unit.memoryType,
              ownerId: owner,
            },
            vectors[j],
          );
          if (saveResult.outcome === "merged") {
            event.merged++;
          } else {
            if (saveResult.outcome === "versioned") event.versioned++;
            else if (saveResult.outcome === "conflict") event.conflicts++;
            else event.saved++;
            await this.#storage.query(
              `INSERT INTO import_provenance (memory_id, owner_id, source, session_id, file_path, start_line, end_line, excerpt)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT (memory_id) DO NOTHING`,
              [
                saveResult.id,
                owner,
                AGENT_MEMORY_LEDGER_SOURCE,
                unit.identity,
                unit.filePath,
                unit.startLine,
                unit.endLine,
                unit.content.slice(0, PROVENANCE_EXCERPT_CHARS),
              ],
            );
          }
          await this.#storage.query(
            `INSERT INTO import_ledger (owner_id, source, session_id, file_path, line_offset, prefix_hash, memories_saved)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (owner_id, source, session_id) DO UPDATE SET
               file_path = EXCLUDED.file_path,
               line_offset = EXCLUDED.line_offset,
               prefix_hash = EXCLUDED.prefix_hash,
               memories_saved = import_ledger.memories_saved + EXCLUDED.memories_saved,
               updated_at = now()`,
            [
              owner,
              AGENT_MEMORY_LEDGER_SOURCE,
              unit.identity,
              unit.filePath,
              unit.endLine,
              unit.contentHash,
              saveResult.outcome === "merged" ? 0 : 1,
            ],
          );
        }
      } catch (err) {
        folderError = err instanceof Error ? err.message : String(err);
      }

      result.saved += event.saved;
      result.merged += event.merged;
      result.versioned += event.versioned;
      result.conflicts += event.conflicts;
      result.folders++;

      if (folderError !== undefined) {
        event.outcome = "partial";
        event.error = folderError;
        result.error = folderError;
        onProgress?.(event);
        break;
      }
      onProgress?.(event);
    }

    result.calls.classifier = this.#classifyCalls - classifyBefore;
    if (!opts.dryRun && result.saved + result.versioned + result.conflicts > 0) {
      this.#scheduleAutoIndex(owner);
    }
    return result;
  }

  // ---- Hook capture state (scope, status, notify) ----------------------------------------

  async #metaGet(key: string): Promise<string | null> {
    const [row] = await this.#storage.query<{ value: string }>(
      "SELECT value FROM _memloom_meta WHERE key = $1",
      [key],
    );
    return row?.value ?? null;
  }

  async #metaSet(key: string, value: string): Promise<void> {
    await this.#storage.query(
      `INSERT INTO _memloom_meta (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, value],
    );
  }

  async #unattendedCallsToday(): Promise<number> {
    return Number((await this.#metaGet(importCallsKey())) ?? 0);
  }

  async #bumpUnattendedCalls(): Promise<void> {
    await this.#metaSet(importCallsKey(), String((await this.#unattendedCallsToday()) + 1));
  }

  /** The hook capture scope `connect` configured; null = capture off. */
  async importScope(): Promise<ImportCaptureScope> {
    const raw = await this.#metaGet(IMPORT_SCOPE_KEY);
    if (raw === null) return null;
    if (raw === "all") return "all";
    try {
      const parsed = JSON.parse(raw) as { projects?: string[] };
      return Array.isArray(parsed.projects) ? { projects: parsed.projects.map(String) } : null;
    } catch {
      return null;
    }
  }

  /** Set (connect) or clear (disconnect) the hook capture scope. */
  async setImportScope(scope: ImportCaptureScope): Promise<void> {
    if (scope === null) {
      await this.#storage.query("DELETE FROM _memloom_meta WHERE key = $1", [IMPORT_SCOPE_KEY]);
      return;
    }
    await this.#metaSet(IMPORT_SCOPE_KEY, scope === "all" ? "all" : JSON.stringify(scope));
  }

  async importStatus(ownerId: string = SENTINEL_OWNER): Promise<ImportStatus> {
    // Session totals only: agent-memory ledger rows live under their own source.
    const [totals] = await this.#storage.query<{ sessions: string; saved: string }>(
      `SELECT count(*) AS sessions, COALESCE(sum(memories_saved), 0) AS saved
       FROM import_ledger WHERE owner_id = $1 AND source = 'claude-code'`,
      [ownerId],
    );
    return {
      scope: await this.importScope(),
      lastNotifyAt: await this.#metaGet(IMPORT_NOTIFY_AT_KEY),
      lastNotifyError: await this.#metaGet(IMPORT_NOTIFY_ERROR_KEY),
      todayUnattendedCalls: await this.#unattendedCallsToday(),
      unattendedDailyCap: UNATTENDED_DAILY_CALL_CAP,
      sessionsImported: Number(totals?.sessions ?? 0),
      memoriesSaved: Number(totals?.saved ?? 0),
    };
  }

  /**
   * One session-end notify from the hook: scope check, unattended import of exactly that
   * transcript, and status bookkeeping. Every failure is recorded, never thrown away: a
   * provider outage, the spend cap, or a missing LLM must all be visible in `memloom status`
   * (a silently dead hook is the one failure mode this feature is not allowed to have).
   */
  async handleSessionNotify(
    path: string,
  ): Promise<{ accepted: boolean; reason?: string; result?: ImportResult }> {
    const scope = await this.importScope();
    if (scope === null) {
      return {
        accepted: false,
        reason: "capture is not configured; run memloom connect claude-code",
      };
    }
    const project = basename(dirname(path)).toLowerCase();
    if (scope !== "all" && !scope.projects.some((p) => project.includes(p.toLowerCase()))) {
      // Out-of-scope sessions are the allowlist working as designed: not an error state.
      return { accepted: false, reason: "project is outside the capture scope" };
    }
    await this.#metaSet(IMPORT_NOTIFY_AT_KEY, new Date().toISOString());
    try {
      const result = await this.importSessions({ paths: [path], unattended: true });
      if (result.error) await this.#metaSet(IMPORT_NOTIFY_ERROR_KEY, result.error);
      else
        await this.#storage.query("DELETE FROM _memloom_meta WHERE key = $1", [
          IMPORT_NOTIFY_ERROR_KEY,
        ]);
      return { accepted: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.#metaSet(IMPORT_NOTIFY_ERROR_KEY, message);
      return { accepted: false, reason: message };
    }
  }

  // One client per engine so its request spacing is global: a manual sync and the
  // daemon's poll share the ~3 requests/second budget instead of tripping 429s together.
  #notionClientInstance: NotionClient | null = null;
  #notionSyncInFlight: Promise<NotionSyncResult> | null = null;

  #notionClient(): NotionClient {
    const token = process.env.NOTION_TOKEN;
    if (!token) {
      throw new Error(
        "NOTION_TOKEN is not set. Create an internal integration at " +
          "notion.so/profile/integrations, share your pages with it (page menu, " +
          "Connections), and export the token as NOTION_TOKEN.",
      );
    }
    this.#notionClientInstance ??= new NotionClient(token, this.#notionFetch);
    return this.#notionClientInstance;
  }

  /** The pages and data sources selected for sync; null = connector off. */
  async notionScope(): Promise<NotionScope> {
    const raw = await this.#metaGet(NOTION_SCOPE_KEY);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as { items?: unknown[] };
      if (!Array.isArray(parsed.items)) return null;
      return {
        items: parsed.items
          .filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null)
          .map((i) => ({
            id: String(i.id),
            object: i.object === "data_source" ? ("data_source" as const) : ("page" as const),
            title: String(i.title ?? "Untitled"),
          })),
      };
    } catch {
      return null;
    }
  }

  async setNotionScope(scope: NotionScope): Promise<void> {
    if (scope === null || scope.items.length === 0) {
      await this.#storage.query("DELETE FROM _memloom_meta WHERE key = $1", [NOTION_SCOPE_KEY]);
      return;
    }
    await this.#metaSet(NOTION_SCOPE_KEY, JSON.stringify(scope));
  }

  /**
   * Everything the integration can see, marked with what is already selected. Search is
   * eventually consistent on Notion's side: a page shared moments ago can be missing, so
   * callers tell the user to retry rather than conclude the share failed.
   */
  async notionListPages(): Promise<NotionListedPage[]> {
    const items = await this.#notionClient().listShared();
    const scope = await this.notionScope();
    const selected = new Set(scope?.items.map((i) => i.id) ?? []);
    return items.map((item) => ({ ...item, selected: selected.has(item.id) }));
  }

  /**
   * Sync the selected Notion items into context documents. One metadata request per item
   * decides whether it changed (last_edited_time watermark, minute granularity); changed
   * pages fetch incrementally against the cached block tree (see #fetchPageNodes), get
   * rendered to markdown, and go through the shared document pipeline, where the
   * content-hash short-circuit makes redundant fetches harmless. Item failures are
   * reported and skipped; the run continues.
   */
  async notionSync(
    opts: NotionSyncOptions = {},
    onProgress?: (event: NotionSyncEvent) => void,
  ): Promise<NotionSyncResult> {
    // Single-flight: a second sync (usually the daemon's poll racing a manual run)
    // would only halve the shared rate budget and redo the same work. A manual run
    // passes wait and QUEUES behind the in-flight one instead of being refused: the
    // user reaching for `notion sync --force` must always end with their edit pulled,
    // not with an error. The poll never waits; its next tick comes anyway.
    if (this.#notionSyncInFlight && !opts.wait) {
      throw new Error(
        "a Notion sync is already running (the daemon also polls in the background); " +
          "try again in a moment or watch memloom notion status",
      );
    }
    if (this.#notionSyncInFlight) {
      onProgress?.({
        id: "",
        title: "",
        object: "page",
        index: 0,
        total: 0,
        outcome: "waiting",
        chunks: 0,
      });
      while (this.#notionSyncInFlight) {
        await this.#notionSyncInFlight.catch(() => undefined);
      }
    }
    const run = this.#notionSyncRun(opts, onProgress).finally(() => {
      this.#notionSyncInFlight = null;
    });
    this.#notionSyncInFlight = run;
    return run;
  }

  /**
   * The page's full block tree, incrementally when possible. With a cached tree from the
   * last sync, only the top level is listed (hundreds of day-sections cost a handful of
   * requests) and only sections whose last_edited_time moved since the cache are
   * re-downloaded. Notion bumps every ancestor's timestamp when a nested block changes
   * (verified against real pages; a parent can trail its deepest child by a minute of
   * rounding, but it always moves, and the diff compares each section against its own
   * cached value, never parent against child). If the page reported an edit that no
   * section accounts for, fall back to a full fetch: correctness over savings.
   */
  async #fetchPageNodes(
    client: NotionClient,
    pageId: string,
    force: boolean,
    onProgress: (blocksFetched: number) => void,
  ): Promise<{
    nodes: NotionBlockNode[];
    truncated: boolean;
    sections?: number;
    refetched?: number;
  }> {
    let cache: NotionTreeCache | null = null;
    if (!force) {
      const raw = await this.#metaGet(notionTreeKey(pageId));
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as NotionTreeCache;
          if (parsed.v === NOTION_TREE_CACHE_VERSION && Array.isArray(parsed.nodes)) {
            cache = parsed;
          }
        } catch {
          // unreadable cache: fall through to a full fetch, which rewrites it
        }
      }
    }
    if (!cache) return client.blockTree(pageId, onProgress);

    const cachedById = new Map(cache.nodes.map((n) => [n.block.id, n]));
    let fetched = 0;
    const top = await client.blockChildrenList(pageId, (n) => {
      fetched = n;
      onProgress(n);
    });
    const changed = top.filter((block) => {
      const prev = cachedById.get(block.id);
      return (
        !prev ||
        String(prev.block.last_edited_time ?? "") !== String(block.last_edited_time ?? "")
      );
    });
    if (changed.length === 0) return client.blockTree(pageId, onProgress);

    const changedIds = new Set(changed.map((b) => b.id));
    const nodes: NotionBlockNode[] = [];
    let truncated = cache.truncated;
    for (const block of top) {
      const prev = cachedById.get(block.id);
      if (!changedIds.has(block.id) && prev) {
        // Unchanged section: fresh block payload (already in hand), cached subtree.
        nodes.push({ block, children: prev.children });
        continue;
      }
      let children: NotionBlockNode[] = [];
      if (expandsInline(block)) {
        const base = fetched;
        let subFetched = 0;
        const sub = await client.blockTree(block.id, (n) => {
          subFetched = n;
          onProgress(base + n);
        });
        fetched = base + subFetched;
        children = sub.nodes;
        truncated = truncated || sub.truncated;
      }
      nodes.push({ block, children });
    }
    return { nodes, truncated, sections: top.length, refetched: changed.length };
  }

  async #notionSyncRun(
    opts: NotionSyncOptions,
    onProgress?: (event: NotionSyncEvent) => void,
  ): Promise<NotionSyncResult> {
    const owner = opts.ownerId ?? SENTINEL_OWNER;
    const scope = await this.notionScope();
    if (!scope || scope.items.length === 0) {
      throw new Error("no Notion pages selected: run memloom notion connect first");
    }
    const client = this.#notionClient();

    const result: NotionSyncResult = {
      items: scope.items.length,
      added: 0,
      updated: 0,
      unchanged: 0,
      fresh: 0,
      errors: 0,
      truncated: 0,
      dryRun: opts.dryRun === true,
    };
    let anyChange = false;

    for (const [index, item] of scope.items.entries()) {
      // Change detection asks the ITEM endpoint, never search: Notion's search index is
      // eventually consistent and its last_edited_time can lag an edit by minutes, which
      // once made a just-edited diary look fresh. GET /pages/{id} is authoritative and
      // costs one request per selected item per pass.
      let title = item.title;
      let lastEdited = "";
      let metaError: string | null = null;
      try {
        const meta =
          item.object === "page" ? await client.page(item.id) : await client.dataSource(item.id);
        lastEdited = String(meta.last_edited_time ?? "");
        title = item.object === "page" ? pageTitle(meta) : dataSourceTitle(meta);
      } catch (err) {
        metaError = err instanceof Error ? err.message : String(err);
      }
      const emit = (
        outcome: NotionSyncEvent["outcome"],
        chunks = 0,
        error?: string,
        truncated?: boolean,
        incremental?: { sections: number; refetched: number },
      ) => {
        onProgress?.({
          id: item.id,
          title,
          object: item.object,
          index: index + 1,
          total: scope.items.length,
          outcome,
          chunks,
          ...(error ? { error } : {}),
          ...(truncated ? { truncated: true } : {}),
          ...(incremental ?? {}),
        });
      };
      try {
        if (metaError !== null) throw new Error(metaError);
        const stored = await this.#metaGet(notionEditedKey(item.id));
        // Exact-string comparison: any edit bumps last_edited_time (rounded down to the
        // minute, so an edit in the same minute as the previous sync can wait one poll).
        if (!opts.force && lastEdited && stored === lastEdited) {
          result.fresh++;
          emit("fresh");
          continue;
        }
        if (opts.dryRun) {
          emit("would-sync");
          continue;
        }

        // Life signs while content downloads: rate-limited fetches of a long page take
        // minutes, and they also keep the NDJSON stream from idling out.
        emit("fetching");
        let lastReported = 0;
        const fetchProgress = (blocksFetched: number) => {
          if (blocksFetched - lastReported >= 100) {
            lastReported = blocksFetched;
            emit("fetching", blocksFetched);
          }
        };
        let markdown: string;
        let truncated = false;
        let pageNodes: NotionBlockNode[] | null = null;
        let incremental: { sections: number; refetched: number } | undefined;
        if (item.object === "page") {
          const tree = await this.#fetchPageNodes(
            client,
            item.id,
            opts.force === true,
            fetchProgress,
          );
          truncated = tree.truncated;
          pageNodes = tree.nodes;
          if (tree.sections !== undefined && tree.refetched !== undefined) {
            incremental = { sections: tree.sections, refetched: tree.refetched };
          }
          markdown = blocksToMarkdown(title, tree.nodes);
        } else {
          markdown = rowsToMarkdown(title, await client.dataSourceRows(item.id));
        }
        if (truncated) result.truncated++;
        const file: ExtractedFile = {
          kind: "notion",
          title,
          contentHash: `${createHash("sha256").update(markdown).digest("hex")}#n${NOTION_PIPELINE_VERSION}`,
          chunker: "markdown",
          units: [{ text: markdown, page: null }],
        };
        const ingest = await this.#ingestDocument(owner, `notion://${item.id}`, file, null);
        // Cache before the watermark: if the cache write dies, the stale watermark makes
        // the next sync refetch; the other order could pair a new watermark with an old
        // tree and quietly serve stale sections.
        if (pageNodes) {
          const treeCache: NotionTreeCache = {
            v: NOTION_TREE_CACHE_VERSION,
            truncated,
            nodes: pageNodes,
          };
          await this.#metaSet(notionTreeKey(item.id), JSON.stringify(treeCache));
        }
        if (lastEdited) await this.#metaSet(notionEditedKey(item.id), lastEdited);

        if (ingest.outcome === "unchanged") {
          result.unchanged++;
          emit("unchanged", ingest.chunks, undefined, truncated, incremental);
        } else if (ingest.outcome === "added") {
          result.added++;
          anyChange = true;
          emit("added", ingest.chunks, undefined, truncated, incremental);
        } else {
          result.updated++;
          anyChange = true;
          emit("updated", ingest.chunks, undefined, truncated, incremental);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors++;
        result.error = message;
        emit("error", 0, message);
      }
    }

    if (anyChange) this.#scheduleAutoIndex(owner);
    if (!opts.dryRun) {
      await this.#metaSet(NOTION_SYNC_AT_KEY, new Date().toISOString());
      if (result.error) await this.#metaSet(NOTION_SYNC_ERROR_KEY, result.error);
      else {
        await this.#storage.query("DELETE FROM _memloom_meta WHERE key = $1", [
          NOTION_SYNC_ERROR_KEY,
        ]);
      }
    }
    return result;
  }

  async notionStatus(ownerId: string = SENTINEL_OWNER): Promise<NotionStatus> {
    const [row] = await this.#storage.query<{ documents: string; chunks: string }>(
      `SELECT count(*) AS documents, COALESCE(sum(chunk_count), 0) AS chunks
       FROM context_documents WHERE owner_id = $1 AND path LIKE 'notion://%'`,
      [ownerId],
    );
    return {
      tokenPresent: Boolean(process.env.NOTION_TOKEN),
      syncing: this.#notionSyncInFlight !== null,
      scope: await this.notionScope(),
      lastSyncAt: await this.#metaGet(NOTION_SYNC_AT_KEY),
      lastSyncError: await this.#metaGet(NOTION_SYNC_ERROR_KEY),
      documents: Number(row?.documents ?? 0),
      chunks: Number(row?.chunks ?? 0),
    };
  }

  // The stored excerpt is what keeps provenance alive after the user cleans up transcripts;
  // it is built from the already-redacted units, so no matched secret is ever persisted.
  async #insertProvenance(
    owner: string,
    memoryId: string,
    sessionId: string,
    filePath: string,
    memory: DistilledMemory,
    chunk: SessionChunk,
  ): Promise<void> {
    const excerpt = excerptOf(memory, chunk);
    await this.#storage.query(
      `INSERT INTO import_provenance (memory_id, owner_id, source, session_id, file_path, start_line, end_line, excerpt)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (memory_id) DO NOTHING`,
      [
        memoryId,
        owner,
        "claude-code",
        sessionId,
        filePath,
        memory.startLine,
        memory.endLine,
        excerpt,
      ],
    );
  }

  // Precomputed vectors come from the import path's batch-embed pre-pass: one provider call
  // for a whole session's memories instead of one per save. Everything after the embedding
  // is the identical pipeline; there is no bypass lane.
  async #save(input: SaveInput, precomputed?: number[]): Promise<SaveResult> {
    const owner = input.ownerId ?? SENTINEL_OWNER;
    const embedding = precomputed ?? (await this.#embedding.embed([input.content]))[0];
    if (!embedding) throw new Error("memloom: embedding provider returned no vector");
    const hash = createHash("sha256").update(input.content).digest("hex");

    if (!this.#dedup) {
      const id = await this.#insert(owner, input, embedding, hash);
      return { id, outcome: "added" };
    }

    // Exact duplicate: cheap short-circuit, no LLM needed.
    const exact = await this.#storage.query<{ id: string }>(
      "SELECT id FROM memory_objects WHERE owner_id = $1 AND status = 'active' AND content_hash = $2 LIMIT 1",
      [owner, hash],
    );
    if (exact[0]) return { id: exact[0].id, outcome: "merged" };

    const candidates = await this.#findCandidates(owner, embedding, hash);
    if (candidates.length === 0) {
      const id = await this.#insert(owner, input, embedding, hash);
      return { id, outcome: "added" };
    }

    this.#classifyCalls++;
    const classifications = await classify(
      this.#llm,
      { canonical: input.canonical, content: input.content },
      candidates,
    );

    // A restatement of the same fact appends a new version to that belief's lineage (the prior
    // version goes stale). A verbatim re-save was already short-circuited above as "merged".
    const identical = classifications.find((c) => c.relation === "identical");
    if (identical) {
      const parent = candidates.find((c) => c.id === identical.candidateId);
      if (parent) {
        const childId = await this.#versionOf(owner, parent, input, embedding, hash);
        return { id: childId, outcome: "versioned", version: parent.version + 1 };
      }
    }

    const id = await this.#insert(owner, input, embedding, hash);

    const contradictions = classifications.filter((c) => c.relation === "contradictory");
    if (contradictions.length > 0) {
      const conflictCandidates: ConflictCandidate[] = contradictions.map((cl) => {
        const cand = candidates.find((c) => c.id === cl.candidateId);
        return {
          id: cl.candidateId,
          canonical: cand?.canonical ?? null,
          content: cand?.content ?? "",
          relation: cl.relation,
          reason: cl.reason,
        };
      });
      const conflictId = await this.#recordConflict(owner, id, input, conflictCandidates);
      // With transcript context in hand (session imports), give the resolver one shot at
      // settling the contradiction now, with the recording times and excerpts the dedup
      // classifier never saw. A decisive verdict goes through resolveConflict, so it lands
      // in the same revertable history as a human decision; unsure stays pending.
      if (input.context) {
        const decision = await this.#judgeConflictNow(input, conflictCandidates);
        if (decision) {
          await this.resolveConflict(conflictId, decision.resolve);
          return { id, outcome: "conflict", conflictId, autoResolution: decision.name };
        }
      }
      return { id, outcome: "conflict", conflictId };
    }

    return { id, outcome: "added" };
  }

  /** All active memories, newest first. The browsing counterpart to query-driven recall. */
  async memories(ownerId: string = SENTINEL_OWNER): Promise<Memory[]> {
    const rows = await this.#storage.query<MemoryRow>(
      `SELECT id, owner_id, status, memory_type, canonical, content, summary,
              root_id, version, asserted_at, created_at
       FROM memory_objects
       WHERE owner_id = $1 AND status = 'active'
       ORDER BY created_at DESC`,
      [ownerId],
    );
    return rows.map(mapRow);
  }

  /**
   * The full version history of a belief: every version sharing this memory's root_id, newest
   * first (active current version plus all stale predecessors). Pass any version's id.
   */
  async history(memoryId: string, ownerId: string = SENTINEL_OWNER): Promise<Memory[]> {
    const [row] = await this.#storage.query<{ root_id: string }>(
      "SELECT root_id FROM memory_objects WHERE id = $1 AND owner_id = $2",
      [memoryId, ownerId],
    );
    if (!row) throw new Error(`memloom: no memory ${memoryId}`);
    const rows = await this.#storage.query<MemoryRow>(
      `SELECT id, owner_id, status, memory_type, canonical, content, summary,
              root_id, version, asserted_at, created_at
       FROM memory_objects
       WHERE owner_id = $1 AND root_id = $2
       ORDER BY version DESC`,
      [ownerId, row.root_id],
    );
    return rows.map(mapRow);
  }

  /**
   * The complete text of one recall hit by id: a saved memory or a context chunk. The
   * fetch-the-rest path behind truncated recall passages (assistant read_source, MCP
   * read_passage); null when the id matches neither.
   */
  async passage(id: string, ownerId: string = SENTINEL_OWNER): Promise<string | null> {
    // A non-uuid id is "not found", not a Postgres cast error (agents pass free text).
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
    const [row] = await this.#storage.query<{ content: string }>(
      `SELECT content FROM memory_objects WHERE id = $1 AND owner_id = $2
       UNION ALL
       SELECT content FROM context_chunks WHERE id = $1 AND owner_id = $2`,
      [id, ownerId],
    );
    return row?.content ?? null;
  }

  /**
   * Edit a belief: append a new current version with the given content and stale the prior one.
   * An explicit edit: unlike a save, it never runs the dedup/conflict funnel. Reversible in the
   * sense that the prior version stays queryable via history().
   */
  async update(input: UpdateInput): Promise<UpdateResult> {
    const owner = input.ownerId ?? SENTINEL_OWNER;
    const [parent] = await this.#storage.query<{
      id: string;
      root_id: string;
      version: number;
      memory_type: MemoryType;
    }>(
      "SELECT id, root_id, version, memory_type FROM memory_objects WHERE id = $1 AND owner_id = $2 AND status = 'active'",
      [input.id, owner],
    );
    if (!parent) throw new Error(`memloom: no active memory ${input.id}`);
    const [embedding] = await this.#embedding.embed([input.content]);
    if (!embedding) throw new Error("memloom: embedding provider returned no vector");
    const hash = createHash("sha256").update(input.content).digest("hex");
    const childId = await this.#versionOf(
      owner,
      { id: parent.id, rootId: parent.root_id, version: Number(parent.version) },
      {
        content: input.content,
        ...(input.canonical ? { canonical: input.canonical } : {}),
        memoryType: parent.memory_type,
      },
      embedding,
      hash,
    );
    this.#scheduleAutoIndex(owner); // the new version is a fresh unindexed row
    return { id: childId, rootId: parent.root_id, version: Number(parent.version) + 1 };
  }

  /**
   * Delete a belief outright: every version in its chain, the edges it participates in, and
   * any pending conflict that references it. Unlike update(), this is not reversible; the
   * version history goes with it. Entities the belief mentioned stay in the graph (other
   * sources may mention them), and resolved conflicts stay as the audit log (they carry
   * their own content copies).
   */
  async deleteMemory(memoryId: string, ownerId: string = SENTINEL_OWNER): Promise<void> {
    await this.#storage.tx(async (tx) => {
      const [row] = await tx.query<{ root_id: string }>(
        "SELECT root_id FROM memory_objects WHERE id = $1 AND owner_id = $2",
        [memoryId, ownerId],
      );
      if (!row) throw new Error(`memloom: no memory ${memoryId}`);
      // Edges the chain appears in (mention, replaces, distinct) and relationships it
      // stated (source_id) go with it. Runs before the row delete: the subselects need
      // the chain to still exist.
      await tx.query(
        `DELETE FROM memory_edges
         WHERE owner_id = $2 AND (
           from_id IN (SELECT id FROM memory_objects WHERE owner_id = $2 AND root_id = $1)
           OR to_id IN (SELECT id FROM memory_objects WHERE owner_id = $2 AND root_id = $1)
           OR source_id IN (SELECT id FROM memory_objects WHERE owner_id = $2 AND root_id = $1))`,
        [row.root_id, ownerId],
      );
      // A pending conflict pointing at a deleted memory would render as a ghost the owner
      // can no longer act on; drop it whether the memory is the incoming or a candidate side.
      await tx.query(
        `DELETE FROM memory_dedup_decisions
         WHERE owner_id = $2 AND action = 'conflict' AND resolution_action IS NULL
           AND (incoming_id IN (SELECT id FROM memory_objects WHERE owner_id = $2 AND root_id = $1)
             OR EXISTS (
               SELECT 1 FROM jsonb_array_elements(candidates) AS cand
               JOIN memory_objects mo ON mo.id = (cand.value->>'id')::uuid
               WHERE mo.owner_id = $2 AND mo.root_id = $1))`,
        [row.root_id, ownerId],
      );
      await tx.query("DELETE FROM memory_objects WHERE owner_id = $1 AND root_id = $2", [
        ownerId,
        row.root_id,
      ]);
    });
  }

  /**
   * Recall active memories, ranked by hybrid retrieval: vector (meaning) and keyword (exact)
   * arms fused with reciprocal-rank fusion. `similarity` is the cosine signal alone;
   * `rrfScore` is the fused rank a result should be ordered by. Results arrive fused-order.
   */
  async recall(query: string, opts: RecallOptions = {}): Promise<Memory[]> {
    const owner = opts.ownerId ?? SENTINEL_OWNER;
    const limit = opts.limit ?? 10;
    const [embedding] = await this.#embedding.embed([query]);
    if (!embedding) throw new Error("memloom: embedding provider returned no vector");
    const qvec = toVectorLiteral(embedding);

    // The temporal arm: a calendar-day filter over memories, ranked by similarity.
    // Deliberately outside the fuse (which has no notion of time): the day IS the filter,
    // similarity only orders within it. Context chunks are excluded by construction.
    if (opts.assertedOn) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.assertedOn)) {
        throw new Error(`memloom: assertedOn must be YYYY-MM-DD, got "${opts.assertedOn}"`);
      }
      // Callers pass the USER's calendar day (the assistant's "today", MCP on_date), but a
      // bare timestamptz::date cast folds in the DB session's timezone, UTC on PGLite. Those
      // days disagree for a few hours around midnight, so "plans for today" would silently
      // miss right after midnight. The daemon runs on the user's machine, so the host
      // timezone is the user's day; convert before taking the date.
      const rows = await this.#storage.query<MemoryRow>(
        `SELECT id, owner_id, status, memory_type, canonical, content, summary, root_id,
                version, asserted_at, created_at,
                1 - (embedding <=> $1::vector) AS similarity
         FROM memory_objects
         WHERE owner_id = $2 AND status = 'active'
           AND (asserted_at AT TIME ZONE $3)::date = $4::date
         ORDER BY similarity DESC LIMIT $5`,
        [qvec, owner, hostTimeZone(), opts.assertedOn, limit],
      );
      return rows.map((row) => ({ ...mapRow(row), kind: "memory" as const }));
    }

    // The fuse ranks memories and context chunks together; join whichever table each id
    // came from and map to one result shape (chunks carry a source for provenance).
    const rows = await this.#storage.query<RecallRow>(
      `SELECT f.id, f.src, f.rrf_score,
              1 - (COALESCE(mo.embedding, cc.embedding) <=> $1::vector) AS similarity,
              mo.owner_id, mo.status, mo.memory_type, mo.canonical, mo.content,
              mo.summary, mo.root_id, mo.version, mo.asserted_at, mo.created_at,
              cc.owner_id AS c_owner_id, cc.content AS c_content,
              cc.heading_path AS c_heading_path, cc.page AS c_page,
              cc.created_at AS c_created_at,
              cd.id AS d_id, cd.title AS d_title, cd.path AS d_path
       FROM memloom_fuse($2, $1::vector, $3, $4, p_session => $5) f
       LEFT JOIN memory_objects mo ON f.src = 'memory' AND mo.id = f.id
       LEFT JOIN context_chunks cc ON f.src = 'chunk' AND cc.id = f.id
       LEFT JOIN context_documents cd ON cd.id = cc.document_id
       ORDER BY f.rrf_score DESC`,
      [qvec, query, owner, limit, opts.sessionId ?? null],
    );
    return rows.map(mapRecallRow);
  }

  /**
   * Index unprocessed memories AND context chunks: extract entities, resolve them, and link
   * each source to its entities with a 'mention' edge in the shared edge table. Idempotent:
   * only touches rows not yet indexed. Chunks stay outside the belief pipeline; their edges
   * are how context connects to memory (rolled up per document in graph()). One LLM call per
   * row, so a large PDF makes indexing proportionally slower.
   */
  async index(
    ownerId: string = SENTINEL_OWNER,
    onProgress?: (event: IndexProgressEvent) => void,
  ): Promise<IndexResult> {
    return this.#runIndex(ownerId, "index", onProgress);
  }

  // Run ids this process is executing right now. Any DB row still 'running' that is NOT in
  // here belongs to a process that died mid-run: reconciled to 'interrupted' on read/start.
  #activeRuns = new Set<string>();

  async #reconcileInterruptedRuns(ownerId: string): Promise<void> {
    const live = [...this.#activeRuns];
    await this.#storage.query(
      `UPDATE memory_index_runs SET status = 'interrupted', finished_at = now()
       WHERE owner_id = $1 AND status = 'running'${
         live.length > 0 ? ` AND id NOT IN (${live.map((_, i) => `$${i + 2}`).join(", ")})` : ""
}`,
      [ownerId, ...live],
    );
  }

  /**
   * The shared index pass behind index() and reindex(): processes every unindexed memory
   * and chunk, and records the pass as a session: one memory_index_runs row plus one
   * memory_index_events row per item, so progress survives the viewer navigating away
   * and CLI runs show up in the Console. A failing item is logged and left unindexed
   * (the next run retries it); the run finishes 'warning' instead of dying mid-batch.
   */
  async #runIndex(
    ownerId: string,
    trigger: "index" | "rebuild",
    onProgress?: (event: IndexProgressEvent) => void,
  ): Promise<IndexResult> {
    const snippet = (text: string) => (text.length > 64 ? `${text.slice(0, 61)}...` : text);
    // The vocabulary is loaded ONCE per run (registry rows: system + user tiers, active),
    // then injected into every extraction: one query, not one per item.
    const schema = await this.#activeSchema(ownerId);

    const pending = await this.#storage.query<{ id: string; content: string }>(
      `SELECT id, content FROM memory_objects
       WHERE owner_id = $1 AND status = 'active' AND indexed_at IS NULL
       ORDER BY created_at`,
      [ownerId],
    );
    const pendingChunks = await this.#storage.query<{
      id: string;
      content: string;
      heading_path: string | null;
      chunk_index: number;
      doc_title: string;
    }>(
      `SELECT cc.id, cc.content, cc.heading_path, cc.chunk_index, cd.title AS doc_title
       FROM context_chunks cc
       JOIN context_documents cd ON cd.id = cc.document_id
       WHERE cc.owner_id = $1 AND cc.indexed_at IS NULL AND cc.session_id IS NULL
       ORDER BY cc.created_at, cc.chunk_index`,
      [ownerId],
    );
    // Nothing pending: no session row; an empty run every time someone clicks "index"
    // would drown the real history.
    if (pending.length + pendingChunks.length === 0) return { indexed: 0, chunksIndexed: 0 };

    await this.#reconcileInterruptedRuns(ownerId);
    const [run] = await this.#storage.query<{ id: string }>(
      `INSERT INTO memory_index_runs (owner_id, trigger, batch_size)
       VALUES ($1, $2, $3) RETURNING id`,
      [ownerId, trigger, pending.length + pendingChunks.length],
    );
    if (!run) throw new Error("memloom: could not create index run");
    const runId = run.id;
    this.#activeRuns.add(runId);

    // entities/relations count rows and edges that did not exist before this run, never
    // resolves of existing ones: the console's "+N entities" must reconcile with the table.
    const totals = { memories: 0, chunks: 0, failed: 0, entities: 0, relations: 0 };
    const logEvent = async (
      level: "info" | "success" | "warning" | "error",
      message: string,
      itemId: string | null,
      metadata: Record<string, unknown>,
    ) => {
      await this.#storage.query(
        `INSERT INTO memory_index_events (owner_id, run_id, level, message, item_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [ownerId, runId, level, message, itemId, JSON.stringify(metadata)],
      );
    };
    // Counters sync per item, not per run, so an interrupted run's row still tells the truth.
    const syncTotals = async () => {
      await this.#storage.query(
        `UPDATE memory_index_runs
         SET memories_indexed = $2, chunks_indexed = $3, items_failed = $4,
             entities_linked = $5, relations_created = $6
         WHERE id = $1`,
        [runId, totals.memories, totals.chunks, totals.failed, totals.entities, totals.relations],
      );
    };
    const outcomeOf = (linked: { entities: string[]; relationships: number }) =>
      linked.entities.length === 0
        ? "no entities"
        : linked.entities.join(", ") +
          (linked.relationships > 0
            ? ` (+${linked.relationships} ${linked.relationships === 1 ? "relationship" : "relationships"})`
            : "");

    // The expensive step per item is the LLM extraction (seconds); the writes around it
    // are milliseconds. A worker pool overlaps the extractions while EVERY write (entity
    // resolution, edges, indexed_at, run bookkeeping) passes through one serialized
    // queue: no two items write concurrently, so #resolveEntity's read-check-insert can
    // never race itself into duplicate entities and PGLite sees sequential writes.
    const concurrency = Math.max(
      1,
      Math.min(16, Number(process.env.MEMLOOM_INDEX_CONCURRENCY) || 6),
    );
    // Consecutive item failures mean the provider path is down, not that items are bad:
    // stop cleanly instead of burning through hundreds of doomed calls. Unvisited items
    // stay unindexed; `memloom index` resumes.
    const BREAKER_THRESHOLD = 5;
    let consecutiveFailures = 0;
    let breakerTripped = false;

    let writeChain: Promise<unknown> = Promise.resolve();
    const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
      const next = writeChain.then(fn, fn);
      writeChain = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    };

    const runPool = async <T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> => {
      let cursor = 0;
      await Promise.all(
        Array.from({ length: Math.min(concurrency, items.length) }, async () => {
          for (;;) {
            if (breakerTripped) return;
            const item = items[cursor++];
            if (item === undefined) return;
            await worker(item);
          }
        }),
      );
    };

    try {
      let memoryDone = 0;
      await runPool(pending, async (memory) => {
        const label = snippet(memory.content);
        let extraction: Awaited<ReturnType<typeof extractGraph>> | null = null;
        let failure: string | null = null;
        try {
          extraction = await this.#extractForGraph(ownerId, memory.content, schema);
        } catch (err) {
          failure = err instanceof Error ? err.message : String(err);
        }
        await serialized(async () => {
          memoryDone += 1;
          const base = {
            kind: "memory" as const,
            id: memory.id,
            label,
            index: memoryDone,
            total: pending.length,
          };
          const prefix = `[${base.index}/${base.total}] memory ${base.label}`;
          try {
            if (failure !== null || extraction === null) throw new Error(failure ?? "no extraction");
            const linked = await this.#writeGraph(ownerId, memory.id, extraction);
            await this.#storage.query(
              "UPDATE memory_objects SET indexed_at = now() WHERE id = $1",
              [memory.id],
            );
            totals.memories += 1;
            totals.entities += linked.newEntities;
            totals.relations += linked.relationships;
            consecutiveFailures = 0;
            await logEvent(
              linked.entities.length > 0 ? "success" : "info",
              `${prefix} → ${outcomeOf(linked)}`,
              memory.id,
              { entities: linked.entities, relationships: linked.relationships },
            );
            await syncTotals();
            onProgress?.({
              ...base,
              entities: linked.entities,
              relationships: linked.relationships,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            totals.failed += 1;
            consecutiveFailures += 1;
            if (consecutiveFailures >= BREAKER_THRESHOLD) breakerTripped = true;
            await logEvent("error", `${prefix} → failed: ${message}`, memory.id, {
              error: message,
            });
            await syncTotals();
            onProgress?.({ ...base, entities: [], error: message });
          }
        });
      });

      let chunkDone = 0;
      await runPool(pendingChunks, async (chunk) => {
        const label = snippet(
          `${chunk.doc_title} › ${chunk.heading_path ?? `#${Number(chunk.chunk_index) + 1}`}`,
        );
        // Formula-dominated chunks have nothing extractable: skip the LLM call entirely
        // (a math exercise sheet would otherwise become a graph of equations).
        const skipped = isMathDense(chunk.content);
        let extraction: Awaited<ReturnType<typeof extractGraph>> | null = null;
        let failure: string | null = null;
        if (!skipped) {
          try {
            extraction = await this.#extractForGraph(ownerId, chunk.content, schema, {
              docTitle: chunk.doc_title,
            });
          } catch (err) {
            failure = err instanceof Error ? err.message : String(err);
          }
        }
        await serialized(async () => {
          chunkDone += 1;
          const base = {
            kind: "chunk" as const,
            id: chunk.id,
            label,
            index: chunkDone,
            total: pendingChunks.length,
          };
          const prefix = `[${base.index}/${base.total}] chunk ${base.label}`;
          try {
            if (failure !== null) throw new Error(failure);
            const linked =
              skipped || extraction === null
                ? { entities: [], newEntities: 0, relationships: 0 }
                : await this.#writeGraph(ownerId, chunk.id, extraction);
            await this.#storage.query(
              "UPDATE context_chunks SET indexed_at = now() WHERE id = $1",
              [chunk.id],
            );
            totals.chunks += 1;
            totals.entities += linked.newEntities;
            totals.relations += linked.relationships;
            consecutiveFailures = 0;
            await logEvent(
              skipped ? "info" : linked.entities.length > 0 ? "success" : "info",
              `${prefix} → ${skipped ? "skipped (math-dense)" : outcomeOf(linked)}`,
              chunk.id,
              skipped
                ? { skipped: "math-dense" }
                : { entities: linked.entities, relationships: linked.relationships },
            );
            await syncTotals();
            onProgress?.({
              ...base,
              entities: linked.entities,
              relationships: linked.relationships,
              ...(skipped ? { skipped: "math-dense" as const } : {}),
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            totals.failed += 1;
            consecutiveFailures += 1;
            if (consecutiveFailures >= BREAKER_THRESHOLD) breakerTripped = true;
            await logEvent("error", `${prefix} → failed: ${message}`, chunk.id, {
              error: message,
            });
            await syncTotals();
            onProgress?.({ ...base, entities: [], error: message });
          }
        });
      });

      if (breakerTripped) {
        await logEvent(
          "error",
          `stopped after ${BREAKER_THRESHOLD} consecutive failures; the provider looks ` +
            "unreachable. Everything already indexed is saved; run `memloom index` to resume.",
          null,
          { breaker: true },
        );
      }
      const status = breakerTripped
        ? "interrupted"
        : totals.failed === 0
          ? "success"
          : totals.memories + totals.chunks > 0
            ? "warning"
            : "error";
      await this.#storage.query(
        "UPDATE memory_index_runs SET status = $2, finished_at = now() WHERE id = $1",
        [runId, status],
      );
    } catch (err) {
      // Something outside the per-item guards (storage failure, schema query): finalize
      // the session honestly before propagating.
      await this.#storage
        .query("UPDATE memory_index_runs SET status = 'error', finished_at = now() WHERE id = $1", [
          runId,
        ])
        .catch(() => {});
      throw err;
    } finally {
      this.#activeRuns.delete(runId);
    }

    return { indexed: totals.memories, chunksIndexed: totals.chunks };
  }

  /** Index sessions, newest first: the Console's persistent log. Reconciles dead runs. */
  async listIndexRuns(ownerId: string = SENTINEL_OWNER, limit = 100): Promise<IndexRun[]> {
    await this.#reconcileInterruptedRuns(ownerId);
    const rows = await this.#storage.query<{
      id: string;
      trigger: IndexRun["trigger"];
      status: IndexRun["status"];
      batch_size: number;
      memories_indexed: number;
      chunks_indexed: number;
      items_failed: number;
      entities_linked: number;
      relations_created: number;
      started_at: string;
      finished_at: string | null;
    }>(
      `SELECT id, trigger, status, batch_size, memories_indexed, chunks_indexed, items_failed,
              entities_linked, relations_created, started_at, finished_at
       FROM memory_index_runs WHERE owner_id = $1
       ORDER BY started_at DESC LIMIT $2`,
      [ownerId, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      trigger: r.trigger,
      status: r.status,
      batchSize: Number(r.batch_size),
      memoriesIndexed: Number(r.memories_indexed),
      chunksIndexed: Number(r.chunks_indexed),
      itemsFailed: Number(r.items_failed),
      entitiesLinked: Number(r.entities_linked),
      relationsCreated: Number(r.relations_created),
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    }));
  }

  /** The per-item log lines of one session, oldest first (reads like a terminal). */
  async indexRunEvents(runId: string, ownerId: string = SENTINEL_OWNER): Promise<IndexRunEvent[]> {
    const rows = await this.#storage.query<{
      id: string;
      level: IndexRunEvent["level"];
      message: string;
      item_id: string | null;
      metadata: unknown;
      created_at: string;
    }>(
      `SELECT id, level, message, item_id, metadata, created_at
       FROM memory_index_events WHERE owner_id = $1 AND run_id = $2
       ORDER BY created_at, id`,
      [ownerId, runId],
    );
    return rows.map((r) => ({
      id: r.id,
      level: r.level,
      message: r.message,
      itemId: r.item_id,
      // jsonb comes back parsed from pg/PGLite, but tolerate string-returning adapters.
      metadata: (typeof r.metadata === "string"
        ? JSON.parse(r.metadata)
        : (r.metadata ?? {})) as IndexRunEvent["metadata"],
      createdAt: r.created_at,
    }));
  }

  /** Delete one session and its events (the Console's per-row delete). */
  async deleteIndexRun(runId: string, ownerId: string = SENTINEL_OWNER): Promise<void> {
    await this.#storage.query(
      "DELETE FROM memory_index_runs WHERE owner_id = $1 AND id = $2", // events cascade
      [ownerId, runId],
    );
  }

  /** Wipe the whole indexing history. */
  async clearIndexRuns(ownerId: string = SENTINEL_OWNER): Promise<void> {
    await this.#storage.query("DELETE FROM memory_index_runs WHERE owner_id = $1", [ownerId]);
  }

  // assistant chat

  static readonly #ASSISTANT_HISTORY_LIMIT = 12;

  async #embedOrNull(text: string): Promise<string | null> {
    try {
      const [vec] = await this.#embedding.embed([text]);
      return vec ? toVectorLiteral(vec) : null;
    } catch {
      return null; // search degrades to keyword-only for this message; the chat still works
    }
  }

  async #saveAssistantMessage(
    ownerId: string,
    sessionId: string,
    role: "user" | "assistant",
    content: string,
    sources: AssistantSource[],
  ): Promise<string> {
    const embedding = await this.#embedOrNull(content);
    const [row] = await this.#storage.query<{ id: string }>(
      `INSERT INTO assistant_messages (owner_id, session_id, role, content, sources, embedding)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [ownerId, sessionId, role, content, JSON.stringify(sources), embedding],
    );
    return row?.id ?? "";
  }

  /**
   * One assistant turn: resolve/create the session, replay recent history, run the
   * agentic loop (the model decides whether to recall), persist both turns, return the
   * grounded answer with its sources. `onEvent` streams tool activity + answer deltas.
   */
  async assistantChat(
    input: { sessionId?: string; message: string; ownerId?: string; model?: string },
    onEvent?: (e: AssistantEvent) => void,
  ): Promise<AssistantChatResult> {
    const owner = input.ownerId ?? SENTINEL_OWNER;
    const llm = this.#llm;
    if (!isChatProvider(llm)) {
      throw new Error(
        "the assistant needs a chat-capable LLM: add OPENROUTER_API_KEY to " +
          "~/.memloom/config.env and restart the daemon",
      );
    }

    const titleOf = (message: string) =>
      message.length > 60 ? `${message.slice(0, 57)}...` : message;
    let sessionId = input.sessionId;
    if (sessionId) {
      const found = await this.#storage.query<{ title: string }>(
        "SELECT title FROM assistant_sessions WHERE owner_id = $1 AND id = $2",
        [owner, sessionId],
      );
      if (found.length === 0) throw new Error(`no assistant session ${sessionId}`);
      // A session created by an attach-before-first-message still has the column default
      // title; the first real message names it. The guard makes this race-safe.
      if (found[0]?.title === "New chat") {
        await this.#storage.query(
          `UPDATE assistant_sessions SET title = $3
           WHERE owner_id = $1 AND id = $2 AND title = 'New chat'`,
          [owner, sessionId, titleOf(input.message)],
        );
      }
    } else {
      const [row] = await this.#storage.query<{ id: string }>(
        "INSERT INTO assistant_sessions (owner_id, title) VALUES ($1, $2) RETURNING id",
        [owner, titleOf(input.message)],
      );
      if (!row) throw new Error("memloom: could not create assistant session");
      sessionId = row.id;
    }

    // Last N plain turns, oldest first. Tool scaffolding is never persisted, so this is
    // exactly what the model should see again.
    const historyRows = await this.#storage.query<{ role: "user" | "assistant"; content: string }>(
      `SELECT role, content FROM assistant_messages
       WHERE owner_id = $1 AND session_id = $2 ORDER BY created_at DESC, seq DESC LIMIT $3`,
      [owner, sessionId, Memloom.#ASSISTANT_HISTORY_LIMIT],
    );
    const history = historyRows.reverse();
    const attachments = (await this.sessionAttachments(sessionId, owner)).map((d) => d.title);

    await this.#saveAssistantMessage(owner, sessionId, "user", input.message, []);

    const now = new Date();
    const scopedSessionId = sessionId;
    const { answer, sources } = await runAssistantTurn({
      provider: llm,
      recall: (query, onDate) =>
        this.recall(query, {
          ownerId: owner,
          limit: 8,
          sessionId: scopedSessionId,
          ...(onDate ? { assertedOn: onDate } : {}),
        }),
      history,
      message: input.message,
      // Both forms: the readable one for prose, the ISO one to copy into on_date.
      today: `${now.toDateString()} (${now.toLocaleDateString("en-CA")})`,
      ...(input.model ? { model: input.model } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(onEvent ? { onEvent } : {}),
    });

    const messageId = await this.#saveAssistantMessage(
      owner,
      sessionId,
      "assistant",
      answer,
      sources,
    );
    await this.#storage.query("UPDATE assistant_sessions SET updated_at = now() WHERE id = $1", [
      sessionId,
    ]);
    return { sessionId, messageId, answer, sources };
  }

  async assistantSessions(ownerId: string = SENTINEL_OWNER): Promise<AssistantSession[]> {
    const rows = await this.#storage.query<{
      id: string;
      title: string;
      is_starred: boolean;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, title, is_starred, created_at, updated_at FROM assistant_sessions
       WHERE owner_id = $1 ORDER BY is_starred DESC, updated_at DESC`,
      [ownerId],
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      isStarred: Boolean(r.is_starred),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async assistantMessages(
    sessionId: string,
    ownerId: string = SENTINEL_OWNER,
  ): Promise<AssistantMessage[]> {
    const rows = await this.#storage.query<{
      id: string;
      role: "user" | "assistant";
      content: string;
      sources: unknown;
      created_at: string;
    }>(
      `SELECT id, role, content, sources, created_at FROM assistant_messages
       WHERE owner_id = $1 AND session_id = $2 ORDER BY created_at, seq`,
      [ownerId, sessionId],
    );
    return rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      sources: (typeof r.sources === "string"
        ? JSON.parse(r.sources)
        : (r.sources ?? [])) as AssistantSource[],
      createdAt: r.created_at,
    }));
  }

  async renameAssistantSession(
    sessionId: string,
    title: string,
    ownerId: string = SENTINEL_OWNER,
  ): Promise<void> {
    await this.#storage.query(
      "UPDATE assistant_sessions SET title = $3 WHERE owner_id = $1 AND id = $2",
      [ownerId, sessionId, title.trim() || "New chat"],
    );
  }

  async starAssistantSession(
    sessionId: string,
    starred: boolean,
    ownerId: string = SENTINEL_OWNER,
  ): Promise<void> {
    await this.#storage.query(
      "UPDATE assistant_sessions SET is_starred = $3 WHERE owner_id = $1 AND id = $2",
      [ownerId, sessionId, starred],
    );
  }

  async deleteAssistantSession(sessionId: string, ownerId: string = SENTINEL_OWNER): Promise<void> {
    await this.#storage.tx(async (tx) => {
      // Attachments are scoped to the chat, so they die with it. Chunks cascade from the
      // document FK, but edge cleanup must be explicit (see #deleteDocumentChunks); session
      // chunks are never indexed so no edges exist in practice: this keeps the invariant
      // anyway. Messages cascade from the session FK.
      await this.#deleteSessionAttachments(tx, ownerId, sessionId);
      await tx.query("DELETE FROM assistant_sessions WHERE owner_id = $1 AND id = $2", [
        ownerId,
        sessionId,
      ]);
    });
  }

  async clearAssistantSessions(ownerId: string = SENTINEL_OWNER): Promise<void> {
    await this.#storage.tx(async (tx) => {
      await this.#deleteSessionAttachments(tx, ownerId, null);
      await tx.query("DELETE FROM assistant_sessions WHERE owner_id = $1", [ownerId]);
    });
  }

  /** Delete one session's attached documents (sessionId null = every session's). */
  async #deleteSessionAttachments(
    tx: StorageAdapter,
    owner: string,
    sessionId: string | null,
  ): Promise<void> {
    const docs = await tx.query<{ id: string }>(
      `SELECT id FROM context_documents
       WHERE owner_id = $1 AND session_id IS NOT NULL
         AND ($2::uuid IS NULL OR session_id = $2)`,
      [owner, sessionId],
    );
    for (const doc of docs) {
      await this.#deleteDocumentChunks(tx, doc.id, owner);
      await tx.query("DELETE FROM context_documents WHERE id = $1 AND owner_id = $2", [
        doc.id,
        owner,
      ]);
    }
  }

  /**
   * Hybrid chat search: a keyword arm (ILIKE over titles + message content) and a
   * similarity arm (cosine over message embeddings). Merged per session; keyword hits
   * rank above pure-similarity hits; each hit carries its best-matching snippet.
   */
  async searchAssistantSessions(
    query: string,
    ownerId: string = SENTINEL_OWNER,
  ): Promise<AssistantSessionHit[]> {
    const q = query.trim();
    if (!q) return (await this.assistantSessions(ownerId)).map((s) => ({ ...s, snippet: "" }));

    type HitRow = {
      id: string;
      title: string;
      is_starred: boolean;
      created_at: string;
      updated_at: string;
      snippet: string | null;
      sim?: number;
    };
    const keyword = await this.#storage.query<HitRow>(
      `SELECT DISTINCT ON (s.id) s.id, s.title, s.is_starred, s.created_at, s.updated_at,
              m.content AS snippet
       FROM assistant_sessions s
       LEFT JOIN assistant_messages m ON m.session_id = s.id AND m.content ILIKE $2
       WHERE s.owner_id = $1 AND (s.title ILIKE $2 OR m.id IS NOT NULL)
       ORDER BY s.id, m.created_at DESC`,
      [ownerId, `%${q}%`],
    );

    const hits = new Map<string, AssistantSessionHit & { score: number }>();
    const add = (row: HitRow, score: number) => {
      const existing = hits.get(row.id);
      if (existing && existing.score >= score) return;
      hits.set(row.id, {
        id: row.id,
        title: row.title,
        isStarred: Boolean(row.is_starred),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        snippet: (row.snippet ?? "").slice(0, 160),
        score,
      });
    };
    for (const row of keyword) add(row, 2); // keyword outranks similarity

    const [vec] = await this.#embedding.embed([q]).catch(() => [undefined]);
    if (vec) {
      const similar = await this.#storage.query<HitRow>(
        `SELECT DISTINCT ON (s.id) s.id, s.title, s.is_starred, s.created_at, s.updated_at,
                m.content AS snippet, 1 - (m.embedding <=> $2::vector) AS sim
         FROM assistant_messages m
         JOIN assistant_sessions s ON s.id = m.session_id
         WHERE m.owner_id = $1 AND m.embedding IS NOT NULL
         ORDER BY s.id, sim DESC`,
        [ownerId, toVectorLiteral(vec)],
      );
      for (const row of similar) {
        const sim = Number(row.sim ?? 0);
        if (sim >= 0.35) add(row, sim);
      }
    }

    return [...hits.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map(({ score: _score, ...hit }) => hit);
  }

  /**
   * Wipe every extracted artifact and re-run indexing from scratch: the recovery path for
   * a store polluted by a weaker extraction pipeline. Deletes all entities, their mention
   * edges (from memories AND chunks), and every typed entity-to-entity edge; belief edges
   * (replaces/distinct) connect only memory_objects and are untouched by construction.
   * The wipe commits in one tx BEFORE any LLM call: a mid-run failure leaves everything
   * merely unindexed, and a plain index() resumes.
   */
  async reindex(
    ownerId: string = SENTINEL_OWNER,
    onProgress?: (event: IndexProgressEvent) => void,
  ): Promise<IndexResult> {
    await this.#storage.tx(async (tx) => {
      await tx.query(
        `DELETE FROM memory_edges
         WHERE owner_id = $1
           AND (relation = 'mention'
             OR from_id IN (SELECT id FROM memory_entities WHERE owner_id = $1)
             OR to_id IN (SELECT id FROM memory_entities WHERE owner_id = $1))`,
        [ownerId],
      );
      await tx.query("DELETE FROM memory_entities WHERE owner_id = $1", [ownerId]);
      await tx.query(
        "UPDATE memory_objects SET indexed_at = NULL WHERE owner_id = $1 AND status = 'active'",
        [ownerId],
      );
      await tx.query(
        "UPDATE context_chunks SET indexed_at = NULL WHERE owner_id = $1 AND session_id IS NULL",
        [ownerId],
      );
    });
    return this.#runIndex(ownerId, "rebuild", onProgress);
  }

  /**
   * Recompute every stored embedding with the CURRENTLY configured provider, then stamp the
   * store with its fingerprint: the migration path for switching embedding configs (offline
   * hashing to a real cloud model being the one that matters). Same crash-safety story as
   * reindex(): the wipe (all vectors NULLed + a marker in _memloom_meta) commits before the
   * first provider call, `embedding IS NULL` is the resume cursor, and an interrupted run
   * resumes by calling reembed() again. While the marker exists a normal init() refuses to
   * serve. Store-wide on purpose: a store is one vector space, owners share it.
   *
   * Not on MemoryEngine/HTTP: a maintenance path for hosts that own the store directly, and
   * it requires init({ fingerprint: "tolerate" }) to have been used when fingerprints differ.
   */
  async reembed(opts: ReembedOptions = {}): Promise<ReembedResult> {
    const current = this.#embedding.fingerprint;
    // Defense in depth behind the CLI's pre-init check: a provider of the wrong width would
    // otherwise fail row by row with an opaque pgvector cast error.
    const [col] = await this.#storage.query<{ dims: number | null }>(
      `SELECT atttypmod AS dims FROM pg_attribute
       WHERE attrelid = to_regclass('memory_objects') AND attname = 'embedding'`,
    );
    if (col?.dims != null && col.dims !== -1 && col.dims !== this.#embedding.dims) {
      throw new Error(
        `this store's embedding columns are vector(${col.dims}) but the configured provider ` +
          `produces ${this.#embedding.dims} dims ("${current}"). Changing dimensions is not ` +
          "supported by reembed yet; configure a model with matching dims, or start fresh.",
      );
    }

    const meta = await this.#storage.query<{ key: string; value: string }>(
      `SELECT key, value FROM _memloom_meta
       WHERE key IN ('embedding_fingerprint', '${REEMBED_MARKER_KEY}')`,
    );
    const stored = meta.find((r) => r.key === "embedding_fingerprint")?.value ?? null;
    const marker = meta.find((r) => r.key === REEMBED_MARKER_KEY)?.value;

    // Each table's re-embeddable text. Everything with a vector column, ALL rows (stale
    // memories and session chunks included): a store is one vector space or none.
    const tables: Array<{
      table: ReembedProgressEvent["table"];
      name: string;
      text: string;
      touch: string;
    }> = [
      { table: "memories", name: "memory_objects", text: "content", touch: ", updated_at = now()" },
      { table: "entities", name: "memory_entities", text: "name", touch: "" },
      { table: "chunks", name: "context_chunks", text: "content", touch: "" },
      { table: "messages", name: "assistant_messages", text: "content", touch: "" },
    ];

    const countNulls = async () => {
      const counts = {} as Record<ReembedProgressEvent["table"], number>;
      for (const t of tables) {
        const [row] = await this.#storage.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${t.name} WHERE embedding IS NULL`,
        );
        counts[t.table] = row?.n ?? 0;
      }
      return counts;
    };

    const resuming = marker !== undefined && marker === current;
    if (!resuming) {
      const pending = await countNulls();
      const anyNull = Object.values(pending).some((n) => n > 0);
      if (stored === current && marker === undefined && !anyNull && !opts.force) {
        return {
          outcome: "up-to-date",
          previousFingerprint: stored,
          fingerprint: current,
          counts: { memories: 0, entities: 0, chunks: 0, messages: 0 },
        };
      }
      // The wipe: marker first, then every vector, one tx. From here until the finish tx the
      // store refuses a normal init(), which is exactly right: half its vectors are NULL.
      // A marker for a DIFFERENT target (config changed mid-migration) lands here too and
      // simply re-wipes toward the new one.
      await this.#storage.tx(async (tx) => {
        await tx.query(
          `INSERT INTO _memloom_meta (key, value) VALUES ('${REEMBED_MARKER_KEY}', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [current],
        );
        for (const t of tables) {
          await tx.query(`UPDATE ${t.name} SET embedding = NULL WHERE embedding IS NOT NULL`);
        }
      });
    }

    // Backfill, paged. 128 = two of the OpenRouter provider's internal batches of 64; a crash
    // loses at most one page of API spend. The provider call stays OUTSIDE any tx (slow,
    // fallible), mirroring the ingest path.
    const PAGE = 128;
    const totals = await countNulls();
    const counts = { memories: 0, entities: 0, chunks: 0, messages: 0 };
    for (const t of tables) {
      for (;;) {
        const rows = await this.#storage.query<{ id: string; text: string }>(
          `SELECT id, ${t.text} AS text FROM ${t.name}
           WHERE embedding IS NULL ORDER BY created_at, id LIMIT ${PAGE}`,
        );
        if (rows.length === 0) break;
        const vectors = await this.#embedding.embed(rows.map((r) => r.text));
        await this.#storage.query(
          `UPDATE ${t.name} AS x
           SET embedding = v.emb::vector${t.touch}
           FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::text[]) AS emb) v
           WHERE x.id = v.id`,
          [rows.map((r) => r.id), vectors.map(toVectorLiteral)],
        );
        counts[t.table] += rows.length;
        opts.onProgress?.({ table: t.table, done: counts[t.table], total: totals[t.table] });
      }
    }

    await this.#storage.tx(async (tx) => {
      await tx.query(
        `INSERT INTO _memloom_meta (key, value) VALUES ('embedding_fingerprint', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [current],
      );
      await tx.query(`DELETE FROM _memloom_meta WHERE key = '${REEMBED_MARKER_KEY}'`);
    });
    return { outcome: "reembedded", previousFingerprint: stored, fingerprint: current, counts };
  }

  /**
   * The graph schema with live usage counts: the closed entity-type vocabulary and the
   * relation/predicate vocabulary, zero-filled so every schema row appears even before
   * first use. Predicate counts consider entity-sourced edges only, so document/memory
   * mention edges don't pollute the quarantine count.
   */
  async describeSchema(ownerId: string = SENTINEL_OWNER): Promise<SchemaInfo> {
    await this.#ensureSchemaSeed(ownerId);
    const rows = await this.#storage.query<
      SchemaEntry & { created_at: string; examples: ProposalExample[] | string }
    >(
      `SELECT id, kind, name, description, tier, status, occurrences, examples, created_at
       FROM memory_schema WHERE owner_id = $1 ORDER BY created_at`,
      [ownerId],
    );
    const typeCounts = await this.#storage.query<{ entity_type: string; n: number }>(
      "SELECT entity_type, count(*)::int AS n FROM memory_entities WHERE owner_id = $1 GROUP BY entity_type",
      [ownerId],
    );
    const relationCounts = await this.#storage.query<{ relation: string; n: number }>(
      "SELECT relation, count(*)::int AS n FROM memory_edges WHERE owner_id = $1 AND active GROUP BY relation",
      [ownerId],
    );
    const predicateCounts = await this.#storage.query<{ relation: string; n: number }>(
      `SELECT e.relation, count(*)::int AS n
       FROM memory_edges e
       JOIN memory_entities me ON me.id = e.from_id
       WHERE e.owner_id = $1 AND e.active
       GROUP BY e.relation`,
      [ownerId],
    );
    const byType = new Map(typeCounts.map((r) => [r.entity_type, Number(r.n)]));
    const byRelation = new Map(relationCounts.map((r) => [r.relation, Number(r.n)]));
    const byPredicate = new Map(predicateCounts.map((r) => [r.relation, Number(r.n)]));

    const entry = (r: SchemaEntry): SchemaEntry => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      description: r.description,
      tier: r.tier,
      status: r.status,
      occurrences: Number(r.occurrences),
    });
    const vocab = rows.filter((r) => r.tier !== "proposed" && r.status !== "dismissed");
    return {
      entityTypes: vocab
        .filter((r) => r.kind === "entity_type")
        .map((r) => ({ ...entry(r), count: byType.get(r.name) ?? 0 })),
      // Edge relations are engine mechanics, not registry rows: reported from code.
      relations: EDGE_RELATIONS.map((r) => ({
        name: r.name,
        description: r.description,
        count: r.virtual ? 0 : (byRelation.get(r.name) ?? 0),
      })),
      predicates: vocab
        .filter((r) => r.kind === "predicate")
        .map((r) => ({ ...entry(r), count: byPredicate.get(r.name) ?? 0 })),
      // The review queue: suggested often enough, not yet approved or dismissed. Each
      // carries the saved occurrences, so review shows the evidence and approval links it.
      proposals: rows
        .filter(
          (r) =>
            r.tier === "proposed" &&
            r.status === "active" &&
            Number(r.occurrences) >= PROPOSAL_MIN_OCCURRENCES,
        )
        .map((r) => ({
          ...entry(r),
          examples: Array.isArray(r.examples)
            ? r.examples
            : typeof r.examples === "string"
              ? JSON.parse(r.examples)
              : [],
        })),
    };
  }

  /**
   * The memory graph for the owner: one graph, two granularities. Active memories, entities,
   * and context documents as nodes. Chunk-level mention edges never leave the store; they
   * roll up to one weighted document -> entity edge, so a 300-chunk PDF is one node, not a
   * hairball (Zep/Cognee link raw content at fine grain but nobody renders chunks).
   */
  async graph(ownerId: string = SENTINEL_OWNER): Promise<Graph> {
    const memoryRows = await this.#storage.query<{
      id: string;
      canonical: string | null;
      content: string;
      memory_type: GraphMemory["memoryType"];
    }>(
      `SELECT id, canonical, content, memory_type FROM memory_objects
       WHERE owner_id = $1 AND status = 'active'`,
      [ownerId],
    );
    const entityRows = await this.#storage.query<{ id: string; name: string; entity_type: string }>(
      "SELECT id, name, entity_type FROM memory_entities WHERE owner_id = $1",
      [ownerId],
    );
    const documents = await this.#storage.query<GraphDocument>(
      "SELECT id, title, path FROM context_documents WHERE owner_id = $1 AND session_id IS NULL",
      [ownerId],
    );
    // Memory-anchored edges only: chunk edges are represented by the rollup below.
    const edgeRows = await this.#storage.query<{
      from_id: string;
      to_id: string;
      relation: string;
    }>(
      `SELECT e.from_id, e.to_id, e.relation
       FROM memory_edges e
       JOIN memory_objects mo ON mo.id = e.from_id
       WHERE e.owner_id = $1 AND e.active`,
      [ownerId],
    );
    // Typed entity-to-entity relationships (uses, part_of, ...) plus quarantined mentions.
    const entityEdgeRows = await this.#storage.query<{
      from_id: string;
      to_id: string;
      relation: string;
    }>(
      `SELECT e.from_id, e.to_id, e.relation
       FROM memory_edges e
       JOIN memory_entities me ON me.id = e.from_id
       WHERE e.owner_id = $1 AND e.active`,
      [ownerId],
    );
    const docEdgeRows = await this.#storage.query<{
      from_id: string;
      to_id: string;
      weight: number;
    }>(
      `SELECT cc.document_id AS from_id, e.to_id, count(*)::int AS weight
       FROM memory_edges e
       JOIN context_chunks cc ON cc.id = e.from_id
       WHERE e.owner_id = $1 AND e.relation = 'mention' AND e.active
       GROUP BY cc.document_id, e.to_id`,
      [ownerId],
    );

    const memories: GraphMemory[] = memoryRows.map((m) => ({
      id: m.id,
      canonical: m.canonical,
      content: m.content,
      memoryType: m.memory_type,
    }));
    const entities: Entity[] = entityRows.map((e) => ({
      id: e.id,
      name: e.name,
      entityType: e.entity_type,
    }));
    const edges: GraphEdge[] = [
      ...edgeRows.map((e) => ({ from: e.from_id, to: e.to_id, relation: e.relation })),
      ...entityEdgeRows.map((e) => ({ from: e.from_id, to: e.to_id, relation: e.relation })),
      ...docEdgeRows.map((e) => ({
        from: e.from_id,
        to: e.to_id,
        relation: "mention",
        weight: Number(e.weight),
      })),
    ];
    return { memories, entities, documents, edges };
  }

  /** Pending conflicts for the owner, newest first. */
  async conflicts(ownerId: string = SENTINEL_OWNER): Promise<Conflict[]> {
    const rows = await this.#storage.query<{
      id: string;
      incoming_id: string;
      incoming_canonical: string | null;
      incoming_content: string;
      candidates: ConflictCandidate[];
      created_at: string;
    }>(
      `SELECT id, incoming_id, incoming_canonical, incoming_content, candidates, created_at
       FROM memory_dedup_decisions
       WHERE owner_id = $1 AND action = 'conflict' AND resolution_action IS NULL
       ORDER BY created_at DESC`,
      [ownerId],
    );
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      incoming: { id: r.incoming_id, canonical: r.incoming_canonical, content: r.incoming_content },
      candidates: r.candidates,
    }));
  }

  /**
   * Resolved conflicts, newest resolution first: the revertable history behind the pending
   * queue. The stored action collapses keep_new and keep_existing into 'supersede'; the
   * winner side tells them apart again.
   */
  async resolvedConflicts(ownerId: string = SENTINEL_OWNER): Promise<ResolvedConflict[]> {
    const rows = await this.#storage.query<{
      id: string;
      incoming_id: string;
      incoming_canonical: string | null;
      incoming_content: string;
      candidates: ConflictCandidate[];
      resolution_action: "supersede" | "keep_both" | "merge";
      resolution_winner_id: string | null;
      resolved_at: string;
      created_at: string;
    }>(
      `SELECT id, incoming_id, incoming_canonical, incoming_content, candidates,
              resolution_action, resolution_winner_id, resolved_at, created_at
       FROM memory_dedup_decisions
       WHERE owner_id = $1 AND action = 'conflict' AND resolution_action IS NOT NULL
       ORDER BY resolved_at DESC`,
      [ownerId],
    );
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      incoming: { id: r.incoming_id, canonical: r.incoming_canonical, content: r.incoming_content },
      candidates: r.candidates,
      resolution:
        r.resolution_action === "supersede"
          ? r.resolution_winner_id === r.incoming_id
            ? "keep_new"
            : "keep_existing"
          : r.resolution_action,
      resolvedAt: r.resolved_at,
    }));
  }

  /** Resolve a pending conflict. Every action is reversible via revertConflict. */
  async resolveConflict(conflictId: string, decision: ResolveDecision): Promise<void> {
    const [row] = await this.#storage.query<{
      owner_id: string;
      incoming_id: string;
      candidates: ConflictCandidate[];
    }>("SELECT owner_id, incoming_id, candidates FROM memory_dedup_decisions WHERE id = $1", [
      conflictId,
    ]);
    if (!row) throw new Error(`memloom: no conflict ${conflictId}`);
    const owner = row.owner_id;
    const incoming = row.incoming_id;
    const candidateIds = row.candidates.map((c) => c.id);

    switch (decision.action) {
      case "keep_new": {
        // The incoming belief continues the (primary) existing fact's lineage: a resolved
        // contradiction is a version step, so it shows up in that belief's history().
        const primary = candidateIds[0];
        if (primary) {
          const lin = await this.#lineageOf(primary);
          if (lin) await this.#reparent(incoming, lin.rootId, lin.version + 1);
        }
        await markStale(this.#storage, candidateIds);
        for (const loser of candidateIds)
          await addEdge(this.#storage, owner, incoming, loser, "replaces");
        await this.#attachResolution(conflictId, "supersede", incoming, candidateIds);
        break;
      }
      case "keep_existing": {
        const winner = decision.candidateId;
        await markStale(this.#storage, [incoming]);
        await addEdge(this.#storage, owner, winner, incoming, "replaces");
        await this.#attachResolution(conflictId, "supersede", winner, [incoming]);
        break;
      }
      case "keep_both": {
        for (const cand of candidateIds)
          await addEdge(this.#storage, owner, incoming, cand, "distinct");
        await this.#attachResolution(conflictId, "keep_both", null, []);
        break;
      }
      case "merge": {
        const [embedding] = await this.#embedding.embed([decision.content]);
        if (!embedding) throw new Error("memloom: embedding provider returned no vector");
        const hash = createHash("sha256").update(decision.content).digest("hex");
        const winner = await this.#insert(
          owner,
          {
            content: decision.content,
            ...(decision.canonical ? { canonical: decision.canonical } : {}),
          },
          embedding,
          hash,
        );
        // The merged belief continues the primary existing fact's lineage.
        const mergePrimary = candidateIds[0] ?? incoming;
        const mergeLin = await this.#lineageOf(mergePrimary);
        if (mergeLin) await this.#reparent(winner, mergeLin.rootId, mergeLin.version + 1);
        const losers = [incoming, ...candidateIds];
        await markStale(this.#storage, losers);
        for (const loser of losers) await addEdge(this.#storage, owner, winner, loser, "replaces");
        await this.#attachResolution(conflictId, "merge", winner, losers);
        break;
      }
    }
  }

  /** Undo a resolution: restore staled memories, deactivate the edges it created, re-queue it. */
  async revertConflict(conflictId: string): Promise<void> {
    const [row] = await this.#storage.query<{
      owner_id: string;
      incoming_id: string;
      candidates: ConflictCandidate[];
      resolution_action: string | null;
      resolution_winner_id: string | null;
      resolution_loser_ids: string[] | null;
    }>(
      `SELECT owner_id, incoming_id, candidates, resolution_action, resolution_winner_id, resolution_loser_ids
       FROM memory_dedup_decisions WHERE id = $1`,
      [conflictId],
    );
    if (!row) throw new Error(`memloom: no conflict ${conflictId}`);
    if (!row.resolution_action) return; // already pending

    const owner = row.owner_id;
    const candidateIds = row.candidates.map((c) => c.id);
    const losers = row.resolution_loser_ids ?? [];

    switch (row.resolution_action) {
      case "supersede": {
        await reactivate(this.#storage, losers);
        await deactivateEdgesTouching(this.#storage, owner, "replaces", losers);
        // keep_new re-parented the incoming onto the losers' lineage; restore it to its own root.
        if (row.resolution_winner_id === row.incoming_id) {
          await this.#reparent(row.incoming_id, row.incoming_id, 1);
        }
        break;
      }
      case "keep_both": {
        await deactivateEdgesTouching(this.#storage, owner, "distinct", [
          row.incoming_id,
          ...candidateIds,
        ]);
        break;
      }
      case "merge": {
        await reactivate(this.#storage, [row.incoming_id, ...candidateIds]);
        if (row.resolution_winner_id) {
          await markStale(this.#storage, [row.resolution_winner_id]);
          await deactivateEdgesTouching(this.#storage, owner, "replaces", [
            row.resolution_winner_id,
          ]);
        }
        break;
      }
    }

    await this.#storage.query(
      `UPDATE memory_dedup_decisions
       SET resolution_action = NULL, resolution_winner_id = NULL,
           resolution_loser_ids = NULL, resolved_at = NULL
       WHERE id = $1`,
      [conflictId],
    );
  }

  /**
   * Second-pass conflict resolution: re-judge every pending conflict WITH the context the
   * dedup classifier never saw, the recording times and the transcript excerpts provenance
   * kept. Decisive verdicts are applied through resolveConflict, so an auto-resolution lands
   * in the same revertable history as a human one; "unsure" stays in the queue.
   */
  async autoResolveConflicts(
    ownerId: string = SENTINEL_OWNER,
    onProgress?: (event: ConflictAutoEvent) => void,
  ): Promise<ConflictAutoResult> {
    if (this.#llm instanceof NullLLMProvider) {
      throw new Error(
        "memloom: conflict auto-resolution judges with an LLM and none is configured. " +
          "Set OPENROUTER_API_KEY in your memloom config and restart the daemon.",
      );
    }
    const pending = await this.conflicts(ownerId);
    const result: ConflictAutoResult = {
      examined: 0,
      resolved: 0,
      keepNew: 0,
      keepExisting: 0,
      keepBoth: 0,
      unsure: 0,
    };
    for (const [i, conflict] of pending.entries()) {
      const ids = [conflict.incoming.id, ...conflict.candidates.map((c) => c.id)];
      const { createdOf, excerptOf } = await this.#conflictContext(ids);
      const sideOf = (id: string, content: string): ResolverSide => ({
        content,
        createdAt: createdOf.get(id) ?? null,
        excerpt: excerptOf.get(id) ?? null,
      });

      const verdict = await resolveConflictWithContext(
        this.#llm,
        sideOf(conflict.incoming.id, conflict.incoming.content),
        conflict.candidates.map((c) => ({ ...sideOf(c.id, c.content), relation: c })),
      );
      result.examined++;

      if (verdict.verdict === "keep_new") {
        await this.resolveConflict(conflict.id, { action: "keep_new" });
        result.keepNew++;
        result.resolved++;
      } else if (verdict.verdict === "keep_existing") {
        const winner = conflict.candidates[verdict.candidateIndex] ?? conflict.candidates[0];
        if (winner) {
          await this.resolveConflict(conflict.id, {
            action: "keep_existing",
            candidateId: winner.id,
          });
          result.keepExisting++;
          result.resolved++;
        } else {
          result.unsure++;
        }
      } else if (verdict.verdict === "keep_both") {
        await this.resolveConflict(conflict.id, { action: "keep_both" });
        result.keepBoth++;
        result.resolved++;
      } else {
        result.unsure++;
      }

      onProgress?.({
        conflictId: conflict.id,
        index: i + 1,
        total: pending.length,
        verdict: verdict.verdict,
        reason: verdict.reason,
        content: conflict.incoming.content.slice(0, 100),
      });
    }
    return result;
  }

  /** Recording times and provenance excerpts for a set of memory ids: the resolver's evidence. */
  async #conflictContext(
    ids: string[],
  ): Promise<{ createdOf: Map<string, string>; excerptOf: Map<string, string> }> {
    const marks = ids.map((_, j) => `$${j + 1}`).join(", ");
    const rows = await this.#storage.query<{ id: string; created_at: string }>(
      `SELECT id, created_at FROM memory_objects WHERE id IN (${marks})`,
      ids,
    );
    const prov = await this.#storage.query<{ memory_id: string; excerpt: string }>(
      `SELECT memory_id, excerpt FROM import_provenance WHERE memory_id IN (${marks})`,
      ids,
    );
    return {
      createdOf: new Map(rows.map((r) => [r.id, String(r.created_at)])),
      excerptOf: new Map(prov.map((p) => [p.memory_id, p.excerpt])),
    };
  }

  // A save-time verdict on a just-recorded conflict, using the incoming excerpt the import
  // provided and the stored context of the contradicted memories. Null = leave it pending.
  async #judgeConflictNow(
    input: SaveInput,
    candidates: ConflictCandidate[],
  ): Promise<{
    resolve: ResolveDecision;
    name: "keep_new" | "keep_existing" | "keep_both";
  } | null> {
    const { createdOf, excerptOf } = await this.#conflictContext(candidates.map((c) => c.id));
    const verdict = await resolveConflictWithContext(
      this.#llm,
      {
        content: input.content,
        createdAt: new Date().toISOString(),
        excerpt: input.context?.excerpt ?? null,
      },
      candidates.map((c) => ({
        content: c.content,
        createdAt: createdOf.get(c.id) ?? null,
        excerpt: excerptOf.get(c.id) ?? null,
        relation: c,
      })),
    );
    if (verdict.verdict === "keep_new") {
      return { resolve: { action: "keep_new" }, name: "keep_new" };
    }
    if (verdict.verdict === "keep_both") {
      return { resolve: { action: "keep_both" }, name: "keep_both" };
    }
    if (verdict.verdict === "keep_existing") {
      const winner = candidates[verdict.candidateIndex] ?? candidates[0];
      if (winner) {
        return {
          resolve: { action: "keep_existing", candidateId: winner.id },
          name: "keep_existing",
        };
      }
    }
    return null;
  }

  // --- internals ---

  // Insert a memory. Without `lineage` it starts a new belief (root_id = its own id, version 1);
  // with `lineage` it's the next version of an existing belief. The id is generated app-side so
  // a new root can set root_id = id atomically.
  async #insert(
    owner: string,
    input: { content: string; canonical?: string; memoryType?: MemoryType },
    embedding: number[],
    hash: string,
    lineage?: { rootId: string; version: number },
  ): Promise<string> {
    const id = randomUUID();
    const rootId = lineage?.rootId ?? id;
    const version = lineage?.version ?? 1;
    const rows = await this.#storage.query<{ id: string }>(
      `INSERT INTO memory_objects
         (id, owner_id, root_id, version, memory_type, canonical, content, content_hash, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector)
       RETURNING id`,
      [
        id,
        owner,
        rootId,
        version,
        input.memoryType ?? "fact",
        input.canonical ?? null,
        input.content,
        hash,
        toVectorLiteral(embedding),
      ],
    );
    const rid = rows[0]?.id;
    if (!rid) throw new Error("memloom: insert returned no id");
    return rid;
  }

  // Append a new version to a belief: stale the parent, insert the child sharing the parent's
  // root with version + 1, and link them child -> parent with a 'replaces' edge. Returns the
  // new current version's id.
  async #versionOf(
    owner: string,
    parent: { id: string; rootId: string; version: number },
    input: { content: string; canonical?: string; memoryType?: MemoryType },
    embedding: number[],
    hash: string,
  ): Promise<string> {
    const childId = await this.#insert(owner, input, embedding, hash, {
      rootId: parent.rootId,
      version: parent.version + 1,
    });
    await markStale(this.#storage, [parent.id]);
    await addEdge(this.#storage, owner, childId, parent.id, "replaces");
    return childId;
  }

  // Move a memory onto a lineage (used when a resolved conflict continues an existing belief).
  async #reparent(id: string, rootId: string, version: number): Promise<void> {
    await this.#storage.query(
      "UPDATE memory_objects SET root_id = $2, version = $3, updated_at = now() WHERE id = $1",
      [id, rootId, version],
    );
  }

  // The current root_id + version of a memory, or null if it's gone.
  async #lineageOf(id: string): Promise<{ rootId: string; version: number } | null> {
    const [row] = await this.#storage.query<{ root_id: string; version: number }>(
      "SELECT root_id, version FROM memory_objects WHERE id = $1",
      [id],
    );
    return row ? { rootId: row.root_id, version: Number(row.version) } : null;
  }

  // Extract the graph from one source (memory or context chunk): mention edges to each
  // surviving entity, plus typed entity-to-entity edges for the relationships the text
  // states (out-of-vocab and under-confident ones arrive already quarantined as 'mention'
  // by parseExtraction). The edge table has no FKs, so all node kinds share it. Returns
  // what the index progress stream reports.
  /**
   * The read + LLM half of indexing one item: safe to run concurrently across items
   * (nothing is written). Fetched per item (one cheap query next to one expensive LLM
   * call) so an item's extraction sees the canonical spellings every COMPLETED item
   * created; items in flight at the same moment do not see each other, the price of
   * running extractions in parallel.
   */
  async #extractForGraph(
    owner: string,
    content: string,
    schema: ActiveSchema,
    context?: ExtractionContext,
  ): Promise<Awaited<ReturnType<typeof extractGraph>>> {
    const known = await this.#storage.query<{ name: string }>(
      `SELECT me.name
       FROM memory_entities me
       LEFT JOIN memory_edges e ON e.to_id = me.id AND e.relation = 'mention' AND e.active
       WHERE me.owner_id = $1
       GROUP BY me.id, me.name
       ORDER BY count(e.id) DESC, me.created_at
       LIMIT 75`,
      [owner],
    );
    return extractGraph(
      this.#llm,
      content,
      { ...context, knownEntities: known.map((r) => r.name) },
      schema,
    );
  }

  /**
   * The write half: entity resolution and edges. MUST run on the index run's serialized
   * write queue; #resolveEntity is read-check-insert and duplicates entities if raced.
   */
  async #writeGraph(
    owner: string,
    sourceId: string,
    extraction: Awaited<ReturnType<typeof extractGraph>>,
  ): Promise<{ entities: string[]; newEntities: number; relationships: number }> {
    const idByName = new Map<string, string>();
    // `entities` is every name this source mentions (the per-item console line);
    // `newEntities` counts only rows that did not exist before, so run totals reconcile
    // with the entity table instead of re-counting every resolve as a creation.
    let newEntities = 0;
    for (const entity of extraction.entities) {
      const resolved = await this.#resolveEntity(owner, entity.name, entity.type);
      if (resolved.created) newEntities += 1;
      idByName.set(entity.name.toLowerCase(), resolved.id);
      await addEdge(this.#storage, owner, sourceId, resolved.id, "mention");
    }
    let stored = 0;
    for (const rel of extraction.relationships) {
      const fromId = idByName.get(rel.subject.toLowerCase());
      const toId = idByName.get(rel.object.toLowerCase());
      if (!fromId || !toId) continue; // parser guarantees this; stay defensive
      const created = await addEdgeIfAbsent(this.#storage, owner, fromId, toId, rel.predicate, {
        confidence: rel.confidence,
        sourceId,
      });
      if (created) stored += 1;
    }
    // Vocabulary the model wanted but the schema lacks: accumulate occurrences; the
    // review queue surfaces a name once enough independent extractions ask for it. The
    // motivating occurrences are saved with it (stamped with this source), so approval can
    // link them without a re-index.
    for (const proposal of extraction.proposals) {
      await this.#recordProposal(owner, proposal.kind, proposal.name, proposal.examples, sourceId);
    }
    return { entities: extraction.entities.map((e) => e.name), newEntities, relationships: stored };
  }

  // --- schema registry ---

  // Seed the system tier for this owner (idempotent). Lazy, so new owners and upgraded
  // engines converge without data migrations; user rows and proposals are never touched.
  async #ensureSchemaSeed(owner: string): Promise<void> {
    for (const t of ENTITY_TYPES) {
      await this.#storage.query(
        `INSERT INTO memory_schema (owner_id, kind, name, description, tier, status)
         VALUES ($1, 'entity_type', $2, $3, 'system', 'active')
         ON CONFLICT (owner_id, kind, name) DO NOTHING`,
        [owner, t.name, t.description],
      );
    }
    for (const p of PREDICATES) {
      await this.#storage.query(
        `INSERT INTO memory_schema (owner_id, kind, name, description, tier, status)
         VALUES ($1, 'predicate', $2, $3, 'system', 'active')
         ON CONFLICT (owner_id, kind, name) DO NOTHING`,
        [owner, p.name, p.description],
      );
    }
  }

  // The vocabulary an extraction run works against: active system + user rows, plus the
  // dismissed names the prompt must never re-propose.
  async #activeSchema(owner: string): Promise<ActiveSchema> {
    await this.#ensureSchemaSeed(owner);
    const rows = await this.#storage.query<{
      kind: SchemaKind;
      name: string;
      description: string;
      status: string;
      tier: string;
    }>(
      `SELECT kind, name, description, status, tier FROM memory_schema
       WHERE owner_id = $1 ORDER BY created_at`,
      [owner],
    );
    const active = rows.filter((r) => r.status === "active" && r.tier !== "proposed");
    return {
      entityTypes: active
        .filter((r) => r.kind === "entity_type")
        .map((r) => ({ name: r.name, description: r.description })),
      predicates: active
        .filter((r) => r.kind === "predicate")
        .map((r) => ({ name: r.name, description: r.description })),
      dismissed: rows.filter((r) => r.status === "dismissed").map((r) => r.name),
    };
  }

  // Examples kept per proposal; enough evidence to judge and materialize, bounded so a
  // hot name can't grow a row without limit.
  static readonly #MAX_PROPOSAL_EXAMPLES = 20;

  async #recordProposal(
    owner: string,
    kind: SchemaKind,
    name: string,
    examples: ProposalExample[] = [],
    sourceId?: string,
  ): Promise<void> {
    // Merge the new occurrences into what earlier runs saved: dedupe by entity name-key
    // (or endpoint pair), first sighting wins, capped. Read-then-upsert is fine here: the
    // embedded store is single-process and index runs are single-flight.
    const [existing] = await this.#storage.query<{ examples: ProposalExample[] | string }>(
      `SELECT examples FROM memory_schema
       WHERE owner_id = $1 AND kind = $2 AND name = $3
         AND tier = 'proposed' AND status = 'active'`,
      [owner, kind, name],
    );
    const parse = (v: ProposalExample[] | string | undefined): ProposalExample[] =>
      Array.isArray(v) ? v : typeof v === "string" ? JSON.parse(v) : [];
    const merged = parse(existing?.examples);
    const keyOf = (e: ProposalExample) =>
      e.entity ? entityNameKey(e.entity) : `${e.from?.toLowerCase()}|${e.to?.toLowerCase()}`;
    const seen = new Set(merged.map(keyOf));
    for (const example of examples) {
      if (merged.length >= Memloom.#MAX_PROPOSAL_EXAMPLES) break;
      const key = keyOf(example);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...example, ...(sourceId ? { sourceId } : {}) });
    }
    // Dismissed and existing names never re-enter the queue (the unique index holds the
    // line; occurrences only grow while the row stays a proposal).
    await this.#storage.query(
      `INSERT INTO memory_schema (owner_id, kind, name, tier, status, occurrences, examples)
       VALUES ($1, $2, $3, 'proposed', 'active', 1, $4)
       ON CONFLICT (owner_id, kind, name)
       DO UPDATE SET occurrences = memory_schema.occurrences + 1, examples = EXCLUDED.examples
         WHERE memory_schema.tier = 'proposed' AND memory_schema.status = 'active'`,
      [owner, kind, name, JSON.stringify(merged)],
    );
  }

  /** Add a user-tier vocabulary entry. Name is normalized to snake_case. */
  async addSchemaEntry(
    kind: SchemaKind,
    name: string,
    description: string,
    ownerId: string = SENTINEL_OWNER,
  ): Promise<SchemaEntry> {
    await this.#ensureSchemaSeed(ownerId);
    const normalized = normalizeSchemaName(name);
    if (!normalized) throw new Error("memloom: schema entry needs a usable name");
    const [row] = await this.#storage.query<SchemaEntry>(
      `INSERT INTO memory_schema (owner_id, kind, name, description, tier, status)
       VALUES ($1, $2, $3, $4, 'user', 'active')
       ON CONFLICT (owner_id, kind, name)
       DO UPDATE SET description = EXCLUDED.description, tier = 'user', status = 'active'
       RETURNING id, kind, name, description, tier, status, occurrences`,
      [ownerId, kind, normalized, description],
    );
    if (!row) throw new Error("memloom: failed to add schema entry");
    return row;
  }

  /**
   * Promote a proposal to the user tier AND materialize its saved occurrences: held-out
   * entities enter the graph with mention edges from their original sources, quarantined
   * relationships get their typed edge. No re-index needed; a second extraction run is not
   * deterministic and might never re-find what the first one saw.
   */
  async approveProposal(
    id: string,
    ownerId: string = SENTINEL_OWNER,
  ): Promise<{ entitiesLinked: number; edgesLinked: number }> {
    const [row] = await this.#storage.query<{
      kind: SchemaKind;
      name: string;
      examples: ProposalExample[] | string;
    }>(
      `UPDATE memory_schema SET tier = 'user', status = 'active'
       WHERE id = $1 AND owner_id = $2 AND tier = 'proposed'
       RETURNING kind, name, examples`,
      [id, ownerId],
    );
    if (!row) throw new Error(`memloom: no pending proposal ${id}`);
    const examples: ProposalExample[] = Array.isArray(row.examples)
      ? row.examples
      : typeof row.examples === "string"
        ? JSON.parse(row.examples)
        : [];

    let entitiesLinked = 0;
    let edgesLinked = 0;
    // A saved source may have been deleted or versioned away since; link only what still
    // stands (an entity without a live mention would be an orphan node in the graph).
    const sourceAlive = async (sourceId: string | undefined): Promise<boolean> => {
      if (!sourceId) return false;
      const rows = await this.#storage.query<{ ok: number }>(
        `SELECT 1 AS ok FROM memory_objects WHERE id = $1 AND status = 'active'
         UNION ALL
         SELECT 1 AS ok FROM context_chunks WHERE id = $1`,
        [sourceId],
      );
      return rows.length > 0;
    };

    for (const example of examples) {
      if (row.kind === "entity_type" && example.entity) {
        if (!(await sourceAlive(example.sourceId))) continue;
        const resolved = await this.#resolveEntity(ownerId, example.entity, row.name);
        await addEdgeIfAbsent(
          this.#storage,
          ownerId,
          example.sourceId as string,
          resolved.id,
          "mention",
        );
        entitiesLinked += 1;
      } else if (row.kind === "predicate" && example.from && example.to) {
        // Endpoints had known types, so they exist as entities iff that extraction stored
        // them; look them up by name-key and never create them here.
        const fromId = await this.#findEntityId(ownerId, example.from);
        const toId = await this.#findEntityId(ownerId, example.to);
        if (!fromId || !toId) continue;
        await addEdgeIfAbsent(this.#storage, ownerId, fromId, toId, row.name, {
          ...(example.confidence !== undefined ? { confidence: example.confidence } : {}),
          ...(example.sourceId ? { sourceId: example.sourceId } : {}),
        });
        edgesLinked += 1;
      }
    }
    return { entitiesLinked, edgesLinked };
  }

  /** Reject a proposal: the name is blocklisted from re-proposal in the prompt. */
  async dismissProposal(id: string, ownerId: string = SENTINEL_OWNER): Promise<void> {
    const updated = await this.#storage.query<{ id: string }>(
      `UPDATE memory_schema SET status = 'dismissed'
       WHERE id = $1 AND owner_id = $2 AND tier = 'proposed' RETURNING id`,
      [id, ownerId],
    );
    if (updated.length === 0) throw new Error(`memloom: no pending proposal ${id}`);
  }

  /** Enable or disable a vocabulary entry (system or user tier). */
  async setSchemaStatus(
    id: string,
    status: "active" | "disabled",
    ownerId: string = SENTINEL_OWNER,
  ): Promise<void> {
    const updated = await this.#storage.query<{ id: string }>(
      `UPDATE memory_schema SET status = $3
       WHERE id = $1 AND owner_id = $2 AND tier <> 'proposed' RETURNING id`,
      [id, ownerId, status],
    );
    if (updated.length === 0) throw new Error(`memloom: no schema entry ${id}`);
  }

  /**
   * Permanently remove a DISABLED user-tier vocabulary entry. Deliberately narrow:
   * system rows are re-seeded by name as ACTIVE on the next run, so deleting one would
   * silently re-enable it: disable is their only off-switch. Proposals have their own
   * lifecycle (approve/dismiss). Entities already extracted under the deleted type stay
   * in the graph, exactly as they do for a disabled type.
   */
  async deleteSchemaEntry(id: string, ownerId: string = SENTINEL_OWNER): Promise<void> {
    const deleted = await this.#storage.query<{ id: string }>(
      `DELETE FROM memory_schema
       WHERE id = $1 AND owner_id = $2 AND tier = 'user' AND status = 'disabled'
       RETURNING id`,
      [id, ownerId],
    );
    if (deleted.length > 0) return;
    const [row] = await this.#storage.query<{ tier: string; status: string }>(
      "SELECT tier, status FROM memory_schema WHERE id = $1 AND owner_id = $2",
      [id, ownerId],
    );
    if (!row) throw new Error(`memloom: no schema entry ${id}`);
    if (row.tier === "system") {
      throw new Error("memloom: system entries cannot be deleted; disable instead");
    }
    if (row.tier === "proposed") {
      throw new Error("memloom: proposals are approved or dismissed, not deleted");
    }
    throw new Error("memloom: only disabled entries can be deleted; disable it first");
  }

  async #resolveEntity(
    owner: string,
    name: string,
    type: string,
  ): Promise<{ id: string; created: boolean }> {
    // Identity is the NAME KEY alone (see entityNameKey): the type is an attribute, not
    // part of the key. The extractor classifies inconsistently across chunks ("@memloom/core"
    // as technology here, project there); forking a node per type is never what a personal
    // graph wants, and the rare true homonym merges into one node: a smaller failure than
    // duplicates everywhere. First classification wins; oldest row wins over pre-fix dupes.
    // The SQL expression mirrors entityNameKey: trim, casefold, strip leading @, collapse ws.
    const existing = await this.#storage.query<{ id: string }>(
      `SELECT id FROM memory_entities
       WHERE owner_id = $1
         AND regexp_replace(regexp_replace(btrim(lower(name)), '^@', ''), '\\s+', ' ', 'g') = $2
       ORDER BY created_at LIMIT 1`,
      [owner, entityNameKey(name)],
    );
    if (existing[0]) return { id: existing[0].id, created: false };
    const [embedding] = await this.#embedding.embed([name]);
    if (!embedding) throw new Error("memloom: embedding provider returned no vector");
    const [row] = await this.#storage.query<{ id: string }>(
      `INSERT INTO memory_entities (owner_id, name, entity_type, embedding)
       VALUES ($1, $2, $3, $4::vector) RETURNING id`,
      [owner, name, type, toVectorLiteral(embedding)],
    );
    if (!row) throw new Error("memloom: failed to insert entity");
    return { id: row.id, created: true };
  }

  /** #resolveEntity's lookup half: find by name key, never create. */
  async #findEntityId(owner: string, name: string): Promise<string | null> {
    const [row] = await this.#storage.query<{ id: string }>(
      `SELECT id FROM memory_entities
       WHERE owner_id = $1
         AND regexp_replace(regexp_replace(btrim(lower(name)), '^@', ''), '\\s+', ' ', 'g') = $2
       ORDER BY created_at LIMIT 1`,
      [owner, entityNameKey(name)],
    );
    return row?.id ?? null;
  }

  // --- entity management (the schema tab's instances list) ---

  /** Every entity with usage counts, most-mentioned first. */
  async listEntities(ownerId: string = SENTINEL_OWNER): Promise<EntityDetail[]> {
    const rows = await this.#storage.query<{
      id: string;
      name: string;
      entity_type: string;
      mentions: number;
      memories: number;
      documents: number;
    }>(
      `SELECT me.id, me.name, me.entity_type,
              count(e.id)::int AS mentions,
              count(DISTINCT mo.id)::int AS memories,
              count(DISTINCT cc.document_id)::int AS documents
       FROM memory_entities me
       LEFT JOIN memory_edges e
         ON e.to_id = me.id AND e.relation = 'mention' AND e.active AND e.owner_id = me.owner_id
       LEFT JOIN memory_objects mo ON mo.id = e.from_id AND mo.status = 'active'
       LEFT JOIN context_chunks cc ON cc.id = e.from_id
       WHERE me.owner_id = $1
       GROUP BY me.id, me.name, me.entity_type
       ORDER BY count(e.id) DESC, lower(me.name)`,
      [ownerId],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      entityType: r.entity_type,
      mentions: Number(r.mentions),
      memories: Number(r.memories),
      documents: Number(r.documents),
    }));
  }

  /**
   * Rename and/or retype one entity. A rename re-embeds (the vector must follow the
   * name) and refuses a name-key collision with another entity: that situation is a
   * merge, not a rename. A retype must name an active vocabulary type.
   */
  async updateEntity(
    id: string,
    patch: { name?: string; entityType?: string },
    ownerId: string = SENTINEL_OWNER,
  ): Promise<void> {
    const [row] = await this.#storage.query<{ id: string }>(
      "SELECT id FROM memory_entities WHERE id = $1 AND owner_id = $2",
      [id, ownerId],
    );
    if (!row) throw new Error(`memloom: no entity ${id}`);

    if (patch.entityType !== undefined) {
      const schema = await this.#activeSchema(ownerId);
      if (!schema.entityTypes.some((t) => t.name === patch.entityType)) {
        throw new Error(`memloom: "${patch.entityType}" is not an active entity type`);
      }
      await this.#storage.query(
        "UPDATE memory_entities SET entity_type = $3 WHERE id = $1 AND owner_id = $2",
        [id, ownerId, patch.entityType],
      );
    }

    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new Error("memloom: entity name must be non-empty");
      const clash = await this.#storage.query<{ id: string }>(
        `SELECT id FROM memory_entities
         WHERE owner_id = $1 AND id <> $2
           AND regexp_replace(regexp_replace(btrim(lower(name)), '^@', ''), '\\s+', ' ', 'g') = $3
         LIMIT 1`,
        [ownerId, id, entityNameKey(name)],
      );
      if (clash[0]) {
        throw new Error(`memloom: an entity named "${name}" already exists. Merge instead`);
      }
      const [embedding] = await this.#embedding.embed([name]);
      if (!embedding) throw new Error("memloom: embedding provider returned no vector");
      await this.#storage.query(
        "UPDATE memory_entities SET name = $3, embedding = $4::vector WHERE id = $1 AND owner_id = $2",
        [id, ownerId, name, toVectorLiteral(embedding)],
      );
    }
  }

  /**
   * Merge one entity into another: every edge touching the source is repointed to the
   * target (would-be duplicates and would-be self-loops are dropped first), then the
   * source row is deleted. The target's name and type win.
   */
  async mergeEntities(
    sourceId: string,
    targetId: string,
    ownerId: string = SENTINEL_OWNER,
  ): Promise<void> {
    if (sourceId === targetId) throw new Error("memloom: cannot merge an entity into itself");
    await this.#storage.tx(async (tx) => {
      for (const eid of [sourceId, targetId]) {
        const [row] = await tx.query<{ id: string }>(
          "SELECT id FROM memory_entities WHERE id = $1 AND owner_id = $2",
          [eid, ownerId],
        );
        if (!row) throw new Error(`memloom: no entity ${eid}`);
      }
      // Edges between the two would become self-loops after repointing.
      await tx.query(
        `DELETE FROM memory_edges
         WHERE owner_id = $1
           AND ((from_id = $2 AND to_id = $3) OR (from_id = $3 AND to_id = $2))`,
        [ownerId, sourceId, targetId],
      );
      // Source edges that already exist against the target would become duplicates.
      await tx.query(
        `DELETE FROM memory_edges e
         WHERE e.owner_id = $1 AND e.to_id = $2
           AND EXISTS (
             SELECT 1 FROM memory_edges t
             WHERE t.owner_id = $1 AND t.to_id = $3
               AND t.from_id = e.from_id AND t.relation = e.relation)`,
        [ownerId, sourceId, targetId],
      );
      await tx.query(
        `DELETE FROM memory_edges e
         WHERE e.owner_id = $1 AND e.from_id = $2
           AND EXISTS (
             SELECT 1 FROM memory_edges t
             WHERE t.owner_id = $1 AND t.from_id = $3
               AND t.to_id = e.to_id AND t.relation = e.relation)`,
        [ownerId, sourceId, targetId],
      );
      await tx.query("UPDATE memory_edges SET to_id = $3 WHERE owner_id = $1 AND to_id = $2", [
        ownerId,
        sourceId,
        targetId,
      ]);
      await tx.query("UPDATE memory_edges SET from_id = $3 WHERE owner_id = $1 AND from_id = $2", [
        ownerId,
        sourceId,
        targetId,
      ]);
      await tx.query("DELETE FROM memory_entities WHERE id = $1 AND owner_id = $2", [
        sourceId,
        ownerId,
      ]);
    });
  }

  /** Delete one entity and every edge touching it (no FK cascade on the shared edge table). */
  async deleteEntity(id: string, ownerId: string = SENTINEL_OWNER): Promise<void> {
    await this.#storage.tx(async (tx) => {
      await this.#deleteEntityEdges(tx, ownerId, id);
      const deleted = await tx.query<{ id: string }>(
        "DELETE FROM memory_entities WHERE id = $1 AND owner_id = $2 RETURNING id",
        [id, ownerId],
      );
      if (deleted.length === 0) throw new Error(`memloom: no entity ${id}`);
    });
  }

  // Entities appear on both edge ends (mentions point at them, typed predicates run
  // between them), so cleanup must sweep both: the same manual story as document chunks.
  async #deleteEntityEdges(tx: StorageAdapter, owner: string, entityId: string): Promise<void> {
    await tx.query(
      "DELETE FROM memory_edges WHERE owner_id = $1 AND (from_id = $2 OR to_id = $2)",
      [owner, entityId],
    );
  }

  async #findCandidates(owner: string, embedding: number[], hash: string): Promise<CandidateRow[]> {
    const rows = await this.#storage.query<{
      id: string;
      canonical: string | null;
      content: string;
      root_id: string;
      version: number;
      similarity: number;
    }>(
      `SELECT id, canonical, content, root_id, version, 1 - (embedding <=> $1::vector) AS similarity
       FROM memory_objects
       WHERE owner_id = $2 AND status = 'active' AND embedding IS NOT NULL AND content_hash <> $3
       ORDER BY embedding <=> $1::vector
       LIMIT $4`,
      [toVectorLiteral(embedding), owner, hash, CANDIDATE_LIMIT],
    );
    return rows
      .map((r) => ({
        id: r.id,
        canonical: r.canonical,
        content: r.content,
        rootId: r.root_id,
        version: Number(r.version),
        similarity: Number(r.similarity),
      }))
      .filter((r) => r.similarity >= CANDIDATE_THRESHOLD);
  }

  async #recordConflict(
    owner: string,
    incomingId: string,
    input: SaveInput,
    candidates: ConflictCandidate[],
  ): Promise<string> {
    const [row] = await this.#storage.query<{ id: string }>(
      `INSERT INTO memory_dedup_decisions
         (owner_id, action, incoming_id, incoming_canonical, incoming_content, candidates)
       VALUES ($1, 'conflict', $2, $3, $4, $5::jsonb)
       RETURNING id`,
      [owner, incomingId, input.canonical ?? null, input.content, JSON.stringify(candidates)],
    );
    if (!row) throw new Error("memloom: failed to record conflict");
    return row.id;
  }

  async #attachResolution(
    conflictId: string,
    action: "supersede" | "keep_both" | "merge",
    winnerId: string | null,
    loserIds: string[],
  ): Promise<void> {
    await this.#storage.query(
      `UPDATE memory_dedup_decisions
       SET resolution_action = $2, resolution_winner_id = $3,
           resolution_loser_ids = $4::jsonb, resolved_at = now()
       WHERE id = $1`,
      [conflictId, action, winnerId, JSON.stringify(loserIds)],
    );
  }
}
