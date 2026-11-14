# Plan: n8n-to-claude

Move n8n workflows off n8n with Claude. Every workflow gets a classified outcome. Those that can, run on the person's own Claude subscription, are viewable as a graph in a Claude artifact, and send no token outside Claude's own surfaces. Those that cannot are reported with the reason and what they would need.

## Survey (2026-11-14)

What the 100 most-viewed n8n templates contain. Counted by node type, not by operation, so every eligibility figure is an upper bound. Scripts: `evals/survey/` (rough; the analyzer replaces them).

| Wake-up                                        | Templates |
| ---------------------------------------------- | --------- |
| Webhook, chat or form trigger                  | 45        |
| App trigger (Telegram, WhatsApp, Gmail, Drive) | 24        |
| Manual only                                    | 20        |
| Schedule                                       | 11        |

| Contents                                                         | Templates |
| ---------------------------------------------------------------- | --------- |
| LangChain nodes (51 have an AI Agent node)                       | 78        |
| HTTP Request node                                                | 54        |
| Code node                                                        | 35        |
| Wait node (every one is a time interval, none resume on webhook) | 17        |
| `pinData` present                                                | 7         |
| Tutorials about n8n itself                                       | about 8   |

Other findings:

- Sub-workflow calls: 46. 25 call the same workflow by expression, 4 are inline, 17 use a hard-coded id.
- Chat triggers: 29 templates, 5 set to public.
- Webhook nodes: 12, of which 10 reply synchronously.
- Node versions: 7 of the AI Agent node, 6 of Google Sheets, 5 each of If, Set and Merge.
- The author's own three n8n repos: 11 workflows, 3 scheduled. All three scheduled ones depend on Data Tables, Postgres or HTTP Request with stored credentials.

Eligibility as each lever is added, in build order:

| Lever                                                                 | Templates needing it | Cumulative eligible |
| --------------------------------------------------------------------- | -------------------- | ------------------- |
| None: logic, model steps, first-party connectors                      | n/a                  | 8                   |
| `agent` step, self-calling sub-workflows inlined                      | 53                   | 9                   |
| `http` step with stored secrets                                       | 73                   | 23                  |
| Media through the original provider (transcription, image generation) | 16                   | 25                  |
| Files in the script                                                   | 18                   | 28                  |
| Poll for Gmail, Drive and Sheets triggers                             | 7                    | 32                  |
| Chat trigger becomes a skill                                          | 28                   | 48                  |
| Form trigger becomes an artifact form                                 | 9                    | 56                  |
| Database through MCP or a driver                                      | 9                    | 61                  |
| Vector store through MCP                                              | 11                   | 68                  |
| Relay to the cloud task's API trigger                                 | 15                   | 83                  |

The other 17, and the best case for all 100:

| Outcome                    | Best case | What it depends on                                                                                                       |
| -------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------ |
| Runs on the subscription   | 87 to 93  | 8 need a bulk export, an approved substitution or a dropped error branch; 6 depend on who uses the endpoint or chat page |
| Replaced by Claude itself  | 2         | n8n acting as an MCP server, when Claude is the only client                                                              |
| Hosted elsewhere, no model | 3         | Synchronous endpoints with no model step (2 are n8n tutorials)                                                           |
| Hosted elsewhere, API key  | 2 to 8    | An outside caller waits for a model answer, or outsiders use a chat page                                                 |

## Decisions already made

- **Form:** one skill (`skills/n8n-to-claude/`) wrapped in a plugin. The same folder zips into an uploadable skill for chat-only users.
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
- **Generated workflows are self-contained.** They keep running if the skill is removed. See open decision 1.
- **The subscription token is never read, copied or passed to anything we ship.**
- **Third-party MCP servers are named as options, never installed for the person.**
- **The unattended path is what the bench grades.** The artifact path comes second.
- **The skill is improved by a measured loop, not by hand.** A bench migrates n8n templates in one shot, compares each against the original running in n8n, and failures drive the next change to the skill (Phases 5 and 6).

## Open decisions

Each has a recommended default so work is not blocked.

1. **Local runs: bundle one MCP server or stay dependency-free.** The server would offer `http_request`, key-value state and SQL, and resolve a credential by its n8n name from the OS keychain. Default: bundle it, and list it in `requires` for workflows that use it.
2. **`hosted` outcome: report only, or generate the function.** Default: report only in v1; generate no-model endpoints later.
3. **Relay: report only, or ship a forwarder.** Default: report only until Phase 0 confirms the API trigger.
4. **Database writes.** Default: parameterised statements stored in the definition, run by the bundled server or a driver under a least-privilege role. A vendor MCP with a free-form SQL tool is offered read-only.

