# memloom

**A memory engine for AI agents that you can see and correct. One inspectable Postgres store,
byte-identical from your laptop to the cloud.**

Agents forget, or silently overwrite what they knew. memloom gives every AI client you use
(Claude Desktop, Claude Code, Cursor, your own scripts) one durable memory that you stay in
charge of:

- **See and correct it.** When a new memory contradicts an old one, memloom flags the conflict
  and lets you resolve it: keep new, keep old, keep both, or merge. Every decision is
  reversible. Most memory systems auto-resolve and destroy the losing fact; memloom keeps
  both and puts you in the loop.
- **One Postgres engine.** Relational, vector, keyword, and entity-graph retrieval fused in a
  single store (three-arm reciprocal-rank fusion in one SQL call). Open it with psql or Drizzle
  Studio; it is plain Postgres.
- **Your files are memory too.** `memloom context add ./notes` ingests .md/.txt/.pdf into the
  same recall, with citations back to the exact section and page. PDFs are rebuilt from glyph
  geometry, so even equation-heavy documents come out readable.
- **Laptop to cloud, same engine.** Embedded (a folder on disk, no Docker, no signup), local
  Postgres, or cloud Postgres all run the exact same SQL, so you can move your data between
  tiers whenever you want.

## Quickstart: two minutes, no Docker, no signup

```bash
npm install -g memloom                # one binary, no Docker
memloom init                          # creates ~/.memloom, starts the daemon
memloom save "the staging database runs on Postgres"
memloom recall "staging db"
memloom context add ./docs            # your files join the same recall, with citations
memloom ui                            # graph + conflicts + console in your browser
```

That works fully offline. For real semantic embeddings, contradiction detection, and entity
extraction, add one key to `~/.memloom/config.env` and restart the daemon:

```bash
OPENROUTER_API_KEY=sk-or-...
```

### Connect your AI tools (MCP)

Every MCP client shares the same store through the daemon. For Claude Desktop / Claude Code /
Cursor, add:

```json
{
  "mcpServers": {
    "memloom": { "command": "npx", "args": ["-y", "@memloom/mcp"] }
  }
}
```

Your agent gets `save_memory`, `recall_memory` (memories *and* your ingested files, with
sources), and conflict listing/resolution.

## How it compares

|  | **memloom** | mem0 | Zep / Graphiti | Letta | Supermemory |
|---|---|---|---|---|---|
| Conflict handling | **Human-in-the-loop, every resolution reversible** | auto-resolve (LLM decides) | auto-invalidate (temporal) | agent decides | auto |
| Storage | **one Postgres store** (embedded / local / cloud) | vector DB + optional graph DB | Neo4j/FalkorDB + DB | Postgres + framework state | closed-source cloud |
| Ingest local files into recall | **yes: .md/.txt/.pdf with section + page citations** | no | no | limited | cloud upload |
| Retrieval | **hybrid: vector + keyword + entity graph, fused in SQL** | vector (+graph opt.) | graph + semantic | vector | proprietary |
| Runs with zero infra | **yes: embedded Postgres (PGLite), no Docker** | needs vector store | needs graph DB | Docker-first | hosted only |
| Inspect with standard tools | **any Postgres client** | varies | Cypher | partial | no |
| License | **Apache-2.0** | Apache-2.0 | Apache-2.0 | Apache-2.0 | proprietary |

The difference in intent: the other tools optimize for memory that manages itself. memloom
optimizes for memory you can audit, correct, and revert, because agents are wrong often
enough that silent overwrites are a liability.

## Surfaces

One daemon (`memloom serve`) owns the store; everything else is a client:

| Surface | What |
| --- | --- |
| CLI | `memloom save / recall / context / conflicts / ui` |
| MCP | `@memloom/mcp`: Claude Desktop, Claude Code, Cursor, any MCP client |
| HTTP API | `http://127.0.0.1:4319`: full [API reference](./docs), localhost-only by design |
| Viewer | `memloom ui`: memory/entity graph, conflict review, console |
| Postgres wire | `postgresql://postgres@127.0.0.1:54329/postgres`: psql, Drizzle Studio, TablePlus |

## Extending: add a file format

Extraction is pluggable: an extractor is one object (`kind`, `extensions`, `extract()`), and
formats added by the community land in the same registry the built-ins use. See
[CONTRIBUTING.md](./CONTRIBUTING.md#write-an-extractor) for a worked example; wanted next:
CSV/JSON, DOCX, URLs.

## Learn more

- [ARCHITECTURE.md](./ARCHITECTURE.md): the design, and the two rules that are hard to reverse
- [CONTRIBUTING.md](./CONTRIBUTING.md): dev setup (tests run against real Postgres via PGLite,
  no Docker), the extractor guide, releasing
- [docs/](./docs): the full HTTP API (Mintlify)

## License & trademark

memloom is licensed under [Apache-2.0](./LICENSE). Copyright 2026 Kostiantyn Sytnyk (see
[NOTICE](./NOTICE)).

"memloom" and the memloom logo are trademarks; please don't use them in a way that implies
official endorsement of a fork or derived service.

Built by [Versuno](https://versuno.ai).
