import { mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { waitUntilStable } from "./stability.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "memloom-stability-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("waitUntilStable", () => {
  it("returns immediately for a file nobody has touched in a settle window", async () => {
    const path = join(dir, "done.wav");
    await writeFile(path, Buffer.alloc(4096));
    // Written now, so the mtime shortcut cannot fire; two polls 20 ms apart agree instead.
    const started = Date.now();
    const info = await waitUntilStable(path, { settleMs: 20 });
    expect(info.size).toBe(4096);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("waits out a file that is still growing and returns its final size", async () => {
    const path = join(dir, "growing.bin");
    const handle = await open(path, "w");
    // Writes every 200 ms, well inside the 1 s settle window, so the wait cannot
    // short-circuit: it has to keep polling until the writer stops.
    let writes = 0;
    const timer = setInterval(() => {
      writes++;
      void handle.write(Buffer.alloc(64 * 1024));
      if (writes >= 15) clearInterval(timer);
    }, 200);

    const polls: number[] = [];
    const info = await waitUntilStable(path, {
      settleMs: 1000,
      onWait: (ms) => polls.push(ms),
    });
    clearInterval(timer);
    const real = await stat(path);
    await handle.close();

    expect(writes).toBe(15);
    expect(info.size).toBe(real.size);
    // The whole point: the size it settled on is the size AFTER every write, not the
    // partial file it would have read the moment it was asked.
    expect(info.size).toBe(15 * 64 * 1024 + 0);
    expect(polls.length).toBeGreaterThan(2);
  }, 30_000);

  it("fails cleanly when the file is not there", async () => {
    await expect(waitUntilStable(join(dir, "nope.wav"))).rejects.toThrow(/does not exist/);
  });

  it("gives up rather than blocking the queue forever", async () => {
    const path = join(dir, "endless.bin");
    const handle = await open(path, "w");
    const timer = setInterval(() => void handle.write(Buffer.alloc(1024)), 50);
    await expect(waitUntilStable(path, { settleMs: 100, timeoutMs: 400 })).rejects.toThrow(
      /still being written/,
    );
    clearInterval(timer);
    await handle.close();
  }, 20_000);

  it("honours a cancel while waiting", async () => {
    const path = join(dir, "growing.bin");
    const handle = await open(path, "w");
    const timer = setInterval(() => void handle.write(Buffer.alloc(512)), 100);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    await expect(
      waitUntilStable(path, { settleMs: 500, signal: controller.signal }),
    ).rejects.toThrow(/cancelled/);
    clearInterval(timer);
    await handle.close();
  }, 20_000);

  it("passes a directory straight through", async () => {
    // A folder ingest walks its own files; a directory's stat says nothing about them.
    const info = await waitUntilStable(dir, { settleMs: 5_000 });
    expect(info.size).toBe(0);
  });
});
