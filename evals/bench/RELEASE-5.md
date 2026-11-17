# Release point 5 (2026-11-17)

Held-out report (PLAN Phase 6). A session that changes the skill, the converter or the runtime must not read this file (EXCLUSIONS.md). Template-identifying detail stays here; LOOP.md carries only the general failure kinds and counts.

## Setup

- Commit b0143fb (skill, converter and runtime as `r5b3-full`, which ran on 6a8f17f; b0143fb adds only its results and docs), plain `convert.mjs`, replayed model replies, in process, the claude driver for gate 8. Fresh rows, nothing carried forward: `rel5-dev` (the 120 dev templates of round 5, all with fixtures), `rel5-held` (round 5's fresh held-out, `splits.json` `heldOutFresh5`, 20 templates, explicit ids). `r5b3-full` was not reused; `rel5-dev` is compared with it below.
- `validate.mjs --ids <held-out>`: 80 fixture files, 0 failing. Held-out warnings: 11 write steps of 4498 (its other content types' publish branches, off the path every variant takes) are not in `writes`.
- Held-out setup at release time (`run.mjs --n8n-check-only` on all 20, every variant; no model, nothing saved): 77 of 80 canned runs end in success, no read goes unanswered, and no credential is missing. The three that fail are empty variants whose fixtures state the failure n8n itself raises on an empty input (a Code node's own empty-input check, and Simple Memory refusing an empty chat message twice). Nothing marked `n8nCannotRun` or `n8nFails`; no overlay, route or fixture change.
- **Recording pass** (P115's procedure): `rel5-held-rec`, a full bench run of the 20 before any scored run, recorded n8n's live model calls (35 calls over 2897, 2922, 2945, 3003, 4036, 5626 and 8487) and, because `run.mjs` has no recording-only mode, also ran the claude driver on the 8 templates that passed gates 3–7 in process (16 runs: the 7 passes and 3627, whose driver run fails) plus one Claude-side model call answered live where no recorded call matched (4036, whose baseline failed). It is not scored. Its verdicts, gates, buckets and causes equal `rel5-held`'s on all 20 (0 flips between the run that recorded live and the replay).
- Two held-out baselines failed on the stand-in model's first live draw in the recording pass, where the canned checks ran to the end: 8487 (`Generate HTML Email`: `(jobData.candidateSkills || []).join is not a function`, the extraction reply gave the skills as text) and 4036 (`AI Agent`: `Received tool input did not match expected schema`). P13 never re-draws, and a mark needs a canned check that shows n8n failing, so neither is marked; both count in n as gate-3 `fixture` failures (P134; sensitivity below).
- **One scored held-out run, not two.** The recording pass cost 52 `claude -p` against an estimate of about 20 (P135), and `rel5-held` 16 more, so a second scored run (`rel5-held-b`, about 16) did not fit the release point's cap of 2200 beside dev. Flips are counted between `rel5-held-rec` and `rel5-held` instead: the same commit, one run recording live and one replaying, as at release point 4. P115 is fixed at its cause, so the run that records no longer depends on arrival order.
- **Cap raised for `rel5-dev` only.** `rel5-dev` (ids ordered with `r5b3-full`'s 69 failures first, then its 51 passes) stopped at the cap with 117 of 120 done; the coordinator raised the cap to 2240 for `rel5-dev` alone, and the same tag resumed the last 3 (2803, 1954, 1959; 6 runs). No held-out run used the raise.
- `claude -p`: 174 runs (ledger 2032 → 2206): recording pass 52 (35 live n8n model calls, 16 claude-driver runs, 1 Claude-side model call answered live), `rel5-held` 16 (claude-driver runs), `rel5-dev` 106 (claude-driver runs; 100 under the 2200 cap, 6 under the raised cap). Haiku only, no usage limit hit. The machine stayed at 45–54% free; no bench-error rows.

## Numbers

|                              | dev (n=120) | held-out (n=20) |
| ---------------------------- | ----------- | --------------- |
| pass every gate              | 50 (41.7%)  | 7 (35.0%)       |
| gate sum                     | 705         | 108             |
| stop at gate 2               | 1           | 0               |
| stop at gate 3               | 54          | 8               |
| stop at gate 4               | 6           | 4               |
| stop at gate 5               | 1           | 1               |
| stop at gate 6               | 1           | 0               |
| stop at gate 8               | 7           | 0               |
| bench error (gate 0)         | 0           | 0               |
| connector-limited            | 2           | 0               |
| n8n cannot run               | 1           | 0               |
| n8n fails on the template    | 1           | 0               |
| passes, no effect compared   | 22          | 3               |
| flips (repeat on one commit) | 1 of 120¹   | 0 of 20²        |
| claude-driver slips (P40)    | 4 of 120³   | 0 of 16         |

¹ `rel5-dev` against `r5b3-full` (`summary.mjs --tag rel5-dev --against r5b3-full`): 1978 passed every gate and now stops at gate 3 (`runner bug: step ?: run needs`). Gates 3–7 pass in process, with the Gmail send equal to n8n's; the claude driver's sessions on normal and hostile both stopped before the send on their own judgment (the HTML has `undefined` where n8n's has it too; a coupon the session thought unwarranted) and ended `needs`, not a P40 slip (P136). Every other template has the same gate, bucket and cause.
² `rel5-held` against `rel5-held-rec` (the recording pass, same commit): same gate, bucket and cause on all 20.
³ 4969 normal and hostile slipped on both attempts (P106, `model refusal`), as in every round-5 run.

- **Round 5's two numbers out of the 120 dev templates:** one-shot **50 of 120, gate sum 705**; converter coverage **62 of 120** (full 26, review 36; blocked 58; preflight clean 47; schema-invalid 1; `convert-coverage --split dev`, unchanged since `r5b3-full`). On round 4's 100 as a subset: one-shot 43 of 100, gate sum 592; coverage 51.
- **Gap:** 41.7 − 35.0 = **6.7 points**.
- **Bound:** pooled p = 57/140 = 40.7%; 1.96 · sqrt(p(1 − p)(1/120 + 1/20)) = **23.3 points**, + 2 × 0 held-out flips (`summary.mjs --release rel5-dev rel5-held --flips 0`).
- **Verdict: inside the bound.** Release point 4 was inside too (25.0 against 32.2), so the overfitting rule (over the bound at two release points in a row) **does not fire**, and nothing is pending from this release point toward it.
- **Without the templates that have no baseline** (`n8nCannotRun` and `n8nFails`, dev 2271 and 4846; held-out none marked): dev 50 of 118 (42.4%), held-out 7 of 20, gap 7.4 against 23.3, inside.

**Sensitivity.** Rows that rest on bench defects, on baselines n8n cannot give, or on passes that compare no effect:

- Held-out: 3003 stops at gate 4 on fixture times filled at two instants (P132), its later gates unmeasured; 8487 and 4036 have no baseline from the stand-in's first live draw (P134). A fourth, 3809, also differs on a random number in a write (P133), but it differs on a second write too, so it stays a failure in every variant. Three of the seven held-out passes compare no effect: 2922 a terminal node's items (with 5 model inputs checked), 5626 and 2897 the chat reply.
- Dev: 22 of the 50 passes compare no effect (16 reply-only, 6 result-only, P50); 2 templates have no baseline (2271 cannot run, 4846 fails on its own configuration); 2722 and 2740 are connector-limited; 1978 lost its pass to the driver (P136).

| variant                                                                          | dev            | held-out     | gap  | bound | inside |
| -------------------------------------------------------------------------------- | -------------- | ------------ | ---- | ----- | ------ |
| as scored (`rel5-held`, 0 flips)                                                 | 50/120 (41.7%) | 7/20 (35.0%) | 6.7  | 23.3  | yes    |
| no baseline left out (dev 2271, 4846; held-out none marked)                      | 50/118 (42.4%) | 7/20 (35.0%) | 7.4  | 23.3  | yes    |
| also 8487 and 4036 as no baseline                                                | 50/118 (42.4%) | 7/18 (38.9%) | 3.5  | 24.5  | yes    |
| held-out without 3003 (P132), 8487 and 4036 (P134)                               | 50/120 (41.7%) | 7/17 (41.2%) | 0.5  | 25.0  | yes    |
| both of the above                                                                | 50/118 (42.4%) | 7/17 (41.2%) | 1.2  | 25.1  | yes    |
| no-effect passes as failures on both sides                                       | 28/120 (23.3%) | 4/20 (20.0%) | 3.3  | 19.9  | yes    |
| no-effect passes as failures, no baseline out, held-out without 3003, 8487, 4036 | 28/118 (23.7%) | 4/17 (23.5%) | 0.2  | 21.6  | yes    |
| dev 1978 at its `r5b3-full` pass                                                 | 51/120 (42.5%) | 7/20 (35.0%) | 7.5  | 23.3  | yes    |
| dev's flip counted in the bound (1 flip)                                         | 50/120 (41.7%) | 7/20 (35.0%) | 6.7  | 33.3  | yes    |
| held-out's three no-effect passes removed, dev as scored                         | 50/120 (41.7%) | 4/20 (20.0%) | 21.7 | 20.6  | no     |

Every reading that treats both sides alike is inside, most by a wide margin. The one reading that is over counts held-out's no-effect passes as failures while keeping dev's 22 (21.7 against 20.6): it is not a consistent reading, and is listed because it shows the margin rests partly on reply- and result-only passes on both sides. Four of the seven held-out passes compare real writes (2945: 2 writes and 8 model inputs; 3701, 4498: 2 writes each; 683: 1 write), against 0 at release point 4's first run.

Failures by gate and bucket:

| gate: bucket                            | dev | held-out |
| --------------------------------------- | --- | -------- |
| 2: skill instruction (schema-invalid)   | 1   | 0        |
| 3: unmapped node (preflight)            | 46  | 3        |
| 3: runner bug (preflight failed)        | 1   | 0        |
| 3: runner bug (run time)                | 3   | 3        |
| 3: field map (tool arguments)           | 1   | 0        |
| 3: fixture (baseline failed)            | 2   | 2        |
| 3: model refusal                        | 1   | 0        |
| 4: field map                            | 6   | 4        |
| 5: field map (malformed)                | 1   | 1        |
| 6: runner bug (allow list)              | 1   | 0        |
| 8: bench defect (no driver measurement) | 7   | 0        |

Preflight refusals: dev 48 of 70 failures, held-out 3 of 13 (12 of 18 at release point 4, 16 of 19 at release point 3).

Per stratum (reported, never gated): dev chat 16/34, poll 4/10, form 0/11, manual 17/33, schedule 11/27, sub-workflow 2/5; held-out chat 2/6, poll 1/2, form 0/2, manual 2/5, schedule 1/4, sub-workflow 1/1. Gaps: chat 13.7, poll −10.0, form 0.0, manual 11.5, schedule 15.7, sub-workflow −60.0 points.

Held-out passes: 2922 (sub-workflow: a hallucination check by a local model, terminal items and 5 model inputs), 2945 (manual: keywords read from a sheet and classified by a model, written back; 2 writes), 3701 (poll: a scrape cleaned and saved to Sheets, emailed as CSV; 2 writes), 4498 (manual: Instagram publishing through the Graph API; 2 writes), 683 (schedule: a meme sent to Discord; 1 write), 5626 and 2897 (chat: an image generator and an OpenRouter chat, the reply). The claude driver passed normal and hostile on each. No template-specific rule is involved (the lint covers every corpus id).

**Converter coverage.** Dev: **62 of 120** with every step supported (above). Held-out: `convert-coverage.mjs` refuses held-out for `--split` and runs explicit ids for release points, so the same report was made with `--ids <the 20> --corpus evals/bench/data/wf --out <scratch>` (not committed; same clock, default answers): **16 of 20** with every step supported (full 8, review 8), blocked 4, preflight clean 13, schema-invalid 0. Held-out's coverage share (80%) is higher than dev's (52%) and its pass rate lower; 9 of its 16 supported templates fail, all at run time or in the comparison (kinds below), none at preflight.

## Held-out failures that dev already shows (expected)

A template counts under every kind its first failed gate names (sole blocker in brackets).

| kind                                                                                       | held-out templates       |
| ------------------------------------------------------------------------------------------ | ------------------------ |
| app REST request template missing (Airtable record create, Discord channel create)         | 3 [3] — 3200, 3027, 4022 |
| a plain-http address under the "public https hosts" answer (the template writes `http://`) | 2 [2] — 3880, 2276       |
| an inline API key redacted to a marker, here in a header the task driver cannot send       | 1 [1] — 3627             |
| a Drive file created through the connector without the fields a later step reads           | 1 [1] — 3710             |
| different writes on malformed input (gate 5)                                               | 1 [1] — 2023             |

All five are kinds dev ranks or release point 4 named: request templates are a LEVERS family, the plain-http refusal is release point 4's new kind 4 (a design choice: the "public" answer is https only), the redacted inline key is release point 3's, and the Drive create's missing fields are a review flag the converter already prints.

## New kinds dev never showed (candidate blind spots)

1. **A Drive trigger's file item without `name`.** The mail step reads the new file's `name`; the Claude side's trigger row lacks it (1283, gate 4 `different fields`).
2. **A raw JSON body that n8n sends decoded and the Claude side as text.** An HTTP Request with `contentType: raw`, `rawContentType: JSON` and a body built in an expression: n8n's request is compared as a JSON object, the Claude side's as the JSON text (3809, gate 4). Whether the Claude side sends the JSON content type, or the comparer should decode its text, is not checked here.

Release point 4's new kinds, again: the LangChain Chat node v1 0; agent tools for time, mail delete, calendar free/busy 0; a sub-workflow tool's declared inputs 0; a Gmail trigger's simple output 0; a created spreadsheet's sheet list 0; a match column on malformed data 0; a feed on plain http under the "public" answer 2 (both from the template's own `http://` addresses).

## Bench defects found

- **Relative fixture times filled at two instants** (3003): the n8n side fills `{{bench.now-1d}}` just before its run, the Claude side from n8n's `startedAt` a fraction of a second later; masking covers only timestamps near `startedAt`, so a day-old item date differs by 356 ms on every run. No dev fixture uses the tokens, so only held-out is exposed. Proposal P132.
- **A random number in a write** (3809): `Math.random()` in an HTTP body field can never compare equal; no verdict depends on it today. Proposal P133.
- **Baselines that fail on the stand-in's first live draw** (8487, 4036): neither marked nor re-drawn. Proposal P134.
- **The recording pass runs the claude driver** (16 of its 52 runs), which pushed the second scored held-out run past the cap. Proposal P135.
- **A driver session that declines a send step** (dev 1978): the round's one dev flip. Proposal P136.

## Compared with release points 1–4

|                    | release point 1            | release point 2                        | release point 3            | release point 4                  | release point 5                         |
| ------------------ | -------------------------- | -------------------------------------- | -------------------------- | -------------------------------- | --------------------------------------- |
| commit             | 4e8a5f8                    | cbfe38d                                | ab1050b                    | 8c005e4                          | b0143fb                                 |
| dev                | 9/30 (30.0%)               | 16/50 (32.0%)                          | 29/100 (29.0%)             | 35/100 (35.0%), round-4 corpus   | 50/120 (41.7%); round 4's 100: 43       |
| held-out           | 2/20 (10.0%)               | 3/20 (15.0%)                           | 1/20 (5.0%)                | 2/20 (10.0%); 3/20 on the repeat | 7/20 (35.0%), same on the recording run |
| gap                | 20.0                       | 17.0                                   | 24.0                       | 25.0                             | 6.7                                     |
| bound              | 23.4                       | 23.1                                   | 20.8                       | 32.2 (22.2 + 10.0 for 1 flip)    | 23.3                                    |
| held-out gate sum  | 71                         | 80                                     | 67                         | 77 (82 on the repeat)            | 108                                     |
| held-out at gate 3 | 15 (12 preflight refusals) | 15 (14 preflight refusals, 1 baseline) | 16 (16 preflight refusals) | 14 (12 preflight refusals)       | 8 (3 preflight refusals, 2 baselines)   |
| held-out flips     | 0                          | 0                                      | 0                          | 1 (a bench defect, P115)         | 0                                       |
| verdict            | inside                     | inside                                 | over (first time)          | inside; the stop does not fire   | inside; the stop does not fire          |

- Round 5's dev is round 4's 100 plus round 4's scored held-out (20); the corpus rule is round 4's, so rounds 4 and 5 compare, and neither compares with rounds 1–3.
- Held-out moved from preflight to run time: 3 of 13 failures are preflight refusals, against 12 of 18 at release point 4. Round 5's levers (XML, Postgres, the SerpAPI tool, sub-workflow tool schemas, Sheets over REST) do not appear in this held-out set, which has no database or vector-store node; its stops are request templates, hosts answers, connector shapes and three bench defects.

## Fixture check

No fixture fixes. The canned checks left no read unanswered.

## Label check at release time

`node evals/bench/compare-labels.mjs --labels evals/bench/labels-held5.json` on HEAD, 20 labels, all current held-out: outcome 20/20, outcome and target 20/20, wake-up 20/20, blockers 20/20, questions 20/20, everything 20/20, as at setup. Batch 2 moved the Postgres node's steps to local tasks (a database question per credential and a `db-client` requirement) after the labels were written; no held-out template has a Postgres or other database node, so no disagreement comes from it.
