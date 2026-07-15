# CLI manual test plan (0 to 100%)

Work top to bottom; each phase builds on the previous one. Check the box when the
EXPECTED line matches what you saw. When it doesn't, stop and write down the command,
the output, and what you expected; that note is a launch blocker until triaged.

How to run the CLI while testing:

- **Pre-publish (workspace):** `pnpm build` once, then use `node packages/cli/dist/bin.js`
  wherever this plan says `memloom`. Tip: `doskey memloom=node D:\Kostek\Projects\memloom\packages\cli\dist\bin.js $*`
  for the session, or add an alias.
- **Post-publish (the real user path):** `npx memloom@latest`. Re-run at least phases
  0 to 3 this way after the first npm publish; npx is what the landing page tells
  people to type, and it exercises packaging (`files`, bundled viewer, bin shims)
  that the workspace never does.

## Phase 0: clean slate

- [ ] Stop any daemon: `memloom stop` (a "no daemon" style answer is fine).
- [ ] Park your real store: rename `%USERPROFILE%\.memloom` to `.memloom-backup`.
      EXPECTED: the folder moves with no locked-file complaint. If it complains, a
      daemon or DB client still holds it.
- [ ] `node --version` is >= 22 (the engines requirement).

## Phase 1: first contact (offline mode)

- [x] `memloom help`
      EXPECTED: the command list renders, no stray formatting, paths at the bottom
      point at the new empty home.
- [x] `memloom init`
      EXPECTED: creates `~/.memloom/config.env` (commented template) and starts the
      daemon. Banner shows HTTP 4319, Postgres 54329, data + config paths, and
      `mode OFFLINE, no OPENROUTER_API_KEY` with the hint to set it.
- [x] Open `config.env` in an editor.
      EXPECTED: every option is present as a comment, including
      `OPENROUTER_CHAT_MODEL` and `MEMLOOM_AUTO_INDEX`.
- [x] `memloom serve` in a second terminal.
      EXPECTED: "already serving" message, exits cleanly, does not corrupt anything.

## Phase 2: offline basics

Offline mode has deterministic hashing embeddings and dedup off. Recall works best
with word overlap; that is expected, not a bug.

- [x] `memloom save "the staging database runs on postgres"`
      EXPECTED: outcome `added` with an id.
- [x] `memloom recall "staging database"`
      EXPECTED: the memory comes back with a similarity score.
- [x] `memloom update <id> "the staging database moved to neon"` then
      `memloom history <id>`
      EXPECTED: two versions, v2 current, v1 superseded.
- [x] `memloom conflicts`
      EXPECTED: "no pending conflicts" (no LLM means no contradiction detection).
- [ ] Create `notes.md` with a couple of headed sections; `memloom context add notes.md`
      then `memloom context list` and `memloom recall <phrase from the file>`.
      EXPECTED: added with a chunk count; recall returns the chunk with
      `from notes.md › <heading>` provenance.
- [ ] `memloom index`
      EXPECTED: this is the offline sharp edge. Items fail (extraction needs the LLM)
      and the run logs errors rather than crashing. Judge the error text: would a new
      user understand they need a key? Write down the exact wording.

## Phase 3: the switch to cloud mode

- [ ] Put a real `OPENROUTER_API_KEY` in `config.env`, then `memloom stop` and
      `memloom serve`.
      EXPECTED: **startup refuses** with the embedding-fingerprint error, because the
      store was embedded offline and cloud vectors are incompatible. This is by
      design. Judge the message: does it tell you what to do?
- [ ] Delete `~/.memloom/data` (keep `config.env`), `memloom serve` again.
      EXPECTED: fresh store, banner shows
      `mode cloud (qwen/qwen3-embedding-8b @ 1024 dims via nebius, google/gemini-2.5-flash, auto-index on)`.

## Phase 4: the belief pipeline (cloud)

- [ ] `memloom save "the deploy window is friday afternoon"`
      EXPECTED: `added`.
- [ ] Save a reworded restatement: `memloom save "deploys happen friday after lunch"`
      EXPECTED: `versioned` (new version of the same belief) or `merged`; either is a
      pass, `added` is a fail (dedup missed).
