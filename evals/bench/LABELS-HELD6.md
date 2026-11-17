# Round 6 held-out labels vs the analyzer

Fixing sessions must not read this file, `labels-held6.json` or the templates until release point 6 has scored them (EXCLUSIONS.md, "Held-out").

20 hand labels (`labels-held6.json`, committed in 5ed5132 before the analyzer was run on these templates) against `analyze.mjs` with default answers at that commit (the analyzer is unchanged since b9d706a, where the walk ran). Reproduce: `node evals/bench/compare-labels.mjs --labels evals/bench/labels-held6.json` (needs `evals/bench/data/`).

Every template here is eligible by the round-4 rule with amendment 1, so the analyzer gives each one outcome `subscription`. This checks targets, wake-ups, blockers and questions. Prior exposure is stated in the labels file.

By the labels:

- **Wake-up:** chat 6, manual 5, schedule 4, poll 2, form 2, sub-workflow 1.
- **Target:** skill 12, cloud-task 5, artifact-form 2, local-task 1.

| Agreement                                  | Templates |
| ------------------------------------------ | --------- |
| Outcome kind                               | 20 / 20   |
| Outcome and target                         | 20 / 20   |
| Wake-up                                    | 20 / 20   |
| Blocker kinds                              | 20 / 20   |
| Questions (all required asked, none extra) | 18 / 20   |
| Everything                                 | 18 / 20   |

**The two disagreements: 5140 and 7647.** The analyzer also asks `writes`, which the labels did not list. Both are RAG chats. The chat run only reads a vector store, but each has a manual ingestion branch that POSTs and PUTs to a placeholder Qdrant host. The analyzer asks `writes` once per workflow, for every step whose effect it assumes, on any branch. So it is right under its own rule, and the question cannot change the outcome.

Stricter, with every `mayAsk` kind counted as expected: 15 of 20 question sets match exactly. The analyzer asked 16 of the 20 `mayAsk` kinds. The four it did not ask are `hosts` on 8785 (its Graph URL is one expression whose host is a literal), `database` and `hosts` on 3761 (its Postgres nodes name an empty credential, and its only HTTP-like steps are local file reads), and `writes` on 8916 (its Postgres statements are not assumed writes).

## Redrawn while labelling

- **574** (manual) was excluded by rule `hand` before any label was written. It is the companion workflow of the Crypto node's docs: a manual trigger and one Crypto node hashing fixed text, a demo of n8n itself (its description says so).
- **695** (manual) was excluded by rule `hand` before any label was written. It is a two-node example of reading the instance's timezone with moment.js inside a Function node, which works only once the instance allows the module: a demo of n8n itself (its description says so).

Both keep their pool and their place in the seeded shuffle (`fetch.mjs` `HAND_AFTER_DRAW`), so only the manual stratum moved, to 3581 and 4755 (`heldOutFresh6.redraws`). Each replacement was labelled from its JSON alone before the analyzer ran on it.

## Agreed outcome, disputed detail (for a person, not the loop)

- **4847:** its schedule rule is empty, so it runs on n8n's default (daily at midnight), which the file does not write. The description promises news fetched with Perplexity, but the agent has no tool.
- **8916, 5140, 7647:** a chat run beside an ingestion branch of another trigger (Drive polls or a manual run) that writes to a vector store. The chat decides the target. The vector store is a requirement, not a blocker.
- **3761:** the chat agent writes SQL that a Postgres step runs as is, and the schema file it reads lives in `/files` on the host disk.
- **5149:** a sub-workflow with no caller in the export that POSTs to `http://gotenberg:3000`, a container on the person's own network.
- **4755:** its public chat trigger is disabled, so only the manual ingestion branch runs.
