# Distillation eval

Thirty transcripts, each with the memories a careful human would keep from it, scored
against what `distillChunk` produces. It exists because the shipped prompt was written for
coding sessions and, on an advice chat, stored the assistant's advice as the owner's beliefs
(197 of 280 memories in the Phase 0 probe) while dropping the owner's own biography. Any
change to `packages/core/src/distill.ts` should run this before and after.

## What is in here

| folder | transcripts | kind | where from |
|---|---|---|---|
| `fixtures/coding` | 10 | `agent-session` | hand-written Claude Code style sessions: a decision, a gotcha, a preference, and a long generic explanation from the assistant that must not become a memory |
| `fixtures/advice` | 10 | `chat` | LongMemEval_S sessions (question ids in each file's `source`), the same corpus the Phase 0 probe ran on; expected memories hand-written from the user turns |
| `fixtures/voice` | 10 | `note` | hand-written voice-note monologues: filler, self-corrections ("no wait, Wednesday"), relative dates, one generic musing each, one secret that must not be stored |

A fixture is `{ id, kind, date, units: [{role, text}], expected: [{content, type, keywords}] }`.
`keywords` is the deterministic fallback for the recall score: every group must appear in some
extracted memory (a group is a string, or an any-of list). The LLM judge is the default and
reads meaning; keywords are for a quick run with zero judge calls.

## Scores

| column | meaning |
|---|---|
| facts recalled | expected memories that some extracted memory covers (same fact, key specifics intact) |
| advice stored | extracted memories the judge labels `generic`: assistant advice, recommendations, explanations, musings that would be just as true for a stranger |
| duplicates | extracted memories that restate another extracted memory |
| unsupported | extracted memories not stated in the transcript |
| dropped by parser | reply items `parseDistillation` refused: untyped, unsourced, empty, oversized |

Every run writes `runs/<label>.json` with each extracted memory and its labels, so a number in
the table can be traced to the memories behind it.

## Running

```bash
pnpm eval                                        # current prompt, claude -p on your subscription
pnpm eval -- --prompt baseline --label before    # the prompt as it shipped before this branch
pnpm eval -- --label after
pnpm eval:compare eval/runs/before.json eval/runs/after.json
```

Providers:

- `--provider claude-cli` (default): shells out to `claude -p` through `ClaudeCliLLM`. Needs the
  CLI installed and logged in (`claude login`); a logged-out CLI fails every fixture with the auth
  error rather than scoring zero. Distiller `haiku`, judge `sonnet` by default.
- `--provider openrouter`: the model memloom ships with (`google/gemini-2.5-flash`), judged by a
  different vendor (`openai/gpt-4.1-mini`). Reads `OPENROUTER_API_KEY` from the environment or
  `~/.memloom/config.env`. Spends credits: pass `--max-usd` and the run stops at the cap. A full
  run costs roughly $0.30.
- `--provider empty`: distills nothing; exercises the harness.

Other flags: `--model`, `--judge-provider`, `--judge-model`, `--judge keywords`,
`--kinds coding,advice,voice`, `--only <fixture id>`, `--concurrency N`.

## Results, 2026-10-06

Distiller `google/gemini-2.5-flash` (memloom's shipped default), judge `openai/gpt-4.1-mini`,
both over OpenRouter; `runs/before.json` is the prompt as it shipped, `runs/after.json` is this
branch. The four prompt iterations between them are in `runs/iterations/`.

| kind | metric | before | after |
|---|---|---|---|
| coding | facts recalled | 30/34 (88%) | 33/34 (97%) |
| coding | advice wrongly stored | 9/68 (13%) | 0/68 (0%) |
| coding | duplicates | 24/68 (35%) | 18/68 (26%) |
| advice | facts recalled | 38/50 (76%) | 47/50 (94%) |
| advice | advice wrongly stored | 34/80 (43%) | 0/56 (0%) |
| advice | duplicates | 10/80 (13%) | 8/56 (14%) |
| voice | facts recalled | 35/39 (90%) | 39/39 (100%) |
| voice | advice wrongly stored | 0/56 (0%) | 1/50 (2%) |
| voice | duplicates | 11/56 (20%) | 5/50 (10%) |
| all | facts recalled | 103/123 (84%) | 119/123 (97%) |
| all | advice wrongly stored | 43/204 (21%) | 1/174 (1%) |
| all | duplicates | 45/204 (22%) | 31/174 (18%) |
| all | memories per transcript | 6.8 | 5.8 |

What the iterations taught: the owner rule alone (v1) took advice stored to 0% and recall to 92%
but left duplicates where they were, because the model split one subject into a memory per
clause. A consolidation rule (v2) cut memories by a quarter and lost a few mild preferences and
one decision; v3 restored them by saying folding never drops a fact. v3 also exposed the model
inventing `type: "decision"`, which the parser dropped and which cost a voice note its whole
point; v4 maps the types models invent onto the four real ones. Two consecutive runs of the final
prompt scored 98% / 1% / 15% and 97% / 1% / 18%, so expect that much run-to-run noise.

The two remaining advice misses are the user's best friend's baby shower and brother's new
apartment (listed with no gift named) and "not ready to commit to a Master's" (the model kept the
Economics major and the course history, not the hesitation). The one voice memory the judge calls
generic is "the user prefers to travel light with one backpack", which is a borderline call either
way. The "unsupported" cells are the judge not knowing the recording date: it marks a resolved
date ("Friday, June 26, 2026") as unsupported when the transcript said "Friday".

## Reading a result

`runs/before.json` and `runs/after.json` are committed. The judge is a model and disagrees with a
human on the margins, so compare runs made with the same judge, and read the memories behind any
surprising cell before believing it. The LongMemEval sessions were written by a model too; their
assistant turns are long and generic by construction, which is what made them good at exposing
the original failure.
