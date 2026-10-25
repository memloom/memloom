import { AnthropicLLM, OpenRouterLLM } from "@memloom/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEngineDeps } from "./engine-config.js";

// Which LLM the daemon gets is decided here and nowhere else, so the switch is pinned here.

afterEach(() => vi.unstubAllEnvs());

describe("LLM provider selection", () => {
  it("keeps OpenRouter by default", () => {
    vi.stubEnv("MEMLOOM_LLM_PROVIDER", "");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or");
    const deps = buildEngineDeps();
    expect(deps.llm).toBeInstanceOf(OpenRouterLLM);
    expect(deps.llmProvider).toBe("openrouter");
  });

  it("moves only the LLM to Anthropic, Haiku 5.5 unless told otherwise", () => {
    vi.stubEnv("MEMLOOM_LLM_PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or");
    const deps = buildEngineDeps();
    expect(deps.llm).toBeInstanceOf(AnthropicLLM);
    expect(deps.llmModel).toBe("claude-haiku-5-5");
    expect(deps.embedding.fingerprint).toMatch(/^openrouter:/);
  });

  it("refuses Anthropic without a key, and a provider or effort it does not know", () => {
    vi.stubEnv("MEMLOOM_LLM_PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(() => buildEngineDeps()).toThrow(/needs ANTHROPIC_API_KEY/);
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant");
    vi.stubEnv("ANTHROPIC_EFFORT", "extreme");
    expect(() => buildEngineDeps()).toThrow(/ANTHROPIC_EFFORT/);
    vi.stubEnv("MEMLOOM_LLM_PROVIDER", "gemini");
    expect(() => buildEngineDeps()).toThrow(/MEMLOOM_LLM_PROVIDER/);
  });
});
