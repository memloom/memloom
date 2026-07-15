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

  it("<command> --help prints that command's help without touching the daemon", async () => {
    // These must never call connect(); a daemon-less environment is the whole point.
    await run(["index", "--help"]);
    expect(logs.join("\n")).toContain("memloom index [--rebuild]");

    logs = [];
    await run(["save", "-h"]);
    expect(logs.join("\n")).toContain("memloom save <text...>");

    logs = [];
    await run(["auto-index", "--help"]);
    expect(logs.join("\n")).toContain("memloom auto-index [on|off]");

    logs = [];
    await run(["reembed", "--help"]);
    expect(logs.join("\n")).toContain("memloom reembed [--force]");

    // help <command> is the same output; an unknown topic falls back to the main help.
    logs = [];
    await run(["help", "conflicts"]);
    expect(logs.join("\n")).toContain("memloom conflicts");

    logs = [];
    await run(["help", "frobnicate"]);
    expect(logs.join("\n")).toContain("Usage: memloom");
  });
});
