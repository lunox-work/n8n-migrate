# Differential test against n8n (2026-11-14)

The runner core against real **n8n 2.47.7** (`n8nio/n8n:2.47.7`, the bench container, REST manual runs) as the oracle. No model anywhere.

```
node evals/n8n/container.mjs up
node evals/diff/differential.mjs <workflow.json> [--pins p.json] [--trigger t.json] [--save-fixture tests/fixtures/n8n-observed/x.json]
node evals/diff/run-all.mjs [--corpus templates,siblings,generated] [--seed 1,2,3] [--count 200] [--order-check]
node evals/diff/gen.mjs --seed N --count K --out dir
node evals/diff/pins.mjs <workflow.json> --pinned "A,B"
```

## Method

- **Pinned on both sides**: the trigger and every node that is not logic (connectors, models, agents, vector stores, files, sub-workflows, HTTP Request with a credential, pagination or a file response). n8n gets `pinData`; the runner's `run(def, {pinData})` mirrors n8n's `getPinnedOutput`. Pin data: the template's own, else `pins.mjs` synthesises items from the paths downstream expressions read.
- **Same inputs**: `https://` in HTTP Request URLs becomes `http://`, Wait becomes NoOp, credentials are dropped (n8n redacts execution data that touches a credential the user cannot open), a missing `executionOrder` becomes `v1`. The runner gets n8n's workflow id and name, execution id, start time and the bench's timezone (UTC).
- **HTTP**: the runner's reference `http` host (in `differential.mjs`) sends each request to an in-process copy of the bench mock with the same fixtures, the way n8n reaches it (direct to `mock:8080`, other origins as proxied absolute URLs, https as a refused CONNECT that reads as a 502).
- **Compared**: status and failing node; per node the run count, each run's branches, items (`json`, keys sorted) and `pairedItem` (own class), error; execution order; the ordered request log (method, origin, path, raw query, body, headers minus user-agent, content-length, accept-encoding, host, connection).
- **Time**: ISO and HTTP-date timestamps within 120 s, epoch numbers within 120 s and fractional numbers within 1e-6 relative count as equal; each report counts the comparisons that touched.
- **Soft classes**: `http-order` (same requests, other order: n8n sends a node's items concurrently), `random` (values differing only in letters and digits: Math.random, uuid), `unsupported` (the runner refuses an operation at run time: coverage, not divergence). Server stack traces in error items are skipped.
- **Regression fixtures**: `tests/fixtures/n8n-observed/*.json` (minimal workflow, pins, HTTP fixtures, n8n's run, observed 2026-11-14), replayed by `tests/n8n-observed.test.mjs` without a container. Each fix's fixtures fail on the runner before it.

## Numbers

Templates: the 100 in `evals/survey/data/wf/` (unwrapped). Siblings: `../n8n-*/workflows/*.json`; other sessions add repos, so the count moves between runs. Generated: `gen.mjs` at commit 744a461, seeds 1, 2 and 3, 200 each.

<!-- numbers:start -->

Last run 2026-11-13 UTC (`node evals/diff/run-all.mjs`), container peak 802 MiB.

- **templates**: 100 workflows, 83 qualified, 80 same, 0 diff, 3 stop at a runner-unsupported operation (Html operation "…" (needs an HTML parser) is not supported by the runtime: 2; Code: helpers.httpRequest is not supported by the runtime: 1). Not qualified: preflight: not implemented: n8n-nodes-base.markdown v1 (kind logic) (7); preflight: not implemented: n8n-nodes-base.htmlExtract v1 (kind logic) (3); n8n-refused (3); preflight: not implemented: n8n-nodes-base.dateTime v1 (kind logic) (1); community node n8n-nodes-youtube-transcription.youtubeTranscripter (not installed in the bench) (1); preflight: not implemented: n8n-nodes-base.debugHelper v1 (kind logic) (1); community node @blotato/n8n-nodes-blotato.blotato (not installed in the bench) (1). Before the fixes (runner at the harness commit, same corpus): 83 qualified, 67 same, 13 diff (http 7, error-message 6, status 2, items 2, branch-padding 1, node-error 1, order 1, runs 1).
- **siblings**: 101 workflows, 101 qualified, 96 same, 5 diff. Diff classes: random 5. Before the fixes (runner at the harness commit, same corpus): 101 qualified, 46 same, 55 diff (error-message 36, http 10, status 6, random 5, branches 5, items 5, node-error 5, order 3, runs 3).
- **generated** (seed 1,2,3, count 200): 600 workflows, 600 qualified, 598 same, 2 diff. Diff classes: items 2, pairedItem 2, random 1. Before the fixes (runner at the harness commit, same corpus): 600 qualified, 376 same, 224 diff (items 135, http 128, branches 68, node-error 68, status 68, order 60, runs 60, error-message 7, pairedItem 2).
<!-- numbers:end -->

The 2 generated diffs are the sort-engine difference below; the sibling diffs are all `random` (tokens from Math.random). Generated runs that read `$('X').item` across Code, Split In Batches and Merge nodes (293 executed references in 500 earlier-generator workflows: 46 across Code, 25 across a loop, 7 across a Merge) all matched once fixed.

Not qualified, by reason: logic node versions the runner does not implement (Markdown, HTML Extract, Date & Time v1, Debug Helper); community nodes not installed in the bench; n8n refusing the run ("Parameter URL is required" on an unpinned node, an unrecognized node type). Unsupported at run time: Html extractHtmlContent, `helpers.httpRequest` in Code.

## Divergences fixed

| Class                                                                                                                                                                                                                            | Fix                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Code errors lack n8n's ` [line N]`; Code sees `undefined` keys that n8n's JSON transport drops; no `Buffer`                                                                                                                      | b70f4b0 (`code-error-line`, `code-json-transport`, `code-buffer`)       |
| Code return-shape errors lack ` [item N]`; reserved key wording                                                                                                                                                                  | b70f4b0 (`code-return-shapes`)                                          |
| A run whose last node continued on error ends as an error in n8n                                                                                                                                                                 | 8a18ec5 (`code-return-shapes`)                                          |
| HTTP: default accept header, duplicate names by version, lodash-set JSON bodies, header case, URL checks, strict JSON fields, qs `indices` lists, continue-on-fail AxiosError items, explicit json/text parsing and empty bodies | 8f5f484 (`http-request-build`, `http-error-items`, `http-empty-bodies`) |
| Date & Time 2: `null`/`""` are the epoch, a missing date is now                                                                                                                                                                  | 81019de (`datetime-parse`)                                              |
| Set v1/v2 turns an undefined result into `""`/`0`; Set raw mode lacks jsonrepair's `undefined` and unquoted-value repairs                                                                                                        | 0775bef (`set-undefined-values`)                                        |
| Paired-item errors: "Unpin 'X' to execute", Code short messages, n8n wording; pinned nodes answer `$()`                                                                                                                          | 5372361 (`paired-pinned-trigger`)                                       |
| Item Lists v1 split errors, Html template `{{ }}`, If v1 TypeError names, Crypto on non-strings, Respond redirect URL check                                                                                                      | 6783681 (`small-nodes`, `respond-redirect`)                             |

## Known differences (not mirrored)

- **`$('X')` through X's error output reads null in parameter expressions** (n8n 2.47.7: `.first()`, `.all()`, `.item` throw inside n8n and the expression yields null; Code nodes and `$node['X']` see the items; through an intermediate Code node it works). Looks like an n8n bug; fixture `paired-error-output` records it. Seen in 2 of 500 workflows from an earlier generator version (seeds 2 and 3), none of the final 600.
- **Sort with an inconsistent comparator** (mixed types, missing values): the order depends on the JS engine; n8n's image runs Node 26.13, the test host Node 24.21.
- **Random values** (`random`): Math.random, uuid, Crypto generate.
- **Concurrent HTTP order** (`http-order`): n8n sends one node's requests in parallel.
- **Error item stacks**: n8n's continue-on-fail HTTP items carry axios's server stack; the runner gives the same fields without it.
- Template-level: Html extractHtmlContent and `helpers.httpRequest` in Code are refused by the runner (`unsupported`).

## Execution order v0 / v1

- n8n's engine runs v1 only when `settings.executionOrder === "v1"`. REST create and `n8n import:workflow` keep a missing setting missing, so such a workflow runs **v0**; the editor saves `{executionOrder: "v1", ...}` whenever it saves (and on template import). 52 of the 100 templates have no setting, all siblings have one (one is an explicit v0 lab).
- `run-all.mjs --order-check`: those 52 in n8n under v0 and under v1, same pins: 46 same, 4 differ, 2 skipped (unknown node). The 4: node order only (3, one of them runner-qualified: t1747), and one where a failure lands earlier in v1's depth-first order so two branches never ran (t1748, not runner-qualified). No output differed except a clock string.
- Decision: **v0 is not implemented**. The converter now writes `v1` when the export has none (1965894), the editor's behaviour; the runner warns on an explicit `v0`.
- `run-workflow.mjs` sends `settings: wf.settings ?? {executionOrder: "v1"}`: a workflow with settings but no executionOrder runs v0 there. The differential sets the order explicitly.

## For the Phase 5 bench

- Pin connectors on both sides only through `pinData` in manual mode: it changes `pairedItem` (a pinned trigger pairs every item to item 0), paired-item error wording ("Unpin ..."), and `$()` fallbacks. Production-mode runs (webhook) ignore pinData.
- A workflow whose last node continues on error is reported failed by n8n: gate 3 must use the same rule, or the bench miscounts.
- The time tolerance and the soft classes (`random`, `http-order`) must be part of gate 4's comparison; n8n has no fake clock.
- Corpus: 83 of 100 templates qualify once non-logic nodes are pinned, and most stop at a pinned agent within a few logic steps, so the generated corpus carries most of the logic coverage.
