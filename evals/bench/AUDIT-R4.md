# Round 4 eligibility audit (2026-11-15)

Rule: EXCLUSIONS.md "Round 4 eligibility", committed in **76c2fac** before this audit ran. That commit also holds the lists (`evals/bench/eligibility.json`), the check (`evals/bench/eligible.mjs`) and its test (`tests/bench-eligible.test.mjs`). The maintainer's tightening (bounded bench fixes only, something to compare, nothing hosted or relay) arrived before the first commit, so it is part of 76c2fac. There is no follow-up commit.

Applied with `node evals/bench/eligible.mjs --ids <round-3 dev 100 + round-3 held-out 20>`. The audit used the checkout's analyzer with default answers and the cached template JSON only. It read no held-out fixtures, labels or results. The only fixture reads were dev fixtures, for the `expect.n8nCannotRun`/`expect.n8nFails` fields.

Uncommitted change from applying the rule: `evals/bench/corpus.json` gains `r4Hand` on 1826 and 2328 (see Hand calls). The orchestrator commits it with this report.

## Totals

|                  | Eligible | Ineligible |
| ---------------- | -------- | ---------- |
| Round-3 dev (100) | 81       | 19         |
| Round-3 held-out (20) | 19   | 1          |
| **All 120**      | **100**  | **20**     |

Of the 100 eligible, 12 are eligible only through a pending bounded bench fix (listed below).

## Leaving, by reason

Each template is listed under its first reason, in rule order. A `*` marks a round-3 held-out template.

| Reason (clause)                                                | n   | Ids                                  |
| -------------------------------------------------------------- | --- | ------------------------------------ |
| Public chat page (out of scope: Chat Trigger `public: true`)   | 6   | 2415 2098 5993 2413 6270 2395        |
| Relay wake-up or a hosted other trigger (outcome)              | 3   | 2167 1938 2749                       |
| Error workflow (wake-up `error`, Error Trigger)                | 1   | 2894                                 |
| Synchronous webhook reply (Respond to Webhook on a form)       | 1   | 2417                                 |
| Wait on webhook (multi-page Form)                              | 1   | 2878                                 |
| Persistent-connection trigger (IMAP)                           | 1   | 3169\*                               |
| n8n fails on its own: chat model in the completion class       | 2   | 3016 2320                            |
| n8n fails on its own: required parameter empty                 | 2   | 5110 4352                            |
| Hand: n8n fails on the template's own wiring                   | 2   | 2328 1826                            |
| Nothing to compare (no enabled trigger: everything unreached)  | 1   | 3393                                 |
| **Total**                                                      | 20  |                                      |

Points for the orchestrator:

- **Four templates that pass today leave** (at `r3g-full`): 2413 and 6270 (public chat page) and 2167 and 1938 (relay). The maintainer's update says relay leaves, so 2167 and 1938 leaving is intended. The public-chat clause applies the wording ("public chat pages", pinned to `public: true`) whatever the analyzer's default answer. With default answers the analyzer turns these six into a skill, and the bench does pass two of them. Reading PLAN's "(reported as hosted)" as the deciding part would keep all six. That is a one-line change to `outOfScope` and must be committed before it is applied.
- **3016 is an unmarked self-fail.** Its completion model names `gpt-4o`, the same refusal as 2320. Its canned n8n check already stops at "Error in sub-node OpenAI Model". The definition found it without a mark.
- **3393's only trigger is disabled.** The analyzer reaches no step, so nothing can be compared. This follows from the template file.
- **4846 needs watching (P82).** It stays eligible. Its JSON body depends on the data, so it is not a self-fail by the definition.
- **2557 is not flagged for its empty X text.** The X node is not on the analyzer's main branch, which agrees with its canned check succeeding.

## The 12 dev templates with no n8n baseline

From the dev fixtures' `expect` fields: `n8nCannotRun` is 1073, 5338, 5230, 1978, 2090, 2859, 1992 and 2320 (8; 1992 and 2320 were not in the brief's list). `n8nFails` is 4352, 5110, 2328 and 1826.

