# Real bulk export check (2026-11-14)

PLAN Phase 1: "a real export of 20+ workflows produces a report with no crash and no guessed node". **Passes.**

```
node evals/n8n/export-check.mjs        # fresh container, import, export, analyze, diff, down
```

Script: [export-check.mjs](export-check.mjs) (corpus ids in `CORPUS_IDS`). Output in `evals/n8n/.work/export-check/` (git-ignored).

## Setup

- n8n **2.47.7** (`n8nio/n8n:2.47.7`), SQLite, fresh volume, no credentials, on the bench's internal network ([HEADLESS.md](HEADLESS.md)). Nothing executed.
- **35 workflows imported** with `n8n import:workflow --separate`: the author's 11 sibling workflows (files as committed, ids kept) and 24 corpus templates, unwrapped from `.workflow.workflow` and named after the template. Wake-ups: endpoint 8, schedule 7, manual 4, relay 4, chat 4, poll 2, sub-workflow 2, form 2, error 1, MCP server 1. 729 nodes.
- Exported three ways: `--all` (one JSON array), `--backup` (one pretty file per workflow, named `<id>.json`), `--all --separate` (same files, not pretty). Import 4.1 s, each export 1.5 s.

## What import/export changes

| Field                                                                                                                                                                       | Change                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `createdAt`, `updatedAt`, `description`, `isArchived`, `nodeGroups`, `shared`, `sourceWorkflowId`, `staticData`, `triggerCount`, `versionCounter`, `versionMetadata`, `activeVersionId` | added to every workflow                                                           |
| `id`, `versionId`                                                                                                                                                           | assigned when missing (templates have neither); `versionId` always new            |
| `active`                                                                                                                                                                    | `false` for all: import deactivates unless `--activeState=fromJson`               |
| `meta`, `pinData`, `staticData`                                                                                                                                             | `null` when absent (`pinData` may also be `{}`)                                   |
| `tags`                                                                                                                                                                      | sorted by tag id                                                                  |
| node `id`                                                                                                                                                                   | added to nodes that had none                                                      |
| node `credentials`                                                                                                                                                          | 0.x string form `{"mongoDb": "db-mongo"}` becomes `{"mongoDb": {"id": null, "name": "db-mongo"}}` |
| `shared[].project.name`                                                                                                                                                     | the owner's name and email, e.g. `Instance Owner <bench@example.com>`             |

Import refuses deprecated nodes (Function, Function Item, LangChain Code v1) and fails the whole batch unless `N8N_DEPRECATED_NODES_BLOCK=false`. 2 of the top 100 templates have one (1073, 2982).

## Analyzer result

| Input             | Crash | Unmapped | Outcomes (subscription / replaced / hosted / keep) | Questions | Diffs vs originals |
| ----------------- | ----- | -------- | -------------------------------------------------- | --------- | ------------------ |
| original files    | no    | 0        | 17 / 1 / 12 / 5                                    | 36        | n/a                |
| `--all` array     | no    | 0        | 17 / 1 / 12 / 5                                    | 36        | 0                  |
| `--backup` folder | no    | 0        | 17 / 1 / 12 / 5                                    | 36        | 0                  |
| `--separate`      | no    | 0        | 17 / 1 / 12 / 5                                    | 36        | 0                  |

The diff compares each workflow's report field by field. It ignores `id`, `file` and `sourceHash`, and maps workflow ids to names in `calls`, `calledBy`, `sharedState.sharedWith` and question-id prefixes, because import gives templates new ids.

One analyzer bug found and fixed: `sharedState.sharedWith` listed partner workflows in input order. A folder export names files by id, so the same workflows gave a different report as an array than as a folder. Partners are now sorted. Fixture `tests/fixtures/n8n2-export-all.json` is a hand-written 2.x `--all` export (three workflows sharing a Data Table, out of id order, with a published workflow, `{id: null}` credential, static data and an owner in `shared`). A test checks that the report does not depend on input order and never contains the owner's email.
