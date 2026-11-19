# Reference

Contracts and where they live. How each part works is in the comments at the
top of its file. `SKILL` is `skills/n8n-migrate/`.

## Commands

Node 20 or later, no install. All run from any folder.

| Command                                                                                                                                                       | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Exit                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `node SKILL/scripts/pull.mjs <source>... [--login addr [--register-again]] [--out d] [--active] [--env-file f] [--json]`                                      | Export files from n8n.io template links (`template:<id>`), `n8n` (every workflow) or editor links. Instance sources read over MCP after a browser sign-in with `--login` (OAuth; only workflows set Available in MCP), else over the REST API with `N8N_BASE_URL`/`N8N_API_KEY`. Sign-in details: the comment at the top of `scripts/n8n-oauth.mjs`                                                                                                                                                                                                  | 0, 1 some failed, 2 bad usage or none      |
| `node SKILL/scripts/start.mjs [<address\|link\|file>...] [--out d] [--api] [--env-file f] [--no-open] [--yes] [--no-setup] [--repo name]` (`npx n8n-migrate`) | Gets the workflows the easiest way (asks when nothing says), writes `report.html` + `report.json`, opens the page. At a terminal it then lists a plan and, on one go-ahead, converts into `<out>/flows`, commits it, pushes it to a new private GitHub repository when a workflow runs as a cloud task (`gh` signed in), writes the key names into `flows/.claude/settings.local.json` for the person to fill, and opens Claude Code there to create the tasks. `--yes`: convert and commit only, the rest printed. `--no-setup`: stop at the report | 0 report, 1 nothing to report, 2 bad usage |
| `node SKILL/scripts/analyze.mjs <path\|-> [--json] [--out f] [--html f] [--answers f] [--now ISO]`                                                            | The fit report for a file, a folder or a bulk export (`--html`: as a page). No model, no network                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 0 report, 2 bad input                      |
| `node SKILL/scripts/convert.mjs <export\|-> --out <repo> [--answers f] [--approve id,...]`                                                                    | One folder per workflow under `<repo>`, plus the repo-root settings and hook dispatcher                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 0, 1 failed, 2 bad input                   |
| `node SKILL/scripts/convert.mjs --regenerate <repo>/<folder>`                                                                                                 | Rebuild a folder from its stored export and `overrides.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 0, 1 failed, 2 bad input                   |
| `node SKILL/scripts/try-step.mjs <folder> <step> [--items i.json \| --pin]`                                                                                   | Run one step alone on sample items; requests are recorded, nothing is sent                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 0 done, 1 step failed, 2 bad input         |
| `node SKILL/scripts/cutover.mjs <folder> <step> [--json] [--force] [--login addr]`                                                                            | Cutover and rollback, one step at a time ([Cutover](#cutover))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 0 done, 1 refused or failed, 2 bad usage   |
| `node <folder>/runtime/runner.mjs start [--dry-run] \| next \| answer \| result \| status`                                                                    | The task driver, run by the scheduled task's session ([Runs](#runs))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 0 done, 10 needs host results, 1 failed, 2 |
| `node <folder>/runtime/runner.mjs resolve <effectKey> sent\|resend`                                                                                           | The person's answer for a write whose outcome is unknown; refused without a terminal                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | as the runner                              |
| `node scripts/skill.mjs check \| sync \| pack \| plugin-branch [--out d] [--push]`                                                                            | Package checks and builds for this repository                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 0, 1 problems                              |

Input shapes `analyze.mjs` and `convert.mjs` read: an export, a bulk export, an
API list, a template, the editor's clipboard, and MCP tool results saved as they
came (`get_workflow_details`, `n8n_get_workflow`, a `content` envelope): `unwrap`
in `analyze.mjs`.

Other flags: `convert.mjs --force-convert` (greyed graph for a refused
workflow), `--workflow <id|name>`. Every runner command: the comment at the
top of `SKILL/runtime/src/cli.mjs`.

## Report

Schema: `SKILL/references/report.schema.json`. Per workflow:

| Field             | Values                                                                                                                                                                                                                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wakeup.kind`     | `schedule`, `poll`, `chat`, `form`, `manual`, `relay` (pushed in, no reply awaited), `endpoint` (caller waits), `mcp-server`, `subworkflow`, `error`                                                                                                                                                                                   |
| `body.kind`       | `prompt`, `script`, `script+model`                                                                                                                                                                                                                                                                                                     |
| `outcome.kind`    | `subscription`, `replaced`, `hosted`, `keep-in-n8n`                                                                                                                                                                                                                                                                                    |
| `outcome.target`  | subscription: `cloud-task`, `local-task`, `skill`, `artifact-form`, `artifact`; hosted: `key`, `no-key`                                                                                                                                                                                                                                |
| `requires[].kind` | `connector`, `model`, `http`, `secret`, `db`, `vector`, `state`, `poll`, `relay`, `task-handoff`, `local-network`, `substitution`, `missing-export`, `frequency`, `bundled-server`, ...                                                                                                                                                |
| `blockers[].kind` | `input-incomplete`, `unsupported`, `unmapped`, `substitution`, `dropped-branch`, `not-an-automation`                                                                                                                                                                                                                                   |
| `questions[]`     | `id`, `text`, `options`, `assumed`; answer with `--answers {"<id>": <answer>}`                                                                                                                                                                                                                                                         |
| site question     | `<workflow id>/site/<credential name>`: the address of the person's own site for a credential that names one (WordPress `url`, n8n API `baseUrl`; an n8n address with no path gets `/api/v1`); requests go to it and the secret only to its host; a local address adds `local-network` (a local task); unanswered, the step is blocked |
| hosts question    | `<workflow id>/hosts/<step name>`: an HTTP Request whose host comes from data; a list of hosts, or `public` (any public https host; GET or HEAD without a credential only); unanswered, preflight refuses the step ([Runs](#runs), Hosts)                                                                                              |

## Outcomes

| Outcome                       | Means                                                                                      | What the skill does                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `subscription/cloud-task`     | Runs unattended on Anthropic's VM, at most hourly                                          | Folder + `setup-cloud-task.md`                                               |
| `subscription/local-task`     | Needs more often than hourly, or something only the computer has; app open, computer awake | Folder + `setup-local-task.md`                                               |
| `subscription/skill`          | A chat workflow: each message to the skill runs it                                         | Folder + `<folder>/skill/`                                                   |
| `subscription/artifact-form`  | A form trigger: an artifact page people in the organisation fill in                        | Folder + `artifact.html`; a task hand-off when a step cannot run in the page |
| `subscription/artifact`       | Manual, and every step can run in the page                                                 | Folder + `artifact.html`                                                     |
| `replaced`                    | n8n served tools to Claude (MCP server): Claude does it itself                             | Points to the connectors                                                     |
| `hosted/key`, `hosted/no-key` | An outside caller waits for the reply, or outsiders use the chat page                      | Report only; names what would host it                                        |
| `keep-in-n8n`                 | A blocker with no Claude counterpart (trigger, node, missing export)                       | Report only; names the blocker                                               |

Rules for edge cases (several triggers, LLM APIs over HTTP, chat-app relays,
directory connectors, DST): [DESIGN.md](DESIGN.md#analyzer-rules-for-edge-cases).

## Convert

Per folder (`SKILL/scripts/convert.mjs`, header comment):

| File                                          | Holds                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `definition.json`                             | Steps, edges, allowed tools and hosts, secrets by name (`SKILL/references/definition.schema.json`)                                                                                                                                                                                                                                                         |
| `source.n8n.json`                             | The export, inline secrets redacted; its sha256 is in the definition                                                                                                                                                                                                                                                                                       |
| `report.json`, `MIGRATION.md`                 | The analyzer's report; what moved, what is flagged or blocked, what it needs                                                                                                                                                                                                                                                                               |
| `overrides.json`                              | Translations, alert channel, host narrowing; survives `--regenerate`                                                                                                                                                                                                                                                                                       |
| `task.json`, `task-prompt.md`                 | Store, secrets mode, schedule; the task's prompt                                                                                                                                                                                                                                                                                                           |
| `artifact.html`, `artifact.capabilities.json` | The page and the capabilities to publish it with (`SKILL/references/artifact-runtime.md`)                                                                                                                                                                                                                                                                  |
| `runtime/`                                    | A copy of the runner, driver and hooks: the folder runs without the skill; `runtime/vendor/pdfjs/` and `runtime/vendor/xlsx/` (Apache-2.0, licence and checksums beside them, NOTICE.md) only when the definition has a PDF or spreadsheet step; `runtime/vendor/pg/` (node-postgres 8.21.0, MIT, as n8n 2.47.7 ships it) only when it has a Postgres step |

Printed status per workflow: `converted`, `review` (steps flagged),
`blocked-steps` (greyed with the reason), `refused` (not `subscription`:
`report.json` and `MIGRATION.md` only). A substitution (another service) is
applied only with `--approve <id>`; the same service over its REST API with
the person's key is not a substitution. Flagged steps:
`SKILL/references/translation.md`.

## Runs

- **Driver.** The session runs `runner.mjs start`, makes only the call it
  prints, and returns the result. Model answers go through `.n8m/inbox/`.
  Prompt: `SKILL/references/task-prompt.md`.
- **Fence.** Root `.claude/settings.json`: dontAsk, the runner, the listed
  connector tools. `n8m-hook.mjs` routes each hook call to its folder;
  PreToolUse refuses any call but the outstanding one with its exact
  arguments; PostToolUse stores the response and hides it from the model
  (`SKILL/runtime/src/hook.mjs`).
- **Preflight.** Definition hash, every named tool present, no blocked step
  reachable from a trigger. Fails closed.
- **Hosts.** `allow.http` holds the hosts and path prefixes written in each
  step; every request is checked against it at run time
  (`SKILL/runtime/src/engine.mjs` `checkContainment`), and a secret goes only
  to its own hosts. A URL built at run time that writes its own address in the
  expression (`'https://api.github.com/repos/' + …`) may reach only the
  addresses written there (`writtenTargets()`); one whose host comes from data
  (`{{ $json.url }}`, a sheet cell, a form field, a scraped link) gets the
  hosts question at setup. A list of hosts allows those hosts only (and the
  step's secret goes to them). `public` adds `{host: "*", scope: "public",
step}`: that step alone may reach any public https host, which is the honest
  answer for a scraper that visits sites from a list, and the person's explicit
  choice, recorded in the report and in `MIGRATION.md`. It is refused for a
  write method or a step with a credential (name the hosts instead), and on
  every request `engine.mjs` `publicHttpsUrl()` refuses plain http, a port, user
  info, IP literals in private, loopback, link-local (metadata), carrier-NAT and
  reserved ranges, IPv6 literals and local names (`localhost`, `.local`,
  `.internal`, …); in a task the driver also refuses a name that resolves to
  such an address (`publicAddress()`; a rebinding between that lookup and the
  connection is not covered). Unanswered, the step stays `*` and preflight
  refuses it. Agent tools whose URL the model picks are not asked about: they
  stay limited to the URLs written in the tool.
- **Redirects.** In a task the driver follows redirects itself, hop by hop:
  each hop is checked against `allow.http` (and a secret against its hosts)
  like a new request, so a redirect cannot carry a request or a credential to a
  host the definition does not allow.
- **HTML.** The HTML node's extraction (v1–1.2) and HTML Extract v1 run in the
  runtime with no library: `SKILL/runtime/src/htmldom.mjs` builds the trees
  cheerio 1.1 (parse5) and htmlparser2 8 build and matches css-select's
  selectors; `htmltext.mjs` is html-to-text 9.0.5's conversion (MIT, ported),
  which Html 1.2 uses for text. The Markdown node runs node-html-markdown
  1.2.0 on node-html-parser 5.4.2 (`htmlmarkdown.mjs`) and showdown 2.1.0
  (`showdown.mjs`), the MIT libraries n8n ships, kept as distributed. A
  selector or construct they do not carry refuses the step.
- **Files over HTTP.** An HTTP Request step's file response (or an
  autodetected binary type, n8n's list) becomes binary data as n8n builds it
  (name from `content-disposition` or the URL path, type from the response);
  a binary body sends the item's binary property typed by its `mimeType`. The
  task driver hands such responses back as `bodyBase64`; a host may also give
  a string, read as one character per byte under a binary content type.
- **Postgres.** The Postgres node v2's executeQuery and table operations
  (select, insert, update, upsert, deleteTable) run as a step or an agent
  tool, with the SQL n8n builds (`SKILL/runtime/src/postgres.mjs`), sent with
  the vendored node-postgres (`pgclient.mjs`) in a local task only: a cloud
  task's secrets reach HTTP requests only, and the artifact page has no TCP.
  The connection is a setup answer (a `postgres://` URL without the
  password); the password is the credential's secret. Other databases stay
  blocked.
- **n8n node.** Its workflow and execution reads run as an `http` step
  against the person's own n8n over its public API (`rest.mjs` `n8nApi`),
  the site a setup answer; they work only while that n8n runs. Writes,
  credentials and audit stay blocked.
- **Ledger.** `sending` before each write, `sent` after. A `sending` with no
  `sent` stops the workflow until `resolve`.
- **Resume.** The next start continues an open run with the same id (replay
  plus ledger), then starts the new one.
- **Cursors.** Poll triggers work from a stored cursor; `scheduled` and
  `manual` (Run now) cursors are separate.

Setup: `SKILL/references/setup-cloud-task.md`,
`SKILL/references/setup-local-task.md`.

## Records

Store per `task.json` `store` (`SKILL/runtime/src/store.mjs`,
`SKILL/runtime/src/records.mjs`): `file` at `<folder>/.n8m/records/` (local
task, skill); `git` on branch `n8m-state` under the folder's path, committed
through a private index and pushed (cloud task); `artifact-db` mirrors run
records to the page's database (off until a task can call it).

| Path                  | Body                                                                      |
| --------------------- | ------------------------------------------------------------------------- |
| `runs/<runId>`        | status, trigger, driver, dry run, step statuses, effects, cursors reached |
| `meta/current`        | definition hash of the running folder                                     |
| `meta/schedule`       | last run time, for missed-run detection                                   |
| `cutover/<at>-<step>` | one cutover step: by, ok, forced, detail                                  |
| `meta/cutover`        | owner (`n8n` or `claude`)                                                 |
| `meta/dry-run`        | the latest clean dry run                                                  |

## Alerts

Contract: `SKILL/references/alerts.md`. Channel in `overrides.json`
`alerts.channel` (Slack DM, Gmail draft or email to themselves), then
`--regenerate`. Events: `failed`, `missed` (scheduled fires past a 15-minute
grace), `needs-check` (a write's outcome unknown). Fixed template: workflow,
step, error class, run id, counts, times; never payload text. One ledger key
per event. No channel: the task's final line is the alert.

## Cutover

Contract: `SKILL/references/cutover.md`. One system sends at any moment;
n8n goes off before the task goes on.

| Step                        | Does                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `status`                    | Who sends, cursors, the next step                                                            |
| `dry-run`                   | Records a clean `runner.mjs start --dry-run`: reads go out, writes are held and shown        |
| `parity`                    | Optional: replays the export's `pinData` and compares each pinned node                       |
| `deactivate-n8n`            | Unpublishes the n8n workflow, waits for running executions, records n8n's cursor             |
| `seed`                      | Sets the scheduled cursor from n8n's cursor, or `--from <time\|row>`                         |
| `enable`                    | Opens the gate (owner `claude`), prints the task setup and schedule times missed in the gap  |
| `run-now`                   | For those missed times: how to run the task once (never automatic), or `--skip`              |
| `rollback`                  | Closes the gate, writes the cursor back into n8n's static data, republishes the live version |
| `checklist`, `shared-moved` | The artifact's checklist; marks shared n8n state as moved out                                |

Until `enable`, and after `rollback`, a scheduled start prints `HELD` and
reads nothing. n8n's API is used only with `N8N_BASE_URL` and `N8N_API_KEY`
in the environment; otherwise the steps are printed for the person. Steps
refuse to run out of order; `--force` is refused wherever it could make both
systems send. Cursor mappings checked live: Gmail only.

## Plugin and package

| Path                               | Role                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `.claude-plugin/plugin.json`       | Plugin manifest; version = `analyze.mjs` `VERSION` (`skill.mjs sync`)        |
| `.claude-plugin/marketplace.json`  | One-plugin marketplace (`/plugin marketplace add lunox-work/n8n-migrate`)    |
| `.claude-plugin/data.md`           | What is sent where; copied into the plugin branch's README                   |
| `.claude-plugin/icon.png`          | From `assets/icon.svg` (`node assets/src/render.mjs icon`)                   |
| `dist-skills/<name>-<version>.zip` | `skill.mjs pack`: the skill folder at HEAD, one top-level folder             |
| `claude-plugin` branch             | `skill.mjs plugin-branch --push`: only the plugin's files, for the directory |

## Bench

`evals/bench/README.md` (commands, gates, contract), `evals/bench/RELEASE-1.md`
to `evals/bench/RELEASE-5.md` (release points 1–5), `evals/results.jsonl`
(one row per template and run), `evals/convert-coverage-dev.md` (converter
coverage over the current round's dev templates), `evals/phase0/CHECKS.md`
(compatibility checks), `docs/DESIGN.md` (decisions, bench method, known gaps).
