# Alerts

A failed run, missed scheduled runs and a write whose outcome is unknown notify the person. Code: `runtime/src/alerts.mjs` (template, channel check), `runtime/src/schedule.mjs` (missed runs), the task driver (when to send).

## Channel

Chosen by the person at setup, written to the folder's `overrides.json`, then `n8n-migrate convert --regenerate <folder>`:

```json
{ "alerts": { "channel": { "connector": "slack", "tool": "slack_send_message", "target": "<their Slack user id>" } } }
```

| Channel                   | connector, tool               | target                                |
| ------------------------- | ----------------------------- | ------------------------------------- |
| Slack DM to themselves    | `slack`, `slack_send_message` | their user id (a DM), or a channel id |
| Gmail draft to themselves | `gmail`, `create_draft`       | their address                         |
| Gmail email to themselves | `gmail`, `send_message`       | their address                         |

Regeneration sets `definition.alerts` and `allow.alerts` (its own allowlist category) and adds the tool to the settings allowlist. No channel: the task's final line is the alert (`... No alert channel is set, so this line is the alert.`); cloud task sessions are visible to the person.

## Containment

- The alert is a request the driver builds, handed to the session like any tool call: the hooks allow only that exact call (same tool, same arguments), and it must match the one channel in `allow.alerts`.
- Fixed template: workflow name, step name, error class, run id, counts and times. Never an error message, tool output or any payload text, so hostile content a run read cannot be relayed through the alert. Names are cleaned (no line breaks, no `<>`, 80 characters).
- Each alert has a ledger key per event: a resumed session never sends the same alert twice.

## When

- **failed**: the run ends failed (or preflight refuses it). After the run's records are written.
- **missed**: at the start of a scheduled run, from `meta/schedule.lastRunAt` and the trigger's schedule: fires after the last run and before now minus a grace period (`task.json` `missedGraceMinutes`, default 15) count as missed. Text: "missed N scheduled runs since <time>". The run then goes ahead; a poll works from its cursor, so missed items are picked up. The artifact page shows the same count in its history.
- **needs-check**: a write was going out when an earlier session ended (ledger `sending`, no `sent`). The run stops until the person runs `resolve` in a terminal; later starts stop again without re-alerting.