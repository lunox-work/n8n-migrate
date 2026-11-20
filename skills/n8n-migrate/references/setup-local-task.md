# Local task setup

For `outcome.target: local-task` (more often than hourly, the host shell, or a local-only lever). A Desktop scheduled task runs on the person's computer, only while the Claude app is open and the computer awake; a missed time gets one catch-up run within 7 days.

## Contract

| Piece       | Where it comes from                                                                                                                                                                                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Folder      | the `--out` folder (`<repo>`), on this computer; a git repo is optional                                                                                                                                                                                                                                    |
| Prompt      | `<repo>/<folder>/task-prompt.md`                                                                                                                                                                                                                                                                           |
| Schedule    | the trigger's `schedule` (cron in `schedule.timezone`). Under an hour only when Claude sets the schedule; the form allows 1 hour                                                                                                                                                                           |
| Permissions | the root `.claude/settings.json` (dontAsk, runner, inbox, connector tools, hooks). The task's permission mode must not override it with prompts                                                                                                                                                            |
| Secrets     | `task.json` `secrets: "env"`: `N8M_SECRET_<NAME>` (credential name in capitals, other characters `_`). The person sets them in `<repo>/.claude/settings.local.json` `{"env": {...}}` (git-ignored) or the environment the app starts with. Unconfirmed that Desktop tasks pass settings `env` to the shell |
| Records     | `task.json` `store: {kind: "file"}`: `<folder>/.n8m/records/` (runs, cursors, ledger, open run state)                                                                                                                                                                                                      |

## Steps to give the person

1. Review `MIGRATION.md`; resolve flagged steps (`translation.md`).
2. Open `<repo>` once in Claude Code and accept the trust prompt (an untrusted folder drops the allowlist).
3. Set the secrets as above. Never handle the values. For a Google credential (a Sheets or Calendar step; the report's requirement `google-token`), a Google access token lasts an hour, so the value should be what lets the runner mint a new one for each request: the OAuth client's JSON `{"client_id": "...", "client_secret": "...", "refresh_token": "..."}` (the client and refresh token behind the n8n credential), or a service-account key file's JSON (`client_email`, `private_key`; add `"delegated_email"` to act as a user, as n8n's impersonation does, and share the sheet or calendar with the service account otherwise). A plain access token also works, for one hour.
4. In the Claude desktop app (Code tab, **Scheduled** > **New task** > **Set up manually**): name it, paste the folder's `task-prompt.md` as the instructions, turn on **Advanced settings > Only on this computer**, pick `<repo>` as the **Local folder** and a **Trigger**. The form goes no faster than hourly; for a shorter interval, ask Claude in a Desktop session to create the task with that schedule (the docs say it is not held to the hourly minimum). Observed 2026-11-18: a task made this way on the test repo ran to `DONE` (run-2142abfd5518).
5. Run it once (Run now). If a permission prompt appears for the runner command or a connector tool, choose "always allow" for exactly that; it should end with `DONE: run ... finished`.
6. Keep the computer awake at run times. A skipped run is reported as missed at the next run (`alerts.md`) and, for polls, picked up from the cursor.

## Recovery

An interrupted run resumes at the next start with the same run id. A write left unknown stops the workflow: the person checks the target, then runs `node <folder>/runtime/runner.mjs resolve <key> sent` (it went out) or `resend` (it did not) in a terminal.