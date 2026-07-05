# memloom

**A memory engine for AI agents that you can see and correct — running as one inspectable
Postgres store, byte-identical from your laptop to the cloud.**

memloom gives your AI agents durable, queryable memory:

- **See and correct it.** When a new memory contradicts an old one, memloom flags the conflict
  and lets *you* resolve it (keep new / keep old / keep both / merge) — every decision
  reversible. Most memory systems silently overwrite the old fact; memloom puts you in the loop.
- **One Postgres engine.** Relational, vector (semantic), keyword, and graph search in a single
  store — open it in any Postgres tool. No polyglot of stitched-together databases.
- **Laptop to cloud, same engine.** Run it embedded (a folder on your disk, no Docker), on a
  local Postgres, or in the cloud — the exact same SQL. Own your data; move it anywhere.

> **Status: in active development.** The engine is being extracted into this repo. Watch this
> space for the first release.

## Quickstart

_Coming with the first release._ The goal: `npx memloom init`, then have an agent save and
recall memory in under two minutes — no Docker, no signup.

## License & trademark

memloom is licensed under [Apache-2.0](./LICENSE). Copyright 2026 Kostiantyn Sytnyk (see
[NOTICE](./NOTICE)).

"memloom" and the memloom logo are trademarks — please don't use them in a way that implies
official endorsement of a fork or derived service.

Built by [Versuno](https://versuno.ai).
