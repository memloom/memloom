import type { Memory } from "@memloom/core";

// The UserPromptSubmit hook: recall memories relevant to the prompt the user just typed and
// print them for Claude to read as context. Everything here is built around one contract:
// in this hook, an escaped error surfaces on the user's prompt as noise (and exit 2 blocks
// the prompt outright), so every failure path (daemon down, store locked, timeout, bad
// payload) resolves to printing nothing and exiting 0. No daemon auto-start, ever: a
// prompt must never spawn one.

export const RECALL_LIMIT = 5;
/**
 * Caps the prompt delay. Recall embeds the query through the provider: ~0.5s warm, but the
 * first call after a daemon start has been measured at ~2.7s, so the cap leaves room for
 * exactly that case. A dead daemon refuses the connection instantly and never waits this long.
 */
export const RECALL_TIMEOUT_MS = 4_000;
export const HIT_CHARS = 400;
export const TOTAL_CHARS = 2_000;

/** Parse the UserPromptSubmit stdin JSON; null when unparseable or there is no prompt. */
export function parsePromptPayload(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { prompt?: unknown };
    return typeof parsed.prompt === "string" ? parsed.prompt : null;
  } catch {
    return null;
  }
}

/** Prompts recall should ignore: empty, slash commands, and ! shell passthrough. */
export function shouldSkipPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  return trimmed === "" || trimmed.startsWith("/") || trimmed.startsWith("!");
}

/** Query the daemon directly; null on any failure (down, 503 store lock, timeout). */
export async function fetchRecall(
  query: string,
  base = "http://127.0.0.1:4319",
): Promise<Memory[] | null> {
  try {
    const res = await fetch(`${base}/memory/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, limit: RECALL_LIMIT }),
      signal: AbortSignal.timeout(RECALL_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const { memories } = (await res.json()) as { memories: Memory[] };
    return Array.isArray(memories) ? memories : null;
  } catch {
    return null;
  }
}

function sourceNote(m: Memory): string {
  if (!m.source) return "";
  const heading = m.source.headingPath ? ` › ${m.source.headingPath}` : "";
  const page = m.source.page != null ? `, p. ${m.source.page}` : "";
  return ` (from ${m.source.title}${heading}${page})`;
}

/**
 * The context block Claude reads. Compact on purpose: this rides along on every prompt, so
 * no ids, dates, or scores; the MCP tools are the path to detail. "" when there is nothing
 * worth injecting.
 */
export function formatRecallBlock(memories: readonly Memory[]): string {
  if (memories.length === 0) return "";
  const lines: string[] = [];
  let used = 0;
  for (const [i, m] of memories.entries()) {
    const label = m.kind === "context" ? "context" : m.memoryType;
    const content =
      m.content.length > HIT_CHARS ? `${m.content.slice(0, HIT_CHARS)}...` : m.content;
    const line = `${i + 1}. [${label}] ${content}${sourceNote(m)}`;
    // The budget bounds the per-prompt token cost; the first hit always makes it in.
    if (lines.length > 0 && used + line.length > TOTAL_CHARS) break;
    lines.push(line);
    used += line.length;
  }
  return [
    '<memloom-memory note="Recalled from your local memloom store. Background context, verify before relying on it.">',
    ...lines,
    "</memloom-memory>",
  ].join("\n");
}

/** The whole hook: read stdin, skip non-prompts, recall, format. Never throws. */
export async function promptRecall(stdin: NodeJS.ReadableStream, base?: string): Promise<string> {
  try {
    let raw = "";
    for await (const piece of stdin) raw += piece;
    const prompt = parsePromptPayload(raw);
    if (prompt === null || shouldSkipPrompt(prompt)) return "";
    const memories = await fetchRecall(prompt, base);
    if (!memories) return "";
    return formatRecallBlock(memories);
  } catch {
    return "";
  }
}
