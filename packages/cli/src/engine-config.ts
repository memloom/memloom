import type {
  ChatMessage,
  ChatProvider,
  ChatResult,
  ChatTool,
  EmbeddingProvider,
  LLMProvider,
  LlmUsage,
} from "@memloom/core";
import {
  AnthropicLLM,
  HashingEmbeddingProvider,
  NullLLMProvider,
  OpenRouterEmbeddings,
  OpenRouterLLM,
} from "@memloom/core";

// The ONE place provider and storage selection happens, shared by the daemon and
// `memloom reembed` so a maintenance command can never disagree with the daemon about which
// vector space or which store it operates on. Reads process.env (populate it with
// loadConfigEnv() first): presence of OPENROUTER_API_KEY is the cloud/offline switch, and
// presence of MEMLOOM_PG_URL is the storage-tier switch (external Postgres instead of the
// embedded PGLite data dir).

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
  /** Set when ANTHROPIC_API_KEY moves the pipeline's completions to the Anthropic API. */
  anthropicModel: string | undefined;
  autoIndex: boolean;
}

/**
 * Completions from one provider, the assistant's chat from another. The pipeline (dedup,
 * extraction, re-checks) is completion-only and can bill to an Anthropic account, while the
 * assistant keeps its OpenRouter chat with tool calling and the viewer's model picker.
 */
class SplitLLM implements LLMProvider, ChatProvider {
  constructor(
    readonly pipeline: AnthropicLLM,
    readonly chatter: ChatProvider,
  ) {}

  /** Read by reconciliation to price a run, so it names the model that does the spending. */
  get model(): string {
    return this.pipeline.model;
  }

  complete(prompt: string, opts?: { onUsage?: (usage: LlmUsage) => void }): Promise<string> {
    return this.pipeline.complete(prompt, opts);
  }

  chat(
    messages: ChatMessage[],
    opts?: { tools?: ChatTool[]; toolChoice?: "auto" | "none"; model?: string },
  ): Promise<ChatResult> {
    return this.chatter.chat(messages, opts);
  }

  chatStream(
    messages: ChatMessage[],
    onDelta: (text: string) => void,
    opts?: { tools?: ChatTool[]; model?: string },
  ): Promise<string> {
    return this.chatter.chatStream(messages, onDelta, opts);
  }
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
  const llmModel = process.env.OPENROUTER_LLM_MODEL;
  const chatModel = process.env.OPENROUTER_CHAT_MODEL;
  // Only in cloud mode: embeddings still come from OpenRouter, and offline mode has no LLM.
  const anthropicKey = apiKey ? process.env.ANTHROPIC_API_KEY?.trim() || undefined : undefined;
  const anthropicModel = anthropicKey
    ? process.env.ANTHROPIC_LLM_MODEL?.trim() || "claude-haiku-5-5"
    : undefined;
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
  const openRouterLlm = apiKey
    ? new OpenRouterLLM({
        apiKey,
        ...(llmModel ? { model: llmModel } : {}),
        ...(chatModel ? { chatModel } : {}),
      })
    : undefined;
  const llm: LLMProvider = !openRouterLlm
    ? new NullLLMProvider()
    : anthropicKey
      ? new SplitLLM(
          new AnthropicLLM({ apiKey: anthropicKey, ...(anthropicModel ? { model: anthropicModel } : {}) }),
          openRouterLlm,
        )
      : openRouterLlm;

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
    anthropicModel,
    autoIndex,
  };
}
