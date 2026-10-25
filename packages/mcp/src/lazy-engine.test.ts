import type { MemoryEngine } from "@memloom/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { lazyEngine } from "./lazy-engine.js";
import { buildServer } from "./server.js";

async function clientFor(engine: MemoryEngine): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildServer(engine).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

describe("lazyEngine", () => {
  it("answers initialize and reports the daemon's error from the tool call", async () => {
    const client = await clientFor(
      lazyEngine(() => Promise.reject(new Error("memloom: the local server exited (code 1)"))),
    );
    const res = await client.callTool({ name: "recall_memory", arguments: { query: "x" } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("the local server exited (code 1)");
  });

  it("retries a failed connect on the next call", async () => {
    let attempts = 0;
    const engine = lazyEngine(async () => {
      attempts++;
      if (attempts === 1) throw new Error("not yet");
      return { recall: async () => [] } as unknown as MemoryEngine;
    });
    await expect(engine.recall("x")).rejects.toThrow("not yet");
    await expect(engine.recall("x")).resolves.toEqual([]);
    expect(attempts).toBe(2);
  });

  it("connects once for many calls", async () => {
    let attempts = 0;
    const engine = lazyEngine(async () => {
      attempts++;
      return { recall: async () => [] } as unknown as MemoryEngine;
    });
    await Promise.all([engine.recall("a"), engine.recall("b"), engine.recall("c")]);
    expect(attempts).toBe(1);
  });
});
