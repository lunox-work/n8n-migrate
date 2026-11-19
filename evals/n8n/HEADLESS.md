# n8n headless: the bench's n8n side (2026-11-14)

Phase 0 row "Local n8n runs a rewritten workflow headless from its CLI": **yes**, observed on n8n 2.47.7. Through its CLI (`n8n execute`) and, faster, through its internal REST API. The public API has no execute endpoint.

## Commands

```
node evals/n8n/container.mjs up [--fresh] [--env K=V]   # n8n + mock sidecar, waits for /healthz/readiness
node evals/n8n/run-workflow.mjs <wf.json> --trigger t.json --mock m.json --credentials c.json [--via pin|cli|webhook] --out r.json
node evals/n8n/selftest.mjs [--repeat 3]               # every path on workflows/, timings, memory
node evals/n8n/export-check.mjs                        # EXPORT-CHECK.md
node evals/n8n/container.mjs down [--purge]            # purge also drops the database volume
```

`run-workflow.mjs` exports `runWorkflow(workflow, opts)` for the bench. It returns `{status, mode, nodes, effects, response?, executionData, wallMs, executionMs, credentials}`. `nodes` holds every node's runs with all output items as JSON. `executionData` is n8n's `resultData`, raw.

## Closed environment

| Part               | What                                                                                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `n8nmigrate-bench` | `n8nio/n8n:2.47.7`, `--memory=1g --memory-swap=1g`, SQLite on volume `n8nmigrate-bench-data`, only on `n8nmigrate-net` (`--internal`). Owner created from env, fixed bench encryption key, no real credentials. |
| `n8nmigrate-mock`  | `node:22-alpine` running `mock-server.mjs`, 128 MB. Host `mock:8080` on the internal network; on `n8nmigrate-edge` it publishes `127.0.0.1:5690` and relays it to n8n's 5678.                                   |
| Egress             | n8n reaches only the mock. Observed: `https://example.com` timeout, `1.1.1.1` ENETUNREACH, `host.docker.internal` timeout.                                                                                      |
| Proxy              | `HTTP_PROXY`/`HTTPS_PROXY` = the mock, so a call to a real hostname still lands there: plain HTTP is answered from fixtures, HTTPS is logged as `CONNECT host:443` and refused (502).                           |
| Files              | The mock reads `<work>/fixtures.json` and appends `<work>/effects.jsonl` (`evals/n8n/.work/`, git-ignored). `<work>` is not mounted into n8n, so a workflow cannot read or change its own effect log.           |

Published ports do not work on an `--internal` network (Docker Desktop), hence the relay.

## Run paths

| `--via`         | How                                                                                                                                                       | Mode      | Triggers                                      | Wall time  | Peak memory |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------- | ---------- | ----------- |
| `pin` (default) | `POST /rest/workflows` with `pinData[trigger] = input`, then `POST /rest/workflows/:id/run {triggerToStartFrom: {name}}`, poll `GET /rest/executions/:id` | `manual`  | any                                           | 145–215 ms | 500–580 MiB |
| `cli`           | trigger replaced by a Code node of the same name returning the input, fed by a Manual Trigger; `n8n execute --id --rawOutput`                             | `cli`     | any, except workflows with Respond to Webhook | 2.3–2.6 s  | 830–920 MiB |
| `webhook`       | `POST /rest/workflows/:id/activate`, then the request to `/webhook/<path>`; HTTP response captured                                                        | `webhook` | Webhook node                                  | 110–390 ms | 510–550 MiB |

Timings are medians of 3 to 5 runs on the bench's workflows; the execution itself takes 10–30 ms. Idle container: 370 MiB after start, 470–580 MiB after a few dozen runs.

- REST needs a session: `POST /rest/login {emailOrLdapLoginId, password}` with a `browser-id` header, then the cookie and the same header. The owner comes from `N8N_INSTANCE_OWNER_MANAGED_BY_ENV`, `N8N_INSTANCE_OWNER_EMAIL` and `N8N_INSTANCE_OWNER_PASSWORD_HASH` (bcrypt), so there is no setup screen. These are internal endpoints: pin the image.
- `GET /rest/executions/:id` returns `data` as a flatted string; `parseFlatted` in `run-workflow.mjs` decodes it.
- Public API v1 (`X-N8N-API-KEY`): workflows, executions, credentials, data tables; no way to run a workflow (only evaluation test-runs and retry).
- `n8n execute`: `--file` is gone ("first import the workflow and then execute it using the --id flag"). It starts only at an enabled Manual Trigger, Manual Chat Trigger or Execute Workflow Trigger, otherwise "Missing node to start execution". It ignores `pinData`, which n8n uses only in `manual` and `evaluation` modes. While the server runs, the CLI process needs another task-broker port (`N8N_RUNNERS_BROKER_PORT=5681`; `container.mjs exec` sets it). It is a second n8n process, which explains the memory peak.

## Trigger input

