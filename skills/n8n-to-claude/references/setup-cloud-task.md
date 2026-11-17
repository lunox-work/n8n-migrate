# Cloud task setup

For a workflow with `outcome.target: cloud-task`. A cloud task (a routine) runs on Anthropic's VM with the computer off, cloning a repository each run. Facts and their status: `evals/phase0/CHECKS.md` in the n8n-to-claude repo; items marked unconfirmed need a run on a real account.

## Contract

| Piece       | Where it comes from                                                                                                                                                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository  | the `--out` folder (`<repo>`): workflow folders, root `.claude/settings.json`, `n2c-hook.mjs`, `.gitignore`. Private GitHub repo                                                                                                                                                                                                      |
| Prompt      | `<repo>/<folder>/task-prompt.md`, as is (it starts `node <folder>/runtime/runner.mjs start`)                                                                                                                                                                                                                                          |
| Schedule    | the trigger step's `schedule.cron` in `schedule.timezone` (definition.json). Cloud tasks reject more often than hourly; a run on the hour can start minutes late                                                                                                                                                                      |
| Connectors  | each `allow.tools[].connector` (and the alert channel's) connected on the account and attached to the task under its own name (the default): the session calls them `mcp__<Name>__<tool>` (`mcp__Notion__`, `mcp__Google-Drive__`), as the folder's task.json and settings say. Each tool the workflow uses must run without approval |
| Network     | the environment's allowed domains must include every `allow.http[].host` (MIGRATION.md lists them); the default environment refuses other hosts at its egress proxy (observed 2026-11-17). A step answered `public` needs full network access                                                                                         |
| Secrets     | each `definition.secrets[]`: an environment network secret named as the credential, for exactly its `hosts`. `task.json` `secrets: "proxy"`: the request goes out without it and the proxy adds it                                                                                                                                    |
| Records     | `task.json` `store: {kind: "git"}`: run records, cursors, the ledger and an open run's state on branch `n2c-state`, under the folder's path. Never on `main`                                                                                                                                                                          |
| Permissions | the root `.claude/settings.json`: dontAsk, the runner command, writes to `.n2c/inbox/`, the connector tools; hooks refuse any call that is not the runner's request                                                                                                                                                                   |

## Steps to give the person (do none of them without a go-ahead)

1. Review `MIGRATION.md` of each folder; resolve flagged steps first (`translation.md`).
2. `cd <repo> && git init && git add . && git commit -m "n8n workflows migrated"`; create a private GitHub repo and push `main`. No secret is in the files; `.n2c/` is ignored.
3. Create a cloud environment for the migrated workflows (Settings > Code > Cloud environments > New, e.g. "n8n workflows"), rather than widening Default: Network access Limited, allowed domains = every host from MIGRATION.md's "Allowed targets" (the HTTP steps fail with a refused connection otherwise), plus each secret as a network secret for its listed hosts only. The person types the values; never handle them. The person's other cloud sessions keep their own network, and the list doubles as a record of where the workflows reach.
4. In Claude (web, Code), create a scheduled cloud task on that repo, in that environment: paste the folder's `task-prompt.md`; set the schedule from `schedule.cron` converted to the form's timezone (say the converted time in words, e.g. "08:00 Singapore = 00:00 UTC"); schedule a few minutes past the hour when the cron says `:00`.
5. The task pushes its records to `n2c-state` with the session's GitHub access (observed 2026-11-17). If the first run's records do not appear there, switch the workflow to a local task, or accept that poll workflows replay without a cursor (do not, for writes).
6. Run it once from the task page (Run now) and read the session: it should end with one `DONE: run ... finished` line. Check `n2c-state` holds `runs/<id>.json`.
7. Optional: publish the folder's `artifact.html` to watch runs. To have scheduled runs appear in its history (observed 2026-11-17), set task.json `artifactDb: true`, `artifactUrl: <the page's link>` and `toolPrefixes["artifact-db"]: ""`, and add `ArtifactData` to the root `.claude/settings.json` allow list and to the task's allowed tools. The store stays `git` (ledger and cursors on `n2c-state`); each finished run is also handed to the session as one `ArtifactData` batch, which the hook checks like any call. A session killed before that batch leaves a gap in the page's history, never in the records.

## What a run does

The session runs the runner, makes only the calls it prints, and writes model answers to `.n2c/inbox/`. A usage limit or a stall ends the session with the run's state on `n2c-state`; the next scheduled run resumes it first (same run id, nothing sent twice), then runs its own. A write whose outcome is unknown stops the workflow until the person runs `node <folder>/runtime/runner.mjs resolve <key> sent|resend` in a terminal on a checkout (and pushes). Missed runs and failures alert (`alerts.md`).

## Observed (2026-11-17)

- A cloud task trusts the repo's root `.claude/settings.json` and runs its hooks: `n2c-hook.mjs` refused an `ArtifactData` call that no run had requested.
- A cloud task can call `ArtifactData` (read and batch write) on the person's artifact from a Limited environment with no artifact domains added.
- Egress goes through the environment's proxy; the runner relaunches Node with `NODE_USE_ENV_PROXY=1` so `fetch` uses it.

## Observed (2026-11-18)

- A cloud task's session names connector tools after the routine's connection (`mcp__Notion__notion-connector-search`), not `mcp__claude_ai_Notion__` as on this machine: a cloud-task folder is converted with those names.
- The session was offered 37 of the Notion connector's tools and not `notion-search`, `notion-fetch`, `notion-query-data-sources` or the page writes, whatever the routine's connection listed. The run failed at that step with the tool missing, nothing invented. Likely cause, unconfirmed: tools that need approval are not offered unattended. Before the first run, open the connector's settings on claude.ai and set each tool the workflow uses to run without approval; then Run now and check the step.

## Unconfirmed

- Which connector tools a cloud task gets, and why some are missing (above).
