import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

// Claude Code session discovery + parsing for `memloom import sessions`. Sessions live as
// JSONL transcripts under ~/.claude/projects/<encoded-project>/<session-uuid>.jsonl. Only
// main-session files count: agent-*.jsonl sidecars are subagent transcripts whose content is
// a near-copy of fragments of the parent session, so distilling them pays twice and floods
// dedup with near-duplicates. Compaction-summary lines inside a session are skipped for the
// same reason. Everything here is filesystem-and-parsing only; no LLM, no store.

/** Main sessions are named by their UUID; anything else (agent-*.jsonl, sidecars) is skipped. */
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/** A file modified this recently is an active session still being written; skip until quiet. */
export const QUIET_MS = 5 * 60 * 1000;

export function claudeProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

export interface DiscoveredSession {
  path: string;
  /** The encoded project directory name, e.g. "D--Kostek-Projects-memloom". */
  project: string;
  mtimeMs: number;
}

export interface DiscoverySkips {
  /** Non-session JSONL files (subagent transcripts, sidecars). */
  sidecars: number;
  /** Sessions still being written (modified within QUIET_MS). */
  active: number;
  /** Sessions older than the day window. */
  outsideWindow: number;
  /** Sessions inside the window but beyond the session cap. */
  overCap: number;
}

export interface DiscoveryOptions {
  /** Override ~/.claude/projects (tests, unusual layouts). */
  root?: string;
  /** Sessions modified in the last N days. Default 14. */
  days?: number;
  /** Newest-first cap after the day window. Default 20. */
  maxSessions?: number;
  /** Case-insensitive substring match on the project directory name. */
  project?: string;
  /** Allowlist form: a project directory matches when ANY entry matches. */
  projects?: string[];
  /** Injectable clock (tests). */
  now?: number;
}

export interface DiscoveryResult {
  sessions: DiscoveredSession[];
  skipped: DiscoverySkips;
}

// Both bounds apply: sessions modified in the last `days`, newest first, stopping at
// `maxSessions`. Announced by the caller; no silent caps.
export async function discoverSessions(opts: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const root = opts.root ?? claudeProjectsDir();
  const days = opts.days ?? 14;
  const maxSessions = opts.maxSessions ?? 20;
  const now = opts.now ?? Date.now();
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const filters = [opts.project, ...(opts.projects ?? [])]
    .filter((f): f is string => Boolean(f))
    .map((f) => f.toLowerCase());

  const skipped: DiscoverySkips = { sidecars: 0, active: 0, outsideWindow: 0, overCap: 0 };
  const inWindow: DiscoveredSession[] = [];

  const projectDirs = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    if (filters.length > 0 && !filters.some((f) => dir.name.toLowerCase().includes(f))) continue;
    const dirPath = join(root, dir.name);
    const files = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      if (!SESSION_FILE.test(file.name)) {
        skipped.sidecars++;
        continue;
      }
      const info = await stat(join(dirPath, file.name)).catch(() => null);
      if (!info) continue;
      if (info.mtimeMs < cutoff) {
        skipped.outsideWindow++;
        continue;
      }
      if (now - info.mtimeMs < QUIET_MS) {
        skipped.active++;
        continue;
      }
      inWindow.push({ path: join(dirPath, file.name), project: dir.name, mtimeMs: info.mtimeMs });
    }
  }

  inWindow.sort((a, b) => b.mtimeMs - a.mtimeMs);
  skipped.overCap = Math.max(0, inWindow.length - maxSessions);
  return { sessions: inWindow.slice(0, maxSessions), skipped };
}

// ---- Parsing ----------------------------------------------------------------------------

/** One conversational unit: a text block from a user or assistant turn, with its JSONL line. */
export interface SessionUnit {
  /** 1-based line number in the JSONL file: the provenance pointer. */
  line: number;
  role: "user" | "assistant";
  text: string;
}

export interface ParsedSession {
  /** The session's own id from its lines; falls back to the filename UUID. */
  sessionId: string;
  units: SessionUnit[];
  /** Lines in the file, so the ledger watermark knows where "processed" ends. */
  lineCount: number;
  /** sha256 hex of the raw processed lines; rewrite detection for the ledger. */
  prefixHash: string;
  /** Lines that were not valid JSON; skipped, never fatal. */
  malformed: number;
}

interface RawContentBlock {
  type?: string;
  text?: string;
}

interface RawLine {
  type?: string;
  sessionId?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  message?: {
    role?: string;
    content?: string | RawContentBlock[];
  };
}