## Phase 0: checks on real accounts

Checks run 2026-11-14 from a session without a test account, with quotes and status: [evals/phase0/CHECKS.md](evals/phase0/CHECKS.md).

The analyzer (Phase 1) does not wait for these. Everything else does. Each has a fallback, so a "no" changes the design, not the project. "Docs say" is from the public docs on 2026-11-14 and is untested.

| Check                                                                               | Docs say                                                                                                                                                                                                                           | If no                                                                         |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Pro can upload a custom skill in Desktop                                            |                                                                                                                                                                                                                                    | Ship as plugin only; chat-only users are out of scope                         |
| Pro can install a plugin in Cowork                                                  |                                                                                                                                                                                                                                    | Zip upload is the only Desktop path                                           |
| Artifacts on Pro get `mcp`, `sample` and `db`                                       | All three exist on the author's account                                                                                                                                                                                            | Artifact is view-only; all runs go through tasks                              |
| An artifact page can call arbitrary hosts                                           |                                                                                                                                                                                                                                    | "Run now" hands `http` steps to a task                                        |
| A cloud task runs a bundled script and connectors unattended, writes included       | Connectors are included and writes allowed; a classifier can block a call and leave a prompt waiting                                                                                                                               | Count stalls; route the workflow to a local task                              |
| A local task does the same                                                          | Each task has a permission mode; tools that need interaction prompt on every call                                                                                                                                                  | Body `script` needs a cloud task                                              |
| A scheduled run can write to the artifact's database                                |                                                                                                                                                                                                                                    | The run republishes the artifact with new history                             |
| Where runs happen                                                                   | Cloud tasks run with the computer off. Local tasks need the app open and the computer awake, with one catch-up run for the latest miss within 7 days                                                                               | README states it                                                              |
| Minimum interval and caps                                                           | Cloud: 1 hour minimum, 100 scheduled runs per account per hour. Local: 1 minute only when Claude sets the schedule; the forms allow 1 hour (2026-11-14)                                                                            | Sets the analyzer's thresholds                                                |
| A secret a script can use without the model seeing it                               | Cloud: network secrets injected by a proxy for listed hosts. Local: nothing documented                                                                                                                                             | Local needs open decision 1, or `http` steps are cloud only                   |
| Secrets for non-HTTP protocols (Postgres, SMTP) in a cloud task                     | Not documented                                                                                                                                                                                                                     | Database through a vendor MCP or an HTTP SQL endpoint; SMTP is a substitution |
| The API trigger accepts a payload from a forwarder                                  | POST to `/fire` with a bearer token and a beta header; `text` arrives marked as untrusted; 30 fires per task per hour                                                                                                              | `relay` stays report only                                                     |
| Custom connectors (for example Neon) work in cloud tasks and artifacts              | All connected connectors are included by default                                                                                                                                                                                   | Database and vector levers are local only                                     |
| A plugin-bundled MCP server works in local tasks                                    |                                                                                                                                                                                                                                    | Open decision 1 falls back to dependency-free                                 |
| What happens when the usage limit is hit mid-run                                    | Mid-run not documented; new runs are rejected until the window resets, unless usage credits are on, then they run on overage (2026-11-14)                                                                                          | The ledger treats every run as interruptible at any step                      |
| How `sample` calls and task runs count against usage                                | Tasks draw usage like interactive sessions; `sample` spends the viewer's usage                                                                                                                                                     | Decides the "fits" threshold in the report                                    |
| Which usage pool `claude -p` draws from                                             | No separate pool: signed in with a plan, `claude -p` and the Agent SDK draw from subscription limits; the separate credit was paused on 2026-06-15. Max, Ultra and Team get monthly API credits for a Console API key (2026-11-14) | Re-budget the bench and the loop                                              |
| Which runtime the chat sandbox has (Python, Node)                                   |                                                                                                                                                                                                                                    | Decides the analyzer's language                                               |
| Current terms allow all of the above on a subscription                              |                                                                                                                                                                                                                                    | Reword or drop the subscription promise                                       |
| n8n's template listing sorts by popularity and its terms allow download for testing | Sorting and download without auth work. Terms let other users "use and adapt" shared templates and have no scraping clause; `api.n8n.io/robots.txt` disallows all (2026-11-14)                                                     | Use a hand-picked list of template ids                                        |
| Local n8n runs a rewritten workflow headless from its CLI                           | Observed 2026-11-14 on 2.47.7: `n8n execute --id` starts only at a manual-type trigger and ignores pinned data; the internal REST API runs any trigger with pinned input ([HEADLESS.md](evals/n8n/HEADLESS.md))                    | Drive it through its API instead                                              |
| The real connectors' tool names and schemas can be captured for mocks               |                                                                                                                                                                                                                                    | Bench covers only connectors we can list                                      |

