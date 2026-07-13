import { afterEach, describe, expect, it } from "vitest";
import { type AssistantEvent, runAssistantTurn, stripInvalidMarkers } from "./assistant.js";
import { HashingEmbeddingProvider, NullLLMProvider } from "./hashing-provider.js";
import { Memloom } from "./memloom.js";
import { PgliteAdapter } from "./pglite-adapter.js";
import type { ChatMessage, ChatProvider, ChatResult, ChatTool, LLMProvider } from "./providers.js";
import type { Memory } from "./types.js";

// The assistant harness: the model decides whether to recall; the loop enforces caps,
// dedupes queries, survives failures, and validates citations. Pure tests first
// (scripted ChatProvider, no DB), then engine-level persistence tests on PGLite.

function memory(id: string, content: string): Memory {
  return {
    id,
    ownerId: "o",
    status: "active",
    memoryType: "fact",
    canonical: null,
    content,
    summary: null,
    rootId: id,
    version: 1,
    assertedAt: "",
    createdAt: "",
    kind: "memory",
  };
}

// Scripted chat provider: chat() answers from a queue, chatStream() streams a fixed text.
function scripted(
  turns: Array<ChatResult | Error>,
  finalAnswer = "answer",
): ChatProvider & { chatCalls: ChatMessage[][]; streamed: boolean } {
  const provider = {
    chatCalls: [] as ChatMessage[][],
    streamed: false,
    async chat(
      messages: ChatMessage[],
      _opts?: { tools?: ChatTool[]; toolChoice?: "auto" | "none" },
    ): Promise<ChatResult> {
      provider.chatCalls.push(messages);
      const next = turns.shift() ?? { content: null, toolCalls: [] };
      if (next instanceof Error) throw next;
      return next;
    },
    async chatStream(_m: ChatMessage[], onDelta: (t: string) => void): Promise<string> {
      provider.streamed = true;
      for (const word of finalAnswer.split(" ")) onDelta(`${word} `);
      return finalAnswer;
    },
  };
  return provider;
}

const toolCall = (query: string, id = "c1") => ({
  id,
  name: "recall_memory",
  arguments: JSON.stringify({ query }),
});

