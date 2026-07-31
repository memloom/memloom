import { mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IngestQueue, type QueueRunner, type QueueSnapshot } from "./queue.js";

// The queue's own home, so a test never touches the developer's real ingest-queue.json.
let home: string;
let dir: string;
let previousHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "memloom-queue-home-"));
  dir = await mkdtemp(join(tmpdir(), "memloom-queue-"));
  previousHome = process.env.MEMLOOM_HOME;
  process.env.MEMLOOM_HOME = home;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.MEMLOOM_HOME;
  else process.env.MEMLOOM_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
});

/** Records the size each path had at the moment the queue actually handed it over. */
function sizeRecordingRunner(): { runner: QueueRunner; sizes: Map<string, number> } {
  const sizes = new Map<string, number>();
  return {
    sizes,
    runner: {
      async ingest(path) {
        sizes.set(path, (await stat(path)).size);
        return { outcome: "added", chunks: 1 };
      },
    },
  };
}

function settled(queue: IngestQueue): Promise<QueueSnapshot> {
  return new Promise((resolve) => {
    const stop = queue.subscribe((snapshot) => {
      const pending = snapshot.items.some((i) => i.status === "queued" || i.status === "running");
      if (!pending) {
        stop();
        resolve(snapshot);
      }
    });
  });
}

describe("IngestQueue stability", () => {
  it("does not hand a still-growing file to the runner until it stops growing", async () => {
    const path = join(dir, "recording.wav");
    const handle = await open(path, "w");
    await handle.write(Buffer.alloc(64 * 1024));

    let writes = 0;
    const timer = setInterval(() => {
      writes++;
      void handle.write(Buffer.alloc(64 * 1024));
      if (writes >= 8) clearInterval(timer);
    }, 200);

    const { runner, sizes } = sizeRecordingRunner();
    const queue = new IngestQueue(runner);
    const done = settled(queue);
    await queue.add([path]);
    const snapshot = await done;
    clearInterval(timer);
    const final = (await stat(path)).size;
    await handle.close();

    expect(snapshot.items[0]?.status).toBe("done");
    // The assertion the whole change exists for: what the runner saw is the finished file,
    // not the prefix that happened to be on disk when the watcher fired.
    expect(sizes.get(path)).toBe(final);
    expect(writes).toBe(8);
  }, 30_000);

  it("reports a waiting stage so the pause is never silent", async () => {
    const path = join(dir, "recording.wav");
    const handle = await open(path, "w");
    const timer = setInterval(() => void handle.write(Buffer.alloc(32 * 1024)), 150);
    setTimeout(() => clearInterval(timer), 1500);

    const stages = new Set<string>();
    const queue = new IngestQueue(sizeRecordingRunner().runner);
    queue.subscribe((snapshot) => {
      for (const item of snapshot.items) if (item.stage) stages.add(item.stage);
    });
    const done = settled(queue);
    await queue.add([path]);
    await done;
    clearInterval(timer);
    await handle.close();

    expect(stages.has("waiting")).toBe(true);
  }, 30_000);

  it("fails the item rather than the daemon when the file is gone", async () => {
    const queue = new IngestQueue(sizeRecordingRunner().runner);
    const done = settled(queue);
    await queue.add([join(dir, "never-existed.wav")]);
    const snapshot = await done;
    expect(snapshot.items[0]?.status).toBe("failed");
    expect(snapshot.items[0]?.error).toMatch(/does not exist/);
  }, 20_000);

  it("still runs a finished file straight through", async () => {
    const path = join(dir, "ready.md");
    await writeFile(path, "# already written");
    const { runner, sizes } = sizeRecordingRunner();
    const queue = new IngestQueue(runner);
    const done = settled(queue);
    await queue.add([path]);
    const snapshot = await done;
    expect(snapshot.items[0]?.status).toBe("done");
    expect(sizes.get(path)).toBeGreaterThan(0);
  }, 20_000);
});
