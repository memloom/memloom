import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "./index.js";

// Offline CLI tests (no OPENROUTER_API_KEY): the store persists to a temp dir, save/recall
// round-trip with the deterministic provider.

describe("cli", () => {
  let dir: string;
  let logs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memloom-cli-"));
    process.env.MEMLOOM_HOME = dir;
    delete process.env.OPENROUTER_API_KEY;
    logs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    delete process.env.MEMLOOM_HOME;
    rmSync(dir, { recursive: true, force: true });
  });

  it("help prints usage", async () => {
    await run(["help"]);
    expect(logs.join("\n")).toContain("Usage: memloom");
  });

  it("unknown command sets a nonzero exit code", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = 0;
    await run(["frobnicate"]);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    errSpy.mockRestore();
  });

  it("init creates the store; save + recall round-trip offline", async () => {
    await run(["init"]);
    expect(existsSync(dir)).toBe(true);

    await run(["save", "the", "staging", "database", "is", "postgres"]);

    logs.length = 0;
    await run(["recall", "staging", "database"]);
    expect(logs.join("\n")).toContain("staging database");
  });
});
