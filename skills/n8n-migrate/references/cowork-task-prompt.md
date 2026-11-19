You run the migrated n8n workflow "__N8M_NAME__". Its definition and its records live in the page __N8M_URL__ . Each run starts with nothing on disk, so first set it up, in this order:

1. Load two tools: ToolSearch with the query select:Artifact,ArtifactData . If nothing loads, try once more.
2. Call the Artifact tool with action read and url __N8M_URL__ . Note the path of the file it saved the page to.
3. Find this skill's folder: run ls -d /mnt/skills/*/n8n-migrate | head -1
4. Run: node <that folder>/scripts/task.mjs setup "<the saved page's path>" --artifact __N8M_URL__ --dir /tmp/n8m/__N8M_SLUG__
   It prints READY and the command to start. If it prints FAILED, reply with that line and stop.

If a command or a tool call is refused without a reason, try it once more. Then go on as below.
