import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Claude Code hook management for `memloom connect claude-code`. This module edits the ONE
// file memloom touches that it does not own: the user's Claude Code settings, which may
// carry their own hooks. Every write here merges, never replaces; a backup is taken before
// the first edit; a file that does not parse is refused untouched. memloom installs two
// hooks: a SessionEnd notifier (`memloom notify claude-code`) that posts the ended session
// to the daemon, and a UserPromptSubmit recaller (`memloom prompt-recall claude-code`) that
// prints relevant memories for Claude to read. Both are thin and silent: a hook timeout or
// kill can never lose work or block a prompt.

/** One memloom hook: the Claude Code event it registers under, and the CLI invocation. */
export interface HookSpec {
  event: string;
  /** Subcommand + args after the bin path; doubles as the marker that identifies our entry. */
  invocation: string;
}

export const SESSION_END_HOOK: HookSpec = { event: "SessionEnd", invocation: "notify claude-code" };
export const PROMPT_RECALL_HOOK: HookSpec = {
  event: "UserPromptSubmit",
  invocation: "prompt-recall claude-code",
};
export const ALL_HOOKS: readonly HookSpec[] = [SESSION_END_HOOK, PROMPT_RECALL_HOOK];

export function claudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

/** The command Claude Code runs for a hook. Absolute bin path: PATH-independent. */
export function hookCommand(spec: HookSpec): string {
  const bin = fileURLToPath(new URL("./bin.js", import.meta.url));
  return `node "${bin}" ${spec.invocation}`;
}

/** Kept for callers/tests that predate multiple hooks. */
export function notifyCommand(): string {
  return hookCommand(SESSION_END_HOOK);
}

interface HookCommand {
  type?: string;
  command?: string;
  [key: string]: unknown;
}

interface HookGroup {
  hooks?: HookCommand[];
  [key: string]: unknown;
}

interface Settings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

function isOurs(entry: HookCommand, spec: HookSpec): boolean {
  return typeof entry.command === "string" && entry.command.includes(spec.invocation);
}

/** Parse the settings file; a file that exists but does not parse is refused, not clobbered. */
function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `refusing to edit ${path}: it is not valid JSON. Fix it (or move it aside) and retry; nothing was changed.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `refusing to edit ${path}: expected a JSON object at the top level. Nothing was changed.`,
    );
  }
  return parsed as Settings;
}

// One backup, taken before memloom's FIRST edit ever and never overwritten after: it must
// stay the pre-memloom state, not roll forward with each connect.
function backupOnce(path: string): string | null {
  if (!existsSync(path)) return null;
  const backup = `${path}.memloom-backup`;
  if (existsSync(backup)) return null;
  copyFileSync(path, backup);
  return backup;
}

export interface HookEditResult {
  changed: boolean;
  /** The invocations this edit actually added or removed. */
  edited: string[];
  /** Set when this edit created the one-time backup. */
  backupPath?: string;
}

/** Merge the given memloom hooks into the settings, preserving everything else. */
export function installHooks(
  specs: readonly HookSpec[],
  settingsPath = claudeSettingsPath(),
): HookEditResult {
  const settings = readSettings(settingsPath);
  const missing = specs.filter(
    (spec) =>
      !(settings.hooks?.[spec.event] ?? []).some((group) =>
        (group.hooks ?? []).some((entry) => isOurs(entry, spec)),
      ),
  );
  if (missing.length === 0) return { changed: false, edited: [] };

  const backup = backupOnce(settingsPath);
  settings.hooks = settings.hooks ?? {};
  for (const spec of missing) {
    settings.hooks[spec.event] = [
      ...(settings.hooks[spec.event] ?? []),
      { hooks: [{ type: "command", command: hookCommand(spec) }] },
    ];
  }
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return {
    changed: true,
    edited: missing.map((spec) => spec.invocation),
    ...(backup ? { backupPath: backup } : {}),
  };
}

/** Remove ONLY the given memloom hook entries; the user's own hooks stay byte-equal. */
export function removeHooks(
  specs: readonly HookSpec[],
  settingsPath = claudeSettingsPath(),
): HookEditResult {
  if (!existsSync(settingsPath)) return { changed: false, edited: [] };
  const settings = readSettings(settingsPath);
  if (!settings.hooks) return { changed: false, edited: [] };

  const edited: string[] = [];
  for (const spec of specs) {
    const groups = settings.hooks[spec.event];
    if (!groups) continue;
    let removed = false;
    const kept = groups
      .map((group) => {
        const hooks = group.hooks ?? [];
        const filtered = hooks.filter((entry) => !isOurs(entry, spec));
        if (filtered.length !== hooks.length) removed = true;
        return { ...group, hooks: filtered };
      })
      // A group that only held our hook disappears entirely; user groups keep their shape.
      .filter((group) => (group.hooks?.length ?? 0) > 0 || Object.keys(group).length > 1);
    if (!removed) continue;
    edited.push(spec.invocation);
    if (kept.length > 0) settings.hooks[spec.event] = kept;
    else delete settings.hooks[spec.event];
  }
  if (edited.length === 0) return { changed: false, edited: [] };

  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  const backup = backupOnce(settingsPath);
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { changed: true, edited, ...(backup ? { backupPath: backup } : {}) };
}

export function hookInstalled(spec: HookSpec, settingsPath = claudeSettingsPath()): boolean {
  try {
    const settings = readSettings(settingsPath);
    return (settings.hooks?.[spec.event] ?? []).some((group) =>
      (group.hooks ?? []).some((entry) => isOurs(entry, spec)),
    );
  } catch {
    return false;
  }
}

// ---- The notifier ------------------------------------------------------------------------

/**
 * The hook's stdin payload from Claude Code. Only the transcript path matters; everything
 * else is ignored so schema drift across Claude Code versions cannot break the notifier.
 */
export async function readNotifyPayload(stdin: NodeJS.ReadableStream): Promise<string | null> {
  let raw = "";
  for await (const piece of stdin) raw += piece;
  try {
    const parsed = JSON.parse(raw) as { transcript_path?: string; transcriptPath?: string };
    return parsed.transcript_path ?? parsed.transcriptPath ?? null;
  } catch {
    return null;
  }
}

/**
 * Post the ended session to the daemon. Deliberately quiet and fast: no daemon auto-start
 * (a session ending must never spawn one; the startup sweep covers the gap), a short
 * timeout, and exit 0 no matter what, so Claude Code never surfaces memloom noise.
 */
export async function notifyDaemon(path: string, base = "http://127.0.0.1:4319"): Promise<boolean> {
  try {
    const res = await fetch(`${base}/import/claude-code/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
      signal: AbortSignal.timeout(1_500),
    });
    return res.ok;
  } catch {
    return false;
  }
}
