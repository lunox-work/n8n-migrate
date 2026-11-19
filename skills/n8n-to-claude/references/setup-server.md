# Run your workflows from a claude.ai chat or Cowork (the server)

Without Claude Code, Claude has nowhere to keep your API keys and no runner of its own. The server fills that gap. It is a small program you run on a computer you control, and Claude reaches it as a custom connector. It runs each workflow step by step and keeps your keys, its records and the "already sent" ledger on that computer. Claude does only what the server asks for: the workflow's model steps, and its connector steps (Gmail, Slack, …) with exact arguments. How it works: `scripts/gateway.mjs` and `scripts/serve.mjs`, top comments.

You need Node 20 or later on the computer that runs the server, and a terminal there once. `n8n-to-claude` below is the package's command (the repository README, Install), or `node <this skill's folder>/scripts/start.mjs`, which is the same thing.

## 1. Convert

```sh
n8n-to-claude you.app.n8n.cloud                  # or a file, a template link: the report
n8n-to-claude convert n8n-to-claude/exports --out n8n-flows
```

No terminal? Upload the skill in claude.ai (Customize > Skills) and ask _"convert my n8n workflows for the server"_. Claude converts them in the chat's code sandbox and gives you `n8n-flows` as a zip (observed: the sandbox had Node 22). You still run the server on a computer you control.

## 2. Try it (10 minutes, temporary address)

```sh
n8n-to-claude serve n8n-flows --tunnel            # needs cloudflared (macOS: brew install cloudflared)
```

It writes `n8n-flows/.n2c/secrets.env`. Put each key there (never in a chat), stop the server with Ctrl+C and start it again. It prints a public address and the connector settings. The address changes every time it restarts, and claude.ai cannot edit a connector's address (only remove and re-add it), so use it for trying the server out only.

## 3. Add it to Claude

claude.ai > Customize > Connectors > Add > **Add custom connector**:

| Field           | Value                                                                   |
| --------------- | ----------------------------------------------------------------------- |
| Name            | n8n workflows                                                           |
| MCP server URL  | `https://<your address>/mcp`                                            |
| Authentication  | No sign-in                                                              |
| Request headers | `Authorization` = `Bearer <token>` (printed once; `serve --show-token`) |

Type the token yourself. Then, in a chat: _"list my n8n workflows"_, _"dry run <name>"_ (writes are held and shown), and _"run <name> for real"_ once the dry run shows what it would send. Chat workflows run for real by default. Switch the n8n workflow off before the first real run: `cutover.md`.

## 4. Keep it running (recommended): a computer that stays on, and a Cloudflare tunnel

