# Release point 1 (2026-11-14)

Held-out report (PLAN Phase 6). A session that changes the skill, the converter or the runtime must not read this file (EXCLUSIONS.md). Held-out results are given as aggregates; new failure kinds are described without template detail.

## Setup

- Commit 4e8a5f8 (skill unchanged since iteration 10b), plain `convert.mjs`, replayed model replies, in process, the claude driver for gate 8. Fresh rows, nothing carried forward: `rel1-dev` (dev 30), `rel1-held` (held-out 1–20, explicit ids), `rel1-held-b` (repeat of held-out, the cheaper run: its recordings existed and 2 templates reach the claude driver, against 9 in dev).
- Bench changes applied first (PROPOSALS P10–P12) and held-out setup: placeholder overlays for 7 templates (an overlay `credentials` section for a service domain), time compression on 3 (flagged), the Ollama completion node routed to the model shim. `validate.mjs`: 200 fixture files, 0 failing.
- `claude -p`: 67 runs (ledger 264 → 331; dev 25, held-out 36 with the live recordings, repeat 6), haiku only, no usage limit hit. `node --test` 287 pass, lint ok.

## Numbers

|                                      | dev (n=30) | held-out (n=20) |
| ------------------------------------ | ---------- | --------------- |
| pass every gate                      | 9 (30.0%)  | 2 (10.0%)       |
| gate sum                             | 149        | 71              |
| stop at gate 3                       | 18         | 15              |
| stop at gate 4                       | 2          | 2               |
| stop at gate 6                       | 1          | 0               |
| bench error (gate 0)                 | 0          | 1               |
| connector-limited                    | 0          | 0               |
| time compression                     | 1          | 3               |
| flips (repeat on one commit, n = 20) | –          | 0 of 20         |

- **Gap:** 30.0 − 10.0 = **20.0 points**.
- **Bound:** pooled p = 11/50 = 22.0%; 1.96 · sqrt(p(1 − p)(1/30 + 1/20)) = **23.4 points**, + 2 × 0 flips = 23.4. PLAN writes the formula for the full split (1/60 + 1/40, 16.0 points at this p); only 30 dev and 20 held-out templates have fixtures, so n is the fixtured sizes. The flips term is 0 here (0 of 20 held-out verdicts, gates, buckets or causes changed between `rel1-held` and `rel1-held-b`).
- **Verdict:** the gap is inside the bound. First release point, reported only (overfitting = over the bound at two points in a row).
- **Sensitivity.** Four held-out rows rest on bench defects (below): three failures that say nothing about the migration and one pass the comparer cannot vouch for. Dropping the three and counting the pass as a failure, held-out is 1 of 17 (5.9%); counting dev's one pass on the same blind spot as a failure, dev is 8 of 30 (26.7%). The gap stays near 20 points.

Failures by gate and bucket:

| gate: bucket                  | dev | held-out |
| ----------------------------- | --- | -------- |
| 3: unmapped node (preflight)  | 18  | 9        |
| 3: runner bug                 | 0   | 4        |
| 3: expression translation     | 0   | 1        |
| 3: fixture (baseline failed)  | 0   | 1        |
| 4: field map                  | 2   | 1        |
| 4: flaky model step           | 0   | 1        |
| 6: runner bug                 | 1   | 0        |
| 0: bench defect (bench error) | 0   | 1        |

Per stratum (reported, never gated): dev chat 3/10, poll 1/5, form 0/3, manual 2/7, schedule 2/3, other 1/2; held-out chat 1/4, poll 0/2, form 0/3, manual 1/5, schedule 0/6, other (none in 1–20).

Dev against `p6-i10b` (same skill): 9 of 30 either way; gate sum 147 → 149 from the bench changes alone. 1953 4 → 6: with P10 its reply pairs with n8n's REST send, gates 4 and 5 pass, and gate 6 fails because the connector's reply follows the hostile message's Reply-To (a lookalike address) where n8n replies to From. 4722 stays at 4; with P11 its get reads receive their own rows again and the remaining difference is P1's missing headers.

