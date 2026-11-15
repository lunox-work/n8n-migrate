# Release point 2 (2026-11-15)

Held-out report (PLAN Phase 6). A session that changes the skill, the converter or the runtime must not read this file (EXCLUSIONS.md). Template-identifying detail stays here; LOOP.md carries only the general failure kinds and counts.

## Setup

- Commit cbfe38d (skill, converter and runtime unchanged since a56011c, the commit of `r2-h-full`; the two setup commits touch held-out fixtures only), plain `convert.mjs`, replayed model replies, in process, the claude driver for gate 8. Fresh rows, nothing carried forward: `rel2-dev` (the 50 dev fixture templates of round 2), `rel2-held` (held-out 21–40, explicit ids), `rel2-held-b` (repeat of held-out on the same commit). `r2-h-full` was not reused; `rel2-dev` matches it row for row (below).
- `validate.mjs`: 280 fixture files, 0 failing. Held-out warnings: sub-workflow tool and Execute Workflow steps neither fed nor listed (2006, 2026, 2085, 2878), which n8n runs as child executions (P20).
- Held-out setup at release time:
  - Overlays: none added. The blind fixture session had written them (placeholder fills for 1938, 2872, 2894, 3085; time compression for 1992 and 2557, flagged in the rows).
  - Model routing: none needed. Every held-out model node is already answered by the shim (P18 routed the Hugging Face inference and OpenAI completion types these fixtures use).
  - `expect.n8nCannotRun` on 1992 (commit cd7939d): a Python Code node on its main path, and the bench image has no Python runner (`evals/n8n/container.mjs`; n8n's error: `This instance disallows Python execution`).
  - `expect.n8nCannotRun` on 2320 (commit cbfe38d): its completion model node names a chat model, and the image's LangChain refuses that in the completion class (`"gpt-3.5-turbo-1106", is a chat model and not a text-in/text-out LLM`, n8n's node error, before any model call). Found in the first pass (below).
  - 2324 runs with `--n8n-check normal` in `rel2-held` and `rel2-held-b`: its malformed fixture has a route whose URL cannot be parsed, which crashed the canned n8n check (P48). The verdict comes from preflight either way.
  - No fixture fixes: every held-out n8n run had no unanswered service request.
- First pass `rel2-held-setup` (commit cd7939d, 20 rows, renamed from `rel2-held` in `evals/results.jsonl` so that `rel2-held` names the scored run): it recorded the live n8n model calls and found the 2324 crash (a gate-0 bench error) and 2320's refused model. Apart from 2324, its verdicts, gates, buckets and causes equal `rel2-held`'s.
- `claude -p`: 62 runs (ledger 609 → 671; budget 110): first pass 17 (11 live n8n model calls, 6 claude-driver), `rel2-held` 6, `rel2-held-b` 6, `rel2-dev` 33 (32 claude-driver plus one slip retry). Haiku only, no usage limit hit. The claude driver's memory gate stopped our n8n container 3 times on held-out runs and 8 times on dev (the accepted `bench-seq.sh` workaround); no bench-error rows in the scored runs. Containers stopped after.

## Numbers

|                              | dev (n=50) | held-out (n=20) |
| ---------------------------- | ---------- | --------------- |
| pass every gate              | 16 (32.0%) | 3 (15.0%)       |
| gate sum                     | 251        | 80              |
| stop at gate 3               | 29         | 15              |
| stop at gate 4               | 5          | 2               |
| bench error (gate 0)         | 0          | 0               |
| connector-limited            | 0          | 0               |
| n8n cannot run               | 0          | 2               |
| time compression             | 4          | 2               |
| flips (repeat on one commit) | 0 of 50¹   | 0 of 20         |
| claude-driver slips (P40)    | 1 of 33    | 0 of 6          |

¹ `rel2-dev` against `r2-h-full` (same skill, converter and runtime): every one of the 50 templates has the same gate, bucket and cause.

- **Gap:** 32.0 − 15.0 = **17.0 points**.
- **Bound:** pooled p = 19/70 = 27.1%; 1.96 · sqrt(p(1 − p)(1/50 + 1/20)) = **23.1 points**, + 2 × 0 flips = 23.1 (`summary.mjs --release rel2-dev rel2-held --round 2`). The flips term is 0: no held-out verdict, gate, bucket or cause changed between `rel2-held` and `rel2-held-b`.
- **Verdict:** the gap is inside the bound. Release point 1 was inside too (20.0 against 23.4), so the overfitting rule (over the bound at two release points in a row) does not fire. Reported only.
- **One-shot success without the templates n8n cannot run:** held-out 3 of 18 (16.7%), dev unchanged (gap 15.3, bound 24.2).

