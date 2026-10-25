import { Readable } from "node:stream";
import type { Memory } from "@memloom/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchRecall,
  formatRecallBlock,
  HIT_CHARS,
  parsePromptPayload,
  projectScopeOf,
  promptRecall,
  RECALL_LIMIT,
  shouldSkipPrompt,
  TOTAL_CHARS,
} from "./recall-hook.js";

// The silence suite. In the UserPromptSubmit contract a thrown error surfaces on the
// user's prompt as noise, so every failure path here must resolve to "" quietly.

afterEach(() => {
  vi.unstubAllGlobals();
});

function memory(over: Partial<Memory> = {}): Memory {
  return {
    id: "m1",
    ownerId: "default",
    status: "active",
    memoryType: "fact",
    canonical: null,
    content: "the staging database runs on Postgres",
    summary: null,
    rootId: "m1",
    version: 1,
    assertedAt: "2026-07-25T10:00:00.000Z",
    createdAt: "2026-07-25T10:00:00.000Z",
    ...over,
  } as Memory;
}

function okFetch(memories: Memory[]) {
  return vi.fn(async () => ({ ok: true, json: async () => ({ memories }) }));
}

describe("parsePromptPayload", () => {
  it("extracts the prompt and the working directory", () => {
    expect(parsePromptPayload('{"prompt":"hello","cwd":"/x"}')).toEqual({
      prompt: "hello",
      cwd: "/x",
    });
  });

  it("keeps the prompt when cwd is missing or unusable", () => {
    expect(parsePromptPayload('{"prompt":"hello"}')).toEqual({ prompt: "hello", cwd: null });
    expect(parsePromptPayload('{"prompt":"hello","cwd":42}')).toEqual({
      prompt: "hello",
      cwd: null,
    });
    expect(parsePromptPayload('{"prompt":"hello","cwd":"  "}')).toEqual({
      prompt: "hello",
      cwd: null,
    });
  });

  it("returns null on invalid JSON or a missing prompt", () => {
    expect(parsePromptPayload("{ nope")).toBeNull();
    expect(parsePromptPayload('{"cwd":"/x"}')).toBeNull();
    expect(parsePromptPayload('{"prompt":42}')).toBeNull();
  });
});

describe("projectScopeOf", () => {
  it("derives projects/<basename> from either separator style", () => {
    expect(projectScopeOf("D:\\Kostek\\Projects\\memloom")).toBe("projects/memloom");
    expect(projectScopeOf("/home/k/projects/Widget Factory")).toBe("projects/widget-factory");
  });

  it("yields nothing for missing directories and drive roots", () => {
    expect(projectScopeOf(null)).toBeUndefined();
    expect(projectScopeOf("D:\\")).toBeUndefined();
    expect(projectScopeOf("/")).toBeUndefined();
  });
});

describe("shouldSkipPrompt", () => {
  it("skips empty prompts, slash commands, and shell passthrough", () => {
    for (const p of ["", "   ", "/compact", "  /model", "!ls -la"]) {
      expect(shouldSkipPrompt(p)).toBe(true);
    }
  });

  it("keeps real prompts", () => {
    expect(shouldSkipPrompt("how do we deploy staging?")).toBe(false);
  });
});

