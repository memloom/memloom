import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "./index.js";

// The CLI is now a thin router over the daemon (data commands auto-start `memloom serve` and
// talk to it over HTTP). Here we cover the router itself; save/recall behaviour is tested at
// the engine, server (HttpMemloomClient), and MCP-tools layers.

describe("cli router", () => {
  let logs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("help prints usage", async () => {
    await run(["help"]);
    expect(logs.join("\n")).toContain("Usage: memloom");
  });

  it("no command prints usage", async () => {
    await run([]);
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
});
