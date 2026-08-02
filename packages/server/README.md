# @memloom/server

**The HTTP layer for [memloom](https://memloom.dev), a local-first memory engine for AI agents.**
A thin [Hono](https://hono.dev) app over [`@memloom/core`](https://www.npmjs.com/package/@memloom/core)
that validates requests, maps them to engine calls, and serves the viewer.

<!-- prettier-ignore -->
> You probably want the [`memloom`](https://www.npmjs.com/package/memloom) CLI instead. It bundles
> this server, the store, the viewer and the daemon into one command: `memloom init`.

```bash
npm install @memloom/server
```

## Usage

```ts
import { createServer } from "@memloom/server";

const app = createServer(memloom);   // a Memloom instance from @memloom/core
```

Returns a Hono app you can serve however you like. The daemon in the `memloom` package uses
`@hono/node-server`.

## What it exposes

Memories, recall, context documents, the entity graph and schema, conflicts, reconciliation, and
the assistant. Streaming endpoints report progress as NDJSON, so long operations like indexing or
a reconcile sweep never hold a request open in silence.

The full route list is the
[API reference](https://docs.memloom.dev/api-reference/introduction).

## Access

Binds to localhost, and both an Origin and a Host check run on every request, so a page on the
open web cannot drive a daemon running on someone's laptop.

Apache-2.0. Built by [Versuno](https://versuno.ai).
