import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hookInstalled, installHook, notifyCommand, removeHook } from "./hooks.js";

// The merge-safety suite. This is the only file memloom edits that it does not own; a bad
// merge here deletes someone's hooks in a tool they use all day. Every case is about one
// promise: the user's own configuration survives everything memloom does, byte for byte.

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function settingsFile(content?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "memloom-hooks-"));
  dirs.push(dir);
  const path = join(dir, "settings.json");
  if (content !== undefined) writeFileSync(path, JSON.stringify(content, null, 2));
  return path;
}

function read(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

const userSettings = {
  model: "opus",
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-linter" }] }],
    SessionEnd: [{ hooks: [{ type: "command", command: "my-own-cleanup.sh" }] }],
  },
};

describe("installHook", () => {
  it("creates the file and the hook when none exists", () => {
    const path = settingsFile();
    const result = installHook(path);
    expect(result.changed).toBe(true);
    expect(hookInstalled(path)).toBe(true);
  });

  it("merges alongside the user's own hooks, preserving them", () => {
    const path = settingsFile(userSettings);
    installHook(path);
    const after = read(path) as typeof userSettings;
    expect(after.model).toBe("opus");
    expect(after.hooks.PreToolUse).toEqual(userSettings.hooks.PreToolUse);
    expect(after.hooks.SessionEnd[0]).toEqual(userSettings.hooks.SessionEnd[0]);
    expect(after.hooks.SessionEnd).toHaveLength(2);
    expect(JSON.stringify(after.hooks.SessionEnd[1])).toContain("notify claude-code");
  });

  it("is idempotent: a second connect changes nothing", () => {
    const path = settingsFile(userSettings);
    installHook(path);
    const once = readFileSync(path, "utf8");
    const second = installHook(path);
    expect(second.changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(once);
  });

  it("writes a one-time backup before the first edit and never overwrites it", () => {
    const path = settingsFile(userSettings);
    const first = installHook(path);
    expect(first.backupPath).toBe(`${path}.memloom-backup`);
    const backup = readFileSync(`${path}.memloom-backup`, "utf8");
    expect(JSON.parse(backup)).toEqual(userSettings);
    removeHook(path);
    installHook(path);
    // The backup still holds the pre-memloom state, not an intermediate one.
    expect(readFileSync(`${path}.memloom-backup`, "utf8")).toBe(backup);
  });

  it("refuses an unparseable settings file and changes nothing", () => {
    const path = settingsFile();
    writeFileSync(path, "{ this is not json");
    expect(() => installHook(path)).toThrow(/refusing to edit/);
    expect(readFileSync(path, "utf8")).toBe("{ this is not json");
    expect(existsSync(`${path}.memloom-backup`)).toBe(false);
  });

  it("refuses a non-object settings file", () => {
    const path = settingsFile();
    writeFileSync(path, "[1, 2, 3]");
    expect(() => installHook(path)).toThrow(/JSON object/);
  });
});

describe("removeHook", () => {
  it("removes only memloom's entry", () => {
    const path = settingsFile(userSettings);
    installHook(path);
    const result = removeHook(path);
    expect(result.changed).toBe(true);
    const after = read(path) as typeof userSettings;
    expect(after.hooks.SessionEnd).toEqual(userSettings.hooks.SessionEnd);
    expect(after.hooks.PreToolUse).toEqual(userSettings.hooks.PreToolUse);
    expect(after.model).toBe("opus");
    expect(hookInstalled(path)).toBe(false);
  });

  it("cleans up empty hook containers when memloom was the only hook", () => {
    const path = settingsFile();
    installHook(path);
    removeHook(path);
    const after = read(path);
    expect(after.hooks).toBeUndefined();
  });

  it("is a no-op when nothing is installed", () => {
    const path = settingsFile(userSettings);
    const before = readFileSync(path, "utf8");
    expect(removeHook(path).changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(removeHook(join(dirs[0] as string, "missing.json")).changed).toBe(false);
  });
});

describe("notifyCommand", () => {
  it("is an absolute, quoted node invocation carrying the marker", () => {
    const command = notifyCommand();
    expect(command).toMatch(/^node ".+bin\.js" notify claude-code$/);
  });
});
