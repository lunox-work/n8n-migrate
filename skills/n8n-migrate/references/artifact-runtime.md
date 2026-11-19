# Artifact runtime contract

What the artifact page (`artifact.html`, driver `runtime/src/artifact-driver.mjs`) relies on. Read 2026-11-14 from the `artifact-capabilities` skill, runtime contract **0.2.96** (its `claude.d.ts`, `mcp.d.ts`, `sample.d.ts`, `db.d.ts`, `permissions.d.ts`). These are preview features: re-read the contract when its version changes and diff this file. Nothing here has run on a published page yet; `evals/artifact/shim.js` implements these shapes for the local check.

## Declaring and consent

- Capabilities are declared at publish, not in the page: `capabilities: {mcp: {servers: [{server, tools}]}, sample: {}, db: {rules}}`. A non-empty object replaces the stored set; omitting it on a redeploy keeps it. The converter writes the set to `artifact.capabilities.json`.
- `mcp.servers[].server` is the connector's display name (or the session's `claude_ai_<Name>` segment, resolved at publish); `tools` lists upstream tool names and must not be empty. Display names are derived from the session tool prefix (`mcp__claude_ai_Google_Drive__` → `Google Drive`) and stay unverified until a publish result states them.
- `const ns = await claude.use(name)` resolves the namespace or `null` (not served, not granted, failed; indistinguishable; `null` after 10 s with no host). Never synchronous. `window.claude` has only `use`.
- Consent is lazy, asked at the first call: per connector for `mcp` (scoped permission `mcp:<server>`), once per view for `sample` (it spends the viewer's usage). `permissions.state/request/manage` are built in. A "no" is final for the page load.
- Calls run as the viewer: their connectors, their usage. Viewers outside the organisation get `null` for `mcp`. Connector tools that need per-action approval reject `approval_required`.
- The page's network is its own origin only (CSP): no `fetch` to other hosts, so `http` steps cannot run here.

## mcp

- `callTool(server, tool, input, {cache?, signal?})` → `{content: [{type, text}...], structuredContent?, payload?, cache?}`. `payload` = structuredContent, else the first text block parsed as JSON, else that text. The driver reads `payload` and passes `cache: false`.
- Failures reject `{code, message, server?, retryable?, retryAfterMs?, result?}`; never a resolved `isError`.
  - Ambiguous for writes (the tool may have run): `server_unavailable`, `upstream_error`, `cancelled`, `rate_limited`, any unknown code. The driver leaves the ledger at `sending` and stops with `needs-check`.
  - The call did not run: `not_in_manifest`, `server_not_connected`, `needs_reauth`, `selection_required`, `blocked_by_policy`, `approval_required`, `bad_request`, `not_granted`, `capability_disabled`. Recorded `failed`.
  - `tool_error`: the connector answered with a failure. Recorded `failed`, handed to the runner as an error result.
- `listTools(server?)` → `{servers: [{server, kind?, authStatus, tools: [{name, description, annotations?}]}]}`. Before consent a connector lists from the manifest alone (`authStatus: "unknown"`), so preflight can prove only that the tool is declared and the connector is present; the first failed call fails closed.
- Also `watchTool`, `invalidate`, `server(name)`, `describeTool` (unused).

## sample

- `sample(input, opts?)` → `{text, truncated, modelTierApplied, modelApplied?}`; `sample.json(input, opts?)` → the reply parsed as one JSON value (tolerant: whole reply, a fenced block, or first `{`/`[` to last; `invalid_json` otherwise); `sample.limits()`.
- `input`: a string, or `[{role: "user"|"assistant", content}]` starting and ending on `user`; at most 256 KiB. No system role and no schema parameter: instructions, data and the output format go in the prompt. Each call is memoryless.
- `opts`: `onText`, `signal`, `tools` (page functions Claude may call), `images`, `modelTier` (`quick|default|complex|inherit`), `model`, `effort`, `fast`, `cache` (5-minute replay by default; the driver passes `false`).
- Rejects `{code, message, text?}`: `not_granted`, `rate_limited`, `refused`, `empty_completion`, `invalid_json`, `prompt_too_large`, `upstream_error`, and others. Never retried from code.
- Mapping: `model` → `sample(prompt)`, or `sample.json` when the step has `outputSchema` (the schema is written into the prompt; the page does not validate the answer against it yet). `agent` → `sample.json`, reply `{"intent": "tool-calls", "calls": [...]}` or `{"final": ...}`. The page does not use sample's own `tools`: the runner executes each call, so containment and the ledger apply. Agent memory lives in the page for that page load.

## db

- `db.doc(path)` (even segment count) / `db.collection(path)` (odd). Segments: letters, digits, `_ - . ~ : @ +`, at most 200 bytes, 16 segments. Bad paths throw `TypeError`.
- Document: `get()` → `{id, exists, data()}`; `set(body)` replaces; `update(body)` merges and requires the document; `delete()`; `onSnapshot(next, error)`; `acquire({holder, ttlMs, data?})` → `{acquired, version?, expiresAt?, holder?}`, a lease of 1–600 s (default 30 s) with no release verb. Query: `where` (up to 10), one `orderBy`, `limit` 1–1000, `get`, `onSnapshot`.
- Bodies are JSON objects up to 256 KiB and 32 levels; at most 25,000 documents and 100 MB per artifact. Last writer wins; no transactions.
- Who writes: by default Contributors and up; Viewers and Commenters never. The page declares `rules: [{path: "", read: "admin", write: "admin"}]`: run records hold connector data, so only the owner and Editors read or write them. A refused write rejects `invalid_argument`.
- Errors: `invalid_argument`, `resource_exhausted`, `quota_exceeded`, `unavailable`, `revoked`, `not_granted`, `capability_disabled`.
- A Claude session reaches the same store through the `ArtifactData` tool (`get`, `list`, `query`, `set`, `update`, `str_replace`, `delete`, `batch`; writes take `if_version`). It has no `acquire`. Whether a scheduled task can call it is Phase 0 check 6.

## Records (`runtime/src/records.mjs`, written by both drivers)

| Path                         | Body                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runs/<runId>`               | `format, runId, workflow, trigger (manual\|scheduled), driver (artifact\|task), status, dryRun, startedAt, endedAt, durationMs, definitionHash, commit, effects {reads, writes, sent, wouldSend, unknown}, steps {<name>: {status, in, out, error?, wouldSend?, sent?, sample?}}, wouldSend [{step, connector, tool, effectKey, args}], handoff {step, kind, request}?, error {message, node}?, unknown [...]?, cursorsSaved, resumable` |
| `runs/<runId>/state/current` | the runner's step-mode state without the definition, while a run is open (resume); dropped when it ends; `{tooLarge: true}` over 200 KB                                                                                                                                                                                                                                                                                                  |
| `ledger/<effectKey>`         | `format, effectKey, runId, requestId, step, connector, tool, argsHash, status (sending\|sent\|failed\|cleared), at, result?, error?, resolvedBy?`                                                                                                                                                                                                                                                                                        |
| `cursors/<cursorId(step)>`   | `format, step, cursor, runId, updatedAt, definitionHash, seeded`                                                                                                                                                                                                                                                                                                                                                                         |
| `lock/run`                   | `format, holder, kind, runId, via (artifact\|task), acquiredAt, expiresAt, released`                                                                                                                                                                                                                                                                                                                                                     |
| `meta/current`               | `definitionHash, commit, ...` written by the task; a different hash disables Run now                                                                                                                                                                                                                                                                                                                                                     |
| `meta/cutover`               | `owner (n8n \| claude), updatedAt, n8n {workflowId}`: who may send (references/cutover.md); a task's scheduled run is held while the owner is n8n                                                                                                                                                                                                                                                                                        |
| `cutover/<at>-<step>`        | `format, step, at, by (cli \| artifact), ok, forced, detail`: the cutover log the checklist reads; the page writes its clean dry run and its Seed                                                                                                                                                                                                                                                                                        |

- Run status: `running`, `done`, `failed`, `handoff`, `needs-check`, `preflight-failed`; the page shows a `running` run whose lock has lapsed as `interrupted`, with Resume when `resumable`.
- Step status: `pending`, `running`, `done`, `error`, `skipped`, `would-send`, `handoff`, `unknown`, `blocked`.
- Lock: the page takes the lease with `acquire` (30 s, renewed every 10 s) and writes the body with `via: "artifact"`. A writer without `acquire` (a task through ArtifactData) reads the body, refuses while an unreleased body's `expiresAt` is ahead, and writes `via: "task"` with `if_version`. The page refuses while a task body is live; an expired one is broken. Leases cannot be released, so another view waits up to 30 s after a run.
- Ledger: before a real write, `sending`; after, `sent` (with the result) or `failed`. On resume, `sent` replays the stored result, `sending` stops the run as `unknown: check before re-sending` until the person chooses "it was sent" (`sent`, `resolvedBy: "person"`) or "it was not sent" (`cleared`, then sent).
- Dry run: a write gets `{dryRun: true, ok: true}` as its result and is counted only when the run reached it (`held`). Cursors are saved only after a real run ends `done`.

## Differences from the design's assumptions

- `http` steps cannot run from the page (CSP): "Run now" stops at them with `handoff`; the design assumed tool and model steps only, which holds.
- `db` has no transactions or create-if-absent. The lock is a lease (`acquire`), which an ArtifactData writer cannot take, so overlap protection against a scheduled task rests on the body protocol above.
- `sample` has no system role and no output schema: both go into the prompt, and JSON is parsed tolerantly.
- Every call is the viewer's: a shared page runs with whoever clicks, on their connectors and usage.
