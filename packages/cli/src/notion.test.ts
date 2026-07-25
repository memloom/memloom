import type { NotionListedPage } from "@memloom/core";
import { describe, expect, it } from "vitest";
import { flattenListing, matchPages, parseSelection } from "./notion.js";

function listed(over: Partial<NotionListedPage> & { id: string; title: string }): NotionListedPage {
  return {
    object: "page",
    lastEdited: "",
    url: null,
    selected: false,
    parentId: null,
    parentType: null,
    ...over,
  };
}

describe("parseSelection", () => {
  it("parses numbers, ranges, and all", () => {
    expect(parseSelection("1", 5)).toEqual([0]);
    expect(parseSelection("1,3-5", 5)).toEqual([0, 2, 3, 4]);
    expect(parseSelection(" 2 , 2 ", 5)).toEqual([1]);
    expect(parseSelection("all", 3)).toEqual([0, 1, 2]);
  });

  it("rejects out-of-range, reversed, and junk input", () => {
    expect(parseSelection("", 5)).toBeNull();
    expect(parseSelection("0", 5)).toBeNull();
    expect(parseSelection("6", 5)).toBeNull();
    expect(parseSelection("4-2", 5)).toBeNull();
    expect(parseSelection("nope", 5)).toBeNull();
  });
});

describe("matchPages", () => {
  const listing = [
    listed({ id: "aaa", title: "Personal Diary" }),
    listed({ id: "bbb", title: "Work Diary" }),
    listed({ id: "ccc", title: "Reading list", object: "data_source" }),
  ];

  it("matches by exact id and by unique title substring, case-insensitive", () => {
    const { matched, missing } = matchPages(listing, ["ccc", "personal"]);
    expect(matched.map((m) => m.id).sort()).toEqual(["aaa", "ccc"]);
    expect(missing).toEqual([]);
  });

  it("an ambiguous title fragment is missing, never a guess", () => {
    const { matched, missing } = matchPages(listing, ["diary"]);
    expect(matched).toEqual([]);
    expect(missing).toEqual(["diary"]);
  });

  it("deduplicates repeated picks", () => {
    const { matched } = matchPages(listing, ["aaa", "Personal Diary"]);
    expect(matched).toHaveLength(1);
  });
});

describe("flattenListing", () => {
  it("indents children under parents and collapses database rows into a count", () => {
    const listing = [
      listed({ id: "trip", title: "Rome trip" }),
      listed({
        id: "exp",
        title: "Expenses",
        object: "data_source",
        parentId: "trip",
        parentType: "page",
      }),
      listed({ id: "r1", title: "Train", parentId: "exp", parentType: "data_source" }),
      listed({ id: "r2", title: "Hostel", parentId: "exp", parentType: "data_source" }),
      listed({ id: "sub", title: "Packing list", parentId: "trip", parentType: "page" }),
      listed({ id: "diary", title: "Personal Diary" }),
    ];
    const tree = flattenListing(listing);
    expect(tree.map((r) => r.item.id)).toEqual(["trip", "exp", "sub", "diary"]);
    expect(tree.map((r) => r.depth)).toEqual([0, 1, 1, 0]);
    expect(tree.find((r) => r.item.id === "exp")?.rows).toBe(2);
  });

  it("an item whose parent is not listed renders at top level", () => {
    const listing = [
      listed({ id: "orphan", title: "Shared alone", parentId: "unseen", parentType: "page" }),
    ];
    const tree = flattenListing(listing);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.depth).toBe(0);
  });

  it("a page nested inside a collapsed row surfaces instead of disappearing", () => {
    const listing = [
      listed({ id: "exp", title: "Expenses", object: "data_source" }),
      listed({ id: "row", title: "Hostel", parentId: "exp", parentType: "data_source" }),
      listed({ id: "inner", title: "Hostel notes", parentId: "row", parentType: "page" }),
    ];
    const tree = flattenListing(listing);
    expect(tree.map((r) => r.item.id)).toEqual(["exp", "inner"]);
    expect(tree.find((r) => r.item.id === "inner")?.depth).toBe(0);
  });
});
