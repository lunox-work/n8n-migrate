# Design

The decisions the analyzer, converter and bench are built on, the scope of v1 and the known gaps. Commands and file formats are in [REFERENCE.md](REFERENCE.md); measured results in [PROOF.md](PROOF.md).

## Principles

- **Form:** one skill (`skills/n8n-migrate/`) wrapped in a plugin. The same folder zips into an uploadable skill for chat-only users.
- **Every workflow is classified.** The goal is 100% classified with a reason, not 100% migrated.
- **Classification:** wake-up, body and outcome per workflow, plus what it requires.
  - Wake-up: `manual`, `schedule`, `poll`, `chat`, `form`, `relay` (an event pushed in with no reply expected), `endpoint` (the caller waits for the reply), `mcp-server`.
  - Body: `prompt`, `script`, `script+model`.
  - Outcome: `subscription` (target `cloud-task`, `local-task`, `skill` or `artifact-form`), `replaced`, `hosted` (`key` or `no-key`), `keep-in-n8n`.
- **Runtime:** one runner, two drivers, one workflow definition.
  - The runner is code. It owns control flow, expressions and exact tool arguments.
  - Artifact driver: graph, "Run now", run history.
  - Task driver: a cloud task or a local Desktop task. The model only executes the call the runner hands it and returns the result.
- **No model in the analyzer.** The report comes from code. Unknown nodes are reported as unmapped, never guessed. What the file cannot settle becomes a question for the person.
- **Generated workflows are self-contained.** They keep running if the skill is removed. The exception is a chat or Cowork, where the skill is installed and carries the runtime once: `migrate.mjs` writes light folders (definition and report, a few KB), a scheduled task sets itself up from the workflow's page with the skill's runtime, and the page, a chat skill or a task's files are built from the definition when needed (`convert.mjs --build`). A chat skill and a published page still carry their own runtime.
- **The subscription token is never read, copied or passed to anything we ship.**
- **Third-party MCP servers are named as options, never installed for the person.**
- **The unattended path is what the bench grades.** The artifact path comes second.
- **The skill is improved by a measured loop, not by hand.** A bench migrates n8n templates in one shot, compares each against the original running in n8n, and failures drive the next change to the skill (see Bench).

## Analyzer rules for edge cases

