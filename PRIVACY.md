# Privacy

n8n-migrate is an agent skill with Node scripts that run on your machine, in
your own Claude sessions and scheduled tasks. It needs no account of its own,
runs no service and sends no telemetry. Nothing it handles reaches its author.

- **What it reads:** the n8n workflows you give it: an export file, a
  template fetched from n8n.io by its id, or your own n8n, read after you sign
  in to it in the browser (only workflows set "Available in MCP") or with your
  API key. Exports can carry the owner's name and email (`shared`); the report
  never repeats them. Credentials are read by name only; inline keys found in
  HTTP Request or Code nodes are redacted before anything is written.
- **Signing in to n8n:** the sign-in's tokens are kept in memory for that run
  and never written, and the refresh token is revoked at the end. What is kept
  is n8n's registration of this client (its id and secret, the callback port)
  in `~/.config/n8n-migrate/oauth-clients.json`, readable only by you. It
  grants nothing without your consent in the browser.
- **What it writes:** one folder per workflow under the `--out` folder you
  choose: the definition, the redacted export, the report, the task prompt and
  permissions, an artifact page. Run records, poll cursors and the effect
  ledger go to `<folder>/.n8m/` on a local task, to the `n8m-state` branch of
  your own repository on a cloud task, or to the artifact's database when you
  publish the page. In a chat or Cowork, the page that lists your workflows
  and each workflow's own page are artifacts on your Claude account.
- **GitHub:** `npx n8n-migrate` lists a plan after the report and, on your
  go-ahead, commits the converted folders. When a workflow runs as a cloud
  task and `gh` is signed in, it pushes them to a new private repository on
  your account, which the task clones. The folders hold the redacted exports
  and never a key. `--no-setup` stops at the report.
- **Secrets stay with you.** The skill never asks for, prints or copies a
  secret's value. You store each one yourself: a cloud task's network secret,
  or `N8M_SECRET_<NAME>` in your git-ignored `.claude/settings.local.json` for
  a local task. `N8N_BASE_URL` and `N8N_API_KEY`, used only to read your
  workflows and by the cutover steps, are read from your environment or a file
  you name. `serve` keeps its own token and the keys you type in
  `<folder>/.n8m/` on the computer it runs on, git-ignored and readable only
  by you.
- **Where data goes when a workflow runs:** to the services the workflow
  already used, through your connectors or its own HTTP requests, and through
  your Claude session: connector results and model-step inputs pass through
  the model in your account, under your agreement with Anthropic. A search
  step you move to Claude's web search sends its queries there instead of
  SerpAPI. The cutover steps call your n8n instance, and nothing else.
- **`serve`:** runs the converted folders on a computer you control, and a
  chat reaches it at the address you add as a connector. `--tunnel` passes
  that traffic through a temporary Cloudflare tunnel.
- **Other requests:** the Claude plugin's copy of the skill runs each command
  as `npx n8n-migrate@<version> <command>`, a download of this package from
  registry.npmjs.org on first use, with nothing of yours in it. `npx n8n-migrate`
  offers to add the skill with `npx skills add`, a download from GitHub. The account check (`probe.mjs`)
  asks three public hosts whether they answer and sends nothing else.
- **Convert-time drafts (optional):** with your go-ahead, `draft.mjs` sends a
  blocked step's node type, operation and redacted parameters to the model in
  your account (`claude -p`) to draft a missing request template or tool map;
  the draft is written to that folder's `overrides.json`.
- **Retention:** only the folders and records above, on your machine or in
  your repository and artifact. Delete them to remove everything.

Questions about this policy: open an issue at
https://github.com/lunox-work/n8n-migrate/issues.

Last updated 2026-11-20.
