# Design: node versioning (history of changes)

Status: **built** (pre-launch), 2026-07-09. Core + HTTP + CLI shipped; 100 tests green. MCP
tools and a viewer history drill-down are the noted follow-ups.

## Problem

Today a memory is a single mutable-by-supersession row. When an agent re-states or changes a
fact, we either drop it (dedup `identical` → no-op) or open a conflict (contradiction → HITL).
Neither keeps a **walkable history of how a belief evolved**. `asserted_at` was meant to carry
"last re-affirmed" but is dormant (always equals `created_at`).

Goal: every belief has a version chain — `v1 → v2 → v3` — so we can show how it changed over
time, without polluting recall (recall must still return only the current belief).

## Model (chosen: lineage chain, reuse existing machinery)

We already have ~80% of this: superseded memories go `status='stale'` (never deleted) and a
`replaces` edge records lineage. We make that a first-class chain:

- `memory_objects` gains **`root_id uuid`** (the stable lineage identity — all versions of one
  belief share it) and **`version int`** (1, 2, 3…). The **newest `active` row** per `root_id`
  is the current belief; older ones are `stale`.
- Each version step also writes a `replaces` edge (child → parent), keeping the graph and
  reversibility uniform with conflict resolution.
- **Validity interval reuses existing columns** — no new temporal columns:
  `asserted_at` = *valid from* (when this version became the belief), `stale_since` = *valid to*
  (NULL while current). This finally gives `asserted_at` a real meaning.
- **History** = `SELECT … WHERE root_id = $x ORDER BY version DESC`. One query, no edge-walking.
- **Recall is unchanged and clean for free** — `memloom_fuse` and `#findCandidates` already
  filter `status='active'`, so stale old versions never surface in recall, dedup, or the graph.

## What triggers a new version

| Save funnel case | Classifier | Behavior | Version? |
|---|---|---|---|
| verbatim re-save | (exact content hash) | no-op, `merged` | **no** — nothing changed |
| same fact, reworded | `identical` | stale parent, insert child (same root, v+1), `replaces` edge | **yes**, auto → outcome `versioned` |
| related, both true | `complementary` | insert as a new belief (new root) | no — it's a different fact |
| cannot both be true | `contradictory` | **HITL conflict** (unchanged); both stay active | on resolve (below) |
| explicit `update(id, …)` | — | stale parent, insert child (same root, v+1) | **yes**, auto |

**Contradictions stay human-in-the-loop** (the memloom differentiator). The *resolution* is what
records the version step:

- `keep_new` → the incoming belief continues the existing fact's lineage: re-parent it to the
  loser's `root_id`, `version = loser.version + 1`. Losers go stale.
- `merge` → the merged belief continues the (primary) loser's lineage, `version + 1`.
- `keep_existing` → the incoming is a rejected alternative: it goes stale on its own root, no
  re-parent (linear history v1; branching is out of scope).
- `keep_both` → genuinely distinct facts, two roots, **no** versioning.

`revert` restores lineage: reverting a `keep_new` resets the incoming to its own root
(`root_id = id, version = 1`); `merge` revert already stales the merged row so its lineage is
moot. All still non-destructive.

### ⚠️ One interpretive call to confirm

You said "saves the same fact again **or** changes the fact → new version." I've read
"saves the same fact again" as a **reworded** restatement (`identical`) → auto-version, and a
**verbatim** re-save (byte-identical) → no version (nothing changed; it's caught by the content
hash). If you actually want *every* re-assertion — even byte-identical — to append a version,
that's a one-line change (drop the exact-hash short-circuit for versioning), but it makes history
noisy with non-changes. Default = the reworded reading. Flag if you want the other.

## Surfaces (v1)

- Engine: `update(input)` and `history(memoryId)` added to `MemoryEngine`.
- HTTP: `POST /memory/:id/update`, `GET /memory/:id/history`.
- CLI: `memloom update <id> <text…>`, `memloom history <id>`.
- Deferred (post-launch, noted): MCP `update`/`history` tools; viewer "history" drill-down on a
  memory node; branching histories; a `rollback(versionId)` that promotes an old version to current.

## Files

- `packages/core/src/migrations.ts` — migration `0009_node_versions` (columns, backfill, index).
- `packages/core/src/types.ts` — `Memory.rootId/version`, `SaveOutcome` gains `versioned`,
  `UpdateInput`.
- `packages/core/src/memloom.ts` — `#insert` (app-generated id + lineage), `#versionOf`,
  `#reparent`; `save` identical→version; `update`; `history`; `resolveConflict`/`revertConflict`
  lineage continuation; `mapRow` carries root/version; `#findCandidates` selects root/version.
- `packages/core/src/engine.ts`, `http-client.ts`, `packages/server/src/index.ts`,
  `packages/cli/src/index.ts` — the surfaces.
- Docs: `ARCHITECTURE.md` (belief lifecycle), `CODEBASE-GUIDE.md` (retire the `asserted_at`
  dormant note), `CHANGELOG.md`.

## Verification

- Core tests: identical-restatement bumps version and stales the parent; recall returns only the
  current version; `history` returns the full chain in order; `update` versions; resolve `keep_new`
  continues lineage and `revert` restores it; `keep_both` makes two roots.
- `pnpm -r build && pnpm -r typecheck`, full `vitest`, Biome — green.
- Live: `save` a fact, `save` a reworded version, `history <id>` shows v1+v2, `recall` shows only v2.
