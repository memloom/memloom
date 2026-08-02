# @memloom/core

**The engine behind [memloom](https://memloom.dev), a local-first memory engine for AI agents.**
Embed it in your own application, or use the [`memloom`](https://www.npmjs.com/package/memloom)
CLI instead if you want the daemon, viewer and MCP server ready to go.

```bash
npm install @memloom/core
```

## Usage

```ts
import { Memloom, PgliteAdapter } from "@memloom/core";

const storage = await PgliteAdapter.open({ dataDir: "./data" });
const memloom = new Memloom({ storage, embedding, llm });
await memloom.init();

await memloom.save({ content: "the staging database runs on Postgres" });
const hits = await memloom.recall("staging db");
```

`init()` runs the migrations and verifies the store's embedding fingerprint, so a store embedded
with one model refuses to open under another.

## What is in it

- **The belief pipeline.** Saves dedupe, restatements become versions, and contradictions are
  kept and raised rather than overwritten.
- **Hybrid retrieval.** Vector, keyword and entity-graph arms fused by rank in a single SQL
  function, over memories and ingested documents together.
- **Context ingestion.** Markdown, text, PDF, web pages, audio and video, chunked along real
  structure with citations. The extractor registry is open, so you can add a format.
- **The entity graph.** Schema-constrained extraction, reversible entity folds, traversal.
- **Storage adapters.** `PgliteAdapter` for embedded Postgres in a folder, `PgAdapter` for a real
  server with pgvector. Identical schema and SQL on both.

Core reads no environment variables and holds no global state. Every provider and setting is a
constructor argument, so the whole engine is testable without a network.

## Documentation

[docs.memloom.dev/concepts/architecture](https://docs.memloom.dev/concepts/architecture)

Apache-2.0. Built by [Versuno](https://versuno.ai).
