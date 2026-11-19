# Survey reconciliation (2026-11-14)

The PLAN survey tables, recomputed by the analyzer, and every template where the two disagree. Reproduce:

```
node skills/n8n-migrate/scripts/analyze.mjs evals/survey/data/wf --json --now 2026-11-16T00:00:00Z --out /tmp/r.json
node evals/survey/reconcile.mjs /tmp/r.json evals/survey/data/wf --markdown
```

"Survey port" is `reconcile.mjs`'s Node port of `levers.py` and `classify.py`. It reproduces every PLAN figure, so any difference in the analyzer column comes from the analyzer.

## Headline

|                           | PLAN survey          | Analyzer, default answers                                                   | Analyzer, answers that favour moving |
| ------------------------- | -------------------- | --------------------------------------------------------------------------- | ------------------------------------ |
| Runs on the subscription  | 87 to 93 (best case) | **67** (skill 38, cloud task 9, local task 7, artifact form 7, artifact 6)  | 94                                   |
| Replaced by Claude        | 2                    | 1                                                                           | 1                                    |
| Hosted elsewhere          | 5 to 11              | **21** (API key 16, no model 5)                                             | 0                                    |
| Kept in n8n               | n/a                  | 11                                                                          | 5                                    |
| Eligible after all levers | 83                   | **67**                                                                      | n/a                                  |

- **LLM API over HTTP (`llm-api` lever):** 4 templates (2466, 3291, 4110, 4352). A fifth (2777) has the calls, but they are not connected to anything. No template becomes eligible through this lever alone, because each also makes other HTTP calls. It removes one API key from each of the 4; 2 of the 4 run on the subscription.
- **Open questions:** 154 → 90. Write questions went from 97 (one per node, in 32 workflows) to 28 (one per workflow; host rules settle 4 workflows completely). Timezone questions went from 17 to 7, now asked only for time-of-day schedules. Added: 15 `chat-app-users`. Per kind: writes 28, chat-app users 15, sub-workflow id 14, endpoint callers 10, form outsiders 9, timezone 7, chat outsiders 4, MCP only client 3.
- **Main correction:** 15 templates are Telegram or WhatsApp chat bots (one behind a plain Webhook node). The survey counted them under the relay lever, and the analyzer sent them to a cloud task. People wait for each reply, a cloud task's start-up time has not been measured, and its API trigger takes at most 30 events an hour. By the PLAN's own definition ("outsiders use a chat page") they are hosted unless the person answers otherwise.

## Tables

### Wake-up

| Wake-up                                                | PLAN | Survey port | Analyzer |
| ------------------------------------------------------ | ---- | ----------- | -------- |
| Webhook, chat or form trigger                          | 45   | 45          | 44       |
| App trigger (Telegram, WhatsApp, Gmail, Drive)         | 24   | 24          | 19       |
| Manual only (analyzer: manual + uncalled sub-workflow) | 20   | 20          | 24       |
| Schedule                                               | 11   | 11          | 13       |

Analyzer wake-up kinds: chat 26, manual 21, relay 15, schedule 13, form 9, endpoint 6, poll 5, sub-workflow 3, MCP server 2.

`classify.py` counted the Execute Workflow Trigger as an app trigger (1534, 2563, 2567, 2783) and counted disabled triggers (2605, 2786).

### Contents

| Contents (enabled nodes)          | PLAN        | Analyzer                                                        |
| --------------------------------- | ----------- | --------------------------------------------------------------- |
| LangChain nodes (AI Agent)        | 78 (51)     | 78 (51)                                                         |
| HTTP Request node                 | 54          | 54                                                              |
| Code node                         | 35          | 34 (the survey also counted the LangChain Code node in 2982)    |
| Wait node / resuming on a webhook | 17 / 0      | 17 / 0                                                          |
| `pinData` present                 | 7           | 7                                                               |
| Tutorials (not-an-automation)     | about 8     | 5 (1700, 1744, 1751, 2896, 5170; the rule is strict on purpose) |
| LLM API called over HTTP          | not counted | 4                                                               |

### Eligibility as each lever is added

| Lever                                                          | Needing: PLAN | Analyzer | Cumulative: PLAN | Analyzer |
| -------------------------------------------------------------- | ------------- | -------- | ---------------- | -------- |
| None: logic, model steps, first-party connectors (+ `llm-api`) | n/a           | n/a      | 8                | 8        |
| `agent` step, self-calling sub-workflows                       | 53            | 51       | 9                | 9        |
| `http` step with stored secrets                                | 73            | 71       | 23               | 24       |
| Media through the original provider                            | 16            | 16       | 25               | 26       |
| Files in the script                                            | 18            | 18       | 28               | 30       |
| Poll for Gmail, Drive and Sheets triggers                      | 7             | 7        | 32               | 35       |
| Chat trigger becomes a skill                                   | 28            | 28       | 48               | 50       |
| Form trigger becomes an artifact form                          | 9             | 9        | 56               | 57       |
| Database through MCP or a driver                               | 9             | 9        | 61               | 62       |
| Vector store through MCP                                       | 11            | 10       | 68               | 67       |
| Relay to the cloud task's API trigger                          | 15            | 15       | 83               | **67**   |

The relay lever adds no template: all 15 relays are chat bots and default to hosted.

Lever differences, all analyzer right:

- `agent`: 2777's agent nodes are not connected, and 2786's chat trigger is disabled.
- `http`: 2606's HTTP node is not connected. 3770 uses the n8n API node, which is blocked, not HTTP. 2098's OpenAI Assistant node is an API call (`http`), not a Claude agent, since the assistant's instructions live at OpenAI.
- `vector`: 1951's text splitter feeds a summarisation chain, not a vector store.

