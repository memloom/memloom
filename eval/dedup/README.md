# Dedup eval

Hand-labelled cases for the dedup classifier: memloom's LLM prompt (`packages/core/src/dedup.ts`)
and the Jev decision model (`packages/core/src/jev-dedup.ts`) label the same candidates, and the
run scores both against the gold labels. Run it before changing the dedup prompt, the Jev
question wording, the Jev model or `DEFAULT_JEV_THRESHOLD`.

## What is in here

`cases.json` holds 54 incoming memories and 178 candidate judgments. Each case is one incoming
memory with the 2 to 4 existing memories a save would send the classifier together, because
production asks about up to 5 candidates in one request and both classifiers should be measured
on that shape. A candidate is `{ text, gold, accept?, trap }`.

The memories are written to look like what the owner's assistant and coding agents save:
appointments, family, money, preferences, servers, repo decisions. Every case has a trap:

| trap | example |
|---|---|
| changed number, date, time, place or name | rent 3,200 PLN vs 3,400 PLN |
| different subject, same template | Alice's birthday vs Bob's birthday on the same day |
| negation, preference reversal | prefers tea vs prefers coffee |
| state change | "we migrated CI to GitHub Actions" vs "CI runs on CircleCI" |
| implied contradiction | "moved to Berlin in October" vs "lives in Warsaw" |
| unit conversion | 24,576 MB vs 24 GB |
| cross-language | a Polish memory against its English twin |
| dropped detail | "lives in Warsaw" vs "lives in Warsaw, in Mokotow, with their partner and two kids" |
| different event, same topic | the 10 km race on 12 October vs the weekly 5 km run |

## Label rules

- **identical**: the existing memory states the same fact. Wording, units, language and tense may
  differ. Versioning the existing memory into the new one loses nothing.
