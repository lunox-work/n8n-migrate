# Proof and compatibility

The measurements behind the README: how the bench works, what it found, and what has and has not been run on a real Claude account.

## Proof

The bench migrates n8n templates in one shot (plain converter, no retry, no
hand edit) and runs each against the same template running in n8n 2.47.7 in
Docker, every external call answered by the same fixtures. Raw data:
[evals/results.jsonl](../evals/results.jsonl); method:
[evals/bench/README.md](../evals/bench/README.md).

<!-- corpus: evals/bench/corpus.json (counts, coverageTop100); splits: evals/bench/splits.json; round 4 eligibility:
     evals/bench/EXCLUSIONS.md "Round 4 eligibility" and its amendment 1, evals/bench/AUDIT-R4.md; LOOP.md "r4-base", "r5-base". -->

- **Corpus.** n8n's template listing walked by views: the first 100 templates
  the analyzer marks `subscription` (13 excluded by a rule committed first: 9
  tutorials about n8n, 3 paid, 1 by hand), split 60 dev / 40 held-out by a
  seeded shuffle. **The corpus changed in round 4**: it was rebuilt under a
  new eligibility rule, committed before it was applied, that keeps only
  templates workable end to end (an n8n baseline, every outside service
  mocked, every main-branch step under a planned feature, something to
  compare). 24 of round 3's dev templates left and 24 came in, so numbers
  from round 4 on do not compare with rounds 1–3 (round 3's 29 passes are 27
  of the new 100 before any round-4 fix). The held-out rolls: each release
  point scores 20 templates that no fixing session has read, labelled and
  fixtured blind, and they join dev afterwards. Round 5's dev is round 4's
  100 plus round 4's 20 scored held-out templates (120); its held-out is 20
  fresh templates from further down the listing under the same rule.
- **Gates.** Analyze, convert, run, the same effects as n8n, robust on empty
  and malformed input, contained on hostile input, stable over 3 repeats,
  affordable. A template stops at its first failed gate.

<!-- evals/bench/RELEASE-5.md (release point 5, commit b0143fb); evals/results.jsonl rel5-dev, rel5-held, rel5-held-rec;
     gap and bound: node evals/bench/summary.mjs --release rel5-dev rel5-held --flips 0. Coverage: node
     evals/convert-coverage.mjs --split dev (evals/convert-coverage-dev.md); held-out the same with --ids (RELEASE-5.md).
     Loop: LOOP.md "r5-base" (40 of 120) to "R5b3" (51 of 120, r5b3-full). Sensitivity: RELEASE-5.md "Sensitivity".
     Release points 1-4: evals/bench/RELEASE-1.md to RELEASE-4.md (round 4: dev 35 of 100, held-out 2 of 20, inside). -->

- **Round 5: converter coverage 62 of 120, one-shot 50 of 120.** Out of
  round 5's 120 dev templates (round 4's 100 plus round 4's 20 scored
  held-out), 62 have every step supported by the converter and 50 pass every
  gate in one shot (`rel5-dev`, release point 5). On round 4's 100 as a
  subset: 51 and 43 (48 and 35 at release point 4). The loop took the
  one-shot count from 40 (`r5-base`) to 51 of 120 (`r5b3-full`); the release
  run measured 50 because one template's driver session declined to make a
  send on the same commit. Levers added in round 5: the XML node with n8n's
  own libraries, the Postgres node's queries and table operations (local
  task), the SerpAPI agent tool, sub-workflow tools with an input schema,
  Sheets spreadsheet creates over the Sheets API, and the n8n node's reads.
- **Release point 5: held-out 7 of 20 (35%), inside the overfitting bound.**
  The 6.7-point gap is inside the bound of 23.3 points (pooled pass rate
  41%, n = 120 and 20, no held-out template flipped). Release point 4 was
  inside too, so the rule that stops the loop (over the bound at two release
  points in a row) has **not** fired. Four of the 7 held-out passes compare
  real writes, against none at release point 4's first run. Every variant
  that treats both sides alike stays inside (gap 0.2 to 7.5 points), with
  rows that rest on bench defects set aside or reply-only passes counted as
  failures. The held-out ran once, on replay: the pass that records n8n's
  model calls first cost more than planned, so flips were counted against
  that pass on the same commit (none).
