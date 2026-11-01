# memloom design

The rules that keep every memloom surface (viewer, docs, landing, README) looking like one
deliberately made thing. The default to avoid: sky-blue accent on slate-dark, rounded
cards, gradient blobs. That's the Tailwind starter look every AI-generated dashboard ships
with, and memloom must never read as one of them.

## Viewer theme: iPod

The viewer (`apps/viewer`) left the amber system on 2026-11-01 for an iPod look, because
Kostek liked it better. Docs, landing and README still follow the amber rules below.

- **Light is brushed silver, dark is black.** Cool aluminium neutrals in light (`--bg
  #e6e7ea`, `--bg-raised #f4f5f6`), near-black in dark (`--bg #0c0d0f`, `--bg-raised
  #16171a`). The header carries the metal: a vertical sheen with a fine horizontal grain in
  light, black anodized in dark. Sidebars get the grain over a flatter panel, so a tall
  sidebar doesn't fade toward the bottom.
- **One glossy blue bar means "selected".** The active tab, the picked folder, chat
  session, model, inbox row, segment and chip all get the same strip: a split-gloss blue
  gradient (`#5b9dff` to `#1d5bc8`) with white text, like an iPod menu row. Primary
  buttons use it too.
- **The blue stays clear of the data.** Chrome blue is `#3b82f6` in dark and `#1f62d6` in
  light, deeper than the memory-node sky `#38bdf8`, so a selected row never reads as a
  memory. The same rule as amber applies: the blue is chrome and selection only, never data.
- **Soft corners.** 8px on cards, modals, the legend and graph panels; 5px on buttons,
  inputs, chips and rows. The theme toggle is a round click-wheel button.
- **Fields stay light.** Inputs sit on `--field` (near-white in light), so they read as
  writable on silver.

All of it lives in tokens at the top of `styles.css` plus one "iPod theme layer" section at
the end of the file. The canvas graph's light palette uses cool greys to match.

## Brand color: amber

The brand color is **amber** on every surface except the viewer (see above).

| Token | Hex | Where |
| --- | --- | --- |
| brand | `#f59e0b` | dark surfaces (viewer chrome, landing): accents, active states, primary actions |
| brand-bright | `#fbbf24` | hover/emphasis on dark |
| brand-deep | `#d97706` | light surfaces (docs primary) |
| brand-dark | `#b45309` | docs dark-mode primary |

Why amber, and not the blue the viewer started with:

- **Amber preserves.** Real amber is fossilized resin that keeps things intact for millions
  of years. The preservation metaphor matches what a memory engine does.
- **Warm = human = ownership.** memloom's story is "memory you own, on your machine." Cool
  blues signal corporate/cloud; warm amber signals hearth, craft, personal. It fits "loom":
  weaving, thread, handmade.
- **Category differentiation.** The memory/agent-infra category (mem0, Zep, Letta) sits in
  the blue-purple-teal band. Amber is instantly recognizable in a screenshot feed.
- **Anti-slop.** Sky-on-slate is the generated-dashboard uniform. You can't look handmade in
  it.

### The one rule: amber means memloom, and nothing else

Amber is reserved for **chrome and identity**: the wordmark accent, active tab, primary
buttons, focus rings, selected chips, links on hover. Amber must never encode data or state:
no amber node types, no amber warnings, no amber charts. The moment amber means something
*inside* the product, the brand color stops meaning the product.

## Data palette (the graph)

Node kinds keep their own colors. They are a data encoding rather than decoration, and they
never change with the brand:

| Kind | Color | Shape |
| --- | --- | --- |
| memory | `#38bdf8` sky | square (content is square) |
| entity | `#c084fc` purple | circle (only entities are circles) |
| document | `#34d399` emerald | diamond |
| chunk | `#6ee7b7` light emerald | small square |

Edge colors follow their relation: `mention` purple, `replaces` (version lineage) indigo
`#5d67f5`, `distinct` teal, document→chunk emerald. Type accents inside lists stay neutral
(white/muted); the type is a label rather than a traffic light.

## Semantic colors

