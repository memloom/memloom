import type { DedupClassifier, EmbeddingProvider, LLMProvider } from "@memloom/core";
import {
  type AnthropicEffort,
  AnthropicLLM,
  DEFAULT_JEV_MODEL,
  DEFAULT_JEV_THRESHOLD,
  HashingEmbeddingProvider,
  JevDedupClassifier,
  LlmDedupClassifier,
  NullLLMProvider,
  OpenRouterEmbeddings,
  OpenRouterLLM,
} from "@memloom/core";

// The ONE place provider and storage selection happens, shared by the daemon and
// `memloom reembed` so a maintenance command can never disagree with the daemon about which
// vector space or which store it operates on. Reads process.env (populate it with
// loadConfigEnv() first): presence of OPENROUTER_API_KEY is the cloud/offline switch, and
// presence of MEMLOOM_PG_URL is the storage-tier switch (external Postgres instead of the
// embedded PGLite data dir). MEMLOOM_LLM_PROVIDER=anthropic moves only the LLM to the Anthropic
// API; embeddings stay on OpenRouter, since Anthropic has no embeddings endpoint.
// MEMLOOM_DEDUP_PROVIDER=jev moves only the dedup label to TypeSafe's Jev decision model on
// OpenRouter, with the LLM as its fallback when Jev is unsure.

export interface EngineDeps {
  embedding: EmbeddingProvider;
  llm: LLMProvider;
  apiKey: string | undefined;
  pgUrl: string | undefined;
  embedModel: string | undefined;
  embedDims: number | undefined;
  embedProvider: string | undefined;
  llmModel: string | undefined;
  chatModel: string | undefined;
  /** Who serves the LLM. Embeddings are always OpenRouter's (or offline hashing). */
  llmProvider: "openrouter" | "anthropic";
  /** Who labels dedup candidates. Undefined means Memloom's default, the LLM classifier. */
  dedupClassifier: DedupClassifier | undefined;
  /** One line for the daemon banner, e.g. "jev (typesafe/jev-1.14 >= 0.9, fallback llm)". */
  dedupLabel: string;
  autoIndex: boolean;
}

export function buildEngineDeps(): EngineDeps {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const pgUrl = process.env.MEMLOOM_PG_URL || undefined;
  const embedModel = process.env.OPENROUTER_EMBED_MODEL;
  const embedDims = process.env.OPENROUTER_EMBED_DIMS
    ? Number(process.env.OPENROUTER_EMBED_DIMS)
    : undefined;
  // Prefer a specific OpenRouter host for embeddings (latency varies 20x between hosts of the
  // same model). Defaults to nebius for the default model (even when the config spells it out
  // explicitly). Mirrors OpenRouterEmbeddings.
  const embedProvider =
    process.env.OPENROUTER_EMBED_PROVIDER ??
    ((embedModel ?? "qwen/qwen3-embedding-8b") === "qwen/qwen3-embedding-8b"
      ? "nebius"
      : undefined);
  const anthropic = isAnthropic();
  const llmModel = anthropic
    ? (process.env.ANTHROPIC_LLM_MODEL ?? "claude-haiku-5-5")
    : process.env.OPENROUTER_LLM_MODEL;
  const chatModel = anthropic
    ? process.env.ANTHROPIC_CHAT_MODEL
    : process.env.OPENROUTER_CHAT_MODEL;
  // Auto-index needs the LLM, so offline mode never turns it on. Opt out with
  // MEMLOOM_AUTO_INDEX=off (or false/0) when every LLM call should be explicit.
  const autoIndex = !["off", "false", "0"].includes(
    (process.env.MEMLOOM_AUTO_INDEX ?? "on").toLowerCase(),
  );

  const embedding: EmbeddingProvider = apiKey
    ? new OpenRouterEmbeddings({
        apiKey,
        ...(embedModel ? { model: embedModel } : {}),
        ...(embedDims ? { dims: embedDims } : {}),
        ...(embedProvider ? { provider: embedProvider } : {}),
      })
    : new HashingEmbeddingProvider(1024);
  const llm: LLMProvider = anthropic
    ? anthropicLLM(llmModel, chatModel)
    : apiKey
      ? new OpenRouterLLM({
          apiKey,
          ...(llmModel ? { model: llmModel } : {}),
          ...(chatModel ? { chatModel } : {}),
        })
      : new NullLLMProvider();
  const dedup = dedupConfig(apiKey, llm);

  return {
    embedding,
    llm,
    apiKey,
    pgUrl,
    embedModel,
    embedDims,
    embedProvider,
    llmModel,
    chatModel,
    llmProvider: anthropic ? "anthropic" : "openrouter",
    dedupClassifier: dedup.classifier,
    dedupLabel: dedup.label,
    autoIndex,
  };
}

