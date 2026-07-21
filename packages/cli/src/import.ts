import type { ImportResult, ImportSessionEvent, MemoryEngine } from "@memloom/core";

// `memloom import claude-code`: the CLI face of the daemon-side session import. The daemon
// does discovery, redaction, distillation, and the ledger (it is the store's single writer);
// this module only parses flags, renders per-session progress lines, and prints the summary
// with the cost line.

export interface ImportFlags {
  dryRun: boolean;
  force: boolean;
  days?: number;
  maxSessions?: number;
  project?: string;
}

export function parseImportFlags(args: readonly string[]): ImportFlags {
  const flags: ImportFlags = { dryRun: false, force: false };
  const words = [...args];
  while (words.length > 0) {
    const word = words.shift() as string;
    const [flag, inline] = word.includes("=")
      ? [word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1)]
      : [word, undefined];
    const value = () => {
      const v = inline ?? words.shift();
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "--dry-run":
        flags.dryRun = true;
        break;
      case "--force":
        flags.force = true;
        break;
      case "--days": {
        const days = Number(value());
        if (!Number.isInteger(days) || days <= 0) throw new Error("--days must be a positive integer");
        flags.days = days;
        break;
      }
      case "--sessions": {
        const max = Number(value());
        if (!Number.isInteger(max) || max <= 0) {
          throw new Error("--sessions must be a positive integer");
        }
        flags.maxSessions = max;
        break;
      }
      case "--project":
        flags.project = value();
        break;
      default:
        throw new Error(
          `unknown flag ${flag}. usage: memloom import claude-code [--dry-run] [--force] [--days N] [--sessions N] [--project <name>]`,
        );
    }
  }
  return flags;
}

function sessionLine(e: ImportSessionEvent): string {
  const name = `${e.project}/${e.sessionId.slice(0, 8)}`;
  if (e.outcome === "up-to-date") return `[${e.index}/${e.total}] ${name}  up to date`;
  if (e.outcome === "partial") {
    return `[${e.index}/${e.total}] ${name}  stopped mid-session (${e.saved} saved before the failure)`;
  }
  if (e.outcome === "dry-run") {
    return `[${e.index}/${e.total}] ${name}  would distill ${e.chunks} chunk${e.chunks === 1 ? "" : "s"} (${e.redactions} redactions)`;
  }
  const parts = [`saved ${e.saved}`];
  if (e.versioned) parts.push(`versioned ${e.versioned}`);
  if (e.merged) parts.push(`merged ${e.merged}`);
  if (e.conflicts) parts.push(`conflicts ${e.conflicts}`);
  if (e.dropped) parts.push(`dropped ${e.dropped}`);
  if (e.redactions) parts.push(`redacted ${e.redactions}`);
  return `[${e.index}/${e.total}] ${name}  ${parts.join(", ")}`;
}

function skipLine(result: ImportResult): string | null {
  const s = result.skipped;
  const parts = [
    s.upToDate ? `${s.upToDate} up to date` : "",
    s.active ? `${s.active} still active` : "",
    s.outsideWindow ? `${s.outsideWindow} outside the day window` : "",
    s.overCap ? `${s.overCap} beyond the session cap` : "",
    s.sidecars ? `${s.sidecars} subagent sidecars` : "",
  ].filter(Boolean);
  return parts.length > 0 ? `skipped: ${parts.join(", ")} (widen with --days / --sessions)` : null;
}

export async function runImport(engine: MemoryEngine, args: readonly string[]): Promise<void> {
  const flags = parseImportFlags(args);
  const result = await engine.importClaudeCode(
    {
      dryRun: flags.dryRun,
      force: flags.force,
      ...(flags.days !== undefined ? { days: flags.days } : {}),
      ...(flags.maxSessions !== undefined ? { maxSessions: flags.maxSessions } : {}),
      ...(flags.project ? { project: flags.project } : {}),
    },
    (event) => console.log(sessionLine(event)),
  );

  if (result.dryRun) {
    console.log(
      `dry run: ${result.sessions} session${result.sessions === 1 ? "" : "s"} would be distilled ` +
        `(no LLM calls made; a real run makes one extraction call per chunk).`,
    );
  } else {
    const conflictNote = result.conflicts > 0 ? "  (resolve conflicts in the viewer)" : "";
    console.log(
      `imported ${result.sessions} session${result.sessions === 1 ? "" : "s"}: ` +
        `${result.saved} saved, ${result.versioned} versioned, ${result.merged} merged, ` +
        `${result.conflicts} conflicts${conflictNote}`,
    );
    console.log(
      `cost: ${result.calls.extraction} extraction, ${result.calls.classifier} dedup, ` +
        `${result.calls.embedding} embedding calls` +
        (result.redactions ? `  |  ${result.redactions} secrets redacted` : "") +
        (result.truncated ? `  |  ${result.truncated} oversized messages truncated` : ""),
    );
  }
  const skips = skipLine(result);
  if (skips) console.log(skips);
  if (result.error) {
    console.log(`stopped early: ${result.error}`);
    console.log(
      "everything distilled before the failure is saved and watermarked; running the same command again resumes where it stopped.",
    );
  }
}
