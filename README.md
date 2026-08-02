# memloom

![The memory graph: memories and documents recallable from one place](.github/memloom-graph.png)

**A local-first memory engine for AI agents.** One store on your machine, shared by every tool
you use, that persists across sessions and survives switching agents.

```bash
npm install -g memloom
memloom init
memloom save "the staging database runs on Postgres"
memloom recall "staging db"
```

Requires Node 20 or later. No Docker, no database to install.

## What you get

| | |
| --- | --- |
| **One layer across every tool** | Claude Code, Claude Desktop, Cursor, Copilot and your own scripts read and write the same store over MCP |
| **Contradictions you settle** | A new memory that clashes with an old one keeps both and asks. Every resolution is reversible |
| **Answers with citations** | One recall, with the source named, instead of searching transcripts again every time |
| **Your files are memory too** | `.md`, `.txt`, `.pdf`, web pages and recordings, cited back to section, page or timestamp |
| **Your agents' history is memory too** | Import months of coding sessions as typed memories, or capture each one as it ends |

Retrieval is hybrid: vector, keyword and entity-graph arms fused by rank in a single SQL call
over one Postgres store.

## Quickstart

Everything above works offline. For real embeddings, contradiction detection and entity
extraction, add one key to `~/.memloom/config.env`:

```bash
OPENROUTER_API_KEY=sk-or-...
```

Then migrate what you saved offline into the new vector space:

```bash
memloom stop && memloom reembed && memloom serve
```

The store is stamped with its embedding config and the daemon refuses to mix vector spaces, so
`reembed` is the way across. On a fresh store with the key set from the start it never comes up.

Then:

```bash
memloom context add ./notes    # your files join the same recall
memloom ui                     # graph, assistant, conflicts, console
```

### Or let your agent set it up

Paste into Claude Code, Cursor, or any agent that can run commands:

```text
Set up memloom on this machine. Fetch https://docs.memloom.dev/guides/agent-setup
and follow it exactly. Ask me before anything that spends money or captures a
project. I will give you the API key when you ask.
```

Agents with skill support can install memloom's instead: `npx skills add memloom/memloom`.

## Connect your tools

```json
{
  "mcpServers": {
    "memloom": { "command": "npx", "args": ["-y", "@memloom/mcp"] }
  }
}
```

Fourteen tools: save and recall, read a full passage, walk the entity graph, version history,
list and resolve conflicts, add web pages and files as source material, and manage the graph
vocabulary. Every client shares one store through the daemon. See
[the client list](https://docs.memloom.dev/mcp/setup).

## Import what your agents already know

```bash
memloom import sessions --dry-run     # distill session transcripts into typed memories
memloom import agent-memory           # the memory files agents keep on disk
memloom connect claude-code --all     # capture every future session as it ends
```

`import sessions` reads transcripts locally, scrubs secret-shaped strings, and distills each one
into facts, preferences, episodes and procedures. A ledger makes re-runs free.

`import agent-memory` needs no distillation, since those files are already memories. It parses
them with provenance back to each file.

`connect` makes it continuous, scoped to an explicit project allowlist, and also installs a
prompt-time hook so relevant memories reach the agent without it being told to search.

## Connectors

```bash
memloom notion connect     # pick pages and databases
memloom notion sync        # the daemon also polls for edits
```

Sync is incremental: only changed sections are refetched, an idle workspace costs one API call
per poll, and no model calls ever.

## How it compares

|  | **memloom** | mem0 | Zep / Graphiti | Letta | Supermemory |
|---|---|---|---|---|---|
| Conflict handling | **Human-in-the-loop, every resolution reversible** | auto-resolve (LLM decides) | auto-invalidate (temporal) | agent decides | auto |
| Import coding-agent history | **yes: transcripts distilled, memory files parsed** | no | no | no | no |
| Storage | **one Postgres store** (embedded / local / cloud) | vector DB + optional graph DB | Neo4j/FalkorDB + DB | Postgres + framework state | closed-source cloud |
| Ingest local files into recall | **yes, with section and page citations** | no | no | limited | cloud upload |
| Retrieval | **hybrid: vector + keyword + entity graph, fused in SQL** | vector (+graph opt.) | graph + semantic | vector | proprietary |
| Runs with zero infra | **yes: embedded Postgres, no Docker** | needs vector store | needs graph DB | Docker-first | hosted only |
| Inspect with standard tools | **any Postgres client** | varies | Cypher | partial | no |
| License | **Apache-2.0** | Apache-2.0 | Apache-2.0 | Apache-2.0 | proprietary |

The others optimize for memory that manages itself. memloom optimizes for memory you can audit,
correct and revert, because agents are wrong often enough that silent overwrites are a liability.

## Surfaces

One daemon owns the store. Everything else is a client.

| Surface | What |
| --- | --- |
| CLI | `save`, `recall`, `context`, `import`, `connect`, `notion`, `conflicts`, `reconcile`, `ui` |
| MCP | `@memloom/mcp` over stdio, for any MCP client |
| HTTP | `http://127.0.0.1:4319`, localhost only by design |
| Viewer | `memloom ui`: graph, assistant, memories, documents, schema, conflicts, console |
| Postgres wire | `postgresql://postgres@127.0.0.1:54329/postgres` for psql, Drizzle Studio, TablePlus |

## Extending

An extractor is one object (`kind`, `extensions`, `version`, `chunker`, `extract()`) registered
into the same registry the built-ins use. See the
[extractor guide](https://docs.memloom.dev/guides/extractors). Wanted next: CSV/JSON, DOCX.

## Development

Node 20 or later and pnpm 10. Tests spin up PGLite in-process, run the migrations, and exercise
the engine against a real database.

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Learn more

- [docs.memloom.dev](https://docs.memloom.dev): concepts, guides, and the full CLI, MCP and HTTP reference
- [ARCHITECTURE.md](./ARCHITECTURE.md): the design, and the two rules that are hard to reverse

## License and trademark

Apache-2.0, copyright 2026 Kostiantyn Sytnyk. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

"memloom" and the memloom logo are trademarks. Please do not use them in a way that implies
official endorsement of a fork or derived service.

Built by [Versuno](https://versuno.ai).
