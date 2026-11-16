# Round 4 held-out labels vs the analyzer

Fixing sessions must not read this file, `labels-held4.json` or the templates until release point 4 has scored them (EXCLUSIONS.md). Since round 5 they are dev material.

20 hand labels (`labels-held4.json`, committed in c25dfb8 before the analyzer was run on these templates) against `analyze.mjs` with default answers at that commit. Reproduce: `node evals/bench/compare-labels.mjs --labels evals/bench/labels-held4.json` (needs `evals/bench/data/`).

Every template here is round-4 eligible by construction, so the analyzer gives each one outcome `subscription`. This checks targets, wake-ups, blockers and questions. Prior exposure is stated in the labels file.

By the labels:

- **Wake-up:** chat 6, manual 5, schedule 4, poll 2, form 2, sub-workflow 1.
- **Target:** skill 11, local-task 4, cloud-task 2, artifact-form 2, artifact 1.

| Agreement                                  | Templates |
| ------------------------------------------ | --------- |
| Outcome kind                               | 20 / 20   |
| Outcome and target                         | 19 / 20   |
| Wake-up                                    | 20 / 20   |
| Blocker kinds                              | 20 / 20   |
| Questions (all required asked, none extra) | 20 / 20   |
| Everything                                 | 19 / 20   |

## Round 5 setup (P119)

The table above counted 2198, which amendment 1 redrew out of the held-out, and had no label for 2694, which came in. Round 5 made these templates dev, so the file was fixed: 2198's label moved to `redrawnOut` (kept, not compared), and 2694 got a label written from its template JSON alone, after release point 4, so it is not blind (`blind: false`). Over the 20 current templates, against the analyzer at round 5 setup: outcome 20, outcome and target 19 (1957 below), wake-up 20, blockers 20, questions 19 (1554: iteration 39's hosts question for a data-built feed URL, which postdates the labels), everything 18.

## Disagreement

| Id   | Label                 | Analyzer                                        | Who is right                                                                                                                                                                                                                                              |
| ---- | --------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1957 | subscription artifact | subscription skill ("an artifact lacks sample") | The analyzer, under `capabilities.json`. A model step on the artifact surface is `needs:sample`, not `ok`, and the Phase 1 manual-target decision gives `artifact` only when every requirement is `ok`. The label assumed an artifact can call the model. |

## Agreed outcome, disputed detail (for a person, not the loop)

- **4635:** a form with no sign-in that responds after its last node. With the default answer the steps go to a task hand-off. The analyzer's reason says the form can no longer show the result, which matches the label's note.
- **2956:** a Code node that requires an npm package (`youtube-transcript`). n8n loads it only with `NODE_FUNCTION_ALLOW_EXTERNAL` and the package installed, so the bench needs an image flag. Neither side blocks it. Whether the runner's Code sandbox loads packages decides more than the target does.
- **6137:** both real triggers are disabled. What stays is a self-called ingest sub-workflow with no live caller, filling an in-memory vector store. Both sides agree it is a skill.
- **4366, 6137:** an in-memory vector store shared between executions needs a real store.
- **2612:** free-form SQL from the model is read-only under open decision 4. Neither side blocks it.
- **2433, 3132, 2736, 4506:** recipients, keys, document ids or request URLs are left empty or as placeholders for the person to fill. The bench's overlay fills (P78) cover these, so none is a hand case.

## Kinds for the loop

None new. The one disagreement follows from the committed capability table, and nothing here is an analyzer defect.
