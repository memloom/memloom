import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHUNK_BUDGET_CHARS,
  chunkUnits,
  discoverSessions,
  hashPrefix,
  parseSession,
  type SessionUnit,
} from "./claude-sessions.js";

// Fixture builder: a fake ~/.claude/projects with controllable mtimes. Freshly written
// files look "active" to the quiet check, so every fixture is backdated by default.

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memloom-sessions-"));
  roots.push(root);
  return root;
}

function writeSession(
  root: string,
  project: string,
  lines: string[],
  opts: { name?: string; ageMs?: number } = {},
): string {
  const dir = join(root, project);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, opts.name ?? `${randomUUID()}.jsonl`);
  writeFileSync(path, `${lines.join("\n")}\n`);
  const when = new Date(Date.now() - (opts.ageMs ?? 60 * 60 * 1000));
  utimesSync(path, when, when);
  return path;
}

function userLine(text: string, sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"): string {
  return JSON.stringify({
    type: "user",
    sessionId,
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

function assistantLine(text: string): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

describe("discoverSessions", () => {
  it("finds main sessions and skips sidecars", async () => {
    const root = makeRoot();
    writeSession(root, "proj-a", [userLine("hello")]);
    writeSession(root, "proj-a", [userLine("subagent")], { name: "agent-12345.jsonl" });
    const { sessions, skipped } = await discoverSessions({ root });
    expect(sessions).toHaveLength(1);
    expect(skipped.sidecars).toBe(1);
  });

  it("skips sessions still being written (quiet check)", async () => {
    const root = makeRoot();
    writeSession(root, "proj-a", [userLine("mid-session")], { ageMs: 60 * 1000 });
    const { sessions, skipped } = await discoverSessions({ root });
    expect(sessions).toHaveLength(0);
    expect(skipped.active).toBe(1);
  });

  it("applies the day window and the cap, newest first", async () => {
    const root = makeRoot();
    writeSession(root, "proj-a", [userLine("old")], { ageMs: 30 * 24 * 60 * 60 * 1000 });
    const newer = writeSession(root, "proj-a", [userLine("newer")], { ageMs: 60 * 60 * 1000 });
    writeSession(root, "proj-a", [userLine("older")], { ageMs: 2 * 60 * 60 * 1000 });
    const { sessions, skipped } = await discoverSessions({ root, days: 14, maxSessions: 1 });
    expect(skipped.outsideWindow).toBe(1);
    expect(skipped.overCap).toBe(1);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.path).toBe(newer);
  });

  it("filters by project substring, case-insensitive", async () => {
    const root = makeRoot();
    writeSession(root, "D--Kostek-Projects-memloom", [userLine("a")]);
    writeSession(root, "D--Other-thing", [userLine("b")]);
    const { sessions } = await discoverSessions({ root, project: "MEMLOOM" });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.project).toBe("D--Kostek-Projects-memloom");
  });

  it("returns empty on a missing root", async () => {
    const { sessions } = await discoverSessions({ root: join(makeRoot(), "nope") });
    expect(sessions).toHaveLength(0);
  });
});

describe("parseSession", () => {
  it("extracts text units with line numbers and the session id", async () => {
    const root = makeRoot();
    const path = writeSession(root, "p", [
      JSON.stringify({ type: "summary", summary: "compacted stuff" }),
      userLine("what database do we use?"),
      assistantLine("postgres on the staging box"),
    ]);
    const parsed = await parseSession(path);
    expect(parsed.sessionId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(parsed.units).toEqual([
      { line: 2, role: "user", text: "what database do we use?" },
      { line: 3, role: "assistant", text: "postgres on the staging box" },
    ]);
    expect(parsed.lineCount).toBe(3);
  });

  it("skips malformed lines without aborting", async () => {
    const root = makeRoot();
    const path = writeSession(root, "p", [userLine("fine"), "{not json", userLine("also fine")]);
    const parsed = await parseSession(path);
    expect(parsed.malformed).toBe(1);
    expect(parsed.units).toHaveLength(2);
  });

  it("skips sidechain and meta lines", async () => {
    const root = makeRoot();
    const path = writeSession(root, "p", [
      JSON.stringify({
        type: "user",
        isSidechain: true,
        message: { role: "user", content: [{ type: "text", text: "subagent turn" }] },
      }),
      JSON.stringify({
        type: "user",
        isMeta: true,
        message: { role: "user", content: [{ type: "text", text: "harness bookkeeping" }] },
      }),
      userLine("real turn"),
    ]);
    const parsed = await parseSession(path);
    expect(parsed.units).toHaveLength(1);
    expect(parsed.units[0]?.text).toBe("real turn");
  });

  it("ignores tool blocks and accepts plain-string content", async () => {
    const root = makeRoot();
    const path = writeSession(root, "p", [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: "Bash" },
            { type: "text", text: "ran the build" },
          ],
        },
      }),
      JSON.stringify({ type: "user", message: { role: "user", content: "plain string" } }),
    ]);
    const parsed = await parseSession(path);
    expect(parsed.units.map((u) => u.text)).toEqual(["ran the build", "plain string"]);
  });

  it("skips slash-command noise units", async () => {
    const root = makeRoot();
    const path = writeSession(root, "p", [
      userLine("<command-name>/model</command-name>"),
      userLine("<local-command-stdout>Set model to Fable 5</local-command-stdout>"),
      userLine("real question"),
    ]);
    const parsed = await parseSession(path);
    expect(parsed.units.map((u) => u.text)).toEqual(["real question"]);
  });

  it("resumes after a watermark and hashes consistently", async () => {
    const root = makeRoot();
    const path = writeSession(root, "p", [userLine("one"), userLine("two"), userLine("three")]);
    const full = await parseSession(path);
    const tail = await parseSession(path, 2);
    expect(tail.units.map((u) => u.text)).toEqual(["three"]);
    expect(tail.prefixHash).toBe(full.prefixHash);
    expect(await hashPrefix(path, full.lineCount)).toBe(full.prefixHash);
  });
});

describe("chunkUnits", () => {
  const unit = (line: number, text: string): SessionUnit => ({ line, role: "user", text });

  it("splits at unit boundaries under the budget", () => {
    const big = "x".repeat(CHUNK_BUDGET_CHARS - 100);
    const { chunks, truncated } = chunkUnits([unit(1, big), unit(2, "small"), unit(3, big)]);
    expect(truncated).toBe(0);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks[0]?.endLine).toBe(2);
    expect(chunks[1]?.startLine).toBe(3);
  });

  it("truncates a single oversized unit head and tail", () => {
    const huge = `START${"y".repeat(CHUNK_BUDGET_CHARS * 2)}END`;
    const { chunks, truncated } = chunkUnits([unit(5, huge)]);
    expect(truncated).toBe(1);
    const text = chunks[0]?.units[0]?.text ?? "";
    expect(text.length).toBeLessThan(CHUNK_BUDGET_CHARS);
    expect(text.startsWith("START")).toBe(true);
    expect(text.endsWith("END")).toBe(true);
    expect(text).toContain("[truncated");
  });

  it("returns no chunks for no units", () => {
    expect(chunkUnits([]).chunks).toHaveLength(0);
  });
});
