import { spawn } from "node:child_process";
import type { LlmUsage, LLMProvider } from "./providers.js";

// An LLMProvider that shells out to the Claude Code CLI (`claude -p`), so evals and local
// experiments run on a Claude subscription instead of an API key. Test and eval use only: it
// is not wired into the daemon's provider selection, it has no chat() so the assistant stays
// unavailable, and every call pays a process spawn (seconds of startup) that a production
// pipeline could not afford. The CLI must be installed and logged in (`claude login`); a
// logged-out CLI answers every call with an auth error, which surfaces here as a thrown error
// instead of an empty reply so a run never silently scores zero.

export interface ClaudeCliOptions {
  /** Model alias or id passed as --model; omitted = the CLI's default. */
  model?: string;
  /** The executable to run. Default "claude"; tests point it at a node script. */
  command?: string;
  /** Extra arguments inserted before the prompt flags (tests, --settings, ...). */
  extraArgs?: string[];
  /** Max concurrent CLI processes. Default 2: each spawn is a whole Node process. */
  concurrency?: number;
  /** Per-call wall clock before the process is killed. Default 180 s. */
  timeoutMs?: number;
}

// The CLI wraps a coding agent around the model. This system prompt replaces that persona with
// a plain completion contract so the model answers the prompt instead of acting on it.
const COMPLETION_SYSTEM_PROMPT =
  "You are a text-processing function. Answer the prompt you are given and nothing else: " +
  "no preamble, no commentary, no questions back. You have no tools and no filesystem.";

interface CliEnvelope {
  type?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class ClaudeCliLLM implements LLMProvider {
  readonly #model: string | undefined;
  readonly #command: string;
  readonly #extraArgs: string[];
  readonly #timeoutMs: number;
  readonly #limit: number;
  #running = 0;
  readonly #waiting: Array<() => void> = [];
  /** Calls made so far, for the eval's cost line. */
  calls = 0;

  constructor(opts: ClaudeCliOptions = {}) {
    this.#model = opts.model;
    this.#command = opts.command ?? "claude";
    this.#extraArgs = opts.extraArgs ?? [];
    this.#timeoutMs = opts.timeoutMs ?? 180_000;
    this.#limit = Math.max(1, opts.concurrency ?? 2);
  }

  get model(): string {
    return this.#model ?? "claude-cli-default";
  }

  async complete(
    prompt: string,
    opts: { onUsage?: (usage: LlmUsage) => void } = {},
  ): Promise<string> {
    await this.#acquire();
    try {
      this.calls++;
      const envelope = await this.#run(prompt);
      if (envelope.is_error) {
        throw new Error(`claude -p failed: ${envelope.result ?? "unknown error"}`);
      }
      if (opts.onUsage) {
        opts.onUsage({
          inputTokens: Number(envelope.usage?.input_tokens ?? 0),
          outputTokens: Number(envelope.usage?.output_tokens ?? 0),
          usd: typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : null,
        });
      }
      return envelope.result ?? "";
    } finally {
      this.#release();
    }
  }

  // The prompt goes over stdin: distillation prompts run to 24k+ characters, past the
  // command-line limit on Windows. Session persistence and settings are off so an eval never
  // writes into ~/.claude/projects or picks up a CLAUDE.md from the cwd.
  #run(prompt: string): Promise<CliEnvelope> {
    const args = [
      ...this.#extraArgs,
      "-p",
      "--output-format",
      "json",
      "--tools",
      "",
      "--no-session-persistence",
      "--setting-sources",
      "",
      "--system-prompt",
      COMPLETION_SYSTEM_PROMPT,
      ...(this.#model ? ["--model", this.#model] : []),
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(this.#command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        // The parent session's own Claude variables (a nested Claude Code run, a proxy base URL)
        // would redirect or confuse the child; strip them so the CLI authenticates on its own.
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !key.startsWith("CLAUDE") && key !== "ANTHROPIC_BASE_URL",
          ),
        ) as NodeJS.ProcessEnv,
        // No shell, on any platform: a shell drops the empty `--tools ""` value and splits the
        // system prompt into loose words. The native installer ships claude.exe, which spawn
        // finds on PATH directly; an npm .cmd shim needs `command` set to its full path.
        shell: false,
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`claude -p timed out after ${this.#timeoutMs / 1000}s`));
      }, this.#timeoutMs);
      child.stdout.on("data", (buf: Buffer) => {
        stdout += buf.toString("utf8");
      });
      child.stderr.on("data", (buf: Buffer) => {
        stderr += buf.toString("utf8");
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`could not start ${this.#command}: ${err.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const parsed = parseEnvelope(stdout);
        if (parsed) {
          resolve(parsed);
          return;
        }
        reject(
          new Error(
            `claude -p exited ${code} without a JSON result` +
              (stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""),
          ),
        );
      });
      child.stdin.on("error", () => {
        // A child that dies before reading stdin closes the pipe; the close handler reports it.
      });
      child.stdin.end(prompt);
    });
  }

  #acquire(): Promise<void> {
    if (this.#running < this.#limit) {
      this.#running++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#waiting.push(() => {
        this.#running++;
        resolve();
      });
    });
  }

  #release(): void {
    this.#running--;
    this.#waiting.shift()?.();
  }
}

/** The last JSON object on stdout: the CLI may print warnings before the result envelope. */
export function parseEnvelope(stdout: string): CliEnvelope | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed) as CliEnvelope;
    return typeof obj === "object" && obj !== null ? obj : null;
  } catch {
    // Scan for the result object from the end, in case of leading noise.
    const start = trimmed.lastIndexOf('{"');
    if (start < 0) return null;
    try {
      return JSON.parse(trimmed.slice(start)) as CliEnvelope;
    } catch {
      return null;
    }
  }
}
