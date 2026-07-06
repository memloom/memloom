import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// memloom's home: ~/.memloom (override with MEMLOOM_HOME). Layout:
//   ~/.memloom/config.env   settings the daemon reads at startup (API key, models)
//   ~/.memloom/data/        the Postgres data directory — your memory, copy/back it up
export function memloomHome(): string {
  return process.env.MEMLOOM_HOME ?? join(homedir(), ".memloom");
}

export function dataDir(): string {
  return join(memloomHome(), "data");
}

export function configPath(): string {
  return join(memloomHome(), "config.env");
}

const CONFIG_TEMPLATE = `# memloom configuration. The daemon (\`memloom serve\`) reads this at startup.
# Real environment variables take precedence over values here.

# OpenRouter API key: enables real embeddings + LLM dedup/conflict detection/entities.
# Without it, memloom runs in offline mode (deterministic embeddings, no dedup).
# OPENROUTER_API_KEY=sk-or-...

# Optional model overrides (defaults shown):
# OPENROUTER_EMBED_MODEL=qwen/qwen3-embedding-8b
# OPENROUTER_EMBED_DIMS=1024
# OPENROUTER_LLM_MODEL=google/gemini-2.5-flash
`;

/** Create the home + a commented config template if missing. Returns the config path. */
export function ensureConfig(): string {
  mkdirSync(memloomHome(), { recursive: true });
  const path = configPath();
  if (!existsSync(path)) writeFileSync(path, CONFIG_TEMPLATE);
  return path;
}

/**
 * Load ~/.memloom/config.env into process.env (dotenv-style KEY=VALUE lines; # comments).
 * Values already present in the real environment win, so a shell/MCP-provided key overrides
 * the file. Called by the daemon at startup — the one place config needs to exist.
 */
export function loadConfigEnv(): void {
  const path = configPath();
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
