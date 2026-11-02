import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthStore,
  HashingEmbeddingProvider,
  Memloom,
  NullLLMProvider,
  PgliteAdapter,
  type StorageAdapter,
} from "@memloom/core";
import { createServer } from "@memloom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mountMcp } from "./http.js";

// The hosted MCP endpoint, through the same app and token check a real request meets.

const OWNER = "55555555-5555-4555-8555-555555555555";
let storage: StorageAdapter;
let previousHome: string | undefined;
let fakeHome: string;

beforeAll(async () => {
  storage = await PgliteAdapter.open();
  fakeHome = mkdtempSync(join(tmpdir(), "memloom-mcp-http-"));
  previousHome = process.env.MEMLOOM_HOME;
  process.env.MEMLOOM_HOME = fakeHome;
});
afterAll(async () => {
  await storage.close();
  if (previousHome === undefined) delete process.env.MEMLOOM_HOME;
  else process.env.MEMLOOM_HOME = previousHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("hosted MCP endpoint", () => {
  async function setup() {
    const memloom = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: new NullLLMProvider(),
    });
    await memloom.init();
    const store = new AuthStore(storage);
    const app = createServer(memloom, {
      cloudAuth: { store, publicUrl: "https://memloom.example.com", ownerId: OWNER },
      mount: mountMcp,
    });
    const { token } = await store.issue(OWNER, "api");
    let id = 0;
    const rpc = async (method: string, params: unknown, bearer: string | null = token) => {
      const res = await app.request("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      });
      type Rpc = { result: { tools: { name: string }[]; content: unknown } };
      return { status: res.status, body: (res.status === 200 ? await res.json() : null) as Rpc };
    };
    return { rpc };
  }

  it("needs a token", async () => {
    const { rpc } = await setup();
    expect((await rpc("tools/list", {}, null)).status).toBe(401);
  });

  it("saves and recalls for the token's owner, without add_file", async () => {
    const { rpc } = await setup();
    const tools = await rpc("tools/list", {});
    const names = tools.body.result.tools.map((t) => t.name);
    expect(names).toContain("save_memory");
    expect(names).not.toContain("add_file");

    await rpc("tools/call", { name: "save_memory", arguments: { content: "hosted recall works" } });
    const recalled = await rpc("tools/call", {
      name: "recall_memory",
      arguments: { query: "hosted recall" },
    });
    expect(JSON.stringify(recalled.body.result.content)).toContain("hosted recall works");
  });
});