function dedupConfig(
  apiKey: string | undefined,
  llm: LLMProvider,
): { classifier: DedupClassifier | undefined; label: string } {
  const provider = (process.env.MEMLOOM_DEDUP_PROVIDER || "llm").trim().toLowerCase();
  if (provider !== "llm" && provider !== "jev") {
    throw new Error(
      `memloom: MEMLOOM_DEDUP_PROVIDER is "${provider}"; it takes "llm" (the default) or "jev".`,
    );
  }
  if (provider === "llm") return { classifier: undefined, label: "llm" };
  if (!apiKey) {
    throw new Error(
      "memloom: MEMLOOM_DEDUP_PROVIDER=jev needs OPENROUTER_API_KEY in your memloom config.",
    );
  }
  const model = process.env.MEMLOOM_DEDUP_JEV_MODEL?.trim() || DEFAULT_JEV_MODEL;
  const rawThreshold = process.env.MEMLOOM_DEDUP_JEV_THRESHOLD?.trim();
  const threshold = rawThreshold ? Number(rawThreshold) : DEFAULT_JEV_THRESHOLD;
  if (!(threshold > 0 && threshold <= 1)) {
    throw new Error(
      `memloom: MEMLOOM_DEDUP_JEV_THRESHOLD takes a number above 0 and at most 1; got "${rawThreshold}".`,
    );
  }
  const fallback = (process.env.MEMLOOM_DEDUP_JEV_FALLBACK || "llm").trim().toLowerCase();
  if (fallback !== "llm" && fallback !== "conflict") {
    throw new Error(
      `memloom: MEMLOOM_DEDUP_JEV_FALLBACK is "${fallback}"; it takes "llm" (the default) or "conflict".`,
    );
  }
  return {
    classifier: new JevDedupClassifier({
      apiKey,
      model,
      threshold,
      fallback: fallback === "llm" ? new LlmDedupClassifier(llm) : null,
    }),
    label: `jev (${model} at ${threshold}, unsure goes to ${fallback === "llm" ? "the LLM" : "a human"})`,
  };
}

const EFFORTS: readonly AnthropicEffort[] = ["low", "medium", "high", "xhigh", "max"];

function isAnthropic(): boolean {
  const provider = (process.env.MEMLOOM_LLM_PROVIDER || "openrouter").trim().toLowerCase();
  if (provider !== "anthropic" && provider !== "openrouter") {
    throw new Error(
      `memloom: MEMLOOM_LLM_PROVIDER is "${provider}"; it takes "openrouter" (the default) or "anthropic".`,
    );
  }
  return provider === "anthropic";
}

function anthropicLLM(model: string | undefined, chatModel: string | undefined): AnthropicLLM {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "memloom: MEMLOOM_LLM_PROVIDER=anthropic needs ANTHROPIC_API_KEY in your memloom config.",
    );
  }
  const effort = process.env.ANTHROPIC_EFFORT?.trim().toLowerCase();
  if (effort && !EFFORTS.includes(effort as AnthropicEffort)) {
    throw new Error(`memloom: ANTHROPIC_EFFORT takes ${EFFORTS.join(", ")}; got "${effort}".`);
  }
  return new AnthropicLLM({
    apiKey,
    ...(model ? { model } : {}),
    ...(chatModel ? { chatModel } : {}),
    ...(effort ? { effort: effort as AnthropicEffort } : {}),
  });
}