The checks are a dated, re-runnable list, because these are preview features. Run them on Pro, Max and Team.

Done when: the table is filled in with the date and what was observed, and moved into the README as the compatibility section.

## Phase 1: analyzer, shipped on its own

People deciding whether to move need the fit report first, and it depends on no preview feature and no model.

Input: one workflow, a bulk export, or pasted JSON. Sub-workflow ids are resolved across a bulk export. Output: a JSON report and a readable summary.

Per workflow the report gives:

- wake-up and body, with the nodes that decided each;
- outcome and target;
- `requires`: each connector, secret, MCP server, relay, substitution or missing export, marked for cloud task, local task and artifact;
- `questions` the file cannot settle: who calls this URL, do outsiders use this chat page, does this workflow id point to this workflow;
- blockers, by kind: `input-incomplete`, `substitution` (needs approval, for example SMTP to a mail API), `dropped-branch` (for example an error trigger), `not-an-automation`;
- credential names referenced (names only, never values), and inline secrets found in HTTP and Code nodes, redacted;
- runs per day and shortest interval, and whether that fits a cloud task, needs a local task, or needs a frequency change;
- state shared with other workflows (Data Tables, static data).

Files:

- `scripts/analyze.*`: single file, no dependencies. Also published as an `npx` command.
- `references/nodes.json`: keyed by node type, version, resource and operation. The skeleton is generated from the `n8n-nodes-base` package; anything not mapped is `unmapped`. A drift check runs on each n8n release.
- `references/capabilities.json`: lever to surface (cloud task, local task, artifact).
- `tests/fixtures/`: exports we wrote ourselves, one per outcome, blocker kind and question, with golden reports.

Done when: every fixture matches its golden report; a real export of 20+ workflows produces a report with no crash and no guessed node; the report reproduces or corrects the survey tables; and the author agrees with the report for the 11 workflows in the three sibling n8n repos.

Decisions taken here:

- **Manual target:** `artifact` only when every requirement is `ok` on the artifact surface; otherwise `skill` (Claude Code or Cowork, where secrets and the bundled server exist). The same applies to a sub-workflow with no caller. `outcome.reason` names what the artifact lacks.
- **Several triggers:** the most demanding wake-up decides the outcome. `outcome.alsoTargets` lists other trigger kinds that need a different target, for example chat → skill plus schedule → cloud task. Manual, sub-workflow and error triggers never get one.
- **LLM API over HTTP:** a POST to a known LLM API (`references/http-hosts.json`) is a `model` step with effect none, lever `llm-api` and a `model call → Claude` substitution requirement. It runs on the subscription instead of an API key.
- **Undetermined effects:** an HTTP or SQL step the file cannot settle counts as a write (`effectBy: assumed`). It joins one `writes` question per workflow, answered with true, false or node names.
- **Chat-app relays:** Telegram, WhatsApp and Twilio triggers, and a plain Webhook whose messaging step replies to the chat id in its body, ask who waits for the replies. The assumed answer, outsiders, gives `hosted`; only you gives a `local-task` polling Telegram's getUpdates every minute, or a relay to a `cloud-task` for providers without a polling API; messaging Claude instead gives `skill`; nobody waits gives `cloud-task`.
- **Directory connectors:** Jira, Confluence, ClickUp and HubSpot operations with a captured connector tool are connector steps, the rest stay `http` with a secret, and the REST path stays in the report as `alternative`.
- **Form target:** a form whose step cannot run in an artifact keeps the artifact form and adds a `task-handoff` requirement: a task picks the submission up and runs the steps.
- **Setup only:** a workflow that only creates and seeds n8n Data Tables from a manual run, or only manages n8n, keeps its outcome and gets `setupOnly`.
- **DST:** a time-of-day schedule in a zone with DST gets `schedule.dstNote`; the run counts still ignore DST.
- **Relay rate:** relay outcomes note the API trigger's limits and ask the peak event rate; over 100 an hour stays in n8n.
- **Execute Command** is a substitution to a local task's shell, not a blocker. **Debug Helper** is a logic step. The **n8n API node** stays a blocker.

