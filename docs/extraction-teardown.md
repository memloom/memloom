# Extraction teardown: how five memory systems turn conversation into memory

Written 2026-10-06 for the distillation rework on `feat/distill-any-transcript`. Five systems
were cloned at their current default branch and read for the same three questions: what the
extraction prompt says, how the system tells the user's facts from the assistant's output, and
what happens when a new memory updates or contradicts an old one. memloom's own pipeline is
described first so the comparison has a baseline.

| system | clone | commit |
|---|---|---|
| mem0 | github.com/mem0ai/mem0 | c93420c (2026-10-05) |
| supermemory | github.com/supermemoryai/supermemory | ac21804 |
| Letta | github.com/letta-ai/letta | main 5bcdd17 is docs only; code read from the `archive` branch at 56ba9c2 |
| cognee | github.com/topoteretes/cognee | shallow clone, 2026-10-06 |
| graphiti | github.com/getzep/graphiti | 2a85bbbf (v0.30.2) |

Letta's `AGENTS.md` asks that the archived code not be used for comparisons with other memory
systems or to infer current behaviour; current Letta lives in `letta-ai/letta-code`. The Letta
section below describes the archived V1 Python server and is labelled as such.

## memloom before this branch

One function, `buildDistillPrompt` in `packages/core/src/distill.ts`, called from
`importSessions` in `memloom.ts` once per chunk. The pipeline:

1. `parseSession` reads a Claude Code JSONL transcript and keeps the text blocks of user and
   assistant turns. Tool calls, tool results, sidechains, meta lines and slash-command noise
   are dropped. Each block is a unit with a line number and a role.
2. `redact` scrubs secrets; `chunkUnits` packs units into chunks of about 24,000 characters.
3. One LLM call per chunk. The prompt opened "You distill a coding-session transcript", framed
   the transcript as untrusted data, listed the four memory types, and asked for a JSON array
   with line ranges. It never said whose statements count.
4. `parseDistillation` drops untyped, empty or oversized items and clamps line ranges.
5. Each memory is embedded and saved through the belief pipeline: exact hash merges; otherwise
   the dedup classifier (`dedup.ts`) labels each near neighbour identical, complementary or
   contradictory. Identical appends a version; contradictory records a conflict, and when a
   transcript excerpt is attached the conflict resolver (`conflict-resolver.ts`) gets one shot
   at settling it from recording times and excerpts. Nothing is deleted.

The failure the Phase 0 probe found (agent-memory-bench, `HANDOFF.md`): on LongMemEval_S, 197 of
280 stored beliefs were the assistant's generic advice. The prompt asked for "a stable truth
about the project, system, or user" and "reusable how-to steps", and an advice reply is a list
of exactly those. Nothing told the model that first-person statements by the user outrank the
assistant's text, and "skip what is obvious from the code itself" has no meaning for a chat.

## mem0

**Where.** `mem0/configs/prompts.py:468-944` is `ADDITIVE_EXTRACTION_PROMPT`, the live system
prompt; `generate_additive_extraction_prompt()` at 965-1062 builds the user prompt. The call
site is `mem0/memory/main.py:918-1220` (`_add_to_vector_store`). The older v2 prompts
(`FACT_RETRIEVAL_PROMPT`, `USER_MEMORY_EXTRACTION_PROMPT`, `AGENT_MEMORY_EXTRACTION_PROMPT`,
`DEFAULT_UPDATE_MEMORY_PROMPT`) are still in the file and have no callers.

