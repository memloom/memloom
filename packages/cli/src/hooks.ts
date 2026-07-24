import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Claude Code hook management for `memloom connect claude-code`. This module edits the ONE
// file memloom touches that it does not own: the user's Claude Code settings, which may
// carry their own hooks. Every write here merges, never replaces; a backup is taken before
// the first edit; a file that does not parse is refused untouched. The hook itself is a
// thin notifier (`memloom notify claude-code`): it posts the ended session's path to the
// daemon and exits, so a hook timeout or kill can never lose distillation work.

/** The marker that identifies memloom's own hook entry among the user's. */
const HOOK_MARKER = "notify claude-code";

export function claudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

/** The command Claude Code runs at session end. Absolute bin path: PATH-independent. */
export function notifyCommand(): string {
  const bin = fileURLToPath(new URL("./bin.js", import.meta.url));
  return `node "${bin}" notify claude-code`;
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

function isOurs(entry: HookCommand): boolean {
  return typeof entry.command === "string" && entry.command.includes(HOOK_MARKER);
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
  /** Set when this edit created the one-time backup. */
  backupPath?: string;
}

/** Merge memloom's SessionEnd hook into the settings, preserving everything else. */
export function installHook(settingsPath = claudeSettingsPath()): HookEditResult {
  const settings = readSettings(settingsPath);
  const groups = settings.hooks?.SessionEnd ?? [];
  const already = groups.some((group) => (group.hooks ?? []).some(isOurs));
  if (already) return { changed: false };

  const backup = backupOnce(settingsPath);
  settings.hooks = settings.hooks ?? {};
  settings.hooks.SessionEnd = [
    ...groups,
    { hooks: [{ type: "command", command: notifyCommand() }] },
  ];
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { changed: true, ...(backup ? { backupPath: backup } : {}) };
}

/** Remove ONLY memloom's hook entry; the user's own hooks and settings stay byte-equal. */
export function removeHook(settingsPath = claudeSettingsPath()): HookEditResult {
  if (!existsSync(settingsPath)) return { changed: false };
  const settings = readSettings(settingsPath);
  const groups = settings.hooks?.SessionEnd;
  if (!groups) return { changed: false };

  let changed = false;
  const kept = groups
    .map((group) => {
      const hooks = group.hooks ?? [];
      const filtered = hooks.filter((entry) => !isOurs(entry));
      if (filtered.length !== hooks.length) changed = true;
      return { ...group, hooks: filtered };
    })
    // A group that only held our hook disappears entirely; user groups keep their shape.
    .filter((group) => (group.hooks?.length ?? 0) > 0 || Object.keys(group).length > 1);
  if (!changed) return { changed: false };

  const backup = backupOnce(settingsPath);
  if (kept.length > 0) {
    settings.hooks = { ...settings.hooks, SessionEnd: kept };
  } else if (settings.hooks) {
    delete settings.hooks.SessionEnd;
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { changed: true, ...(backup ? { backupPath: backup } : {}) };
}

export function hookInstalled(settingsPath = claudeSettingsPath()): boolean {
  try {
    const settings = readSettings(settingsPath);
    return (settings.hooks?.SessionEnd ?? []).some((group) => (group.hooks ?? []).some(isOurs));
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
