# Round 5 held-out labels vs the analyzer

Fixing sessions must not read this file, `labels-held5.json` or the templates until release point 5 has scored them (EXCLUSIONS.md, "Held-out").

20 hand labels (`labels-held5.json`, committed in e20ce56 before the analyzer was run on these templates; 3200's in 21dbaf0, 683's in 0a8b17b and 4036's in c5ad752, the same way) against `analyze.mjs` with default answers at that commit. Reproduce: `node evals/bench/compare-labels.mjs --labels evals/bench/labels-held5.json` (needs `evals/bench/data/`).

Every template here is eligible by the round-4 rule with amendment 1, so the analyzer gives each one outcome `subscription`. This checks targets, wake-ups, blockers and questions. Prior exposure is stated in the labels file.

By the labels:

- **Wake-up:** chat 6, manual 5, schedule 4, poll 2, form 2, sub-workflow 1.
- **Target:** skill 11, local-task 6, artifact-form 2, cloud-task 1.

| Agreement                                  | Templates |
| ------------------------------------------ | --------- |
| Outcome kind                               | 20 / 20   |
| Outcome and target                         | 20 / 20   |
| Wake-up                                    | 20 / 20   |
| Blocker kinds                              | 20 / 20   |
| Questions (all required asked, none extra) | 20 / 20   |
| Everything                                 | 20 / 20   |

Stricter, with every `mayAsk` kind counted as expected: 20 of 20 question sets match exactly. The analyzer asked all 11 `mayAsk` kinds.

## Redrawn while labelling

- **2562** (manual) was excluded by clause 6 (`r4Hand`) before any label was written. Its post step calls `trim()` on a field the step before it never sets, so n8n fails the node. The manual stratum moved to 3809 (`heldOutFresh5.redraws`).
- **1948** (manual) was excluded by clause 6 (`r4Hand`) by the blind fixture session, before any fixture was written. Its file read is inside n8n's own folder, which n8n 2.x blocks by default before it checks any allowed path, so n8n refuses the node. The manual stratum moved to 3200 (`heldOutFresh5.redraws`), labelled from its JSON alone before the analyzer ran on it: it agrees on every column, and the analyzer asks its `mayAsk` kind (`writes`).
- **4414** (schedule) was excluded by clause 6 (`r4Hand`) by the blind fixture session, before any fixture was written. Its If passes on only the rows a Sheets lookup returned, and each has the looked-up column, so the If's false branch, the only path to its post and its Sheets append, is never taken and n8n reaches no write. The schedule stratum moved to 683 (`heldOutFresh5.redraws`), labelled from its JSON alone before the analyzer ran on it: it agrees on every column, and the analyzer asks its `mayAsk` kind (`timezone`).
- **3259** (chat) was excluded by clause 6 (`r4Hand`) by the blind fixture session, before its fixtures were written. The sheet it creates gets one column, but its append maps 13, and n8n 2.x's Sheets append refuses a header that lacks any of them. The chat stratum had no candidate left, so the views walk continued after the round's walk (PROPOSALS P126) and its first eligible chat entry, 4036, came in. It was labelled from its JSON alone before the analyzer ran on it, and it agrees on every column.

## Agreed outcome, disputed detail (for a person, not the loop)

- **3003:** a form with no sign-in that waits for its last node, beside a daily schedule. With the default answer the steps go to a task hand-off, which cannot answer the form. Its Telegram chat id is `$env.TELEGRAM_CHAT_ID`, which n8n refuses when env access in nodes is blocked (an instance setting).
- **2897:** the description calls it a trivial demonstration of a workaround for old n8n versions. It is kept because it is one working chat agent.
- **3809, 2023:** HTTP or Sheets nodes name a credential type but carry no credential. The person adds it; the bench's credential dummies (P61) stand in.
- **3880, 3701:** a Gmail recipient is left empty. That is a P91 placeholder.