| Template | Mark          | Round 4                       | Fix that keeps it                                                        |
| -------- | ------------- | ----------------------------- | ------------------------------------------------------------------------ |
| 1073     | n8nCannotRun  | kept, pending                 | P66 (MongoDB sidecar) + R4-nodes-exclude (Execute Command) + substitution approval |
| 5338     | n8nCannotRun  | kept, pending                 | R4-community-package (Blotato in the image)                              |
| 5230     | n8nCannotRun  | kept, pending                 | P66 (MongoDB sidecar)                                                    |
| 1978     | n8nCannotRun  | kept, pending                 | P53 (SMTP sink, smtp effect, substitution approval)                      |
| 2090     | n8nCannotRun  | kept, pending                 | P66 (Postgres sidecar)                                                   |
| 2859     | n8nCannotRun  | kept, pending                 | P66 (Postgres sidecar)                                                   |
| 1992     | n8nCannotRun  | kept, pending                 | R4-python (Python task runner)                                           |
| 2320     | n8nCannotRun  | leaves (self-fail)            | none: n8n's LangChain class refuses the template's model name            |
| 4352     | n8nFails      | leaves (self-fail)            | none: required parameters empty                                          |
| 5110     | n8nFails      | leaves (self-fail)            | none: `matchingColumns` empty                                            |
| 2328     | n8nFails      | leaves (hand)                 | none: wiring                                                             |
| 1826     | n8nFails      | leaves (hand)                 | none: wiring through disabled nodes                                      |

So bench fixes keep **7 of the 12**, and 5 leave.

Checking the definition against the marks: the mechanical clauses catch 4352, 5110 and 2320 as marked, plus 3016 (unmarked). 2328 and 1826 are wiring failures the lists cannot see, so they are hand calls. Every `n8nCannotRun` template except 2320 maps to a bounded fix.

## Hand calls (corpus.json `r4Hand`, decided from the template)

- **2328:** "Get Transcript File takes its Drive file from $json.docsDestination.document in URL mode, but its input is the Meet transcripts list reply (the document sits under transcripts[]), so n8n gets no file id whatever the data". This reading also uses the Meet API's documented reply shape.
- **1826:** "the manual trigger also feeds the disabled Read Binary File and download nodes, which n8n passes through, so Read Spreadsheet File runs a second time on an item with no binary data and fails".

Disclosure: the `n8nFails` marks prompted me to read these two templates. Each reason stands on the template alone.

## Wake-up strata

| Stratum  | Quotas used: Phase 5 (100) + fresh (20) | Round-3 composition (120) | Eligible (dev / held-out) | Refill to the quotas | Refill to the composition |
| -------- | ----------------------------------- | ------------------------- | ------------------------- | ------------------- | ------------------------- |
| chat     | 25 + 6 = 31                         | 35                        | 28 (22 / 6)               | 3                   | 7                         |
| manual   | 25 + 5 = 30                         | 30                        | 28 (23 / 5)               | 2                   | 2                         |
| schedule | 20 + 4 = 24                         | 25                        | 23 (19 / 4)               | 1                   | 2                         |
| form     | 12 + 2 = 14                         | 11                        | 9 (7 / 2)                 | 5                   | 2                         |
| poll     | 10 + 2 = 12                         | 12                        | 8 (7 / 1)                 | 4                   | 4                         |
| other    | 8 + 1 = 9                           | 7                         | 4 (3 / 1)                 | 5                   | 3                         |
| **Total** | 120                                | 120                       | 100                       | 20                  | 20                        |

Strata come from the current analyzer's wake-up, which agrees with corpus.json on all 120. The Phase 5 fetch never filled form or other (the shortfall was filled from overflow), so refilling to the quotas asks for more form and other templates than the corpus ever held.

## Pending bench fixes per kept template

| Fix                  | Keeps                                   |
| -------------------- | --------------------------------------- |
| P66 Postgres         | 2090, 2859, 2803 (2803 runs today on pins; its insert is not observed until the sidecar) |
| P66 MongoDB          | 5230, 1073 (1073 also needs R4-nodes-exclude) |
| P53 SMTP             | 1978, 2537\* (2537 also needs P61)      |
| R4-python            | 1992, 2374\*                            |
| P61 every type       | 2557, 2537\*                            |
| P52 loopback to mock | 1150\*                                  |
| R4-community-package | 5338                                    |
| R4-nodes-exclude     | 1073                                    |

Without these fixes the 12 stay eligible, but none of them has a baseline. Each fix's ids are listed in `eligibility.json` `bench.fixes`. New fixes have provisional names (R4-…) until the orchestrator gives them P numbers.

## Draft bench proposals (PROPOSALS style; not in PROPOSALS.md)

### P53 (revisited). Mail over SMTP has no bench counterpart, and the Claude side never substitutes

