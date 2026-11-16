# Release point 4 (2026-11-16)

Held-out report (PLAN Phase 6). A session that changes the skill, the converter or the runtime must not read this file (EXCLUSIONS.md). Template-identifying detail stays here; LOOP.md carries only the general failure kinds and counts.

## Setup

- Commit 8c005e4 (skill, converter and runtime as `r4l-full`, which ran on 2f952cf; 8c005e4 adds only its results and docs), plain `convert.mjs`, replayed model replies, in process, the claude driver for gate 8. Fresh rows, nothing carried forward: `rel4-dev` (the 100 dev templates of round 4, all with fixtures), `rel4-held` (round 4's fresh held-out, `splits.json` `heldOutFresh4`, 20 templates, explicit ids), `rel4-held-b` (repeat of held-out on the same commit). `r4l-full` was not reused; `rel4-dev` is compared with it below.
- `validate.mjs --ids <held-out>`: 80 fixture files, 0 failing. Held-out warnings: steps neither fed nor listed on two variants of 3132 (its later HTTP reads, off the path those variants take), a template-pinned agent never called by n8n's manual run (2741, P89), and 503's MongoDB credential with no `db.mongodb` in the fixture (below).
- Held-out setup at release time (`run.mjs --n8n-check-only` on all 20, every variant; no model, nothing saved):
  - Overlays: none added. The blind fixture session's placeholder fills stand (2433, 4506, 3132, 2736, 1554, 2956, 4635, 2694; no time compression).
  - Model routing: none needed.
  - `expect.n8nCannotRun` and `expect.n8nFails`: **none marked**. Every canned normal run succeeds except 503 and 4506:
    - 4506 stops at its Code node after a structured-output parser on every variant but empty; a canned reply does not reach the parser's shape (expected for a canned run, as at release point 3). In the scored run its live recording reaches the end, and it stops at preflight on the Claude side either way.
    - 503 fails at MongoDB on every variant (`URI contained empty userinfo section`). Its fixture was written while P66 was pending and has no `db.mongodb`, so the n8n credential reaches no server. n8n can run it on the bench since P66 (R4f-2): this is a fixture gap, not an environment n8n cannot give, so it is not marked (P117). The Claude side blocks it at preflight on the same MongoDB step.
    - 2612 (a Postgres agent's SQL tools) has the same gap; its canned runs succeed because a canned reply calls no tool.
    - 2956's fixture note says n8n refuses its Code node's external module; that node sits in a tool sub-workflow, the chat reply still comes, and the canned runs succeed. Not marked.
  - No fixture fixes.
- `rel4-held` was the first run of the held-out templates on the n8n side, so it also recorded n8n's model calls live (13 calls over 2433, 2572, 1957, 2740 and 2956); `rel4-held-b` replayed them. Release point 3 recorded in a separate setup pass first; here the first scored run did both, which is where the one flip comes from (below, P115).
- `claude -p`: 101 runs (ledger 1414 → 1515; cap 1554): `rel4-dev` 76 (claude-driver runs), `rel4-held` 19 (13 live n8n model calls, 6 claude-driver runs), `rel4-held-b` 6 (claude-driver runs). Haiku only, no usage limit hit, no budget stop; all 100 dev templates ran. The machine stayed at 51–60% free; the claude driver's memory gate never waited. No bench-error rows.

## Numbers

|                              | dev (n=100) | held-out (n=20) |
| ---------------------------- | ----------- | --------------- |
| pass every gate              | 35 (35.0%)  | 2 (10.0%)       |
| gate sum                     | 543         | 77              |
| stop at gate 2               | 1           | 0               |
| stop at gate 3               | 49          | 14              |
| stop at gate 4               | 9           | 3               |
| stop at gate 5               | 1           | 1               |
| stop at gate 6               | 1           | 0               |
| stop at gate 8               | 4           | 0               |
| bench error (gate 0)         | 0           | 0               |
| connector-limited            | 1           | 0               |
| n8n cannot run               | 1           | 0               |
| n8n fails on the template    | 1           | 0               |
| passes, no effect compared   | 13          | 2               |
| flips (repeat on one commit) | 2 of 100¹   | 1 of 20²        |
| claude-driver slips (P40)    | 4 of 84³    | 0 of 6          |

¹ `rel4-dev` against `r4l-full` (same skill, converter and runtime; `summary.mjs --tag rel4-dev --against r4l-full`): 1900 passed every gate and now stops at gate 3 (`runner bug: step ?: run needs`): on normal, the claude driver's session declined to answer a completion-model step whose prompt it saw as empty and ended without finishing the run (not a P40 slip, so not retried; P116). 4969 stays at gate 3 and its cause reads `model refusal` (P106) again instead of `runner bug: run needs`; same verdict, new wording. One pass/fail flip, two verdict flips by the summary's definition (gate, bucket or cause). Every other template has the same gate, bucket and cause.
² 2433 stops at gate 4 in `rel4-held` and passes every gate in `rel4-held-b`. In `rel4-held` the n8n side recorded its two per-item model calls live and they arrived in the other order (call 1 before call 0); gates 3–7 passed in process, and the claude driver's gate 4 found the two model inputs swapped between the items (`2 replayed model call(s) got a different input`). On replay the driver passes. A bench defect (P115), counted as the flip it is.
³ 4969 normal and hostile slipped on both attempts (the session would not write the template's own prompt's answer, P106), as in every round-4 run.

- **Gap:** 35.0 − 10.0 = **25.0 points**.
- **Bound:** pooled p = 37/120 = 30.8%; 1.96 · sqrt(p(1 − p)(1/100 + 1/20)) = 22.2 points, + 2 × 1 flip (10.0 points of the held-out side) = **32.2 points** (`summary.mjs --release rel4-dev rel4-held --flips 1`). The flips term counts the held-out repeat, as at release point 3.
- **Verdict: inside the bound.** Release point 3 was over (24.0 against 20.8); release point 4 is not, so the overfitting rule (over the bound at two release points in a row) **does not fire**. The verdict rests on one template, the one that flipped: see the sensitivity table.
- **Without the templates that have no baseline** (`n8nCannotRun` and `n8nFails`, dev 2271 and 4846; held-out none marked): dev 35 of 98 (35.7%), held-out 2 of 20, gap 25.7 against 32.3 with the flip, inside (22.3 without it: over).

**Sensitivity.** Rows that rest on bench defects, on baselines n8n cannot give, or on passes that compare no effect:

- Held-out: 2433 fails only in the run that recorded live (P115); 2736 stops at preflight because the overlay's URL fill, which carries a dummy token, never reached the export the converter reads (P118), so its later gates are unmeasured; 503 has no working baseline (P117) and stops at preflight on the Claude side anyway. Both held-out passes compare only a terminal node's items (2572: a CV analysis over HTTP, 1957: a chain behind an auto-fixing parser; `result`, P70). 2433's pass in `rel4-held-b` compares 6 effects.
- Dev: 13 of the 35 passes compare no effect (8 reply-only, 5 result-only, P50); 2 templates have no baseline (2271 cannot run, 4846 fails on its own configuration); 2722 is connector-limited; 1900 lost its pass to the driver (P116).

| variant                                                                                        | dev            | held-out     | gap  | bound | inside |
| ---------------------------------------------------------------------------------------------- | -------------- | ------------ | ---- | ----- | ------ |
| as scored (`rel4-held`, 1 flip)                                                                | 35/100 (35.0%) | 2/20 (10.0%) | 25.0 | 32.2  | yes    |
| the flip ignored, 2433 kept as failed                                                          | 35/100 (35.0%) | 2/20 (10.0%) | 25.0 | 22.2  | no     |
| 2433 at its replayed verdict (pass), no flip                                                   | 35/100 (35.0%) | 3/20 (15.0%) | 20.0 | 22.3  | yes    |
| `rel4-held-b` as the scored run, 1 flip                                                        | 35/100 (35.0%) | 3/20 (15.0%) | 20.0 | 32.3  | yes    |
| no baseline left out on both sides, 1 flip                                                     | 35/98 (35.7%)  | 2/20 (10.0%) | 25.7 | 32.3  | yes    |
| no baseline left out on both sides, no flip                                                    | 35/98 (35.7%)  | 2/20 (10.0%) | 25.7 | 22.3  | no     |
| held-out without 2433, 2736 (bench defects) and 503 (no baseline), no flip                     | 35/100 (35.0%) | 2/17 (11.8%) | 23.2 | 23.9  | yes    |
| dev's no-effect passes as failures, held-out as scored (both its passes are result-only), flip | 22/100 (22.0%) | 0/20 (0.0%)  | 22.0 | 28.6  | yes    |
| dev's no-effect passes as failures, held-out as scored, no flip                                | 22/100 (22.0%) | 0/20 (0.0%)  | 22.0 | 18.6  | no     |
| dev's no-effect passes as failures, 2433 at its replayed pass (compares effects), no flip      | 22/100 (22.0%) | 1/20 (5.0%)  | 17.0 | 18.9  | yes    |
| both: no-effect as failures, no baseline out, held-out without 2433, 2736, 503, no flip        | 22/98 (22.4%)  | 0/17 (0.0%)  | 22.4 | 20.3  | no     |
| dev's flips counted too (2 flips: 1900 and 2433)                                               | 35/100 (35.0%) | 2/20 (10.0%) | 25.0 | 42.2  | yes    |
| dev 1900 at its `r4l-full` pass (36/100), no flip                                              | 36/100 (36.0%) | 2/20 (10.0%) | 26.0 | 22.3  | no     |
| held-out's two passes removed, 1 flip                                                          | 35/100 (35.0%) | 0/20 (0.0%)  | 35.0 | 31.8  | no     |

Every consistent reading of 2433 puts the gap inside: as the rule counts it (a flip widens the bound by 10 points), and as the bench should have measured it (its replayed pass, no flip: 20.0 against 22.3). It is over only when 2433's live-run failure is kept and its flip ignored, which counts the same defect one way and not the other. The margin is thin: inside by 2.3 points at its replayed verdict, and one held-out template is 5 points.

The no-effect reading is the sharper finding again. Both held-out passes compare only a terminal node's items, as 13 of dev's 35 do. With those passes counted as failures the gap is 17.0–22.4 points against bounds of 18.6–28.6: inside with 2433's effect-comparing pass or the flip, over without either. Round 4's eligibility rule ("compares something") admits result-only templates on purpose; the held-out set shows the loop has not yet made a template with real writes pass from outside dev, apart from 2433 on replay.

Failures by gate and bucket (`rel4-held`; `rel4-held-b` the same apart from 2433):

| gate: bucket                            | dev | held-out |
| --------------------------------------- | --- | -------- |
| 2: skill instruction (schema-invalid)   | 1   | 0        |
| 3: unmapped node (preflight)            | 44  | 9        |
| 3: runner bug (preflight failed)        | 0   | 3        |
| 3: runner bug (run time)                | 1   | 1        |
| 3: field map (tool arguments)           | 1   | 0        |
| 3: expression translation (run time)    | 0   | 1        |
| 3: fixture (baseline failed)            | 2   | 0        |
| 3: model refusal                        | 1   | 0        |
| 4: field map                            | 8   | 3        |
| 4: flaky model step                     | 1   | 0        |
| 5: field map or runner bug (malformed)  | 1   | 1        |
| 6: runner bug (allow list)              | 1   | 0        |
| 8: bench defect (no driver measurement) | 4   | 0        |

Preflight refusals: dev 45 of 65 failures, held-out 12 of 18.

Per stratum (reported, never gated): dev chat 9/28, poll 4/8, form 0/9, manual 14/28, schedule 6/23, sub-workflow 2/4; held-out chat 0/6, poll 0/2, form 0/2, manual 2/5, schedule 0/4 (1/4 in `rel4-held-b`), sub-workflow 0/1. Gaps: chat 32.1, poll 50.0, form 0.0, manual 10.0, schedule 26.1 (1.1 in `rel4-held-b`), sub-workflow 50.0 points.

Held-out passes: 2572 (manual: a CV read from a PDF and analysed by an OpenAI request over HTTP, compared as the terminal node's items), 1957 (manual: a Basic LLM Chain behind an auto-fixing output parser, compared as the terminal items with the model input checked); 2433 in `rel4-held-b` only (schedule: podcast downloads, an audio cut job, Whisper and a summary per item, one Gmail send; 6 effects compared). The claude driver passed normal and hostile on each. No template-specific rule is involved (the lint covers every corpus id).

**Converter coverage.** Dev (`convert-coverage --split dev`, 2026-11-14 clock, no model): **48 of 100** with every step supported (full 21, review 27), blocked 52, preflight clean 40, schema-invalid 1, unchanged since `r4l-full`. Held-out: `convert-coverage.mjs` refuses held-out for `--split` and runs explicit ids for release points, so the same report was made with `--ids <the 20> --corpus evals/bench/data/wf --out <scratch>` (not committed; same clock, default answers): **11 of 20** with every step supported (full 2, review 9), blocked 9, preflight clean 4, schema-invalid 0. Held-out has a higher coverage share (55%) than dev (48%) and a lower pass rate: 9 of its 11 supported templates fail, 2 at preflight on a node version the runtime does not implement (the coverage classes count only blocked steps), 1 at preflight on a URL fill that never reached the converter (P118), 6 at run time or in the comparison (kinds below).

## Held-out failures that dev already shows (expected)

A template counts under every kind its first failed gate names (sole blocker in brackets).

| kind                                                                                   | held-out templates       |
| -------------------------------------------------------------------------------------- | ------------------------ |
| vector store (an agent tool on one, a store written or searched)                       | 3 [0] — 2741, 6137, 4366 |
| database step (a MongoDB insert, a Postgres agent's SQL tools, a dedup table)          | 3 [2] — 503, 2612, 6137  |
| connector operation without a tool (a Google Docs edit in place)                       | 1 [0] — 2741             |
| model step not converted (OpenAI Assistants)                                           | 1 [1] — 2782             |
| app REST request template missing (a YouTube video update)                             | 1 [0] — 4506             |
| Edit Image (GraphicsMagick)                                                            | 1 [1] — 2416             |
| core logic node version not implemented (XML v1, a gallery lever with no dev template) | 1 [1] — 3132             |

The ranking matches dev's: vector stores and database steps first; XML v1 is one of LEVERS.md's top rows (no dev unlock).

## New kinds dev never showed (candidate blind spots)

1. **A LangChain Chat node v1 (`Respond to Chat`) is not implemented.** Two such steps in one chat template (10230, sole; it also ships pins for most of its path, P89/P97).
2. **Agent tools dev has none of:** a date-and-time tool that cannot run in the runtime, a permanent mail delete (the connector only trashes), a calendar free/busy tool whose connector schemas are not captured (4366, 3131).
3. **A poll trigger without a tool map** (RSS Feed Read trigger, 4506, with the YouTube update).
4. **A feed on plain http refused by the hosts answer.** The bench answers a data-built URL's hosts question "public" (any public https host); the RSS read's first feed is `http://`, which that answer excludes, so the run stops at run time where n8n reads it (1554, gate 3). A person can answer the host itself; the "public" answer is https only by design.
5. **A sub-workflow tool offered under another input schema.** n8n offers the tool with the inputs its called workflow declares (`videoId`); the Claude side offers the generic `input` string (2956, gate 4 `different tools offered`).
6. **A Gmail trigger's simplified message without fields n8n keeps.** The agent's prompt on the n8n side carries `payload.mimeType`, `sizeEstimate`, `historyId` and `internalDate` beside From, To and Subject; the Claude side's trigger row has only the simplified headers (2740, gate 4).
7. **A created spreadsheet's output without its sheet list.** A later Sheets append reads the new sheet's id from `sheets[0].properties.sheetId` of a create-spreadsheet step's output; the Claude side's output has no such field (4635, gate 3 at run time, `Can not get sheet 'id' with a value of 'undefined'`).
8. **A Sheets append-or-update without its match column on malformed data**: the runtime refuses (`The 'Column to Match On' parameter is required`) where n8n writes (2694, gate 5; normal and empty pass gate 4).

Release point 3's new kinds, again: a node version written as a string 0; an inline API key in a raw JSON body 0; an IMAP trigger, Compression, Move Binary Data 0; an older connector node version without a tool map 0.

## Bench defects found

- **Live-recorded per-item model calls compared by arrival index in the claude driver** (2433): in the run that records n8n's model calls, two per-item calls arrived in the other order; gates 3–7 pass in process (P76 pairs them by content), but the claude driver's gate 4 found the inputs swapped. On replay it passes. Proposal P115. It made the round's one held-out flip.
- **A driver session that declines an empty-looking prompt ends the run `needs`** (dev 1900, normal): not a P40 slip, so not retried; the same template passed on the same commit in `r4l-full`. Proposal P116.
- **Held-out fixtures written before P66 have no `db`** (503, 2612): the n8n side's database credential reaches no server; 503's canned and scored n8n runs fail at MongoDB. No verdict depends on it (both stop at preflight on their database steps). Proposal P117.
- **An overlay URL fill that carries a dummy token never reaches the converted export** (2736): P78 leaves out of the filled export a fill the converter would redact as an inline secret; here the whole URL (`…?token=bench-apify-token`) is such a fill, so the converter sees the template's placeholder text, writes an allow list of any host, asks no hosts question, and preflight refuses. Proposal P118.
- **The label file holds the redrawn-out template** (below): no label for 2694. Proposal P119.
- 2736's summarization chain asks `tiktoken.pages.dev` for its tokenizer on the n8n side, unanswered (the fixture note expects it); no verdict depends on it.

## Compared with release points 1–3

|                    | release point 1            | release point 2                        | release point 3            | release point 4                  |
| ------------------ | -------------------------- | -------------------------------------- | -------------------------- | -------------------------------- |
| commit             | 4e8a5f8                    | cbfe38d                                | ab1050b                    | 8c005e4                          |
| dev                | 9/30 (30.0%)               | 16/50 (32.0%)                          | 29/100 (29.0%)             | 35/100 (35.0%), round-4 corpus   |
| held-out           | 2/20 (10.0%)               | 3/20 (15.0%)                           | 1/20 (5.0%)                | 2/20 (10.0%); 3/20 on the repeat |
| gap                | 20.0                       | 17.0                                   | 24.0                       | 25.0                             |
| bound              | 23.4                       | 23.1                                   | 20.8                       | 32.2 (22.2 + 10.0 for 1 flip)    |
| held-out gate sum  | 71                         | 80                                     | 67                         | 77 (82 on the repeat)            |
| held-out at gate 3 | 15 (12 preflight refusals) | 15 (14 preflight refusals, 1 baseline) | 16 (16 preflight refusals) | 14 (12 preflight refusals)       |
| held-out flips     | 0                          | 0                                      | 0                          | 1 (a bench defect, P115)         |
| verdict            | inside                     | inside                                 | over (first time)          | inside; the stop does not fire   |

- **The corpus changed in round 4.** Dev is the 100 templates that meet the round-4 eligibility rule (every template workable end to end: an n8n baseline, every outside service mocked, every main-branch step under a planned feature, something to compare); 24 of round 3's dev left and 24 came in. Round 4's held-out was drawn from listing pages 5–6 under the same rule. Rates are not comparable with earlier rounds: round 3's 29 became 27 of 100 (`r4-base`) through the corpus change alone, and the loop took it to 36 (`r4l-full`); `rel4-dev` measures 35 with the one driver flip.
- Held-out stops less at preflight than before (12 of 18 failures against 16 of 19), because the eligibility rule keeps out templates whose steps no planned feature covers. More of its failures are later kinds: run-time refusals and comparisons on connector output shapes, which a fixing session cannot see from dev.

## Fixture check

No fixture fixes. The held-out n8n runs had one kind of unanswered request (2736's tokenizer download, expected by its note). 503's and 2612's fixtures lack the `db` P66 now reads (P117).

## Label check at release time

`node evals/bench/compare-labels.mjs --labels evals/bench/labels-held4.json` on HEAD, 20 labels: outcome 20/20, outcome and target 19/20, wake-up 20/20, blockers 20/20, questions 19/20, everything 18/20 (19 at round 4's setup). The label file still holds 2198, which amendment 1 redrew out of the held-out, and has no label for 2694, which came in (P119). Over the 19 current held-out templates it labels: outcome 19/19, outcome and target 18/19, wake-up 19, blockers 19, questions 18/19, everything 17/19.

- Outcome and target: 1957, the disagreement adjudicated at setup (a model step needs `sample` on the artifact surface, so a model-only manual run is a skill; the analyzer is right).
- Questions: new since setup, 1554's hosts question for its RSS read, which iteration 39 added (a feed URL that comes from data asks for its hosts at setup) after the labels were written. It asks about a real step, so it is an extra of the labels' era, not an analyzer error.