**Sensitivity.** Rows that rest on bench defects or on baselines n8n cannot give:

- Held-out: 2320 (n8n cannot run; its Claude side passed gate 3 in process, gates 4–8 unmeasured) says nothing about the migration; 890's pass compares no effect (no write, no reply, no network on either side, P50). 1992 also cannot run in n8n, but its Claude side stops at preflight on its own blockers, so its failure stands.
- Dev: 2271 (stand-in baseline) and 1826 (the template's own wiring fails in n8n, P45) are baselines n8n cannot give; 2614 (n8n's resumable Drive upload, P46) and 1900 (an effect the comparer table does not cover) are comparer gaps; 1747 and 2473 pass with no compared effect (release point 1 noted them).

| variant                                                               | dev           | held-out     | gap  | bound |
| --------------------------------------------------------------------- | ------------- | ------------ | ---- | ----- |
| as scored                                                             | 16/50 (32.0%) | 3/20 (15.0%) | 17.0 | 23.1  |
| held-out only: drop 2320, 890 a failure                               | 16/50 (32.0%) | 2/19 (10.5%) | 21.5 | 23.2  |
| both: drop the unmeasurable rows, no-effect passes as failures        | 14/46 (30.4%) | 2/19 (10.5%) | 19.9 | 23.0  |
| held-out 2320 counted as a pass (its Claude side ran clean to gate 3) | 16/50 (32.0%) | 4/20 (20.0%) | 12.0 | 23.4  |

The gap stays inside the bound in every variant; the closest is 21.5 against 23.2, when only the held-out side is corrected. Dropping dev's two rows that rest on assumed connector shapes as well (4722, 2415, P1) leaves dev at 14/44 (31.8%).

Failures by gate and bucket:

| gate: bucket                     | dev | held-out |
| -------------------------------- | --- | -------- |
| 3: unmapped node (preflight)     | 23  | 12       |
| 3: runner bug (preflight failed) | 3   | 2        |
| 3: fixture (baseline failed)     | 2   | 1        |
| 3: expression translation        | 1   | 0        |
| 4: field map                     | 4   | 2        |
| 4: bench defect                  | 1   | 0        |

Per stratum (reported, never gated): dev chat 5/14, poll 2/7, form 0/6, manual 4/12, schedule 4/9, other 1/2; held-out chat 1/8, poll 0/2, form 0/1, manual 2/5, schedule 0/2, other 0/2.

Held-out passes: 2552 (manual: page fetch over HTTP, an information extractor, Sheets append), 2384 (chat: a model chain), 890 (manual: a CSV read from local disk and parsed, through the files lever of iteration 19; no compared effect). One of the three (890) runs only because of a round-2 fix (the files lever); no template-specific rule is involved (the lint covers every corpus id).

## Held-out failures that dev already shows (expected)

A template counts under every kind its first failed gate names (sole blocker in brackets).

| kind                                                                                                 | held-out templates                               |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| app REST request template missing (incl. an agent tool whose app has none)                           | 7 [5] — 1992, 2557, 1938, 2026, 3085, 2324, 1959 |
| connector operation without a tool map (incl. a connector not attached, editing a document in place) | 4 [2] — 1992, 2786, 2894, 2872                   |
| core logic node version not implemented                                                              | 3 [1] — 1748, 2006, 2878                         |
| request URL built at run time                                                                        | 2 [0] — 2557, 2006                               |
| vector store                                                                                         | 1 [1] — 1960                                     |
| media through the original provider                                                                  | 1 [0] — 2894                                     |
| file path built at run time (files lever)                                                            | 1 [0] — 2894                                     |
| forms that wait for a person                                                                         | 1 [0] — 2878                                     |
| connector write left without its required arguments                                                  | 1 [0] — 2878                                     |

The core-logic-node kind was release point 1's new kind 2 and is still unaddressed; here it is the only blocker of one template (an HTML extraction node version), and a Markdown node version blocks two more. The rest are the dev levers ranked in LOOP.md (REST templates, tool maps, vector stores, media, run-time URLs, forms).

## New kinds dev never showed (candidate blind spots)

1. **Sub-workflow tool names.** An agent tool that calls a sub-workflow is offered to the model under the name the author typed in the tool; the Claude side offers a name made from the node's name, so the tool list differs (gate 4, `different tools offered`; 1 template). Iteration 17 carried n8n's tool names for other tool kinds, not this one.
2. **Prompt of a text-completion model.** For a chain fed by a text-completion (non-chat) model, n8n sends only the user's text and leaves the chain's system message out; the Claude side sends the system message, so the replayed model input differs (gate 4; 1 template).
3. **A baseline the current n8n cannot give.** The template's model configuration is refused by the n8n image's own LangChain before any call (1 template, the only failure there, Claude side clean through gate 3), and a Python Code node with no runner (1 template, also blocked on the Claude side). Release point 1's baseline failures came from stand-in draws, not from the template.
4. **Python Code node.** Preflight flags a Python Code node for translation (review, not a block; 1 template, behind other blockers). No dev fixture template has one on its main path.

