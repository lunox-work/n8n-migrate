# Privacy

n8n-to-claude is an agent skill with Node scripts that run on your machine, in
your own Claude sessions and scheduled tasks. It needs no account of its own,
runs no service and sends no telemetry. Nothing it handles reaches its author.

- **What it reads:** the n8n workflow exports you give it. Exports can carry
  the owner's name and email (`shared`); the report never repeats them.
  Credentials are read by name only; inline keys found in HTTP Request or Code
  nodes are redacted before anything is written.
- **What it writes:** one folder per workflow under the `--out` folder you
  choose: the definition, the redacted export, the report, the task prompt and
  permissions, an artifact page. Run records, poll cursors and the effect
  ledger go to `<folder>/.n2c/` on a local task, to the `n2c-state` branch of
  your own repository on a cloud task, or to the artifact's database when you
  publish the page.
- **Secrets stay with you.** The skill never asks for, prints or copies a
  secret's value. You store each one yourself: a cloud task's network secret,
  or `N2C_SECRET_<NAME>` in your git-ignored `.claude/settings.local.json` for
  a local task. `N8N_BASE_URL` and `N8N_API_KEY`, used only by the cutover
  steps, are read from your environment.
- **Where data goes when a workflow runs:** to the services the workflow
  already used, through your connectors or its own HTTP requests, and through
  your Claude session: connector results and model-step inputs pass through
  the model in your account, under your agreement with Anthropic. The cutover
  steps call your n8n instance's API, and nothing else.
- **Convert-time drafts (optional):** with your go-ahead, `draft.mjs` sends a
  blocked step's node type, operation and redacted parameters to the model in
  your account (`claude -p`) to draft a missing request template or tool map;
  the draft is written to that folder's `overrides.json`.
- **Retention:** only the folders and records above, on your machine or in
  your repository and artifact. Delete them to remove everything.

Questions about this policy: open an issue at
https://github.com/lunox-work/n8n-to-claude/issues.

Last updated 2026-11-17.
