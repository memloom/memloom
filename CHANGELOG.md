# Changelog

## 0.2.0

The engine, end to end:

- **Memory write path**: save → semantic dedup funnel (exact / near-duplicate / contradiction
  via LLM classification) → human-in-the-loop conflicts. Contradictions keep *both* memories
  active and queue a conflict; resolutions (keep new / keep existing / keep both / merge) are
  durable and **reversible**.
- **Node versioning**: every belief is a version chain: restating or editing a fact appends a
  new version (shared `root_id`, prior version staled but kept), and resolving a contradiction is
  a version step. `history()` shows how a belief changed; recall returns only the current version.
  `memloom update <id> <text>` and `memloom history <id>`.
- **Hybrid retrieval**: vector + keyword + entity-graph arms fused with reciprocal-rank fusion
  in a single SQL call (`memloom_fuse`), over memories and context chunks together.
- **Context connector**: `memloom context add` ingests .md/.txt/.pdf into the same recall with
  section + page citations. Markdown chunks at headings; plain text and PDFs chunk along their
  outline (ALL-CAPS titles, numbered points; one point per chunk). PDF text is rebuilt from
  glyph geometry (reading order for equation-heavy documents, 2-up duplicate-column collapse).
  Documents are mirrors: unchanged files no-op by content hash, changed files replace their
  chunks transactionally; extractor pipeline versions are salted into the hash so improvements
  re-ingest automatically.
- **Pluggable extractor registry**: a file format is one registered object (`kind`,
  `extensions`, `version`, `chunker`, `extract()`); see CONTRIBUTING.md.
- **Entity graph**: LLM entity extraction over memories and chunks with a closed per-owner
  predicate vocabulary; documents roll up chunk mentions into weighted document→entity edges.
- **Single-owner daemon**: `memloom serve` owns the store: HTTP API on 4319 (zod-validated,
  fast 503 when a Postgres wire client holds the lock), Postgres wire on 54329
  (pglite-socket, for psql/Drizzle Studio), embedded viewer. CLI/MCP/viewer are all HTTP
  clients; any command auto-starts the daemon.
- **Viewer**: `memloom ui`: memory/entity graph, conflict review (with undo), console.
- **MCP server**: `@memloom/mcp` (stdio): `save_memory`, `recall_memory` (memories + files,
  with sources), conflict list/resolve.
- **Storage**: embedded PGLite (a folder on disk, no Docker) or any Postgres via the same
  `StorageAdapter`; embedding-fingerprint guard refuses reopening a store with a mismatched
  embedding configuration.
- **Providers**: offline hashing mode (no key needed) or OpenRouter cloud mode
  (qwen3-embedding-8b @ 1024 dims pinned to Nebius, gemini-2.5-flash for classification).

## 0.1.0 (first release)

The engine, end to end:

- **Memory write path**: save → semantic dedup funnel (exact / near-duplicate / contradiction
  via LLM classification) → human-in-the-loop conflicts. Contradictions keep *both* memories
  active and queue a conflict; resolutions (keep new / keep existing / keep both / merge) are
  durable and **reversible**.
- **Node versioning**: every belief is a version chain: restating or editing a fact appends a
  new version (shared `root_id`, prior version staled but kept), and resolving a contradiction is
  a version step. `history()` shows how a belief changed; recall returns only the current version.
  `memloom update <id> <text>` and `memloom history <id>`.
- **Hybrid retrieval**: vector + keyword + entity-graph arms fused with reciprocal-rank fusion
  in a single SQL call (`memloom_fuse`), over memories and context chunks together.
- **Context connector**: `memloom context add` ingests .md/.txt/.pdf into the same recall with
  section + page citations. Markdown chunks at headings; plain text and PDFs chunk along their
  outline (ALL-CAPS titles, numbered points; one point per chunk). PDF text is rebuilt from
  glyph geometry (reading order for equation-heavy documents, 2-up duplicate-column collapse).
  Documents are mirrors: unchanged files no-op by content hash, changed files replace their
  chunks transactionally; extractor pipeline versions are salted into the hash so improvements
  re-ingest automatically.
- **Pluggable extractor registry**: a file format is one registered object (`kind`,
  `extensions`, `version`, `chunker`, `extract()`); see CONTRIBUTING.md.
- **Entity graph**: LLM entity extraction over memories and chunks with a closed per-owner
  predicate vocabulary; documents roll up chunk mentions into weighted document→entity edges.
- **Single-owner daemon**: `memloom serve` owns the store: HTTP API on 4319 (zod-validated,
  fast 503 when a Postgres wire client holds the lock), Postgres wire on 54329
  (pglite-socket, for psql/Drizzle Studio), embedded viewer. CLI/MCP/viewer are all HTTP
  clients; any command auto-starts the daemon.
- **Viewer**: `memloom ui`: memory/entity graph, conflict review (with undo), console.
- **MCP server**: `@memloom/mcp` (stdio): `save_memory`, `recall_memory` (memories + files,
  with sources), conflict list/resolve.
- **Storage**: embedded PGLite (a folder on disk, no Docker) or any Postgres via the same
  `StorageAdapter`; embedding-fingerprint guard refuses reopening a store with a mismatched
  embedding configuration.
- **Providers**: offline hashing mode (no key needed) or OpenRouter cloud mode
  (qwen3-embedding-8b @ 1024 dims pinned to Nebius, gemini-2.5-flash for classification).