describe("formatRecallBlock", () => {
  it("is empty for no hits", () => {
    expect(formatRecallBlock([])).toBe("");
  });

  it("wraps numbered, type-labeled hits", () => {
    const block = formatRecallBlock([
      memory(),
      memory({ id: "m2", memoryType: "preference", content: "prefers pnpm over npm" }),
    ]);
    expect(block).toMatch(/^<memloom-memory note="[^"]+">\n/);
    expect(block).toContain("1. [fact] the staging database runs on Postgres");
    expect(block).toContain("2. [preference] prefers pnpm over npm");
    expect(block.endsWith("</memloom-memory>")).toBe(true);
  });

  it("labels context chunks and cites their source", () => {
    const block = formatRecallBlock([
      memory({
        memoryType: "context",
        kind: "context",
        content: "the postgres wire runs on 54329",
        source: {
          documentId: "d1",
          title: "setup.md",
          path: "/notes/setup.md",
          headingPath: "Daemon > Ports",
          page: null,
        },
      }),
    ]);
    expect(block).toContain(
      "1. [context] the postgres wire runs on 54329 (from setup.md › Daemon > Ports)",
    );
  });

  it("truncates long hits and stays within the total budget, keeping hit 1", () => {
    const long = "x".repeat(HIT_CHARS + 200);
    const block = formatRecallBlock(
      Array.from({ length: 6 }, (_, i) => memory({ id: `m${i}`, content: long })),
    );
    expect(block).toContain(`${"x".repeat(HIT_CHARS)}...`);
    expect(block).toContain("1. [fact]");
    const body = block.split("\n").slice(1, -1).join("\n");
    expect(body.length).toBeLessThanOrEqual(TOTAL_CHARS + HIT_CHARS + 100);
    expect(block).not.toContain("6. [fact]");
  });
});

describe("fetchRecall", () => {
  it("posts the query with the hit limit and returns the memories", async () => {
    const fetchMock = okFetch([memory()]);
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchRecall("staging db");
    expect(result).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4319/memory/query");
    expect(JSON.parse(init.body as string)).toEqual({ query: "staging db", limit: RECALL_LIMIT });
  });

  it("passes the scope through in the body", async () => {
    const fetchMock = okFetch([memory()]);
    vi.stubGlobal("fetch", fetchMock);
    await fetchRecall("staging db", undefined, "projects/memloom");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      query: "staging db",
      limit: RECALL_LIMIT,
      scope: "projects/memloom",
    });
  });

  it("retries a 400 once without the scope so an unknown folder never silences recall", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 400 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ memories: [memory()] }) });
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchRecall("staging db", undefined, "projects/brand-new");
    expect(result).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(second[1].body as string)).toEqual({
      query: "staging db",
      limit: RECALL_LIMIT,
    });
  });

  it("stays null when the unscoped retry fails too", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 400 })
      .mockResolvedValueOnce({ ok: false, status: 503 });
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchRecall("q", undefined, "projects/x")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never retries a non-400 failure or an unscoped 400", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchRecall("q", undefined, "projects/x")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const badRequest = vi.fn(async () => ({ ok: false, status: 400 }));
    vi.stubGlobal("fetch", badRequest);
    expect(await fetchRecall("q")).toBeNull();
    expect(badRequest).toHaveBeenCalledTimes(1);
  });

  it("returns null on a non-ok response (503 store lock) and on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503 })),
    );
    expect(await fetchRecall("q")).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))),
    );
    expect(await fetchRecall("q")).toBeNull();
  });
});

describe("promptRecall", () => {
  function stdin(payload: string): NodeJS.ReadableStream {
    return Readable.from([payload]);
  }

  it("returns the block for a real prompt with hits", async () => {
    vi.stubGlobal("fetch", okFetch([memory()]));
    const out = await promptRecall(stdin('{"prompt":"what runs the staging db?"}'));
    expect(out).toContain("[fact] the staging database runs on Postgres");
  });

  it("scopes the query to the payload's project directory", async () => {
    const fetchMock = okFetch([memory()]);
    vi.stubGlobal("fetch", fetchMock);
    const out = await promptRecall(
      stdin('{"prompt":"what runs the staging db?","cwd":"D:\\\\Kostek\\\\Projects\\\\memloom"}'),
    );
    expect(out).toContain("[fact]");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).scope).toBe("projects/memloom");
  });

  it("never queries for skipped prompts", async () => {
    const fetchMock = okFetch([memory()]);
    vi.stubGlobal("fetch", fetchMock);
    expect(await promptRecall(stdin('{"prompt":"/compact"}'))).toBe("");
    expect(await promptRecall(stdin("not json at all"))).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is silent on daemon failure and on zero hits", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("down"))),
    );
    expect(await promptRecall(stdin('{"prompt":"anything"}'))).toBe("");
    vi.stubGlobal("fetch", okFetch([]));
    expect(await promptRecall(stdin('{"prompt":"anything"}'))).toBe("");
  });
});
