import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenRouterEmbeddings, OpenRouterLLM } from "./openrouter-provider.js";

// Assert the exact request body we send OpenRouter: the dimensions param (Matryoshka
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

  it("complete() caps max_tokens: without one OpenRouter preauthorizes the model's full output ceiling and 402s small balances", async () => {
    const fetch = mockChatFetch();
    vi.stubGlobal("fetch", fetch);

    await new OpenRouterLLM({ apiKey: "k" }).complete("hi");

    const body = JSON.parse((fetch.mock.calls[0]?.[1] as { body: string }).body);
    expect(body.max_tokens).toBe(8192);
  });

  // Every complete() caller classifies or extracts. Measured on a real store: 1156 memory pairs
  // judged twice with an identical prompt disagreed on 8 at the model's default temperature and on
  // none at 0. Without this, two identical saves can be classified differently, and no test can
  // catch a bug that only shows up on some samples.
  it("complete() pins temperature at 0, and chat() leaves the assistant's own words sampled", async () => {
    const fetch = mockChatFetch();
    vi.stubGlobal("fetch", fetch);
    const llm = new OpenRouterLLM({ apiKey: "k" });

    await llm.complete("classify this");
    await llm.chat([{ role: "user", content: "hi" }]);

    const completion = JSON.parse((fetch.mock.calls[0]?.[1] as { body: string }).body);
    const chat = JSON.parse((fetch.mock.calls[1]?.[1] as { body: string }).body);
    expect(completion.temperature).toBe(0);
    expect(chat.temperature).toBeUndefined();
  });

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

describe("postJson retry behavior", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const okCompletion = {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => "",
    json: async () => ({ choices: [{ message: { content: "ok" } }] }),
  };

  it("retries network failures and succeeds, without surfacing the blip", async () => {
    vi.useFakeTimers();
    const netErr = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNRESET" },
    });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(netErr)
      .mockRejectedValueOnce(netErr)
      .mockResolvedValue(okCompletion);
    vi.stubGlobal("fetch", fetchMock);

    const pending = new OpenRouterLLM({ apiKey: "k" }).complete("hi");
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after 4 attempts and names the real cause, not just fetch failed", async () => {
    vi.useFakeTimers();
    const netErr = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNRESET" },
    });
    const fetchMock = vi.fn().mockRejectedValue(netErr);
    vi.stubGlobal("fetch", fetchMock);

    const pending = new OpenRouterLLM({ apiKey: "k" }).complete("hi");
    pending.catch(() => {});
    await vi.runAllTimersAsync();
    await expect(pending).rejects.toThrow(/after 4 attempts.*fetch failed \(ECONNRESET\)/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("retries 429 honoring Retry-After, drains the body first", async () => {
    vi.useFakeTimers();
    let drained = false;
    const throttled = {
      ok: false,
      status: 429,
      headers: { get: (name: string) => (name === "retry-after" ? "2" : null) },
      text: async () => {
        drained = true;
        return "slow down";
      },
      json: async () => ({}),
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(throttled).mockResolvedValue(okCompletion);
    vi.stubGlobal("fetch", fetchMock);

    const pending = new OpenRouterLLM({ apiKey: "k" }).complete("hi");
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(drained).toBe(true);
  });

  it("does not retry a non-retryable status", async () => {
    const bad = {
      ok: false,
      status: 400,
      headers: { get: () => null },
      text: async () => "bad request",
      json: async () => ({}),
    };
    const fetchMock = vi.fn().mockResolvedValue(bad);
    vi.stubGlobal("fetch", fetchMock);

    await expect(new OpenRouterLLM({ apiKey: "k" }).complete("hi")).rejects.toThrow(
      /400 bad request/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
