# n8n-to-claude

Move n8n workflows onto Claude. A fit report classifies every workflow in an export with the reason (scheduled task, skill, artifact form, hosting, or stays in n8n), then each one that fits becomes a self-contained folder: a definition a code runner executes step by step, the task prompt and permissions, and an artifact page with the graph and Run now. Cutover turns n8n off before Claude goes on.

## Skills

- **n8n-to-claude**: Move n8n workflows off n8n and onto Claude. Reads an n8n export (pasted JSON, a file, a folder or a bulk `n8n export:workflow --all`), classifies every workflow with the reason (runs on the Claude subscription as a cloud task, a local task, a skill or an artifact form; replaced by Claude; needs hosting; stays in n8n), asks what the file cannot settle, then converts each workflow into a self-contained folder: a definition a code runner executes step by step, the scheduled-task prompt and permissions, an artifact page with the graph and Run now, and for chat workflows a skill. Use when someone wants to move, migrate or port n8n workflows to Claude, asks whether an n8n workflow can run on Claude (or on their Claude subscription instead of n8n), wants an n8n automation as a Claude scheduled task, or pastes n8n workflow JSON (an object with "nodes" and "connections").

## Install

```sh
claude plugin marketplace add lunox-work/n8n-to-claude
claude plugin install n8n-to-claude@n8n-to-claude
```

## Requirements

- **n8n-to-claude**: Node 20 or later; zero dependencies. Works in Claude Code and in Cowork or Desktop where a shell with Node is available, and in the chat code sandbox if it has Node (not confirmed yet). Without Node, say so: the analyzer cannot run under Python only.

## Data

- **Sent off the machine by the skill:** nothing of its own. The analyzer and
  the converter make no network call and call no model. There is no telemetry
  and nothing reaches the author. The optional drafting pass (`draft.mjs`), run
  only with the person's go-ahead, sends a blocked step's node type, operation
  and redacted parameters to the person's own Claude through `claude -p`.
- **When a converted workflow runs:** it reaches the services the n8n workflow
  already used, through the person's connectors or the workflow's own HTTP
  requests, limited to the tools and hosts its definition allows. Connector
  results and model-step inputs pass through the person's own Claude session.
- **n8n:** the cutover steps call the person's n8n instance through its public
  API only when `N8N_BASE_URL` and `N8N_API_KEY` are set in the environment;
  otherwise they print the steps to do by hand.
- **Secrets:** read by credential name only. The skill never asks for, prints
  or copies a value; inline keys in an export are redacted before anything is
  written. The person stores each secret (a cloud task's network secret, or
  `N2C_SECRET_<NAME>` in a git-ignored local settings file).
- **Personal data:** exports can carry the owner's name and email; the report
  never repeats them.
- **Retention:** run records, cursors and the effect ledger stay in the
  workflow's folder (`.n2c/`), on a branch of the person's own repository
  (`n2c-state`), or in the artifact's database the person publishes.

## Links

- [Privacy](https://github.com/lunox-work/n8n-to-claude/blob/main/PRIVACY.md)
- [Documentation](https://github.com/lunox-work/n8n-to-claude/blob/main/docs/REFERENCE.md)
- [Support](https://github.com/lunox-work/n8n-to-claude/issues)

## Source

This branch holds only the plugin's files. The evaluation bench, tests and
documentation are on the main branch of https://github.com/lunox-work/n8n-to-claude. License: MIT.
