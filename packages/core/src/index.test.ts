import { describe, expect, it } from "vitest";
import {
  type EmbeddingProvider,
  type LLMProvider,
  Memloom,
  type StorageAdapter,
  VERSION,
} from "./index.js";

const fakeStorage: StorageAdapter = {
  query: async () => [],
  tx: async (fn) => fn(fakeStorage),
  close: async () => {},
};
const fakeEmbedding: EmbeddingProvider = {
  dims: 1024,
  embed: async (texts) => texts.map(() => []),
};
const fakeLLM: LLMProvider = { complete: async () => "" };

const config = { storage: fakeStorage, embedding: fakeEmbedding, llm: fakeLLM };

describe("Memloom scaffold", () => {
  it("exposes a version", () => {
    expect(VERSION).toBe("0.0.0");
  });

  it("constructs with injected providers and exposes them", () => {
    const m = new Memloom(config);
    expect(m.deps.embedding.dims).toBe(1024);
  });

  it("save is not implemented yet (Phase 1)", async () => {
    const m = new Memloom(config);
    await expect(m.save({ content: "x" })).rejects.toThrow(/Phase 1/);
  });
});