Install the command for good first (not a one-off copy from npx's cache, which can be cleared): README, Install.

```sh
n8n-to-claude serve n8n-flows --setup             # token + secrets files; fill in secrets.env
n8n-to-claude serve n8n-flows --service           # writes a launchd (macOS) or systemd (Linux) unit
```

Run the two or three commands `--service` prints. They start the server now and at every login, and restart it if it stops. Then give it a lasting address. You need a free Cloudflare account and a domain on Cloudflare:

```sh
cloudflared tunnel login
cloudflared tunnel create n8n-workflows
cloudflared tunnel route dns n8n-workflows n8n.<your-domain>
cloudflared tunnel run --url http://127.0.0.1:8787 n8n-workflows
```

To keep the tunnel running, follow Cloudflare's "Run as a service" guide for your system. The connector URL is then `https://n8n.<your-domain>/mcp`. Tailscale Funnel works too, but only on port 443: claude.ai did not reach a Funnel on port 10000.

A laptop that sleeps stops every run until it wakes. Use a computer that stays on.

## 5. Or: a small server with Docker

```sh
n8n-to-claude serve n8n-flows --setup             # then fill in .n2c/secrets.env
n8n-to-claude serve n8n-flows --docker            # writes Dockerfile + .dockerignore
```

Copy the `n8n-flows` folder to the server, including `.n2c/server.env` and `.n2c/secrets.env`. Then run the `docker build` and `docker run` commands `--docker` printed. Keys and the token are passed when the container starts and never go into the image, and records live on a volume. Put HTTPS on port 443 in front of `127.0.0.1:8787` with a Cloudflare tunnel (above) or Caddy (`caddy reverse-proxy --from n8n.<your-domain> --to 127.0.0.1:8787`). The image installs the published package, so it needs a release that includes `serve` (later than 0.1.0).

## Updating and stopping

- **Changed workflows:** convert again into the same folder, then restart the server: `launchctl kickstart -k gui/$(id -u)/<label>`, `systemctl --user restart <unit>`, or rebuild the container. Records stay in `.n2c/gateway/`.
- **A new token:** `serve --rotate-token`, update the connector's header, then restart.
- **Stopping for good:** the commands `--service` printed under "To stop it". Then remove the connector in claude.ai.

## Keep it safe

- The token is the only thing standing between the internet and your workflows, and that includes their writes. Keep it in the connector's request header (claude.ai stores it and never shows it), not in the URL, and never in a chat.
- `.n2c/` holds the token, the keys (mode 600) and the records. `convert` git-ignores it, so never commit it.
- A service that sends a key back has it replaced with `[secret]` in records and replies. A run on the server keeps the real value for its later steps; on an artifact page those steps see `[secret]` (the key never reaches the browser). Model and connector steps see what the workflow gives them, as in n8n.
- Nothing is sent twice. A write handed to a chat that ended before answering stops the workflow until you check the service and tell Claude which happened (`n2c_resolve`).

## Contract

| Piece      | Where it comes from                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Workflows  | every subfolder of the served folder with a `definition.json`                                                                            |
| Token      | `.n2c/server.env` `N2C_GATEWAY_TOKEN` (or the environment); header `Authorization: Bearer`, or `/mcp/<token>` where no header can be set |
| Secrets    | `.n2c/secrets.env` and `--env-file`, `N2C_SECRET_<NAME>`; the environment wins                                                           |
| Records    | `.n2c/gateway/<folder>/records` (runs, ledger, cursors, open run state)                                                                  |
| Tools      | `n2c_list`, `n2c_run`, `n2c_continue`, `n2c_status`, `n2c_resolve` (the person's decision only), `n2c_http` (artifact page)              |
| Runs here  | logic, code, `http` and `db` steps, containment checked on every hop                                                                     |
| Handed out | `model`, `agent`, connector `tool` steps, one at a time; no hook sees the connector call                                                 |
| Refused    | `file` steps (your disk: local task only)                                                                                                |
| Log        | `N2C_GATEWAY_LOG=1`: method, tool, status; never the token                                                                               |

## Not yet

- Scheduled and poll workflows: nothing on the server starts a run by itself, so they still need a cloud or local task (or Cowork's scheduler, unconfirmed).
- Not yet run: Cowork (it starts only in the desktop app).

## Observed (2026-11-19)

- A claude.ai chat (Opus 5.5) connected over a Cloudflare quick tunnel, listed the workflows, ran a manual workflow (an http step with the server's key, then a model step), answered the model step and reached `DONE` (run g-mwn8cvz2-8bl8). The chat saw only the step's result, never the key.
- claude.ai did not reach the same server through Tailscale Funnel on port 10000 (no request arrived).
- httpbin echoed the key, which reached a run record. Records and replies have been scrubbed since.
- claude.ai checks a server before its request headers are filled in. A 401 at that point is taken as OAuth: it tries to register a client and fails. So the handshake on `/mcp` needs no token, and `tools/call` does.
- With the token as a request header (every claude.ai request carried it), a chat (Sonnet 5.5) ran a manual workflow that reads Gmail through the person's Gmail connector, plus two model steps, and reached `DONE` (run g-mwn9zgk4-sfbp). The server parsed the response the chat passed back into the two messages' subjects.
- `serve --service` on macOS: launchd started the server, restarted it after a kill and after `kickstart -k`, and the printed stop commands removed it. `serve --docker`: the image (built from a local pack) served with the header token, keys from `--env-file` and records on a volume across a restart, with nothing from `.n2c/` in the image.
- A chat ran a connector write through the server: a dry run held Gmail `create_draft` with its exact arguments, then the real run handed it out once and the ledger went sending → sent with the draft's id (run g-mwnb8ohm-t5lx).
- An artifact page converted with `--server` sent its http step to `n2c_http` (with the connector's tools still on "Needs approval"), got httpbin's answer with the echoed key as `[secret]`, and ended `done` with the cutover's "Dry run clean" ticked; its record in the page's db holds no key and shows nothing at `view` level.
- `serve --service` on Linux: in a systemd container (Debian, Node 22) the user unit started, came back after a kill and was removed by the printed commands.
- claude.ai cannot edit a connector's address, only remove and re-add it; `claude.ai/cowork` on the web leads to the product page, so Cowork could not be driven from a browser.
- A claude.ai chat with the skill uploaded ran `analyze.mjs` and `convert.mjs --server` in its code sandbox (Node v22.23.5) and handed over the folder as a zip. claude.ai refuses to upload a skill whose name contains "claude", so this ran with the name changed in the zip's SKILL.md.