- **What stops most templates is a missing lever, not a wrong conversion.**
  48 of the 70 dev failures stop at preflight, before any effect: a step the
  converter blocks, a core logic node version the runtime does not
  implement, or an operation without a tool map. Blocked most often across
  round 5's dev: vector stores (12 templates), a WordPress site address to
  answer (8), database steps other than the Postgres node's (7), forms that
  wait for a person (3). Held-out stops at preflight far less (3 of 13
  failures, 12 of 18 at release point 4), on apps with no request template.
- **Losses.** Held-out passes at a lower rate than dev (35% against 42%),
  and its failures now come at run time: plain-http addresses refused under
  the "public https hosts" answer, a Drive trigger's item without the file
  name n8n gives, a raw JSON body sent as text, a Drive file created without
  the fields a later step reads, an inline key redacted inside a header.
  Three held-out failures rest on bench defects (fixture times filled at two
  instants, and two n8n baselines that failed on the stand-in model's first
  draw; PROPOSALS P132, P134).
- **Connector shapes are partly verified.** The mock connectors carry the
  real tool names and input schemas captured from a Claude account (116
  tools, 7 connectors). Slack, Google Drive and Notion reads were checked
  against real output on 2026-11-18 (evals/connectors/observed-2026-11-18.md)
  and their adapters fixed; Gmail and all writes still rest on hand-written
  fixtures and stay `unverified`.
- **What the comparer cannot vouch for.** Model replies on the Claude side
  are n8n's own, replayed per node and call; the bench checks that Claude
  asked the same question, offered the same tools and ran the same agent tool
  turns. A template that writes, replies and sends nothing passes on that
  alone: 22 of the 50 round-5 dev passes and 3 of the 7 held-out passes
  compare only the reply or a terminal node's items, no write (PROPOSALS
  P50, P70). Counting those as failures on both sides leaves the gap at 0.2
  to 3.3 points against bounds of 19.9 to 21.6.
