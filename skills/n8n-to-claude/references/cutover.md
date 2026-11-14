# Cutover (placeholder)

PLAN Phase 7; another unit writes this file. Until then the order is the artifact's Cutover checklist (`records.mjs` `cutoverChecklist`):

1. Dry run clean: Run now with dry run on, until it ends done with this definition. Nothing is sent while n8n is still live.
2. Seed cursor (poll workflows): the Cutover panel's Seed copies the dry run's cursor into the scheduled cursor, so the first scheduled run does not replay history. Without the artifact, the first scheduled run seeds itself and emits nothing.
3. Enable the schedule (`setup-cloud-task.md`, `setup-local-task.md`).
4. Deactivate the n8n workflow once a scheduled run is clean.

Rollback: disable the task, re-activate the n8n workflow, and carry the cursor back. Not yet specified: shared Data Tables moving first, pinData replay against n8n's output.
