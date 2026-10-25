import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ClaudeCliLLM } from "../../packages/core/src/claude-cli-provider.js";
import { ScriptedLLMProvider } from "../../packages/core/src/hashing-provider.js";
import { OpenRouterLLM } from "../../packages/core/src/openrouter-provider.js";
import type { LLMProvider, LlmUsage } from "../../packages/core/src/providers.js";

// Provider selection for the eval. "claude-cli" is the default: it runs on a Claude
// subscription through `claude -p` and costs nothing per call. "openrouter" is the model
// memloom ships with (gemini-2.5-flash) and spends real credits, so it carries a hard USD cap.

export type ProviderName = "claude-cli" | "openrouter" | "empty";

export interface Metered extends LLMProvider {
  readonly label: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly usd: number;
}

class MeteredProvider implements Metered {
  readonly label: string;
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  usd = 0;
  readonly #inner: LLMProvider;
  readonly #maxUsd: number | undefined;

  constructor(label: string, inner: LLMProvider, maxUsd?: number) {
    this.label = label;
    this.#inner = inner;
    this.#maxUsd = maxUsd;
  }

  async complete(prompt: string, opts: { onUsage?: (u: LlmUsage) => void } = {}): Promise<string> {
    if (this.#maxUsd !== undefined && this.usd >= this.#maxUsd) {
      throw new Error(
        `eval budget spent: $${this.usd.toFixed(3)} of the $${this.#maxUsd} cap (${this.calls} calls)`,
      );
    }
    this.calls++;
    return this.#inner.complete(prompt, {
      onUsage: (u) => {
        this.inputTokens += u.inputTokens;
        this.outputTokens += u.outputTokens;
        this.usd += u.usd ?? 0;
        opts.onUsage?.(u);
      },
    });
  }
}

/** OPENROUTER_API_KEY from the environment, else from ~/.memloom/config.env. */
export function openRouterKey(): string {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const path = join(process.env.MEMLOOM_HOME ?? join(homedir(), ".memloom"), "config.env");
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = /^\s*OPENROUTER_API_KEY\s*=\s*(.+?)\s*$/.exec(line);
      if (m?.[1]) return m[1].replace(/^["']|["']$/g, "");
    }
  } catch {
    // no config file: fall through to the error below
  }
  throw new Error(`OPENROUTER_API_KEY is not set and ${path} does not define it`);
}

export const DEFAULT_MODELS: Record<ProviderName, { distill: string; judge: string }> = {
  // haiku is the production-tier stand-in; the judge is a different model on purpose.
  "claude-cli": { distill: "haiku", judge: "sonnet" },
  // gemini-2.5-flash is memloom's shipped default; the judge is a different vendor.
  openrouter: { distill: "google/gemini-2.5-flash", judge: "openai/gpt-4.1-mini" },
  empty: { distill: "empty", judge: "empty" },
};

export function buildProvider(
  name: ProviderName,
  model: string,
  opts: { maxUsd?: number; concurrency?: number } = {},
): Metered {
  switch (name) {
    case "claude-cli":
      return new MeteredProvider(
        `claude-cli:${model}`,
        new ClaudeCliLLM({ model, concurrency: opts.concurrency ?? 3 }),
      );
    case "openrouter":
      return new MeteredProvider(
        `openrouter:${model}`,
        new OpenRouterLLM({ apiKey: openRouterKey(), model }),
        opts.maxUsd,
      );
    case "empty":
      // Smoke-test provider: distills nothing, judges nothing. Exercises the harness only.
      return new MeteredProvider("empty", new ScriptedLLMProvider(() => "[]"));
  }
}
