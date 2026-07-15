import type { EmbeddingProvider, LLMProvider } from "@memloom/core";
import {
  HashingEmbeddingProvider,
  NullLLMProvider,
  OpenRouterEmbeddings,
  OpenRouterLLM,
} from "@memloom/core";

// The ONE place provider selection happens, shared by the daemon and `memloom reembed` so a
// maintenance command can never disagree with the daemon about which vector space the store
// should be in. Reads process.env (populate it with loadConfigEnv() first): presence of
// OPENROUTER_API_KEY is the cloud/offline switch.

export interface EngineDeps {
  embedding: EmbeddingProvider;
  llm: LLMProvider;
  apiKey: string | undefined;
  embedModel: string | undefined;
  embedDims: number | undefined;
  embedProvider: string | undefined;
  llmModel: string | undefined;
  chatModel: string | undefined;
  autoIndex: boolean;
}

export function buildEngineDeps(): EngineDeps {
  const apiKey = process.env.OPENROUTER_API_KEY;
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
  const llmModel = process.env.OPENROUTER_LLM_MODEL;
  const chatModel = process.env.OPENROUTER_CHAT_MODEL;
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
  const llm: LLMProvider = apiKey
    ? new OpenRouterLLM({
        apiKey,
        ...(llmModel ? { model: llmModel } : {}),
        ...(chatModel ? { chatModel } : {}),
      })
    : new NullLLMProvider();

  return {
    embedding,
    llm,
    apiKey,
    embedModel,
    embedDims,
    embedProvider,
    llmModel,
    chatModel,
    autoIndex,
  };
}
