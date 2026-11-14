# Improvement loop log

Append-only (PLAN Phase 6). One entry per iteration, accepted or discarded: bucket, hypothesis, change, before/after (passes, sum of reached gates, reached gate per template on the 10 dev fixture templates; `convert-coverage --split dev`), verdict. Bench tags are `p6-i<n>`; commits carry the same numbers.

Baseline (`p6-i0`, plain `convert.mjs`, commit before iteration 1): see iteration 0.

## Iteration 0 (baseline and lint)

- Change: `scripts/lint-no-template-rules.mjs` wired into `node --test`; `evals/convert-coverage.mjs --split dev | --ids` with a preflight-clean count and `--per-template`.
- Bench `p6-i0` (plain `convert.mjs`, replayed models, commit 5186070): 0 of 10 pass, gate sum 31. Reached: 2098 3, 2187 3, 2415 3, 2420 3, 2508 3, 2614 3, 2777 3, 2803 3, 3016 3, 4722 4. Same gates and causes as `b2` (headless skill folders).
- `convert-coverage --split dev`: full 4, review 9, blocked 47, preflight clean 15 of 60.
- Blocking levers over the 60 dev templates (templates with a preflight error of that kind; sole blocker in brackets): Sheets without a tool 16 (4), files 10 (2), URL built at run time 10 (2), database 8 (0), media 6, vector store 6 (3), LLM API over HTTP 5 (2), WordPress 4, Facebook Graph 4, forms that wait 2 (1), OpenAI Assistants 1 (1). On the 10 fixture templates only LLM API (2777) and files (2420) are sole blockers.

## Iteration 1: connector result shapes (accepted)