Status 2026-11-14: every fixture matches its golden. 82 tests pass, including a robustness test that mutates every fixture. The report corrects the survey tables ([RECONCILE.md](evals/survey/RECONCILE.md)). With default answers the top 100 split into subscription 67 (skill 38, cloud task 9, local task 7, artifact form 7, artifact 6), replaced 1, hosted 21 and kept in n8n 11. Eligible after all levers: 67, not 83. If every answer favours moving, 94 run on the subscription. The biggest correction: the 15 Telegram and WhatsApp relays are chat bots whose users wait for replies. `llm-api` applies to 4 templates. Open questions fell from 154 to 90. All 7 artifact forms need a task hand-off. The sibling report is in [sibling-review.md](evals/sibling-review.md), with 11 of 11 rows judged correct now that the two Setup workflows are flagged setup only. A real bulk export now passes: 35 workflows (the 11 sibling ones and 24 templates) imported and exported by n8n 2.47.7 in all three export shapes give no crash, no unmapped node and the same report as the original files, after one fix ([EXPORT-CHECK.md](evals/n8n/EXPORT-CHECK.md)).

Remaining:

- The author's sign-off on the sibling review.
- Phase 0 should add a check on how long a cloud task takes to start from its API trigger, because the chat-app default depends on it.

## Phase 2: one workflow end to end

Build the thinnest slice before widening anything. Workflow: Schedule Trigger → one read connector → one model step → Slack message.

1. Hand-write its workflow definition (see Phase 3 for the shape).
2. Runner as code from the start, with both drivers.
3. Artifact that draws the graph and runs it from a button.
4. Cloud task and local task that run the same definition.
5. Run record appears in the artifact after each kind of run.

Measured here, because the answers shape everything after:

- payload fidelity through the model at 1, 50 and 500 items;
- stalls on a permission prompt, per run;
- a hostile read (text that asks for a different action) causes no effect outside the definition;
- where the single copy of the definition lives, since an artifact cannot read a local file.

Done when: the workflow has run unattended on a Pro account for three days, the artifact shows every run, and the four measurements are recorded.

Status 2026-11-14, task driver: built and measured with real `claude -p` (CLI 2.1.323, haiku and sonnet) against mock connectors with the real tool names, in 34 recorded runs ([MEASUREMENTS.md](evals/task-driver/MEASUREMENTS.md)).

How the driver works:

- `runner.mjs start|next|answer|result` hands the model one step at a time.
- A PreToolUse hook denies any connector call that is not the outstanding request with its exact arguments, and fills in the arguments from `{"n2c": "<q>"}`.
- A PostToolUse hook saves the response verbatim and hides it from the model.
- `convert.mjs` writes the minimal allowlist and the hooks into each folder.

The four measurements:

- **Fidelity:** with hooks on, the Slack arguments matched exactly at 1, 50 and 500 items on both models, with 0 transcription diffs in 4,697 leaves. With hooks off it was also exact up to 28.5 KB, but output tokens and cost grew with N. Above Claude Code's MCP output limit (between 28.5 and 57 KB) the model never sees the payload.
- **Stalls:** none. In `-p` a missing permission is denied at once and the run keeps its resume point.
- **Hostile read:** 0 calls outside the definition in 5 hostile runs. A session told to post elsewhere was stopped by the hook, even for a tool on the allowlist; with hooks off, that post got through.
- **Definition location:** a git repo holds the folder; the artifact embeds a copy and its hash; run records, cursors and the ledger go to the artifact `db`.

Cost per run: about $0.006–0.014 on haiku and $0.07–0.18 on sonnet at API prices, in 13–23 s, driven by 8–12 turns rather than by payload size.

Found on the way and fixed:

- An untrusted folder drops the project allowlist.
- A Bash heredoc holding JSON is denied, so answers go through `.n2c/inbox` files.
- An oversized connector response reaches the hook as a note naming a saved file; it had produced a silent "done" with 0 posts.

Still needs a real Pro account:

- three days unattended;
- whether cloud and Desktop tasks trust the repo's settings and run its hooks;
- the connector names and output shapes in a task;
- the usage-window share per run.

Status 2026-11-14, artifact driver: built and checked against a local shim of the runtime contract (0.2.96, [artifact-runtime.md](skills/n8n-to-claude/references/artifact-runtime.md)); see Phase 4. Item 5 (a run record after each kind of run) has the shared record shape in `runtime/src/records.mjs`: the page writes it to `db`, the task driver writes the same documents to `.n2c/records/`. Copying those into the artifact's `db` waits on Phase 0 check 6.

## Phase 3: workflow definition and converter

One neutral file per workflow, read by both drivers.

- Carries a schema version, validates against a JSON Schema, and sits beside the original export and its hash.
- Step kinds: `tool` (connector call), `http`, `code` (JavaScript), `model` (prompt), `agent` (model with tools and memory), `state`, `sleep`, `subflow`, `branch`, `loop`.
- The runner implements n8n's item model: per-item execution, paired items, Merge modes, references to another node's item.
- Edges carry over from n8n `connections`, so the graph matches what the person built.
- Each step records the n8n node it came from and a `review` flag.
- The definition fixes the allowed tools and their targets. SQL is stored as parameterised statements.
- Timezone comes from the workflow settings.

