# Release point 3 (2026-11-15)

Held-out report (PLAN Phase 6). A session that changes the skill, the converter or the runtime must not read this file (EXCLUSIONS.md). Template-identifying detail stays here; LOOP.md carries only the general failure kinds and counts.

## Setup

- Commit ab1050b (skill, converter and runtime unchanged since a3043e1, the commit of `r3g-full`; e378780 adds results and docs, ab1050b marks one held-out fixture), plain `convert.mjs`, replayed model replies, in process, the claude driver for gate 8. Fresh rows, nothing carried forward: `rel3-dev` (the 100 dev templates of round 3, all with fixtures), `rel3-held` (round 3's fresh held-out, 20 templates, explicit ids), `rel3-held-b` (repeat of held-out on the same commit). `r3g-full` was not reused; `rel3-dev` is compared with it below.
- `validate.mjs --ids <held-out>`: 80 fixture files, 0 failing (all 400 files: 0 failing). Held-out warnings: an in-memory vector store tool (5010), a vector store tool (2705) and a self-called Execute Workflow step (2374) are neither fed nor listed, in every variant.
- Held-out setup at release time:
  - Overlays: none added. The blind fixture session had written placeholder fills for 1150, 2537 and 3169 (no time compression).
  - Model routing: none needed.
  - `expect.n8nFails` on 4968 (commit ab1050b; P54 left it for this release point): the canned check fails at LinkedIn, `The Text field is empty. Enter text to publish the post.`, on the normal, empty and hostile variants (the malformed one stops earlier at the OpenAI image node on its 400). The row reads `confirmed: true`.
  - 2883 **not** marked: the fixture expected n8n to stop at its SerpAPI request on the template's `$credentials` expression, but the canned normal and hostile runs succeed (empty and malformed fail on their data, as their branches say). Its `offline` note is wrong on this point (P54's evidence was derived from the source, not a run).
  - `expect.n8nCannotRun`, written by the blind session and confirmed by the canned checks: 1150 (n8n's internal REST API on localhost answers 401: `Get Workflow List`, every variant), 2537 (three Send Email nodes without sender or recipient: n8n refuses to start, `3 nodes have issues`, every variant; no SMTP sidecar either), 2374 (the Python Code node: `This instance disallows Python execution`, normal and hostile; empty never reaches it, malformed stops at Hacker News on its 404).
  - 3169 runs with `--no-n8n-check` in `rel3-held` and `rel3-held-b`: its canned n8n check gets the n8n container killed by the 1 GiB memory cap (`OOMKilled: true`) about 70 s in, twice (`rel3-held-setup`, `rel3-held-setup2`), and the next template's run then finds the container stopped (P83). Its verdict comes from preflight either way.
  - No fixture fixes.
- First passes `rel3-held-setup` (commit e378780, 20 rows) and `rel3-held-setup2` (3169 and 2374 again): they recorded the live n8n model calls (2768, 3314), ran the canned checks that confirmed 4968's failure and refuted 2883's, and found the OOM kill. Apart from the two bench-error rows (3169, 2374), their verdicts, gates, buckets and causes equal `rel3-held`'s.
- `claude -p`: 68 runs (ledger 959 → 1027; budget 130): `rel3-held-setup` 5 (3 live n8n model calls for 2768 and 3314, 2 claude-driver runs for 2824), `rel3-held` 2, `rel3-held-b` 2, `rel3-dev` 59 (claude-driver gate-8 runs, one slip retry included). Haiku only, no usage limit hit. The claude driver's memory gate never waited (the machine stayed at 63–79% free); no bench-error rows in the scored runs. Containers stopped after.

## Numbers

|                              | dev (n=100) | held-out (n=20) |
| ---------------------------- | ----------- | --------------- |
| pass every gate              | 29 (29.0%)  | 1 (5.0%)        |
| gate sum                     | 494         | 67              |
| stop at gate 2               | 0           | 1               |
| stop at gate 3               | 60          | 16              |
| stop at gate 4               | 8           | 2               |
| stop at gate 5               | 1           | 0               |
| stop at gate 8               | 2           | 0               |
| bench error (gate 0)         | 0           | 0               |
| connector-limited            | 1           | 0               |
| n8n cannot run               | 8           | 3               |
| n8n fails on the template    | 4           | 1               |
| passes, no effect compared   | 12          | 0               |
| flips (repeat on one commit) | 0 of 100¹   | 0 of 20         |
| claude-driver slips (P40)    | 2 of 63²    | 0 of 4          |

¹ `rel3-dev` against `r3g-full` (same skill, converter and runtime): every one of the 100 templates has the same gate, bucket and cause (`summary.mjs --tag rel3-dev --against r3g-full`: 0 flips).
² 2197 hostile slipped on both attempts (the session would not answer a model step whose input carried the hostile instruction, and ended); a repeated slip stands as the verdict, and 2197 passes every gate as it did in `r3g-full`, so it is no flip.

- **Gap:** 29.0 − 5.0 = **24.0 points**.
- **Bound:** pooled p = 30/120 = 25.0%; 1.96 · sqrt(p(1 − p)(1/100 + 1/20)) = **20.8 points**, + 2 × 0 flips = 20.8 (`summary.mjs --release rel3-dev rel3-held`). The flips term is 0: no held-out verdict, gate, bucket or cause changed between `rel3-held` and `rel3-held-b`.
- **Verdict: over the bound**, for the first time. Release points 1 (20.0 against 23.4) and 2 (17.0 against 23.1; restated under P50, 20.0 against 22.2) were inside, so the overfitting rule (over the bound at two release points in a row) does not fire yet. If release point 4 is over its bound too, the loop stops for review.
- **Without the templates that have no baseline** (`n8nCannotRun` and `n8nFails`, left out of n and passes on both sides): dev 29 of 88 (33.0%), held-out 1 of 16 (6.3%), gap 26.7 against a bound of 24.1: over as well.

**Sensitivity.** Rows that rest on bench defects, on baselines n8n cannot give, or on passes that compare no effect:

- Held-out: 1150, 2537, 2374 (n8n cannot run) and 4968 (n8n fails on the template) have no baseline; 3314 fails gate 4 on a bench difference (P84: the bench's hosts add no transport headers, which its prompt quotes), so its later gates are unmeasured. No held-out pass rests on a missing effect: 2824 compares its one HTTP write.
- Dev: 12 of the 29 passes compare no effect (9 reply-only, 3 result-only, P50); 12 templates have no baseline (8 cannot run, 4 fail on their own configuration); 2722 is connector-limited; 4722 and 2415 fail on assumed connector shapes (P1).

| variant                                                                              | dev            | held-out     | gap  | bound | inside |
| ------------------------------------------------------------------------------------ | -------------- | ------------ | ---- | ----- | ------ |
| as scored                                                                            | 29/100 (29.0%) | 1/20 (5.0%)  | 24.0 | 20.8  | no     |
| no baseline left out on both sides                                                   | 29/88 (33.0%)  | 1/16 (6.3%)  | 26.7 | 24.1  | no     |
| held-out only: drop the 4 rows without a baseline and 3314 (P84)                     | 29/100 (29.0%) | 1/15 (6.7%)  | 22.3 | 23.8  | yes    |
| held-out 3314 counted as a pass                                                      | 29/100 (29.0%) | 2/20 (10.0%) | 19.0 | 21.0  | yes    |
| dev's no-effect passes counted as failures                                           | 17/100 (17.0%) | 1/20 (5.0%)  | 12.0 | 17.1  | yes    |
| both: no baseline dropped, dev's no-effect passes as failures, held-out without 3314 | 17/88 (19.3%)  | 1/15 (6.7%)  | 12.7 | 20.8  | yes    |
| held-out's one pass removed                                                          | 29/100 (29.0%) | 0/20 (0.0%)  | 29.0 | 20.6  | no     |

The verdict turns on single templates: one held-out template is 5 points, and the held-out side has one pass. It is over as scored and with the no-baseline rows left out; inside when the held-out bench defect is set aside, and well inside once dev's no-effect passes stop counting. That last variant names the sharpest finding: 12 of dev's 29 passes compare only a reply or a terminal node's items, while held-out has no such pass, so part of the gap is that dev's chat and manual templates pass on a reply the loop learned to reproduce, and held-out's templates of the same kinds stop earlier on levers.

Failures by gate and bucket:

| gate: bucket                            | dev | held-out |
| --------------------------------------- | --- | -------- |
| 2: skill instruction (no definition)    | 0   | 1        |
| 3: unmapped node (preflight or run)     | 51  | 13       |
| 3: runner bug (preflight failed or run) | 4   | 2        |
| 3: field map (tool arguments)           | 0   | 1        |
| 3: fixture (baseline failed)            | 4   | 0        |
| 3: expression translation               | 1   | 0        |
| 4: field map                            | 8   | 2        |
| 5: field map                            | 1   | 0        |
| 8: bench defect (no driver measurement) | 2   | 0        |

Preflight refusals: dev 52 of 71 failures, held-out 16 of 19.

Per stratum (reported, never gated): dev chat 9/29, poll 4/10, form 0/9, manual 7/25, schedule 6/21, relay 2/2, sub-workflow 1/4; held-out chat 0/6, poll 0/2, form 0/2, manual 1/5, schedule 0/4, sub-workflow 0/1.

Held-out pass: 2824 (manual: two Set nodes and a Perplexity request over HTTP with the person's key, compared as an HTTP write; the claude driver passed normal and hostile). No template-specific rule is involved (the lint covers every corpus id); whether it needed a round-3 fix was not checked.

Converter coverage on the held-out (`convert-coverage.mjs --ids`, HEAD): full 1, review 5, blocked 14, schema-invalid 1, preflight clean 3. Dev (round 3, unchanged since `r3g-full`): full 15, review 32, blocked 53, preflight clean 41.

## Held-out failures that dev already shows (expected)

A template counts under every kind its first failed gate names (sole blocker in brackets).

| kind                                                                                   | held-out templates                   |
| -------------------------------------------------------------------------------------- | ------------------------------------ |
| app REST request template missing (LinkedIn post, Hacker News, a Wikipedia agent tool) | 5 [2] — 4968, 2883, 2288, 3082, 2374 |
| vector store (an agent tool on one, in-memory or Pinecone)                             | 3 [2] — 5010, 2705, 2374             |
| core logic node version not implemented (Markdown v1, Merge v1, HTTP Request v1)       | 3 [1] — 2648, 3169, 1150             |
| connector operation without a tool map (Drive upload in node v1/v2, Notion block list) | 3 [1] — 1897, 1150, 2288             |
| model step not converted (OpenAI Assistants)                                           | 2 [1] — 2201, 2288                   |
| connector write left without its required arguments (Notion create and query)          | 2 [1] — 2354, 2288                   |
| request URL built at run time outside an HTTP Request step (RSS Read)                  | 1 [1] — 2799                         |
| SMTP send (substitution to a mail connector; also `n8nCannotRun`)                      | 1 [1] — 2537                         |
| forms that wait for a person                                                           | 1 [0] — 3082                         |

Not blocking: a Python Code node flagged for translation (2374, behind other blockers). The ranking matches dev's: REST request templates, vector stores, logic node versions and tool maps first.

## New kinds dev never showed (candidate blind spots)

1. **A node version written as a string.** One export stores a Set node's `typeVersion` as `"3.4"`; the converter copies it, its definition fails the schema (`$.steps.…n8n.typeVersion: string is not number`) and no folder is written, so the template stops at gate 2 (`refused: subscription …`, bucket skill instruction). n8n reads the string as the number. 1 template (4028).
2. **An API key written inline in a raw JSON body.** A Tavily request carries the template's placeholder key inside its JSON body text; the converter redacts the inline key to a marker (`«redacted named-param …»`) and the request sends the marker and the body as text, where n8n sends the parsed object with the key (gate 4, `different fields`). With a real key the request would fail. 1 template (2768).
3. **Blocked nodes dev has none of:** an IMAP trigger (offered as a substitution to the Gmail connector's poll, but blocked as written; 3169, with Markdown v1), the Compression node (2292, sole), Move Binary Data (1150).
4. **A connector operation dev maps in its current node version but not in an older one** (Drive upload in node v1 and v2; dev's v3 upload maps): 2 templates (1897 sole, 1150).
5. **A model prompt quoting a whole HTTP response's headers** differs on the transport headers (3314, gate 4). This is the bench's own difference (P84), not a migration failure; the template's later gates are unmeasured.

Release point 2's new kinds, again: sub-workflow tool names 0 (fixed in iteration 21); a text-completion model's prompt 0 (fixed in iteration 23); baselines the n8n image cannot give 3 (n8n's own REST API on localhost, SMTP with empty addresses, a Python Code node); a Python Code node flagged for review 1.

## Bench defects found

- **An OOM kill in a canned n8n check** (3169): the container's 1 GiB cap killed n8n about 70 s into the check, twice; the row read `bench error: fetch failed` and the next template's run (2374) found the container stopped. Measured with `--no-n8n-check`. Proposal P83.
- **Transport headers** (3314): the in-process host adds none of the `date`, `connection`, `transfer-encoding` headers Node's server adds on the n8n side; a prompt that quotes the response headers differs. Proposal P84.
- **A route URL without a path** (2648): `https://blog.n8n.io` does not answer n8n's request for `https://blog.n8n.io/`, so every canned check fails at the first read (logged `read-default`); the template stops at preflight on Markdown v1 anyway. Proposal P85.
- **A fixture note that predicted an n8n failure** (2883): the canned runs succeed where the `offline` note expected the `$credentials` expression to fail; not marked (above). The note should be corrected by a person.
- **Canned checks stop after model nodes** (2292 agent output parser, 2354, 2705 Pinecone sub-node): expected for a canned run (P41's fitted replies do not reach every parser); no verdict depends on them, since each template stops at preflight.

## Compared with release points 1 and 2

|                    | release point 1            | release point 2                        | release point 3            |
| ------------------ | -------------------------- | -------------------------------------- | -------------------------- |
| commit             | 4e8a5f8                    | cbfe38d                                | ab1050b                    |
| dev                | 9/30 (30.0%)               | 16/50 (32.0%)                          | 29/100 (29.0%)             |
| held-out           | 2/20 (10.0%)               | 3/20 (15.0%)                           | 1/20 (5.0%)                |
| gap                | 20.0                       | 17.0                                   | 24.0                       |
| bound              | 23.4                       | 23.1                                   | 20.8                       |
| held-out gate sum  | 71                         | 80                                     | 67                         |
| held-out at gate 3 | 15 (12 preflight refusals) | 15 (14 preflight refusals, 1 baseline) | 16 (16 preflight refusals) |
| held-out flips     | 0                          | 0                                      | 0                          |
| verdict            | inside                     | inside                                 | over (first time)          |

- Dev's rate stayed near 30% while dev doubled: round 3's dev added the 30 seeded dev templates that had no fixtures before and release point 2's held-out, and the loop moved it from 18 (`r3-base`) to 29 of 100. Held-out fell from 3 to 1 of 20 on a fresh set drawn from further down n8n's listing (ranks 169–199 and a top-up past 200), where templates use more apps the converter has no request template for (LinkedIn three times), vector stores and older node versions.
- The bound narrowed (n_dev 100 instead of 50) while the gap widened by 7 points; one held-out template is 5 points.
- Held-out still stops almost entirely at preflight (16 of 19 failures), on levers round 3 did not take on: REST request templates for other apps, vector stores, older logic node versions, tool maps. Round 3's fixes do show: 2648's WordPress draft now maps (iteration 28) and its preflight names only Markdown v1, and 2288's and 3314's data-built URLs get the setup hosts question (iteration 30).

## Fixture check

No fixture fixes. One held-out n8n run had an unanswered service request (2648, P85); the others had none. Unused routes are on paths that stopped earlier or on canned runs.

## Label check at release time

`node evals/bench/compare-labels.mjs --labels evals/bench/labels-held3.json` on HEAD: outcome 18/20, outcome and target 18/20, wake-up 19/20, blockers 18/20, questions 16/20 (19 at R3a), everything 13/20 (16 at R3a). The analyzer's verdicts are as at R3a (1150 target, 2374 wake-up, 3169 substitution, 3082 form question); the three new disagreements are questions the labels predate: iteration 30's hosts question on 2288 (an image URL from a Notion block) and 3314 (the form's URL field), iteration 28's WordPress site question on 2648. Each asks about a real step, so they are extras of the labels' era, not analyzer errors.
