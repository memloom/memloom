# MCP manual test plan (0 to 100%)

The MCP server (`@memloom/mcp`, stdio) is how agents reach the store. It routes
through the daemon over HTTP (auto-starting it if needed), so it never holds the
store lock itself. Six tools: `save_memory`, `recall_memory`, `memory_history`,
`list_conflicts`, `resolve_conflict`, `delete_schema_entry`.

Run this AFTER the CLI plan passes through phase 4, with the daemon in cloud mode:
the interesting MCP behavior (dedup, conflicts) needs the LLM.

> NOTE while testing: the docs currently have NO page telling users how to register
> the MCP server. The snippets below are the source material for that page; write it
> during the docs review.

## Phase 0: registration

Pick the client you use most first; repeat for a second client in phase 6.

- **Claude Code (pre-publish, local build):**
  `claude mcp add memloom -- node D:\Kostek\Projects\memloom\packages\mcp\dist\bin.js`
- **Claude Code (post-publish):**
  `claude mcp add memloom -- npx -y @memloom/mcp`
- **Claude Desktop** (`claude_desktop_config.json` under `mcpServers`):

  ```json
  "memloom": {
    "command": "node",
    "args": ["D:\\Kostek\\Projects\\memloom\\packages\\mcp\\dist\\bin.js"]
  }
  ```

  Post-publish: `"command": "npx", "args": ["-y", "@memloom/mcp"]`.
- **Cursor** (Settings > MCP): same command/args shape as Desktop.

Checks:

- [ ] After registering, the client lists **memloom** with all six tools
      (`/mcp` in Claude Code; the tools icon in Desktop).
- [ ] Stop the daemon first (`memlooom stop`), then restart the MCP client.
      EXPECTED: the server still comes up; connect() auto-starts the daemon.
      Confirm with `curl http://127.0.0.1:4319/health`.

## Phase 1: save_memory

Use natural prompts; the point is that the AGENT picks the right tool and type.

- [ ] "Remember that our staging database runs on Postgres 17."
      EXPECTED: `save_memory` call, response "Saved memory <id>". Open `memloom ui`
      Memories tab: the memory is there (cross-surface check).
- [ ] "Remember that I prefer pnpm over npm."
      EXPECTED: saved with `type: preference` (check the tool call arguments).
- [ ] "Remember that we shipped the viewer on July 5th."
      EXPECTED: `type: episode`.
- [ ] "Remember the release steps: bump VERSION, tag, push."
      EXPECTED: `type: procedure`.
- [ ] Repeat the first prompt reworded ("our staging DB is Postgres seventeen").
      EXPECTED: "Already known: merged into memory <id>" or a versioned save; the
      agent should NOT report a second fresh memory.

## Phase 2: recall_memory

- [ ] "What do you remember about the staging database?"
      EXPECTED: `recall_memory` call; answer grounded in the saved memory, with the
      id visible in the tool result.
- [ ] Ingest a file via CLI (`memloom context add notes.md`), then ask about its
      content.
      EXPECTED: the tool result carries provenance (`from notes.md › <heading>`),
      and the agent's answer names the file.
- [ ] Ask with an exact identifier from a saved memory (a port, a config key).
      EXPECTED: the keyword arm finds it even if the wording differs.
- [ ] Ask about something never stored ("what do you know about my cat?").
      EXPECTED: "No memories found" style result; the agent says it has nothing,
      rather than inventing.

## Phase 3: memory_history

- [ ] Update a memory via CLI (`memloom update <id> "..."`), then ask the agent
      "how has the staging database memory changed over time?"
      EXPECTED: `memory_history` call; v2 current, v1 superseded, readable dates.

## Phase 4: conflicts end to end

- [ ] "Remember that the deploy window is Friday afternoon." then
      "Remember that the deploy window moved to Monday morning."
      EXPECTED: the second save returns the CONTRADICTS message with a conflict id,
      and the agent RELAYS that to you instead of glossing over it. This is the
      product's signature moment over MCP; judge the wording hard.
- [ ] "List my memory conflicts."
      EXPECTED: `list_conflicts` shows NEW vs EXISTING sides.
- [ ] "Resolve it: keep the new one."
      EXPECTED: `resolve_conflict` with `keep_new`; response says reversible.
- [ ] In the viewer's Conflicts tab, revert the resolution.
      EXPECTED: agent's next `list_conflicts` shows it pending again (undo works
      across surfaces).
- [ ] Ask for `keep_existing` on a fresh conflict WITHOUT naming which existing.
      EXPECTED: the tool errors ("requires candidateId") and the agent asks you
      which one, rather than failing silently.

## Phase 5: delete_schema_entry (the guards)

- [ ] "Delete the person entity type from my memory schema."
      EXPECTED: refusal text: built-ins can be disabled but never deleted. The agent
      relays the reason.
- [ ] Add a user type in the viewer (schema tab), leave it active, ask the agent to
      delete it.
      EXPECTED: "still active, disable it first" relayed.
- [ ] Disable it in the viewer, ask again.
      EXPECTED: deleted; the schema tab no longer lists it.

## Phase 6: multi-client and cross-surface

- [ ] Register memloom in a SECOND client (Desktop if you started with Code).
      Save from one, recall from the other.
      EXPECTED: both see the same store instantly; no lock conflicts (both route
      through the one daemon).
- [ ] While an agent chat is mid-session, save something from the CLI, then ask the
      agent to recall it.
      EXPECTED: found; there is no cache to go stale.

## Phase 7: failure modes

- [ ] Kill the daemon (Task Manager) mid-session, then ask the agent to recall.
      EXPECTED: the tool call fails with a readable connection error (the MCP
      process connected at startup and does not re-dial). Restarting the MCP client
      (or the daemon) recovers. Judge whether the error would make sense to a user;
      note the exact text.
- [ ] Attach TablePlus/psql to the Postgres wire, then ask the agent to save.
      EXPECTED: the store-locked 503 text surfaces through the tool result and the
      agent explains it. Disconnect; next call works.
- [ ] Offline mode (remove the key, restart daemon, delete data dir per CLI plan
      phase 3 if the fingerprint refuses): save and recall over MCP.
      EXPECTED: both work; no dedup, no conflicts. `delete_schema_entry` and
      indexing-dependent answers degrade gracefully.

## Wrap up

- [ ] Remove the test registrations you do not want to keep
      (`claude mcp remove memloom`, delete the Desktop JSON block).
- [ ] File deviations. Phases 0 to 4 are launch blockers; 5 to 7 are judgment calls.
- [ ] Write the registration docs page from phase 0 while it is fresh.
