# Cutover

Moving one converted workflow from n8n to its Claude target, and back (PLAN Phase 7). Files: `scripts/cutover.mjs` (the steps), `scripts/n8n-api.mjs` (n8n's API and static data), `runtime/src/records.mjs` (log, checklist), `runtime/src/driver.mjs` (dry run, gate), `evals/cutover/e2e.mjs` (the done test, in the repo).

## Rule

At any moment one system may send. n8n goes off before the task goes on. Items that arrive in between wait behind n8n's cursor, which the task starts from, so none is lost and none is sent twice. Rollback is the same in reverse.

## Steps

`node SKILL/scripts/cutover.mjs <folder> <step> [--json]`. Steps refuse to run out of order; `--force` overrides only an order that cannot make both systems send. Exit codes: 0 done, 1 refused or failed, 2 bad usage, 3 waiting for the person.

| Step             | Does                                                                                                                                                                                                                                    | Needs                                    | `--force`                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------- |
| `status`         | who sends, cursors, n8n's state (with the API), the next step                                                                                                                                                                           |                                          |                                                   |
| `dry-run`        | records the latest clean `runner.mjs start --dry-run` (run in a Claude session: reads go through connectors) and prints its held writes; runs it itself when the workflow has no connector or model step                                |                                          |                                                   |
| `parity`         | replays the export's `pinData`: pinned triggers, reads, writes and model steps are fed in, each pinned computing node is compared with ours; writes are stubbed. Not applicable without `pinData`                                       |                                          |                                                   |
| `deactivate-n8n` | unpublishes the n8n workflow, waits until no execution runs, records n8n's cursor and when n8n stopped (`offAt`). By hand: `--done [--n8n-export <file>] [--off-at <ISO>]` (when the person switched it off; else the step's time)      | clean dry run                            | yes: an early stop only pauses                    |
| `seed`           | sets the scheduled cursor from n8n's cursor, or `--from <ISO time \| row>`. Never from the dry run: n8n kept sending after it, and it read items n8n never polled                                                                       | `deactivate-n8n`                         | refused                                           |
| `enable`         | opens the gate (owner `claude`), prints the exact task setup for the target and the schedule times that fell while neither side ran (below)                                                                                             | `deactivate-n8n`, `seed` (poll triggers) | only for `seed`: the first run then skips the gap |
| `run-now`        | for those schedule times: says how to run the task once now (exit 3), finds that run in the task's records, or `--skip` records that they stay unrun. Never runs anything itself                                                        | `enable`                                 |                                                   |
| `rollback`       | closes the gate under the folder's lock, waits for an open run to end, writes the task's scheduled cursor into n8n's static data while unpublished, publishes the version that was live. By hand: prints the static data, then `--done` | `deactivate-n8n`                         | refused                                           |
| `checklist`      | the checklist as the artifact shows it                                                                                                                                                                                                  |                                          |                                                   |
| `shared-moved`   | `<kind:name> --to <where>`: the person moved shared n8n state out of n8n                                                                                                                                                                |                                          |                                                   |

Steps that change something are written to the folder's record store, the one the task uses (`task.json` `store`): `.n2c/records/` for a local task, branch `n2c-state` for a cloud task, which the CLI pushes as the task does.

## Records

| Path                  | Body                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `cutover/<at>-<step>` | `format, step, at, by (cli \| artifact), ok, forced, detail`. A `rollback` entry starts a new round; the checklist reads the last one |
| `meta/cutover`        | `format, owner (n8n \| claude), updatedAt, n8n {workflowId}`                                                                          |
| `meta/dry-run`        | `format, runId, status, definitionHash, startedAt, endedAt, wouldSend`                                                                |

The dry run's own record is `runs/<runId>` with `dryRun: true`, `wouldSend` and the `cursors` it reached; it saves no cursor and writes no ledger. The artifact page writes its clean dry run and its Seed to the same log in its `db`. Its Seed copies the dry run's cursor, which is right for Run now from the page; the task's cursor is the CLI's `seed`.

## Gate

From the first logged step until `enable`, and again after `rollback`, a scheduled `runner.mjs start` prints `HELD:`, reads nothing and continues no open run. A task created too early, or left on after a rollback, therefore sends nothing. Dry runs and chat skills are not held. A folder with no `meta/cutover` is not gated.

## The overlap window

The two orders when a cutover stops halfway:

- Enable first, the first run only seeding, then deactivate n8n: stopped between the two, every later task run and every n8n poll send the same items. The seeding run also skips what arrived between n8n's last poll and it.
- Deactivate n8n first, seed from its cursor, then enable (chosen): stopped between the two, items wait. The first run after `enable` sends them, once.

