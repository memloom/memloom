import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  copilotMemoryCandidates,
  locateAgentMemoryFolders,
  parseClaudeMemoryFolder,
  parseCopilotMemoryFolder,
} from "./agent-memories.js";

// Discovery and parsing of agent memory folders: the filesystem-only layer under
// `memloom import agent-memory`. No store, no providers.

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeClaudeMemory(
  root: string,
  project: string,
  file: string,
  fm: { name?: string; description?: string; type?: string },
  body: string,
): string {
  const dir = join(root, project, "memory");
  mkdirSync(dir, { recursive: true });
  const lines = ["---"];
  if (fm.name) lines.push(`name: ${fm.name}`);
  if (fm.description) lines.push(`description: ${fm.description}`);
  if (fm.type) lines.push("metadata:", `  type: ${fm.type}`);
  lines.push("---", "", body);
  const path = join(dir, file);
  writeFileSync(path, lines.join("\n"));
  return path;
}

describe("locateAgentMemoryFolders", () => {
  it("fans out over Claude projects with a memory dir and honors the project filter", async () => {
    const root = makeDir("memloom-agents-");
    writeClaudeMemory(root, "D--proj-one", "a.md", { name: "a" }, "alpha");
    writeClaudeMemory(root, "D--proj-two", "b.md", { name: "b" }, "beta");
    mkdirSync(join(root, "D--no-memory"), { recursive: true });

    const all = await locateAgentMemoryFolders({ claudeRoot: root, copilotRoots: [] });
    expect(all.map((f) => f.label).sort()).toEqual(["D--proj-one", "D--proj-two"]);
    expect(all.every((f) => f.agent === "claude-code")).toBe(true);

    const filtered = await locateAgentMemoryFolders({
      claudeRoot: root,
      copilotRoots: [],
      project: "proj-TWO",
    });
    expect(filtered.map((f) => f.label)).toEqual(["D--proj-two"]);
  });

  it("returns Copilot roots that exist and skips ones that do not", async () => {
    const copilot = makeDir("memloom-copilot-");
    const folders = await locateAgentMemoryFolders({
      claudeRoot: join(makeDir("memloom-empty-"), "nope"),
      copilotRoots: [copilot, join(copilot, "missing")],
    });
    expect(folders).toEqual([{ agent: "copilot", path: copilot, label: "global" }]);
  });

  it("respects the agents allowlist", async () => {
    const root = makeDir("memloom-agents-");
    writeClaudeMemory(root, "proj", "a.md", {}, "alpha");
    const copilot = makeDir("memloom-copilot-");
    const onlyCopilot = await locateAgentMemoryFolders({
      agents: ["copilot"],
      claudeRoot: root,
      copilotRoots: [copilot],
    });
    expect(onlyCopilot.map((f) => f.agent)).toEqual(["copilot"]);
  });

  it("builds per-OS Copilot candidates for both VS Code builds", () => {
    const win = copilotMemoryCandidates("win32", { APPDATA: join("C:", "AppData") });
    expect(win).toHaveLength(2);
    expect(win[0]).toContain(join("Code", "User", "globalStorage", "github.copilot-chat"));
    expect(win[1]).toContain("Code - Insiders");
    const linux = copilotMemoryCandidates("linux", {});
    expect(linux[0]).toContain(join(".config", "Code"));
  });
});

