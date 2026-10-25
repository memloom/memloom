import type { MemoryEngine } from "@memloom/core";

/**
 * A MemoryEngine that connects on first use instead of before the server starts.
 *
 * An MCP client gives a server a few seconds to answer `initialize`; one that exits first is
 * shown only as "connection closed", with no reason. So the stdio transport comes up at once
 * and the daemon is reached when a tool is called. If that fails, the tool call fails with the
 * daemon's own error, which the calling agent can read and pass on, and the next call tries
 * again, so fixing the store does not need a client restart.
 */
export function lazyEngine(connect: () => Promise<MemoryEngine>): MemoryEngine {
  let pending: Promise<MemoryEngine> | undefined;
  const engine = (): Promise<MemoryEngine> => {
    pending ??= connect().catch((err) => {
      pending = undefined;
      throw err;
    });
    return pending;
  };
  // Start connecting now so the first tool call does not pay for the daemon's start-up.
  engine().catch(() => {});
  return new Proxy({} as MemoryEngine, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      return async (...args: unknown[]) => {
        const target = (await engine()) as unknown as Record<PropertyKey, unknown>;
        const member = target[prop];
        if (typeof member !== "function") {
          throw new TypeError(`memloom: engine has no method ${String(prop)}`);
        }
        return member.apply(target, args);
      };
    },
  });
}
