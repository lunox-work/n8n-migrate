# Bench change proposals

The Phase 6 loop may not change fixtures, mocks, gates, the comparer or the ceiling (PLAN Phase 6). Defects it finds are written here with evidence and wait for a person. Nothing below is applied.

## P1. Fixture connector rows and n8n-side rows disagree on what the service returns (4722, 2415)

- **Evidence, 4722 (Gmail `get`, `simple: false`).** The n8n side reads `GET /gmail/v1/users/me/messages/<id>?format=raw`; the raw message in the fixture carries `Message-ID`, `List-Unsubscribe`, `Precedence` (first mail) and `In-Reply-To`, `References` (second). The Claude side's `get_message` rows (`shape: assumed`) carry no headers at all. The template's agent prompt prints `headers['list-unsubscribe']`, `headers.precedence`, `headers['in-reply-to']`, `headers.references`, so the replayed model input can never match, whatever the converter does. After iteration 1 this is 4722's only blocker (bench `p6-i1`, gate 4 detail: `List-Unsubscribe Header:` empty on the Claude side).
- **Evidence, 2415 (Notion `database:get`, `simple: false`).** The n8n pin is a REST database object with property ids (`%3AbQr`, `Zx%7Bp`, …) and option ids and colours; the `notion-fetch` text row's `<data-source-state>` schema has neither. The template's agent prompt embeds `inputDatabase.properties` with `id` per property, so once the ReAct agent is modelled the prompt will differ on the ids alone.
- **Proposed change.** Check the real output of Gmail `get_message` (with `messageFormat: FULL_CONTENT`) and Notion `notion-fetch` on a database, once reading real data is allowed. Where the real connector returns headers or property ids, add them to the fixture's `connector` rows so both sides are fed the same facts. Where it does not, keep the rows and mark the template's gate 4 as `connector-limited` in the fixture's `expect.offline`, so the gap is reported as a connector limit rather than a migration failure.
- **Why not in the loop.** It changes fixtures, and which way it goes depends on real connector output nobody has captured.

## P2. Gate 8 in an in-process run is reported as a bench defect

- **Evidence.** `p6-i2` and `p6-i3`: 2777 passes gates 3–7 in process and stops at gate 8 with `bench defect: no claude-driver measurement for this template`; the same commit under `--driver claude` (`p6-i2c`, 2 `claude -p` runs) passes gate 8.
- **Proposed change.** Either document in `evals/bench/README.md` that the loop re-runs `--driver claude` on every template that reaches gate 8 in process (2 runs each), or let `run.mjs` do that automatically within the claude budget. The gate itself stays as it is.
- **Why not in the loop.** It changes how the bench reports a gate.