describe("parseClaudeMemoryFolder", () => {
  it("parses one file per memory with frontmatter mapping and skips the MEMORY.md index", async () => {
    const root = makeDir("memloom-claude-");
    writeClaudeMemory(
      root,
      "proj",
      "prefers-pnpm.md",
      { name: "prefers-pnpm", description: "package manager choice", type: "feedback" },
      "The user prefers pnpm over npm.\n\n**Why:** faster installs. See [[monorepo-layout]].",
    );
    writeClaudeMemory(
      root,
      "proj",
      "staging-db.md",
      { name: "staging-db", type: "project" },
      "The staging database runs on Postgres 16.",
    );
    const dir = join(root, "proj", "memory");
    writeFileSync(join(dir, "MEMORY.md"), "- [prefers-pnpm](prefers-pnpm.md)");

    const { units, files } = await parseClaudeMemoryFolder(dir);
    expect(files).toBe(2);
    expect(units).toHaveLength(2);

    const pref = units.find((u) => u.canonical === "prefers-pnpm");
    expect(pref?.memoryType).toBe("preference");
    expect(pref?.content).toContain("prefers pnpm over npm");
    expect(pref?.content).toContain("[[monorepo-layout]]");
    expect(pref?.sectionAnchor).toBeNull();
    expect(pref?.startLine).toBeGreaterThan(5);

    const fact = units.find((u) => u.canonical === "staging-db");
    expect(fact?.memoryType).toBe("fact");
  });

  it("falls back to the description when the body is empty and skips truly empty files", async () => {
    const root = makeDir("memloom-claude-");
    writeClaudeMemory(root, "proj", "thin.md", { name: "thin", description: "a bare summary" }, "");
    writeClaudeMemory(root, "proj", "empty.md", { name: "empty" }, "");
    const { units } = await parseClaudeMemoryFolder(join(root, "proj", "memory"));
    expect(units).toHaveLength(1);
    expect(units[0]?.content).toBe("a bare summary");
  });

  it("treats a file without frontmatter as a whole-file fact", async () => {
    const root = makeDir("memloom-claude-");
    const dir = join(root, "proj", "memory");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "note.md"), "Plain note without frontmatter.");
    const { units } = await parseClaudeMemoryFolder(dir);
    expect(units).toHaveLength(1);
    expect(units[0]?.memoryType).toBe("fact");
    expect(units[0]?.canonical).toBeUndefined();
    expect(units[0]?.startLine).toBe(1);
  });

  it("changes the content hash when the name or body changes", async () => {
    const root = makeDir("memloom-claude-");
    const path = writeClaudeMemory(root, "proj", "a.md", { name: "a" }, "body");
    const dir = join(root, "proj", "memory");
    const [first] = (await parseClaudeMemoryFolder(dir)).units;
    writeFileSync(path, "---\nname: a\n---\n\nbody changed");
    const [second] = (await parseClaudeMemoryFolder(dir)).units;
    expect(first?.contentHash).not.toBe(second?.contentHash);
    expect(first?.identity).toBe(second?.identity);
  });
});

describe("parseCopilotMemoryFolder", () => {
  it("splits topic files into one memory per ## section with line provenance", async () => {
    const dir = makeDir("memloom-copilot-");
    writeFileSync(
      join(dir, "build.md"),
      [
        "# Build system",
        "",
        "## Always use pnpm",
        "The repo is a pnpm workspace; npm install breaks the lockfile.",
        "",
        "## CI runs node 20",
        "The floor is node 20; do not use node 22 APIs.",
      ].join("\n"),
    );

    const { units, files } = await parseCopilotMemoryFolder(dir);
    expect(files).toBe(1);
    expect(units).toHaveLength(2);
    expect(units[0]?.canonical).toBe("Always use pnpm");
    expect(units[0]?.sectionAnchor).toBe("Always use pnpm");
    expect(units[0]?.memoryType).toBe("fact");
    expect(units[0]?.startLine).toBe(4);
    expect(units[1]?.identity).toContain("CI runs node 20");
  });

  it("captures a file without ## sections whole, below its title", async () => {
    const dir = makeDir("memloom-copilot-");
    writeFileSync(join(dir, "note.md"), "# Deploys\nAlways deploy from main.");
    const { units } = await parseCopilotMemoryFolder(dir);
    expect(units).toHaveLength(1);
    expect(units[0]?.canonical).toBe("Deploys");
    expect(units[0]?.sectionAnchor).toBeNull();
    expect(units[0]?.content).toBe("Always deploy from main.");
  });

  it("drops empty sections instead of saving blank memories", async () => {
    const dir = makeDir("memloom-copilot-");
    writeFileSync(join(dir, "sparse.md"), "# T\n\n## Empty one\n\n## Full one\ncontent here");
    const { units } = await parseCopilotMemoryFolder(dir);
    expect(units.map((u) => u.canonical)).toEqual(["Full one"]);
  });
});
