# Phase 0 probe: what a Cowork scheduled task can do

Answers the open questions in PLAN.md Phase 0 on a real account in a few minutes. Nothing is read from n8n and nothing is sent anywhere but the three HTTPS checks.

## Steps for the person

1. Install the plugin in Cowork (Customize > Plugins > Add marketplace, `lunox-work/n8n-to-claude`, then add n8n-to-claude).
2. In Cowork: Scheduled > New task (or ask Claude in a conversation to schedule it). Name: `n8n-to-claude probe`. Frequency: Manual (or hourly). No folder. Paste the prompt below.
3. Run it now, wait for it to finish, then run it now a second time.
4. Copy the last message of both runs back to Claude.

## Prompt

```
Use the n8n-to-claude skill.
1. Run: npx n8n-to-claude@0.4.0 probe
2. List the names of the tools you have whose names start with mcp__, and say whether you have tools named ArtifactData, Artifact, Bash, Write and Skill.
3. Reply with exactly two lines and nothing else:
PROBE <the JSON line the script printed, unchanged>
TOOLS <the tool names from step 2, comma-separated>
If node is missing or the script cannot be found, reply PROBE none and say why in one line.
```

## Reading the result

| Question (PLAN.md Phase 0)              | Where it shows                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| A remote task runs Node from the plugin | `PROBE` is JSON with `node`, and `skillDir` points into the plugin              |
| State survives between runs             | second run: a `folders[].earlierRun` holds the first run's time                 |
| The sandbox reaches outside hosts       | `https` statuses (a number is a reply; `error: …` is blocked)                   |
| Connector tool names in a task          | `TOOLS`: the `mcp__<name>__` prefixes the converter must write for this surface |
| A task can mirror runs to an artifact   | `TOOLS` has `ArtifactData`                                                      |
| Remote or on this computer              | `platform`, `home` and `cwd` (a Linux sandbox path means remote)                |

Hooks are not checked here: the plugin ships no global hook. Record what was seen in `evals/phase0/CHECKS.md` with the date.