describe("assistant harness", () => {
  it("answers directly without recall for trivial questions", async () => {
    const provider = scripted([{ content: "It is Sunday, July 13.", toolCalls: [] }]);
    let recalled = 0;
    const events: AssistantEvent[] = [];
    const out = await runAssistantTurn({
      provider,
      recall: async () => {
        recalled += 1;
        return [];
      },
      history: [],
      message: "what day is today?",
      today: "Sun Jul 13 2026",
      onEvent: (e) => events.push(e),
    });
    expect(out.answer).toBe("It is Sunday, July 13.");
    expect(out.sources).toEqual([]);
    expect(recalled).toBe(0);
    expect(provider.streamed).toBe(false);
    expect(events.some((e) => e.type === "tool_call")).toBe(false);
  });

  it("recalls, numbers sources, streams the answer, strips fabricated markers", async () => {
    const provider = scripted(
      [
        { content: null, toolCalls: [toolCall("staging database")] },
        { content: null, toolCalls: [] },
      ],
      "Staging runs on Postgres. [1] Bogus claim. [9]",
    );
    const events: AssistantEvent[] = [];
    const out = await runAssistantTurn({
      provider,
      recall: async () => [memory("m1", "the staging database runs on Postgres")],
      history: [],
      message: "what runs staging?",
      today: "Sun Jul 13 2026",
      onEvent: (e) => events.push(e),
    });
    expect(out.sources).toHaveLength(1);
    expect(out.sources[0]).toMatchObject({ n: 1, kind: "memory", id: "m1" });
    expect(out.answer).toContain("[1]");
    expect(out.answer).not.toContain("[9]");
    const types = events.map((e) => e.type);
    expect(types.indexOf("tool_call")).toBeLessThan(types.indexOf("tool_result"));
    expect(types.indexOf("tool_result")).toBeLessThan(types.indexOf("delta"));
    // The tool result reached the model as a numbered passage.
    const toolMsg = provider.chatCalls[1]?.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("[1] (memory)");
  });

  it("dedupes identical consecutive queries", async () => {
    const provider = scripted([
      { content: null, toolCalls: [toolCall("espresso")] },
      { content: null, toolCalls: [toolCall("espresso", "c2")] },
      { content: null, toolCalls: [] },
    ]);
    let recalled = 0;
    await runAssistantTurn({
      provider,
      recall: async () => {
        recalled += 1;
        return [memory("m1", "espresso notes")];
      },
      history: [],
      message: "coffee?",
      today: "d",
    });
    expect(recalled).toBe(1);
    const secondToolMsg = provider.chatCalls[2]?.filter((m) => m.role === "tool").at(-1);
    expect(secondToolMsg?.content).toContain("already searched");
  });

  it("malformed args fall back to the raw user message as the query", async () => {
    const provider = scripted([
      { content: null, toolCalls: [{ id: "c1", name: "recall_memory", arguments: "not json" }] },
      { content: null, toolCalls: [] },
    ]);
    let seenQuery = "";
    await runAssistantTurn({
      provider,
      recall: async (q) => {
        seenQuery = q;
        return [];
      },
      history: [],
      message: "what do I know about Redis?",
      today: "d",
    });
    expect(seenQuery).toBe("what do I know about Redis?");
  });

  it("zero hits produce an explicit no-results tool message", async () => {
    const provider = scripted(
      [
        { content: null, toolCalls: [toolCall("unicorns")] },
        { content: null, toolCalls: [] },
      ],
      "I could not find anything about that in your memories.",
    );
    const out = await runAssistantTurn({
      provider,
      recall: async () => [],
      history: [],
      message: "my unicorn project?",
      today: "d",
    });
    const toolMsg = provider.chatCalls[1]?.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("No relevant memories found");
    expect(out.sources).toEqual([]);
  });

  it("caps tool rounds at 3 and still answers", async () => {
    const provider = scripted([
      { content: null, toolCalls: [toolCall("a")] },
      { content: null, toolCalls: [toolCall("b", "c2")] },
      { content: null, toolCalls: [toolCall("c", "c3")] },
      { content: null, toolCalls: [toolCall("d", "c4")] }, // never reached
    ]);
    let recalled = 0;
    const out = await runAssistantTurn({
      provider,
      recall: async () => {
        recalled += 1;
        return [];
      },
      history: [],
      message: "q",
      today: "d",
    });
    expect(recalled).toBe(3);
    expect(out.answer).toBe("answer");
    expect(provider.streamed).toBe(true);
  });

  it("a mid-loop model failure still answers with gathered context", async () => {
    const provider = scripted([
      { content: null, toolCalls: [toolCall("staging")] },
      new Error("provider exploded"),
    ]);
    const out = await runAssistantTurn({
      provider,
      recall: async () => [memory("m1", "staging is Postgres")],
      history: [],
      message: "staging?",
      today: "d",
    });
    expect(out.answer).toBe("answer");
    expect(out.sources).toHaveLength(1);
  });

  it("stripInvalidMarkers only keeps markers with sources", () => {
    expect(stripInvalidMarkers("a [1] b [2] c [12]", new Set([2]))).toBe("a  b [2] c ");
  });

  it("passes on_date through to recall and dates the passages", async () => {
    const provider = scripted(
      [
        {
          content: null,
          toolCalls: [
            {
              id: "c1",
              name: "recall_memory",
              arguments: JSON.stringify({ query: "plans", on_date: "2026-07-13" }),
            },
          ],
        },
        { content: null, toolCalls: [] },
      ],
      "You are going to Poznan. [1]",
    );
    let seenDate: string | undefined;
    const events: AssistantEvent[] = [];
    const poznan = { ...memory("m1", "going to a waterpark in poznan today") };
    poznan.assertedAt = "2026-07-13T09:52:08.000Z";
    const out = await runAssistantTurn({
      provider,
      recall: async (_q, onDate) => {
        seenDate = onDate;
        return [poznan];
      },
      history: [],
      message: "what are my plans for today?",
      today: "Sun Jul 13 2026 (2026-07-13)",
      onEvent: (e) => events.push(e),
    });
    expect(seenDate).toBe("2026-07-13");
    expect(out.sources[0]?.date).toBe("2026-07-13");
    const toolMsg = provider.chatCalls[1]?.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("saved 2026-07-13");
    const call = events.find((e) => e.type === "tool_call");
    expect(call && "onDate" in call ? call.onDate : undefined).toBe("2026-07-13");
  });
});

