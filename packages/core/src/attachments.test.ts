import { afterEach, describe, expect, it } from "vitest";
import { HashingEmbeddingProvider, NullLLMProvider } from "./hashing-provider.js";
import { Memloom } from "./memloom.js";
import { PgliteAdapter } from "./pglite-adapter.js";
import type { ChatMessage, ChatProvider, ChatResult, ChatTool, LLMProvider } from "./providers.js";

// Chat-scoped attachments: a file uploaded into one assistant session is chunked and
// embedded like a document, but only that chat's recall sees it, it never joins the
// documents list / graph / index, and it dies with the chat.

const md = (text: string) => new TextEncoder().encode(text);

type ChatLLM = LLMProvider & ChatProvider;

function echoLLM(): ChatLLM {
  return {
    async complete() {
      return '{"entities":[],"relationships":[]}';
    },
    async chat(messages: ChatMessage[]): Promise<ChatResult> {
      const user = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
      return { content: `echo: ${user}`, toolCalls: [] };
    },
    async chatStream(_m: ChatMessage[], onDelta: (t: string) => void) {
      onDelta("streamed");
      return "streamed";
    },
  };
}

describe("chat attachments", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  async function fresh(llm: LLMProvider = new NullLLMProvider()): Promise<Memloom> {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const m = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(256),
      llm,
      dedup: false,
    });
    await m.init();
    return m;
  }

  it("attach without a session creates one; re-attaching the same bytes is a no-op", async () => {
    const m = await fresh();
    const first = await m.contextAttach({
      filename: "notes.md",
      bytes: md("# Notes\nthe secret launch window is thursday night"),
    });
    expect(first.outcome).toBe("added");
    expect(first.sessionId).toBeTruthy();
    expect(first.chunks).toBeGreaterThan(0);

    const again = await m.contextAttach({
      filename: "notes.md",
      bytes: md("# Notes\nthe secret launch window is thursday night"),
      sessionId: first.sessionId,
    });
    expect(again.outcome).toBe("unchanged");
    expect(again.documentId).toBe(first.documentId);

    const sessions = await m.assistantSessions();
    expect(sessions.map((s) => s.id)).toContain(first.sessionId);
    expect(sessions.find((s) => s.id === first.sessionId)?.title).toBe("New chat");
  });

  it("attaching to an unknown session fails", async () => {
    const m = await fresh();
    await expect(
      m.contextAttach({
        filename: "x.md",
        bytes: md("# X\nnothing"),
        sessionId: "00000000-0000-0000-0000-000000000001",
      }),
    ).rejects.toThrow(/no assistant session/);
  });

  it("recall sees the attachment only from its own session", async () => {
    const m = await fresh();
    const { sessionId } = await m.contextAttach({
      filename: "plan.md",
      bytes: md("# Plan\nthe secret launch window is thursday night"),
    });
    const other = await m.contextAttach({
      filename: "other.md",
      bytes: md("# Other\nsomething unrelated entirely"),
    });

    const scoped = await m.recall("secret launch window thursday", { sessionId });
    expect(scoped.some((r) => r.content.includes("launch window"))).toBe(true);

    const unscoped = await m.recall("secret launch window thursday");
    expect(unscoped.some((r) => r.content.includes("launch window"))).toBe(false);

    const otherScoped = await m.recall("secret launch window thursday", {
      sessionId: other.sessionId,
    });
    expect(otherScoped.some((r) => r.content.includes("launch window"))).toBe(false);
  });

  it("global chunks and memories stay visible from a scoped recall", async () => {
    const m = await fresh();
    await m.save({ content: "the staging database password rotates monthly" });
    const { sessionId } = await m.contextAttach({
      filename: "a.md",
      bytes: md("# A\nattachment content here"),
    });
    const results = await m.recall("staging database password", { sessionId });
    expect(results.some((r) => r.kind === "memory")).toBe(true);
  });

  it("attachments stay out of the documents list, the graph, and indexing", async () => {
    const m = await fresh();
    const { sessionId, documentId } = await m.contextAttach({
      filename: "hidden.md",
      bytes: md("# Hidden\nGrace Hopper invented the compiler"),
    });

    expect(await m.contextList()).toHaveLength(0);
    expect((await m.graph()).documents).toHaveLength(0);
    // A zero-pending index short-circuits before creating a run row, so an empty run
    // history proves the session chunks were never selected (a failed extraction would
    // still leave a run).
    expect(await m.index()).toEqual({ indexed: 0, chunksIndexed: 0 });
    expect(await m.listIndexRuns()).toHaveLength(0);

    const listed = await m.sessionAttachments(sessionId);
    expect(listed.map((d) => d.id)).toEqual([documentId]);
    expect(listed[0]?.title).toBe("Hidden");
  });

  it("deleting the session deletes its attachments and chunks", async () => {
    const m = await fresh(echoLLM());
    const { sessionId } = await m.contextAttach({
      filename: "gone.md",
      bytes: md("# Gone\nsoon to be deleted content"),
    });
    await m.deleteAssistantSession(sessionId);

    expect(await m.sessionAttachments(sessionId)).toHaveLength(0);
    const orphans = await m.deps.storage.query(
      "SELECT id FROM context_chunks WHERE session_id IS NOT NULL",
    );
    expect(orphans).toHaveLength(0);
  });

  it("a 'New chat' session created by an attach is retitled by its first message", async () => {
    const m = await fresh(echoLLM());
    const { sessionId } = await m.contextAttach({
      filename: "brief.md",
      bytes: md("# Brief\nproject kickoff details"),
    });
    await m.assistantChat({ sessionId, message: "summarize the brief for me" });
    const session = (await m.assistantSessions()).find((s) => s.id === sessionId);
    expect(session?.title).toBe("summarize the brief for me");

    // A custom title is never overwritten.
    await m.renameAssistantSession(sessionId, "My kickoff chat");
    await m.assistantChat({ sessionId, message: "and one more thing" });
    const renamed = (await m.assistantSessions()).find((s) => s.id === sessionId);
    expect(renamed?.title).toBe("My kickoff chat");
  });

  it("assistantChat threads the model override and attachment titles through", async () => {
    const seenModels: (string | undefined)[] = [];
    const seenSystems: string[] = [];
    const llm: ChatLLM = {
      async complete() {
        return "{}";
      },
      async chat(
        messages: ChatMessage[],
        opts?: { tools?: ChatTool[]; toolChoice?: "auto" | "none"; model?: string },
      ): Promise<ChatResult> {
        seenModels.push(opts?.model);
        seenSystems.push(messages.find((m) => m.role === "system")?.content ?? "");
        return { content: "ok", toolCalls: [] };
      },
      async chatStream() {
        return "ok";
      },
    };
    const m = await fresh(llm);
    const { sessionId } = await m.contextAttach({
      filename: "spec.md",
      bytes: md("# Spec Document\nrequirements go here"),
    });
    await m.assistantChat({ sessionId, message: "hi", model: "anthropic/claude-sonnet-5" });
    expect(seenModels).toEqual(["anthropic/claude-sonnet-5"]);
    expect(seenSystems[0]).toContain("Spec Document");

    await m.assistantChat({ message: "no attachments here" });
    expect(seenModels[1]).toBeUndefined();
    expect(seenSystems[1]).not.toContain("attached");
  });
});
