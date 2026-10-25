import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AnthropicLLM, anthropicCostUsd, toAnthropicMessages } from "./anthropic-provider.js";
import { LlmSpendError } from "./openrouter-provider.js";
import { estimateUsd } from "./reconcile.js";

// A local stand-in for the Messages API, so the request body memloom sends and the way it reads
// the answer are both pinned without a key or a network.

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function fakeApi(
  reply: (body: Record<string, unknown>) => { status: number; json: unknown },
): Promise<{ baseUrl: string; bodies: Record<string, unknown>[] }> {
  const bodies: Record<string, unknown>[] = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      bodies.push(body);
      const { status, json } = reply(body);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, bodies };
}

const message = (content: unknown[], usage = { input_tokens: 1000, output_tokens: 200 }) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-haiku-5-5",
  content,
  stop_reason: "end_turn",
  stop_sequence: null,
  usage,
});

describe("AnthropicLLM.complete", () => {
  it("asks Haiku 5.5 at low effort, returns only the text, and prices the call", async () => {
    const api = await fakeApi(() => ({
      status: 200,
      json: message([
        { type: "thinking", thinking: "", signature: "s" },
        { type: "text", text: '{"ok":true}' },
      ]),
    }));
    const llm = new AnthropicLLM({ apiKey: "k", baseUrl: api.baseUrl });
    let usd: number | null = null;
    const text = await llm.complete("classify this", { onUsage: (u) => (usd = u.usd) });

    expect(text).toBe('{"ok":true}');
    expect(usd).toBeCloseTo((1000 * 0.1 + 200 * 0.5) / 1_000_000, 12);
    const body = api.bodies[0] as Record<string, unknown>;
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.output_config).toEqual({ effort: "low" });
    expect(body).not.toHaveProperty("temperature");
    expect(llm.model).toBe("claude-haiku-5-5");
  });

  it("stops a run on a rejected key or an empty balance instead of skipping the item", async () => {
    const unauthorized = await fakeApi(() => ({
      status: 401,
      json: {
        type: "error",
        error: { type: "authentication_error", message: "invalid x-api-key" },
      },
    }));
    const err = await new AnthropicLLM({ apiKey: "k", baseUrl: unauthorized.baseUrl })
      .complete("x")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmSpendError);
    expect((err as LlmSpendError).code).toBe("unauthorized");
    expect((err as Error).message).toMatch(/^Anthropic rejected the API key/);
    server?.close();

    const broke = await fakeApi(() => ({
      status: 400,
      json: {
        type: "error",
        error: { type: "invalid_request_error", message: "Your credit balance is too low" },
      },
    }));
    const err2 = await new AnthropicLLM({ apiKey: "k", baseUrl: broke.baseUrl })
      .complete("x")
      .catch((e: unknown) => e);
    expect((err2 as LlmSpendError).code).toBe("no_credit");
  });

  it("throws on a refusal instead of returning an empty answer", async () => {
    const api = await fakeApi(() => ({
      status: 200,
      json: {
        ...message([]),
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "cyber", explanation: null },
      },
    }));
    await expect(
      new AnthropicLLM({ apiKey: "k", baseUrl: api.baseUrl }).complete("x"),
    ).rejects.toThrow(/declined the completion \(cyber\)/);
  });
});

describe("AnthropicLLM.chat", () => {
  it("maps tools both ways and ignores an OpenRouter model id from the picker", async () => {
    const api = await fakeApi(() => ({
      status: 200,
      json: message([{ type: "tool_use", id: "tu_1", name: "recall", input: { query: "kids" } }]),
    }));
    const llm = new AnthropicLLM({
      apiKey: "k",
      baseUrl: api.baseUrl,
      chatModel: "claude-sonnet-5-5",
    });
    const result = await llm.chat([{ role: "user", content: "who are my kids?" }], {
      tools: [{ name: "recall", description: "search", parameters: { type: "object" } }],
      model: "google/gemini-2.5-flash",
    });

    expect(result).toEqual({
      content: null,
      toolCalls: [{ id: "tu_1", name: "recall", arguments: '{"query":"kids"}' }],
    });
    const body = api.bodies[0] as Record<string, unknown>;
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(body.tools).toEqual([
      { name: "recall", description: "search", input_schema: { type: "object" } },
    ]);
    expect(body.tool_choice).toEqual({ type: "auto" });
  });
});

describe("toAnthropicMessages", () => {
  it("lifts system turns and keeps a run of tool results in one user message", () => {
    const { system, messages } = toAnthropicMessages([
      { role: "system", content: "be brief" },
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          { id: "a", name: "recall", arguments: '{"query":"x"}' },
          { id: "b", name: "recall", arguments: "not json" },
        ],
      },
      { role: "tool", toolCallId: "a", content: "r1" },
      { role: "tool", toolCallId: "b", content: "r2" },
    ]);
    expect(system).toBe("be brief");
    expect(messages).toEqual([
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "a", name: "recall", input: { query: "x" } },
          { type: "tool_use", id: "b", name: "recall", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: "r1" },
          { type: "tool_result", tool_use_id: "b", content: "r2" },
        ],
      },
    ]);
  });
});

describe("anthropicCostUsd", () => {
  it("bills long prompts at the long rate and leaves unknown models unpriced", () => {
    expect(anthropicCostUsd("claude-haiku-5-5", 200_000, 1_000)).toBeCloseTo(
      (200_000 * 0.5 + 1_000 * 2.5) / 1_000_000,
      12,
    );
    expect(anthropicCostUsd("claude-something-new", 10, 10)).toBeNull();
  });

  it("prices a reconcile dry run on a Claude model", () => {
    expect(estimateUsd("claude-haiku-5-5", 50_000, 10_000)).toBeCloseTo(0.01, 12);
  });
});