// Text blocks only, deliberately. Decisions and their rationale live in the human and
// assistant prose; tool_use inputs and tool_result bodies are bulky, secret-dense, and
// summarized by the assistant's own next message anyway.
function unitText(message: NonNullable<RawLine["message"]>): string {
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => (block.text as string).trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Stream-parse a session transcript. `fromLine` resumes after a ledger watermark (1-based,
 * exclusive: pass the last processed line). The prefix hash always covers line 1 through the
 * end of the file as read, so the caller can both verify the old watermark's prefix and store
 * the new one.
 */
export async function parseSession(path: string, fromLine = 0): Promise<ParsedSession> {
  const units: SessionUnit[] = [];
  const hash = createHash("sha256");
  let sessionId = "";
  let line = 0;
  let malformed = 0;

  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const raw of rl) {
    line++;
    hash.update(raw);
    hash.update("\n");
    if (line <= fromLine) continue;
    if (!raw.trim()) continue;
    let parsed: RawLine;
    try {
      parsed = JSON.parse(raw) as RawLine;
    } catch {
      malformed++;
      continue;
    }
    if (!sessionId && typeof parsed.sessionId === "string") sessionId = parsed.sessionId;
    // Summaries duplicate content that also appears in full; sidechains are subagent turns
    // mirrored into the parent file; meta lines are harness bookkeeping.
    if (parsed.type !== "user" && parsed.type !== "assistant") continue;
    if (parsed.isSidechain || parsed.isMeta || !parsed.message) continue;
    const role = parsed.message.role === "assistant" ? "assistant" : "user";
    const text = unitText(parsed.message);
    // Slash-command noise (<command-name>, <local-command-stdout>, ...) arrives as ordinary
    // user text without a meta flag; zero distillation value, so it never becomes a unit.
    if (text && !text.startsWith("<command-") && !text.startsWith("<local-command-")) {
      units.push({ line, role, text });
    }
  }

  return {
    sessionId: sessionId || basename(path, ".jsonl"),
    units,
    lineCount: line,
    prefixHash: hash.digest("hex"),
    malformed,
  };
}

/** sha256 hex of the first `lines` lines: the ledger's rewrite check on a later run. */
export async function hashPrefix(path: string, lines: number): Promise<string> {
  const hash = createHash("sha256");
  let line = 0;
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const raw of rl) {
    line++;
    if (line > lines) break;
    hash.update(raw);
    hash.update("\n");
  }
  return hash.digest("hex");
}

// ---- Chunking ---------------------------------------------------------------------------

// A fixed conservative budget (chars, ~4 chars per token) so chunking depends on nothing
// provider-specific. One extraction call per chunk; results union; the belief pipeline owns
// dedupe across chunk boundaries.
export const CHUNK_BUDGET_CHARS = 24_000;

// One unit larger than the whole budget (a pasted file, an echoed log) keeps its head and
// tail: openings carry intent, endings carry conclusions, the middle is bulk.
const OVERSIZE_HEAD = Math.floor(CHUNK_BUDGET_CHARS * 0.6);
const OVERSIZE_TAIL = Math.floor(CHUNK_BUDGET_CHARS * 0.2);

export interface SessionChunk {
  units: SessionUnit[];
  startLine: number;
  endLine: number;
}

export interface ChunkResult {
  chunks: SessionChunk[];
  /** Units truncated by the oversize rule; the import summary reports the count. */
  truncated: number;
}

export function chunkUnits(units: SessionUnit[], budget = CHUNK_BUDGET_CHARS): ChunkResult {
  const chunks: SessionChunk[] = [];
  let truncated = 0;
  let current: SessionUnit[] = [];
  let size = 0;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push({
      units: current,
      startLine: current[0]?.line ?? 0,
      endLine: current[current.length - 1]?.line ?? 0,
    });
    current = [];
    size = 0;
  };

  for (const unit of units) {
    let text = unit.text;
    if (text.length > budget) {
      const cut = text.length - OVERSIZE_HEAD - OVERSIZE_TAIL;
      text = `${text.slice(0, OVERSIZE_HEAD)}\n[truncated ${cut} chars]\n${text.slice(text.length - OVERSIZE_TAIL)}`;
      truncated++;
    }
    if (size + text.length > budget) flush();
    current.push(text === unit.text ? unit : { ...unit, text });
    size += text.length;
  }
  flush();
  return { chunks, truncated };
}
