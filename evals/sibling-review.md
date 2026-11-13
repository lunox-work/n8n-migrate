# Sibling workflows: analyzer report review

**Status: awaiting author review.** Tick a box only when you, the author, agree with the analyzer's row. A tick is not implied by the judgment column.

The author's 11 workflows in `n8n-hvac-runtime-reminders`, `n8n-job-leases` and `n8n-telegram-class-booking` (`workflows/`). Analyzer at the commit that adds this file, run per repo as a bulk export and across all three:

```
node skills/n8n-to-claude/scripts/analyze.mjs ../<repo>/workflows --now 2026-11-16T00:00:00Z
```

The cross-repo run gives the same report for each workflow (no ids cross repos). Totals: subscription 3 (local task 3), hosted 7, keep in n8n 1; 15 open questions. "Bundled server" is left out of the requires column: it is derived from the secret and state rows.

| OK | Workflow | Wake-up | Body | Outcome → target | Requires | Questions | Blockers | Judgment |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [ ] | HVAC · 0 Setup | endpoint (also manual) | script | hosted, no key | state: Data Tables `hvac_customers`, `hvac_settings` | who calls "Or call" | none | Right for the default answer, wrong in spirit. Only the operator calls the setup URL, so `only-me` gives skill. Truer still: it creates n8n Data Tables, and after a move the state store replaces them, so there is nothing to migrate. The analyzer has no "provisioning" notion. |
| [ ] | HVAC · 1 Meter and remind | schedule every 10 min | script | subscription, local task | HTTP; secret `HVAC Thermostat App`; Data Tables `hvac_customers`, `hvac_settings`; SMTP → mail connector | none | substitution (SMTP) | Correct. 10 min is under the cloud task's 1 h, so local task. The tables are shared with workflows 2 and 3, which stay hosted, so the state has to move first (noted in the text). The token refresh POST is settled as a write by the OAuth rule. |
| [ ] | HVAC · 2 Customers and visits | endpoint ×3 | script | hosted, no key | Data Tables `hvac_customers`, `hvac_settings` | who calls each of the 3 URLs | none | Correct. Office tools and the scheduling form call these and wait for JSON. `only-me` → skill if only the author calls them from Claude. |
| [ ] | HVAC · 3 Connect thermostat | endpoint ×2 | script | hosted, no key | HTTP; secret `HVAC Thermostat App`; Data Tables | who calls each of the 2 URLs | none | Correct. A customer's browser and Honeywell's OAuth redirect must reach a public URL, so the answer can only be `outsiders`. |
| [ ] | Job Leases · 0 Setup | endpoint (also manual) | script | hosted, no key | Data Table `job_leases` | who calls "Or call" | none | Same as HVAC · 0: right for the default answer, but really one-off provisioning. |
| [ ] | Job Leases · 1 Agent API | endpoint ×5 | script | hosted, no key | Data Table `job_leases` | who calls each of the 5 URLs | none | Correct. Remote agents claim, heartbeat and complete over HTTP and wait for each answer. |
| [ ] | Job Leases · 2 Reaper | schedule every 1 min | script | subscription, local task | Data Table `job_leases` | none | none | Correct by the rules (1 min is the local task's minimum). In practice it must not move without the Agent API: they share `job_leases`, and the API stays hosted (noted in the text). A reaper on a computer that sleeps also lets leases pile up. |
| [ ] | Studio Bot · 1 Chat | relay (Telegram) | script | hosted, no key | HTTP; secrets `Studio Bot Postgres`, `Studio Bot Telegram`; database Postgres; relay | who messages the bot; which of 2 Telegram calls write | none | Correct since this review. It used to say cloud task. Trainers and admins wait for each button reply, and a studio's traffic passes 30 events an hour. No model step, so no key. |
| [ ] | Studio Bot · 2 Notifier | schedule every 5 min | script | subscription, local task | HTTP; secret `Studio Bot Postgres`; database Postgres | none | none | Correct. The bot token comes from the database at run time, so the HTTP call has no stored credential and only the Postgres secret is listed. `sendMessage` is settled as a write by the bot-method rule. |
| [ ] | Studio Bot · 3 Calendar feed | endpoint | script | hosted, no key | secret `Studio Bot Postgres`; database Postgres | who calls the URL | none | Correct. Google, Apple and Outlook calendars poll this URL. |
| [ ] | Studio Bot · 4 Error alerts | error | script | keep in n8n | none | none | dropped branch | Correct. It serves workflows 1 and 3, which stay outside the subscription. Workflows that move get the runner's failure alert. |

PLAN claim checked: the 3 scheduled workflows are HVAC · 1 (Data Tables plus HTTP with a stored credential), Job Leases · 2 (Data Tables) and Studio Bot · 2 (Postgres, plus HTTP without a stored credential). The report shows exactly these dependencies.

## Analyzer errors found here and fixed

- Telegram, WhatsApp and Twilio triggers were relays to a cloud task. They are now a `chat-app-users` question; the assumed answer `outsiders` gives hosted.
- The timezone was asked for every schedule. It is now asked only when the schedule runs at a time of day, so 10, 1 and 5 minute rhythms get no question.
- Write rules were missing. OAuth token endpoints and Telegram-style bot methods were questions; now they are settled as writes, including after a base URL that comes from an expression.
- Data Tables chosen by expression all shared one key, so the two Setup workflows looked as if they shared a table across repos. Tables now match by name, and a table chosen at run time matches nothing.
- The error workflow's reason now says why it stays.

## Judgment summary

Judged correct: 9 of 11. Judged right only by the default answer: 2, the two Setup workflows. Their real outcome is "nothing to migrate", which the analyzer cannot express yet.
