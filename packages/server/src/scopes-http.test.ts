import type { StorageAdapter } from "@memloom/core";
import {
  HashingEmbeddingProvider,
  Memloom,
  NullLLMProvider,
  PgliteAdapter,
  truncateAll,
} from "@memloom/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "./index.js";

// The scope registry over HTTP (PLAN-memory-scopes.md child 2): the routes the CLI and the
// viewer drive, exercised via Hono's request helper.

let storage: StorageAdapter;
beforeAll(async () => {
  storage = await PgliteAdapter.open();
});
afterAll(async () => {
  await storage.close();
});

async function app() {
  await truncateAll(storage);
  const memloom = new Memloom({
    storage,
    embedding: new HashingEmbeddingProvider(1024),
    llm: new NullLLMProvider(),
    dedup: false,
  });
  await memloom.init();
  return createServer(memloom);
}

const post = (server: Awaited<ReturnType<typeof app>>, path: string, body: unknown) =>
  server.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

interface ScopeNodeish {
  id: string;
  path: string;
  kind: string;
  children: ScopeNodeish[];
  memories: number;
}

const flatten = (nodes: ScopeNodeish[]): ScopeNodeish[] =>
  nodes.flatMap((n) => [n, ...flatten(n.children)]);

describe("scopes over HTTP", () => {
  it("creates folders, lists the tree, and files saves into it", async () => {
    const server = await app();
    const created = await post(server, "/scopes", {
      path: "projects/memloom",
      description: "the engine",
    });
    expect(created.status).toBe(200);

    const saved = await post(server, "/memory/save", {
      content: "the fuse gained scope params",
      scope: "projects/memloom",
      tags: ["Engine"],
    });
    expect(saved.status).toBe(200);

    const tree = await server.request("/scopes");
    expect(tree.status).toBe(200);
    const { scopes } = (await tree.json()) as { scopes: ScopeNodeish[] };
    const all = flatten(scopes);
    expect(all.map((s) => s.path).sort()).toEqual([
      "global",
      "projects",
      "projects/memloom",
      "uncategorized",
    ]);
    expect(all.find((s) => s.path === "projects/memloom")?.memories).toBe(1);

    // The row is filed and tagged: /memory/list carries scopePath + normalized tags.
    const list = await server.request("/memory/list?scope=projects");
    const { memories } = (await list.json()) as {
      memories: Array<{ scopePath: string; tags: string[] }>;
    };
    expect(memories).toHaveLength(1);
    expect(memories[0]?.scopePath).toBe("projects > memloom");
    expect(memories[0]?.tags).toEqual(["engine"]);
  });

  it("answers an unknown scope with 400, on save and on query alike", async () => {
    const server = await app();
    const saved = await post(server, "/memory/save", { content: "x", scope: "nope" });
    expect(saved.status).toBe(400);
    expect(((await saved.json()) as { error: string }).error).toMatch(/unknown scope/);

    const queried = await post(server, "/memory/query", { query: "x", scope: "nope" });
    expect(queried.status).toBe(400);

    const listed = await server.request("/memory/list?scope=nope");
    expect(listed.status).toBe(400);
  });

  it("scoped query stays out of other folders but sees uncategorized and global", async () => {
    const server = await app();
    await post(server, "/scopes", { path: "personal-life" });
    await post(server, "/scopes", { path: "projects" });
    await post(server, "/memory/save", { content: "omega personal", scope: "personal-life" });
    await post(server, "/memory/save", { content: "omega project", scope: "projects" });
    await post(server, "/memory/save", { content: "omega unfiled" });
    await post(server, "/memory/save", { content: "omega preference", scope: "global" });

    const res = await post(server, "/memory/query", { query: "omega", scope: "personal-life" });
    const { memories } = (await res.json()) as { memories: Array<{ content: string }> };
    expect(memories.map((m) => m.content).sort()).toEqual([
      "omega personal",
      "omega preference",
      "omega unfiled",
    ]);
  });

  it("moves memories in bulk and guards the registry's system folders", async () => {
    const server = await app();
    await post(server, "/scopes", { path: "a" });
    await post(server, "/memory/save", { content: "movable row" });
    const list = await server.request("/memory/list");
    const { memories } = (await list.json()) as { memories: Array<{ id: string }> };
    const first = memories[0];
    if (!first) throw new Error("fixture memory missing");

    const moved = await post(server, "/memory/scope", { ids: [first.id], scope: "a" });
    expect(((await moved.json()) as { moved: number }).moved).toBe(1);

    const tree = await server.request("/scopes");
    const { scopes } = (await tree.json()) as { scopes: ScopeNodeish[] };
    const uncat = flatten(scopes).find((s) => s.path === "uncategorized");
    if (!uncat) throw new Error("uncategorized missing");
    const del = await server.request(`/scopes/${uncat.id}`, { method: "DELETE" });
    expect(del.status).toBe(400);
    expect(((await del.json()) as { error: string }).error).toMatch(/system folder/);

    const gone = await server.request(`/scopes/${first.id}`, { method: "DELETE" });
    expect(gone.status).toBe(404);
  });

  it("re-scopes a document or answers 404 when it does not exist", async () => {
    const server = await app();
    await post(server, "/scopes", { path: "a" });
    const missing = await post(
      server,
      "/context/documents/00000000-0000-0000-0000-000000000001/scope",
      { scope: "a" },
    );
    expect(missing.status).toBe(404);
  });
});
