import type {
  ChatMessage,
  ChatProvider,
  ChatResult,
  ChatTool,
  ChatToolCall,
  EmbeddingProvider,
  LLMProvider,
} from "./providers.js";

// Real cloud providers via OpenRouter (OpenAI-compatible endpoints). BYO key. These are the
// production defaults; local models (Ollama) can implement the same interfaces later.

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const EMBED_BATCH = 64;
// Without a deadline, a stalled provider call hangs a save/recall forever (and the daemon's
// request never completes, so nothing surfaces in the log). Fail loudly instead.
const REQUEST_TIMEOUT_MS = 60_000;

async function postJson(url: string, apiKey: string, body: unknown, what: string) {
  let res: { ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> };
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(`OpenRouter ${what} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`OpenRouter ${what} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export interface OpenRouterEmbeddingsOptions {
  apiKey: string;
  model?: string;
  dims?: number;
  baseUrl?: string;
  /**
   * OpenRouter provider slug to prefer (e.g. "nebius"), with fallbacks allowed. Embedding
   * latency varies wildly between providers for the same model (DeepInfra has been seen taking
   * 16s where Nebius takes well under a second), so pinning matters.
   */
  provider?: string;
}

export class OpenRouterEmbeddings implements EmbeddingProvider {
  readonly dims: number;
  readonly fingerprint: string;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #baseUrl: string;
  readonly #provider: string | undefined;

  constructor(opts: OpenRouterEmbeddingsOptions) {
    this.#apiKey = opts.apiKey;
    this.#model = opts.model ?? "qwen/qwen3-embedding-8b";
    // qwen3-embedding-8b is natively 4096 but supports Matryoshka truncation: we request
    // `dimensions` in the embed call, so 1024 is real, smaller, and proven. Override for a
    // model with different support; the schema follows this value at init.
    this.dims = opts.dims ?? 1024;
    this.#baseUrl = opts.baseUrl ?? OPENROUTER_BASE;
    // For the default model we know Nebius is the fast host; a different model gets no
    // preference unless the caller states one. Keyed by VALUE, not absence — configs often
    // spell out the default model explicitly.
    this.#provider =
      opts.provider ?? (this.#model === "qwen/qwen3-embedding-8b" ? "nebius" : undefined);
    // The routing host doesn't change the vector space — model + dims do.
    this.fingerprint = `openrouter:${this.#model}@${this.dims}`;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH);
      const json = (await postJson(
        `${this.#baseUrl}/embeddings`,
        this.#apiKey,
        {
          model: this.#model,
          input: batch,
          dimensions: this.dims,
          ...(this.#provider
            ? { provider: { order: [this.#provider], allow_fallbacks: true } }
            : {}),
        },
        "embeddings",
      )) as { data: { embedding: number[] }[] };
      for (const item of json.data) out.push(item.embedding);
    }
    return out;
  }
}

export interface OpenRouterLLMOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Model for the assistant's chat turns; defaults to `model`. Must support tool calling. */
  chatModel?: string;
}

// OpenRouter's wire shape for messages/tools (OpenAI-compatible, snake_case).
interface WireToolCall {
  id: string;
  type: string;
  function?: { name?: string; arguments?: string };
}

function toWireMessages(messages: ChatMessage[]) {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.toolCalls
      ? {
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          })),
        }
      : {}),
    ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
  }));
}

function fromWireToolCalls(calls: WireToolCall[] | undefined): ChatToolCall[] {
  return (calls ?? [])
    .filter((c) => c.type === "function" && c.function?.name)
    .map((c) => ({
      id: c.id,
      name: c.function?.name ?? "",
      arguments: c.function?.arguments ?? "{}",
    }));
}

export class OpenRouterLLM implements LLMProvider, ChatProvider {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #chatModel: string;
  readonly #baseUrl: string;

  constructor(opts: OpenRouterLLMOptions) {
    this.#apiKey = opts.apiKey;
    this.#model = opts.model ?? "google/gemini-2.5-flash";
    this.#chatModel = opts.chatModel ?? this.#model;
    this.#baseUrl = opts.baseUrl ?? OPENROUTER_BASE;
  }

  async complete(prompt: string): Promise<string> {
    const json = (await postJson(
      `${this.#baseUrl}/chat/completions`,
      this.#apiKey,
      { model: this.#model, messages: [{ role: "user", content: prompt }] },
      "completion",
    )) as { choices: { message: { content: string } }[] };
    return json.choices[0]?.message.content ?? "";
  }

  async chat(
    messages: ChatMessage[],
    opts: { tools?: ChatTool[]; toolChoice?: "auto" | "none" } = {},
  ): Promise<ChatResult> {
    let json: unknown;
    try {
      json = await postJson(
        `${this.#baseUrl}/chat/completions`,
        this.#apiKey,
        {
          model: this.#chatModel,
          messages: toWireMessages(messages),
          ...(opts.tools
            ? {
                tools: opts.tools.map((t) => ({
                  type: "function",
                  function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                  },
                })),
                tool_choice: opts.toolChoice ?? "auto",
              }
            : {}),
        },
        "chat",
      );
    } catch (err) {
      // OpenRouter answers 404 "No endpoints found that support tool use" for models
      // without native tool calling. Name the fix instead of leaking the raw error.
      const message = err instanceof Error ? err.message : String(err);
      if (opts.tools && /support tool use|404/.test(message)) {
        throw new Error(
          `the model "${this.#chatModel}" does not support tool calling on OpenRouter. ` +
            "Set OPENROUTER_CHAT_MODEL to a tool-capable model (e.g. google/gemini-2.5-flash).",
        );
      }
      throw err;
    }
    const choice = (
      json as { choices: { message: { content: string | null; tool_calls?: WireToolCall[] } }[] }
    ).choices[0];
    return {
      content: choice?.message.content ?? null,
      toolCalls: fromWireToolCalls(choice?.message.tool_calls),
    };
  }

  async chatStream(messages: ChatMessage[], onDelta: (text: string) => void): Promise<string> {
    const res = await fetch(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.#apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.#chatModel,
        messages: toWireMessages(messages),
        stream: true,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 3), // long answers stream slowly
    });
    if (!res.ok) throw new Error(`OpenRouter chat failed: ${res.status} ${await res.text()}`);
    if (!res.body) throw new Error("OpenRouter chat: no response body to stream");

    // OpenAI-style SSE: "data: {json}\n\n" lines, terminated by "data: [DONE]".
    let full = "";
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const handleLine = (line: string) => {
      const data = line.startsWith("data: ") ? line.slice(6).trim() : null;
      if (!data || data === "[DONE]") return;
      try {
        const chunk = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
        const text = chunk.choices?.[0]?.delta?.content;
        if (text) {
          full += text;
          onDelta(text);
        }
      } catch {
        // keep-alive comments / partial noise: ignore
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        handleLine(buffer.slice(0, newline).trim());
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    handleLine(buffer.trim());
    return full;
  }
}
