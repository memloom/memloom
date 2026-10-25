import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSnapshots, openWithFallback, snapshotDir, takeSnapshot } from "./snapshots.js";

// A store that will not open after a crash comes back from the newest snapshot, and the broken
// one is kept for whatever it holds past that.

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "memloom-snapshots-"));
  previousHome = process.env.MEMLOOM_HOME;
  process.env.MEMLOOM_HOME = home;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.MEMLOOM_HOME;
  else process.env.MEMLOOM_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

const open = (dir: string, snapshot?: Blob) =>
  PGlite.create({ dataDir: dir, ...(snapshot ? { loadDataDir: snapshot } : {}) });

// What a crash can leave: a control file that no longer describes the WAL beside it.
function breakStore(dir: string) {
  writeFileSync(join(dir, "global", "pg_control"), Buffer.alloc(8192, 0x5a));
}

describe("store snapshots", () => {
  it("restores the newest snapshot when the store will not open, keeping the broken one", async () => {
    const dir = join(home, "data");
    const db = await open(dir);
    await db.exec("CREATE TABLE kept (v int); INSERT INTO kept VALUES (1)");
    await takeSnapshot(db);
    await db.exec("INSERT INTO kept VALUES (2)");
    await db.close();
    breakStore(dir);

    const lines: string[] = [];
    const { db: back, restored } = await openWithFallback(dir, open, (l) => lines.push(l));
    try {
      expect((await back.query("SELECT v FROM kept")).rows).toEqual([{ v: 1 }]);
    } finally {
      await back.close();
    }
    expect(restored?.brokenDir).toMatch(/data\.broken-/);
    expect(existsSync(join(restored?.brokenDir as string, "global", "pg_control"))).toBe(true);
    expect(lines.join("\n")).toContain("only in the moved store");
  });

  it("leaves a store alone when there is no snapshot to fall back on", async () => {
    const dir = join(home, "data");
    const db = await open(dir);
    await db.close();
    breakStore(dir);
    await expect(openWithFallback(dir, open, () => {})).rejects.toBeDefined();
    expect(existsSync(join(dir, "global", "pg_control"))).toBe(true);
  });

  it("keeps only the newest two", async () => {
    const db = await open(join(home, "data"));
    try {
      for (let i = 0; i < 3; i++) {
        await takeSnapshot(db);
        await new Promise((r) => setTimeout(r, 1100)); // names are to the second
      }
    } finally {
      await db.close();
    }
    const left = listSnapshots(snapshotDir());
    expect(left).toHaveLength(2);
    expect(left[0]?.takenAt.getTime()).toBeGreaterThan(left[1]?.takenAt.getTime() as number);
  });
});
