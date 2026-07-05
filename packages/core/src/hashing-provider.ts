import type { EmbeddingProvider, LLMProvider } from "./providers.js";

// A deterministic, offline embedding provider used for tests and local development without an
// API key. It uses signed feature hashing over word tokens, so texts that share words get
// higher cosine similarity — a real (if crude) semantic signal that is fully reproducible.
// NOT for production recall quality; swap in a real model (OpenRouter/Ollama) for that.

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

function fnv1a(token: string): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly dims: number;

  constructor(dims = 1024) {
    this.dims = dims;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => this.#embedOne(text));
  }

  #embedOne(text: string): number[] {
    const v = new Array<number>(this.dims).fill(0);
    for (const token of tokenize(text)) {
      const h = fnv1a(token);
      const idx = h % this.dims;
      const sign = (h & 1) === 0 ? 1 : -1;
      v[idx] = (v[idx] ?? 0) + sign;
    }
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;
    return v;
  }
}

// A no-op LLM provider for phases/tests that don't exercise the LLM path yet. Throws if used,
// so an accidental dependency on the LLM surfaces loudly instead of silently misbehaving.
export class NullLLMProvider implements LLMProvider {
  async complete(): Promise<string> {
    throw new Error(
      "NullLLMProvider: no LLM configured. Inject a real LLMProvider to use this path.",
    );
  }
}

// A deterministic LLM stand-in for tests: you supply a function that turns a prompt into a
// response string, so the full parse/route path runs without a live model.
export class ScriptedLLMProvider implements LLMProvider {
  readonly #respond: (prompt: string) => string;

  constructor(respond: (prompt: string) => string) {
    this.#respond = respond;
  }

  async complete(prompt: string): Promise<string> {
    return this.#respond(prompt);
  }
}
