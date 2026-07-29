import { describe, expect, it } from "vitest";
import {
  boundedEditDistance,
  groupPairs,
  judgePair,
  mergeKey,
  nameTokens,
  pickCanonical,
  type ResolvableEntity,
  versionTokens,
} from "./entity-resolution.js";

// The software-name pairs below are the SHAPES a real 1789-entity graph accumulated, which is
// what these rules were tuned against: a project against a command built on it, a release
// against its family, a file against the thing it is named after. Person names are
// illustrative stand-ins, since a rule about human names should not be documented with a real
// person's.
const ent = (id: string, name: string, entityType = "project", mentions = 1): ResolvableEntity => ({
  id,
  name,
  entityType,
  mentions,
});

describe("mergeKey", () => {
  it("collapses case, punctuation and separators", () => {
    expect(mergeKey("Claude Code")).toBe("claudecode");
    expect(mergeKey("claude-code")).toBe("claudecode");
    expect(mergeKey("Claude_Code")).toBe("claudecode");
    expect(mergeKey("@Node.js ")).toBe("nodejs");
  });

  it("keeps genuinely different names apart", () => {
    expect(mergeKey("memory_entities")).not.toBe(mergeKey("memory_edges"));
  });
});

describe("nameTokens / versionTokens", () => {
  it("splits on separators and keeps decimal versions whole", () => {
    expect(nameTokens("Claude Opus 4.8")).toEqual(["claude", "opus", "4.8"]);
    expect(nameTokens("memory_entities")).toEqual(["memory", "entities"]);
  });

  it("picks out only the digit-bearing tokens", () => {
    expect(versionTokens("Claude Opus 4.8")).toEqual(["4.8"]);
    expect(versionTokens("Postgres")).toEqual([]);
  });
});

describe("boundedEditDistance", () => {
  it("measures small edits", () => {
    expect(boundedEditDistance("postgres", "postgresql", 2)).toBe(2);
    expect(boundedEditDistance("versuno", "versunoai", 2)).toBe(2);
  });

  it("abandons past the bound instead of computing the true distance", () => {
    expect(boundedEditDistance("memoryentities", "memoryedges", 2)).toBe(3);
  });
});

describe("judgePair: folds", () => {
  it("auto-folds pure orthographic variants", () => {
    const j = judgePair(ent("a", "Claude Code"), ent("b", "claude-code", "technology"));
    expect(j.verdict).toBe("auto");
    expect(j.score).toBe(1);
  });

  it("sends word containment to review, not straight to a fold", () => {
    const j = judgePair(ent("a", "Claude Opus 4.8"), ent("b", "Opus 4.8"));
    expect(j.verdict).toBe("review");
    expect(j.reason).toMatch(/contained/);
  });

  it("sends spelling variants to review", () => {
    const j = judgePair(ent("a", "Postgres", "technology"), ent("b", "PostgreSQL", "technology"));
    expect(j.verdict).toBe("review");
    expect(j.reason).toMatch(/spelling variant/);
  });

  it("notes a type disagreement in the reason shown to the human", () => {
    const j = judgePair(ent("a", "Claude Opus 4.7", "tool"), ent("b", "Opus 4.7", "project"));
    expect(j.verdict).toBe("review");
    expect(j.reason).toMatch(/typed differently \(tool vs project\)/);
  });

  it("raises the score when the vectors agree, but never to a fold", () => {
    const a = ent("a", "Postgres", "technology");
    const b = ent("b", "PostgreSQL", "technology");
    const plain = judgePair(a, b);
    const confirmed = judgePair(a, b, 0.91);
    expect(confirmed.score).toBeGreaterThan(plain.score);
    expect(confirmed.verdict).toBe("review");
  });
});

