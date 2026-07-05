import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PgliteAdapter } from "./pglite-adapter.js";

// D1: the embedded store must reject a second opener so it can never corrupt the WAL.

describe("data-dir lock", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) {
      const d = dirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), "memloom-lock-"));
    dirs.push(d);
    return d;
  }

  it("rejects a second opener of the same data dir", async () => {
    const dir = tempDir();
    const first = await PgliteAdapter.open({ dataDir: dir });
    try {
      await expect(PgliteAdapter.open({ dataDir: dir })).rejects.toThrow(/already open/);
    } finally {
      await first.close();
    }
  });

  it("allows re-opening after the first is closed", async () => {
    const dir = tempDir();
    const first = await PgliteAdapter.open({ dataDir: dir });
    await first.close();
    const second = await PgliteAdapter.open({ dataDir: dir });
    await second.close();
    expect(true).toBe(true);
  });
});
