# Changelog

## Unreleased

- Added entity resolution: memloom now folds the several spellings of one thing
  (`Claude Opus 4.8` and `Opus 4.8`, `Postgres` and `PostgreSQL`) into one entity. Spellings
  that differ only in case and punctuation fold automatically; anything less certain is
  queued in the Conflicts tab for you to decide. Every fold is reversible, and the absorbed
  spelling keeps resolving to the survivor, so new memories using the old name land in the
  right place ([docs](https://docs.memloom.dev/concepts/entity-resolution))
- Recall now follows folded spellings. The entity arm anchors on alias vectors as well as
  entity vectors, so a query using a name that was folded away still reaches everything the
  surviving entity is attached to. This matters because duplicate spellings compete for the
  arm's ten anchor slots, so folding them is a retrieval improvement, not just tidiness
- Added graph traversal: walk from one entity to see who and what it is connected to,
  filtered by entity type. Accepts a name, an id, or a folded-away spelling, and reports
  which one it matched. Relationships extraction actually stated are listed separately from
  entities that merely appear in the same memories. Available as a **traverse** panel on the
  viewer's Graph tab, where searching an entity dims the canvas to its neighbourhood and
  clicking a neighbour follows it, plus `GET /memory/entities/related` and the
  `related_entities` MCP tool
- Added `agent` as a built-in entity type, for a named AI model or assistant that does work
- `DELETE /memory/entities/{id}` now refuses while an unreverted fold points at the entity.
  It used to take the alias row with it, which made the fold permanent and swept the absorbed
  entity's mentions along with it

## 0.5.0

- Added prompt-time recall to `memloom connect claude-code`: a second hook injects the
  memories relevant to each prompt you type, so Claude uses your memory without being told
  to search it. Silent when nothing matches or the daemon is down, never blocks a prompt;
  opt out with `--no-recall` ([docs](https://docs.memloom.dev/cli/import))
- Added an agent setup guide plus installable setup and usage skills, so an AI agent can
  install and configure memloom end to end with the human only supplying the API key and
  capture consent ([docs](https://docs.memloom.dev/guides/agent-setup))

## 0.4.0

- Added `memloom notion connect`: sync selected Notion pages and databases into memloom
  as fresh context documents. The daemon polls and refetches only the sections whose
  last_edited_time moved, so an idle workspace costs one search call per poll and sync
  spends embeddings only, and only on changes. The picker shows the workspace as a tree
  with database rows collapsed, in the CLI and in a new viewer connectors tab;
  `notion sync [--dry-run|--force]`, `notion status`, and `notion disconnect` complete
  the set ([docs](https://docs.memloom.dev/cli/notion))
- Changed document re-ingestion to keep unchanged chunks: same row, same embedding, same
  indexed state, same entity links. Only new or edited chunks are embedded and re-indexed,
  so one edited diary day costs one chunk instead of the whole page
- Changed indexing to run on a worker pool (default 6, `MEMLOOM_INDEX_CONCURRENCY`) with
  transient-failure retries and a circuit breaker, so large indexes take minutes and a
  provider outage stops cleanly with a resume hint
- Fixed index run counters over-counting: "+N entities" now reports entities and relations
  actually created, which reconciles with the graph

## 0.3.0

- Added `memloom import agent-memory`: bring in the memories your agents already saved on
  disk. Claude Code's per-project memory folders and GitHub Copilot's memory-tool notes are
  parsed, redacted, and saved through the belief pipeline with per-file provenance; no LLM
  extraction is needed because the files are already distilled, and a content-hash ledger
  makes re-runs free. Read-only on the agents' folders
  ([docs](https://docs.memloom.dev/cli/import))

## 0.2.0

- Added `memloom import sessions`: distill your agent's sessions into typed, searchable
  memories, with secrets redacted before anything reaches a provider and a ledger that
  makes re-runs free. Claude Code is the first supported agent (`--agent claude-code`,
  the default) ([docs](https://docs.memloom.dev/cli/import),
  [how distillation works](https://docs.memloom.dev/concepts/distillation))
- Added `memloom connect claude-code`: continuous capture through a session-end hook,
  scoped to an allowlist of projects and bounded by a daily unattended budget
  ([docs](https://docs.memloom.dev/cli/import))
- Added automatic conflict resolution: a contradiction with decisive evidence (recording
  times, transcript excerpts) resolves itself at import time, and `memloom conflicts auto`
  or the viewer's "Resolve the obvious ones" button re-judges the pending queue; every
  auto-resolution is revertable ([docs](https://docs.memloom.dev/cli/conflicts))
- Added per-chunk progress ("distilling chunk 12/47") so long imports are never silent
- Fixed the CLI dying with a bare "terminated" on long runs while the daemon kept
  importing: progress streams now carry heartbeats, and a lost stream says where to check
- Fixed small OpenRouter balances failing every call with 402: completions now cap
  max_tokens instead of preauthorizing the model's full output ceiling
- Fixed the graph rebuilding on every tab return, jolting on no-op background refreshes,
  and freezing on deep zooms: the view stays mounted across tabs, unchanged polls are
  ignored, and drawing culls to the viewport
- Fixed big conflict queues overwhelming the CLI and viewer: the CLI lists the first 5,
  and the viewer's lists scroll in a fixed pane with a filter
- Fixed the dedup classifier flagging unrelated memories as contradictions
- Fixed slash-command noise from transcripts being distilled as session content

## 0.1.1

- **Node 20 is now supported** (was Node 22 or later). The whole suite passes on Node 20,
  including PGLite storage, the data-dir lock, and hybrid retrieval, so the higher floor was
  never needed. CI now runs on Node 20, 22, and 24.
- **Docs state the Node requirement.** They never did. If your Node was too old, npm skipped
  the package instead of linking it, and `memloom` looked installed but was not on your PATH.

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
  in a single SQL call (`memloom_fuse`), over memories and context chunks together. A separate
  date arm answers "what did I plan on Tuesday": recall scoped to a calendar day, ranked by
  similarity within it.
- **Context connector**: `memloom context add` ingests .md/.txt/.pdf into the same recall with
  section + page citations, from a path, a browser upload, or a chat attachment. Markdown
  chunks at headings; plain text and PDFs chunk along their outline (ALL-CAPS titles, numbered
  points; one point per chunk). PDF text is rebuilt from glyph geometry (reading order for
  equation-heavy documents, 2-up duplicate-column collapse). Documents are mirrors: unchanged
  files no-op by content hash, changed files replace their chunks transactionally; extractor
  pipeline versions are salted into the hash so improvements re-ingest automatically.
- **Pluggable extractor registry**: a file format is one registered object (`kind`,
  `extensions`, `version`, `chunker`, `extract()`); see CONTRIBUTING.md.
- **Entity graph with a reviewed vocabulary**: schema-constrained LLM extraction over memories
  and chunks. The vocabulary is data (system seeds, your entries, LLM proposals): unknown
  types and predicates are held out as proposals with their evidence, and approving one links
  the held-out finds into the graph immediately, no re-index. Typed relationships carry
  confidence and provenance (a removed document takes its claims with it). Entity corrections
  built in: rename, retype, merge, delete. Documents roll up chunk mentions into weighted
  document→entity edges.
- **Indexing you can watch**: `memloom index` streams per-item progress, every run is logged
  to the store (session-grouped, survives restarts, CLI runs show in the viewer Console), and
  auto-index quietly indexes new memories and files in the background (opt out with
  `MEMLOOM_AUTO_INDEX=off`).
- **Assistant**: chat grounded in your store (`memloom ui` → assistant tab). Two-stage turn:
  tool rounds gather memories and passages, then one streaming answer with numbered source
  citations. Sessions persist and are searchable; files attached to a chat are scoped to that
  chat and die with it.
- **Single-owner daemon**: `memloom serve` owns the store: HTTP API on 4319 (zod-validated,
  fast 503 when a Postgres wire client holds the lock), Postgres wire on 54329
  (pglite-socket, for psql/Drizzle Studio), embedded viewer. CLI/MCP/viewer are all HTTP
  clients; any command auto-starts the daemon.
- **Viewer**: `memloom ui`: the living memory graph (deterministic layout, document chunk
  blooms), assistant, memories and documents with edit/history/delete, schema review queue,
  conflict review with undo, indexing console.
- **MCP server**: `@memloom/mcp` (stdio): `save_memory`, `recall_memory` (memories + files,
  with sources), `read_passage`, `memory_history`, conflict list/resolve, and schema
  enable/disable/delete, so an agent can use the memory and you stay in control of the
  vocabulary.
- **Storage tiers**: embedded PGLite by default (a folder on disk, no Docker); set
  `MEMLOOM_PG_URL` and the same daemon runs on any Postgres with pgvector (Docker, Supabase,
  managed) over a pooled connection. Same schema, same SQL, both tiers. The
  embedding-fingerprint guard refuses reopening a store with a mismatched embedding
  configuration, and `memloom reembed` migrates a store to a new embedding config in place,
  resumable if interrupted.
- **Providers**: offline hashing mode (no key needed) or OpenRouter cloud mode
  (qwen3-embedding-8b @ 1024 dims pinned to Nebius, gemini-2.5-flash for classification and
  chat).
