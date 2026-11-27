# Plan: migrate in one Cowork conversation

Written 2026-11-19 at commit a983add. Status 2026-11-20: Phases 1, 2 (items 1 to 3) and 3 are built and committed, Phase 0 and Phase 1's finish line ran on the real account; what is left is under "Left" at the end. Design decisions stay in [docs/DESIGN.md](docs/DESIGN.md); this file is the work order, and it is not committed (the launch cleanup a983add took the working plan out of the repository). Script paths here are under `skills/n8n-to-claude/`.

## Goal

A person with n8n and a paid Claude plan, and no terminal, moves a workflow to Claude in one Cowork conversation. Claude Code is the fallback only for workflows that need a stored key.

## Target flow

What the person does, in order:

1. **Add the plugin.** Customize > Plugins > Discover > n8n-to-claude > Add. Until the directory listing exists: "Add marketplace", `lunox-work/n8n-to-claude`.
2. **Connect n8n.** In n8n: Settings > Instance-level MCP > Connect a client > Claude. Fallback: drop an export file into the conversation.
3. **Say "migrate my n8n workflows".**
4. **Read one page.** Three groups, one line of reason each: Ready to move, Needs one thing from you, Stays in n8n for now.
5. **Approve a test run of the easiest workflow.** Sending is held; the page shows what it would have sent.
6. **Click "Switch it on".** n8n goes off, then the scheduled task is created. Then one approval moves the other ready workflows.

Afterwards the same page shows what runs on Claude, the last run and what it sent, and Undo.

## Rules for every screen and message

- **One workflow first.** Carry the easiest one to running before listing work on the rest.
- **No engine words.** Not "cloud task", "local task", "hosted", "definition", "cutover". Say "runs on Claude every morning", "needs your computer on", "stays in n8n".
- **No cliffs.** A workflow that needs a key goes in "Stays in n8n for now" with "a developer can move it". Never point this person at a server, a tunnel or a terminal.
- **One approval per plan.** List every action once, then act (SKILL.md safety rules already allow this).

## Baseline

The 100 most-viewed templates (`evals/bench/corpus.json` rank 1-100), `analyze.mjs` then `convert.mjs`:

| Measure                                     | Count | 2026-11-20 (2f8649e) |
| ------------------------------------------- | ----- | -------------------- |
| Fit the subscription                        | 68    | 68                   |
| Convert clean                               | 15    | 15                   |
| Convert with flagged steps                  | 20    | 20                   |
| Convert with blocked steps                  | 33    | 33                   |
| Need a stored key                           | 38    | 38                   |
| Need a Google token                         | 19    | 18                   |
| Need neither a key nor outbound HTTP        | 14    | 15                   |
| Carry at least one question                 | 31    | 34                   |
| Stay in n8n: sub-workflow not in the export | 7     | 7                    |
| Need hosting: a chat-app bot                | 14    | 14                   |

Each phase reports these again.

The second column is the same measurement with default answers, so it moves little: the search swap and the Telegram poll act only once their question is answered (three more workflows carry a question for that reason), and one Sheets read no longer asks for a Google token. The count that changed for the person this plan is for is the plain view of the same 100 with Gmail, Drive, Notion and Slack connected: **8 ready, 7 need one answer, 85 stay** (51 of those a developer can move). The 85 are: 26 call a web service themselves, 19 need a Google token, 18 need a server, 6 a saved key, 6 a missing sub-workflow, 5 are tutorials, 5 other. Outbound HTTP is the wall, and it is the platform's.

## Phase 0: check Cowork on a real account

Everything about Cowork here comes from Anthropic's help pages (articles 13854387 and 13837440), not from a run. Each row decides a design choice, so this comes first. Record results in `evals/phase0/CHECKS.md`.

