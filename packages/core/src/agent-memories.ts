import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { MemoryType } from "./types.js";

// Agent memory folder discovery + parsing for `memloom import agent-memory`. Coding agents
// keep long-term notes as markdown on disk: Claude Code writes one file per memory under
// ~/.claude/projects/<slug>/memory/ with YAML frontmatter, and GitHub Copilot keeps topic
// files whose ## sections are individual memories under VS Code's globalStorage. Those files
// are already distilled memories, so import parses and maps them; unlike session import there
// is no LLM distillation step. Everything here is filesystem-and-parsing only; no store, no
// providers. Read-only on the agents' files: memloom never writes into their folders.

export const AGENT_MEMORY_SOURCES = ["claude-code", "copilot"] as const;
export type AgentMemorySource = (typeof AGENT_MEMORY_SOURCES)[number];

/** One discovered memory folder: Claude Code has one per project, Copilot one global. */
export interface AgentMemoryFolder {
  agent: AgentMemorySource;
  path: string;
  /** Claude Code: the encoded project dir name (e.g. "D--Kostek-Projects-memloom"); Copilot: "global". */
  label: string;
}

/** One parsed memory, normalized across agents. */
export interface AgentMemoryUnit {
  /** Stable ledger identity: agent + file + section anchor. Plays the session_id role. */
  identity: string;
  filePath: string;
  /** Copilot: the ## heading the memory came from; null when the whole file is one memory. */
  sectionAnchor: string | null;
  /** Claude frontmatter `name` / Copilot heading; feeds SaveInput.canonical. */
  canonical?: string;
  memoryType: MemoryType;
  content: string;
  /** sha256 hex over canonical + content: the ledger's unchanged check. */
  contentHash: string;
  /** 1-based line range of the content in its file: the provenance pointer. */
  startLine: number;
  endLine: number;
}

export interface AgentMemoryDiscoveryOptions {
  /** Which agents to look at. Default: all supported. */
  agents?: AgentMemorySource[];
  /** Case-insensitive substring match on the Claude Code project directory name. */
  project?: string;
  /** Override ~/.claude/projects (tests, unusual layouts). */
  claudeRoot?: string;
  /** Override the per-OS Copilot candidate paths (tests). */
  copilotRoots?: string[];
}

export function claudeMemoryRoot(): string {
  return join(homedir(), ".claude", "projects");
}

// Copilot memory is a single global folder inside VS Code's globalStorage; the base differs
// per OS and per build (stable vs Insiders).
export function copilotMemoryCandidates(
  platform: string = process.platform,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const home = homedir();
  const editors = ["Code", "Code - Insiders"];
  let bases: string[];
  if (platform === "darwin") {
    bases = editors.map((e) => join(home, "Library", "Application Support", e));
  } else if (platform === "win32") {
    const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
    bases = editors.map((e) => join(appData, e));
  } else {
    const xdg = env.XDG_CONFIG_HOME ?? join(home, ".config");
    bases = editors.map((e) => join(xdg, e));
  }
  return bases.map((base) =>
    join(base, "User", "globalStorage", "github.copilot-chat", "memory-tool", "memories"),
  );
}

async function isDir(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  return info?.isDirectory() ?? false;
}

/** Discover every memory folder the selected agents have on this machine. */
export async function locateAgentMemoryFolders(
  opts: AgentMemoryDiscoveryOptions = {},
): Promise<AgentMemoryFolder[]> {
  const agents = opts.agents ?? [...AGENT_MEMORY_SOURCES];
  const folders: AgentMemoryFolder[] = [];

  if (agents.includes("claude-code")) {
    const root = opts.claudeRoot ?? claudeMemoryRoot();
    const filter = opts.project?.toLowerCase();
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (filter && !entry.name.toLowerCase().includes(filter)) continue;
      const memoryDir = join(root, entry.name, "memory");
      if (await isDir(memoryDir)) {
        folders.push({ agent: "claude-code", path: memoryDir, label: entry.name });
      }
    }
  }

  if (agents.includes("copilot")) {
    for (const dir of opts.copilotRoots ?? copilotMemoryCandidates()) {
      if (await isDir(dir)) folders.push({ agent: "copilot", path: dir, label: "global" });
    }
  }

  return folders;
}

// ---- Parsing ----------------------------------------------------------------------------

/** Recursive .md discovery, skipping dot-directories (.temp and friends). Sorted for determinism. */
async function findMarkdownFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith(".")) results.push(...(await findMarkdownFiles(path)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      results.push(path);
    }
  }
  return results.sort();
}

function hashUnit(canonical: string | undefined, content: string): string {
  return createHash("sha256")
    .update(canonical ?? "")
    .update("\n")
    .update(content)
    .digest("hex");
}

function identityOf(agent: AgentMemorySource, filePath: string, anchor: string | null): string {
  return `${agent}::${filePath}::${anchor ?? ""}`;
}

interface ClaudeFrontmatter {
  name?: string;
  description?: string;
  /** metadata.type: user | feedback | project | reference. */
  type?: string;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value.endsWith(first)) return value.slice(1, -1);
  }
  return value;
}

