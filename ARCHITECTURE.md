# memloom architecture

memloom is a Postgres-native, local-first memory engine you embed as a library, run as a local
server, or consume from the cloud — **the same schema and the same SQL across all three**.

```
                 ┌──────────────────────────────────────────────┐
   agents/CLI ──▶│  @memloom/core  (the engine — the product)    │
   viewer     ──▶│                                              │
                 │   write path (dedup, conflicts, HITL, revert) │
                 │   entity graph + closed predicate vocabulary  │
                 │   hybrid retrieval (vector + keyword + graph) │
                 │                                              │
                 │   StorageAdapter ── EmbeddingProvider ── LLMProvider
                 └────────┬─────────────────┬──────────────┬─────┘
                          │                 │              │
                 ┌────────▼─────┐   ┌────────▼──────┐  (OpenRouter now,
                 │ PgliteAdapter│   │   PgAdapter   │   Ollama later)
                 │ (embedded)   │   │ (local/cloud) │
                 └──────────────┘   └───────────────┘
```

## Two rules that are hard to reverse

1. **The `StorageAdapter` boundary is the load-bearing abstraction.** Its contract is
   driver-agnostic parameterized SQL (`query`, `tx`, `close`). Nothing above it knows which
   driver it talks to, so the embedded (PGLite) and server/cloud (`pg`) tiers run identical
   SQL — no dialect branching. Get this right and every lesser data-layer choice is reversible.

2. **Core never reads `process.env` or global config.** Connection and providers are *injected*
   into the `Memloom` facade. This is what lets a host application hand core a pooled connection
   and its own keys and consume `@memloom/core` directly.

## The three tiers

| Tier | Driver | For |
|---|---|---|
| Embedded | PGLite (WASM Postgres, one folder, no Docker) | your own memory; the 2-minute quickstart |
| Local server | `pg` → Docker/`supabase start` | a persistent daemon, multi-client |
| Cloud | `pg` → managed Postgres | teams, scale |

Because it's one real Postgres dialect everywhere, moving up a tier is a config swap.

## Schema notes

- **Zero plpgsql.** The hybrid retrieval RPC is `language sql`; denormalized counts are
  maintained in TypeScript in the write path. The schema is DDL + `language sql` only, so it
  runs identically on PGLite. (PGLite's plpgsql support is unreliable at runtime.)
- **Single-owner connection (embedded tier).** PGLite is single-process; two openers corrupt
  the WAL. memloom ships a data-dir advisory lock, and when a local server holds the store the
  CLI/MCP route through it rather than opening the directory a second time.
- **Sync-ready.** Every row carries a stable UUID, `created_at`/`updated_at`, and an `owner_id`
  (a fixed sentinel in the embedded tier) so a future sync layer has what it needs.

## Memory vs context

- **Memory** = engine-owned atomic beliefs. Deduped, contradiction-checked, active/stale, with
  human-in-the-loop conflict resolution. If a memory changes, the engine updates its belief.
- **Context** = source-owned documents (`.md`/`.txt`/PDF) the engine mirrors. Re-index replaces
  on file change; no conflict machinery. If context changes, you edit the source file.

Both feed the same entity graph and the same hybrid retrieval — one engine, two ingestion
primitives, one recall call.

## Build status

The engine is being extracted phase by phase. This scaffold (Phase 0) establishes the repo,
the package boundaries, and the two rules above. Phase 1 implements the spine
(save → embed → vector recall) on both storage adapters.
