import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { HttpMemloomClient, isOwnerId, type MemoryEngine } from "@memloom/core";
import { HTTP_PORT } from "./daemon.js";

const BASE = `http://127.0.0.1:${HTTP_PORT}`;

async function healthy(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(600) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Whose memories this process works with, from MEMLOOM_OWNER_ID.
 *
 * The environment, never a command flag or a tool argument: which person a surface acts for is
 * a property of how it was launched, not of what it was asked to do. An MCP registration block
 * or a shell profile sets it once; a model calling a tool can never choose it.
 *
 * Unset is the daemon's own default owner, which is what every single-owner install has always
 * been, so nothing changes for anyone who never sets it. A malformed value is refused rather
 * than ignored: falling back to the shared owner because of a typo is how one person's
 * memories end up in everybody's session.
 */
export function ownerFromEnv(): string | undefined {
  const raw = process.env.MEMLOOM_OWNER_ID?.trim();
  if (!raw) return undefined;
  if (!isOwnerId(raw)) {
    throw new Error(
      `memloom: MEMLOOM_OWNER_ID must be a uuid, got ${JSON.stringify(raw)}. ` +
        "Leave it unset for a single-owner store.",
    );
  }
  return raw.toLowerCase();
}

// Connect to the daemon over HTTP, auto-starting it (detached) if it isn't up. Surfaces (CLI,
// MCP) call this instead of opening the store themselves, so the daemon is the only process
// that ever holds the PGLite lock.
//
// The daemon is shared by everyone on the machine; the OWNER is per connection. That is what
// lets two agents, or two people, work through one daemon without reading each other's
// memories.
export async function connect(): Promise<MemoryEngine> {
  const owner = ownerFromEnv();
  if (await healthy()) return new HttpMemloomClient(BASE, undefined, owner);

  const binPath = fileURLToPath(new URL("./bin.js", import.meta.url));
  const child = spawn(process.execPath, [binPath, "serve"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await healthy()) return new HttpMemloomClient(BASE, undefined, owner);
  }
  throw new Error(
    `memloom: could not reach or start the local server at ${BASE}. Try running \`memloom serve\` manually.`,
  );
}