Conversion is split by how sure it is:

- Covered by `nodes.json`: translated by script.
- n8n expressions (`={{ $json.x }}`) and Code nodes: translated by Claude under the skill's instructions, flagged `review`.
- Blocked nodes: kept in the graph as greyed-out steps with the reason.
- Substitutions are applied only after the person approves them. Dropped branches are listed.

Safety during conversion:

- Sticky notes, node names and parameters are untrusted data, never instructions.
- Inline secrets are redacted before anything is written to a definition or an artifact.
- Code nodes from downloaded templates are shown for review and run sandboxed.

Levers are added in the survey's build order. Each lands with fixtures and is measured by the bench before the next starts.

A workflow regenerates from its stored export when the runner changes, so a fix reaches workflows already generated.

Done when: the Phase 2 workflow converts from its n8n export to the same definition we hand-wrote, and three more workflows of different shapes convert and run.

Status 2026-11-14: `scripts/convert.mjs` turns an export into one folder per workflow (definition, redacted source, report, overrides, runtime copy, MIGRATION.md) and `--regenerate` rebuilds it from the stored source and overrides. The slice converts to the definition hand-written before the converter (`tests/fixtures/convert/slice.*`); a chat agent, a poll workflow and a self-calling sub-workflow convert and run in-process with mock hosts. Corpus: 6 full, 12 with review steps, 49 with blocked steps, 33 refused, no crash ([convert-coverage.md](evals/convert-coverage.md)). Tool maps: `references/tool-maps.json`; every adapter that reads a tool's output is `unverified` until the bench checks it against real output. Agent tool calls are intents the runner executes (`definition.schema.json`, agent.tools).

## Phase 4: artifact and unattended runs

- `references/artifact.html`: graph, per-step status, "Run now", history, a dry-run switch.
- Artifact driver: `tool` steps through `mcp`, `model` steps through `sample`, history and poll cursors in `db`.
- `references/task-prompt.md`: the task prompt. It starts the runner and executes only the calls the runner hands over.
- `chat` workflows become a skill; `form` workflows become an artifact form for viewers inside the organisation.
- `relay` and `endpoint` workflows get a short generated note on what to put in front (including "keep n8n as the listener").

Run safety:

- **Preflight.** Before any effect, check that the definition's hash matches and every tool it names exists. Fail closed.
- **Effect ledger.** Each outgoing effect has a key written before it is sent and checked on resume. A rejected write is not proof it did not run.
- **Lock.** "Run now" and a scheduled run cannot overlap.
- **Interrupted runs.** A usage limit or a stalled prompt ends in a record and a resume point.
- **Alerts.** A failed run and a missed run (expected time passed, no record) both notify the person.
- **Poll cursor.** Work from a cursor, never from "since the last interval", because missed runs collapse into one.

Done when: one `schedule` and one `poll` workflow run unattended for three days with no duplicate, no missed item and every interruption recorded.

Status 2026-11-14, artifact page: `convert.mjs` writes `artifact.html` (from `references/artifact.html`) and `artifact.capabilities.json` into every converted folder. The page is about 670 KB with Luxon, the runner core and the driver inlined as one script (`dist/artifact-runtime.js`), so it loads nothing from a CDN; the page limit is 16 MB.

- Graph from the n8n positions and edges, sub-nodes as circles under their parent, blocked and review steps greyed with the reason, list view under 600 px; per-step status and items; Run now with dry run on by default; history of the latest 50 runs; the cutover checklist read from records.
- Driver: `tool` → `mcp.callTool`, `model` → `sample`, `agent` → `sample.json` with the runner executing tool-call intents, `http` and long waits → `handoff`. Preflight checks the embedded hash, the connectors listed, the runner's `preflight()` and the task's `meta/current` hash, and fails closed. The lock is a `db` lease; the effect ledger writes `sending` before each real write, and on resume a `sending` entry stops the run as unknown until the person decides.
- `evals/artifact/check.mjs` (Playwright, with `evals/artifact/shim.js`) passes 11 of 11: positions, dry-run would-send arguments equal to the in-process runner's, ledger `sending → sent`, the lock (same page, another page, a task lock, a stale lock), a tampered definition sending nothing, the http handoff, an interrupted send not resent, the chat agent through `sample`, screenshots at 375 to 1915 px in both themes with no horizontal scroll.

Still needs the real runtime: one publish on the author's account with the declared capabilities, then one `mcp` read, one `sample` call and one `db` write and read; the connector display names the publish result states; real connector payloads (adapters are still `unverified`); the consent prompts a viewer sees; and whether a scheduled task can write the `db` (Phase 0 check 6), which decides whether scheduled runs appear in the history.