describe("judgePair: the guards that matter", () => {
  it("never folds two releases of one family", () => {
    const j = judgePair(ent("a", "Claude Opus 4.8"), ent("b", "Claude Opus 4.7"));
    expect(j.verdict).toBe("reject");
    expect(j.reason).toMatch(/different version tokens/);
  });

  it("rejects sibling names that are close but distinct", () => {
    const j = judgePair(ent("a", "memory_entities", "table"), ent("b", "memory_edges", "table"));
    expect(j.verdict).toBe("reject");
  });

  it("a high cosine cannot rescue a rejected pair", () => {
    const j = judgePair(ent("a", "Claude Opus 4.8"), ent("b", "Claude Opus 4.7"), 0.99);
    expect(j.verdict).toBe("reject");
  });

  it("refuses to auto-fold names too short for orthography to be evidence", () => {
    const j = judgePair(ent("a", "C#", "technology"), ent("b", "C", "technology"));
    expect(j.verdict).toBe("review");
    expect(j.reason).toMatch(/too short/);
  });

  it("does not fold a dotfile into the thing it is named after", () => {
    // Same merge key ("next"), different things. Found on the real store, where the naive
    // rule folded "Next" into ".next".
    const j = judgePair(ent("a", "Next", "technology"), ent("b", ".next", "file"));
    expect(j.verdict).toBe("review");
    expect(j.reason).toMatch(/punctuation-prefixed/);
  });

  it("rejects a file or domain built on another name", () => {
    expect(judgePair(ent("a", "memloom.ts", "file"), ent("b", "memloom")).verdict).toBe("reject");
    expect(judgePair(ent("a", "CLAUDE.md", "file"), ent("b", "Claude", "tool")).verdict).toBe(
      "reject",
    );
  });

  it("rejects a pinned version against its family", () => {
    const j = judgePair(ent("a", "Postgres 15", "technology"), ent("b", "Postgres", "technology"));
    expect(j.verdict).toBe("reject");
    expect(j.reason).toMatch(/pins a version/);
  });

  it("does not pair a one-word name with every phrase built on it", () => {
    // The single biggest source of false candidates on the real store: "memloom" against
    // "memloom serve", "MEMLOOM_HOME", "@memloom/cli" and 60 others.
    for (const other of ["memloom serve", "memloom index", "MEMLOOM_HOME", "memloom rules"]) {
      expect(judgePair(ent("a", "memloom"), ent("b", other)).verdict).toBe("reject");
    }
  });

  it("still pairs a multi-word name contained verbatim in a longer one", () => {
    expect(judgePair(ent("a", "Design System"), ent("b", "Acme Design System")).verdict).toBe(
      "review",
    );
  });

  it("pairs a person's first name with their full name", () => {
    // The rule above, which exists to stop "memloom" matching "memloom serve", also took out
    // first-name against full-name, which is the most common person alias there is. People
    // are the exception: a human's name is written at several lengths and means one human.
    const j = judgePair(ent("a", "Ada", "person"), ent("b", "Ada Lovelace", "person"));
    expect(j.verdict).toBe("review");
    expect(j.reason).toMatch(/written short and long/);
  });

  it("keeps the exception to people, and to both sides of the pair", () => {
    // A project named after a person is exactly the pair this must not fold, so one-sided
    // person typing earns nothing.
    expect(judgePair(ent("a", "Ada", "person"), ent("b", "Ada Lovelace")).verdict).toBe(
      "reject",
    );
    expect(judgePair(ent("a", "memloom"), ent("b", "memloom serve")).verdict).toBe("reject");
  });

  it("still asks rather than folds when a person's short name is ambiguous", () => {
    // "John" against both "John Smith" and "John Doe" is a real question with a real chance
    // of being two people, so the relaxation must never reach "auto".
    for (const full of ["John Smith", "John Doe"]) {
      expect(judgePair(ent("a", "John", "person"), ent("b", full, "person")).verdict).toBe(
        "review",
      );
    }
  });

  it("does not let the person relaxation outrun the added-words limit", () => {
    // One word short of a full name is an alias; four words short is a different person
    // inside a longer string.
    expect(
      judgePair(ent("a", "Ada", "person"), ent("b", "Ada King Countess of Lovelace", "person"))
        .verdict,
    ).toBe("reject");
  });

  it("scales edit tolerance with name length", () => {
    // Two edits in a six-letter word is most of the word.
    expect(judgePair(ent("a", "NOTICE", "file"), ent("b", "Notion", "tool")).verdict).toBe(
      "reject",
    );
    // but a suffix on a long one is a real variant.
    expect(
      judgePair(ent("a", "Postgres", "technology"), ent("b", "PostgreSQL", "technology")).verdict,
    ).toBe("review");
    // and a one-character typo is always worth asking about.
    expect(judgePair(ent("a", "memlom"), ent("b", "memloom")).verdict).toBe("review");
  });

  it("rejects unrelated names", () => {
    expect(judgePair(ent("a", "Postgres"), ent("b", "Notion")).verdict).toBe("reject");
    expect(judgePair(ent("a", "memloom"), ent("b", "Versuno")).verdict).toBe("reject");
  });

  it("rejects a row against itself", () => {
    expect(judgePair(ent("a", "memloom"), ent("a", "memloom")).verdict).toBe("reject");
  });
});

describe("pickCanonical", () => {
  it("the hub spelling wins, so retrieval weight does not move", () => {
    const big = ent("a", "Claude Opus 4.8", "project", 221);
    const small = ent("b", "Opus 4.8", "project", 19);
    expect(pickCanonical(small, big).canonical.id).toBe("a");
    expect(pickCanonical(big, small).source.id).toBe("b");
  });

  it("ties break toward the more specific name", () => {
    const { canonical } = pickCanonical(
      ent("a", "Opus", "project", 5),
      ent("b", "Claude Opus", "project", 5),
    );
    expect(canonical.name).toBe("Claude Opus");
  });

  it("prefers the properly capitalized spelling over an arbitrary id", () => {
    // Same mentions, same length: without this the uuid decides and the graph shows
    // "claude-code" as the display name half the time.
    const { canonical } = pickCanonical(
      ent("a", "claude-code", "technology"),
      ent("b", "Claude Code", "project"),
    );
    expect(canonical.name).toBe("Claude Code");
  });

  it("is deterministic when everything ties", () => {
    const one = pickCanonical(ent("a", "Xyz"), ent("b", "Abc"));
    const other = pickCanonical(ent("b", "Abc"), ent("a", "Xyz"));
    expect(one.canonical.id).toBe(other.canonical.id);
  });
});

describe("groupPairs", () => {
  it("chains overlapping pairs into one fold group", () => {
    const groups = groupPairs([
      ["a", "b"],
      ["b", "c"],
      ["x", "y"],
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.includes("a"))?.sort()).toEqual(["a", "b", "c"]);
  });

  it("ignores singletons", () => {
    expect(groupPairs([])).toEqual([]);
  });
});