| Meaning | Color |
| --- | --- |
| success / ok | `#34d399` |
| danger / conflict | `#f87171` (contradictions are alerts, so conflict badges and existing-vs-new markers are red rather than amber) |
| versioned / lineage | `#5d67f5` indigo |

## Surfaces

Dark, ink-like, low-chroma:

```
--bg #0b0f14 · --bg-raised #11161d · --bg-inset #0d1117
--border #1f2937 · --border-strong #334155
--text #e2e8f0 · --text-muted #94a3b8 · --text-faint #64748b
```

Docs (Mintlify) run their own light/dark themes with the brand-deep/brand-dark ambers as
primary.

## Shape & typography

- **Sharp corners everywhere except the viewer.** No border-radius. Panels, buttons, inputs, chips: all square.
  This is the single strongest anti-slop signal in the whole system.
- **Monospace for anything a machine produced or consumes:** ids, paths, counts, tags, meta
  rows, breadcrumbs, the wordmark. Sans for human prose. If you're unsure, ask "would this
  string appear in a terminal?"; if yes, mono.
- **Uppercase micro-labels** (11px mono, letterspaced) for section labels and tags.
- **The pixel motif:** node shapes are flat filled primitives, no strokes, no shadows, no
  glow. Density and color do the work.

## Motion

Motion demonstrates the product or it doesn't exist. The force graph blooming, a save
dedup'ing, a conflict resolving: those are worth animating. Scroll-triggered decoration,
floating gradients, parallax blobs are not. Transitions in the viewer stay under 250ms and
move along one axis.

## Voice

Lowercase commands, plain sentences, no exclamation marks. UI copy says what happened
("merged, nothing duplicated") and what to do next, in the same voice as the CLI. Sell
outcomes in marketing surfaces ("never re-explain your codebase to an agent"), mechanisms in
docs (RRF, arms, fingerprints). No em-dashes in user-facing copy; short sentences with
periods, commas, and colons.

## Landing layer (memloom-web)

The marketing site extends this system as "Instrument Panel": the page reads as panels on a
crafted tool, built around one memorable thing, **the living graph**.

- **Display type:** Bricolage Grotesque (Google Fonts via next/font, self-hosted) for the
  headline and section titles only. Weight 650–700, tracking −0.02 to −0.03em. Geist stays
  for body, Geist Mono for machine text. Never use the display face for body copy.
- **TUI panes:** hero copy sits on a solid inset panel (`--bg-inset` ~92%, hairline border),
  never floating over the WebGL terminal. Every surface, hero and terminal demo included,
  follows the active theme: canvas/WebGL components re-palette in JS (the terminal shader
  composites glyph coverage over a theme background color; the graph swaps to the darkened
  light-surface data palette).
- **HUD corner ticks:** the signature motif: amber viewfinder brackets (14px, 2px stroke)
  on the top-left and bottom-right corners of key panels (hero pane, graph card). Use
  sparingly; if everything has ticks, nothing does.
- **Icons:** lucide-react only, 16px, stroke 1.75, always beside a mono label, never in
  colored circles. Muted (`--text-faint`) at rest, amber on the parent's hover.
- **Buttons:** exactly ONE filled amber primary per viewport (near-black text); everything
  else outline or ghost. Icons inside buttons: 16px, 2 stroke.
- **Signature motion:** section titles get a one-time 44px amber scan-line underline on
  scroll-reveal (300ms). Card grids stagger 60ms per cell. Nothing loops except the product
  demos (graph, terminal).

## Decisions log

| Date | Decision | Why |
| --- | --- | --- |
| 2026-07-12 | Amber brand adopted; conflicts moved to red, lineage to indigo | preservation metaphor, category differentiation, anti-slop |
| 2026-07-12 | Landing layer: Bricolage display, TUI panes, HUD ticks, lucide icons, filled amber CTA, scan-line reveals | design review: serve "the living graph", fix hero readability as design |
| 2026-11-01 | Viewer moves to the iPod theme: brushed silver / black, glossy blue selection bar, soft corners | Kostek's call; other surfaces stay amber for now |
