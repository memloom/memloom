import {
  AuthStore,
  isOwnerId,
  migrate,
  PgAdapter,
  PgliteAdapter,
  SENTINEL_OWNER,
  type StorageAdapter,
  storedEmbeddingDims,
} from "@memloom/core";
import { dataDir, ensureConfig, loadConfigEnv } from "./config.js";
import { buildEngineDeps } from "./engine-config.js";

// `memloom token`: API tokens for a hosted memloom. Run where the store is reachable: on the
// server itself (fly ssh console), or anywhere with the same MEMLOOM_PG_URL. Opens the store
// directly rather than asking the server, because the server only answers callers that
// already hold a token.
//
// On an embedded store that means the daemon must be stopped: the data-dir lock says so.

async function openStore(): Promise<StorageAdapter> {
  ensureConfig();
  loadConfigEnv();
  const deps = buildEngineDeps();
  const storage = deps.pgUrl
    ? await PgAdapter.connect(deps.pgUrl)
    : await PgliteAdapter.open({ dataDir: dataDir() });
  // The token tables come with the regular migrations; a store a hosted server has never
  // opened may not have them yet.
  await migrate(storage, (await storedEmbeddingDims(storage)) ?? deps.embedDims ?? 1024);
  return storage;
}

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const USAGE = `usage:
  memloom token create [--label <name>]   print a new API token (shown once)
  memloom token list                      tokens that can still be used
  memloom token revoke <id-prefix|token>  stop a token working`;

export async function runToken(args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub !== "create" && sub !== "list" && sub !== "revoke") {
    console.log(USAGE);
    if (sub) process.exitCode = 1;
    return;
  }
  const storage = await openStore();
  let failed = false;
  try {
    const store = new AuthStore(storage);
    if (sub === "create") {
      const owner = process.env.MEMLOOM_OWNER_ID?.trim().toLowerCase() || SENTINEL_OWNER;
      if (!isOwnerId(owner)) throw new Error("MEMLOOM_OWNER_ID must be a uuid");
      const issued = await store.issue(owner, "api", { label: flag(rest, "--label") ?? "" });
      console.log(issued.token);
      console.error(
        "Shown once. Put it in MEMLOOM_TOKEN or your MCP client's Authorization header.",
      );
    } else if (sub === "list") {
      const rows = (await store.list()).filter((r) => r.kind === "api");
      if (rows.length === 0) console.log("no API tokens");
      for (const r of rows) {
        const used = r.lastUsedAt ? r.lastUsedAt.toISOString() : "never";
        console.log(`${r.hash.slice(0, 12)}  ${r.label || "(no label)"}  last used ${used}`);
      }
    } else {
      const target = rest[0];
      if (!target) throw new Error("name a token: memloom token revoke <id-prefix|token>");
      const matches = (await store.list()).filter((r) => r.hash.startsWith(target));
      if (matches.length > 1)
        throw new Error(`${target} matches ${matches.length} tokens; use more of it`);
      const removed = await store.revoke(matches[0]?.hash ?? target);
      console.log(removed ? "revoked" : "no such token");
      if (!removed) failed = true;
    }
  } catch (err) {
    console.error(`memloom: ${err instanceof Error ? err.message : String(err)}`);
    failed = true;
  } finally {
    await storage.close();
  }
  if (failed) process.exitCode = 1;
}
