// Provider interfaces so the LLM and embedding backends are pluggable (build-plan:
// cloud/OpenRouter first, local/Ollama later). Core depends only on these shapes.

export interface EmbeddingProvider {
  /** Embedding dimensionality; validated against the schema's vector(N) columns. */
  readonly dims: number;
  /**
   * Identifies the vector space this provider produces (e.g. "openrouter:qwen/qwen3-embedding-8b@1024").
   * Stored in the store's meta table on first init; a later init with a different fingerprint
   * is refused — mixing embedding spaces makes similarity silently meaningless.
   */
  readonly fingerprint: string;
  /** Embed a batch of documents/queries. Implementations batch upstream (e.g. 64/call). */
  embed(texts: readonly string[]): Promise<number[][]>;
}

export interface LLMProvider {
  /** Return the model's text completion for a prompt. Structured-JSON helpers layer on top. */
  complete(prompt: string): Promise<string>;
}

// Chat is a separate, optional capability: the assistant needs multi-turn messages with
// native tool calling and streaming, which extraction/dedup never do. A provider that
// only implements complete() (NullLLMProvider in offline mode) simply has no assistant.

export interface ChatToolCall {
  id: string;
  name: string;
  /** Raw JSON string of arguments, exactly as the model produced it. */
  arguments: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** null on assistant tool-call turns: some backends reject an empty string there. */
  content: string | null;
  toolCalls?: ChatToolCall[];
  /** Set on role "tool": which call this message answers. */
  toolCallId?: string;
}

export interface ChatTool {
  name: string;
  description: string;
  /** JSON schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ChatResult {
  content: string | null;
  toolCalls: ChatToolCall[];
}

export interface ChatProvider {
  /**
   * One non-streaming turn. The assistant's tool-gather rounds. `model` overrides the
   * provider's configured chat model for this call only (the viewer's model picker).
   */
  chat(
    messages: ChatMessage[],
    opts?: { tools?: ChatTool[]; toolChoice?: "auto" | "none"; model?: string },
  ): Promise<ChatResult>;
  /**
   * Streaming turn for the assistant's final grounded answer. `tools` must still be
   * declared (with tool choice forced off) when the message history contains tool
   * calls/results: some backends (Gemini via OpenRouter) drop function-call history
   * whose declarations are missing, which silently blinds the model to tool results.
   */
  chatStream(
    messages: ChatMessage[],
    onDelta: (text: string) => void,
    opts?: { tools?: ChatTool[]; model?: string },
  ): Promise<string>;
}

export function isChatProvider(llm: unknown): llm is ChatProvider {
  return (
    typeof llm === "object" &&
    llm !== null &&
    typeof (llm as ChatProvider).chat === "function" &&
    typeof (llm as ChatProvider).chatStream === "function"
  );
}
