import { describe, expect, it } from "vitest";
import { parseImportFlags } from "./import.js";

describe("parseImportFlags", () => {
  it("defaults to a bounded real run", () => {
    expect(parseImportFlags([])).toEqual({ dryRun: false, force: false });
  });

  it("parses every flag in both spellings", () => {
    expect(
      parseImportFlags(["--dry-run", "--force", "--days", "60", "--sessions=50", "--project", "memloom"]),
    ).toEqual({ dryRun: true, force: true, days: 60, maxSessions: 50, project: "memloom" });
  });

  it("rejects non-positive and non-integer bounds", () => {
    expect(() => parseImportFlags(["--days", "0"])).toThrow(/positive integer/);
    expect(() => parseImportFlags(["--days", "two"])).toThrow(/positive integer/);
    expect(() => parseImportFlags(["--sessions", "-5"])).toThrow(/positive integer/);
  });

  it("rejects a valueless flag and an unknown flag", () => {
    expect(() => parseImportFlags(["--project"])).toThrow(/needs a value/);
    expect(() => parseImportFlags(["--nope"])).toThrow(/unknown flag/);
  });
});