- **contradictory**: same subject, and both cannot be true now. A state change counts ("CI runs on
  CircleCI" against "we migrated off CircleCI"): the conflict queue and the auto-resolver are where
  state changes get settled.
- **complementary**: both can be true. Different subject, different event, an added fact, or
  unrelated.

Two rules come from what the labels do in `Memloom.#save`, not from the prompt:

- When the existing memory carries a fact the new one lacks ("dropped detail"), the gold label is
  complementary. Calling it identical would stale the richer memory.
- When the new memory only adds detail to the existing one, identical and complementary are both
  accepted (`accept`): versioning loses nothing and keeping both loses nothing.

"false identical" in the report counts identicals the gold labels do not accept: each one is a
memory staled in production. "missed contradiction" counts gold contradictions labelled anything
else: each one is a conflict a human never sees.

## Running

```bash
pnpm eval:dedup                                          # Haiku 5.5 vs Jev at the default threshold
pnpm eval:dedup -- --threshold 0.8 --label t080
pnpm eval:dedup -- --llm openrouter:google/gemini-2.5-flash --label gemini
```

Both arms bill `OPENROUTER_API_KEY` (from the environment or `~/.memloom/config.env`). A full run
costs about a cent; `--max-usd` (default 0.50) stops it at a cap.

The LLM arm defaults to `anthropic:anthropic/claude-haiku-5.5`: the `AnthropicLLM` class the
owner's server runs, effort low, pointed at OpenRouter's Anthropic-compatible endpoint. The labels
are the production model's; the latency includes the OpenRouter hop, and the cost is priced at
Anthropic's list price for `claude-haiku-5-5`. `openrouter:<model>` runs any OpenRouter model
through `OpenRouterLLM` instead.

The Jev arm is `JevDedupClassifier` itself, gated, with an `LlmDedupClassifier` on the same LLM as
its fallback. Each run writes `runs/<label>.json` with every pair's gold label, the LLM's label,
Jev's probabilities and the gated outcome. The threshold sweep in the report is simulated from
those probabilities, with the LLM arm's label standing in for the fallback.

## Results, 2026-11-08

Three runs on the final set: `runs/haiku-vs-jev.json` (Jev gated at 0.9, Haiku fallback),
`runs/haiku-vs-jev-t080.json` (gated at 0.8) and `runs/gemini-vs-jev.json` (gated at 0.9, Gemini
fallback). Haiku 5.5 is the production LLM on the owner's server; Gemini 2.5 Flash is memloom's
shipped default. Where a cell has several numbers, they are the separate runs.

| | Haiku 5.5 | Gemini 2.5 Flash | Jev 1.14 alone | Jev gated, LLM fallback |
|---|---|---|---|---|
| correct, of 178 | 174, 176 | 177 | 177, 176, 176 | 178, 178, 178 |
| false identical | 0, 0 | 0 | 0, 1, 1 | 0, 0, 0 |
| missed contradiction | 1, 0 | 0 | 0, 0, 0 | 0, 0, 0 |
| p50 / p95 latency per request | 1,514 / 2,641 ms | 1,049 / 1,512 ms | 238 / 346 ms | 270 / 1,945 ms |
| cost per 1,000 judgments | $0.046 | $0.144 | $0.010 | $0.022 |
| requests that needed the LLM | all | all | none | 21 of 54 at 0.9 |

Latency and cost are from the first run; the gated column uses Haiku as the fallback. Jev's price
is $0.042 per million input tokens with free output; one request with three candidates is about
800 input tokens, most of it the criteria repeated per question.

Jev agrees with Haiku on 96% of judgments. Its probabilities are well calibrated on this set:

| Jev's probability for its label | right, run 1 | run 2 | run 3 |
|---|---|---|---|
| 0.99 and above | 126/126 | 125/125 | 126/126 |
| 0.9 to 0.99 | 27/27 | 28/28 | 25/25 |
| 0.7 to 0.9 | 17/18 | 15/16 | 17/18 |
| below 0.7 | 7/7 | 8/9 | 8/9 |

Every answer at 0.9 or above was right in every run. The highest probability Jev ever gave a wrong
answer was 0.76.

Jev's raw mistakes are the ones that need a step of reasoning:

- It called "the user lives in Warsaw" identical to the richer "lives in Warsaw, in Mokotow, with
  their partner and two kids" at 0.55 and 0.59. Acting on that would have staled the richer memory.
- It called 24,576 MB and 24 GB contradictory at 0.71 to 0.76.

The gate sent both to the LLM, which got them right. The LLMs' own misses were different ones, and
Jev answered those at 0.96 to 0.99: Haiku called "standup on Mondays and Thursdays only"
complementary to "standup every weekday", and both LLMs called some plain paraphrases
complementary ("PRs are squash-merged into main", "the release signing key lives in 1Password").

Neither side is deterministic. The same Jev pair scored 0.71, 0.72 and 0.76 across runs, and Haiku's
score moved from 174 to 176 between two runs of the same cases.

### Threshold

Simulated from the first run's probabilities:

| threshold | requests that need the LLM | correct | false identical |
|---|---|---|---|
| 0.7 | 7 of 54 | 176 | 0 |
| 0.8 | 13 of 54 | 176 | 0 |
| 0.9 | 21 of 54 | 176 | 0 |

(The simulation uses the LLM arm's labels for the fallback, so it inherits that arm's two misses;
the real gated runs scored 178.)

The default is 0.9. The highest probability on a wrong answer was 0.76, so 0.8 leaves a margin of
0.04 against a mistake that stales a memory, and 0.9 leaves 0.14. 0.8 cuts the LLM calls by about
a third and is a reasonable setting once a larger sample of real saves agrees.

These cases are hard on purpose: most pairs carry a trap. Real saves are mostly an incoming memory
against neighbours that are plainly about something else, which Jev answers at 0.99, so the share
of saves that reach the LLM in production should be well under the 39% seen here.

## The next candidate: the conflict auto-resolver

`packages/core/src/conflict-resolver.ts` is the second LLM call a save can make. When the dedup
classifier files a conflict during a session import, the resolver sees both memories with their
recording times and transcript excerpts and picks `keep_new`, `keep_existing`, `keep_both` or
`unsure`. It runs at save time (`#judgeConflictNow`) and over the queue in `autoResolveConflicts`.

It maps onto Jev with one `choice` question per conflict, options `keep_new`, `keep_existing` and
`keep_both`, and `state` holding each side's content, timestamp and excerpt. With several
candidates, `keep_existing` becomes one option per candidate.

Three things make it a harder fit than dedup:

- `unsure` should not be an option. The prompt tells the model to answer unsure unless the
  evidence is decisive. A choice model always picks an option and has no reason to pick "I don't
  know", so the unsure answer is the low-probability case instead: below a threshold, the conflict
  stays in the human queue, exactly as `unsure` does today.
- The evidence is in the excerpts, up to 700 characters each, and the decision is about time: which
  side the newer transcript shows changing. Dedup compares two short sentences. Jev's dedup misses
  were the cases that needed a step of reasoning (unit conversion, a dropped detail), so its
  calibration here needs its own measurement.
- The cost of a wrong decisive verdict is higher. `keep_new` and `keep_existing` stale a memory
  without a human seeing it, and the history is revertable, but only if someone looks.

Before building it: label 50 to 100 real conflicts from the store's resolution history
(`memory_dedup_decisions` rows a human resolved, with their excerpts) and measure both the LLM and
Jev against the human's choice, including how many Jev would leave to the human at each threshold.
If Jev's top band is as clean as it is for dedup, the resolver can move off the LLM the same way,
with the LLM as its fallback.