### Outcomes

| Outcome                    | PLAN best case | Survey port    | Analyzer (defaults) | Analyzer, if answers favour moving |
| -------------------------- | -------------- | -------------- | ------------------- | ---------------------------------- |
| Runs on the subscription   | 87 to 93       | 85             | 67                  | 94                                 |
| Replaced by Claude itself  | 2              | 1              | 1                   | 1                                  |
| Hosted elsewhere, no model | 3              | 5 (all hosted) | 5                   | 0                                  |
| Hosted elsewhere, API key  | 2 to 8         |                | 16                  | 0                                  |
| Kept in n8n                |                | 9              | 11                  | 5                                  |

"If answers favour moving" means: endpoint callers and chat-app users are only you (or nobody waits), MCP clients are only Claude, form and chat users are inside the organisation, and every missing sub-workflow is in the export or is the workflow itself. The 5 that stay in n8n: 1534 and 3770 (n8n API node), and 2982, 3066, 3135 (send and wait).

- **Replaced:** the PLAN counted 2. 3514 is replaced now that Debug Helper is a logic step. 3770 manages n8n's own workflows through the n8n API node and runs workflows chosen at run time, so it stays in n8n.
- **Hosted, no model:** 1435, 1750 and 5171 (synchronous endpoints), 2679 (see below) and 2340 (a WhatsApp bot that answers from a sheet).
- **Hosted, API key:** 2431 and 2846 (endpoints), plus 14 chat-app bots (2751 sits behind a plain Webhook node).

## Disagreements

Templates where the analyzer's outcome differs from the survey's (`levers.py` hard blocks and lever sets). 22 in all: 1 analyzer error, fixed; 19 where the survey was wrong; 2 where the template's own file is broken or switched off.

| Template | Survey | Analyzer | Verdict | Reason |
| --- | --- | --- | --- | --- |
| 1073 | subscription | keep (before) → subscription: skill | analyzer was wrong, fixed | One `mkdir` in an Execute Command node blocked the whole workflow. Execute Command is now a substitution to a local task's shell (cloud and artifact: no). Fixture `substitution-shell`. |
| 1534 | subscription | keep in n8n | survey wrong | It backs up the n8n instance through the n8n API node. Managing n8n itself only makes sense while n8n runs (decision 1). |
| 2982, 3066, 3135 | subscription | keep in n8n | survey wrong | A `sendAndWait` operation waits for a human reply through an n8n webhook (out of scope v1). Counting by node type cannot see the operation. |
| 1934, 2035, 2114, 2340, 2462, 2465, 2466, 2534, 2751, 2752, 3586, 3859, 4110, 4696, 4827 | subscription (relay lever) | hosted | survey wrong; the analyzer was too until this pass | Telegram and WhatsApp bots: people wait for each reply. 2751 sits behind a plain Webhook node whose Telegram replies go to the chat id in its body. The `chat-app-users` question decides: outsiders → hosted; only you → a local task polling getUpdates for Telegram, a relay to a cloud task for WhatsApp; in Claude instead → skill; nobody waits → cloud task. Likely exceptions: 2462 (a personal assistant, only you) and 4110 (sends a URL into a pipeline that takes minutes, nobody waits). Fixtures `relay-telegram`, `chat-app-only-me`, `chat-app-webhook`. |
| 2679 | keep in n8n (community node, sync reply) | hosted, no model | file broken; the analyzer reads it literally | The published template does not connect the community transcript node and its whole branch. As exported, the webhook answers without them. Intended: kept in n8n. The text summary now lists nodes that never run. Templates often hold disconnected demo nodes (2777), so no rule change. |
| 2786 | keep in n8n (external sub-workflow) | subscription: skill (uncalled sub-workflow) | file switched off; the analyzer follows n8n | The chat trigger is disabled in the template, so the agent and its tool calls never run. The hard-coded tool ids point to the template itself ("Website Chatbot"). Enabled, it would ask `chat-outsiders` and `subworkflow-id`, now answerable with `self`. The text summary notes disabled triggers. |

## Rules changed while reconciling

All are general, with a fixture each; none names a template.

- Debug Helper is a logic step (decision 1): `mcp-debug-helper`, `n8n-api-node`.
- Execute Command is a substitution to a local task's shell: `substitution-shell`.
- The webhook relay lever was missing from the lever list: goldens `datatable-shared`, `multiple-triggers`.
- `subworkflow-id` offers `self` when the caller has its own Execute Workflow Trigger. 7 of the 9 corpus templates with such questions have one: `subworkflow-id-self`.
- Chat-app relays (Telegram, WhatsApp, Twilio, and a plain Webhook that replies to the chat in its body) ask who waits: `relay-telegram`, `chat-app-only-me`, `chat-app-webhook`.
- The timezone is asked only for time-of-day schedules.
- Host rules (`references/http-hosts.json`): LLM APIs, read endpoints, GraphQL, OAuth token endpoints, bot send methods: `http-hosts`, `chat-app-only-me`.

- A workflow that only creates and seeds n8n Data Tables from a manual run, or only manages n8n, is flagged `setupOnly` (none in the top 100): `setup-only`.
- All 7 artifact forms call outside hosts, so each carries a `task-handoff` to a cloud task: `form-artifact`, `form-handoff-local`.

## Known gaps

- A chat bot behind a webhook that replies through an HTTP Request to the bot API, not a messaging node, is still a plain relay.
