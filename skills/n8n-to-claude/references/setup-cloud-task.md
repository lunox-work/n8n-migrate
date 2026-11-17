# Cloud task setup

For a workflow with `outcome.target: cloud-task`. A cloud task (a routine) runs on Anthropic's VM with the computer off, cloning a repository each run. Facts and their status: `evals/phase0/CHECKS.md` in the n8n-to-claude repo; items marked unconfirmed need a run on a real account.

## Contract

| Piece       | Where it comes from                                                                                                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository  | the `--out` folder (`<repo>`): workflow folders, root `.claude/settings.json`, `n2c-hook.mjs`, `.gitignore`. Private GitHub repo                                                                                                              |
| Prompt      | `<repo>/<folder>/task-prompt.md`, as is (it starts `node <folder>/runtime/runner.mjs start`)                                                                                                                                                  |
| Schedule    | the trigger step's `schedule.cron` in `schedule.timezone` (definition.json). Cloud tasks reject more often than hourly; a run on the hour can start minutes late                                                                              |
| Connectors  | each `allow.tools[].connector` (and the alert channel's) connected on the account. All connected connectors are included by default                                                                                                           |
| Network     | the environment's allowed domains must include every `allow.http[].host` (MIGRATION.md lists them); the default environment refuses other hosts at its egress proxy (observed 2026-11-17). A step answered `public` needs full network access |
| Secrets     | each `definition.secrets[]`: an environment network secret named as the credential, for exactly its `hosts`. `task.json` `secrets: "proxy"`: the request goes out without it and the proxy adds it                                            |
| Records     | `task.json` `store: {kind: "git"}`: run records, cursors, the ledger and an open run's state on branch `n2c-state`, under the folder's path. Never on `main`                                                                                  |
| Permissions | the root `.claude/settings.json`: dontAsk, the runner command, writes to `.n2c/inbox/`, the connector tools; hooks refuse any call that is not the runner's request                                                                           |

## Steps to give the person (do none of them without a go-ahead)

1. Review `MIGRATION.md` of each folder; resolve flagged steps first (`translation.md`).
2. `cd <repo> && git init && git add . && git commit -m "n8n workflows migrated"`; create a private GitHub repo and push `main`. No secret is in the files; `.n2c/` is ignored.
3. In Claude (web, Code), create a scheduled cloud task on that repo: paste the folder's `task-prompt.md`; set the schedule from `schedule.cron` converted to the form's timezone (say the converted time in words, e.g. "08:00 Singapore = 00:00 UTC"); schedule a few minutes past the hour when the cron says `:00`.
4. In the task's environment, add every host from MIGRATION.md's "Allowed targets" to the allowed domains (or the HTTP steps fail with a refused connection), then add each secret as a network secret for its listed hosts only. The person types the values; never handle them.
5. The task pushes its records to `n2c-state` with the session's GitHub access (observed 2026-11-17 on the default environment). If the first run's records do not appear there, switch the workflow to a local task, or accept that poll workflows replay without a cursor (do not, for writes).
6. Run it once from the task page (Run now) and read the session: it should end with one `DONE: run ... finished` line. Check `n2c-state` holds `runs/<id>.json`.
7. Optional: publish the folder's `artifact.html` to watch runs (history from the task needs a task that can write the artifact's database: unconfirmed).

## What a run does

The session runs the runner, makes only the calls it prints, and writes model answers to `.n2c/inbox/`. A usage limit or a stall ends the session with the run's state on `n2c-state`; the next scheduled run resumes it first (same run id, nothing sent twice), then runs its own. A write whose outcome is unknown stops the workflow until the person runs `node <folder>/runtime/runner.mjs resolve <key> sent|resend` in a terminal on a checkout (and pushes). Missed runs and failures alert (`alerts.md`).

## Unconfirmed (Phase 0)

- Whether a cloud task trusts the repo's `.claude/settings.json` and runs its hooks. Without hooks the runner degrades to the model saving responses itself (slower; still contained by the allowlist and the definition).
- Connector tool names in a task (the definition uses the names seen in Claude Code).
