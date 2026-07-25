import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALL_HOOKS,
  hookCommand,
  hookInstalled,
  installHooks,
  notifyCommand,
  PROMPT_RECALL_HOOK,
  removeHooks,
  SESSION_END_HOOK,
} from "./hooks.js";

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
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "my-own-context.sh" }] }],
  },
};

describe("installHooks", () => {
  it("creates the file and both hooks when none exists", () => {
    const path = settingsFile();
    const result = installHooks(ALL_HOOKS, path);
    expect(result.changed).toBe(true);
    expect(result.edited).toEqual(["notify claude-code", "prompt-recall claude-code"]);
    expect(hookInstalled(SESSION_END_HOOK, path)).toBe(true);
    expect(hookInstalled(PROMPT_RECALL_HOOK, path)).toBe(true);
  });

  it("merges alongside the user's own hooks, preserving them", () => {
    const path = settingsFile(userSettings);
    installHooks(ALL_HOOKS, path);
    const after = read(path) as typeof userSettings;
    expect(after.model).toBe("opus");
    expect(after.hooks.PreToolUse).toEqual(userSettings.hooks.PreToolUse);
    expect(after.hooks.SessionEnd[0]).toEqual(userSettings.hooks.SessionEnd[0]);
    expect(after.hooks.SessionEnd).toHaveLength(2);
    expect(JSON.stringify(after.hooks.SessionEnd[1])).toContain("notify claude-code");
    expect(after.hooks.UserPromptSubmit[0]).toEqual(userSettings.hooks.UserPromptSubmit[0]);
    expect(after.hooks.UserPromptSubmit).toHaveLength(2);
    expect(JSON.stringify(after.hooks.UserPromptSubmit[1])).toContain("prompt-recall claude-code");
  });

  it("is idempotent: a second connect changes nothing", () => {
    const path = settingsFile(userSettings);
    installHooks(ALL_HOOKS, path);
    const once = readFileSync(path, "utf8");
    const second = installHooks(ALL_HOOKS, path);
    expect(second.changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(once);
  });

  it("adds only the missing hook when the other is already installed", () => {
    // The upgrade path: a pre-0.5.0 connect installed SessionEnd only; re-connecting
    // must add prompt recall without touching the existing entry.
    const path = settingsFile(userSettings);
    installHooks([SESSION_END_HOOK], path);
    const sessionEnd = (read(path) as typeof userSettings).hooks.SessionEnd;
    const result = installHooks(ALL_HOOKS, path);
    expect(result.edited).toEqual(["prompt-recall claude-code"]);
    const after = read(path) as typeof userSettings;
    expect(after.hooks.SessionEnd).toEqual(sessionEnd);
    expect(hookInstalled(PROMPT_RECALL_HOOK, path)).toBe(true);
  });

  it("writes a one-time backup before the first edit and never overwrites it", () => {
    const path = settingsFile(userSettings);
    const first = installHooks(ALL_HOOKS, path);
    expect(first.backupPath).toBe(`${path}.memloom-backup`);
    const backup = readFileSync(`${path}.memloom-backup`, "utf8");
    expect(JSON.parse(backup)).toEqual(userSettings);
    removeHooks(ALL_HOOKS, path);
    installHooks(ALL_HOOKS, path);
    // The backup still holds the pre-memloom state, not an intermediate one.
    expect(readFileSync(`${path}.memloom-backup`, "utf8")).toBe(backup);
  });

  it("refuses an unparseable settings file and changes nothing", () => {
    const path = settingsFile();
    writeFileSync(path, "{ this is not json");
    expect(() => installHooks(ALL_HOOKS, path)).toThrow(/refusing to edit/);
    expect(readFileSync(path, "utf8")).toBe("{ this is not json");
    expect(existsSync(`${path}.memloom-backup`)).toBe(false);
  });

  it("refuses a non-object settings file", () => {
    const path = settingsFile();
    writeFileSync(path, "[1, 2, 3]");
    expect(() => installHooks(ALL_HOOKS, path)).toThrow(/JSON object/);
  });
});

describe("removeHooks", () => {
  it("removes only memloom's entries", () => {
    const path = settingsFile(userSettings);
    installHooks(ALL_HOOKS, path);
    const result = removeHooks(ALL_HOOKS, path);
    expect(result.changed).toBe(true);
    const after = read(path) as typeof userSettings;
    expect(after.hooks.SessionEnd).toEqual(userSettings.hooks.SessionEnd);
    expect(after.hooks.UserPromptSubmit).toEqual(userSettings.hooks.UserPromptSubmit);
    expect(after.hooks.PreToolUse).toEqual(userSettings.hooks.PreToolUse);
    expect(after.model).toBe("opus");
    expect(hookInstalled(SESSION_END_HOOK, path)).toBe(false);
    expect(hookInstalled(PROMPT_RECALL_HOOK, path)).toBe(false);
  });

  it("removes just the recall hook when asked (the --no-recall path)", () => {
    const path = settingsFile(userSettings);
    installHooks(ALL_HOOKS, path);
    const result = removeHooks([PROMPT_RECALL_HOOK], path);
    expect(result.edited).toEqual(["prompt-recall claude-code"]);
    expect(hookInstalled(SESSION_END_HOOK, path)).toBe(true);
    expect(hookInstalled(PROMPT_RECALL_HOOK, path)).toBe(false);
  });

  it("cleans up empty hook containers when memloom held the only hooks", () => {
    const path = settingsFile();
    installHooks(ALL_HOOKS, path);
    removeHooks(ALL_HOOKS, path);
    const after = read(path);
    expect(after.hooks).toBeUndefined();
  });

  it("is a no-op when nothing is installed", () => {
    const path = settingsFile(userSettings);
    const before = readFileSync(path, "utf8");
    expect(removeHooks(ALL_HOOKS, path).changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(removeHooks(ALL_HOOKS, join(dirs[0] as string, "missing.json")).changed).toBe(false);
  });
});

describe("hookCommand", () => {
  it("is an absolute, quoted node invocation carrying the marker", () => {
    expect(notifyCommand()).toMatch(/^node ".+bin\.js" notify claude-code$/);
    expect(hookCommand(PROMPT_RECALL_HOOK)).toMatch(/^node ".+bin\.js" prompt-recall claude-code$/);
  });
});