- **Evidence.** 1978 (dev) and 2537 (round-3 held-out, joins dev in round 4) send mail with Send Email (SMTP). n8n fails because no server exists and the dummy credential has no host. The analyzer offers `smtp → mail connector`, but headless mode approves no substitution, so the Claude side refuses the step. P53 was deferred because a sink alone would feed only n8n's half.
- **Proposed change.**
  - Add an SMTP capture sidecar on the bench network (for example a small Node `smtp-server`, or MailHog/Mailpit) that accepts any login and records each message.
  - Give the `smtp` credential dummy its host.
  - Add an `smtp.send` effect in effects.json, compared on recipients (to, cc, bcc), subject and decoded body, and paired with a Gmail or Outlook connector `send_message` or REST send.
  - Let the bench's headless setup answers approve the substitutions the analyzer offers. Record each approval in the row as non-placeholder, the way overlay fills are recorded.
- **Keeps.** 1978, 2537 (with P61). This also covers 1073's Execute Command substitution approval.
- **Effort.** About 1 day: sidecar and dummy (2 h), effect and pairing (3 h), approvals plumbing (2 h), tests.
- **Risk.** Approving substitutions in the bench measures a path a headless person run would not take. Mitigation: report "substitution approved" beside the verdict. The pairing could also pass a wrong recipient mapping on both sides, so its table must be the comparer's own, not the converter's.

### P66 (revisited). Database sidecars: Postgres first, MongoDB second

- **Evidence.**
  - 2090 and 2859 (agent tools that run model-written SQL) and 5230 and 1073 (MongoDB insert or update on the main path) are `n8nCannotRun`.
  - 2803's Postgres insert is pinned, so it is not observed.
  - P66 was deferred because the seeds have no column types and every database template stopped at preflight.
- **Proposed change.**
  - `db` fixture sources carry typed seeds: `{engine, schema: [{table, columns: {name: type}}], rows}`.
  - One `postgres:16-alpine` sidecar per bench run, with a fresh database per variant, created from the schema and seeded. `log_statement=all`, or a row diff after the run, gives the write effects (`db.write:<table>`, compared on the changed rows).
  - Point the postgres and mySql dummies at it (MySQL only if a template needs it; none does today).
  - MongoDB: one `mongo:7` sidecar with the profiler at level 2, or a collection diff after the run, giving `db.write:<collection>`.
  - The Claude side's database steps use the same seed through the runtime's driver once the db lever is built.
- **Keeps.** Postgres: 2090, 2859, 2803. MongoDB: 5230, 1073 (with R4-nodes-exclude).
- **Effort.** Postgres about 1.5 days (schema seeding, diff effect, per-variant reset, fixture updates for 3 templates by the blind writer). MongoDB about 1 day more.
- **Risk.** Image size and memory: Postgres about 30 MB RSS idle, MongoDB about 150 MB, against the 16 GB machine and the 1 GiB n8n cap. Start a sidecar only for fixtures that name its engine. Model-written SQL makes 2090 and 2859 depend on replayed replies, which P76 already pairs.

### R4-python. Python Code nodes cannot run in the bench's n8n

- **Evidence.** 1992 (dev, `n8nCannotRun`) and 2374 (round-3 held-out) have Python Code nodes on the main path. n8n 2.x runs Python only through an external task runner (`n8nio/runners` with `N8N_RUNNERS_MODE=external`), and the bench image has none (container.mjs).
- **Proposed change.** Start the runners sidecar beside the n8n container with a shared auth token (`N8N_RUNNERS_ENABLED=true`, `N8N_RUNNERS_MODE=external`, `N8N_RUNNERS_AUTH_TOKEN`, broker on the bench network). Pin the runners image to the n8n version. Keep the runner's network on the proxy, as n8n is, so Python code that reaches out still hits the mock.
- **Keeps.** 1992, 2374.
- **Effort.** About half a day plus one canned check each.
- **Risk.** An extra container (about 100–200 MB). The runner's Python stdlib allowlist (`N8N_RUNNERS_STDLIB_ALLOW`) must cover what the templates import. Read the imports from the template, never widen to `*`.

### R4-nodes-exclude. Execute Command is excluded by n8n 2.x by default

