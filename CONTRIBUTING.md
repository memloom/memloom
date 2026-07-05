# Contributing to memloom

Thanks for your interest. memloom is early — the engine is being extracted from a working
private implementation into this repo, phase by phase.

## Contributor License Agreement

Before your first PR can be merged, you'll be asked to sign the [CLA](./CLA.md) (a bot comments
on your PR; you reply once). This keeps the project's licensing options open. It takes 30
seconds and only needs to happen once.

## Development

Requirements: **Node >= 22** and **pnpm 10**. No Docker, no database to install — that's the
whole point (see below).

```bash
pnpm install
pnpm typecheck   # tsc --noEmit across packages
pnpm lint        # biome check
pnpm test        # vitest
pnpm build       # tsup across packages
```

## Tests run against real Postgres, with no Docker

memloom is Postgres-native, but you don't need a Postgres server to develop or test it. Tests
spin up **PGLite** — Postgres compiled to WebAssembly — in-process, run the migrations, and
exercise the engine against a real database. No container, no service, no fixtures to manage.
This is also our retrieval-quality regression harness: the synthetic eval benchmark runs the
same way.

If you want to *inspect* the local store while developing, point **Drizzle Studio** or any
Postgres client (via `pglite-socket`) at the data directory — memloom doesn't ship its own
table browser because those already exist.

## Repository layout

```
packages/core     the engine (storage adapter, providers, write path, retrieval)
packages/server   local HTTP server (Hono)
packages/mcp      MCP server (stdio)
packages/cli      the `memloom` CLI
apps/viewer       minimal viewer UI (Vite + React)
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design and the two rules that are hard to
reverse.
