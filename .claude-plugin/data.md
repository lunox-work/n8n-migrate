- **The plugin runs the CLI from npm:** the plugin's copy of the skill ships
  no scripts; it runs each command as `npx n8n-migrate@<version> <command>`,
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
- **GitHub:** `npx n8n-migrate`, on the person's go-ahead, pushes the converted
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
