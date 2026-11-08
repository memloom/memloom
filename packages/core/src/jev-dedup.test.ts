import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Candidate, Classification, DedupClassifier } from "./dedup.js";
import { HashingEmbeddingProvider, NullLLMProvider } from "./hashing-provider.js";
import { DECISIONS_URL, type JevDecision, JevDedupClassifier } from "./jev-dedup.js";
import { Memloom } from "./memloom.js";
import { PgliteAdapter } from "./pglite-adapter.js";
import type { StorageAdapter } from "./storage.js";
import { truncateAll } from "./test-store.js";

// The Jev classifier against a fake Decisions endpoint: the request it sends, how it maps
// answers back to candidates, and the gate that keeps a guess from merging anything.

type Probs = { identical: number; complementary: number; contradictory: number };

function choice(p: Probs) {
  const [label] = Object.entries(p).sort((a, b) => b[1] - a[1])[0] ?? ["complementary"];
  return {
    type: "choice",
    choice: label,
    probabilities: p,
    confidence: Math.max(...Object.values(p)),
  };
}

function respond(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

function fakeFetch(answers: Record<string, unknown>, status = 200) {
  return vi.fn(async (_url: string, _init: { body: string }) =>
    respond(
      status === 200
        ? {
            model: "typesafe/jev-1.14-20261014",
            answers,
            usage: { input_tokens: 400, output_tokens: 50, cost: 0.0000168 },
          }
        : { error: { code: status, message: "bad request" } },
      status,
    ),
  ) as unknown as typeof globalThis.fetch & { mock: { calls: [string, { body: string }][] } };
}

class RecordingFallback implements DedupClassifier {
  calls: Candidate[][] = [];
  constructor(
    readonly label: Classification["relation"] | "throw",
    readonly error = new Error("Anthropic is out of credit"),
  ) {}
  async classify(_incoming: unknown, candidates: readonly Candidate[]): Promise<Classification[]> {
    this.calls.push([...candidates]);
    if (this.label === "throw") throw this.error;
    return candidates.map((c) => ({
      candidateId: c.id,
      relation: this.label as Classification["relation"],
      reason: "llm says so",
    }));
  }
}

const cands: Candidate[] = [
  { id: "a", canonical: null, content: "The deploy window is Friday at 3pm.", similarity: 0.9 },
  { id: "b", canonical: null, content: "Staging runs on a separate cluster.", similarity: 0.6 },
];
const incoming = { content: "The deploy window is Friday at 4pm." };

describe("JevDedupClassifier", () => {
  it("sends one choice question per candidate and maps answers back by position", async () => {
    const fetch = fakeFetch({
      relation_1: choice({ identical: 0, complementary: 0.02, contradictory: 0.98 }),
      relation_2: choice({ identical: 0, complementary: 0.99, contradictory: 0.01 }),
    });
    const fallback = new RecordingFallback("complementary");
    const decisions: JevDecision[] = [];
    const jev = new JevDedupClassifier({
      apiKey: "test-key",
      fallback,
      fetch,
      onDecision: (d) => decisions.push(d),
    });

    const out = await jev.classify(incoming, cands);

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(DECISIONS_URL);
    const body = JSON.parse(init?.body ?? "{}");
    expect(body.model).toBe("typesafe/jev-1.14");
    expect(body.state).toEqual({
      new_memory: incoming.content,
      existing_1: cands[0]?.content,
      existing_2: cands[1]?.content,
    });
    expect(Object.keys(body.questions)).toEqual(["relation_1", "relation_2"]);
    expect(body.questions.relation_1.type).toBe("choice");
    expect(Object.keys(body.questions.relation_1.criteria).sort()).toEqual([
      "complementary",
      "contradictory",
      "identical",
    ]);
    expect(body.questions.relation_2.instructions).toContain("existing_2");

    expect(out.map((c) => [c.candidateId, c.relation])).toEqual([
      ["a", "contradictory"],
      ["b", "complementary"],
    ]);
    expect(out[0]?.reason).toContain("0.98");
    expect(fallback.calls).toHaveLength(0);
    expect(decisions[0]?.usage?.usd).toBeCloseTo(0.0000168);
    expect(decisions[0]?.settledBy).toBe("none");
  });

  it("sends only the unsure candidates to the fallback", async () => {
    const fetch = fakeFetch({
      relation_1: choice({ identical: 0.6, complementary: 0.05, contradictory: 0.35 }),
      relation_2: choice({ identical: 0, complementary: 0.97, contradictory: 0.03 }),
    });
    const fallback = new RecordingFallback("contradictory");
    const jev = new JevDedupClassifier({ apiKey: "test-key", fallback, fetch });

    const out = await jev.classify(incoming, cands);

    expect(fallback.calls).toEqual([[cands[0]]]);
    const a = out.find((c) => c.candidateId === "a");
    expect(a?.relation).toBe("contradictory");
    expect(a?.reason).toMatch(/jev unsure .*identical 0\.60.*llm: llm says so/);
    expect(out.find((c) => c.candidateId === "b")?.relation).toBe("complementary");
  });

  it("never acts on a low-confidence identical: no fallback means a conflict", async () => {
    const fetch = fakeFetch({
      relation_1: choice({ identical: 0.7, complementary: 0.3, contradictory: 0 }),
      relation_2: choice({ identical: 0, complementary: 1, contradictory: 0 }),
    });
    const jev = new JevDedupClassifier({ apiKey: "test-key", fallback: null, fetch });

    const out = await jev.classify(incoming, cands);

    const a = out.find((c) => c.candidateId === "a");
    expect(a?.relation).toBe("contradictory");
    expect(a?.reason).toContain("a human decides");
  });

  it("files a conflict when the fallback fails too", async () => {
    const fetch = fakeFetch({
      relation_1: choice({ identical: 0.5, complementary: 0.5, contradictory: 0 }),
      relation_2: choice({ identical: 0, complementary: 1, contradictory: 0 }),
    });
    const decisions: JevDecision[] = [];
    const jev = new JevDedupClassifier({
      apiKey: "test-key",
      fallback: new RecordingFallback("throw"),
      fetch,
      onDecision: (d) => decisions.push(d),
    });

    const out = await jev.classify(incoming, cands);

    expect(out.find((c) => c.candidateId === "a")?.relation).toBe("contradictory");
    expect(out.find((c) => c.candidateId === "a")?.reason).toContain("out of credit");
    expect(decisions[0]?.settledBy).toBe("conflict");
  });

  it("treats a refusal or a missing answer as unsure", async () => {
    const fetch = fakeFetch({ relation_1: { type: "refusal" } });
    const fallback = new RecordingFallback("complementary");
    const jev = new JevDedupClassifier({ apiKey: "test-key", fallback, fetch });

    await jev.classify(incoming, cands);

    expect(fallback.calls[0]?.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("falls back on every candidate when the Decisions request fails", async () => {
    const fetch = fakeFetch({}, 400);
    const fallback = new RecordingFallback("identical");
    const decisions: JevDecision[] = [];
    const jev = new JevDedupClassifier({
      apiKey: "test-key",
      fallback,
      fetch,
      onDecision: (d) => decisions.push(d),
    });

    const out = await jev.classify(incoming, cands);

    expect(fallback.calls[0]).toHaveLength(2);
    expect(out.every((c) => c.relation === "identical")).toBe(true);
    expect(decisions[0]?.jevError).toContain("400");
  });

  it("rejects a threshold outside (0, 1]", () => {
    expect(() => new JevDedupClassifier({ apiKey: "k", fallback: null, threshold: 1.5 })).toThrow(
      /threshold/,
    );
  });
});

// The same gate seen from Memloom.save: a near-duplicate Jev is unsure about must not become a
// new version of the existing memory (which would stale it).
let storage: StorageAdapter;
beforeAll(async () => {
  storage = await PgliteAdapter.open();
});
afterAll(async () => {
  await storage.close();
});

describe("save with the Jev classifier", () => {
  it("files a conflict instead of versioning on an unsure identical", async () => {
    await truncateAll(storage);
    const fetch = fakeFetch({
      relation_1: choice({ identical: 0.75, complementary: 0.2, contradictory: 0.05 }),
    });
    const m = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: new NullLLMProvider(),
      dedupClassifier: new JevDedupClassifier({ apiKey: "test-key", fallback: null, fetch }),
    });
    await m.init();

    const a = await m.save({ content: "the team standup is at 9:30 every weekday" });
    const b = await m.save({ content: "the team standup is at 9:45 every weekday" });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(b.outcome).toBe("conflict");
    const [row] = await storage.query<{ status: string }>(
      "SELECT status FROM memory_objects WHERE id = $1",
      [a.id],
    );
    expect(row?.status).toBe("active");
  });

  it("versions on a confident identical", async () => {
    await truncateAll(storage);
    const fetch = fakeFetch({
      relation_1: choice({ identical: 0.99, complementary: 0.01, contradictory: 0 }),
    });
    const m = new Memloom({
      storage,
      embedding: new HashingEmbeddingProvider(1024),
      llm: new NullLLMProvider(),
      dedupClassifier: new JevDedupClassifier({ apiKey: "test-key", fallback: null, fetch }),
    });
    await m.init();

    await m.save({ content: "the team standup is at 9:30 every weekday" });
    const b = await m.save({ content: "the team standup is at 9:30 on every weekday" });

    expect(b.outcome).toBe("versioned");
  });
});