Result 2026-11-19 (a claude.ai scheduled task without a repository, run twice from Chrome; `evals/phase0/CHECKS.md`): Node 22 runs, uploaded skills are offered, Claude can create tasks itself (`create_trigger`), connector tools are `mcp__Gmail__…` style. **Nothing persists between runs** and **outbound HTTPS is filtered** (api.github.com yes, example.com no). So the runner needs a record store outside the sandbox (next: ArtifactData through ToolSearch, or a cloud Project), and workflows that call web services stay with Claude Code. Hooks and a plugin's MCP server are still unchecked.

Update 2026-11-19 (later): probes 3 and 4 showed a scheduled task can call ArtifactData (list/get with out_dir, batch with file_path and if_version) and can fetch the workflow's page with the Artifact tool, nested collections included. Built on that (commits a5afa6b, 04729f2): runtime store "artifact" (records in the page's database, pushed before each write and at the end; tests/cowork-task.test.mjs), `scripts/task.mjs` (setup from the page; prompt for the task), Cowork task.json in the page build. A real Cowork conversation then ran the flow on a test workflow: converted, dry-ran the real Gmail read and model step with the draft held, and proposed the four-step switch-on. Found and fixed: a conversation has no ArtifactData (test run now uses `--local`), and the transport refuses case-only duplicate keys (records pack them). Still unrun on the account: a scheduled run that sets itself up from the page and saves records there; the switch-on waits for the person's go-ahead in that conversation.

Update 2026-11-20 (`evals/phase0/CHECKS.md`, sections "Switch-on from a chat", "Templates from n8n to claude.ai", "Web access"): **the Cowork path ran end to end on the real account, twice.** Two workflows went export → chat → held test → one go-ahead → page, task and run once: "Mail digest to a draft" made a Gmail draft, and template 2722, created in n8n cloud and exported from its editor, sent a real email. Each run set itself up from its page and saved its record there. Template 1954 (agent chat) converted to a skill with Claude's search in place of SerpAPI. Fixed from what the runs showed: the n8n switch-off is skipped when the export says it is off (d88164e); the schedule keeps its time (07:41 became 07:03 within the 5-minute rule); a known timezone answers the schedule question (d1aedfc); task records use wall time (9f10637); plain JS dates use the workflow's zone (85d69b1); Gmail thread messages outside the query window are dropped (dc04fbf); the page's hidden rows and plain move-from-n8n panel (9f10637, 418df6d); chat skills are handed over as `.skill` with one-click Save skill (ce0e351). Settled: skill frontmatter hooks run in claude.ai chats, but the generated hook looked in the wrong folder (fixed: 4a0a69f, 4c5ef2c); claude.ai WebFetch summarises pages, so direct web calls stay with Claude Code. Top 60 for a chat user at HEAD: 2 ready, 3 need one question, 55 stay (19 call the web, 11 Google token, almost all of those also call the web).

Status: the probe is built (`scripts/probe.mjs`, steps in `references/probe-task.md`); it answers rows 1, 3 and 5 and shows the task's tool names. It needs a person on a real account, and the plugin branch must be pushed first (`node scripts/skill.mjs plugin-branch --push`) so Cowork installs a plugin that has the probe.

| Check                                                                       | If it fails                                                          |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| A remote scheduled task runs Node from the installed plugin                 | The runner cannot run there; scheduled workflows stay on Claude Code |
| The plugin's hooks fire in a remote scheduled task                          | Ship without the exact-argument check there, and say so in the page  |
| State survives between runs (the artifact database store, or account files) | Only workflows with no cursor move; no resume after a cut-off run    |
| Claude creates the scheduled task from the conversation                     | The person fills the schedule form; the page gives the values        |
| The sandbox reaches outside hosts                                           | Outbound HTTP steps stay out of the Cowork target                    |
| "Add marketplace" installs the `claude-plugin` branch in chat and Cowork    | Fall back to the uploaded zip                                        |
| n8n's connector switches a workflow off from Cowork                         | The page links to the workflow and asks the person to flip it        |

