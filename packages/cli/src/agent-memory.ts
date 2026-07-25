import type { AgentMemoryFolderEvent, AgentMemoryImportResult, MemoryEngine } from "@memloom/core";

// `memloom import agent-memory`: the CLI face of the daemon-side agent memory folder
// import. The daemon does discovery, parsing, redaction, and the ledger (it is the store's
// single writer); this module only parses flags, renders per-folder progress lines, and
// prints the summary. Unlike session import there is no LLM extraction step, so the cost
// line is embeddings and dedup only.

export const AGENT_MEMORY_USAGE =
  "usage: memloom import agent-memory [--dry-run] [--force] [--agent claude-code|copilot] [--project <name>]";

export interface AgentMemoryFlags {
  dryRun: boolean;
  force: boolean;
  agents?: string[];
  project?: string;
}

export function parseAgentMemoryFlags(args: readonly string[]): AgentMemoryFlags {
  const flags: AgentMemoryFlags = { dryRun: false, force: false };
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
      case "--agent":
        flags.agents = [...(flags.agents ?? []), value()];
        break;
      case "--project":
        flags.project = value();
        break;
      default:
        throw new Error(`unknown flag ${flag}. ${AGENT_MEMORY_USAGE}`);
    }
  }
  return flags;
}

function folderLine(e: AgentMemoryFolderEvent): string {
  const name = `${e.agent}/${e.label}`;
  if (e.outcome === "up-to-date") return `[${e.index}/${e.total}] ${name}  up to date`;
  if (e.outcome === "dry-run") {
    const unchanged = e.unchanged ? ` (${e.unchanged} unchanged)` : "";
    return (
      `[${e.index}/${e.total}] ${name}  would import ` +
      `${e.memories - e.unchanged} of ${e.memories} memor${e.memories === 1 ? "y" : "ies"}` +
      unchanged
    );
  }
  if (e.outcome === "partial") {
    return `[${e.index}/${e.total}] ${name}  stopped mid-folder (${e.saved} saved before the failure)`;
  }
  const parts = [`saved ${e.saved}`];
  if (e.versioned) parts.push(`versioned ${e.versioned}`);
  if (e.merged) parts.push(`merged ${e.merged}`);
  if (e.conflicts) parts.push(`conflicts ${e.conflicts}`);
  if (e.unchanged) parts.push(`${e.unchanged} unchanged`);
  if (e.redactions) parts.push(`redacted ${e.redactions}`);
  return `[${e.index}/${e.total}] ${name}  ${parts.join(", ")}`;
}

export async function runAgentMemoryImport(
  engine: MemoryEngine,
  args: readonly string[],
): Promise<void> {
  const flags = parseAgentMemoryFlags(args);
  const result: AgentMemoryImportResult = await engine.importAgentMemories(
    {
      dryRun: flags.dryRun,
      force: flags.force,
      ...(flags.agents ? { agents: flags.agents } : {}),
      ...(flags.project ? { project: flags.project } : {}),
    },
    (event) => console.log(folderLine(event)),
  );

  if (result.folders === 0) {
    console.log(
      "no agent memory folders found. Looked for Claude Code project memory " +
        "(~/.claude/projects/*/memory) and Copilot's memory-tool folder.",
    );
    return;
  }

  if (result.dryRun) {
    console.log(
      `dry run: ${result.memories - result.unchanged} of ${result.memories} memories across ` +
        `${result.folders} folder${result.folders === 1 ? "" : "s"} would be imported ` +
        `(${result.unchanged} unchanged; no provider calls made).`,
    );
  } else {
    const conflictNote = result.conflicts > 0 ? "  (resolve conflicts in the viewer)" : "";
    console.log(
      `imported ${result.folders} folder${result.folders === 1 ? "" : "s"}: ` +
        `${result.saved} saved, ${result.versioned} versioned, ${result.merged} merged, ` +
        `${result.conflicts} conflicts${conflictNote}`,
    );
    console.log(
      `cost: ${result.calls.embedding} embedding, ${result.calls.classifier} dedup calls (no LLM extraction: agent memories are already distilled)` +
        (result.unchanged ? `  |  ${result.unchanged} unchanged skipped free` : "") +
        (result.redactions ? `  |  ${result.redactions} secrets redacted` : ""),
    );
  }
  if (result.error) {
    console.log(`stopped early: ${result.error}`);
    console.log(
      "everything saved before the failure is ledgered; running the same command again resumes where it stopped.",
    );
  }
}
