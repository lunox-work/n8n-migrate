- "Here's my n8n export, `workflows.json`. Which of these workflows can run on
  my Claude subscription instead of n8n?" The skill runs the fit report and
  gives each workflow's outcome with its reason.
- "Move my daily sales digest workflow to a Claude scheduled task, and show me
  a dry run before anything is sent." The skill converts the workflow, sets
  up a copy with sending held, and says what it would have sent.
- "Cut over the Slack alert workflow: switch it off in n8n and on in Claude
  without anything being sent twice." The skill walks the cutover steps in
  order, with a rollback.