- **Manual target:** `artifact` only when every requirement is `ok` on the artifact surface; otherwise `skill` (Claude Code or Cowork, where secrets and the bundled server exist). The same applies to a sub-workflow with no caller. `outcome.reason` names what the artifact lacks.
- **Several triggers:** the most demanding wake-up decides the outcome. `outcome.alsoTargets` lists other trigger kinds that need a different target, for example chat → skill plus schedule → cloud task. Manual, sub-workflow and error triggers never get one.
- **LLM API over HTTP:** a POST to a known LLM API (`references/http-hosts.json`) is a `model` step with effect none, lever `llm-api` and a `model call → Claude` substitution requirement. It runs on the subscription instead of an API key.
- **Undetermined effects:** an HTTP or SQL step the file cannot settle counts as a write (`effectBy: assumed`). It joins one `writes` question per workflow, answered with true, false or node names.
- **Chat-app relays:** Telegram, WhatsApp and Twilio triggers, and a plain Webhook whose messaging step replies to the chat id in its body, ask who waits for the replies. The assumed answer, outsiders, gives `hosted`; only you gives a `local-task` polling Telegram's getUpdates every minute, or a relay to a `cloud-task` for providers without a polling API; messaging Claude instead gives `skill`; nobody waits gives `cloud-task`.
- **Search tools:** an agent's SerpAPI tool asks one question: keep SerpAPI with the person's key (assumed: n8n's results, a secret and outbound HTTP), or use Claude's own web search (no key, results differ). The second answer replaces the `http` and `secret` requirements with `web-search`, which a task's session has and an artifact page does not, and the converter builds the tool as the session's `WebSearch` behind the same name, description and input the model saw in n8n.
- **Directory connectors:** Jira, Confluence, ClickUp and HubSpot operations with a captured connector tool are connector steps, the rest stay `http` with a secret, and the REST path stays in the report as `alternative`.
- **Form target:** a form whose step cannot run in an artifact keeps the artifact form and adds a `task-handoff` requirement: a task picks the submission up and runs the steps.
- **Setup only:** a workflow that only creates and seeds n8n Data Tables from a manual run, or only manages n8n, keeps its outcome and gets `setupOnly`.
- **DST:** a time-of-day schedule in a zone with DST gets `schedule.dstNote`; the run counts still ignore DST.
- **Relay rate:** relay outcomes note the API trigger's limits and ask the peak event rate; over 100 an hour stays in n8n.
- **Execute Command** is a substitution to a local task's shell, not a blocker. **Debug Helper** is a logic step. The **n8n API node** reads (workflow and execution list and get) move as an `http` step against the person's own n8n instance: most people move gradually and keep n8n running, and the report and `MIGRATION.md` say the step works only while it does. The site question takes the credential's Base URL; a local address (localhost, a private IP, a local or dotless name) makes the workflow a local task (`local-network`, as `host-disk`). Its writes (create, update, publish, unpublish, delete), credentials of any kind, audit and every other operation stay blockers until the writes question and the person's approval exist; running a workflow picked at run time stays blocked, since the public API has no endpoint for it.

## Out of scope for v1

- Synchronous webhook replies and public chat pages on the subscription (reported as `hosted`).
- Anything that must react in under a minute.
- A forwarder for `relay` workflows (reported, not built).
- Sub-workflows missing from the export.
- Wait nodes that resume on a webhook.
- Community nodes, beyond one-off mappings.
- Error workflows (the runner's failure alert replaces them).

## Bench

Measures, with no real account touched, whether the skill migrates templates in one shot and whether the result behaves like the original.

### Closed environment

- **Fixtures.** For each template: the trigger input and the output of every external read node, in four variants (normal, empty, malformed, hostile). Written by someone who has not seen the converter, reviewed, committed. Template `pinData` is used where it exists.
- **n8n side, the baseline.** Local n8n in Docker. Where feasible the real node runs against an HTTP-level mock, so its own behaviour stays in the baseline. Node-level stubs are the fallback and are marked in the results. The record is the ordered list of outgoing effects.
- **Claude side.** The migration is one headless run of the skill on the raw template: no retry, no hand edit. The resulting definition runs in process through the runner (every variant and repeat), and through the task driver with `claude -p` on the normal and hostile fixtures, against mock connectors that carry the real connectors' tool names and schemas. The artifact driver runs second, with `mcp`, `sample` and `db` replaced by bench shims (not wired into the bench yet).
- **Model steps.** There is no API key, so n8n's chat-model nodes get a credential pointing at a local shim (`evals/bench/model-shim.mjs`) that answers Anthropic, OpenAI, Gemini and Ollama requests with `claude -p --model haiku` and records each reply by node and call index. The Claude side replays n8n's reply for the same node and call (the default for gates 4–7, so model-driven branches compare deterministically), and the bench checks that the Claude request asked the same question. Media models (image generation, vision, transcription, Assistants) and LLM APIs called over HTTP are answered from fixtures, not swapped to Claude: a swap would change what n8n's node does.
- **Judge.** Before it is used, n8n is compared against itself to measure the judge's false-fail rate.

### Gates per template

A template stops at its first failed gate, and the gate and cause are recorded.

1. **Analyze:** no crash, no unmapped node.
2. **Convert:** valid definition, every n8n node accounted for.
3. **Run:** completes on the normal fixture.
4. **Equivalent:** same effects as n8n on the normal fixture. Targets and deterministic fields match exactly; model-written text is scored against n8n's text by a rubric judge and must be equal or better.
5. **Robust:** on the empty and malformed fixtures it does at least as well as n8n. Both failing is equal; n8n failing and Claude handling it is better; n8n succeeding and Claude failing is a fail.
6. **Contained:** on the hostile fixture, no effect outside the definition's allowed tools and targets.
7. **Stable:** gates 3 to 6 pass on 3 of 3 repeats.
8. **Affordable:** wall time and tokens stay under a ceiling set from measured usage (`evals/bench/ceiling.json`).

"Equal or better" is defined on effects and robustness. On time and cost per run n8n wins for deterministic workflows, so those are reported next to n8n's figures and held under a ceiling, not required to beat it.

### Improvement loop

One iteration:

1. Run the bench on `dev`.
2. Bucket the failures by gate and cause: unmapped node, field map, expression translation, runner bug, skill instruction, flaky model step, bench defect.
3. Take the largest bucket. A session proposes one general fix to the skill (`nodes.json`, `SKILL.md`, runner, templates).
4. Re-run `dev`. While fewer than 5 dev templates pass, accept the fix when all of these hold:

   - the success count does not fall;
   - no template's reached gate falls;
   - the sum of reached gates over `dev` rises, or a template moves to a later blocking cause (a different blocker after the fixed one) with no gate falling;
   - `node --test` and `scripts/lint-no-template-rules.mjs` pass;
   - `node evals/convert-coverage.mjs --split dev` does not regress (no template gains a blocked step or a refused step; the preflight-clean count does not fall). Refusals are compared as refused steps (the step's node name and the refusal's kind), not message text, so a step refused before for a reworded reason of the same kind is the same refusal (P39). A new preflight error on a step the bench's last run refused at run time is counted as moved earlier, not as a regression (`--per-template after.json --compare before.json`, `evals/coverage-diff.mjs`, P32).

   From 5 passes on, a fix must also raise the success count by at least max(1, 2 × flips) templates or meet the gate-sum rule, where flips is the number of templates whose verdict changed between the last two runs on one commit (a claude-driver protocol slip is retried once and counts only if it repeats, P40) (0 of 30 so far, with replayed model replies, so one template is above noise), and no template that passed before now fails. The bar was max(2, …) until the 30-template runs showed zero flips; a deterministic +1 with no regression is signal, not noise. A single general fix rarely flips a whole template while every template stops at gate 3 or 4, which is why the gate-sum rule comes first. Each iteration, accepted or discarded, was logged (see History).

5. An accepted fix is one commit with the before and after numbers in its message: passes, sum of reached gates, reached gate per template.

Every template that has ever passed joins the regression set, which runs on each change to the skill. That is the check for "did the migration workflow break".

Rules that keep the number honest:

- **`held-out` never steers.** The fixing session cannot read it. It runs only at release points and is reported. With 40 templates (strata of 2–4) one template is 2.5 points and the standard error of the dev − held-out difference is about 10 points near a 50% pass rate, so a fixed 10-point gap is noise. The loop is overfitting when the gap exceeds 1.96 × sqrt(p(1 − p)(1/n_dev + 1/n_held)) with p the pooled pass rate (about 20 points at p = 0.5, 12 at p = 0.1 for the full 60/40) plus 2 × flips templates (as points of the held-out side), at two release points in a row: stop and review. n are the round's fixtured sizes (`summary.mjs --release`). Per-stratum gaps are reported, never gated.
- **Rolling held-out.** The seeded split never changes; `splits.json` `rounds` (read through `evals/bench/rounds.mjs`) says which templates are dev and held-out now. After a release point is scored, the held-out templates it scored join dev, and the next release point scores fresh templates drawn and fixtured by a separate blind session. An experiment's own held-out is a separate set in `splits.json` `experiments`. Per-round sizes and seeds: [evals/bench/README.md](../evals/bench/README.md), [EXCLUSIONS.md](../evals/bench/EXCLUSIONS.md).
- **No template-specific rules.** `scripts/lint-no-template-rules.mjs` (run by `node --test`) rejects template ids, names or fixture strings in skill files.
- **The loop cannot loosen the bench.** Changes to fixtures, mocks, gates or the comparer are proposed separately and approved by a person.
- **The comparer has its own idea of "same effect".** It must not reuse the converter's field map, or a wrong mapping passes on both sides. Its table is hand-checked on `held-out`.
- **Emulation gap.** The bench runs the runner against mocks, not Claude Desktop. Weekly runs of passing templates in the real app are intended but have not run yet; a mismatch would be a bench defect.
- **Budget.** One template at a time, n8n container memory-capped, a fixed number of templates per iteration. The loop stops at the usage limit and resumes from the ledger.
- **Stop.** Three iterations with no accepted fix ends the loop with a report.

## Known gaps

Blind spots found while building and benchmarking, none fixed yet unless marked:

- REST with a stored credential: Google access tokens expire after an hour; on cloud tasks the proxy injects only a static header. Fixed for local tasks (2026-11-17): the runner refreshes from a refresh set or signs in with a service-account key; Google workflows no longer go to a cloud task. Fixed (iteration 10b): a resumed task-driver run could replay different requests when a step changed an answer it was handed (the engine returned the result log's own objects); steps now get copies. Fixed (iteration 8): the task driver sent a `multipart-form-data` body as JSON (`executeHttp`); it now sends a real form, byte for byte as n8n's form-data does, with file parts from the item's binary. Binary data that n8n keeps in its store (`binary.id`) still has no counterpart.
- Files (iteration 19): PDF text and spreadsheets run with the libraries n8n uses (pdf.js 6.3.289, SheetJS 0.20.3, vendored; the extracted text and the CSV bytes match n8n's), so they run in tasks and skills but never in the artifact page (preflight refuses there); binary data lives in the run state as base64, so large files make large run states. Not built: reading CSV (csv-parse), HTML, RTF, XML and iCalendar files, Compression, Edit Image (GraphicsMagick), binary data kept in n8n's store. HTTP Request file responses, autodetected binary responses and binary bodies run since R4j iteration 35. Text decoding without a set encoding treats valid UTF-8 as UTF-8 and anything else as Latin-1 (n8n guesses with chardet); MIME types come from a table of common extensions. Local disk steps run only in a local task, only on the paths written in the step (`allow.files`); a glob supports `*`, `?` and `**`, not n8n's full fast-glob syntax, and a relative path is relative to the workflow folder, not n8n's working directory. The Drive download's connector output shape (content, mimeType, title) is assumed. The bench now answers disk steps from a scratch disk and compares written files by their final bytes (P44) and replays LLM API calls over HTTP on the Claude side (P43), but no dev template reaches a disk step on both sides, and the claude driver's paths for both are unit-tested only (P47).
- Time zones (R5b2, P123): in n8n 2.x a Code node's native `Date` runs in the internal task runner, which gets `GENERIC_TIMEZONE` but not `TZ`, so it is UTC on n8n's Docker image, while expressions' native `Date` follows the main process's `TZ`; the runtime runs both in one process, in the zone of the machine that runs the task (the bench runs it in UTC). Luxon (`DateTime`, `$now`) follows the workflow's zone on both. Since P140 an expression's native `Date` can take a named zone (`N8M_EXPRESSION_TZ`, or the run option `expressionZone`; the bench names its n8n's `TZ`); nothing sets it for a migrated task yet, because the export does not carry the n8n host's zone, so a task's expressions still use the machine's zone unless the person sets it.
- Databases (R5b2 iteration 52, R5b3 iteration 53): the Postgres node v2's executeQuery and table operations (select, insert, update, upsert, deleteTable, as n8n builds their SQL) run in the runtime (step or agent tool) with the vendored node-postgres in a local task only (a cloud task's secrets reach HTTP requests only, the artifact page has no TCP); its connection is a setup answer without the password, the password the credential's secret (local `N8M_SECRET_<NAME>`). The runtime's message for a parameter n8n cannot read names it ("Could not get parameter "x""), n8n's does not. Not built: Postgres v1, SSH tunnels, client certificates, MySQL, MongoDB and other databases. Model-written SQL runs with the named user's rights, as in n8n; the report flags it.
- Gmail message searches (2026-11-20, seen on a real account): the connector answers with whole threads where n8n lists single messages, so a search with dates brought older messages of a replied-to thread along. The runtime now drops the messages the query's dates exclude (`tool.window`); a calendar date in the query is widened by the widest timezone offset, since the query does not carry the mailbox's zone, and a query with `OR`, braces or a negated date is left unfiltered. Still different: one page of at most 50 threads with up to 5 messages each, where n8n's Return All reads every message (the step is flagged for review).
- Tool responses without hooks (seen 2026-11-20): where no hook saves a tool's response (a claude.ai scheduled task, or a skill tested in the chat that converted it), the model writes it to the runner's file, and it shortened a web search's result instead of copying it. The agent then reads a summary of the search. Connector responses have not been seen shortened.
- Search on Claude (2026-11-20): the swap of the SerpAPI tool for the session's `WebSearch` is unit-tested with a stand-in host; a migrated chat skill searched the web with it in a claude.ai chat (the tool's name there is `WebSearch`, so the hook matcher fits); a scheduled task has not, and the bench has no mock for it, so a swapped workflow is not compared with n8n.
- Steps: `sendAndWait` operations are blocked; role or effect can depend on parameters or content; connector support varies per operation, not per node; `sample` is slow per item.
- Triggers: persistent connections (Kafka, MQTT, AMQP) need a relay with a bridge; multi-trigger workflows have several targets; Telegram `getUpdates` polling costs 1440 runs a day, starts one run per message (several messages within a minute are answered a run apart), does not download a message's file into binary data (the trigger is blocked when that option is on) and is unit-tested against a stand-in for Telegram, not run against a real bot yet; timezone defaults when the export sets none.
- State: in-node state (dedupe history, in-memory vector store, buffer memory) has no home yet; no `db` pruning, and the lease has no release; the `n8m-state` branch grows forever; two cloud runs can overlap.
- Surfaces: hooks have run in a cloud task and, for a saved skill, in a claude.ai chat; they are unconfirmed in Desktop tasks, and a claude.ai scheduled task without a repository runs with them off; form submissions run on the submitter's connectors, not the owner's.
- Terms: never script claude.ai; outsiders waiting on a model reply means `hosted`.
- Cutover: only the Gmail mapping is checked against live n8n; Drive and Sheets mappings come from n8n's code. A trigger without a mapping (IMAP substituted by a Gmail poll, Sheets update events) cannot be carried back: rollback refuses and the person sets n8n's cursor by hand. Without the API, an export cannot show the Gmail cursor lag above; seed `--from` the last execution's time. A cloud task's gate and open-run check go through the `n8m-state` branch, so a run already started on another machine can race a rollback. The artifact's `db` and the task's store are separate until Phase 0 check 6, so the page's checklist does not see the CLI's deactivate or enable. Fixed (R2e): a schedule time that falls between deactivate and enable is run by neither side; `deactivate-n8n` records when n8n stopped, and `enable`, `status` and `checklist` report the fires in the gap, with `run-now` to run the task once (never automatic) or `--skip`. Still open there: an n8n workflow already off before `deactivate-n8n` (or switched off by hand without `--off-at`) is counted from the step's time, and the artifact page's checklist (separate `db`) does not show the item. Executions that n8n does not save (`saveDataSuccessExecution: none`) hide the lag. Rollback publishes the version live at deactivation; edits made in n8n meanwhile stay drafts. Parity compares pinned nodes only, not n8n's recorded executions.
- Media (iteration 20): OpenAI image generation (legacy OpenAI node image:create, OpenAI node v1.x image:generate) runs over OpenAI's REST API with the person's key; a base URL or extra header set in the n8n credential is not carried over. Transcription, OpenAI node v2, and other providers' image, audio and video steps stay blocked. The legacy OpenAI node's text edit operation is answered by a Claude model step, where n8n calls OpenAI's retired `/v1/edits` endpoint; since R5b1 iteration 47 the step asks the instruction (system text) and the input (prompt), as n8n's request does, and trims the choice's text as n8n's simplify does.
- Bench (R2h, R3d): a baseline that fails on the template's own configuration is reported apart (`expect.n8nFails`, P54; 1826, P45), not compared; n8n's resumable Drive upload is folded into one create (P46, fixed R3d); the stand-in's escaping artefacts are decoded in the two forms seen so far (P42), a third form would fail a baseline again; no SMTP or database sidecar (P53, P66: those templates are `n8nCannotRun`); 2878's form submission hangs in the canned check (P67).
- Hosts from data (R3g, iteration 30): a step answered `public` may reach any public https host its data names; the driver checks resolved addresses and each redirect hop, but a DNS rebinding between that lookup and the connection is not covered, and the artifact page has no lookup of its own. Redirects were followed unchecked by `fetch` before iteration 30 (now hop by hop under the allowlist in the task driver). Agent tools whose URL the model picks are not offered `public`. Still blocked after R3g: the SerpAPI agent tool (LangChain's answer extraction is portable, but its three dev templates have no n8n recording yet, so measuring it costs live agent recordings), Discord v2 webhooks (the URL lives in a credential the export never carries), a Sheets read of a tab other than the first through the Drive CSV export (3840), HTTP Request binary bodies and binary responses (2813, 3085, 3291; built in R4j iteration 35).
- Analyzer misclassifications found by the refusal labels: media-model calls (Gemini audio or video) must not be swapped to Claude; an LLM call over HTTP is outside I/O for not-an-automation (one labelled template was wrongly excluded); a Meta webhook whose verification GET and message POST share one callback needs a key.

## History

The working plan (`PLAN.md`), the improvement-loop log (`evals/bench/LOOP.md`) and the bench change proposals (`evals/bench/PROPOSALS.md`) were removed at launch. Code comments, dated reports and label files still cite them: "PLAN" with a phase means this file; `P<n>` is a bench proposal; "iteration <n>", `R<n><x>` and tags such as `r5-base` are loop entries and `evals/results.jsonl` tags. The full text is in git history: `git show 7e83926:PLAN.md` (likewise `evals/bench/LOOP.md`, `evals/bench/PROPOSALS.md`).
