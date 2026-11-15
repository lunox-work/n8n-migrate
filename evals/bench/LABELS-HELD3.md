# Round 3 held-out labels vs the analyzer

Fixing sessions must not read this file, `labels-held3.json` or the templates until release point 3 has scored them (EXCLUSIONS.md).

20 hand labels (`labels-held3.json`, committed in d607cf7 before the analyzer was run on these templates) against `analyze.mjs` with default answers at that commit. Reproduce: `node evals/bench/compare-labels.mjs --labels evals/bench/labels-held3.json` (needs `evals/bench/data/`).

Unlike the Phase 5 labels (20 refusals), every template here is outcome `subscription` by the analyzer by construction (that verdict decided eligibility), so this checks the analyzer's `subscription` verdicts, targets and wake-ups. Prior exposure is stated in the labels file. The labels are wake-up chat 6, manual 6, schedule 4, poll 2, form 2; outcome subscription 18 (skill 12, cloud-task 2, local-task 2, artifact-form 2) and keep-in-n8n 2.

| Agreement                                  | Templates |
| ------------------------------------------ | --------- |
| Outcome kind                               | 18 / 20   |
| Outcome and target                         | 18 / 20   |
| Wake-up                                    | 19 / 20   |
| Blocker kinds                              | 18 / 20   |
| Questions (all required asked, none extra) | 19 / 20   |
| Everything                                 | 16 / 20   |

## Disagreements

| Id   | Label                                     | Analyzer                                                 | Who is right                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---- | ----------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1150 | keep-in-n8n, `unsupported`                | subscription cloud-task ("fires every 1 d")              | Split. The target is the analyzer's defect on any reading: every read goes to `http://localhost:5678`, which a cloud task cannot reach, so carried at all it is a local task. The outcome is a convention for a person: the label applies the n8n API node decision (a workflow that manages n8n stays) to n8n's REST API over HTTP Request; the decision names only the node.                                                                                      |
| 2374 | wake-up manual                            | wake-up subworkflow ("a sub-workflow with no caller")    | The label. The Execute Workflow Trigger is called by this same workflow (`Trigger Insights`, `$workflow.id`) after the manual branch, so the sub-workflow has a caller and the run starts from the manual trigger. Target skill either way. Neither the label nor the analyzer blocks the Python Code node (numpy, scikit-learn); whether the runner can carry it decides more than the wake-up does.                                                              |
| 3082 | asks `form-outsiders`                     | not asked                                                | The analyzer, defensibly: the form has basic auth, which says who fills it in better than an open form (3314, where it does ask). The label was strict.                                                                                                                                                                                                                                                                                                             |
| 3169 | keep-in-n8n, `unsupported` (IMAP trigger) | subscription local-task, `substitution` (IMAP → Gmail poll) | The analyzer. Reading a mailbox through the Gmail or Microsoft 365 connector instead of IMAP is a substitution of the same kind as SMTP → mail API, the PLAN's own example, which the label itself used for 2537 (agreed: subscription with a `substitution` blocker). The label was inconsistent; the IMAP case belongs with the SMTP one.                                                                                                                          |

Adjudicated: the analyzer is right or defensible on 3169 and 3082, wrong on 2374's wake-up and on 1150's target, and 1150's outcome waits for a person (does the n8n API node decision cover n8n's REST API over HTTP).

## Agreed outcome, disputed detail

- **2824:** Perplexity over HTTP is an LLM API (PLAN decision: model step, `model call → Claude` substitution requirement). Both say skill (unapproved, the call stays `http` with the stored key); the analyzer's reason says the artifact lacks `sample`, not that the unapproved call needs a secret. Approved, the label's `ifAnswered` gives artifact.
- **2292, 5010:** a chat skill that reads a local file (2292: `./chinook.db` for a SQLite agent) or fills an in-memory vector store from a form (5010: n8n process memory shared between two executions). Both agree on skill; both labels mark it `uncertain` because the runtime keeps local disk to local tasks and a process-memory store needs a real one.
- **2201, 2288:** OpenAI Assistants (a thread over a file stored at OpenAI) run through OpenAI with the person's key; neither side calls it a substitution.

## Kinds for the loop (general, no ids; also in LOOP.md)

- An Execute Workflow Trigger that the same workflow calls by `$workflow.id` is reported as a sub-workflow with no caller, and its kind wins the wake-up over the trigger that starts the run (dev shows it too).
- An HTTP step to a loopback host does not stop a cloud-task target (no dev template shows it on a cloud-task path).
- A Python Code node gets no blocker or requirement in the outcome (no decision covers it; for a person).
- n8n's REST API reached through HTTP Request is not treated as the n8n API node (a convention question for a person, not a loop fix).
