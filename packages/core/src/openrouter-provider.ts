import type { EmbeddingProvider, LLMProvider } from "./providers.js";

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
    // For the default model we know Nebius is the fast host; a custom model gets no preference
    // unless the caller states one.
    this.#provider = opts.provider ?? (opts.model === undefined ? "nebius" : undefined);
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
}

export class OpenRouterLLM implements LLMProvider {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #baseUrl: string;

  constructor(opts: OpenRouterLLMOptions) {
    this.#apiKey = opts.apiKey;
    this.#model = opts.model ?? "google/gemini-2.5-flash";
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
}
