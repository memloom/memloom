# memloom architecture

memloom is a Postgres-native, local-first memory engine you embed as a library, run as a local
server, or consume from the cloud, with **the same schema and the same SQL across all three**.

```
                 ------------------------------------------------
   agents/CLI -->|          @memloom/core (the engine)          │
   viewer app -->|                                              │
                 |  write path (dedup, conflicts, HITL, revert) │
                 |  entity graph + closed predicate vocabulary  │
                 │  hybrid retrieval (vector + keyword + graph) │
                 │                                              │
                 │ StorageAdapter;EmbeddingProvider;LLMProvider |
                 ------------------------------------------------
                          |                 |              |
                          |                 │              │
                    PgliteAdapter       PgAdapter      OpenRouter
                    
```

## Two rules that are hard to reverse

1. All data access goes through the `StorageAdapter` interface (`query`, `exec`, `tx`,
   `close`). Code above it never knows which driver it talks to, so the embedded (PGLite)
   and server (`pg`) tiers run the same SQL. One query that works on only one tier forks
   the product, so no sql dialects, just postgres everywhere.
2. `@memloom/core` never reads `process.env` or config files. Whatever process constructs
   `Memloom` (the daemon, a test, a host app) builds the storage adapter and providers
   itself and passes them in. Core uses what it is given and nothing else.

## The three tiers

| Tier | Driver | For |
|---|---|---|
| Embedded | PGLite (WASM Postgres, one folder, no Docker) | your own memory; the 2-minute quickstart |
| Local server | `pg` → Docker/`supabase start` | a persistent daemon, multi-client |
| Cloud | `pg` → managed Postgres | teams, scale |

Because it's one real Postgres dialect everywhere, moving up a tier is a config swap:
set `MEMLOOM_PG_URL` in `config.env` and restart the daemon.

## Schema notes

- **Zero plpgsql.** The schema is DDL + `language sql` only, so it runs identically on
  PGLite and real Postgres. This is a choice, not a PGLite limitation: logic stays in
  TypeScript, where it is greppable, debuggable, and unit-tested. Denormalized counts are
  maintained in the write path instead of triggers, and migrations stay plain declarations
  you can review.
- **Single-owner connection (embedded tier).** PGLite is single-process; two openers corrupt
  the WAL. memloom ships a data-dir advisory lock, and when a local server holds the store the
  CLI/MCP route through it rather than opening the directory a second time.
- **Sync-ready.** Every row carries a stable UUID, `created_at`/`updated_at`, and an `owner_id`
  (a fixed sentinel in the embedded tier) so a future sync layer has what it needs.

## Memory vs context

- **Memory** = engine-owned atomic beliefs. Deduped, contradiction-checked, active/stale, with
  human-in-the-loop conflict resolution. A belief is **versioned**: restating or editing a fact
  appends a new version (sharing a `root_id`, prior version staled but kept), so `history()` shows
  how it changed. Recall always returns only the current version.
- **Context** = source-owned documents the engine mirrors. Re-adding an unchanged file is a
  no-op (content hash), a changed file replaces its chunks in one transaction; no conflict
  machinery. If context changes, you edit the source file.

Both feed the same entity graph and the same hybrid retrieval: one engine, two ingestion
sources, one recall call (`memloom_fuse` unions memories and chunks in each retrieval arm).

### The extraction pipeline

`context add` runs: **extract -> section -> size-split -> embed -> mirror-write**.

- **Extract** goes through a pluggable registry (`packages/core/src/extract.ts`). An
  `Extractor` declares its `kind`, `extensions`, a `version`, a `chunker` strategy, and an
  `extract(bytes, path) → units` function; `registerExtractor()` adds formats without touching
  the engine. Built-ins: markdown, plain text, and PDF, where PDF text is rebuilt from glyph
  *geometry* (baseline line grouping, column-gutter detection, 2-up duplicate collapse) because
  content-stream order is scrambled for equation-heavy documents.
- **Section** by the extractor's declared strategy: `"markdown"` splits at headings;
  `"outline"` splits at ALL-CAPS title lines and numbered points (`2. DEFINITION 3. …`), so a
  chunk never starts mid-definition. Each chunk gets its breadcrumb (`Guide > Setup >
  Postgres`) **prepended into the embedded text**, so both the vector and keyword arms see the
  heading context (the contextual-retrieval lever), and the same breadcrumb powers citations
  (`from notes.pdf › TITLE > 2. (p. 1)`).
- **Size-split** only when a section is oversized. Markdown keeps a heading section whole up
  to 16,000 chars; past that it splits at paragraph boundaries toward an 8,000-char target
  with zero overlap. Outline sections (plain text, PDF) use the recursive character splitter
  (~1,600-char target, 2,048 cap, ~200 overlap).
- **Mirror-write**: the extractor `version` is salted into the content hash (`#p{n}`), so when
  an extraction pipeline improves, unchanged files re-ingest on the next `context add` instead
  of no-op'ing on stale chunks.

## Build status

The engine is extracted and functional end-to-end: save -> dedup/conflict funnel -> hybrid
recall (vector + keyword + entity RRF), the single-owner daemon (HTTP API, Postgres wire,
embedded viewer), MCP server, and the context connector with the extractor registry.

See [CHANGELOG.md](./CHANGELOG.md) for what each release contains.