## Held-out failures that dev already shows (expected)

- The 9 unmapped-node refusals (of 12 preflight refusals) block on levers dev knows: files, media, vector stores, missing request templates, operations without a tool map. Database and form-wait blockers did not occur in held-out 1–20.
- The 2 gate-4 rows are model-step differences (one of them on a bench defect).

## New kinds dev never showed (candidate blind spots)

1. **Refused at run time after a clean preflight.** A step passes preflight and the runtime then stops on an option or operation it does not support (2 templates). Preflight judges node types and blocked operations, not every option the runtime lacks, so the refusal comes late and as a runner bug.
2. **Core transform node not implemented.** Preflight refuses a built-in logic node version the runtime has no implementation for (2 templates). Dev's preflight refusals were all about I/O.
3. **URL built at run time as a main blocker.** Known from dev coverage, but here it is the only refusal on one template and part of two more (3 templates); no dev fixture template stopped on it.
4. **Connector write steps left without their required arguments.** Preflight finds a connector write whose arguments need the skill's translation and the plain converter leaves them empty (2 templates), and a model step that was not converted (1). Dev's fixture templates never reached this.
5. **Untranslated expression at preflight** (1 template, the expression translation bucket).
6. **JSON-looking model text handled as an object.** A model reply that is itself JSON text stays a string in n8n but becomes an object on the Claude side, and a downstream string template then renders it differently (1 template; exposed by a stand-in defect, below, but the handling difference is real).
7. **Agent iteration cap not carried over.** n8n stops an agent at its iteration limit; the Claude side kept going past n8n's last recorded turn (1 template, seen under a bench defect).

## Bench defects found

- **Stand-in model fidelity.** Haiku sometimes puts its own answer envelope (`{"type":"text","text":…}`) inside the reply text, or drops a wrapper level a structured-output schema requires. One held-out n8n baseline (2271) fails on n8n's own parser (bucket `fixture`); two other runs (5035, 2090) carry the envelope into replays. Proposal P13. Not re-drawn: choosing draws until n8n succeeds would bias the baseline.
- **Prompt with NUL bytes.** A malformed fixture's chat text holds a NUL byte; the shim passes the prompt to `claude -p` as an argument, which cannot carry one. P12 caught it and saved nothing (2729, gate 0 `recording interrupted`). Proposal P14 (prompt on stdin).
- **Replayed agent turns are not checked against the tools the Claude side ran.** The model-input check compares system and user text only; tool results are not compared and reads are not gated. A Claude side whose agent never runs a read tool passes when n8n's replies are replayed. Held-out 2703 passes this way (its calendar tools are blocked on the Claude side); dev 6270 passes with an n8n-only read. Proposal P15.
- **No database sidecar** (2090, as expected): its n8n agent queries a host that does not exist and stops at its iteration cap, so its baseline is not meaningful. A Postgres container is too heavy for this machine, and the fixture has no rows to pin on the agent's tool node (whether n8n honours such a pin is unverified). Left as a defect.
- **The claude driver's memory gate** waits for 40% free while the n8n container is up; this machine sat at 33–39% and the gate waited 3-minute steps for most of each run (dev took about 70 minutes, mostly waiting). P12's one-time check covers recordings only.
- **Minor.** n8n's tokenizer download (`tiktoken.pages.dev`) goes unanswered in one run; no effect on verdicts. Two passes (dev 1747, held-out 2473) compare no write at all, by design of their templates.

## Fixture check

No fixture fixes. Every held-out n8n run had no unanswered service request. The unused routes are on paths that stopped earlier (canned model replies, failed baselines), plus spare Sheets `!1:1` header reads that n8n 2.47's append does not make (it reads the whole sheet, which the fixtures also serve).
