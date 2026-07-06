import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HttpMemloomClient, type MemoryEngine } from "@memloom/core";
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

// Connect to the single-owner daemon over HTTP, auto-starting it (detached) if it isn't up.
// Surfaces (CLI, MCP) call this instead of opening the store themselves, so the daemon is the
// only process that ever holds the PGLite lock.
export async function connect(): Promise<MemoryEngine> {
  if (await healthy()) return new HttpMemloomClient(BASE);

  const binPath = fileURLToPath(new URL("./bin.js", import.meta.url));
  const child = spawn(process.execPath, [binPath, "serve"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await healthy()) return new HttpMemloomClient(BASE);
  }
  throw new Error(
    `memloom: could not reach or start the local server at ${BASE}. Try running \`memloom serve\` manually.`,
  );
}
