# P137 experiment held-out labels vs the analyzer

Fixing sessions, the drafting-arm build session included, must not read this file, `labels-p137.json` or the templates until a round promotes them (EXCLUSIONS.md, "Held-out").

20 hand labels (`labels-p137.json`, committed in 5ed5132 before the analyzer was run on these templates) against `analyze.mjs` with default answers at that commit (the analyzer is unchanged since `convertCommit` b9d706a). Reproduce: `node evals/bench/compare-labels.mjs --labels evals/bench/labels-p137.json` (needs `evals/bench/data/`).

Every template here is eligible by the round-4 rule with amendment 1, so the analyzer gives each one outcome `subscription`. Each was selected by P137's rule (EXCLUSIONS.md "P137 experiment held-out" step 2), which was known while labelling. Prior exposure is stated in the labels file.

By the labels:

- **Wake-up:** schedule 9, manual 8, poll 2, form 1.
- **Target:** skill 8, cloud-task 7, local-task 4, artifact-form 1.

| Agreement                                  | Templates |
| ------------------------------------------ | --------- |
| Outcome kind                               | 20 / 20   |
| Outcome and target                         | 20 / 20   |
| Wake-up                                    | 20 / 20   |
| Blocker kinds                              | 20 / 20   |
| Questions (all required asked, none extra) | 20 / 20   |
| Everything                                 | 20 / 20   |

Stricter, with every `mayAsk` kind counted as expected: 19 of 20 question sets match exactly; the analyzer asked 12 of the 13 `mayAsk` kinds (6241's `writes` for its Linkup search POST is not asked).

No template was excluded or redrawn while labelling. The blind fixture session (2026-11-17) excluded two by clause 6 and redrew them by the committed procedure: 3609 (an Information Extractor with no chat model connected) → 4327, and 1478 (a Notion v2 archive whose plain-string page id n8n 2.47.7 reads as an empty resource locator) → 6241 (`labels-p137.json` `redrawnOut`). Each replacement was labelled from its JSON alone, committed in a73b837 and 7e9d37c before the analyzer ran on it, then compared with the checkout's analyzer at the fixture session's HEAD: the table above holds for the set as it stands.

## Agreed outcome, disputed detail (for a person, not the loop)

- **466, 862, 863:** one-tool examples on fixed inputs (all of HubSpot's contacts, a uProc DNS lookup of n8n.io, a uProc phone check). They are kept as working reads, not demos of n8n.
- **13:** an old export with no trigger node, so it runs by hand.
- **2131:** the 5-minute interval is n8n's default for a minutes rule. The file does not write it.
- **3077:** its Telegram node has no chat id, a placeholder.