// The frontmatter agents write is a tiny, known shape (flat keys plus metadata.type), so a
// line-based reader covers it without a YAML dependency in core. Unknown keys are ignored.
function parseClaudeFrontmatter(lines: string[]): ClaudeFrontmatter {
  const out: ClaudeFrontmatter = {};
  let inMetadata = false;
  for (const line of lines) {
    const match = /^(\s*)([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    const indent = match[1] as string;
    const key = match[2] as string;
    const value = unquote((match[3] as string).trim());
    if (indent.length === 0) {
      inMetadata = key === "metadata";
      if (key === "name" && value) out.name = value;
      else if (key === "description" && value) out.description = value;
    } else if (inMetadata && key === "type" && value) {
      out.type = value;
    }
  }
  return out;
}

// Claude's memory taxonomy (user | feedback | project | reference) is narrower than
// memloom's. Feedback is guidance on how the user wants things done: a preference.
// Everything else lands as a fact; the body states it self-contained.
function claudeMemoryType(metadataType: string | undefined): MemoryType {
  return metadataType === "feedback" ? "preference" : "fact";
}

/** 1-based line range of the non-blank body inside `lines`, starting at index `from`. */
function bodyRange(lines: string[], from: number): { startLine: number; endLine: number } {
  let start = -1;
  let end = -1;
  for (let i = from; i < lines.length; i++) {
    if ((lines[i] as string).trim()) {
      if (start === -1) start = i + 1;
      end = i + 1;
    }
  }
  return { startLine: Math.max(start, 1), endLine: Math.max(end, 1) };
}

/** Claude Code: one file = one memory. MEMORY.md is the index, not a memory; skipped. */
export async function parseClaudeMemoryFolder(
  folderPath: string,
): Promise<{ units: AgentMemoryUnit[]; files: number }> {
  const units: AgentMemoryUnit[] = [];
  let files = 0;
  for (const file of await findMarkdownFiles(folderPath)) {
    if (basename(file).toLowerCase() === "memory.md") continue;
    files++;
    const raw = await readFile(file, "utf8").catch(() => null);
    if (raw === null) continue;
    const lines = raw.split(/\r?\n/);

    let frontmatter: ClaudeFrontmatter = {};
    let bodyFrom = 0;
    if (lines[0]?.trim() === "---") {
      const close = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
      if (close > 0) {
        frontmatter = parseClaudeFrontmatter(lines.slice(1, close));
        bodyFrom = close + 1;
      }
    }

    // A file whose body is empty still describes something when the frontmatter has a
    // description; better one thin memory than a silent drop.
    let content = lines.slice(bodyFrom).join("\n").trim();
    let { startLine, endLine } = bodyRange(lines, bodyFrom);
    if (!content && frontmatter.description) {
      content = frontmatter.description;
      startLine = 1;
      endLine = 1;
    }
    if (!content) continue;

    const canonical = frontmatter.name;
    units.push({
      identity: identityOf("claude-code", file, null),
      filePath: file,
      sectionAnchor: null,
      ...(canonical ? { canonical } : {}),
      memoryType: claudeMemoryType(frontmatter.type),
      content,
      contentHash: hashUnit(canonical, content),
      startLine,
      endLine,
    });
  }
  return { units, files };
}

interface CopilotSection {
  heading: string;
  headingLine: number;
  lines: string[];
}

/** Copilot: each ## section is a memory; content before the first ## is the topic container. */
export async function parseCopilotMemoryFolder(
  folderPath: string,
): Promise<{ units: AgentMemoryUnit[]; files: number }> {
  const units: AgentMemoryUnit[] = [];
  let files = 0;

  const add = (
    file: string,
    anchor: string | null,
    canonical: string | undefined,
    body: string[],
    firstLineNumber: number,
  ) => {
    const content = body.join("\n").trim();
    if (!content) return;
    let start = -1;
    let end = -1;
    for (let i = 0; i < body.length; i++) {
      if ((body[i] as string).trim()) {
        if (start === -1) start = firstLineNumber + i;
        end = firstLineNumber + i;
      }
    }
    units.push({
      identity: identityOf("copilot", file, anchor),
      filePath: file,
      sectionAnchor: anchor,
      ...(canonical ? { canonical } : {}),
      // Copilot files carry no type metadata; a fact is the safe default and the
      // belief pipeline treats types as hints, not fences.
      memoryType: "fact",
      content,
      contentHash: hashUnit(canonical, content),
      startLine: Math.max(start, 1),
      endLine: Math.max(end, 1),
    });
  };

  for (const file of await findMarkdownFiles(folderPath)) {
    files++;
    const raw = await readFile(file, "utf8").catch(() => null);
    if (raw === null) continue;
    const lines = raw.split(/\r?\n/);

    const sections: CopilotSection[] = [];
    let current: CopilotSection | null = null;
    for (const [i, line] of lines.entries()) {
      const match = /^##\s+(.+?)\s*$/.exec(line);
      if (match) {
        if (current) sections.push(current);
        current = { heading: match[1] as string, headingLine: i + 1, lines: [] };
      } else if (current) {
        current.lines.push(line);
      }
    }
    if (current) sections.push(current);

    if (sections.length === 0) {
      // No ## sections: capture the whole file below its # Title (or all of it) as one
      // memory so plain-text notes are not dropped silently.
      const titleIndex = lines.findIndex((line) => /^#\s+.+/.test(line));
      const title =
        titleIndex >= 0
          ? (/^#\s+(.+?)\s*$/.exec(lines[titleIndex] as string)?.[1] as string)
          : undefined;
      const from = titleIndex + 1;
      add(file, null, title, lines.slice(from), from + 1);
      continue;
    }

    for (const section of sections) {
      add(file, section.heading, section.heading, section.lines, section.headingLine + 1);
    }
  }
  return { units, files };
}

/** Parse one located folder with the adapter for its agent. */
export function parseAgentMemoryFolder(
  folder: AgentMemoryFolder,
): Promise<{ units: AgentMemoryUnit[]; files: number }> {
  return folder.agent === "claude-code"
    ? parseClaudeMemoryFolder(folder.path)
    : parseCopilotMemoryFolder(folder.path);
}
