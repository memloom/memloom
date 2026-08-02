# @memloom/mcp

**The MCP server for [memloom](https://memloom.dev), a local-first memory engine for AI agents.**
Gives your agent a memory it can write to and search, shared with every other tool on your
machine.

## Setup

Add to your MCP client's config:

```json
{
  "mcpServers": {
    "memloom": { "command": "npx", "args": ["-y", "@memloom/mcp"] }
  }
}
```

For Claude Code:

```bash
claude mcp add memloom -- npx -y @memloom/mcp
```

Nothing else to install. The server routes through the `memloom serve` daemon and starts it if
needed, so agents, the CLI and the viewer share one store with no lock conflicts.

## The tools

| Group | Tools |
| --- | --- |
| Memories | `save_memory`, `recall_memory`, `read_passage`, `memory_history` |
| Source material | `add_link`, `add_file`, `list_documents` |
| Decisions | `list_conflicts`, `resolve_conflict`, `list_possible_contradictions`, `answer_possible_contradiction` |
| Graph | `related_entities`, `set_schema_entry_status`, `delete_schema_entry` |

`recall_memory` searches saved memories and ingested documents together, by meaning, exact words
and entities, and returns sources with each result. `save_memory` dedupes and flags
contradictions rather than overwriting.

## Configuration

Put `OPENROUTER_API_KEY` in `~/.memloom/config.env`, not in the client config. The daemon owns
every provider call; this server never talks to a provider itself.

## Documentation

[docs.memloom.dev/mcp/setup](https://docs.memloom.dev/mcp/setup)

Apache-2.0. Built by [Versuno](https://versuno.ai).