**Extraction prompt.** Line 472: "Your sole operation is ADD: identify every piece of memorable
information and produce self-contained, contextually rich factual statements." Line 474: "You
extract from BOTH user and assistant messages. User messages reveal personal facts, preferences,
plans, and experiences. Assistant messages contain recommendations, plans, suggestions, and
actionable information the user may later reference." Line 488: "Attribute correctly: use
'User' for user-stated facts. For assistant-generated content, frame in terms of the user's
context (e.g., 'User was recommended X')." Lines 490-493 exclude vague assistant
characterisations, acknowledgments and the assistant's meta-commentary; 574: "Do NOT extract
from assistant messages that merely restate, summarize, or confirm what the user already said.
The user's own words are the primary source"; 578: "When in doubt, extract. A slightly redundant
memory is far less costly than a missing one." Line 912 asks for 5-15 memories per 10-message
conversation. Memories are 15-80 words, "Contextually Rich, Not Atomic", and transitions keep
the old state ("User switched from almond milk to oat milk lattes after developing an almond
sensitivity"). Relative dates resolve against an Observation Date. Twelve few-shot examples.

**User vs assistant.** By prompt only. `parse_messages` (`mem0/memory/utils.py:61-76`) flattens
every message to `role: content` text, system messages included; no code filters roles. The
model labels each memory `attributed_to: "user" | "assistant"`, the label is stored as metadata
(`main.py:1038`) and nothing filters on it. The v2 `USER_MEMORY_EXTRACTION_PROMPT` took the
opposite stance ("GENERATE FACTS SOLELY BASED ON THE USER'S MESSAGES ... YOU WILL BE PENALIZED",
lines 67-68); v3 reversed it so that recommendations survive as "User was recommended X".

**Updates and contradictions.** v3 has none. The migration doc (`docs/migration/oss-v2-to-v3.mdx:16`)
says "Single-pass ADD-only (one LLM call, no UPDATE/DELETE)", and line 309: "When information
changes, the new fact is stored alongside the old one. Retrieval handles ranking." The ranking
(`mem0/utils/scoring.py:60-124`) has no recency term, so old and new compete on similarity
alone. The prompt asks for `linked_memory_ids` including a "Contradiction" link type (699); the
code discards the field. The v2 `DEFAULT_UPDATE_MEMORY_PROMPT` (176-324) had ADD / UPDATE /
DELETE / NONE against top-10 candidates; its DELETE example ("Loves cheese pizza" plus "Dislikes
cheese pizza" deletes the old one and adds nothing) shows why reconciling in the extractor is
risky.

**Dedup.** md5 of the text against the 10 retrieved candidates only (`main.py:1009-1026`), plus
the prompt's instruction to skip "semantically equivalent" items. No global hash index, no
similarity cutoff. The "Recently Extracted Memories" section the prompt calls the "primary
deduplication reference" is always empty in open source.

**Weaknesses.** System messages reach the extractor; linking is a no-op; the prompt's "when in
doubt, extract" and its 5-15-per-conversation quota push volume onto a dedup layer that is weak
in open source. Prompt and code disagree in several places (window sizes, empty sections, example
format).

## supermemory

**Where.** Nowhere public. The docs state it: `apps/docs/self-hosting/overview.mdx:20`, "The
SDKs and other components in the public repository are open source; the downloadable self-hosted
server binary is built from a separate, non-public codebase", and `configuration.mdx:24`, "In
production, Supermemory uses its own proprietary models tuned for long-horizon data
understanding." The repo holds SDKs, the AI SDK / OpenAI / Mastra middleware, the MCP server, the
docs, a graph visualiser and zod schemas that mirror the database.

**What can be read.** The customer-facing knobs: an org-wide `filterPrompt` (at most 750 chars,
`customization.mdx:10-81`), a per-container `entityContext` (1500 chars; `rules.mdx:150`:
"Picture a third person watching a conversation between two people: what do they remember, and
about whom?"), and topic buckets whose descriptions "steer the classifier"
(`user-profiles.mdx:95-112`). Memory types in `graph-memory.mdx:128-134`: facts "persist until
updated", preferences "strengthen with repetition", episodes "decay unless significant". Forgetting
(136-140): time-based expiry, "Contradiction: updates win for 'what's true now'", and noise
filtering. Extraction is a second asynchronous phase called "dreaming", grouped per session by
`customId` (118-124).

**User vs assistant.** The clients send both roles. `packages/tools/src/vercel/middleware.ts:62-149`
drops system messages, keeps user and assistant text, and excludes tool payloads by default
("often large and low-signal, and would pollute memory extraction", 218-222). The OpenAI
middleware persists only when at least one non-empty user message exists (`openai/middleware.ts:246-256`)
and strips previously injected memory context before saving (274-300) so recalled memories are
not re-ingested. Attribution happens server side, steered only by `entityContext`. The README's
benchmark line reports "Assistant recall 100%, User recall 97%" separately, so assistant content
is memorised.

**Updates and contradictions.** `packages/validation/schemas.ts:239-279`: relations `updates |
extends | derives`; version chains via `version`, `isLatest`, `parentMemoryId`, `rootMemoryId`;
flags `isInference`, `isForgotten`, `isStatic`, `forgetAfter`, `forgetReason`; `sourceCount`.
`graph-memory.mdx:67-77`: an update "replaces what was true before for search purposes; history
can remain for audit". Inferred memories are down-weighted until a human confirms them
(`memory-review.mdx`). `PATCH /v4/memories` creates a new version and keeps the old with
`isLatest=false`. Deletes are soft. Ordering is ingestion order within a container
(`rules.mdx:116`), so backfills can mislabel which fact is latest.

**Dedup.** Content hash per document, `customId` upsert with diffing, `sourceCount` on memories.
The merge logic is not public.

**Weaknesses.** Nothing about the extraction itself can be inspected or tuned beyond two short
free-text fields. Relevant to memloom only as a model of the output shape: typed memories,
linear version chains, soft forgetting, inferences separated from statements.

## Letta (archived V1 server)

**Where.** Memory tools in `letta/functions/function_sets/base.py` (`core_memory_append` 246-260,
`core_memory_replace` 263-280, `memory_replace` 311-388, `memory_insert` 391-450,
`memory_rethink` 488-517, `archival_memory_insert` 164-191). The sleeptime agent's system prompt
is `letta/prompts/system_prompts/sleeptime_v2.py`; the per-turn message it receives is built in
`letta/groups/sleeptime_multi_agent_v4.py:233-243`. Voice variant: `voice_sleeptime.py`.

**How extraction happens.** Agent-driven, not a batch extractor. The chat agent edits its own
memory blocks mid-conversation, or (with sleeptime enabled) a background agent receives the
transcript every N turns (default 5) and edits the shared blocks with `memory_replace`,
`memory_insert`, `memory_rethink`. `sleeptime_v2.py:16-25`: "You goal is to make sure the memory
blocks are comprehensive, readable, and up to date ... do not write 'today' or 'recently', instead
write specific dates and times, because 'today' and 'recently' are relative, and the memory is
persisted indefinitely ... Not every observation warrants a memory edit, be selective in your
memory editing, but also aim to have high recall."

**User vs assistant.** By block, not by rule. Two default blocks (`letta/constants.py:109-110`):
persona ("details about your current persona") and human ("key details about the person you are
conversing with"). The sleeptime message disambiguates roles ("Messages labeled 'assistant' are
from the primary agent (not you)") so the background agent does not confuse itself with the chat
agent, but nothing says the assistant's statements must not land in the human block, and the
voice prompt invites "light, well-supported inferences". `stringify_message`
(`letta/groups/helpers.py:105-119`) includes the assistant's `<thinking>` content, so inner
monologue can reach durable memory.

**Updates and contradictions.** Overwrite in place. Every tool ends in
`update_block_value(label, value)`. `memory_replace` needs an exact, unique substring
(`base.py:363-373`); `memory_rethink` rewrites the whole block ("new_memory should contain all
current information from the block that is not outdated or inconsistent", 285). Contradiction
policy is prose: "Update: Remove or correct outdated or contradictory information"
(`voice_sleeptime.py:60-66`). A `BlockHistory` undo/redo table exists (`orm/block_history.py`)
but no agent edit path calls `checkpoint_block_async`; versioning is only on for agents tagged
`git-memory-enabled` (`block_manager_git.py`).

**Dedup.** None programmatic for blocks (`core_memory_append` appends blindly). Archival memory
is insert-only with no similarity check (`passage_manager.py:543-637`).

**Weaknesses.** One bad rewrite silently drops facts; no per-fact timestamps, provenance or
confidence. Two things worth copying: the ban on relative time words, and `memory_replace`
refusing ambiguous matches.

## cognee

**Where.** Plain text prompts in `cognee/infrastructure/llm/prompts/`. Default graph extraction is
`generate_graph_prompt.txt` (config `graph_prompt_path`, `infrastructure/llm/config.py:165`), wired
in `infrastructure/llm/extraction/knowledge_graph/extract_content_graph.py:18-50`: the chunk text is
the whole user message, no metadata, no context. Summaries: `summarize_content.txt`. Contradiction
detection: `detect_contradictions_system.txt`, `tasks/graph/detect_contradictions.py`. The only
role-aware prompt is `session_distillation_curator_system.txt`, used by the opt-in memify path.

**Extraction prompt.** `generate_graph_prompt.txt:1-3`: "You are a top-tier algorithm designed
for extracting information in structured formats to build a knowledge graph. Nodes represent
entities and concepts. They're akin to Wikipedia nodes." Node labels must be elementary types
("Person", not "Mathematician"); ids are human-readable names; dates are `YYYY-MM-DD` nodes;
coreference resolves to the most complete identifier; line 34: "Adhere to the rules strictly.
Non-compliance will result in termination". The schema (`cognee/shared/data_models.py:49-77`) is
`Node{id, name, type, description}`, `Edge{source_node_id, target_node_id, relationship_name,
description}`, `KnowledgeGraph{nodes, edges}`. No speaker, polarity, confidence or valid-time
fields.

**User vs assistant.** None in the core path. A chat log goes through `TextDocument`, is
paragraph-chunked with turn boundaries ignored (`modules/chunking/TextChunker.py`), and each chunk
is extracted in isolation with the Wikipedia-style prompt. The session bridge
(`tasks/memify/extract_user_sessions.py:97-101`) renders `Question: ... Answer: ...` and feeds
cognee's own generated answers back through the same prompt. The curator prompt for session
distillation is the one place the distinction exists: line 12, "GROUNDED: every lesson must be
supported by what actually appears in the slice (the user's statements and the candidates) ...
do not promote a claim that exists only in an assistant answer unless the user or a candidate
backs it"; line 11, "DURABLE ONLY ... Omit session-local trivia". A writer step then accepts or
rejects each lesson as `already_known`, `not_durable` or `unsupported` against similar prior
lessons.

**Updates and contradictions.** Append and upsert. Nodes are last-write-wins on `properties`
(Ladybug adapter `ON MATCH SET n.properties = node.properties`); existing edges are never
rewritten, so a re-asserted fact keeps its first `edge_text` and `updated_at`. Contradiction
detection is off by default (`modules/cognify/config.py:12`), compares bare triples from a 1-hop
neighbourhood, and only adds a `contradicts` edge with a confidence; nothing is resolved. Temporal
supersession (`resolve_temporal_contradictions`) needs hand-declared functional relationships and
exact relationship-name matches. Re-adding an edited chat log as raw text creates a new document
(content-hash naming), so stale facts are never retired.

**Dedup.** Entity identity is the normalised name, globally (`uuid5` of lowercased name), so
homonyms merge and aliases split. Edge identity is `(source, target, relationship_name)`.
Semantic entity merging is a separate opt-in memify pipeline.

**Weaknesses.** Role-blind by design; isolated chunk extraction; name-only identity. Worth
copying: the curator's grounding rule, the accept/reject gate with named reasons, and
content-hash chunk ids with chunk-level diff updates.

## graphiti

**Where.** `graphiti_core/prompts/`: `extract_nodes.py` (message variant 83-210), `extract_edges.py`
(94-178, with `valid_at` / `invalid_at`), `dedupe_nodes.py` (117-179), `dedupe_edges.py:43-100`
(dedup and contradiction in one call). Episodes are built in `graphiti.py` `add_episode`
(1043-1288) with the last 10 episodes of the same source type as context.

**Extraction prompt.** `extract_nodes.py:84-87`: "You are an entity extraction specialist for
conversational messages. NEVER extract abstract concepts, feelings, or generic words." The
speaker rule at 130-131: "Always extract the speaker (the part before the colon `:` in each
dialogue line) as the first entity node." The entity test at 135: "Could this have its own
Wikipedia article or database entry, OR is it specific enough to distinguish from other items of
the same category within this conversation?" Kinship terms must be possessor-qualified ("Nisha's
dad", not "dad"); "When in doubt, do NOT extract." Facts (`extract_edges.py:157-159`): "The
`fact` MUST preserve all specific details from the source text ... NEVER generalize 'Gamecube' to
'gaming console'". Datetime rules (170-175): present tense sets `valid_at` to the episode time; a
stated change sets `invalid_at`.

**User vs assistant.** None structurally. An episode is one string "actor: content"
(`nodes.py:64-67`); the reference server formats `f'{m.role or ""}({m.role_type}): {m.content}'`
and ingests assistant turns as their own episodes. The speaker rule makes the assistant a node,
and its statements become facts with the same standing as the user's. The only assistant-aware
text is in the combined prompt (`extract_nodes_and_edges.py:142-147`): "Skip didactic / tutorial
scaffolding when the assistant is teaching a topic ... not facts about the user. The user's
interest in the topic ('user is learning Unix commands') is one fact". That prompt is reachable
only through bulk ingestion with a flag that defaults off.

**Updates and contradictions.** Bi-temporal edges (`edges.py:263-285`): `valid_at` / `invalid_at`
are world time, `created_at` / `expired_at` are ingestion time. `dedupe_edges.resolve_edge` returns
`duplicate_facts` and `contradicted_facts` in one call; the prompt: "A fact from EXISTING FACTS can
be both a duplicate AND contradicted (e.g., semantically the same but the new fact
updates/supersedes it)", with the example that "software engineer" to "senior engineer" is a
contradiction, not a duplicate. On contradiction (`edge_operations.py:538-573`) the older edge gets
`invalid_at = new.valid_at` and `expired_at = now`; nothing is deleted. Two gaps: if either
`valid_at` is null the contradiction is silently dropped, and search does not exclude expired edges
unless the caller filters.

**Dedup.** Nodes: embedding candidates (cosine ≥ 0.6, top 15), exact normalised name, MinHash
(Jaccard ≥ 0.9), then one batched LLM call. Edges: only between the same directed node pair, plus a
global top-10 hybrid search for invalidation candidates. "NEVER mark facts as duplicates if they
have key differences, particularly around numeric values, dates, or key qualifiers."

**Weaknesses.** Speaker-as-entity with no role semantics; contradiction needs both dates; expired
facts stay searchable. Worth copying: the never-generalise rule, possessor-qualified entities,
one call for dedup plus contradiction, and the didactic-scaffolding rule that their default path
never reaches.

## Side by side

| | mem0 v3 | supermemory | Letta V1 | cognee | graphiti | memloom (before) | memloom (this branch) |
|---|---|---|---|---|---|---|---|
| extraction | one batch prompt, both roles | closed; async "dreaming" per session | agent edits blocks with tools | graph prompt per chunk, role-blind | entity then fact prompts per message | one batch prompt per chunk | one batch prompt per chunk |
| user vs assistant | prompt attribution label, stored, not filtered | server side; `entityContext` hint | by block (human / persona) | none (curator path only) | speaker is an entity; no role rule | none | owner rule; `source` label; parser drops unlabelled-grounded items |
| assistant advice | kept as "User was recommended X" | unknown; assistant recall is benchmarked | may land in human block | kept as graph facts | kept as facts | kept as the owner's beliefs | dropped unless adopted or observed |
| updates | add only; ranking decides | version chain, `isLatest` | overwrite in place | upsert; contradictions flagged only (opt-in) | bi-temporal invalidation | version on identical; conflict on contradiction | unchanged |
| dedup | md5 vs top 10 | server side | none | name identity | embedding + MinHash + LLM | hash, then LLM classify on neighbours | unchanged |
| relative dates | Observation Date | ingestion order | "never write today" | none | episode timestamp | none | `recordedAt` from the session's first timestamp |

## What memloom takes from this

1. **An owner rule, stated once and early.** cognee's curator ("do not promote a claim that exists
   only in an assistant answer unless the user ... backs it") and graphiti's unused didactic rule
   say it; mem0 v2 said it in capitals and v3 reversed it to keep recommendations. memloom's
   stance is the strict one: the store belongs to the person labelled `user`, the assistant is a
   tool, and its output becomes memory only when the owner adopted it or it reports a verified
   observation about the owner's own system. The test sentence in the prompt ("just as true for
   a stranger who never had this conversation") is the operational form.
2. **A source label the parser enforces.** mem0 stores `attributed_to` and ignores it. memloom
   asks for `source: user | adopted | observed`, and `parseDistillation` drops any other label.
   The model's own flag becomes a filter instead of metadata.
3. **Never generalise specifics.** graphiti's rule, almost verbatim: keep the owner's exact
   numbers, names, dates, amounts, brands and places.
4. **Resolve relative time.** mem0's Observation Date and Letta's "never write today":
   `distillChunk` takes `recordedAt`, and session import passes the transcript's first timestamp.
5. **One prompt, three transcript kinds.** The kind-specific paragraph replaces "coding-session
   transcript" in the opening line. A chunk with no assistant turn is a note; notes keep the
   conclusion of a self-correction, not both halves.
6. **Not taken: add-only with ranking.** mem0 v3 pushes contradiction to retrieval with no recency
   term; memloom keeps the belief pipeline (version on identical, conflict on contradiction,
   nothing deleted), which is closer to graphiti's bi-temporal model and already existed.
7. **Not taken: recall quotas.** mem0's "when in doubt, extract" and 5-15 per conversation make
   dedup load-bearing. memloom keeps "few good memories beat many weak ones" and measures
   duplicates in the eval instead.
