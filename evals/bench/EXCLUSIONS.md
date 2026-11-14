# Bench corpus: exclusion rules

Fixed on 2026-11-14, before the corpus was fetched or any template was labelled. `evals/bench/fetch.mjs` applies them in this order (`excludeReason()`); the first rule that fires is written to `corpus.json` as `excluded`. An excluded template counts toward nothing: neither the 100 eligible, nor the labelled pool. It still counts in "coverage of the top 100" when that is reported raw.

| Rule          | Excluded when                                                                                                                                                                                                                                                                                         | Why                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `paid`        | the listing entry has `price > 0` or a `purchaseUrl`                                                                                                                                                                                                                                                  | the workflow is not freely available  |
| `unavailable` | the template download fails after 3 tries, or `.workflow.workflow` has no `nodes` array or no `connections` object                                                                                                                                                                                    | nothing to run                        |
| `notes-only`  | no node that is enabled and not a sticky note                                                                                                                                                                                                                                                         | only sticky notes                     |
| `no-edges`    | at least 2 enabled non-sticky nodes and no `main` connection between any two of them                                                                                                                                                                                                                  | a node gallery, not a workflow        |
| `duplicate`   | its sha256 (`canonical()` of `.workflow.workflow`) equals that of a template earlier in the listing                                                                                                                                                                                                   | counted once                          |
| `tutorial`    | the analyzer (default answers) gives a `not-an-automation` blocker, or an enabled node is an n8n training node (`n8nTrainingCustomerDatastore`, `n8nTrainingCustomerMessenger`), or the name matches `TUTORIAL_NAME` (below)                                                                          | a tutorial or demo about n8n itself   |
| `hand`        | excluded by reading the template, for one of the reasons above that the mechanical rules missed. Only allowed with a one-line reason in `corpus.json`, decided from the template alone (never from the analyzer's outcome), and only for templates that are tutorials, demos of n8n, or not workflows | the regexes cannot see every tutorial |

`TUTORIAL_NAME` (case-insensitive), applied to the template name:

- any of the words `tutorial`, `course`, `lesson`, `beginner`, `beginners`, `getting started`, `101`, `walkthrough`, `cheat sheet`, `cheatsheet`, `playground`; or
- the word `n8n` together with any of `learn`, `learning`, `guide`, `demo`, `example`, `examples`, `basics`, `intro`, `introduction`, `explained`, `features`, `how to`.

Names that contain `demo` or `example` without `n8n` are not excluded, only flagged `flag: "name-demo"` in `corpus.json`, so a reader can apply `hand` with a reason.

Not excluded on purpose, because they are real refusals the bench should measure: community or unmapped nodes, the n8n API node, error workflows, synchronous webhooks, public chat pages, disabled triggers, and templates whose only trigger is manual.

## Held-out

`splits.json` holds `dev` (60) and `held-out` (40). A session that changes the skill, the converter or the runtime must never read the held-out templates, their fixtures or their results; it runs only at release points (PLAN Phase 6).
