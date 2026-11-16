# Round 5 held-out labels vs the analyzer

Fixing sessions must not read this file, `labels-held5.json` or the templates until release point 5 has scored them (EXCLUSIONS.md, "Held-out").

20 hand labels (`labels-held5.json`, committed in e20ce56 before the analyzer was run on these templates; 3200's in 21dbaf0, the same way) against `analyze.mjs` with default answers at that commit. Reproduce: `node evals/bench/compare-labels.mjs --labels evals/bench/labels-held5.json` (needs `evals/bench/data/`).

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

Stricter, with every `mayAsk` kind counted as expected: 19 of 20 question sets match exactly. The analyzer asked 10 of the 11 `mayAsk` kinds. It did not ask `writes` for 4414, whose only POST is the Gemini image-generation call to a model API host. That call is read as a model step, not a write.

## Redrawn while labelling

- **2562** (manual) was excluded by clause 6 (`r4Hand`) before any label was written. Its post step calls `trim()` on a field the step before it never sets, so n8n fails the node. The manual stratum moved to 3809 (`heldOutFresh5.redraws`).
- **1948** (manual) was excluded by clause 6 (`r4Hand`) by the blind fixture session, before any fixture was written. Its file read is inside n8n's own folder, which n8n 2.x blocks by default before it checks any allowed path, so n8n refuses the node. The manual stratum moved to 3200 (`heldOutFresh5.redraws`), labelled from its JSON alone before the analyzer ran on it: it agrees on every column, and the analyzer asks its `mayAsk` kind (`writes`).

## Agreed outcome, disputed detail (for a person, not the loop)

- **3003:** a form with no sign-in that waits for its last node, beside a daily schedule. With the default answer the steps go to a task hand-off, which cannot answer the form. Its Telegram chat id is `$env.TELEGRAM_CHAT_ID`, which n8n refuses when env access in nodes is blocked (an instance setting).
- **4414:** it writes `qr.png` on the n8n host. n8n 2.x restricts file access to its files folder by default, so the bench's host-disk setup decides whether n8n gives a baseline (1948, redrawn out, read inside n8n's own folder).
- **4414:** the Gemini image call is a model step on the Claude side, which makes no image. That is a media gap, not a target question.
- **2897:** the description calls it a trivial demonstration of a workaround for old n8n versions. It is kept because it is one working chat agent.
- **3809, 2023:** HTTP or Sheets nodes name a credential type but carry no credential. The person adds it; the bench's credential dummies (P61) stand in.
- **3880, 3701:** a Gmail recipient is left empty. That is a P91 placeholder.
