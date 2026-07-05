import { describe, expect, it } from "vitest";
import { evaluate, mean, recallAtK, reciprocalRank } from "./metrics.js";

describe("metrics", () => {
  it("reciprocalRank: first relevant at rank 1 -> 1", () => {
    expect(reciprocalRank(["a", "b", "c"], new Set(["a"]))).toBe(1);
  });

  it("reciprocalRank: first relevant at rank 3 -> 1/3", () => {
    expect(reciprocalRank(["x", "y", "a"], new Set(["a"]))).toBeCloseTo(1 / 3);
  });

  it("reciprocalRank: none retrieved -> 0", () => {
    expect(reciprocalRank(["x", "y"], new Set(["a"]))).toBe(0);
  });

  it("recallAtK: finds half the relevant set in top k", () => {
    expect(recallAtK(["a", "x", "b", "y"], new Set(["a", "b", "c", "d"]), 4)).toBe(0.5);
  });

  it("recallAtK: k smaller than the relevant set", () => {
    expect(recallAtK(["a", "b", "c"], new Set(["a", "b"]), 1)).toBe(0.5);
  });

  it("recallAtK: empty relevant set -> 0", () => {
    expect(recallAtK(["a"], new Set<string>(), 5)).toBe(0);
  });

  it("mean of empty is 0", () => {
    expect(mean([])).toBe(0);
  });

  it("evaluate aggregates over queries", () => {
    const report = evaluate([
      { retrieved: ["a", "b"], relevant: new Set(["a"]) }, // rr 1
      { retrieved: ["x", "b"], relevant: new Set(["b"]) }, // rr 1/2
    ]);
    expect(report.count).toBe(2);
    expect(report.mrr).toBeCloseTo(0.75);
    expect(report.recallAt1).toBeCloseTo(0.5);
  });
});
