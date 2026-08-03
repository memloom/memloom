# Changelog

## 0.9.0 (2026-08-03)

- A recording is no longer refused because voice detection missed the speech. Silero's 0.5
  threshold is right for someone talking into a phone and wrong for speech under continuous loud
  audio: on a 52-second phone recording of music with talking over it, 0.5 found zero speech,
  0.4 found 28.8 seconds and 0.3 found 36.4. Finding nothing now triggers a second pass at 0.3,
  and if that finds nothing either, a recording under ten minutes goes to the recognizer whole:
  detection only chooses which spans to decode, and the recognizer is the thing that reads speech.
  `MEMLOOM_VAD_THRESHOLD` pins the threshold
- A file is only refused now when there is nothing to keep: silence, or audio the recognizer turns
  into no words at all. The message says which. Before, a file it could not read was either
  refused as having "no speech" when it plainly had some, or stored as a document whose only
  chunk was the "Recorded on ..." header
- Fixed recall on recordings of a conversation. A back-channel ("Yeah", "Oh") became its own
  section, so it became its own chunk, and a chunk's text opens with its own heading: two words of
  speech under 20 characters of "25:46 - 25:47, Alice". That chunk's vector is mostly the
  speaker's name, so it matched any question naming that person better than the passage answering
  it did, and a conversation's worth of them filled the results. Sections now need real speech
  before a change of speaker ends them. On one 34-minute recording that is 145 chunks down to 26,
  with none left whose speech is shorter than its own heading
- A recording with one voice now carries that voice's name too. It was left as plain time ranges
  for readability, which cost the whole recording: the name lived only in the roster, so nothing
  in any chunk's text said who was talking and asking about that person by name could not reach a
  word of it. A voice note from one person is exactly what someone searches for by whose voice
  it is
- Both change what a chunk means, so recordings ingested before this need re-adding to benefit:
  `memloom context add <file>`. Neither transcription nor diarization re-runs, both are cached
