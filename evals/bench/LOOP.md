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
