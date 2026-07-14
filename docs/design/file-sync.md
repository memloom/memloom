# File sync: re-ingest linked documents as they change on disk

Status: future feature, not scheduled. This note captures the design so the groundwork
laid in July 2026 (link vs upload provenance) doesn't have to be re-derived.

## Goal

A document linked from disk (documents tab "Link file/folder", `memloom context add`,
or a typed path) should stay current without the user re-adding it: edit the file,
save, and within seconds recall reflects the new content. This is the payoff of
path-linked provenance and the reason linking is the primary add flow.

## What already exists (the groundwork)

- **Two provenance classes.** Linked documents store their real absolute path;
  browser-dialog uploads store `upload://<filename>`. Only linked documents can sync -
  the browser never reveals paths, so uploads are one-time snapshots by construction.
  The split is queryable: `WHERE path NOT LIKE 'upload://%' AND session_id IS NULL`
  (session-scoped chat attachments are excluded too).
- **Idempotent re-ingest.** `contextAdd({ path })` already does everything a sync tick
  needs: sha256 `content_hash` short-circuit when bytes are unchanged, and an atomic
  chunk swap (delete old chunks + their mention edges via `#deleteDocumentChunks`,
  insert new ones) when they changed. Sync is "call contextAdd again", nothing more.
- **Deferred entity extraction.** New chunks sit unindexed until an index run, so a
  sync tick is cheap (extract + chunk + embed) and the LLM cost stays batched behind
  the existing `index()` / Console flow.
- **Run/event log.** `memory_index_runs` + events give sync a natural place to record
  its activity (a `trigger: "sync"` run per batch) so the Console shows what changed.

## Design

### Watcher

- chokidar in the daemon (`packages/cli/src/daemon.ts` owns the lifecycle; the logic
  lives in core or a small `packages/core/src/sync.ts`).
- Watch set = every linked document's path, loaded at daemon start and updated on
  contextAdd/contextRemove. Folders that were linked as folders should be watched as
  folders (new supported files inside get ingested; the bounded-walk rules from
  `collectSupportedFiles` apply: depth 5, skip dot/node_modules dirs).
  This needs one addition: remember WHICH root the user linked (today a folder add
  fans out into per-file documents and the root is forgotten). Likely a small
  `context_roots` table (owner_id, path, added_at) written by the folder-add paths.
- Debounce per path (editors fire bursts of change events; 500ms-1s settle window).
  Hash short-circuit makes over-firing harmless, just noisy.

### Change handling

- change -> `contextAdd({ path })`. `unchanged` = no-op; `updated` = chunks replaced,
  document pending re-index.
- unlink (file deleted) -> policy question, default to KEEPING the document with a
  `missing` marker rather than auto-removing (a temp-save rename or an unmounted drive
  must not destroy knowledge). Surface "file missing" in the documents tab; the user
  removes explicitly. A rename arrives as unlink+add, so keeping the old row also
  preserves history until the user reconciles.
- After a sync batch, optionally auto-run `index()` (config flag, default off - the
  user controls LLM spend; the Console already nags about unindexed chunks).

### Surfaces

- Daemon: on by default for linked docs, `MEMLOOM_SYNC=off` env to disable.
- Documents tab: per-document sync status (synced / pending index / missing),
  timestamp of last change seen.
- Console: sync runs in the same session log as index runs.
- CLI: `memloom context sync` for a one-shot manual pass (useful without the daemon
  watcher, e.g. cron).

### Non-goals

- Watching upload:// or chat-attachment documents (no path).
- Two-way sync (memloom never writes user files).
- Network shares / cloud-drive placeholder files beyond best-effort (OneDrive
  on-demand files hydrate on read; document the caveat).

## Open questions

- PDF churn: some tools rewrite PDFs on every open (metadata), defeating the hash
  short-circuit is impossible (bytes really changed) - consider hashing extracted
  text instead of raw bytes for PDFs.
- Watch-set scale: chokidar handles thousands of files, but linked-folder roots with
  huge trees need the depth/skip rules enforced at watch time as well as add time.
- Windows: chokidar's fsevents equivalent is fine, but paths need normalization
  (case-insensitive drive letters) before comparing against stored document paths.