- Linked files and folders now stay current on their own. Edit a file and recall follows within
  seconds; drop a new recording into a linked folder and it is transcribed and becomes recallable
  without adding it again ([docs](https://docs.memloom.dev/guides/file-sync))
- Only the chunks whose text changed are re-embedded. Editing one section of a long note costs that
  section, not the note, and every untouched chunk keeps its embedding and its entity links
- Linking a folder records the folder, not just the files in it at the time. That is what makes a
  file arriving later findable, and it is what `memloom context roots` lists
- An empty folder can be linked. Make a folder, link it, then point a recorder at it: that is the
  normal order and every add route used to refuse it with "no supported files"
- Watching is on when you link something, and switches off per folder or per file from the documents
  tab or with `memloom context unwatch <path>`. `memloom context forget <folder>` drops a folder from
  the watch list and keeps every document it produced
- A file deleted from disk is marked "file missing" and keeps its chunks. A temp-file rename, an
  unmounted drive, and a pipeline that cleans up after itself all look like a deletion, and none of
  them mean you wanted to forget what the file said
- OS events give the fast path, and every watched folder is re-walked about once a minute, so a
  dropped event costs a minute rather than the file. `MEMLOOM_SYNC=off` turns watching off and
  `MEMLOOM_SYNC_RESCAN_MS` changes the interval
- A folder walk that hits its 500-file cap now says so, instead of reading like a folder with 500
  files in it. Rescans of a folder already being watched are unbounded

## 0.8.0 (2026-08-02)

- Added reconciliation: memloom goes over its own store, repairs what SQL proves is wrong, folds
  duplicate entity names, and asks about the rest. Run it with `memloom reconcile`, preview it with
  `memloom reconcile --dry-run`, and take a whole run back with `memloom reconcile undo <run id>`.
  Retiring a memory means it goes stale, never deleted, so undo puts it back unless something
  else changed it first ([docs](https://docs.memloom.dev/concepts/reconciliation))
- Reconciliation has five passes, listed in cost order in the viewer's Settings tab. The two free ones
  are on and act on their own, because everything they do is undoable. The three that spend
  money are off until you turn them on: let a model resolve uncertain entity pairs, let a model
  resolve memory conflicts, and look for contradictions the save path could not see
- The contradiction re-check finds pairs nothing ever compared. A save is only judged against the
  5 nearest memories that existed at that moment, so a pair at rank 6 was never looked at by
  anything and nothing looked again. The re-check goes back over old beliefs against 20
  neighbours, capped at 200 a run (about 55 cents), oldest first so the backlog drains with
  nothing skipped, and brings a belief back around after 30 days
- Its findings arrive as possible contradictions rather than conflicts, in the Conflicts tab next
  to memory conflicts and duplicate entities. About 40 percent of them are real, so each one
  quotes the clashing sentence from both sides and waits for a yes or no. Confirming is what
  creates the conflict; dismissing means it is never raised again. `memloom reconcile possible` lists
  them in a terminal, and `memloom reconcile yes <id>` or `memloom reconcile no <id>` answers one
- The daemon reconciles on its own: shortly after startup when the last run is more than 36 hours
  old, and when it has been quiet for a while. Automatic runs only ever use the free passes, so a
  run nobody watched can never spend money. Reconciliation also gets quieter rather than louder: ignore
  its findings and the next run surfaces fewer
- The viewer's Settings tab drives all of it, with live progress for a long run, and the Console
  tab keeps every run in history with stop and undo
- Set `RECONCILE_ENABLED=0` in `~/.memloom/config.env` on a host that wants the reports and none of
  the repairs. It is a kill switch, not an opt-in: reconciliation is on by default with its two free
  passes ([docs](https://docs.memloom.dev/guides/configuration))

## 0.7.0

- Added web pages as context: `memloom context add https://…` (or the viewer's Add link
  card) fetches and parses the page in-process, so nothing about it reaches a reader
  service. Pages that build themselves in the browser are refused with advice instead of
  stored empty, and re-adding a link refreshes it
- Added audio and video as context: recordings are transcribed on this machine (Parakeet
  under sherpa-onnx; `memloom audio setup` fetches the models once) and cited by timestamp,
  so recall answers `from standup.mkv › 12:30 - 14:28`. Every audio track is mixed in, the
  transcript opens with when the recording was made, and transcripts are cached by file
  hash so a re-add never transcribes twice
  ([docs](https://docs.memloom.dev/guides/recordings))
- Recordings tell you who is speaking. Multi-voice recordings are diarized locally,
  sections break where the speaker changes, and headings carry the label. Rename
  `Speaker 2` to a real name from the viewer (each voice has a playable sample), and the
  voice library remembers it: later recordings of a voice you have named arrive
  pre-labeled, entirely on-device
- Slow ingests run through a durable queue: link one recording or fifty, watch per-file
  progress with a live percentage for every stage, cancel or resume, and the queue
  survives a daemon restart. Transcription and diarization run in a worker thread, so the
  daemon stays responsive throughout
- Uploads from the browser are capped at ~512 MB with a clear pointer to Link file, and
  uploaded recordings now live in memloom's own uploads directory instead of the OS temp
  dir, so playback and samples keep working after Windows cleans up
- The viewer feels faster: tab data is prefetched on hover and cached, so switching tabs
  shows data instead of a loading message; the queue and entities sections render
  immediately with honest empty and loading states
- The daemon no longer dies when the Postgres wire port cannot bind. The wire is a
  convenience for database tools, so a blocked port now costs you the wire and nothing else:
  `memloom serve` reports the bind error, keeps the HTTP API and viewer running, and releases
  the data-dir lock cleanly on exit. This mostly bites on Windows, where Hyper-V, WSL and
  Docker reserve random port blocks inside the ephemeral range at every boot and one can land
  on the default 54329
- Added `MEMLOOM_PG_PORT` to move the Postgres wire off 54329. Set it in
  `~/.memloom/config.env` (or the environment) to any free port; `memloom serve` and
  `memloom init` print the live one

## 0.6.0

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
