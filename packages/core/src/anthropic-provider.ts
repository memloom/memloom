import Anthropic from "@anthropic-ai/sdk";
import { LlmSpendError } from "./openrouter-provider.js";
import type {
  ChatMessage,
  ChatProvider,
  ChatResult,
  ChatTool,
  ChatToolCall,
  LLMProvider,
  LlmUsage,
} from "./providers.js";

// Claude through the Anthropic API directly, for people who hold Anthropic API credit (a Max
// plan's monthly credit, say) and would rather spend that than OpenRouter's. It replaces only the
// LLM: Anthropic has no embeddings endpoint, so vectors still come from OpenRouter or the offline
// hashing provider.

const DEFAULT_MODEL = "claude-haiku-5-5";
// Thinking counts against max_tokens, so this leaves room for it on top of the pipeline replies
// (distillation arrays, dedup verdicts, entity JSON) that OpenRouter's 8,192 already fits.
const MAX_TOKENS = 16_000;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 3;

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

// The API reports tokens, not dollars, so a budget needs prices. Per million tokens, input then
// output. A model missing here reports no cost, and reconciliation then runs one page and stops
// rather than spending against a budget it cannot measure.
const PRICES: Record<
  string,
  { input: number; output: number; longInput?: number; longOutput?: number }
> = {
  // Prompts above 100K tokens bill at the long rate.
  "claude-haiku-5-5": { input: 0.1, output: 0.5, longInput: 0.5, longOutput: 2.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
};
const LONG_PROMPT_TOKENS = 100_000;

export function anthropicCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const price = PRICES[model];
  if (!price) return null;
  const long = inputTokens > LONG_PROMPT_TOKENS;
  const input = long ? (price.longInput ?? price.input) : price.input;
  const output = long ? (price.longOutput ?? price.output) : price.output;
  return (inputTokens * input + outputTokens * output) / 1_000_000;
}

export interface AnthropicLLMOptions {
  apiKey: string;
  /** Default claude-haiku-5-5. */
  model?: string;
  /** Model for the assistant's chat turns; defaults to `model`. */
  chatModel?: string;
  /**
   * Effort for complete(), the pipeline's classifiers and extractors. Default low: they want a
   * short structured answer, and thinking is billed as output.
   */
  effort?: AnthropicEffort;
  baseUrl?: string;
}

/** Turn the API's billing and key failures into the error that stops a run instead of skipping. */
function rethrow(err: unknown): never {
  if (err instanceof Anthropic.APIError) {
    const detail = err.message.slice(0, 300);
    if (err.status === 401) throw new LlmSpendError("unauthorized", detail, "Anthropic");
    if (err.status === 402 || (err.status === 400 && /credit balance/i.test(err.message))) {
      throw new LlmSpendError("no_credit", detail, "Anthropic");
    }
  }
  throw err;
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function toolCallsOf(content: Anthropic.ContentBlock[]): ChatToolCall[] {
  return content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) }));
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The provider-neutral chat history in the Messages API's shape. System turns move to the
 * top-level system prompt, and each run of tool results becomes one user message, since results
 * split across messages teach the model to stop calling tools in parallel.
 */
export function toAnthropicMessages(messages: ChatMessage[]): {
  system: string | undefined;
  messages: Anthropic.MessageParam[];
} {
  const system: string[] = [];
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      if (m.content) system.push(m.content);
    } else if (m.role === "tool") {
      const result: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: m.toolCallId ?? "",
        content: m.content ?? "",
      };
      const last = out[out.length - 1];
      if (
        last?.role === "user" &&
        Array.isArray(last.content) &&
        last.content.every((b) => b.type === "tool_result")
      ) {
        last.content.push(result);
      } else {
        out.push({ role: "user", content: [result] });
      }
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const call of m.toolCalls) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: parseArguments(call.arguments),
        });
      }
      out.push({ role: "assistant", content: blocks });
    } else {
      out.push({ role: m.role, content: m.content ?? "" });
    }
  }
  return { system: system.length ? system.join("\n\n") : undefined, messages: out };
}

