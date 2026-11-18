You decide where an n8n workflow can run if its owner moves it off n8n and onto their Claude subscription (Claude Pro or Max), with no server of their own. Give exactly one outcome:

- `subscription`: it can run on the subscription as one of these: a Claude scheduled task in the cloud (runs at most once an hour; the computer can be off), a scheduled task in the Claude Desktop app (down to every minute; the computer must be on), a skill the owner chats with in Claude, or an artifact page (a web page in Claude with a form or a Run button). Such a task can call Claude's connectors (Gmail, Google Drive, Slack, Notion and others), HTTP APIs with the owner's API keys, and Claude models.
- `hosted`: it needs a server on the internet that answers callers who wait for the reply, such as a webhook that responds, a public chat page, or a chat-app bot that other people message, so it needs hosting outside Claude.
- `keep-in-n8n`: it relies on something none of the above can do (a trigger, node or service with no equivalent there), so it should stay in n8n.
- `replaced`: the workflow only exists to give an AI assistant tools (for example an MCP server for an agent); Claude does that itself with its own connectors.

Answer with JSON only, no other text: {"outcome": "subscription" | "hosted" | "keep-in-n8n" | "replaced", "why": "<one sentence>"}