Status 2026-11-14, the skill and run safety: `skills/n8n-to-claude/SKILL.md` (117 lines; detail in `references/translation.md`, `setup-cloud-task.md`, `setup-local-task.md`, `alerts.md`, `cutover.md` placeholder) takes the person from an export to a running target; headless mode takes the assumed answers and approves no substitution. Built, with in-process tests (`tests/task-safety.test.mjs`, `tests/run-safety.test.mjs`) and 7 `claude -p` runs:

- **Record store** (`runtime/src/store.mjs`): `file` for local tasks and skills; `git` for cloud tasks (records on branch `n2c-state`, committed through a private index, the checkout untouched; file when the folder is not in a checkout yet); `artifact-db` behind `artifactDb` (mirrors run records through ArtifactData).
- **Effect ledger in the task driver**: the PreToolUse hook writes `sending` before a write, the PostToolUse hook `sent` after; the run state is saved after every step. **Interrupted runs**: the next start resumes the open run with the same id (replay plus ledger), then starts the new one; a `sending` with no `sent` stops the workflow with "check before re-sending" until the person runs `resolve` in a terminal (refused without a TTY). Tested by deleting the checkout between requests and between `sending` and `sent`, with a file store and with a git store over a fresh clone.
- **Alerts**: `definition.alerts` and `allow.alerts` (its own category); a fixed template (workflow, step, error class, run id, counts), never payload text; one ledger key per event. **Missed runs** from the trigger's cron in its timezone (`runtime/src/schedule.mjs`) past a 15-minute grace, alerted before the run and shown in the artifact's history. No channel: the final line is the alert.
- **Cursors**: scheduled runs now read their cursor back (they never did) and save it when done; Run now in the artifact has its own `manual` cursor; only Seed (cutover) or the person's explicit choice copies one into the other.
- **Chat → skill**: `<folder>/skill/` (SKILL.md with hooks in its frontmatter, the definition, the runtime); `runner.mjs chat` runs one message. Measured (`evals/skill/results.jsonl`): done with the hooks on haiku, message in, `search_threads` then `slack_send_message` on the mocks, the reply out. Found on the way: dontAsk denies the Skill tool itself; Claude Code refuses writes under `.claude/skills/` (state moved to `<project>/.n2c/<skill>/`); `CLAUDE_SKILL_DIR` is not set for a skill's hook command, and a hook that cannot start is a non-blocking error, so every pre hook now ends in `|| exit 2`.
- **Form → artifact form**: the page renders the Form Trigger's fields and runs the workflow with n8n's item, or stores the submission for a task's `poll-submissions` source (behind `artifactDb`). `evals/artifact/check.mjs` 13/13 with the form and missed-run scenarios.
- **Several folders in one repo**: the `--out` folder is the repo; its root `.claude/settings.json` is the union of the folders' allowlists and `n2c-hook.mjs` routes each hook call to its folder. Measured once under `claude -p` (hostile fixture): exact Slack arguments, nothing outside the definition.
- Backlog: a text answer where JSON is read fails the step; the mocks enforce Slack's 40,000-character text and Gmail's page size of 50.

Needs a real account (Phase 0 rows 10–13 in CHECKS.md): whether a cloud task can push to `n2c-state`, whether a task can call ArtifactData (history from tasks, `poll-submissions`), whether cloud and Desktop tasks trust the repo settings and run its hooks, whether skill hooks run in Desktop and Cowork, and three days unattended.

## Phase 5: evaluation bench

Measures, with no real account touched, whether the skill migrates templates in one shot and whether the result behaves like the original.

### Corpus

- `evals/fetch.*` walks n8n's template listing by views until it has 100 templates the analyzer marks `subscription`, stratified by wake-up. Only ids and content hashes are committed; the downloaded JSON is git-ignored.
- Tutorials about n8n itself are excluded by a rule committed before the first run.
- Coverage of the top 100 is reported as its own number.
- Eligible templates are split 60/40 into `dev` and `held-out` by a seeded shuffle, committed before the first run.
- 20 templates with other outcomes are hand-labelled with the right outcome, blocker kind and questions. They measure whether the analyzer refuses for the right reason.

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
8. **Affordable:** wall time and tokens stay under a ceiling set from the Phase 0 usage numbers.

"Equal or better" is defined on effects and robustness. On time and cost per run n8n wins for deterministic workflows, so those are reported next to n8n's figures and held under a ceiling, not required to beat it.

### Numbers reported

