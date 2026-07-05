// memloom CLI. Commands: init / save / recall / index / conflicts / serve / ui.
// Prefers a running @memloom/server (routes to it), else opens the store directly with a
// data-dir lock (build-plan D1). The `bin` entry + command wiring land in Phase 5.

export function run(argv: readonly string[]): never {
  void argv;
  throw new Error("memloom CLI is not implemented yet (build-plan Phase 5).");
}
