# P137 result: the plain converter against convert-time drafts

Reading rule: this file names the P137 experiment's held-out templates, so it falls under [EXCLUSIONS.md](EXCLUSIONS.md) "Held-out" like their fixtures, labels and results. A session that changes the skill, the converter or the runtime does not read it until a round promotes the set. PLAN and LOOP carry its aggregates only.

Bar and definitions: [PROPOSALS.md](PROPOSALS.md) P137, amendments 1–4. Scored 2026-11-17 by the experiment's scoring session; nothing in the skill, converter, drafting code, bench or fixtures was changed during the experiment.

## Runs

- Commit **61f5e48** (amendment 4, nothing else changed) for all six tags, n = 19 (the template with no trigger node is out by amendment 4, P142 open). In-process driver, replay, n8n's model calls from the recordings.
- Order: `p137-a`, `p137-b`, `p137-b-approved` (`--drafts-from p137-b`), `p137-a2`, `p137-b2`, `p137-b-approved2` (`--drafts-from p137-b2`). One bench process at a time.
- `claude -p`: 40 runs, all drafting calls (20 per B run; B+approved reused B's drafts; no template reached gate 8, so no driver run). Ledger 2398 → 2438, cap 2560.

## Aggregates

| Tag                | Arm        | Passes | Gate sum | Wrong-effect (am. 3) | Gate-6 | Uncompared (am. 4) | Comparer-table gap at gate 4 |
| ------------------ | ---------- | -----: | -------: | -------------------: | -----: | -----------------: | ---------------------------: |
| `p137-a`           | A          |      0 |       57 |                    0 |      0 |                  0 |                            0 |
| `p137-a2`          | A          |      0 |       57 |                    0 |      0 |                  0 |                            0 |
| `p137-b`           | B          |      0 |       59 |                    1 |      0 |                  0 |                            1 |
| `p137-b2`          | B          |      0 |       59 |                    1 |      0 |                  0 |                            1 |
| `p137-b-approved`  | B+approved |      0 |       63 |                    2 |      0 |                  1 |                            3 |
| `p137-b-approved2` | B+approved |      0 |       65 |                    3 |      0 |                  1 |                            4 |

Flips (`gates.mjs` `flipsBetween`, run against repeat): arm A 0, arm B 0, B+approved 2 (2117 and 6241: their drafts were refused by the docs rule in `p137-b` and accepted in `p137-b2`). Item (1) uses the larger of A's and B's: 0.

"Comparer-table gap" is the bench's existing `bench defect` bucket (`effects the comparer table does not cover`): not a wrong-effect cause under amendment 3, not a pass. The uncompared template (4327, both B+approved runs) is counted in that column too by the bench; amendment 4 reclassifies it.

## Primary bar (shipping decision): don't ship

1. **Passes, B ≥ A + 1 + 2 × flips:** 0 ≥ 0 + 1 + 2 × 0 = 1 fails, in both runs.
2. **Wrong-effect, B ≤ A:** B 1 against A 0, in both runs: fails. The failure (5672) is not a connector call: its Slack writes are paired, and their text is empty because the drafted Airtable search returns Airtable's raw records (`records[*]`, values under `fields`) where n8n's node hands on flattened items.
3. **No gate-6 failure that A lacks:** 0 in every run: holds.
4. **Every drafted step cites docs and passes the rules check:** every accepted draft (7 in `p137-b`, 15 in `p137-b2`) cites docs and has `checks.rules: passed`; refused drafts never reach the runner: holds.

Verdict: **don't ship** (items 1 and 2 fail in both runs).

## Secondary bar (amendment 2, report-only): not reliable

| Run                | Drafted writes approved | Reached gate 4 (bench) | Same effect | Wrong effect | Uncompared | Bench verdict  |
| ------------------ | ----------------------: | ---------------------: | ----------: | -----------: | ---------: | -------------- |
| `p137-b-approved`  |                       4 |                      4 |           0 |            3 |          1 | too few to say |
| `p137-b-approved2` |                      12 |                     12 |           0 |           10 |          2 | not reliable   |

Per approved drafted write (normal fixture, first in-process run):

| Template | Step(s)               | `p137-b-approved`                                                                                     | `p137-b-approved2`                                                                                                                                                                                                                                |
| -------- | --------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2117     | 7 HubSpot deal owners | (drafts refused: docs)                                                                                | 1 uncompared (PATCH `/crm/v3/objects/deals/<id>`, n8n PUT `/deals/v1/deal/<id>`; no comparer rule); 6 reported wrong effect because n8n's one deal write is counted against each step that made none (the switch takes one branch): not exercised |
| 2560     | Discord webhook send  | uncompared (no comparer rule for the webhook)                                                         | same                                                                                                                                                                                                                                              |
| 2716     | Airtable create       | wrong effect: body `{records: [{fields}]}` against n8n's `{fields, typecast}`                         | same                                                                                                                                                                                                                                              |
| 4327     | Airtable create       | bench: wrong effect (no write); amendment 4: uncompared, the Drive connector poll answered by default | same                                                                                                                                                                                                                                              |
| 4885     | Airtable update       | wrong effect: different PATCH bodies (fed by the drafted search's nested `fields`)                    | same                                                                                                                                                                                                                                              |
| 6241     | Airtable create       | (draft refused: docs)                                                                                 | wrong effect: batch body; the fixture answers n8n's single-record form, the draft reads `records[*]`, so the loop ends after one record                                                                                                           |

Read with amendment 4 and the not-exercised attribution: run 1 has 4 drafted writes at gate 4 (0 same, 2 wrong, 2 uncompared): too few to say; run 2 has 6 (0 same, 3 wrong, 3 uncompared): not reliable. No drafted write had n8n's effect in either run, and B+approved has 0 gate-6 failures. Verdict: **not reliable enough to offer behind approval** (the threshold fails in run 2 and cannot hold in run 1).

## Per template

Gate reached and cause; arm A was identical in both runs. "pre" = gate 3, `preflight: blocked steps`; "table" = gate 4, `effects the comparer table does not cover`.

| Template | A (both) | B         | B2        | B+approved            | B+approved2           |
| -------- | -------- | --------- | --------- | --------------------- | --------------------- |
| 11       | pre      | pre       | pre       | pre                   | pre                   |
| 466      | pre      | pre       | pre       | pre                   | pre                   |
| 862      | pre      | pre       | pre       | pre                   | pre                   |
| 863      | pre      | pre       | pre       | pre                   | pre                   |
| 2117     | pre      | pre       | pre       | pre                   | table                 |
| 2131     | pre      | pre       | pre       | pre                   | pre                   |
| 2560     | pre      | pre       | pre       | table                 | table                 |
| 2571     | pre      | pre       | pre       | pre                   | pre                   |
| 2716     | pre      | pre       | pre       | 4 different fields    | 4 different fields    |
| 2889     | pre      | pre       | pre       | pre                   | pre                   |
| 3077     | pre      | pre       | pre       | pre                   | pre                   |
| 3397     | pre      | pre       | pre       | pre                   | pre                   |
| 3703     | pre      | table     | table     | table                 | table                 |
| 4327     | pre      | pre       | pre       | table (am. 4: uncomp) | table (am. 4: uncomp) |
| 4885     | pre      | pre       | pre       | 4 model input differs | 4 model input differs |
| 5672     | pre      | 4 diff f. | 4 diff f. | 4 different fields    | 4 different fields    |
| 6241     | pre      | pre       | pre       | pre                   | 4 different writes    |
| 8968     | pre      | pre       | pre       | pre                   | pre                   |
| 8969     | pre      | pre       | pre       | pre                   | pre                   |

4885's gate-4 cause is two replayed model calls with a different input (the lead name is empty because of the drafted search's nested `fields`); not a wrong-effect cause under amendment 3.

## Drafts per template

Per B run: accepted read / accepted write / refused (rule) / declined / skipped; calls; output tokens; cost at API prices (haiku).

| Template | `p137-b`                         | `p137-b2`                        |
| -------- | -------------------------------- | -------------------------------- |
| 11       | 0/0/0/2/0; 2 calls; 916; $0.0031 | 0/0/0/2/0; 2; 1077; $0.0021      |
| 466      | 0/0/0/1/0; 1; 389; $0.0009       | 0/0/0/1/0; 1; 213; $0.0006       |
| 862      | no target (no operation key); 0  | same                             |
| 863      | no target (no operation key); 0  | same                             |
| 2117     | 0/0/7 docs/0/0; 1; 1628; $0.0016 | 0/7/0/0/0; 1; 1729; $0.0014      |
| 2131     | 0/0/0/1/0; 1; 721; $0.0013       | 0/0/0/1/0; 1; 704; $0.0009       |
| 2560     | 0/1/0/0/0; 1; 1204; $0.0013      | 0/1/0/0/0; 1; 1197; $0.0011      |
| 2571     | no target (connector poll); 0    | same                             |
| 2716     | 0/1/0/0/0; 1; 1311; $0.0017      | 0/1/0/0/0; 1; 1441; $0.0013      |
| 2889     | 0/0/0/0/1 (no host); 0           | same                             |
| 3077     | 0/0/1 docs/2/0; 3; 2661; $0.0036 | 0/0/1 docs/2/0; 3; 2846; $0.0030 |
| 3397     | 0/0/0/1/0; 1; 1862; $0.0017      | 0/0/0/1/0; 1; 1370; $0.0012      |
| 3703     | 1/0/0/0/0; 1; 987; $0.0013       | 1/0/0/0/0; 1; 1277; $0.0012      |
| 4327     | 0/1/0/0/0; 1; 1544; $0.0018      | 0/1/0/0/0; 1; 1198; $0.0013      |
| 4885     | 1/1/0/0/0; 2; 3767; $0.0038      | 1/1/0/0/0; 2; 4118; $0.0033      |
| 5672     | 1/0/0/0/0; 1; 1243; $0.0014      | 1/0/0/0/0; 1; 1401; $0.0012      |
| 6241     | 0/0/1 docs/0/0; 1; 1167; $0.0016 | 0/1/0/0/0; 1; 1396; $0.0013      |
| 8968     | 0/0/0/1/0; 1; 1150; $0.0014      | 0/0/0/1/0; 1; 1469; $0.0012      |
| 8969     | 0/0/0/2/0; 2; 2677; $0.0033      | 0/0/0/2/0; 2; 3177; $0.0030      |

Totals per run, out of 27 target steps on 16 templates (3 templates had no step the pass considers): `p137-b` 3 reads and 4 writes accepted, 9 refused by the docs rule (8 cited no docs, 1 cited developers.google.com for YouTube, outside the rule's domains), 10 declined, 1 skipped; `p137-b2` 3 reads and 12 writes accepted, 1 refused (the same YouTube docs domain), 10 declined, 1 skipped. Declines: pagination (`returnAll`) 3, filter reshaping or an operator not in the parameters 2, multi-request operations (upsert) 1, binary upload 1, fixed constants not in the parameters (YouTube `part`) 2, no matching connector tool (Sheets read, the one tool-map target) 1; one more decline in `p137-b2` replaced a pagination reason with "cannot confirm the endpoint".

Model calls and cost: 15 drafted templates per run, 20 calls each run (1.33 per drafted template), about 8 s per call. `p137-b`: $0.0298, tokens in 44 / out 23,227 / cache read 14,655 / cache write 49,978, $0.0020 per drafted template. `p137-b2`: $0.0241, in 44 / out 24,613 / cache read 48,303 / cache write 16,414, $0.0016 per drafted template. Both runs: 40 calls, $0.0539.

## Where drafting fails

- **Not reached:** 3 of 19 templates had no step the drafting pass considers, though the selection rule counted them (two nodes with no operation key, silently not targets; one connector poll trigger, which the pass never drafts). One more was skipped without a call (no host).
- **The model declines** most targets it is asked about (10 of 26 called steps per run), for real limits of a one-request template: pagination, multi-request operations, binary bodies, fixed constants outside the parameters.
- **The rules check** refuses mostly on docs, and that varies between draws (9 refusals in one run, 1 in the other); every accepted draft passed it.
- **Accepted drafts do not have n8n's effect:** 0 of the drafted writes that reached gate 4 had the same effect, and 2 of the 3 accepted reads change what later steps see (Airtable records with values nested under `fields`, where n8n flattens them). Drafted creates use Airtable's batch body. The rules check, try-step and the held-write dry run do not compare a draft's output items or request form with n8n's node.
- **Unanswered connectors:** no drafted tool map reached the runner (the one tool-map target was declined); one template's Drive connector poll (the converter's own tool map) got the mock's default answer, uncompared by amendment 4.

Proposals from this result: PROPOSALS P143 (drafted output and request shape), P144 (steps the pass silently leaves out), P145 (per-write outcome attribution and comparer rules for drafted REST forms).
