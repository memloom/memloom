# Contributing to memloom

Thanks for your interest. memloom is early, and the highest-leverage contribution right now is
a **file-format extractor**: one object in one file, tested against real Postgres without
Docker (see below).

## Contributor License Agreement

Before your first PR can be merged, you'll be asked to sign the [CLA](./CLA.md) (a bot comments
on your PR; you reply once). This keeps the project's licensing options open. It takes 30
seconds and only needs to happen once.

## Development

Requirements: **Node >= 22** and **pnpm 10**. No Docker, no database to install (see below
for why).

```bash
pnpm install
pnpm typecheck   # tsc --noEmit across packages
pnpm lint        # biome check
pnpm test        # vitest
pnpm build       # tsup across packages
```

## Tests run against real Postgres, with no Docker

memloom is Postgres-native, but you don't need a Postgres server to develop or test it. Tests
spin up **PGLite** (Postgres compiled to WebAssembly) in-process, run the migrations, and
exercise the engine against a real database. No container, no service, no fixtures to manage.
This is also our retrieval-quality regression harness: the synthetic eval benchmark runs the
same way.

If you want to *inspect* the local store while developing, point **Drizzle Studio** or any
Postgres client (via `pglite-socket`) at the data directory; memloom doesn't ship its own
table browser because those already exist.

## Write an extractor

The context connector (`memloom context add`) ingests files through a pluggable registry in
`packages/core/src/extract.ts`. An extractor is one object:

```ts
import { registerExtractor } from "@memloom/core";

registerExtractor({
  kind: "docx",                 // stored on the document row
  extensions: [".docx"],
  version: 1,                   // bump when your pipeline changes → files re-ingest
  chunker: "markdown",          // "markdown" (heading sections) or "outline" (ALL-CAPS titles + numbered points)
  async extract(bytes, path) {
    // e.g. via mammoth (lazy import so the dependency loads only when used):
    const { convertToMarkdown } = await import("mammoth");
    const { value } = await convertToMarkdown({ buffer: Buffer.from(bytes) });
    return { units: [{ text: value, page: null }] };
  },
});
```

That's the whole integration: `detectKind`, directory scans, chunking, embedding, the content-
hash mirror semantics, hybrid recall, and source citations all pick it up automatically.
Ground rules that keep memloom's install light:

- **Lazy-import your parser** (`await import(...)` inside `extract`) and keep it pure-JS. No
  native binaries, no cloud calls in built-in extractors.
- **Preserve locality**: emit one unit per page/sheet/section when the format has them;
  citations depend on it (`page` on the unit).
- **Bump `version`** whenever extraction output changes: it's salted into the content hash, so
  users' unchanged files re-ingest with your improvement instead of no-op'ing.
- **Test end-to-end**: see the "extractor registry" test in `packages/core/src/extract.test.ts`.
  Register, ingest through `Memloom.contextAdd`, recall, assert the citation. It runs against
  real Postgres (PGLite) with no setup.

Wanted next (roughly in order of demand): **CSV / JSON**, **DOCX** (mammoth), **URLs** (fetch +
Readability), **XLSX / PPTX**. Image OCR and audio/video transcription need models rather than
parsers; they belong in optional provider-backed packages rather than core. Open an issue first.

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

## Releasing (maintainers)

Versioning is manual for now (no changesets). To cut a release:

1. Bump `version` in `packages/{core,server,cli,mcp}/package.json` (keep them in lockstep).
2. Update `CHANGELOG.md`.
3. `pnpm -r build && pnpm -r typecheck && pnpm test`, all green.
4. `pnpm release` (runs `pnpm -r publish --access public`; pnpm rewrites the `workspace:*`
   dependency ranges to the real versions at pack time; do **not** use raw `npm publish`).
5. Verify the gate: in an empty temp dir, `npx memloom@latest init` → `save` → `recall` must
   work in under two minutes.
