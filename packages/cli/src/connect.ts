import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { HttpMemloomClient, isOwnerId, type MemoryEngine } from "@memloom/core";
import { configValue, memloomHome } from "./config.js";
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
  const remote = remoteServer();
  // A hosted memloom is someone else's process to run: connect, never auto-start.
  if (remote) return new HttpMemloomClient(remote.url, undefined, owner, remote.token);
  if (await healthy()) return new HttpMemloomClient(BASE, undefined, owner);

  // The daemon's output goes to a file, not nowhere: when it cannot start, what it printed is
  // the only explanation, and an MCP client shows nothing but "connection closed".
  const logPath = daemonLogPath();
  mkdirSync(memloomHome(), { recursive: true });
  const logFd = openSync(logPath, "w");
  const binPath = fileURLToPath(new URL("./bin.js", import.meta.url));
  const child = spawn(process.execPath, [binPath, "serve"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
    windowsHide: true,
  });
  closeSync(logFd);
  let exited: number | null | undefined;
  child.on("exit", (code) => {
    exited = code;
  });
  child.unref();

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await healthy()) return new HttpMemloomClient(BASE, undefined, owner);
    // Exiting is not always failure: a daemon that lost the race to another one exits 0 and
    // the winner answers on the next poll.
    if (exited !== undefined && exited !== 0) break;
  }
  const output = tail(logPath);
  throw new Error(
    exited !== undefined && exited !== 0
      ? `memloom: the local server exited (code ${exited}) before it was ready.` +
          (output ? `\n${output}` : "") +
          `\n  log: ${logPath}`
      : `memloom: could not reach or start the local server at ${BASE}. ` +
          `Try running \`memloom serve\` manually.\n  log: ${logPath}`,
  );
}

/**
 * A hosted memloom to use instead of the local daemon, from MEMLOOM_URL and MEMLOOM_TOKEN (the
 * environment, then ~/.memloom/config.env). Undefined when MEMLOOM_URL is unset, which is every
 * local install.
 */
export function remoteServer(): { url: string; token: string | undefined } | undefined {
  const url = configValue("MEMLOOM_URL");
  if (!url) return undefined;
  if (!/^https?:\/\//.test(url)) {
    throw new Error(
      `memloom: MEMLOOM_URL must start with http:// or https://, got ${JSON.stringify(url)}.`,
    );
  }
  return { url: url.replace(/\/+$/, ""), token: configValue("MEMLOOM_TOKEN") };
}

/** Where hooks send requests: the hosted server when one is set, else the local daemon. */
export function serverBase(): { url: string; headers: Record<string, string> } {
  const remote = remoteServer();
  if (!remote) return { url: BASE, headers: {} };
  return {
    url: remote.url,
    headers: remote.token ? { authorization: `Bearer ${remote.token}` } : {},
  };
}

export function daemonLogPath(): string {
  return join(memloomHome(), "daemon.log");
}

// The last lines of the daemon log, enough to carry its error into a client's message.
function tail(path: string, lines = 8): string {
  try {
    return readFileSync(path, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}
