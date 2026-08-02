# memloom

**A local-first memory engine for AI agents.** One store on your machine, shared by every tool
you use, that persists across sessions and survives switching agents.

```bash
npm install -g memloom
memloom init
memloom save "the staging database runs on Postgres"
memloom recall "staging db"
```

Requires Node 20 or later. No Docker, no database to install: the store is embedded Postgres in a
folder at `~/.memloom`.

## What it does

- **One layer across every tool.** Claude Code, Claude Desktop, Cursor and your own scripts read
  and write the same store over MCP.
- **Contradictions are kept, not overwritten.** A new memory that clashes with an old one keeps
  both and asks you. Every resolution is reversible.
- **Your files are memory too.** `memloom context add ./notes` ingests markdown, text, PDF, web
  pages and recordings into the same recall, cited back to section, page or timestamp.
- **Your agents' history is memory too.** `memloom import sessions` distills months of coding
  sessions into typed memories.
- **Hybrid retrieval.** Vector, keyword and entity-graph arms fused by rank in one SQL call, so
  `memloom recall "pg_hba.conf"` is exact and `memloom recall "that thing about restarting the
  worker"` is semantic.

Works offline with deterministic embeddings. Add `OPENROUTER_API_KEY` to `~/.memloom/config.env`
for real embeddings, contradiction detection and entity extraction.

## Connect an agent

```json
{
  "mcpServers": {
    "memloom": { "command": "npx", "args": ["-y", "@memloom/mcp"] }
  }
}
```

## Common commands

| Command | Does |
| --- | --- |
| `memloom ui` | The viewer: graph, assistant, memories, conflicts, console |
| `memloom context add <path>` | Ingest files or folders as citable source material |
| `memloom conflicts` | List contradictions waiting on you |
| `memloom reconcile` | Review the store, repair what is provably wrong, ask about the rest |
| `memloom import sessions` | Distill agent transcripts into memories |
| `memloom help` | Everything else |

## Documentation

[docs.memloom.dev](https://docs.memloom.dev)

Apache-2.0. Built by [Versuno](https://versuno.ai).
