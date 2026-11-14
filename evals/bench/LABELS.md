# Refusal labels vs the analyzer

20 hand labels (`labels.json`, committed in 23de3e3 before the analyzer was read for them) against `analyze.mjs` with default answers. Reproduce: `node evals/bench/compare-labels.mjs` (needs `evals/bench/data/`, rebuilt by `node evals/bench/fetch.mjs`).

The pool held no setup-only template, so the 20 are hosted 11 (key 7, no-key 4), keep-in-n8n 7 and replaced 2, by the labels.

| Agreement                                   | Templates |
| ------------------------------------------- | --------- |
| Outcome kind                                | 19 / 20   |
| Outcome and target                          | 18 / 20   |
| Wake-up                                     | 20 / 20   |
| Blocker kinds                               | 18 / 20   |
| Questions (all required asked, none extra)  | 20 / 20   |
| Everything                                  | 17 / 20   |

`questions` passes when every required kind is asked and nothing outside `questions` + `mayAsk` is. The `mayAsk` lists are generous, so this row is lenient.

## Disagreements

| Id   | Label       | Analyzer                                                           | Who is right                                                                                                                                                                                                                                                                                    |
| ---- | ----------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2679 | keep-in-n8n, `unmapped` | hosted no-key                                          | The analyzer, on the file as published. The template lost its edges `Get YouTube Video → YouTube Transcript → Split Out`, so the community node is unreached and no model step is on the main path. My label assumed the intended graph. A broken main path deserves a note, which neither gives. |
| 2845 | hosted key  | hosted no-key, `alsoTargets` relay → hosted key                    | The label. The GET (Meta's `hub.challenge`) and the POST (messages) share one path, because Meta needs one callback URL; they cannot be hosted apart, and the POST runs an agent. Ranking the no-model endpoint first understates what hosting needs.                                           |
| 4110 | blocker `substitution` | Perplexity → Claude as a `substitution` requirement, no blocker | The analyzer, by the PLAN decision ("a `model call → Claude` substitution requirement"). Same substance: approval is needed, and it loses Perplexity's web search. Convention, not a defect.                                                                                                       |

## Agreed outcome, disputed detail

- **2466:** the analyzer marks the two Gemini HTTP calls (transcribe audio, describe video) as `llm-api` model steps with a `model call → Claude` substitution. Claude takes neither audio nor video, so that substitution would fail; these are media calls through the provider. The label is right. The same rule misfires in the corpus: 3188 (rank 200, YouTube video analysis over Gemini HTTP, manual trigger) gets `not-an-automation` because an `llm-api` step does not count as outside I/O, so the tutorial rule excluded a real workflow.
- **1750, 3514, 3050, 2465:** tutorials or "your first …" lessons about n8n by their own descriptions. The name rules missed them; only 1750 is a plain n8n lesson that `hand` should have excluded. Kept, since each is a real refusal.
- **2340, 2462, 4110, 4696:** hosted under the default "outsiders" answer, although the file hints at one operator (an allow-list, a personal pipeline, "personal assistant"). The `chat-app-users` question is the right lever; with "only you" these become local tasks.
