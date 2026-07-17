# @memloom/viewer

The viewer UI: a Vite + React static SPA, served by the daemon at `http://127.0.0.1:4319`
(`memloom ui` opens it). Seven tabs: the memory graph (force-directed canvas with
deterministic layout and document chunk blooms), assistant chat, memories, documents, the
schema review queue, conflicts (with revert), and the indexing console. Developer aesthetic:
sharp corners, dark-mode default, CSS variables.

Not published to npm: the build is copied into the CLI package at build time, so the daemon
ships it embedded. `pnpm dev` here runs it against a daemon on 4319.