// Engine-level: sessions, persistence, search, offline mode.

type ChatLLM = LLMProvider & ChatProvider;

function engineLLM(): ChatLLM {
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

describe("assistant engine", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  async function fresh(llm: LLMProvider = engineLLM()): Promise<Memloom> {
    const storage = await PgliteAdapter.open();
    cleanups.push(() => storage.close());
    const m = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm,
      dedup: false,
    });
    await m.init();
    return m;
  }

  it("creates a session titled from the first message and persists both turns", async () => {
    const m = await fresh();
    const first = await m.assistantChat({ message: "hello there, assistant" });
    expect(first.answer).toBe("echo: hello there, assistant");
    await m.assistantChat({ sessionId: first.sessionId, message: "second message" });

    const sessions = await m.assistantSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.title).toBe("hello there, assistant");
    const messages = await m.assistantMessages(first.sessionId);
    expect(messages.map((x) => x.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("rename, star ordering, delete cascade", async () => {
    const m = await fresh();
    const a = await m.assistantChat({ message: "first chat" });
    const b = await m.assistantChat({ message: "second chat" });
    await m.renameAssistantSession(a.sessionId, "renamed");
    await m.starAssistantSession(a.sessionId, true);

    const sessions = await m.assistantSessions();
    expect(sessions[0]?.id).toBe(a.sessionId); // starred outranks newer
    expect(sessions[0]?.title).toBe("renamed");

    await m.deleteAssistantSession(b.sessionId);
    expect(await m.assistantSessions()).toHaveLength(1);
    expect(await m.assistantMessages(b.sessionId)).toEqual([]);
  });

  it("search finds sessions by keyword and by similarity", async () => {
    const m = await fresh();
    const a = await m.assistantChat({ message: "the espresso machine broke again" });
    await m.assistantChat({ message: "notes about postgres tuning" });

    const keyword = await m.searchAssistantSessions("espresso machine");
    expect(keyword[0]?.id).toBe(a.sessionId);
    expect(keyword[0]?.snippet).toContain("espresso");

    // Word order defeats ILIKE; shared tokens keep hashing-embedding similarity high.
    const similar = await m.searchAssistantSessions("machine espresso broke");
    expect(similar.some((s) => s.id === a.sessionId)).toBe(true);

    const all = await m.searchAssistantSessions("");
    expect(all).toHaveLength(2);
  });

  it("recall assertedOn filters memories to one calendar day", async () => {
    const m = await fresh();
    await m.save({ content: "going to a waterpark in poznan today" });
    const old = await m.save({ content: "call Orange before 9 AM" });
    // Backdate the second memory a week: it must vanish from a today-filtered recall.
    await m.deps.storage.query(
      "UPDATE memory_objects SET asserted_at = now() - interval '7 days' WHERE id = $1",
      [old.id],
    );
    const today = new Date().toLocaleDateString("en-CA");
    const hits = await m.recall("plans", { assertedOn: today });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toContain("poznan");

    await expect(m.recall("plans", { assertedOn: "13-07-2026" })).rejects.toThrow(/YYYY-MM-DD/);
  });

  it("offline mode (no chat-capable provider) fails with the setup hint", async () => {
    const m = await fresh(new NullLLMProvider());
    await expect(m.assistantChat({ message: "hi" })).rejects.toThrow(/chat-capable LLM/);
  });
});
