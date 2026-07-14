import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenRouterEmbeddings, OpenRouterLLM } from "./openrouter-provider.js";

// Assert the exact request body we send OpenRouter — the dimensions param (Matryoshka
// truncation to 1024) and the provider preference both silently break retrieval/latency if
// they fall off the request.

function mockFetch(dims: number) {
  return vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as { input: string[] };
    return {
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({ data: body.input.map(() => ({ embedding: new Array(dims).fill(0) })) }),
    };
  });
}

describe("OpenRouterEmbeddings request body", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("default model: sends dimensions and prefers nebius with fallbacks", async () => {
    const fetch = mockFetch(1024);
    vi.stubGlobal("fetch", fetch);

    await new OpenRouterEmbeddings({ apiKey: "k" }).embed(["hello"]);

    const body = JSON.parse((fetch.mock.calls[0]?.[1] as { body: string }).body);
    expect(body.model).toBe("qwen/qwen3-embedding-8b");
    expect(body.dimensions).toBe(1024);
    expect(body.provider).toEqual({ order: ["nebius"], allow_fallbacks: true });
  });

  it("explicitly-spelled default model still prefers nebius", async () => {
    const fetch = mockFetch(1024);
    vi.stubGlobal("fetch", fetch);

    await new OpenRouterEmbeddings({ apiKey: "k", model: "qwen/qwen3-embedding-8b" }).embed(["x"]);
    const body = JSON.parse((fetch.mock.calls[0]?.[1] as { body: string }).body);
    expect(body.provider).toEqual({ order: ["nebius"], allow_fallbacks: true });
  });

  it("custom model: no provider preference unless stated", async () => {
    const fetch = mockFetch(768);
    vi.stubGlobal("fetch", fetch);

    await new OpenRouterEmbeddings({ apiKey: "k", model: "other/model", dims: 768 }).embed(["x"]);
    const body = JSON.parse((fetch.mock.calls[0]?.[1] as { body: string }).body);
    expect(body.provider).toBeUndefined();

    await new OpenRouterEmbeddings({
      apiKey: "k",
      model: "other/model",
      dims: 768,
      provider: "deepinfra",
    }).embed(["x"]);
    const body2 = JSON.parse((fetch.mock.calls[1]?.[1] as { body: string }).body);
    expect(body2.provider).toEqual({ order: ["deepinfra"], allow_fallbacks: true });
  });
});

describe("OpenRouterLLM per-request model override", () => {
  afterEach(() => vi.unstubAllGlobals());

  function mockChatFetch() {
    return vi.fn(async (_url: unknown, _init?: { body?: string }) => ({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
      body: null,
    }));
  }

  it("chat() sends opts.model when given, the configured chatModel otherwise", async () => {
    const fetch = mockChatFetch();
    vi.stubGlobal("fetch", fetch);
    const llm = new OpenRouterLLM({ apiKey: "k", chatModel: "google/gemini-2.5-flash" });

    await llm.chat([{ role: "user", content: "hi" }]);
    await llm.chat([{ role: "user", content: "hi" }], { model: "anthropic/claude-sonnet-5" });

    const body1 = JSON.parse((fetch.mock.calls[0]?.[1] as { body: string }).body);
    const body2 = JSON.parse((fetch.mock.calls[1]?.[1] as { body: string }).body);
    expect(body1.model).toBe("google/gemini-2.5-flash");
    expect(body2.model).toBe("anthropic/claude-sonnet-5");
  });

  it("the tool-support error names the overriding model, not the configured one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        text: async () => "No endpoints found that support tool use",
        json: async () => ({}),
      })),
    );
    const llm = new OpenRouterLLM({ apiKey: "k", chatModel: "google/gemini-2.5-flash" });
    await expect(
      llm.chat([{ role: "user", content: "hi" }], {
        tools: [{ name: "t", description: "d", parameters: {} }],
        model: "some/notool-model",
      }),
    ).rejects.toThrow(/"some\/notool-model" does not support tool calling/);
  });
});
