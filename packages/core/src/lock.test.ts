import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDataDirLock, clearBogusPostmasterPid, lockHolderGone } from "./lock.js";
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

  it("opens a store whose postmaster.pid was left blank by a crash", async () => {
    const dir = tempDir();
    const first = await PgliteAdapter.open({ dataDir: dir });
    await first.exec("CREATE TABLE kept (v int); INSERT INTO kept VALUES (7)");
    await first.close();
    // What a crash mid-write leaves behind: the file's length, none of its content.
    writeFileSync(join(dir, "postmaster.pid"), "\0".repeat(55));
    const second = await PgliteAdapter.open({ dataDir: dir });
    try {
      expect(await second.query("SELECT v FROM kept")).toEqual([{ v: 7 }]);
    } finally {
      await second.close();
    }
  });

  it("leaves a postmaster.pid that holds a pid alone", () => {
    const dir = tempDir();
    const pidFile = join(dir, "postmaster.pid");
    writeFileSync(pidFile, "-42\n/pglite/data\n1791967088\n5432\n");
    expect(clearBogusPostmasterPid(dir)).toBe(false);
    expect(existsSync(pidFile)).toBe(true);
    writeFileSync(pidFile, " ".repeat(55));
    expect(clearBogusPostmasterPid(dir)).toBe(true);
    expect(existsSync(pidFile)).toBe(false);
  });

  // What another process leaves behind: the lock folder, aged past any time limit, and its
  // owner record.
  function leftLock(dir: string, owner: { pid: number; bootedAt: number }) {
    mkdirSync(`${dir}.lock`);
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(`${dir}.lock`, old, old);
    writeFileSync(`${dir}.lock-owner.json`, JSON.stringify(owner));
  }
  const thisBoot = () => Date.now() - uptime() * 1000;

  it("does not take the store from a holder that is alive but busy", async () => {
    const dir = tempDir();
    const busy = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
    try {
      leftLock(dir, { pid: busy.pid as number, bootedAt: thisBoot() });
      expect(lockHolderGone(dir)).toBe(false);
    } finally {
      busy.kill();
    }
  });

  it("takes over the lock of a process that has exited", async () => {
    const dir = tempDir();
    const gone = spawn(process.execPath, ["-e", ""]);
    await new Promise((r) => gone.once("exit", r));
    leftLock(dir, { pid: gone.pid as number, bootedAt: thisBoot() });
    expect(lockHolderGone(dir)).toBe(true);
    const release = await acquireDataDirLock(dir);
    await release();
  });

  it("takes over a lock left before a reboot, even if its pid is in use again", async () => {
    const dir = tempDir();
    const reused = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
    try {
      leftLock(dir, { pid: reused.pid as number, bootedAt: thisBoot() - 24 * 60 * 60_000 });
      expect(lockHolderGone(dir)).toBe(true);
      const release = await acquireDataDirLock(dir);
      await release();
    } finally {
      reused.kill();
    }
  });
});
