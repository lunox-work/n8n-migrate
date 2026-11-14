# Evaluation bench

Runs each template through gates 1–8 (PLAN Phase 5): n8n 2.47.7 in Docker is the baseline, the migrated folder is run by the runner, and the comparer decides whether both made the same effects. A template stops at its first failed gate.

## Commands

```
node evals/bench/run.mjs [<id>...] [--split dev] [--limit n] [--variants normal,empty,malformed,hostile]
     [--repeats 3] [--model-mode replay|live] [--driver inprocess|claude] [--skill <id,...|all>]
     [--tag <name>] [--reuse-convert <tag>] [--record] [--no-n8n-check] [--diagnose]
node evals/bench/judge.mjs --calibrate <id>[,<id>] [--variant normal]
node evals/bench/summary.mjs [--tag <name>] [--json]
node evals/bench/tls.mjs [host...]          # CA and leaves (made on demand by the bench)
node evals/bench/validate.mjs               # fixtures (FIXTURES.md)
```

`--tag` names a bench run; re-running the same tag resumes from `.work/ledger/<tag>.json`. `held-out` never runs without explicit ids (EXCLUSIONS.md).

## Files

| File                             | Role                                                                                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.mjs`                        | orchestrator, ledger, one row per template to `evals/results.jsonl`                                                                                                          |
| `gates.mjs`                      | gate decisions and cause buckets, pure                                                                                                                                       |
| `effects.json`, `compare.mjs`    | the comparer's own table of "same effect" (from n8n and REST docs and `evals/mocks/connectors`, never the converter's field map) and the matching                            |
| `n8n-side.mjs`                   | template preparation: bench credentials, per-node model credentials, config overlay, pins, routes, request-log vs fixture diff                                               |
| `claude-side.mjs`                | plain `convert.mjs`, the headless skill run, the in-process driver                                                                                                           |
| `claude-driver.mjs`              | the folder under `claude -p` haiku with its own prompt, allowlist and hooks; `replay-hook.mjs` replays n8n's model replies into the session's answers                        |
| `model-shim.mjs`                 | answers model calls on both sides: live (`claude -p` haiku, cached by request), replay, canned                                                                               |
| `judge.mjs`                      | rubric judge (haiku) and its n8n-vs-n8n calibration (`judge-calibration.json`; draw A may be a live recording)                                                               |
| `claude.mjs`                     | every `claude -p`: budget (`N2C_BENCH_CLAUDE_MAX`, default 60), usage-limit stop, memory gate; ledger `.work/claude-runs.jsonl`                                              |
| `tls.mjs`                        | local CA and per-host leaves (`.tls/`, git-ignored)                                                                                                                          |
| `config/<id>.json`               | sanctioned overlay: placeholder fills only, applied to both sides (`n8n`: parameter patches by node; `claude.overrides`: merged into `overrides.json`, then `--regenerate`)  |
| `ceiling.json`                   | gate 8 ceiling, provisional                                                                                                                                                  |
| `recordings/<id>/<variant>.json` | n8n's run per variant: request log, model calls (request, reply, mode), node statuses, sources (git-ignored: requests carry template text; a fresh clone records once, live) |
| `../n8n/mock-server.mjs`         | `__routes` (query subset, `{token}`, UUIDs with or without dashes), TLS termination on CONNECT, model forwarding to the shim                                                 |

## Contract

- **n8n side.** Every call goes to the mock: plain HTTP through the proxy, HTTPS through CONNECT terminated with a leaf the container trusts (`NODE_EXTRA_CA_CERTS`). Model nodes reach the shim through `http://mock:8080/model/<tag>`. A read uses its `http` source; its `n8n` pin is used only without one, or after the node failed on it (`pin-fallback`). A poll trigger with `http` responses polls once instead of being pinned (binary data cannot be pinned). Sources per node are in each row's `stubs`.
- **Model replies.** The first n8n run of a template variant is live and recorded; later runs replay it. The Claude side gets n8n's reply for the same model node and call index (replay, the default for gates 4–7) and the bench checks that the Claude request asked the same question (gate 4 fails otherwise). A miss falls back to live and is marked. `--model-mode live` answers the Claude side live and sends model-written fields to the judge.
- **Gate 2.** The folder under test is the headless skill run's (`--skill`) or, for budget, plain `convert.mjs` (`drivers.convert` says which). `plainColumn` always holds the plain converter's gate 2 and preflight.
- **Drivers.** The in-process driver runs gates 3–7 (all variants, repeats). The claude driver runs normal and hostile once per template; gates 3, 4 and 6 must pass on both, and `gates.<n>.driver` names the driver. It does not run folders with `http` steps (the task driver would use the real network).
- **Diagnostics** (`--diagnose`): a template that passes preflight but stops at gates 3–6 still gets Contained measured on the hostile fixture (in process, and with the claude driver on normal and hostile). Recorded under `drivers.claudeDiagnostic` and `metrics.diagnostics`; the verdict stays the first failed gate.
- **Effects.** Writes and media calls are matched as multisets by `service.action.target`, then field by field; reads are reported, not gated; a chat or form workflow's answer is a `chat.reply` effect.
- **Results row** (`evals/results.jsonl`): `template, commit, skillCommit, reached (9 = all passed), gate, bucket, cause, detail, gates, drivers, plainColumn, config, stubs, n8nModelModes, logVsFixture, httpAttempt, metrics` (bench wall time, n8n execution time, skill and claude-driver cost and turns, claude -p runs and cost).
- **Buckets:** unmapped node, field map, expression translation, runner bug, skill instruction, flaky model step, bench defect, fixture.
