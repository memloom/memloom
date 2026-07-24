import { describe, expect, it } from "vitest";
import { buildResolvePrompt, parseResolution } from "./conflict-resolver.js";
import type { ConflictCandidate } from "./types.js";

// The resolver's parsing contract: decisive verdicts pass through, everything malformed or
// hesitant collapses to "unsure" (which leaves the conflict in the human queue).

const relation: ConflictCandidate = {
  id: "c1",
  canonical: null,
  content: "the old fact",
  relation: "contradictory",
  reason: "cannot both be true",
};

describe("parseResolution", () => {
  it("passes decisive verdicts through", () => {
    expect(parseResolution('[{"verdict":"keep_new","reason":"newer state"}]', 1)).toEqual({
      verdict: "keep_new",
      reason: "newer state",
    });
    expect(parseResolution('[{"verdict":"keep_both","reason":"different scopes"}]', 1)).toEqual({
      verdict: "keep_both",
      reason: "different scopes",
    });
  });

  it("maps keep_existing to a 0-based candidate index, clamped into range", () => {
    expect(parseResolution('[{"verdict":"keep_existing","existing":2,"reason":"r"}]', 2)).toEqual({
      verdict: "keep_existing",
      candidateIndex: 1,
      reason: "r",
    });
    expect(parseResolution('[{"verdict":"keep_existing","existing":7,"reason":"r"}]', 2)).toEqual({
      verdict: "keep_existing",
      candidateIndex: 0,
      reason: "r",
    });
  });

  it("collapses garbage and hesitation to unsure", () => {
    expect(parseResolution("no json here", 1).verdict).toBe("unsure");
    expect(parseResolution("[]", 1).verdict).toBe("unsure");
    expect(parseResolution('[{"verdict":"maybe?","reason":"hmm"}]', 1).verdict).toBe("unsure");
  });
});

describe("buildResolvePrompt", () => {
  it("shows the model the times, excerpts, and the classifier's reason", () => {
    const prompt = buildResolvePrompt(
      { content: "the new fact", createdAt: "2026-07-24T12:00:00Z", excerpt: "we changed it" },
      [
        {
          content: "the old fact",
          createdAt: "2026-07-01T09:00:00Z",
          excerpt: "back then it was so",
          relation,
        },
      ],
    );
    expect(prompt).toContain("the new fact");
    expect(prompt).toContain("2026-07-24T12:00:00Z");
    expect(prompt).toContain("we changed it");
    expect(prompt).toContain("the old fact");
    expect(prompt).toContain("2026-07-01T09:00:00Z");
    expect(prompt).toContain("back then it was so");
    expect(prompt).toContain("cannot both be true");
    expect(prompt).toContain('"unsure"');
  });
});
