# Local task setup

For `outcome.target: local-task` (more often than hourly, the host shell, or a local-only lever). A Desktop scheduled task runs on the person's computer, only while the Claude app is open and the computer awake; a missed time gets one catch-up run within 7 days.

## Contract

| Piece       | Where it comes from                                                                                                                                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Folder      | the `--out` folder (`<repo>`), on this computer; a git repo is optional                                                                                                                                                                                                                                    |
| Prompt      | `<repo>/<folder>/task-prompt.md`                                                                                                                                                                                                                                                                           |
| Schedule    | the trigger's `schedule` (cron in `schedule.timezone`). Under an hour only when Claude sets the schedule; the form allows 1 hour                                                                                                                                                                           |
| Permissions | the root `.claude/settings.json` (dontAsk, runner, inbox, connector tools, hooks). The task's permission mode must not override it with prompts                                                                                                                                                            |
| Secrets     | `task.json` `secrets: "env"`: `N2C_SECRET_<NAME>` (credential name in capitals, other characters `_`). The person sets them in `<repo>/.claude/settings.local.json` `{"env": {...}}` (git-ignored) or the environment the app starts with. Unconfirmed that Desktop tasks pass settings `env` to the shell |
| Records     | `task.json` `store: {kind: "file"}`: `<folder>/.n2c/records/` (runs, cursors, ledger, open run state)                                                                                                                                                                                                      |

## Steps to give the person

1. Review `MIGRATION.md`; resolve flagged steps (`translation.md`).
2. Open `<repo>` once in Claude Code and accept the trust prompt (an untrusted folder drops the allowlist).
3. Set the secrets as above. Never handle the values.
4. In the Claude desktop app, create a scheduled task: folder `<repo>`, prompt = the folder's `task-prompt.md`, the schedule from the trigger.
5. Run it once (Run now). If a permission prompt appears for the runner command or a connector tool, choose "always allow" for exactly that; it should end with `DONE: run ... finished`.
6. Keep the computer awake at run times. A skipped run is reported as missed at the next run (`alerts.md`) and, for polls, picked up from the cursor.

## Recovery

An interrupted run resumes at the next start with the same run id. A write left unknown stops the workflow: the person checks the target, then runs `node <folder>/runtime/runner.mjs resolve <key> sent` (it went out) or `resend` (it did not) in a terminal.