Release point 1's new kinds, again: refused at run time after a clean preflight 0; core logic node 3; URL built at run time 2; connector write without arguments 1; untranslated expression 0; JSON-looking model text 0; agent iteration cap 0.

## Bench defects found

- **Unparsable route URL** (2324): a malformed fixture's route with a space in its host crashes `routesOf()`; `validate.mjs` passes it. Run with `--n8n-check normal`. Proposal P48.
- **Baselines n8n cannot give** (1992, 2320) marked `n8nCannotRun`, and **2878's form fixture predates P20** (no `formPages`, so n8n parks at the first page; the Claude side refuses forms that wait anyway). 2894's canned n8n check fails on n8n's file restriction for its relative download path (`EACCES … /proc/self/fd/40/…`); its Claude side stops at preflight. Proposal P49.
- **A pass with no compared effect** (890; dev 1747 and 2473). Proposal P50.
- **Held-out in the survey corpus.** `evals/survey/data/wf` holds 17 of the 20 held-out templates, and the default `convert-coverage.mjs` run (and the aggregate `evals/convert-coverage.md` of 2026-11-14) read that folder. No log shows a fixing session reading held-out content, and the aggregate report lists blocker reasons that dev also shows, but the channel exists. Proposal P51; the round-3 held-out plan (PLAN Phase 6) avoids it.
- **The claude driver's memory gate** again waited for 40% free with our n8n container up (machine at 17–46% free during the runs); `bench-seq.sh` stopped the container and resumed the claude-driver part alone each time.

## Compared with release point 1

|                    | release point 1            | release point 2                        |
| ------------------ | -------------------------- | -------------------------------------- |
| commit             | 4e8a5f8                    | cbfe38d                                |
| dev                | 9/30 (30.0%)               | 16/50 (32.0%)                          |
| held-out           | 2/20 (10.0%)               | 3/20 (15.0%)                           |
| gap                | 20.0                       | 17.0                                   |
| bound              | 23.4                       | 23.1                                   |
| held-out gate sum  | 71                         | 80                                     |
| held-out at gate 3 | 15 (12 preflight refusals) | 15 (14 preflight refusals, 1 baseline) |
| held-out flips     | 0                          | 0                                      |
| verdict            | inside                     | inside                                 |

- Dev went from 9 of 30 to 16 of 50: 10 of the 30 seeded dev templates pass (9 at release point 1) and 6 of the 20 promoted from release point 1's held-out (2 passed there), which fixing sessions could read from round 2. Held-out rose from 2 to 3 of 20 on a fresh set. The gap narrowed by 3 points, well within noise (one held-out template is 5 points).
- Held-out still stops mostly at preflight (14 of 20 refusals, against 12 at release point 1), on the same I/O levers dev ranks first: app REST request templates and connector tool maps. No template of this set is refused at run time after a clean preflight (2 at release point 1); the gate-4 failures moved from model-step differences on bench defects to two converter differences in what the model is offered (tool names, a completion prompt).
- The bench got stricter between the two points (P15–P47): agent tool turns, tool definitions, descriptions, model calls over HTTP and disk writes are now compared. One of the two held-out gate-4 failures (tool names) is caught by a check added after release point 1 (P28); the other (a completion prompt) by the model-input check release point 1 already had.

## Fixture check

No fixture fixes. No held-out n8n run had an unanswered service request. Unused routes are on paths that stopped earlier (preflight-stopped templates get canned n8n checks only, 2878 parks at its first form page).

## Restated under P50 (2026-11-15, round 3 setup)

P50 (commit 4d1932e) stops counting a pass that compared nothing: no write, media call, disk write or reply on either side and no checked model input. Two rows of this release point were such passes, classed from their n8n recordings: 1747 (dev) and 890 (held-out; manual trigger, a CSV read, nothing written). Restated: **dev 15 of 50, held-out 2 of 20, gap 20.0 points, bound 22.2: inside** (`node evals/bench/summary.mjs --release rel2-dev rel2-held --round 2`). Passes that compared no effect but count: dev 2777, 2413, 6270, 2729, 2703 (reply), 2473 (model inputs); held-out 2384 (reply). Without the two templates n8n cannot run (P49, left out of n and passes): held-out 2 of 18, gap 18.9, bound 23.3, inside. The headline above, the README and the hero keep the numbers as scored.