Rows on 2026-11-20 (from the live runs; details in `evals/phase0/CHECKS.md`):

| Check                                                      | Result                                                                                                                                                                             |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A remote scheduled task runs Node from the installed skill | Seen: Node 22, and the task set itself up with the uploaded skill's runtime. Tried with the skill uploaded, not with the plugin                                                    |
| The plugin's hooks fire in a remote scheduled task         | Not tried: only the skill was installed, and a scheduled task runs with hooks off (the model saves each response). Seen instead: a skill's own hooks do run in a claude.ai chat    |
| State survives between runs                                | Not on disk; seen through the workflow page's database, which every run reads and writes                                                                                           |
| Claude creates the scheduled task from the conversation    | Seen (`create_trigger`), three times                                                                                                                                               |
| The sandbox reaches outside hosts                          | Mostly not: the egress proxy refuses them, and WebFetch summarises. Workflows that call the web stay with Claude Code                                                              |
| "Add marketplace" installs the `claude-plugin` branch      | Not tried: the branch on GitHub was still the old one during the runs                                                                                                              |
| n8n's connector switches a workflow off                    | Not tried: the account has no n8n MCP connector of n8n's own and the n8n cloud trial ended. All three exports said the workflow was already off, so the step was skipped each time |

## Phase 1: the Cowork path for connector-only workflows

1. **A Cowork scheduled-task target**: hourly or slower, connectors and model steps only. Done as a plain layer rather than an analyzer target (`scripts/plain.mjs`, `runs: scheduled-task`), so verdicts and the bench do not move; a cadence question covers polls and schedules a task cannot keep, and the answer rewrites the trigger through `overrides.json`. Still open after Phase 0: the record store and tool-name prefixes for that surface.
2. **The runtime ships once, in the plugin.** A migrated workflow becomes its definition (a few KB) instead of a 3.5 MB folder with its own runtime copy and page. Done (5437ff5): `migrate.mjs` converts with `--light` (seven sample workflows 364 KB, was 37 MB; the top 100 sort in 0.9 s into 6.4 MB), and `convert.mjs --build page|skill|task` writes a part when a step needs it. Not yet re-run in a real conversation.
3. **Read through n8n's connector first** (SKILL.md step 1). Detect "no workflow is shared over MCP" and say where to switch it on for a whole project. Done in the SKILL.md chat and Cowork section.
4. **The page**: the three groups, plain reasons, only the questions that change a group. Done: `scripts/migrate.mjs` writes `page.html` (`renderPlainHtml`) and `plan.json`; Claude asks the questions with its own multiple-choice tool, likely answer first, instead of buttons in the page.
5. **The test run in the conversation**: held writes shown in plain words. Written into SKILL.md (dry run, then say what it would have sent); not yet run in Cowork.
6. **Switch on**: n8n off through the connector, then the scheduled task; refuse the other order as `cutover.mjs` does today. Written into SKILL.md with `cutover.mjs ... --done`, `seed`, `enable`; the task creation waits on Phase 0.
7. **Status and Undo** on the same page. Done (90162c3): `scripts/status.mjs` records moved, ran and undone in the page itself; the page lists what runs on Claude with its last run, the link to its history and the undo line; SKILL.md steps 7, 9 and 10. Checked by tests and screenshots, not yet in a real conversation.

Done when a person with no terminal moves one scheduled, connector-only workflow end to end on a real account, and the recording of it is under a minute.

