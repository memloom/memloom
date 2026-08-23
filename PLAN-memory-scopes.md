# Plan: scope dimension (folders + tags)

Status: approved 2026-08-23. Implementation order: child 1 -> 2 -> (3, 5 in parallel) -> 4.
The 3D viewer is a separate follow-up that depends on child 5.

## Why

All memories and context land in one pool per owner. `RecallOptions`
(`packages/core/src/types.ts`) filters only by `ownerId`, `assertedOn`, `sessionId`. Session
capture distills every allowlisted coding session into the same pool as life memories; recall
for personal questions returns code noise, and the graph blends `PGLite` with family. Quality
degrades with every captured session.

## Decisions (locked)

- One required folder per memory and per document. Folders are hierarchical
  ("Personal life > People"). Free-form tags per memory (`text[]`, GIN, any-match `&&`).
- Two system folders per owner, created lazily: `uncategorized` (fallback) and `global`
  (cross-cutting preferences that fire in every scope).
- Scoped recall searches: requested subtree + `uncategorized` + `global`. `scope: "*"` means
  everything. `scope` is optional in tool schemas; descriptions mandate passing it from context.
- Agents cannot create folders. Only the user can (CLI/viewer).
- Session capture scopes mechanically: project dir -> `projects/<name>` folder. No LLM.
- Saves without scope land in `uncategorized` immediately; a background classification pass
  (index-run queue, same budget accounting as distillation) assigns a folder from the closed
  set using folder names + descriptions. Below the confidence floor stays `uncategorized`.
  v1 never invents folders; v2 adds proposals via the `memory_schema` review-queue mechanism.
- Dedup and conflicts stay owner-wide. A merge keeps the existing memory's scope. Conflict
  detection unchanged.
- Entities stay global. Traversal and the viewer graph filter mention edges by the scope of
  their source memory/chunk (join at query time, no denorm on edges).
- Backfill is part of the feature: pass 1 mechanical (`import_provenance` -> `projects/<name>`),
  pass 2 LLM over the remainder, dry-run first, human correction in the viewer.

## Schema (migration 0032, additive)

```sql
CREATE TABLE memory_scopes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL,
  parent_id   uuid REFERENCES memory_scopes(id),
  name        text NOT NULL,
  description text,                -- read by the classifier
  kind        text NOT NULL DEFAULT 'user' CHECK (kind IN ('user','system')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- uniqueness: unique index on (owner_id, coalesce(parent_id, zero-uuid), lower(name))
ALTER TABLE memory_objects    ADD COLUMN scope_id uuid REFERENCES memory_scopes(id);
ALTER TABLE memory_objects    ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE context_documents ADD COLUMN scope_id uuid REFERENCES memory_scopes(id);
ALTER TABLE context_chunks    ADD COLUMN scope_id uuid REFERENCES memory_scopes(id);
```

`scope_id` stays nullable at SQL level; the engine treats NULL as `uncategorized` on read and
never writes NULL going forward. Chunks denormalize the document's scope so `memloom_fuse`
filters without joins; re-scoping a document updates its chunks in the same transaction.

## Retrieval

`memloom_fuse` gains `p_scope_ids uuid[] DEFAULT NULL` and `p_tags text[] DEFAULT NULL`.
Every arm filters `(p_scope_ids IS NULL OR scope_id = ANY(p_scope_ids))`; NULL scope_id rows
match only when the uncategorized id is in the set (coalesce in the predicate). Tags filter
`tags && p_tags` on the memory side. Subtree expansion happens in TypeScript against the
cached registry. Shipped as the established DROP/CREATE migration; zero plpgsql.

## Addressing

Scopes address by path string, `/`-separated (`personal-life/people`); display uses `>`.
Rename and move are registry updates; memories point at ids, nothing rewrites.

## Child issues

| # | Title | Depends on |
|---|---|---|
| 1 | Engine: scope registry, schema migration, write path, fuse filter | none |
| 2 | Interfaces: MCP tools, HTTP endpoints, CLI commands and flags | 1 |
| 3 | Capture and classification: hook scope, import mapping, classifier pass | 1, 2 |
| 4 | Backfill command: mechanical + LLM passes, dry-run, report | 1, 3 |
| 5 | Viewer: folder tree, filtering, bulk move, tags | 2 |

### Child 2 surface

- MCP: `save_memory`/`add_link`/`add_file` gain `scope?`; `save_memory` gains `tags?`;
  `recall_memory` gains `scope?` + `tags?`; new `list_scopes` tool (tree + counts).
- HTTP: scopes CRUD endpoints; `scope`/`tags` on `/memory/query`, save, context add.
- CLI: `memloom scopes list|add|rename|move|rm`, `--scope`/`--tags` on `save`, `recall`,
  `context add`, `notion connect`.

### Child 3 surface

- Recall hook derives project scope from `cwd`, passes it to `/memory/query`.
- Session import maps project dir -> `projects/<name>` (auto-created, `user` kind).
- Classifier pass in the index-run queue, closed set, confidence floor, budget-capped.

### Child 4 surface

- `memloom scopes backfill [--dry-run]`: pass 1 provenance-mechanical, pass 2 LLM remainder,
  per-folder report. Idempotent: skips already-scoped rows.
- `memloom scopes review`: CLI review of classified assignments.

### Child 5 surface

- Folder tree sidebar shared by Memories, Documents, Graph views; subtree filtering.
- Multi-select + move to folder; tag chips + tag filter.
- Graph filters nodes by scope of their mention sources.

## Acceptance criteria

1. `recall_memory("family plans", scope="personal-life")` returns zero results scoped under
   `projects/`, on the real store, post-backfill.
2. `scope: "*"` returns cross-scope results.
3. Scoped recall includes matches from `uncategorized` and `global`.
4. A captured session from `D:\Kostek\Projects\memloom` lands every distilled memory in
   `projects/memloom` with no LLM call for scoping.
5. A `save_memory` without scope is recallable immediately (`uncategorized`) and carries a
   classified folder after the next index run.
6. Classification never assigns outside the registry; below-floor stays `uncategorized`.
7. `backfill --dry-run` prints per-folder counts and writes nothing; the real run scopes 100%
   of provenance-bearing memories mechanically.
8. Documents and chunks carry scope; re-scoping a document re-scopes chunks transactionally.
9. Dedup merge across scopes keeps the existing memory's scope.
10. Viewer: folder filter hides nodes whose only mention sources are outside the subtree;
    multi-select move works from Memories and Documents views.
11. All existing tests pass; PGLite and Postgres run the same SQL (zero plpgsql).

## Out of scope

Graphify or any code-graph ingestion; scope-aware conflict detection; multi-user scope
sharing; classifier folder proposals (v2); per-scope embeddings; the 3D viewer (follow-up).

## Rollback

Migration is additive (new table + nullable columns). Rollback = revert PR; old code ignores
the columns. Backfill is re-runnable and idempotent per memory.