`evals/cutover/e2e.mjs` runs both against local n8n: the first order sent n8n's items a second time; with the chosen one, items that arrived while neither side was on (and a task run was held) went out once.

## Schedule times while neither side runs

Between `deactivate-n8n` and `enable` neither n8n nor the task runs the workflow. A poll trigger loses nothing (its items wait behind the cursor), but a schedule trigger's fires in that window run nowhere. They are counted from the definition's schedule trigger (`runtime/src/schedule.mjs` `expectedRuns`) between `offAt` (recorded by `deactivate-n8n`: just before the unpublish through the API; `--off-at` or the step's time by hand, marked inexact) and `enable`, and reported by `enable` (also kept in its log entry as `missedWhileOff`), by `status` (`gap`) and by `checklist` (item `missed-in-gap`, after the five above: `todo` until answered, next step `run-now`). Nothing runs them by itself. The answer is a task run after `enable` and before the next schedule time (one run at the current time, as n8n's next fire would be; it does not replay each missed time), found in the task's records, or `run-now --skip`. n8n does not catch up missed fires either, so a long gap is the person's call.

## Cursor mapping

| n8n node (2.47.7)                   | n8n's static data (`node:<name>`)                                                                              | Runner cursor                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Gmail poll (`gmailTrigger`)         | `lastTimeChecked` (seconds; `after:` is inclusive), `possibleDuplicates`; nested under the node name from v1.1 | `value` = that second, `ids`; cursor spec `resolutionMs: 1000` |
| Google Drive (`googleDriveTrigger`) | `lastTimeChecked` (ISO, the last poll's time); the query is `createdTime > ` (or `modifiedTime`)               | `value` = that time                                            |
| Google Sheets, `rowAdded`           | `lastIndexChecked` (rows read, header included), `documentId`, `sheetId` (kept from n8n's copy)                | `value` = last `row_number`                                    |

Other poll triggers are not converted. Rollback refuses a trigger it cannot map (n8n would send again what the task sent).

- n8n 2.47.7 saves a new Gmail node's cursor (v1.1+) only when the workflow is next loaded; until then its database holds the activation time. `deactivate-n8n` therefore also reads n8n's executions and takes the later cursor. In the e2e, static data alone would have replayed what n8n had sent.
- With `N8N_POLLER_DURABLE_CURSORS_ENABLED=true`, n8n keeps cursors in a table the API does not reach: do it by hand.

## n8n's public API

`N8N_BASE_URL` and `N8N_API_KEY` in the environment, never stored or printed. Observed on 2.47.7: `GET /workflows/{id}` returns `staticData`; `PUT /workflows/{id}?publishIfActive=false` replaces it (also while published, but the poller keeps its own copy, so it is written only while unpublished); `POST .../unpublish` and `.../publish {versionId}` keep it (`/deactivate` and `/activate` are their deprecated aliases); `GET /executions?workflowId&status=running` and `&includeData=true` give running executions and the trigger's emitted items. Scopes: `workflow:read`, `workflow:update`, `workflow:activate`, `workflow:deactivate`, `execution:list` (the e2e used a key with every scope).

Over a sign-in (`--login <address>`, `n8n-oauth.mjs` `mcpN8nClient`): n8n's MCP server with `workflow:write` and `execution:read`. `get_workflow_details` gives `active`/`activeVersionId` but no `staticData`; `unpublish_workflow` / `publish_workflow {versionId}`; `search_workflow_executions` (status `running`) and `get_workflow_execution {includeData, nodeNames}` give running executions and the trigger's emitted items. No tool reads or writes static data, so `deactivate-n8n` takes the cursor from executions alone and refuses poll triggers without `fromEmitted` (all but Gmail), and `rollback` refuses any poll trigger, both before calling n8n. Each step shows n8n's consent page (2.47 reuses consent only for first-party resources).

Without the API: switch the workflow off in n8n, export it with `n8n export:workflow --id=<id>` (static data included) and pass `--n8n-export`. Rollback prints the static data to put in that file before `n8n import:workflow`; the editor cannot change static data. An export cannot show the lag above, so seed `--from` the time of n8n's last execution when it is a fresh Gmail node.

## Shared state

The report's `sharedState` lists Data Tables and vector stores that other workflows in the export also use. `deactivate-n8n`, `seed` and `enable` refuse while one of them is still in n8n, with no `--force`. Move it to a database or sheet both sides reach, repoint n8n's workflows to it and check they still run, then `shared-moved "data-table:<name>" --to "<where>"`. From then on each workflow moves on its own. State kept inside one node (dedupe history, chat memory, static data a Code node writes) does not carry over.
