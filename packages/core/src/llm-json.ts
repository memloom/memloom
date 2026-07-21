// Tolerant JSON extraction for LLM replies, shared by every prompt module (dedup, distill).
// Models wrap JSON in prose, code fences, or trailing commentary; the parsers here find the
// payload and swallow the noise instead of throwing. One copy, so the quirks stay fixed once.

/** The first [...] span in the reply parsed as an array, or [] when none parses. */
export function extractJsonArray(raw: string): unknown[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