- **Evidence.** 1073's first node is Execute Command. n8n 2.47.7's default `NODES_EXCLUDE` holds `executeCommand` and `localFileTrigger`, so the run stops there (its `n8nCannotRun` text).
- **Proposed change.** Set `NODES_EXCLUDE=[]` on the bench container only for fixtures whose template has an Execute Command node. Run the command inside the container, where its writes stay. Record a disk effect if the command writes a path a fixture lists.
- **Keeps.** 1073 (with P66 MongoDB and P53's substitution approval).
- **Effort.** About 2 hours.
- **Risk.** It runs template shell code in the n8n container. The container is already the sandbox for Code nodes, but cap its memory (it already has the 1 GiB cap) and never mount the host.

### R4-community-package. Blotato's community package is not in the image

- **Evidence.** 5338's ten Blotato nodes (`@blotato/n8n-nodes-blotato`) have a one-off mapping (the analyzer maps them to `http`), but n8n refuses their credential type because the package is not installed (`n8nCannotRun`).
- **Proposed change.** Build the bench image with the community packages that have a one-off mapping in `references/mappings.json` installed at pinned versions (`npm i` in `~/.n8n/nodes` at build time). List them in `eligibility.json` `bench.pendingTypes` until installed. Their HTTP goes through the proxy like every node.
- **Keeps.** 5338.
- **Effort.** About half a day (image build, version pin, canned check).
- **Risk.** Third-party code in the baseline image. Pin by integrity hash, install from the npm tarball only, and add no package without a mapping.

### P61 (extended). Credential dummies for every node type that ships none

- **Evidence.** 2557 (S3, Dropbox, OneDrive, YouTube, X and LinkedIn with stripped credentials) and 2537 (Send Email) have nodes without credentials whose types are not in `n8n-side.mjs` `NODE_CREDENTIAL`, so n8n refuses them once reached.
- **Proposed change.** When a node needs a credential and ships none, attach a dummy of its first credential type from `references/nodes.json` (`credentials`) with generic field values, keeping the per-type overrides that need a host or a token shape (S3 endpoint, OAuth2 token, smtp host from P53).
- **Keeps.** 2557, 2537 (with P53).
- **Effort.** About 2 hours.
- **Risk.** A dummy with a wrong field shape fails differently from a real credential. The canned check shows it, and such a type gets an override.

### P52 (revisited). Loopback hosts reach the mock

- **Evidence.** 1150 (round-3 held-out) calls `http://localhost:5678/rest/workflows` with basic auth. The bench n8n's `NO_PROXY` holds localhost, so the request hits the bench n8n, which refuses basic auth on `/rest`. P52 was declined in R3d because the mock would have to invent n8n's API. An API key does not help here: `/rest` takes only a browser session, and the public `/api/v1` with `X-N8N-API-KEY` is a different API that the n8n node uses and the analyzer already blocks.
- **Proposed change.** For a fixture whose routes name a loopback host, drop that host from `NO_PROXY` for the run and give the mock a leaf for it. The fixture writer then writes that API's answers like any other service's (the same thing the mock already does for Gmail or Notion). FIXTURES.md says so, and `validate.mjs`'s loopback warning becomes "needs a route".
- **Keeps.** 1150.
- **Effort.** About 3 hours.
- **Risk.** n8n's own health or editor calls on localhost must not be proxied. Apply the change only to the named host and port, never to the container's own UI port, and check that n8n starts with it.

### P83 (as filed). OOM-killed n8n runs

- **What it takes.** As P83 proposes: an OOM kill (`State.OOMKilled`) becomes a failed baseline with status `oom`, and the container restarts before the next template.
- **Keeps.** No template directly. The only template seen killed (an IMAP-triggered held-out one) leaves for its persistent-connection trigger. P83 protects every other row from inheriting a stopped container.
- **Effort.** About 2–3 hours. Low risk. Recommended regardless.

### No bounded fix (stay out)

- 3016 and 2320: n8n's LangChain refuses the model name in the completion class.
- 4352 and 5110: empty required parameters.
- 2328 and 1826: wiring.
- 3393: no enabled trigger.
- The out-of-scope set: a bench change cannot bring these into scope.

## Draft PLAN line (Phase 6)

> Round 4 eligibility (EXCLUSIONS.md, commit 76c2fac, before it was applied): a corpus template must be analyzer `subscription` with no relay, hosted or out-of-scope trigger or step (PLAN "Out of scope for v1" pinned in `evals/bench/eligibility.json`), must get an n8n baseline (no self-failing configuration; every outside service mocked today or by a bounded bench fix), must have every main-branch step under a planned feature, and must compare something (a write, a chat reply or a P70 terminal); `evals/bench/eligible.mjs` decides from the template, the analyzer and the lists only. Applied to round 3's 100 dev and 20 held-out: 100 eligible (12 pending bench fixes P52, P53, P61, P66, Python runner, Execute Command, Blotato package), 20 leave (19 dev, 1 held-out); refill by stratum in the audit.

## Checks

- `node --test`: 423 pass, 0 fail (8 new in `tests/bench-eligible.test.mjs`).
- `node scripts/lint-no-template-rules.mjs`: ok.
