# P137 experiment held-out labels vs the analyzer

Fixing sessions, the drafting-arm build session included, must not read this file, `labels-p137.json` or the templates until a round promotes them (EXCLUSIONS.md, "Held-out").

20 hand labels (`labels-p137.json`, committed in 5ed5132 before the analyzer was run on these templates) against `analyze.mjs` with default answers at that commit (the analyzer is unchanged since `convertCommit` b9d706a). Reproduce: `node evals/bench/compare-labels.mjs --labels evals/bench/labels-p137.json` (needs `evals/bench/data/`).

Every template here is eligible by the round-4 rule with amendment 1, so the analyzer gives each one outcome `subscription`. Each was selected by P137's rule (EXCLUSIONS.md "P137 experiment held-out" step 2), which was known while labelling. Prior exposure is stated in the labels file.

By the labels:

- **Wake-up:** schedule 10, manual 8, form 1, poll 1.
- **Target:** skill 8, cloud-task 7, local-task 4, artifact-form 1.

| Agreement                                  | Templates |
| ------------------------------------------ | --------- |
| Outcome kind                               | 20 / 20   |
| Outcome and target                         | 20 / 20   |
| Wake-up                                    | 20 / 20   |
| Blocker kinds                              | 20 / 20   |
| Questions (all required asked, none extra) | 20 / 20   |
| Everything                                 | 20 / 20   |

Stricter, with every `mayAsk` kind counted as expected: 20 of 20 question sets match exactly. The analyzer asked all 11 `mayAsk` kinds.

No template was excluded or redrawn while labelling.

## Agreed outcome, disputed detail (for a person, not the loop)

- **466, 862, 863:** one-tool examples on fixed inputs (all of HubSpot's contacts, a uProc DNS lookup of n8n.io, a uProc phone check). They are kept as working reads, not demos of n8n.
- **13:** an old export with no trigger node, so it runs by hand.
- **2131, 3609:** the 5-minute interval is n8n's default for a minutes rule. The file does not write it.
- **3077:** its Telegram node has no chat id, a placeholder.
