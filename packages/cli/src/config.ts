import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// memloom's home: ~/.memloom (override with MEMLOOM_HOME). Layout:
//   ~/.memloom/config.env   settings the daemon reads at startup (API key, models)
//   ~/.memloom/data/        the Postgres data directory: your memory, copy/back it up
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
# Assistant chat model (defaults to OPENROUTER_LLM_MODEL; must support tool calling):
# OPENROUTER_CHAT_MODEL=google/gemini-2.5-flash

# Preferred OpenRouter host for embeddings (latency varies a lot between hosts of the same
# model; nebius is the fast one for the default model and is used automatically):
# OPENROUTER_EMBED_PROVIDER=nebius

# New memories and files are entity-indexed automatically in the background (one LLM call
# per item, debounced). Set to off to index only via \`memloom index\` / the Console:
# MEMLOOM_AUTO_INDEX=on

# Indexing runs entity extraction on a worker pool; raise or lower the concurrency:
# MEMLOOM_INDEX_CONCURRENCY=6

# Stop \`memloom reconcile\` from ever changing anything, on a host that wants its reports and
# none of its repairs. Which passes run is a setting in the viewer, not an env var, and the
# three that cost money are off until you turn them on. This is a kill switch, not the switch:
# RECONCILE_ENABLED=0

# Linked files and folders are kept in step with disk: an edited file is re-ingested (only the
# chunks that changed are re-embedded) and a file that appears in a watched folder is taken in on
# its own. Set to off to stop watching; folders stay recorded, so it resumes where it left off:
# MEMLOOM_SYNC=off
# How often every watched folder is re-walked, as a safety net for dropped OS events
# (milliseconds, minimum 10000):
# MEMLOOM_SYNC_RESCAN_MS=60000
# Poll instead of subscribing to OS events. \`auto\` polls only UNC paths (\\\\server\\share),
# where events are least likely to arrive; \`on\` forces it, \`off\` forbids it:
# MEMLOOM_SYNC_POLL=auto

# Notion connector: create an internal integration at notion.so/profile/integrations,
# share your pages with it, and put the token here. Pick pages with \`memloom notion connect\`.
# NOTION_TOKEN=ntn_...
# How often the daemon checks Notion for edits (milliseconds, minimum 60000):
# NOTION_POLL_MS=300000

# Postgres wire port for DB tools (Drizzle Studio, psql), default 54329. On Windows,
# Hyper-V/WSL/Docker reserve random port blocks at boot and one can land on 54329; the daemon
# then starts without the wire and says so. Move it to a free port below 49152:
# MEMLOOM_PG_PORT=45432

# Storage tier. Default is the embedded PGLite store in ~/.memloom/data (zero setup). To run
# on a real Postgres server instead (local Docker or managed cloud; pgvector must be
# available), point memloom at it and restart:
# MEMLOOM_PG_URL=postgres://user:password@localhost:5432/memloom

# Everything memloom keeps lives under one directory: this file, the store, downloaded models,
# uploaded media, cached transcripts. Move all of it at once by moving the home:
# MEMLOOM_HOME=/path/to/memloom

# Transcription. Speech models are hundreds of megabytes, so they are downloaded once and
# shared by every project on the machine. Pick one with \`memloom asr\` or in Settings; this
# pins a model for a single run without changing the saved choice:
# MEMLOOM_ASR_MODEL=parakeet-v3
# MEMLOOM_MODEL_DIR=~/.memloom/models

# Transcribing an hour of audio takes minutes, so results are cached by file hash and model.
# Deleting a cached transcript makes the next import redo the work:
# MEMLOOM_TRANSCRIPT_DIR=~/.memloom/transcripts

# Uploaded media is copied here rather than left in the system temp directory, which Windows
# clears whenever it likes. Deleting a document deletes its bytes from here too:
# MEMLOOM_UPLOAD_DIR=~/.memloom/uploads

# Transcription runs in a worker thread so a long file cannot block the daemon. Set this to 1
# to run it in the main process instead, which is only useful when debugging the worker:
# MEMLOOM_ASR_INPROC=1

# Diarization: who spoke when, in a recording with more than one voice. The number of speakers
# is worked out from the audio by default. Set the count when you already know it, which is
# more reliable than any threshold:
# MEMLOOM_DIARIZE_SPEAKERS=2
# How readily two stretches of speech are treated as the same person, from 0 to 1. Lower splits
# one speaker into several, higher merges different people into one:
# MEMLOOM_DIARIZE_THRESHOLD=0.6

# Naming a voice teaches memloom that voice, so the same person is recognised in later
# recordings. Deliberately conservative: a missed match costs one manual rename, a false match
# puts a stranger's words under someone's name:
# MEMLOOM_VOICE_MATCH_THRESHOLD=0.8
`;

/** The commented template `memloom init` writes. Exported so a test can hold it to the copy in
 * config.env.example, which is the same list and has drifted from it before. */
export function configTemplate(): string {
  return CONFIG_TEMPLATE;
}

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
 * the file. Called by the daemon at startup, the one place config needs to exist.
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
