import { homedir } from "node:os";
import { join } from "node:path";

// Where the local store lives: ~/.memloom by default (override with MEMLOOM_HOME). This is a
// real Postgres data directory owned by the `memloom serve` daemon.
export function storeDir(): string {
  return process.env.MEMLOOM_HOME ?? join(homedir(), ".memloom");
}