- Bucket: field map (connector output shapes). 2415 stopped at gate 3 (`notion-fetch` output kept as `{text}`, so `properties` was missing); 4722 at gate 4 (the agent prompt read `from.value[0].address` from a Gmail `get` with `simple: false`, but the adapter emitted n8n's simplified fields only).
- Hypothesis: tolerant readers that accept every plausible output shape and build n8n's own output (per n8n option) move both templates to their next blocker, without touching the bench.
- Change: `runtime/src/shapes.mjs` (`gmail-message`: connector flat shape, Gmail REST `payload.headers`/parts, n8n simplified or parsed, wrappers; `notion-database`: REST object, data-source state JSON, the `<database>`/`<data-source-state>` text), unrecognised output fails with "connector shape not recognised"; adapter `shape` plus `headerLines`/`addresses`/`addressLine` field specs; tool-map `resultWhen` (converter picks the adapter by option, n8n's default when absent): Gmail `get` parsed view for `simple: false`, Notion `database:get` REST view for `simple: false` and `{id, name, url}` otherwise.
- Bench `p6-i1`: 0 of 10 pass (was 0), gate sum 32 (was 31). 2415 3 → 4 (now: the ReAct agent's prefix and the text classifier's format instructions differ from n8n's prompts); 4722 4 → 4 with a later blocker (sender now matches; the assumed `get_message` shape carries no `List-Unsubscribe`/`Precedence` headers, which n8n's raw message has). Others unchanged.
- `convert-coverage --split dev`: unchanged (full 4, review 9, blocked 47, preflight clean 15); no per-template change.
- Verdict: accepted (rules a–e).

## Iteration 2: steps no trigger reaches (accepted)

- Bucket: runner bug (preflight). 2777's only blockers were two LLM-API HTTP nodes and an agent that no trigger reaches; n8n never runs them, but preflight refused any blocked step anywhere in the graph.
- Hypothesis: preflight should judge only steps a run can reach; unreachable blocked or unimplemented steps become warnings ("never runs (no trigger reaches it)"). The engine starts at one trigger and follows edges, so this cannot let a blocked step execute.
- Change: `unreachableSteps()` in `runtime/src/api.mjs` (start set: every enabled trigger; without triggers, every step without inputs); preflight warns instead of refusing for those steps.
- Bench `p6-i2` (in process): 0 of 10 pass, gate sum 37 (was 32). 2777 3 → 8 (gates 3–7 pass; gate 8 needs a claude-driver measurement). `p6-i2c` (2777, `--driver claude`, 2 `claude -p` runs): 2777 passes every gate (9), the loop's first pass, on the plain converter's folder. Others unchanged.
- `convert-coverage --split dev`: preflight clean 15 → 17 (2777, 3102); 6 more templates lose one preflight error each (2315, 2621, 2753, 5148, 5230, 5993); no template gains an error or a blocked step.
- Verdict: accepted (rules a–e).

## Iteration 3: classifier prompts as n8n sends them (accepted)

- Bucket: field map (model step requests). After iteration 1, 2415's text classifier asked a different question: n8n puts LangChain's StructuredOutputParser format instructions (with the category JSON Schema) between the template and the two rules, tab-indented; the converter dropped them. The sentiment step had the same gap and also asked for `sentiment` only, where n8n always asks for `sentiment`, `strength` and `confidence`.
- Hypothesis: building the system message exactly as n8n 2.x does (instruction text from `@langchain/classic`, read from the n8n 2.47.7 image) removes the classifier's own mismatch, leaving the ReAct agent upstream as 2415's only blocker.
- Change: `structuredFormatInstructions()` in `scripts/convert.mjs`; textClassifier system = template, format instructions, multi-class rule, fallback rule joined by `\n\t`; sentimentAnalysis system = template (raw categories string), tab indent by version and batching, format instructions; sentiment schema with all three fields.
- Bench `p6-i3` (in process): 0 of 10, gate sum 37 (unchanged). 2415 stays at 4 with a later blocker: the classifier's system message now matches n8n's; its input text is `null` because the ReAct agent upstream (prompt built from `options.prefix`, not modelled) yields no `output.workflowJson`. Others unchanged; 2777 still 8 in process.
- `convert-coverage --split dev`: unchanged (preflight clean 17).
- Verdict: accepted under rule (c), later blocking cause, no gate falling.

## Baseline for iterations 4–6 (`p6-base30c`, 30 dev fixture templates)

After the approved bench changes P3–P5 (commit dccf5b5): 6 of 30 pass (1747, 2197, 2413, 2777, 3102, 6270), gate sum 130. Reached: 1953 4, 2167 4, 2415 4, 4722 4, the other 20 at 3. `convert-coverage --split dev`: full 4, review 9, blocked 47, preflight clean 17.

From here a run covers the templates whose `definition.json` changed against the previous commit (converted by both trees, `generated`/`converter` stripped); the others carry their previous row, because the runner change in each iteration only adds code that unchanged definitions never reach and replayed runs are deterministic. Every row carries the commit it ran on.

## Iteration 4: same service over REST with the person's credential (accepted)

- Bucket: unmapped node (preflight-blocked steps). Sheets writes were the sole blocker of 2063 and 4573; unapproved LLM API calls over HTTP were blocked in 5 dev templates.
- Hypothesis: keeping the same service over its REST API with a stored credential is the default mapping, not a substitution. One mechanism covers a single request (the existing `http` templates, an LLM API call kept as the original `http` step) and operations that take several requests (`rest` programs that follow the n8n node's own code), with the host allowlist and the secret's hosts from the tool map.
- Change: `runtime/src/rest.mjs` (`googleSheets`: append, update, appendOrUpdate for v4+, n8n 2.47's requests and bodies: metadata, sheet read, `appendDimension`, `PUT`/`:append`, `values:batchUpdate`); tool-map entry kind `rest` (`credentialType`, `hosts`), schema `steps.*.rest`; converter `applyMap` rest branch; an unapproved LLM API call stays `http` with a review line naming `--approve llm-api-to-claude`. PLAN Phase 3, SKILL.md, translation.md state the rule. Caveat on every Sheets step: Google access tokens expire after an hour and service-account sign-in is not built.
- Bench `p6-i4` (changed definitions: 1900, 2063, 2614, 2658, 2777, 3016, 3086, 3102, 4573; 4 `claude -p` runs): 6 of 30 pass (was 6), gate sum 133 (was 130). 2063 3 → 5 (all Sheets writes equal n8n's on the normal fixture; malformed differs in the updated row because the Sheets read does not apply `filtersUI`); 4573 3 → 4 (its Sheets writes equal n8n's; an extra CoreClaw POST from the same unfiltered read). 2777 and 3102 still pass; the rest unchanged.
- `convert-coverage --split dev`: full 4 → 4, review 9 → 16, blocked 47 → 40, preflight clean 17 → 21; no template gains a blocked step or a preflight error (19 lose some).
- Verdict: accepted (gate sum rises, no pass lost, no gate falls).

## Iteration 5: Google Sheets read row filters (accepted)

- Bucket: field map (connector read). Found in `p6-i4`: the Sheets read through the Drive CSV export returned every row and only flagged `filtersUI` for review. n8n applies the filters with `lookupValues`, so 4573 read one pending query (two on the Claude side, hence an extra CoreClaw POST) and 2063's update row came from a different first row.
- Hypothesis: applying n8n's `lookupValues` semantics to the adapted rows (cell text equals the value, `lookupValue` defaulting to `""`, OR in filter order, first match per filter unless all are asked for, 4.6+ stops at the first match, AND) makes the read feed the same rows.
- Change: tool-map `lookup: true` on the Sheets read (the two review lines go; the parameters are understood); converter writes `tool.lookup` (filters, combine, returnAll by version, stopAtFirst for 4.6+; review for 4.1 and older, which pool every item's filters); runtime `applyLookup()` after the adapter, per input item; schema `tool.lookup`.
- Bench `p6-i5` (changed definitions: 2063, 2658, 3086, 4573; 2 `claude -p` runs): 7 of 30 pass (was 6), gate sum 138 (was 133). 4573 4 → 9 (all gates, claude driver included). 2063 stays 5: the malformed fixture's http source holds a `null` cell that its connector source and the real API do not (PROPOSALS P7). 2658, 3086 stay at 3 (other blockers).
- `convert-coverage --split dev`: full 4 → 6 (2063, 4573), review 16 → 14, blocked 40, preflight clean 21; no regression. `evals/convert-coverage-dev.md` regenerated (it also carries iteration 4's change).
- Verdict: accepted.

## Iteration 6: headless skill translates flagged steps; plain node commands (discarded)

- Bucket: skill instruction. In the Phase 5 runs the headless skill translated nothing, and the node-only allowlist refused `cd` chains.
- Hypothesis: telling headless mode to still do step 5 (translate every flagged step, verify it with `try-step.mjs`) and to run each script as one plain `node <relative path>/scripts/<script>.mjs ...` command gives the skill column steps the plain converter leaves flagged.
- Change: two SKILL.md lines (the script paragraph and the headless paragraph).
- Bench `p6-i6` (`--skill` on 3025, 2777, 4573: 3 `claude -p` sonnet runs, 8.8–14.6 s and $0.06–0.09 each, plus 4 claude-driver runs): skill column = plain column on all three (3025 3, 2777 9, 4573 9). The sessions ran plain `node` commands with no refusal. 3025's two flagged steps read `$env`, which translation.md keeps blocked, so the session left them, as the rules say; 2777 and 4573 have no flagged steps. The only override steps in the skill folders are the bench overlay's (placeholder fills, time compression). Among the 30, the only other templates with flagged steps (2315, 2803) flag node versions the runtime lacks, which cannot be translated either.
- `convert-coverage`: unchanged (SKILL.md is not read by the converter).
- Verdict: discarded (no gate rises, no blocker moves). Reverted. The 30 dev fixture templates hold no flagged step that headless translation could settle, so this change cannot be measured on them.

## Iteration 7: ReAct agent prompt as n8n builds it (accepted)

- Bucket: field map (model step requests). 2415's agent (node 1.6, `agent: reActAgent`) got "You are a helpful assistant" as its system message; n8n sends LangChain's ChatAgent prompt. Its output also lost n8n 1.6's `{output: ...}` wrapper, so the classifier downstream read `null`.
- Hypothesis: building the ChatAgent prompt (prefix, tool lines, format instructions, suffix joined by blank lines, f-string braces; input plus the parser's format instructions after a newline) and keeping the 1.6 wrapper leaves the Notion property ids (PROPOSALS P1) as 2415's only difference.
- Change: converter ReAct branch for agents without tools (`agent.system`, `agent.promptAppend`, `agent.wrapOutput` for 1.6 and older); with tools, or with expression or custom human-message options, the native tool-call prompt stays and the step says the prompt differs. Runtime appends `promptAppend` after the evaluated prompt and wraps the final value when asked; schema `agent.promptAppend`, `agent.wrapOutput`. Defaults read from `@langchain/classic` 1.0.27 in the n8n 2.47.7 image.
- Bench `p6-i7` (changed definition: 2415 only; 0 `claude -p` runs): 7 of 30 pass, gate sum 138 (both unchanged). 2415 stays at 4 with a later blocker: 2 differing model inputs → 1; the agent's system and human messages now match n8n's except the property ids the `notion-fetch` text lacks (P1); the text classifier's input matches.
- `convert-coverage --split dev`: unchanged, no regression.
- Verdict: accepted (rule c: a later blocking cause, no gate falling).

## Bench maintenance P6 and P7; full re-run `p6-full30` (baseline for iterations 8–10)

- Bench changes approved by a person and applied: P6 (writes to one target paired by content, commit 5269638), P7 (2063's malformed Sheets rows carry no `null` cell, commit c7b8dc1). PROPOSALS P8 found in this run.
- `p6-full30` (commit c7b8dc1, plain `convert.mjs`, replayed models): all 30 dev fixture templates run again, no row carried forward. 2777 and 4573 stopped once on the bench's own memory gate (claude driver waits for 40% free while the n8n container is up; the machine stayed at 34–39% for 30 minutes); both were resumed in the same tag with the container stopped (their n8n runs were already recorded) and pass. 19 `claude -p` runs (ledger 146 → 165).
- Result: 7 of 30 pass (1747, 2197, 2413, 2777, 3102, 4573, 6270), gate sum 136 (was 138 over the last recorded rows). 28 templates: same gate and cause as their last row (1953's detail differs only in n8n's wall-clock `$now`). Changed:
  - 2063: 5 → 3. With P7 the malformed fixture agrees with itself and 2063 passes gates 3–7 in process for the first time; the claude driver it then runs for gate 8 fails on `socket hang up` / `ECONNRESET` in the bench's http preload (P8), not in the migration. No pass was lost.
  - 2167: 4 → 4, later blocker. With P6 it passes gates 3–7 in process; the claude driver fails gate 4 because the task driver sends the GitLab `multipart-form-data` body as JSON (`position[new_line]` 48 instead of "48"), the known gap in PLAN Known gaps.
- `convert-coverage --split dev`: unchanged (no converter change).
- From here every measurement runs all 30 templates; rows are not carried forward.

## Iteration 8: multipart bodies as n8n sends them (accepted)

- Bucket: runner bug (task driver). Found in `p6-full30`: 2167 passes gates 3–7 in process and fails gate 4 under the claude driver, because `executeHttp` sent the HTTP Request node's `multipart-form-data` body as JSON (`position[new_line]` 48 where n8n's form sends "48"). PLAN Known gaps listed it. Binary form fields were refused outright (`HTTP Request binary form fields`).
- Hypothesis: encoding the body as n8n's form-data 4 does (read from the n8n 2.47.7 image) makes the task driver's request the same as n8n's, and moves 2167 to a pass.
- Change: `driver.mjs` `multipartBody()` and the `executeHttp` branch: each field a part, values byte for byte, numbers, booleans and null as text, objects as JSON, lists repeated, file parts with filename and Content-Type; names escaped as form-data does; the body goes out as bytes with its boundary, so any fetch sends the same thing. `nodes2.mjs` `multipartPairs()`: `formBinaryData` fields become file parts from the item's binary property (n8n's error when it is missing; left out without a field name; data in n8n's store is refused), repeated names as before.
- First measurement `p6-i8` (real multipart through undici's `FormData`, 18 `claude -p` runs): 7 of 30, gate sum 136, every template unchanged. 2167's only difference left: `FormData` rewrites `\n` to `\r\n` inside text values (the WHATWG encoding rule), which n8n's form-data does not. The encoder was replaced by the byte-exact one above.
- Second measurement `p6-i8b` (18 `claude -p` runs; ledger 165 → 201 over both): **8 of 30 pass** (was 7: adds 2167), **gate sum 141** (was 136). Reached: 2167 4 → 9; 1747, 2197, 2413, 2777, 3102, 4573, 6270 9; 1953, 2415, 4722 4; 2063 3 (P8, `read ECONNRESET`, same as `p6-full30`); the other 18 at 3, all unchanged.
- `convert-coverage --split dev`: unchanged (full 6, review 14, blocked 40, preflight clean 21; the converter is untouched). `node --test` 279 pass, lint included.
- Verdict: accepted (success count rises, gate sum rises, no gate falls, no pass lost).

## Bench maintenance P8 and P9 (Stage A); full re-run `p6-a1` (baseline for iterations 9–10)

- Bench changes approved by a person and applied: P8 (the claude driver's http preload opens a fresh connection per request: `agent: false`, `Connection: close`), P9 (the in-process host records a runner file part as the mock decodes one: `{filename, contentType, size, sha256}`).
- `p6-a1` (plain `convert.mjs`, replayed models, all 30 dev fixture templates, no row carried forward; 18 `claude -p` runs, ledger 201 → 219): **8 of 30 pass** (unchanged), **gate sum 142** (was 141). 29 templates: same gate and cause as `p6-i8b` (1953's detail differs only in n8n's wall-clock `$now`).
  - 2063: 3 → 4. The claude driver now runs to `done` on normal and hostile with every http request answered. It stops at gate 4 under the claude driver (`bench defect: effects the comparer table does not cover`, the uncovered SerpApi reads listed because a write is missing): the Sheets `appendOrUpdate` program's `appendDimension` POST is never sent. Cause, from the run record: the engine hands a stored answer to the step by reference (`dispatch()` returns `run.resultLog[id]`); the program adds the new header columns to the read rows in place, the task driver persists the mutated answer, and on the next resume the replayed read already has those columns, so the header write is skipped and every later request id shifts by one (the answer for the `values:batchUpdate` is fed to `appendDimension`'s id). A runner bug, invisible in process (one pass, nothing persisted). Not a bench defect.
- `convert-coverage --split dev`: unchanged (full 6, review 14, blocked 40, preflight clean 21). `node --test` 280 pass (P9 test added), lint included.

## Iteration 9: poll triggers read each new item again (accepted)

- Bucket: field map (connector read). 1953's agent prompt rendered `Sender: marco.bellini@…` where n8n has `"Marco Bellini" <marco.bellini@…>`: n8n's Gmail Trigger re-fetches every new message (`GET messages/<id>`, `format=metadata` in simple mode, which copies the raw headers; `format=raw` through mailparser otherwise, whose address text is `"Name" <address>`; read from the n8n 2.47.7 image), while the poll used only `search_threads`, which has no display names.
- Hypothesis: one detail call per new item after the cursor, adapted with the existing `gmail-message` shape (simple: `From`/`To`/`Cc`/`Bcc` lines from `get_message`'s addresses and `addressDisplayNames`; non-simple: the parsed view of the Gmail `get` map), gives the trigger n8n's item, and moves 1953 to its next blocker.
- Change: tool-map `detail` on a poll entry (`tool`, `args`, `idArg`, `idField`, `keep`, `result`, `resultWhen` with its own `missingFields`); Gmail Trigger gets `get_message` (`MINIMAL` simple, `FULL_CONTENT` otherwise), keeps `threadId` from the list (get_message has none), and drops the "raw format not mapped" review; a caveat says the simple `From` is rebuilt as `"Name" <address>` while n8n copies the raw header. Converter writes `poll.detail` and the detail's `missingFields` and allows the tool; runtime `pollTrigger` calls it per emitted item; schema `poll.detail`. `labels`, `payload`, `historyId`, `internalDate`, `sizeEstimate` stay missing (the assumed `get_message` shape has none).
- Bench `p6-i9` (all 30, no rows carried forward; 18 `claude -p` runs, ledger 219 → 237): 8 of 30 pass, gate sum 142 (both unchanged). 1953 stays at 4 with a later blocker: all four replayed model inputs now match n8n's (the From line included); the remaining difference is the reply write, which the comparer cannot pair with n8n's REST send (PROPOSALS P10). 4722 stays at 4, same cause; its first prompt difference moved earlier because the bench's single-use connector rows hand the trigger's detail reads the rows written for the downstream Gmail `get` (PROPOSALS P11), a bench artifact. 2197 (non-simple trigger) still passes. Others unchanged.
- `convert-coverage --split dev`: full 6 → 7 (2197 loses its last review line), review 14 → 13, blocked 40, preflight clean 21; no template gains a blocked step or a preflight error. `node --test` 280 pass (b2 and two driver tests now see the detail call and the display name; golden `poll-code-http` updated and read), lint included.
- Verdict: accepted (rule c: a later blocking cause for 1953, no gate falling, no pass lost).
