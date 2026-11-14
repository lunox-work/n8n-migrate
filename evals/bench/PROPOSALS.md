# Bench change proposals

The Phase 6 loop may not change fixtures, mocks, gates, the comparer or the ceiling (PLAN Phase 6). Defects it finds are written here with evidence and wait for a person.

Status 2026-11-14: P1 (the connector-limited half) and P2 approved and applied (README "Connector-limited", "Drivers"). P3, P4 and P5 approved and applied (README "Form bodies", "Timezone and run-time timestamps", "Drivers"); baseline `p6-base30c`. Open from P1: the real Gmail `get_message` and Notion `notion-fetch` shapes are still uncaptured, and 4722 and 2415 carry no `connectorGaps` yet, so their gate 4 is not marked connector-limited.

## P1. Fixture connector rows and n8n-side rows disagree on what the service returns (4722, 2415)

- **Evidence, 4722 (Gmail `get`, `simple: false`).** The n8n side reads `GET /gmail/v1/users/me/messages/<id>?format=raw`; the raw message in the fixture carries `Message-ID`, `List-Unsubscribe`, `Precedence` (first mail) and `In-Reply-To`, `References` (second). The Claude side's `get_message` rows (`shape: assumed`) carry no headers at all. The template's agent prompt prints `headers['list-unsubscribe']`, `headers.precedence`, `headers['in-reply-to']`, `headers.references`, so the replayed model input can never match, whatever the converter does. After iteration 1 this is 4722's only blocker (bench `p6-i1`, gate 4 detail: `List-Unsubscribe Header:` empty on the Claude side).
- **Evidence, 2415 (Notion `database:get`, `simple: false`).** The n8n pin is a REST database object with property ids (`%3AbQr`, `Zx%7Bp`, …) and option ids and colours; the `notion-fetch` text row's `<data-source-state>` schema has neither. The template's agent prompt embeds `inputDatabase.properties` with `id` per property, so once the ReAct agent is modelled the prompt will differ on the ids alone.
- **Proposed change.** Check the real output of Gmail `get_message` (with `messageFormat: FULL_CONTENT`) and Notion `notion-fetch` on a database, once reading real data is allowed. Where the real connector returns headers or property ids, add them to the fixture's `connector` rows so both sides are fed the same facts. Where it does not, keep the rows and mark the template's gate 4 as `connector-limited` in the fixture's `expect.offline`, so the gap is reported as a connector limit rather than a migration failure.
- **Why not in the loop.** It changes fixtures, and which way it goes depends on real connector output nobody has captured.

## P2. Gate 8 in an in-process run is reported as a bench defect

- **Evidence.** `p6-i2` and `p6-i3`: 2777 passes gates 3–7 in process and stops at gate 8 with `bench defect: no claude-driver measurement for this template`; the same commit under `--driver claude` (`p6-i2c`, 2 `claude -p` runs) passes gate 8.
- **Proposed change.** Either document in `evals/bench/README.md` that the loop re-runs `--driver claude` on every template that reaches gate 8 in process (2 runs each), or let `run.mjs` do that automatically within the claude budget. The gate itself stays as it is.
- **Why not in the loop.** It changes how the bench reports a gate.

## P3. The comparer reads n8n's multipart bodies as raw text (2167)

- **Evidence.** `p6-base30`: 2167 stops at gate 4, `flaky model step: model-written fields differ in replay`. n8n's Post Discussions body (HTTP Request, `multipart-form-data`) is logged by `mock-server.mjs` `decodeBody()` as one string with the boundary and every part; the Claude side's body is the field object (`body`, `position[old_path]`, …, `position[new_line]: 48`). The model-written `body` text is the same on both sides; only the encoding differs, and `new_line`/`old_line` are strings in a form part and numbers on the Claude side.
- **Proposed change.** Decode `multipart/form-data` in the mock log into `{field: value}` (files as `{filename, contentType, size, sha256}`) and compare form fields as strings.
- **Why not applied here.** It changes the comparer, which was not among the approved bench changes.
- **Status: applied** (approved 2026-11-14). `mock-server.mjs` `parseMultipart()`; `compare.mjs` `formStrings()` on both sides when the body is a form.

## P4. n8n's clock and timezone differ from the Claude side's (1953, 6270)

- **Evidence.** `p6-base30`: 1953 and 6270 stop at gate 4 on the agent's prompt, whose `$now` renders `2026-11-14T04:55:48.679Z` on n8n and `2026-11-13T23:55:40.374-05:00` on the Claude side. Two causes: the bench's n8n runs with `GENERIC_TIMEZONE=UTC` (`evals/n8n/container.mjs`) while the runtime takes n8n's default `America/New_York` for a template without a timezone (`runtime/src/engine.mjs` DEFAULT_TIMEZONE); and n8n's `$now` is the container's wall clock (8 s after the run started in 1953, after two live model calls) while the Claude side's clock is virtual from n8n's `startedAt`.
- **Proposed change.** Run the bench's n8n with n8n's default timezone (`America/New_York`, and `scheduleItem()` with it), re-recording the templates whose prompts carry dates; and either freeze n8n's clock (libfaketime in the image) or compare `$now`-derived text up to the timezone-normalised minute.
- **Why not applied here.** It changes every baseline recording and the environment, beyond the approved changes.
- **Status: applied** (approved 2026-11-14, without freezing n8n's clock). n8n runs with `GENERIC_TIMEZONE` and `TZ` `America/New_York`; `scheduleItem()` takes the zone; `compare.mjs` `maskRunTime()` masks timestamps within ±10 minutes of n8n's `startedAt` in write fields, the reply and replayed model inputs that differ only by them (digits only; shape and offset kept). Re-recorded: 1953 and 6270 (their model requests carried `$now` rendered in UTC).

## P5. Gate 8 cannot be measured for folders with `http` steps (3102, 2413)

- **Evidence.** `p6-base30`: 3102 and 2413 pass gates 3–7 in process; the claude driver does not run folders with `http` steps (`claude-driver.mjs`), so gate 8 stays `bench defect: no claude-driver measurement … the folder has http steps`.
- **Proposed change.** Route the task driver's `http` through the bench mock (the runner's HTTP host pointed at the mock, as the in-process driver does), so the claude driver can run these folders.
- **Why not applied here.** It changes the claude driver, beyond the approved P2.
- **Status: applied** (approved 2026-11-14). `http-preload.mjs`, preloaded with `NODE_OPTIONS --import` into the session's `runtime/runner.mjs` processes only (the Claude Code binary ignores `NODE_OPTIONS`), sends the runner's `fetch` to a host `mock-server.mjs` holding the fixture's http routes; dummy `N2C_SECRET_<NAME>` per declared secret.

## P6. Writes with the same target are paired by order, not by content (2167)

- **Evidence.** `p6-base30c`: 2167 stops at gate 4, `field map: different fields`. Both sides post the same two GitLab discussions to the same merge request (one per changed file, `position[new_path]` `src/invoice.ts` and `test/invoice.test.ts`, bodies and positions equal). n8n's HTTP Request node sends the two items concurrently, so the mock logged the test-file post first; the runner sends them in item order. `compare()` pairs same-key writes in list order, so each n8n post is compared with the other file's post and both pairs differ.
- **Proposed change.** Among unused Claude writes with the same `service.action.target`, pair an n8n write first with one whose fields all match (`sameField`, run-time masking included), and only then fall back to list order for the field diff. Order stays reported (`sameOrder`).
- **Why not applied here.** It changes the comparer beyond the approved P3–P5.