- **Outcome shares:** runs on the subscription, replaced by Claude, hosted elsewhere, kept in n8n.
- **One-shot success:** share of eligible templates passing every gate, with the count beside it.
- **Coverage:** share of the top 100 with outcome `subscription`.
- **Refusal accuracy:** on the 20 labelled templates.
- **Per template:** wall time, tokens, share of a usage window, next to n8n's execution time.

Every result is appended to `evals/results.jsonl` with the template id, skill commit, gate reached, cause and metrics.

Done when: the bench runs end to end on 10 templates, and two runs on the same commit agree on every gate except steps flagged as model-written.

Status 2026-11-14 (P5b): built and run end to end on the 10 fixture templates ([evals/bench/README.md](evals/bench/README.md)); two runs on commit 8ef469d (`b1`, `b2`, both reusing the headless skill runs of `r1`) agree on every gate, cause and diagnostic, 10 of 10. One-shot success 0 of 10: 8 stop at gate 3 on blocked steps (files, database, LLM API over HTTP, OpenAI Assistants, forms that wait, Facebook Graph and WordPress without request templates, Drive move, Sheets), 2415 at gate 3 (the Notion connector's `notion-fetch` result has no `properties`, so a Code node fails) and 4722 at gate 4 (the agent's prompt renders an empty sender because `get_message`'s result has no `from` object; the writes themselves match). The headless skill run gave the same folder as plain `convert.mjs` on 10 of 10 and translated nothing. Contained held on the hostile fixtures of 2415 and 4722 in process and under the claude driver. Judge false fails: 1 of 2 judged pairs (n8n against n8n). 54 `claude -p` runs, $1.10 at API prices. HTTPS interception works on n8n 2.47.7 with `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS`. Gate 8's ceiling is provisional ([ceiling.json](evals/bench/ceiling.json)).

## Phase 6: improvement loop

One iteration:

1. Run the bench on `dev`.
2. Bucket the failures by gate and cause: unmapped node, field map, expression translation, runner bug, skill instruction, flaky model step, bench defect.
3. Take the largest bucket. A session proposes one general fix to the skill (`nodes.json`, `SKILL.md`, runner, templates).
4. Re-run `dev`. While fewer than 5 dev templates pass, accept the fix when all of these hold:
   - the success count does not fall;
   - no template's reached gate falls;
   - the sum of reached gates over `dev` rises, or a template moves to a later blocking cause (a different blocker after the fixed one) with no gate falling;
   - `node --test` and `scripts/lint-no-template-rules.mjs` pass;
   - `node evals/convert-coverage.mjs --split dev` does not regress (no template gains a blocked step or a preflight error; the preflight-clean count does not fall).

   From 5 passes on, the bar is the success count rising by at least max(2, 2 × flips) templates, where flips is the number of templates whose verdict changed between the last two runs on one commit (0 of 10 in Phase 5, with replayed model replies), and no template that passed before now fails. A single general fix rarely flips a whole template while every template stops at gate 3 or 4, which is why the gate-sum rule comes first. A discarded fix is recorded in `evals/bench/LOOP.md` (append-only: iteration, bucket, hypothesis, change, before/after, accepted or discarded).
5. An accepted fix is one commit with the before and after numbers in its message: passes, sum of reached gates, reached gate per template.

Every template that has ever passed joins the regression set, which runs on each change to the skill. That is the check for "did the migration workflow break".

Rules that keep the number honest:

- **`held-out` never steers.** The fixing session cannot read it. It runs only at release points and is reported. With 40 templates (strata of 2–4) one template is 2.5 points and the standard error of the dev − held-out difference is about 10 points near a 50% pass rate, so a fixed 10-point gap is noise. The loop is overfitting when the gap exceeds 1.96 × sqrt(p(1 − p)(1/60 + 1/40)) with p the pooled pass rate (about 20 points at p = 0.5, 12 at p = 0.1) plus 2 × flips templates, at two release points in a row: stop and review. Per-stratum gaps are reported, never gated.
- **No template-specific rules.** `scripts/lint-no-template-rules.mjs` (run by `node --test`) rejects template ids, names or fixture strings in skill files.
- **The loop cannot loosen the bench.** Changes to fixtures, mocks, gates or the comparer are proposed separately and approved by a person.
- **The comparer has its own idea of "same effect".** It must not reuse the converter's field map, or a wrong mapping passes on both sides. Its table is hand-checked on `held-out`.
- **Emulation is checked against the real app.** Weekly, five passing templates are migrated and run in Claude Desktop on the Pro account. A mismatch is a bench defect and goes to the front of the queue.
- **Budget.** One template at a time, n8n container memory-capped, a fixed number of templates per iteration. The loop stops at the usage limit and resumes from the ledger.
- **Stop.** Three iterations with no accepted fix ends the loop with a report.

A person approves each commit at first. After ten clean iterations the loop commits on its own and the person reviews the `held-out` report.

Done when: ten unattended iterations have run, `dev` success has risen, `held-out` is within the overfitting bound above, and no regression was merged.

## Phase 7: parity and cutover

- Dry run: write tools are stubbed and their inputs shown, so nothing is sent twice while n8n is still live.
- Where the export has `pinData`, replay it through the migrated workflow and show n8n's output next to ours. Few exports have it.
- Seed the poll cursor at cutover, so the first run does not replay history.
- Shared state moves first. Data Tables used by more than one workflow go to an external database both sides can reach, so workflows can move one at a time while n8n keeps the listeners.
- Rollback: disable the task, re-activate the n8n workflow, and carry the cursor back.
- Cutover checklist in the artifact: dry run clean → seed cursor → enable schedule → deactivate the n8n workflow.

Done when: a person can migrate a workflow, and roll it back, without any message being sent by both systems.

## Phase 8: package and launch

- The bench numbers (outcome shares, one-shot success, coverage of the top 100) are the README's headline stats.
- `.claude-plugin/` manifest and marketplace entry; zip for upload; listing on skills.sh.
- README in the hook / hero / stats / before-after shape, with the Phase 0 compatibility table and a line that the project is not affiliated with n8n or Anthropic.

## Out of scope for v1

- Synchronous webhook replies and public chat pages on the subscription (reported as `hosted`).
- Anything that must react in under a minute.
- A forwarder for `relay` workflows (reported, not built; see open decision 3).
- Sub-workflows missing from the export.
- Wait nodes that resume on a webhook.
- Community nodes, beyond one-off mappings.
- Error workflows (the runner's failure alert replaces them).
- Pulling from a live n8n instance.

## Risks

- **Usage allowance.** Runs share the usage window with normal chat. If Phase 0 shows only a few runs a day, the pitch becomes "your low-frequency workflows", and the report must say so per workflow.
- **Preview features.** Scheduled tasks and artifact capabilities can change. Keep each behind one file so a change is one edit.
- **Unattended is not guaranteed.** A classifier or a permission prompt can stall a run. Stalls are recorded and alerted, never silent.
- **Data passes through the model.** Connector results go through model context, which costs tokens, can alter large payloads and lets hostile text reach a session that holds write tools. The runner, the allowlist and the Contained gate are the defence.
- **Database access.** A free-form SQL tool in an unattended run can write anything, and a vendor's sign-in can cover a whole account. Writes use stored statements and a narrow role.
- **Third-party servers.** Each one adds trust and upkeep, and needs its own bench mock. Prefer `http` for breadth and MCP only where sign-in or the protocol requires it.
- **Upper-bound numbers.** The survey counts by node type. Operation-level mapping and the bench gates will lower every figure.
- **Emulation gap.** The bench runs the runner and mocks, not Claude Desktop itself. A green bench with a failing real app is the worst outcome, which is why the weekly real-app check outranks other work.
- **Chasing the number.** A loop rewarded on pass rate will find ways to pass. The held-out set, the lint and the locked bench are the defence; if any of them is weakened, the number stops meaning anything.
- **Loop cost.** Bench runs may draw on the same subscription as everything else, or on a separate pool. A full `dev` pass may take more than one usage window.
- **Thin moat.** Pasting the JSON into Claude already works for one workflow. The analyzer, the graph and the cutover safety are what this adds; cut anything that does not serve those.
- **Expression translation.** This is where silent wrong output comes from. Every model-translated step stays flagged until a dry run has passed.

### Known gaps

Blind spots gathered across Phases 1–6, none fixed yet unless marked:

- Steps: `sendAndWait` operations are blocked; role or effect can depend on parameters or content; connector support varies per operation, not per node; `sample` is slow per item.
- Triggers: persistent connections (Kafka, MQTT, AMQP) need a relay with a bridge; multi-trigger workflows have several targets; Telegram `getUpdates` polling costs 1440 runs a day; timezone defaults when the export sets none.
- State: in-node state (dedupe history, in-memory vector store, buffer memory) has no home yet; no `db` pruning, and the lease has no release; the `n2c-state` branch grows forever; two cloud runs can overlap.
- Surfaces: hooks are unconfirmed in cloud and Desktop tasks; form submissions run on the submitter's connectors, not the owner's.
- Terms (3.7): never script claude.ai; outsiders waiting on a model reply means `hosted`.
- Analyzer misclassifications found by the refusal labels: media-model calls (Gemini audio or video) must not be swapped to Claude; an LLM call over HTTP is outside I/O for not-an-automation (one labelled template was wrongly excluded); a Meta webhook whose verification GET and message POST share one callback needs a key.