- [ ] Save a contradiction: `memloom save "the deploy window moved to monday morning"`
      EXPECTED: `conflict` outcome with a conflict id; both memories stay active.
- [ ] `memloom conflicts`
      EXPECTED: the conflict listed with NEW and EXISTING sides.
      (Resolution is a viewer/MCP action; resolve it in `memloom ui`, Conflicts tab,
      and confirm the CLI list empties.)

## Phase 5: context, auto-index, and the graph

- [ ] `memloom context add <folder with a few .md/.txt/.pdf files>`
      EXPECTED: per-file outcomes, folder recursion works, unsupported files skipped.
- [ ] Wait ~5 seconds after the add, then `memloom schema`.
      EXPECTED: entity counts are nonzero WITHOUT you running index; auto-index did
      it. The Console tab in `memloom ui` shows the run.
- [ ] `memloom index`
      EXPECTED: "indexed 0 memories, 0 context chunks" (nothing pending).
- [ ] Re-add the same folder.
      EXPECTED: everything `unchanged`, no re-embedding, fast.
- [ ] Edit one file, re-add.
      EXPECTED: that file `updated`, chunks replaced, auto-index picks it up again.
- [ ] Add a PDF; recall something from it.
      EXPECTED: provenance includes the page number `(p. N)`.
- [ ] `memloom index --help`
      EXPECTED: usage for the index command itself (flags, what --rebuild does),
      NOT an index run. Spot-check one or two others (`save --help`, `recall -h`).
- [ ] `memloom auto-index` then `memloom auto-index off` then `on`.
      EXPECTED: status line each time; after `off`, a save stays unindexed until a
      manual `memloom index`; after `on`, saves index in the background again. The
      Console toggle mirrors the state.
- [ ] `memloom index --rebuild`
      EXPECTED: wipes and re-extracts; progress lines show entities per item;
      `memloom schema` counts repopulate.
- [ ] `memloom context remove <id>` (id from `context list`).
      EXPECTED: document gone from list and recall.

## Phase 6: schema commands

- [ ] `memloom schema`
      EXPECTED: entity types and predicates with usage counts, user/disabled markers.
- [ ] `memloom schema delete entity_type person`
      EXPECTED: refused, built-ins cannot be deleted.
- [ ] Add a user type in the viewer (schema tab), disable it there, then
      `memloom schema delete entity_type <name>`.
      EXPECTED: deleted; `memloom schema` no longer lists it.
- [ ] `memloom schema delete entity_type nonexistent`
      EXPECTED: readable "no entity_type named" error, not a stack trace.

## Phase 7: daemon lifecycle and locking

- [ ] `memloom stop`, then `memloom save "auto start test"`.
      EXPECTED: the CLI auto-starts the daemon (short pause) and the save lands.
- [ ] Kill the daemon process from Task Manager (simulate a crash), then
      `memloom serve`.
      EXPECTED: it rides out the stale lock (may wait a few seconds) and starts.
      Any prior `running` index run shows as `interrupted` in the Console.
- [ ] Connect TablePlus/psql to `postgresql://postgres@127.0.0.1:54329/postgres`,
      then `memloom recall "anything"`.
      EXPECTED: fast, readable 503 about the store being locked by a wire client,
      and the daemon logs a loud warning. Disconnect the client; recall works again.
- [ ] `memloom ui`
      EXPECTED: browser opens the viewer; all seven tabs render against this store.

## Phase 8: portability (the local-first promise)

- [ ] `memloom stop`; copy `~/.memloom/data` somewhere else; delete the original;
      copy it back; `memloom serve`.
      EXPECTED: everything is still there. This is the "a folder you can copy" claim
      on the landing page; it has to be literally true.

## Wrap up

- [ ] Restore your real store: stop the daemon, delete the test `.memloom`, rename
      `.memloom-backup` back.
- [ ] File every deviation you wrote down. Anything in phases 1 to 4 is a launch
      blocker; phases 5 to 8 are judgment calls.