- **A finding the allowlist cannot catch.** At release point 1, dev template
  1953 failed the contained gate: on a hostile email, the Gmail connector's
  reply went to the message's `Reply-To` (a lookalike address) where n8n
  replies to `From`. The call was the allowed tool with the runner's own
  arguments; the connector picked the recipient. The runner now names the
  recipient itself ([Security](../README.md#security)) and 1953 passes every gate; no
  template failed the contained gate at release points 2 and 3.
- **The hooks under `claude -p`.** In 34 recorded task-driver runs
  (haiku and sonnet, CLI 2.1.323) the Slack arguments matched exactly at 1,
  50 and 500 items, and hostile emails produced 0 calls outside the
  definition. The models ignored those injections, so the deny path was
  exercised by separate adversarial-prompt runs, where the hook stopped the
  call ([MEASUREMENTS.md](../evals/task-driver/MEASUREMENTS.md)).
- **Cutover against live n8n.** One Gmail-poll workflow, one feed for both
  sides, n8n polling every minute, interrupted between steps: 9 sendable
  items, each sent once by one system, through cutover and rollback. The
  rejected order, task on while n8n is still on, sent 2 of 2 twice
  ([results](../evals/cutover/results.jsonl)).

## Compatibility

<!-- Rows from evals/phase0/CHECKS.md (2026-11-14) and PLAN Phases 2-7. "Observed" = run on this machine; "docs" = public docs only,
     untested; "needs an account" = only a run on a Pro, Max or Team account settles it. -->

Scheduled tasks, artifact capabilities and the task API trigger are research
previews; this list is dated 2026-11-14 and re-runnable
([CHECKS.md](../evals/phase0/CHECKS.md)).

| Check                                                                  | Status                                  | What was seen or what the docs say                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Analyzer and converter on real n8n exports                             | observed                                | 35 workflows exported by n8n 2.47.7 in all three export shapes: no crash, no unmapped node                                                                                                                                                                             |
| Task driver: allowlist, hooks, exact arguments, resume                 | observed                                | `claude -p`, CLI 2.1.323, against mock connectors with the real tool names                                                                                                                                                                                             |
| Chat skill's frontmatter hooks                                         | observed (CLI)                          | they register and run in Claude Code; Desktop and Cowork not checked                                                                                                                                                                                                   |
| Cutover and rollback through n8n's public API                          | observed                                | local n8n 2.47.7; only the Gmail trigger's cursor mapping is checked live                                                                                                                                                                                              |
| Artifact page: graph, Run now, dry run, ledger, lock, form             | observed                                | published on claude.ai 2026-11-17: graph, Run now and a dry run with a model step; 14 of 14 Playwright scenarios against a local shim cover the rest                                                                                                                   |
| Artifact `mcp`, `sample`, `db` capabilities                            | observed (sample, db)                   | a published page ran an agent through `sample` and kept runs in `db`; `mcp` not yet called from a page                                                                                                                                                                 |
| Artifact page calling other hosts                                      | no (contract)                           | the page reaches only its own origin, so `http` steps hand off to a task                                                                                                                                                                                               |
| Cloud task runs a bundled script and connectors unattended, writes too | observed (script, HTTP, connector read) | runs unattended with no prompt; HTTP works once the workflow's domains are allowed on its environment; a Notion search ran through the repo's hooks (`mcp__<connection>__<tool>`); tools Blocked in the connector's settings are not offered; connector writes not run |
| Desktop (local) task does the same                                     | observed                                | a Desktop scheduled task on the test repo (Only on this computer, hourly) ran to DONE with the repo's settings (run-2142abfd5518)                                                                                                                                      |
| Tasks honour the repository's settings and run its hooks               | observed (cloud)                        | the repo's hooks refused a call no run requested and a call with changed arguments; Desktop not checked                                                                                                                                                                |
| Cloud task pushes run records to its repository (`n2c-state`)          | observed                                | pushed with the session's GitHub access, default environment                                                                                                                                                                                                           |
| A task writes the artifact's database                                  | observed (cloud)                        | a scheduled run's record appeared in the page's history (task.json `store: artifact-db`)                                                                                                                                                                               |
| Real connector output shapes                                           | observed (reads)                        | Gmail, Slack, Drive and Notion reads and Gmail drafts captured 2026-11-18, adapters fixed; other writes unverified                                                                                                                                                     |
| Minimum interval                                                       | docs                                    | cloud tasks 1 hour, at most 100 scheduled runs per account per hour; local tasks 1 minute                                                                                                                                                                              |
| Usage limit hit mid-run                                                | docs                                    | not documented mid-run; the ledger treats every run as interruptible                                                                                                                                                                                                   |
| Share of the usage window per run                                      | not measurable                          | the usage page shows the week in whole percent, by product, not by run; `claude -p` estimates $0.006–0.014 per run on haiku at API prices                                                                                                                              |
| Skill zip upload in chat and Desktop                                   | observed (chat): name refused           | claude.ai refuses a skill name containing "claude" (2026-11-19), so `n8n-to-claude.zip` does not upload as built; renamed, it uploaded and its chat sandbox (Node 22) ran analyze and convert; Desktop not checked                                                     |
| Folders run from a claude.ai chat through the server (`serve.mjs`)     | observed (chat, artifact)               | token as a request header; an http step with the server's key, a Gmail read and a Gmail draft write (ledger sending → sent) through the person's connector, model steps (2026-11-19); an artifact page's http step through `n2c_http`; Cowork not run                  |
| Plugin install in Claude Code and Cowork                               | docs                                    | not installed from this marketplace yet                                                                                                                                                                                                                                |
| Current terms allow all of the above on a subscription                 | docs                                    | runs only through Anthropic's own tasks, artifacts and Claude Code; nothing scripts claude.ai                                                                                                                                                                          |