| Trigger                                            | Fixture                                                                                                                  | How it enters                                                                                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manual                                             | items, default `[{}]`                                                                                                    | pinned, or the swap Code node                                                                                                                                        |
| Schedule                                           | items, default: the item n8n emits at `--now` (`timestamp`, `Readable date`, `Day of week`, `Hour` … in UTC)             | pinned or swapped. An active schedule fires on its cron and takes no input; unpinned in manual mode it emits the current time.                                       |
| Webhook                                            | `{request: {method, path, headers, query, body}}`                                                                        | `webhook`: sent to the production URL (most faithful, gives the response). `pin`/`cli`: becomes the item `{headers, params, query, body, webhookUrl, executionMode}` |
| Chat, form, app triggers, Execute Workflow Trigger | the trigger's output items (chat: `{sessionId, action: "sendMessage", chatInput}`; app triggers: the provider's payload) | pinned. Not run through their production endpoints here.                                                                                                             |

`$('Trigger name')` references keep working on every path, because the trigger keeps its name.

## Effects

The mock's JSONL is the ordered list of outgoing effects: `{seq, method, [proxied], path, query, headers, body, fixture}`. Calls to the model are effects too. Fixture keys: `METHOD /path?query`, `METHOD /path`, `* /path`, `default`, and `METHOD http://origin/path` for proxied requests. A list replies in turn; rewriting the fixture file restarts it. The runner rewrites fixtures and truncates the log before each run, and stops any execution still running.

## Credentials

- Runner: for each credential the workflow references, `POST /rest/credentials {name, type, data}` with data from `--credentials` (keyed by credential name or type), then node references are pointed at the new id. Unmatched references come back as `credentials.missing`.
- CLI: `n8n import:credentials --input=f.json` with `data` as a plain object encrypts it with the bench key and keeps the given id; `export:credentials --decrypted` shows it back.
- Observed: header auth credential `Bench Token` → the mock received `authorization: Bearer dummy-bench-token-123`, and the uncredentialed node sent no such header.

## Model nodes

- `lmChatAnthropic` v1.6 with an `anthropicApi` credential `{apiKey: <dummy>, url: "http://mock:8080"}` sends a well-formed Messages request: `POST /v1/messages`, `x-api-key`, `anthropic-version: 2023-06-01`, `user-agent: Anthropic/JS 0.115.0`, body `{model, stream: false, max_tokens, system, messages}`. Temperature is not sent for `claude-sonnet-5`. An AI Agent v3.1 with a Code Tool adds `tools` (name from the node name, `Stock_lookup`) and runs the full loop against mock replies: `tool_use` → n8n runs the tool → second request with `tool_result` → final text.
- Without the `url` override, the node sends `CONNECT api.anthropic.com:443` through the proxy, gets 502 and keeps retrying with backoff (7 attempts seen over more than a minute), so every model call needs a fixture or a short `--timeout`.

**Recommendation for Phase 5 (not built).** Swap every chat-model sub-node (`lmChatOpenAi`, Gemini, Mistral …) to `lmChatAnthropic` v1.6, keeping the node name and mapping `maxTokens` → `maxTokensToSample`. Then the request is native Messages with tools, and the agent loop runs unchanged. Point its credential's `url` at a model proxy in the sidecar, which records request and response as effects:

1. **Default: Console API key, pass-through.** The proxy forwards to the API with a key that lives only in the sidecar; n8n holds a dummy. Same model, same tools, real token counts. CHECKS.md: Max, Ultra and Team get monthly API credits for a Console key.
2. **Fallback: `claude -p`** on the host, behind the same proxy. It translates a Messages request into `claude -p --output-format json --json-schema …`. That is faithful for plain chains, but for agents it only emulates `tool_use`, and it spends the subscription window. `claude -p` is a permitted surface; driving claude.ai by script is not (CHECKS.md, terms 3.7). Mark results produced this way.
3. Either way, record each model reply once and replay it from fixtures for the repeats and for the n8n-vs-n8n judge run, so the baseline is deterministic.

## Gotchas

- 2.47 refuses to import deprecated nodes (Function, Function Item, LangChain Code v1) unless `N8N_DEPRECATED_NODES_BLOCK=false`, which the bench sets.
- No Python in the image: Python Code nodes fail, and every start logs a harmless "Failed to start Python task runner".
- Deleting a workflow does not cancel its execution. An orphaned model-node retry put a `CONNECT` into the next run's log until the runner learned to stop running executions first.
- Activation can return before the webhook answers; the runner retries "not registered" 404s for up to 10 s.
- Respond to Webhook fails on the `cli` path ("No Webhook node found"). On `pin` it runs and passes its input through.
- `docker cp` leaves root-owned files in the container: remove them with `docker exec -u root`.
- Data Tables, static data and credentials persist in the volume between runs. Use `up --fresh` or seed state per run.
- REST create (`POST /rest/workflows`) accepts an `id`, so a sub-workflow can be created under the id its caller hard-codes. The runner does not do this yet.
