import type { EmbeddingProvider, LLMProvider } from "./providers.js";

// Real cloud providers via OpenRouter (OpenAI-compatible endpoints). BYO key. These are the
// production defaults; local models (Ollama) can implement the same interfaces later.

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const EMBED_BATCH = 64;

export interface OpenRouterEmbeddingsOptions {
  apiKey: string;
  model?: string;
  dims?: number;
  baseUrl?: string;
}

export class OpenRouterEmbeddings implements EmbeddingProvider {
  readonly dims: number;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #baseUrl: string;

  constructor(opts: OpenRouterEmbeddingsOptions) {
    this.#apiKey = opts.apiKey;
    this.#model = opts.model ?? "qwen/qwen3-embedding-8b";
    // qwen3-embedding-8b is natively 4096 but supports Matryoshka truncation: we request
    // `dimensions` in the embed call, so 1024 is real, smaller, and proven. Override for a
    // model with different support; the schema follows this value at init.
    this.dims = opts.dims ?? 1024;
    this.#baseUrl = opts.baseUrl ?? OPENROUTER_BASE;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH);
      const res = await fetch(`${this.#baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: this.#model, input: batch, dimensions: this.dims }),
      });
      if (!res.ok) {
        throw new Error(`OpenRouter embeddings failed: ${res.status} ${await res.text()}`);
      }
      const json = (await res.json()) as { data: { embedding: number[] }[] };
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
    const res = await fetch(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.#model,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenRouter completion failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    return json.choices[0]?.message.content ?? "";
  }
}
