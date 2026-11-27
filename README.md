# n8n-to-claude

Move n8n workflows onto Claude. A fit report classifies every workflow in an export with the reason (scheduled task, skill, artifact form, hosting, or stays in n8n), then each one that fits becomes a self-contained folder: a definition a code runner executes step by step, the task prompt and permissions, and an artifact page with the graph and Run now. Cutover turns n8n off before Claude goes on.

## Skills

- **n8n-to-claude**: Move n8n workflows off n8n and onto Claude. Reads an n8n export (pasted JSON, a file, a folder or a bulk `n8n export:workflow --all`), classifies every workflow with the reason (runs on the Claude subscription as a cloud task, a local task, a skill or an artifact form; replaced by Claude; needs hosting; stays in n8n), asks what the file cannot settle, then converts each workflow into a self-contained folder: a definition a code runner executes step by step, the scheduled-task prompt and permissions, an artifact page with the graph and Run now, and for chat workflows a skill. Use when someone wants to move, migrate or port n8n workflows to Claude, asks whether an n8n workflow can run on Claude (or on their Claude subscription instead of n8n), wants an n8n automation as a Claude scheduled task, or pastes n8n workflow JSON (an object with "nodes" and "connections").

## Examples

- "Here's my n8n export, `workflows.json`. Which of these workflows can run on
  my Claude subscription instead of n8n?" The skill runs the fit report and
  gives each workflow's outcome with its reason.
- "Move my daily sales digest workflow to a Claude scheduled task, and show me
  a dry run before anything is sent." The skill converts the workflow, sets
  up a copy with sending held, and says what it would have sent.
- "Cut over the Slack alert workflow: switch it off in n8n and on in Claude
  without anything being sent twice." The skill walks the cutover steps in
  order, with a rollback.

## Install

```sh
claude plugin marketplace add lunox-work/n8n-to-claude
claude plugin install n8n-to-claude@n8n-to-claude
```

## Requirements

- **n8n-to-claude**: Node 20 or later and npm. Runs the n8n-to-claude@0.4.0 CLI from npm (npx), which downloads it from registry.npmjs.org on first use. Works in Claude Code, and in Cowork with Node.

## Links

- [Privacy](https://github.com/lunox-work/n8n-to-claude/blob/main/PRIVACY.md)
- [Terms](https://lunox.work/terms)
- [Documentation](https://github.com/lunox-work/n8n-to-claude/blob/main/docs/REFERENCE.md)
- [Support](https://github.com/lunox-work/n8n-to-claude/issues)

## Data

- **The plugin runs the CLI from npm:** the plugin's copy of the skill ships
  no scripts; it runs each command as `npx n8n-to-claude@<version> <command>`,
  which downloads that package from registry.npmjs.org on first use. Nothing
  of the person's goes with that download.
- **Sent off the machine by the skill:** nothing of its own. The analyzer and
  the converter make no network call and call no model. There is no telemetry
  and nothing reaches the author. The optional drafting pass (`draft.mjs`), run
  only with the person's go-ahead, sends a blocked step's node type, operation
  and redacted parameters to the person's own Claude through `claude -p`.
- **When a converted workflow runs:** it reaches the services the n8n workflow
  already used, through the person's connectors or the workflow's own HTTP
  requests, limited to the tools and hosts its definition allows. Connector
  results and model-step inputs pass through the person's own Claude session.
- **Reading workflows:** from an export file, from n8n.io (a template, fetched
  by its id), or from the person's own n8n, after a browser sign-in whose
  tokens stay in memory for that run, or with `N8N_BASE_URL` and `N8N_API_KEY`
  from the environment.
- **n8n:** the cutover steps call the person's n8n instance with that sign-in
  or that key; without either they print the steps to do by hand.
- **GitHub:** `npx n8n-to-claude`, on the person's go-ahead, pushes the converted
  folders (redacted exports, never a key) to a new private repository on their
  own account when a workflow runs as a cloud task.
- **`serve`:** runs converted folders on a computer the person controls as a
  connector they add themselves; `--tunnel` passes that traffic through a
  temporary Cloudflare tunnel.
- **Secrets:** read by credential name only. The skill never asks for, prints
  or copies a value; inline keys in an export are redacted before anything is
  written. The person stores each secret (a cloud task's network secret, or
  `N8M_SECRET_<NAME>` in a git-ignored local settings file).
- **Personal data:** exports can carry the owner's name and email; the report
  never repeats them.
- **Retention:** run records, cursors and the effect ledger stay in the
  workflow's folder (`.n8m/`), on a branch of the person's own repository
  (`n8m-state`), or in the artifact's database the person publishes. `serve`
  keeps its records, its token and the keys the person types in the folder's
  `.n8m/`, git-ignored.

## Source

This branch holds only the plugin's files. The evaluation bench, tests and
documentation are on the main branch of https://github.com/lunox-work/n8n-to-claude. License: MIT.
