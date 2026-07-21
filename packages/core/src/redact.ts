// Best-effort secret scrubbing for session import. Transcripts capture whatever crossed the
// terminal: pasted API keys, tokens in env dumps, credentialed URLs. Redaction runs BEFORE a
// chunk goes to the LLM provider AND before an excerpt is stored, so a missed distillation
// still never persists or transmits a matched secret. Pattern-based and therefore best-effort
// by design; the docs say so plainly. Patterns aim for high precision (shaped prefixes, long
// minimum lengths) over recall, so ordinary code and prose survive untouched.

const MASK = "[redacted]";

// Order matters only for overlapping matches (each pattern runs over the already-scrubbed
// text); keep the most specific shapes first so a JWT is one hit, not three.
const PATTERNS: RegExp[] = [
  // JWTs: three base64url segments, the first always decoding to {"alg":... ("eyJ").
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/g,
  // Vendor-shaped keys: OpenAI/OpenRouter/Anthropic (sk-), GitHub (ghp_ etc.), npm, Slack,
  // AWS access key ids, Google API keys.
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{16,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[A-Za-z0-9_-]{30,}\b/g,
  // Authorization headers, wherever they were echoed.
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
];

// KEY=value / "key": "value" assignments whose NAME says secret. The name survives (it is
// what makes the memory useful); only the value is masked. Minimum value length 8 keeps
// placeholders like KEY=xxx readable.
const ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|credential)s?[A-Za-z0-9_.-]*)(\s*["']?\s*[=:]\s*)("[^"\n]{8,}"|'[^'\n]{8,}'|[^\s"',;]{8,})/gi;

// Credentialed URLs: scheme://user:password@host. The password alone is masked so the host
// (often the memorable part) stays.
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+):([^@\s/]+)@/gi;

export interface RedactResult {
  text: string;
  /** Total substitutions made; the import summary reports the sum. */
  hits: number;
}

export function redact(input: string): RedactResult {
  let text = input;
  let hits = 0;
  for (const pattern of PATTERNS) {
    text = text.replace(pattern, () => {
      hits++;
      return MASK;
    });
  }
  text = text.replace(ASSIGNMENT, (whole, name: string, sep: string, value: string) => {
    // Already-masked values (from the shaped patterns above) stay as they are.
    if (value.includes(MASK)) return whole;
    hits++;
    return `${name}${sep}${MASK}`;
  });
  text = text.replace(URL_CREDENTIALS, (_whole, prefix: string) => {
    hits++;
    return `${prefix}:${MASK}@`;
  });
  return { text, hits };
}
