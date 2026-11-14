# Improvement loop log

Append-only (PLAN Phase 6). One entry per iteration, accepted or discarded: bucket, hypothesis, change, before/after (passes, sum of reached gates, reached gate per template on the 10 dev fixture templates; `convert-coverage --split dev`), verdict. Bench tags are `p6-i<n>`; commits carry the same numbers.

Baseline (`p6-i0`, plain `convert.mjs`, commit before iteration 1): see iteration 0.

## Iteration 0 (baseline and lint)

- Change: `scripts/lint-no-template-rules.mjs` wired into `node --test`; `evals/convert-coverage.mjs --split dev | --ids` with a preflight-clean count and `--per-template`.
- Bench `p6-i0` (plain `convert.mjs`, replayed models, commit 5186070): 0 of 10 pass, gate sum 31. Reached: 2098 3, 2187 3, 2415 3, 2420 3, 2508 3, 2614 3, 2777 3, 2803 3, 3016 3, 4722 4. Same gates and causes as `b2` (headless skill folders).
- `convert-coverage --split dev`: full 4, review 9, blocked 47, preflight clean 15 of 60.
- Blocking levers over the 60 dev templates (templates with a preflight error of that kind; sole blocker in brackets): Sheets without a tool 16 (4), files 10 (2), URL built at run time 10 (2), database 8 (0), media 6, vector store 6 (3), LLM API over HTTP 5 (2), WordPress 4, Facebook Graph 4, forms that wait 2 (1), OpenAI Assistants 1 (1). On the 10 fixture templates only LLM API (2777) and files (2420) are sole blockers.