/**
 * The viewer's model picker lists OpenRouter ids ("google/gemini-2.5-flash"), which mean nothing
 * here. Only a Claude model id overrides the configured chat model.
 */
function claudeModelOr(override: string | undefined, fallback: string): string {
  return override?.startsWith("claude-") ? override : fallback;
}

function toAnthropicTools(tools: ChatTool[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool.InputSchema,
  }));
}

export class AnthropicLLM implements LLMProvider, ChatProvider {
  readonly #client: Anthropic;
  readonly #model: string;
  readonly #chatModel: string;
  readonly #effort: AnthropicEffort;

  constructor(opts: AnthropicLLMOptions) {
    this.#client = new Anthropic({
      apiKey: opts.apiKey,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: MAX_RETRIES,
      ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
    });
    this.#model = opts.model ?? DEFAULT_MODEL;
    this.#chatModel = opts.chatModel ?? this.#model;
    this.#effort = opts.effort ?? "low";
  }

  /** The completion model's id. Read by reconciliation to price a run it has not spent yet. */
  get model(): string {
    return this.#model;
  }

  async complete(
    prompt: string,
    opts: { onUsage?: (usage: LlmUsage) => void } = {},
  ): Promise<string> {
    let message: Anthropic.Message;
    try {
      message = await this.#client.messages.create({
        model: this.#model,
        max_tokens: MAX_TOKENS,
        output_config: { effort: this.#effort },
        messages: [{ role: "user", content: prompt }],
      });
    } catch (err) {
      rethrow(err);
    }
    if (opts.onUsage) {
      const inputTokens = message.usage.input_tokens;
      const outputTokens = message.usage.output_tokens;
      opts.onUsage({
        inputTokens,
        outputTokens,
        usd: anthropicCostUsd(this.#model, inputTokens, outputTokens),
      });
    }
    // A declined request is a failure, not an empty answer: every caller reads empty text as
    // "no entities" or "no conflict", and the item would be marked done without being judged.
    if (message.stop_reason === "refusal") {
      const why = message.stop_details?.category ?? message.stop_details?.explanation;
      throw new Error(
        `Anthropic ${this.#model} declined the completion (${why ?? "no reason given"})`,
      );
    }
    return textOf(message.content);
  }

  async chat(
    messages: ChatMessage[],
    opts: { tools?: ChatTool[]; toolChoice?: "auto" | "none"; model?: string } = {},
  ): Promise<ChatResult> {
    const { system, messages: wire } = toAnthropicMessages(messages);
    let message: Anthropic.Message;
    try {
      message = await this.#client.messages.create({
        model: claudeModelOr(opts.model, this.#chatModel),
        max_tokens: MAX_TOKENS,
        ...(system ? { system } : {}),
        messages: wire,
        ...(opts.tools
          ? {
              tools: toAnthropicTools(opts.tools),
              tool_choice: { type: opts.toolChoice ?? "auto" },
            }
          : {}),
      });
    } catch (err) {
      rethrow(err);
    }
    const text = textOf(message.content);
    return { content: text || null, toolCalls: toolCallsOf(message.content) };
  }

  async chatStream(
    messages: ChatMessage[],
    onDelta: (text: string) => void,
    opts: { tools?: ChatTool[]; model?: string } = {},
  ): Promise<string> {
    const { system, messages: wire } = toAnthropicMessages(messages);
    try {
      const stream = this.#client.messages.stream({
        model: claudeModelOr(opts.model, this.#chatModel),
        max_tokens: MAX_TOKENS,
        ...(system ? { system } : {}),
        messages: wire,
        // The history can hold tool calls and results, which need their tools declared.
        ...(opts.tools
          ? { tools: toAnthropicTools(opts.tools), tool_choice: { type: "none" as const } }
          : {}),
      });
      stream.on("text", (delta) => onDelta(delta));
      return textOf((await stream.finalMessage()).content);
    } catch (err) {
      rethrow(err);
    }
  }
}
