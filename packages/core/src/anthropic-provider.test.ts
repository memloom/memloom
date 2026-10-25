import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicLLM } from "./anthropic-provider.js";
import { LlmSpendError } from "./openrouter-provider.js";

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => body,
  };
}

const ok = (text: string, usage = { input_tokens: 1000, output_tokens: 200 }) =>
  reply(200, { content: [{ type: "text", text }], stop_reason: "end_turn", usage });

describe("AnthropicLLM", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("sends the Messages API request the pipeline needs", async () => {
    const fetch = vi.fn(async () => ok("[]"));
    vi.stubGlobal("fetch", fetch);

    await new AnthropicLLM({ apiKey: "k" }).complete("classify this");

    const [url, init] = fetch.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers["x-api-key"]).toBe("k");
    expect(init.headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.messages).toEqual([{ role: "user", content: "classify this" }]);
    // The API rejects sampling parameters on current models.
    expect(body.temperature).toBeUndefined();
  });

  it("joins the text blocks and prices the call from the token counts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        reply(200, {
          content: [
            { type: "text", text: '[{"a":' },
            { type: "text", text: "1}]" },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
        }),
      ),
    );
    const usages: unknown[] = [];

    const text = await new AnthropicLLM({ apiKey: "k" }).complete("x", {
      onUsage: (u) => usages.push(u),
    });

    expect(text).toBe('[{"a":1}]');
    expect(usages).toEqual([{ inputTokens: 1_000_000, outputTokens: 1_000_000, usd: 0.6 }]);
  });

  it("throws on a refusal instead of returning an empty answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        reply(200, {
          content: [],
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: "cyber" },
          usage: { input_tokens: 10, output_tokens: 0 },
        }),
      ),
    );

    await expect(new AnthropicLLM({ apiKey: "k" }).complete("x")).rejects.toThrow(/declined.*cyber/);
  });

  it("retries an overloaded API and then succeeds", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reply(529, { error: { type: "overloaded_error" } }))
      .mockResolvedValueOnce(ok("done"));
    vi.stubGlobal("fetch", fetch);

    const pending = new AnthropicLLM({ apiKey: "k" }).complete("x");
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toBe("done");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stops the run on a bad key or an empty balance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(401, { error: { message: "invalid x-api-key" } })),
    );
    await expect(new AnthropicLLM({ apiKey: "k" }).complete("x")).rejects.toBeInstanceOf(
      LlmSpendError,
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        reply(400, { error: { message: "Your credit balance is too low to access the API" } }),
      ),
    );
    await expect(new AnthropicLLM({ apiKey: "k" }).complete("x")).rejects.toMatchObject({
      code: "no_credit",
      message: expect.stringMatching(/^Anthropic is out of credit/),
    });
  });
});
