import { LlmSpendError } from "./openrouter-provider.js";
import type { LLMProvider, LlmUsage } from "./providers.js";
import { estimateUsd } from "./reconcile.js";

// The pipeline's completions (dedup verdicts, entity extraction, conflict re-checks,
// distillation) sent straight to the Anthropic API, so they bill against an Anthropic account
// instead of OpenRouter credit. Completion only: the assistant's chat stays on OpenRouter, and
// embeddings too, because Anthropic has no embeddings endpoint.

const ANTHROPIC_BASE = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";
const REQUEST_TIMEOUT_MS = 60_000;
// Same ceiling as OpenRouterLLM: pipeline replies are a few hundred tokens, and a cap keeps one
// runaway reply from costing more than a whole batch.
const MAX_COMPLETION_TOKENS = 8_192;
const MAX_ATTEMPTS = 4;
// 529 is Anthropic's "overloaded", which is worth the same backoff as a 503.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const BACKOFF_BASE_MS = 1_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function backoffMs(attempt: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds && Number.isFinite(retryAfterSeconds)) {
    return Math.min(retryAfterSeconds * 1000, 30_000);
  }
  return BACKOFF_BASE_MS * 2 ** (attempt - 1) + Math.random() * 250;
}

export interface AnthropicLLMOptions {
  apiKey: string;
  /** Default claude-haiku-5-5: the pipeline is classification and extraction. */
  model?: string;
  baseUrl?: string;
}

interface MessagesResponse {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
  stop_details?: { category?: string | null; explanation?: string } | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class AnthropicLLM implements LLMProvider {
  readonly #apiKey: string;
  readonly #model: string;
  readonly #baseUrl: string;

  constructor(opts: AnthropicLLMOptions) {
    this.#apiKey = opts.apiKey;
    this.#model = opts.model ?? "claude-haiku-5-5";
    this.#baseUrl = opts.baseUrl ?? ANTHROPIC_BASE;
  }

  /** The completion model's id. Read by reconciliation to price a run it has not spent yet. */
  get model(): string {
    return this.#model;
  }

  /**
   * Thinking is turned off: every caller wants a short structured answer, and thinking tokens
   * bill as output. There is no temperature 0 to pin, as OpenRouterLLM does, because the
   * Messages API rejects sampling parameters on current models.
   */
  async complete(
    prompt: string,
    opts: { onUsage?: (usage: LlmUsage) => void } = {},
  ): Promise<string> {
    const json = await this.#post({
      model: this.#model,
      max_tokens: MAX_COMPLETION_TOKENS,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: prompt }],
    });
    if (!Array.isArray(json.content)) {
      throw new Error(
        `Anthropic completion from ${this.#model} had no content: ${JSON.stringify(json).slice(0, 300)}`,
      );
    }
    if (opts.onUsage) {
      const inputTokens = Number(json.usage?.input_tokens ?? 0);
      const outputTokens = Number(json.usage?.output_tokens ?? 0);
      opts.onUsage({
        inputTokens,
        outputTokens,
        usd: estimateUsd(this.#model, inputTokens, outputTokens),
      });
    }
    // A declined request is a failure, not an empty answer: an empty reply reads as "no
    // entities" or "no conflict" to every caller, and the item would be marked done unjudged.
    if (json.stop_reason === "refusal") {
      const why = json.stop_details?.category ?? json.stop_details?.explanation ?? "no reason given";
      throw new Error(`Anthropic ${this.#model} declined the completion (${why})`);
    }
    return json.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  }

  async #post(body: unknown): Promise<MessagesResponse> {
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${this.#baseUrl}/messages`, {
          method: "POST",
          headers: {
            "x-api-key": this.#apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        if (err instanceof Error && err.name === "TimeoutError") {
          throw new Error(`Anthropic completion timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
        }
        if (attempt >= MAX_ATTEMPTS) {
          const cause = (err as { cause?: { code?: string } })?.cause?.code;
          throw new Error(
            `Anthropic completion failed after ${MAX_ATTEMPTS} attempts: ` +
              `${err instanceof Error ? err.message : String(err)}${cause ? ` (${cause})` : ""}`,
          );
        }
        await sleep(backoffMs(attempt));
        continue;
      }
      if (res.ok) return (await res.json()) as MessagesResponse;

      if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await res.text().catch(() => "");
        await sleep(backoffMs(attempt, retryAfter));
        continue;
      }
      const detail = (await res.text()).slice(0, 300);
      // Anthropic reports an empty balance as a 400 whose message names the credit balance.
      if (res.status === 402 || (res.status === 400 && /credit balance/i.test(detail))) {
        throw new LlmSpendError("no_credit", detail, "Anthropic");
      }
      if (res.status === 401 || res.status === 403) {
        throw new LlmSpendError("unauthorized", detail, "Anthropic");
      }
      throw new Error(`Anthropic completion failed: ${res.status} ${detail}`);
    }
  }
}