Finish line 2026-11-20: the first half is met (template 2722, see Phase 0's update). The second is not and will not be as written: the real flow took about 11 minutes of wall time and three short replies (3 to the first answer, 2.5 for the held test run, 5 for the switch-on with a 130 s first run); a chat skill took about 3. No recording was made: it would show the account's screen (name, chat titles, real mail), so making one and what may be in it is the owner's decision.

## Phase 2: more workflows reach "Ready to move"

1. **Use what Claude has built in, with one tick of approval.** Search tools (SerpAPI, 4 templates) to Claude's web search; Google Sheets (18) and Calendar (2) to a connector where a tool exists. Search: done (4161f9c, ce94d97): one question per SerpAPI tool, and the answer "claude" builds it on the session's WebSearch with no key; it ran in a real chat (template 1954). Sheets: a read on its own already went through the Drive connector, and no longer asks for a Google token (d9f413a); row writes stay on Google's API because the Drive connector has no row write (17 of the 18 templates write rows). Calendar: not done; the Google Calendar connector is not signed in on the account, so its tools cannot be captured.
2. **Pull missing sub-workflows** in `pull.mjs` over the connector or the API (7 of the 10 "stays in n8n" verdicts). Done before this status (4b3ec83, and SKILL.md's fetch-sub-workflow fix for the connector).
3. **The Telegram poll for owner-only bots** (the `getUpdates` trigger blocked today). Done (d109df4): the trigger polls getUpdates, one update a run, with the restrictions n8n's trigger applies. Unit-tested against a stand-in for Telegram, not run against a real bot.
4. **Resume the bench loop**, ordered by what blocks the top 100: document edits in place, vector stores, forms that wait for a person.

## Phase 3: the Claude Code fallback for workflows that need a key

After one approval, `npx n8n-to-claude` goes on from the report: converts, creates the private repository and the scheduled task, and leaves only the key for the person to type. Today it stops at the report.

Done (58f9960), with one difference: the script converts, commits, creates the private GitHub repository and writes the key names for the person to fill, then opens Claude Code on the folder with the setup request, and Claude Code creates the scheduled task after its own go-ahead. The script does not create the task itself, because nothing we ship drives claude.ai. `gh` and `claude` are stand-ins in the tests; the real push and hand-over have not run.

## Phase 4: launch

1. Submit the plugin to the Claude directory (a public GitHub repo; a person reviews a new listing).
2. README: the Phase 1 recording as the hero, the Cowork flow first, `npx` under "For developers". Done except the recording (2f8649e): the no-terminal route opens Get started with a picture of the page; the hero image is unchanged.
3. Announce to developers on the "Claude alone says move it to 6 of 19 that can't" finding; announce to no-code builders once Phase 1 is done.

## Small fixes

- Done: `CONVERTER_VERSION` now follows the skill's version (0.3.0 today).

## Open decisions

- **A "rewrite" tier for blocked workflows.** Claude rewrites a blocked workflow as a plain skill, labelled as not checked against n8n. More workflows end in something runnable; the "same effects as n8n" claim no longer covers them. This is not the model-drafted request templates that failed in P137. Proposed: an experiment with its own pass bar first.
- **Launch order.** Developers now and no-code builders after Phase 1, or one launch after Phase 1.

## Left (2026-11-20)

Needs the account's owner; nothing else can do these:

1. **Say "push"** (or "rewrite first"). `main` is 0.3.0 and 47 commits ahead of GitHub (a983add); nothing is pushed. The reason it waits: unpushed commit c1c62a4 holds the id of the paused probe task on claude.ai (it is gone from the current file since 549b4b5, not from history: c1c62a4's diff adds the line and 549b4b5's diff shows it removed, so a rewrite has to cover both). It is the only such id: a scan of every line the 47 commits add found no token, key, email of a person, home path or other account id. The public repository has never carried an Anthropic-side account id. Pushing as it is publishes that id for good; it cannot be used without the task's own token. Rewriting first drops it and changes every hash from today that the docs and commit messages cite. Then, in order: `git push origin main`, `node scripts/skill.mjs plugin-branch --push`, `git tag v0.3.0 && git push origin v0.3.0` (the release workflow attaches n8n-to-claude.zip, which the README's first step links to).
2. **Publish 0.3.0 to npm** (passkey), after the push, from HEAD: seven fixes landed after the 0.3.0 version commit (6068a57) and nothing has been published as 0.3.0, so the number stays. Until then `npx n8n-to-claude` is 0.2.0 and stops at the report, while the README describes it going on.
3. **Connect Google Calendar** under Customize > Connectors. Then its tool schemas can be captured and Calendar steps moved off Google's API (Phase 2 item 1); "Suggest meeting slots using AI" is the top-100 workflow it unblocks.
4. **Decide on the recording** (Phase 1's finish line, Phase 4 item 2): a screen recording of the flow shows the account's name, chat titles and real mail. Either record on a clean account, or keep the page picture as it is.
5. **Submit the plugin to the Claude directory** (Phase 4 item 1): the form is filled from the owner's other Claude account and its terms are theirs to accept.
6. **Announce** (Phase 4 item 3): posted by hand; the n8n forum bans AI-written posts.
7. **The two open decisions** above: a "rewrite" tier, and the launch order.

Launch check 2026-11-20 (fdbc7a4 to 2021812, all on `main`, unpushed):

- `node --test`: 695 of 695 on Node 24.21.0 and on Node 20.20.2; the lint, `skill.mjs check` and `build-runtime.mjs --check` pass; `claude plugin validate` passes on the repository and on a dry-run `claude-plugin` branch.
- Fixed on the way: a fresh clone failed one test that reads a fetched template (it skips now); on Node 20 a PDF step failed (`Promise.withResolvers`), six bench tests failed (`Object.groupBy`) and a proxied request's error blamed the proxy's allowed domains; `npx n8n-to-claude --version` was an unknown option and an export outside the current folder was printed as a chain of `../`; PRIVACY.md and the plugin's data note did not cover the sign-in, the GitHub repository, `serve` or the pages; PROOF.md said the skill zip does not upload as built.
- Packaging: the npm tarball is 168 files, 2.5 MB, the skill plus LICENSE, NOTICE, PRIVACY and README; installed from the tarball in an empty folder, the report, `convert` and `serve --help` ran on a sample export. `dist-skills/n8n-to-claude-0.3.0.zip` is built from 2021812. Versions agree in package.json, both plugin manifests and the skill.
- Docs: every relative link, repository path, script and flag named in README, AGENTS, docs/, SKILL.md and its references exists. The release workflow builds `n8n-to-claude.zip`, the file the README's first step links to (the v0.2.0 release already serves that name).
- Not checked here: anything that needs the account, a push or a paid model run.

Not done, and why:

- **The bench loop** (Phase 2 item 4) was not resumed. Where to start it: both dev templates blocked only by "document edits in place" (2872, 3025) use Google Docs `update` with one `insert` text action, so the first lever is a REST program for that operation as n8n 2.47.7 builds it (`POST docs.googleapis.com/v1/documents/<id>:batchUpdate`, body `{requests: [{insertText: {text, endOfSegmentLocation: {segmentId: ""}}}]}`, the reply reduced to `{documentId}` when Simplify is on), with a Google token as Sheets writes have. It also needs a rule for that write in `evals/bench/effects.json`, which is a comparer change for a person to approve. Among the 49 dev templates that stop at a blocked step, no single blocker covers more than two; vector stores block seven but never alone. Its three levers (document edits in place, vector stores, forms that wait for a person) are each a feature with its own fixtures, and a full dev pass is about 3.3 hours and 127 haiku runs on a machine shared with the live tests. A regression pass over the 29 dev templates that touch today's changes (tag `p20-reg`) found no change: all 29 reach the same gate as before, 26 pass, gate sum 245. The other 111 dev templates were not re-run.
- **Run for real, not only against stand-ins:** the Telegram poll (needs a bot), `npx n8n-to-claude` going on to a real GitHub repository and Claude Code, and the page's undo.
- **Phase 0's three untried rows** (plugin hooks in a scheduled task, Add marketplace in a chat or Cowork, n8n's connector switching a workflow off) are in that section's second table. The last one needs an n8n instance with Instance-level MCP connected to Claude.
