// The task driver (runtime/src/driver.mjs via runner.mjs start|next|answer|result|show) and
// the Claude Code hooks (runtime/src/hook.mjs), run from a converted folder exactly as a task
// session would, with the hooks fed the JSON Claude Code sends. No model is called: the evals
// that run claude -p live in evals/task-driver/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { convertItems, writeFolder, loadReferences } from "../skills/n8n-to-claude/scripts/convert.mjs";
import { loadInput } from "../skills/n8n-to-claude/scripts/analyze.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const refs = loadReferences();
const NOW = Date.parse("2026-11-14T00:00:00Z");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

function folderFor(file) {
  const dir = mkdtempSync(join(tmpdir(), "n2c-task-"));
  const [res] = convertItems(loadInput(file).items, { refs, now: NOW });
  return { dir, folder: writeFolder(dir, res, { refs }) };
}
function runner(folder, args, input) {
  const r = spawnSync(process.execPath, ["--max-old-space-size=256", join(folder, "runtime/runner.mjs"), ...args], { cwd: folder, encoding: "utf8", input, env: { ...process.env, N2C_SECRET_ACCOUNTS_API_KEY: "" } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function hook(folder, which, input) {
  const r = spawnSync(process.execPath, [join(folder, "runtime/hook.mjs"), which], { cwd: folder, encoding: "utf8", input: typeof input === "string" ? input : JSON.stringify(input) });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}
const GMAIL = "mcp__claude_ai_Gmail__search_threads";
const SLACK = "mcp__claude_ai_Slack__slack_send_message";
const MAIL = { threads: [{ id: "t1", messages: [{ id: "m1", subject: 'Invoice "42"', sender: "ann@example.com", snippet: "Total $250 \\ due", toRecipients: ["me@example.com"] }] }] };
const content = (v) => [{ type: "text", text: JSON.stringify(v) }];

test("converted folders carry the task files: settings with the minimal allowlist and hooks, task.json, prompt", () => {
  const { dir, folder } = folderFor(join(ROOT, "tests/fixtures/convert/slice.n8n.json"));
  try {
    for (const f of ["runtime/driver.mjs", "runtime/hook.mjs", "task.json", "task-prompt.md", ".claude/settings.json"]) assert.ok(existsSync(join(folder, f)), f);
    const s = readJson(join(folder, ".claude/settings.json"));
    assert.deepEqual(s.permissions, { defaultMode: "dontAsk", allow: ["Bash(node runtime/runner.mjs *)", "Edit(.n2c/inbox/**)", GMAIL, SLACK], deny: ["WebFetch", "WebSearch"] });
    assert.deepEqual(Object.keys(s.hooks), ["PreToolUse", "PostToolUse"]);
    assert.equal(s.hooks.PreToolUse[0].matcher, "^(mcp__.*|ArtifactData)$");
    assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'node "$CLAUDE_PROJECT_DIR/runtime/hook.mjs" pre || exit 2');
    // A cloud task: records go to the n2c-state branch once the folder is in a checkout.
    assert.deepEqual(readJson(join(folder, "task.json")), { hooks: true, compactWhole: true, compactOver: 80, hideToolOutput: true, secrets: "proxy", toolPrefixes: { gmail: "mcp__claude_ai_Gmail__", slack: "mcp__claude_ai_Slack__" }, store: { kind: "git", fallback: "file" } });
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), ".n2c/\n.claude/settings.local.json\n");
    const slug = folder.split("/").pop();
    assert.equal(readFileSync(join(folder, "task-prompt.md"), "utf8"), readFileSync(join(ROOT, "skills/n8n-to-claude/references/task-prompt.md"), "utf8").split("__N2C_RUNNER__").join(`node ${slug}/runtime/runner.mjs`));
    // The repository root (the --out folder) gets the union settings and the hook dispatcher.
    const root = readJson(join(dir, ".claude/settings.json"));
    assert.deepEqual(root.permissions.allow, [`Bash(node ${slug}/runtime/runner.mjs *)`, `Edit(${slug}/.n2c/inbox/**)`, GMAIL, SLACK]);
    assert.equal(root.hooks.PostToolUse[0].hooks[0].command, 'node "$CLAUDE_PROJECT_DIR/n2c-hook.mjs" post');
    assert.ok(existsSync(join(dir, "n2c-hook.mjs")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hooks on: pre-hook containment and fidelity, post-hook capture, placeholders after the first capture, DONE once", async () => {
  const { dir, folder } = folderFor(join(ROOT, "tests/fixtures/convert/slice.n8n.json"));
  try {
    const a = runner(folder, ["start", "--clock", "2026-11-14T00:00:00Z"]);
    assert.equal(a.code, 0, a.err);
    assert.match(a.out, /^NEXT: call one tool \(request q1, step "Get unread mail"\)\.\nTool: mcp__claude_ai_Gmail__search_threads\n/);
    assert.match(a.out, /\{"query":"newer_than:1d is:unread","pageSize":10\}/, "the first call carries the full arguments: no hook has been seen yet");

    // Containment: another tool, other arguments, or a placeholder for the wrong request.
    const send = hook(folder, "pre", { tool_name: "mcp__claude_ai_Gmail__send_message", tool_input: { to: ["attacker@example.com"] }, tool_use_id: "x1" });
    assert.equal(send.hookSpecificOutput.permissionDecision, "deny");
    assert.match(send.hookSpecificOutput.permissionDecisionReason, /is not the runner's next request; the outstanding call is mcp__claude_ai_Gmail__search_threads \(q1\)/);
    const wrong = hook(folder, "pre", { tool_name: GMAIL, tool_input: { query: "in:anywhere", pageSize: 10 }, tool_use_id: "x2" });
    assert.equal(wrong.hookSpecificOutput.permissionDecision, "deny");
    assert.match(wrong.hookSpecificOutput.permissionDecisionReason, /differ from request q1 \(query\)/);
    assert.equal(hook(folder, "pre", { tool_name: GMAIL, tool_input: { n2c: "q9" }, tool_use_id: "x3" }).hookSpecificOutput.permissionDecision, "deny");
    assert.equal(hook(folder, "pre", "not json").hookSpecificOutput.permissionDecision, "deny", "a hook error fails closed");

    // The exact call passes untouched; the response is saved verbatim and hidden from the model.
    assert.equal(hook(folder, "pre", { tool_name: GMAIL, tool_input: { query: "newer_than:1d is:unread", pageSize: 10 }, tool_use_id: "t1" }), null);
    const post = hook(folder, "post", { tool_name: GMAIL, tool_input: { query: "newer_than:1d is:unread", pageSize: 10 }, tool_use_id: "t1", tool_response: content(MAIL) });
    assert.match(post.hookSpecificOutput.updatedMCPToolOutput[0].text, /^Saved as result q1 \(\d+ bytes\)\. Now run: node runtime\/runner\.mjs next$/);
    assert.deepEqual(readJson(join(folder, ".n2c/results/q1.json")), { ok: true, value: MAIL, capturedBy: "hook" });
    // An oversized response reaches the hook as Claude Code's note naming the saved full text.
    const saved = join(dir, "tool-results-big.txt");
    writeFileSync(saved, JSON.stringify(MAIL));
    const note = `Error: result (144,338 characters across 1 line) exceeds maximum allowed tokens. Output has been saved to ${saved}.\nFormat: Plain text`;
    const { overflowResult } = await import(pathToFileURL(join(folder, "runtime/driver.mjs")).href);
    assert.deepEqual(overflowResult(note), { ok: true, value: MAIL });
    assert.equal(overflowResult(note.replace(saved, join(dir, "gone.txt"))).error.name, "ResponseTooLarge");
    assert.equal(overflowResult("a normal text response"), null);
    const dup = hook(folder, "pre", { tool_name: GMAIL, tool_input: { query: "newer_than:1d is:unread", pageSize: 10 }, tool_use_id: "t1b" });
    assert.equal(dup.hookSpecificOutput.permissionDecision, "deny", "a second call for a captured request is refused");

    const b = runner(folder, ["next"]);
    assert.match(b.out, /^NEXT: write an answer yourself \(request q2, step "Summarise", item 0\)/);
    assert.match(b.out, /----- PROMPT -----\nSummarise this email in one sentence for a busy reader\.\nFrom: ann@example\.com\nSubject: Invoice "42"\n\nTotal \$250 \\ due\n----- END PROMPT -----/);
    assert.equal(runner(folder, ["result", "q2"], "x").code, 2, "a model request takes `answer`, not `result`");

    const c = runner(folder, ["answer", "q2"], "Ann's invoice 42 is due: $250.\n");
    assert.equal(c.code, 0, c.err);
    assert.match(c.out, /^Saved q2\.\n\nNEXT: call one tool \(request q3, step "Post to Slack"\)\.\nTool: mcp__claude_ai_Slack__slack_send_message\nArguments, exactly as written \(JSON\):\n\{"n2c":"q3"\}\n/);
    const expected = { channel_id: "C0123456789", message: "*Invoice \"42\"*\nAnn's invoice 42 is due: $250." };
    const full = hook(folder, "pre", { tool_name: SLACK, tool_input: { channel_id: "C0123456789", message: "*Invoice 42*\nsomething else" }, tool_use_id: "s0" });
    assert.match(full.hookSpecificOutput.permissionDecisionReason, /differ from request q3 \(message\)/);
    const sub = hook(folder, "pre", { tool_name: SLACK, tool_input: { n2c: "q3" }, tool_use_id: "s1" });
    assert.deepEqual(sub.hookSpecificOutput, { hookEventName: "PreToolUse", updatedInput: expected });
    hook(folder, "post", { tool_name: SLACK, tool_input: expected, tool_use_id: "s1", tool_response: content({ channel: "C0123456789", ts: "1.2" }) });
    const d = runner(folder, ["next"]);
    assert.equal(d.code, 0);
    assert.match(d.out, /^DONE: run run-\w+ finished \(1 write\(s\)\)\. Stop now\.$/m);
    const state = readJson(join(folder, ".n2c/run.json"));
    assert.equal(state.status, "done");
    assert.deepEqual(state.resultLog["Get unread mail#0#0"].value, MAIL);
    assert.ok(existsSync(join(folder, `.n2c/runs/${state.runId}.json`)));
    // The same run record the artifact page writes (runtime/src/records.mjs), for the artifact's db.
    const rec = readJson(join(folder, `.n2c/records/runs/${state.runId}.json`));
    assert.deepEqual([rec.status, rec.trigger, rec.driver, rec.effects.sent, rec.definitionHash], ["done", "scheduled", "task", 1, state.definitionHash]);
    assert.equal(rec.steps["Post to Slack"].status, "done");
    assert.match(runner(folder, ["start"]).out, /^DONE: .*A run just finished; a new one starts only on the next schedule\./, "a second start right after a run does not run it again");
    const events = readFileSync(join(folder, ".n2c/events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(events.filter((e) => e.event.startsWith("hook-")).map((e) => e.event), ["hook-deny", "hook-deny", "hook-deny", "hook-deny", "hook-allow", "hook-capture", "hook-deny", "hook-deny", "hook-allow", "hook-capture"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hooks off: the model saves responses with `result`; a missing hook degrades to the same path", () => {
  const { dir, folder } = folderFor(join(ROOT, "tests/fixtures/convert/slice.n8n.json"));
  try {
    const t = readJson(join(folder, "task.json"));
    writeFileSync(join(folder, "task.json"), JSON.stringify({ ...t, hooks: false }));
    const a = runner(folder, ["start"]);
    assert.ok(a.out.includes(`use the Write tool to write its full response, exactly as returned (every character), with file_path exactly ${join(realpathSync(folder), ".n2c/inbox/q1.txt")} . Then run: node runtime/runner.mjs result q1`), a.out);
    mkdirSync(join(folder, ".n2c/inbox"), { recursive: true });
    writeFileSync(join(folder, ".n2c/inbox/q1.txt"), JSON.stringify(MAIL) + "\n");
    writeFileSync(join(folder, ".n2c/inbox/q1.txt"), JSON.stringify(MAIL) + "\n");
    const b = runner(folder, ["result", "q1"]);
    assert.match(b.out, /^Saved q1\.\n\nNEXT: write an answer yourself/);
    assert.deepEqual(readJson(join(folder, ".n2c/run.json")).resultLog["Get unread mail#0#0"], { ok: true, value: MAIL });

    // Hooks configured but never firing: the second hand-out offers the save path.
    writeFileSync(join(folder, "task.json"), JSON.stringify({ ...t, hooks: true }));
    runner(folder, ["answer", "q2", "--text", "Summary."]);
    const again = runner(folder, ["next"]);
    assert.match(again.out, /\{"channel_id":"C0123456789","message":"\*Invoice \\"42\\"\*\\nSummary\."\}/, "no placeholder while no hook has run");
    assert.match(again.out, /If you already called this tool for q3 and it returned, do not call it again: save its response instead\./);
    const e = runner(folder, ["result", "q3", "--error"], "channel_not_found");
    assert.equal(e.code, 1);
    assert.match(e.out, /FAILED: run run-\w+ stopped at "Post to Slack": channel_not_found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("long instructions are paged under the Bash output limit; outputSchema answers are checked", async () => {
  const { paths, command, PAGE_CHARS } = await import(pathToFileURL(join(ROOT, "skills/n8n-to-claude/runtime/src/driver.mjs")).href);
  const core = await import(pathToFileURL(join(ROOT, "skills/n8n-to-claude/runtime/src/index.mjs")).href);
  const dir = mkdtempSync(join(tmpdir(), "n2c-page-"));
  try {
    const def = {
      schemaVersion: 1,
      name: "Paged",
      steps: {
        Start: { kind: "trigger", n8n: { type: "n8n-nodes-base.manualTrigger", typeVersion: 1 }, params: {} },
        Ask: { kind: "model", n8n: { type: "@n8n/n8n-nodes-langchain.chainLlm", typeVersion: 1.5 }, params: {}, model: { prompt: "={{ 'x'.repeat(45000) }} END", outputSchema: { type: "object", required: ["n"], properties: { n: { type: "integer" } } } } },
      },
      edges: [{ from: "Start", fromOutput: 0, to: "Ask", toInput: 0 }],
      allow: { tools: [], http: [], sql: [] },
      secrets: [],
    };
    writeFileSync(join(dir, "definition.json"), JSON.stringify(def));
    const run = (cmd, pos = [], flags = {}, input = "") => command(cmd, pos, flags, { core, dir, cwd: dir, stdin: () => input });
    const a = await run("start");
    assert.ok(a.text.length < PAGE_CHARS + 400);
    assert.match(a.text, /\[This is part 1 of 3 of request q1\. Read the next part before doing anything: node runtime\/runner\.mjs show q1 2\]$/);
    const c = await run("show", ["q1", "3"]);
    assert.match(c.text, /END\n----- END PROMPT -----/);
    assert.match(c.text, /This was the last part \(3 of 3\)/);
    assert.equal((await run("answer", ["q1"], {}, "not json")).code, 2);
    assert.match((await run("answer", ["q1"], {}, '{"n": "one"}')).text, /does not match the schema: \$\.n should be integer/);
    const ok = await run("answer", ["q1"], {}, '```json\n{"n": 1}\n```');
    assert.match(ok.text, /DONE/);
    assert.deepEqual(readJson(join(paths(dir).runs, `${readJson(paths(dir).state).runId}.json`)).result.output, [{ output: { n: 1 } }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a model request's image is written to a file the session reads, never printed as base64", async () => {
  const { command } = await import(pathToFileURL(join(ROOT, "skills/n8n-to-claude/runtime/src/driver.mjs")).href);
  const core = await import(pathToFileURL(join(ROOT, "skills/n8n-to-claude/runtime/src/index.mjs")).href);
  const dir = mkdtempSync(join(tmpdir(), "n2c-img-"));
  try {
    const def = {
      schemaVersion: 1,
      name: "Image",
      steps: {
        Start: { kind: "trigger", n8n: { type: "n8n-nodes-base.manualTrigger", typeVersion: 1 }, params: {} },
        Ask: { kind: "model", n8n: { type: "@n8n/n8n-nodes-langchain.chainLlm", typeVersion: 1.4 }, params: {}, model: { prompt: "=Read it", messages: [{ role: "user", image: { binary: "data" } }] } },
      },
      edges: [{ from: "Start", fromOutput: 0, to: "Ask", toInput: 0 }],
      allow: { tools: [], http: [], sql: [] },
      secrets: [],
    };
    writeFileSync(join(dir, "definition.json"), JSON.stringify(def));
    const png = "iVBORw0KGgoAAAANSUhEUg==";
    const a = await command("start", [], { trigger: JSON.stringify([{ json: {}, binary: { data: { mimeType: "image/png", data: png } } }]) }, { core, dir, cwd: dir, stdin: () => "" });
    const m = /\[image 1: ([^\]]+\.png)\]/.exec(a.text);
    assert.ok(m, a.text);
    assert.equal(readFileSync(m[1]).toString("base64"), png);
    assert.ok(!a.text.includes(png));
    assert.match(a.text, /look at it with the Read tool/);
    assert.match(a.text, /Read it/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an agent's final answer that reads as JSON stays text without an output schema; tool-call intents are still JSON", async () => {
  const { paths, command } = await import(pathToFileURL(join(ROOT, "skills/n8n-to-claude/runtime/src/driver.mjs")).href);
  const core = await import(pathToFileURL(join(ROOT, "skills/n8n-to-claude/runtime/src/index.mjs")).href);
  const agentDef = (agent) => ({
    schemaVersion: 1,
    name: "Agent answers",
    steps: {
      Start: { kind: "trigger", n8n: { type: "n8n-nodes-base.manualTrigger", typeVersion: 1 }, params: {} },
      Agent: { kind: "agent", n8n: { type: "@n8n/n8n-nodes-langchain.agent", typeVersion: 1.7 }, params: {}, agent: { prompt: "Classify the mail.", ...agent } },
      Note: { kind: "code", n8n: { type: "n8n-nodes-base.code", typeVersion: 2 }, params: { jsCode: "return [{ json: { kind: typeof $input.first().json.output } }];" } },
    },
    edges: [{ from: "Start", fromOutput: 0, to: "Agent", toInput: 0 }, { from: "Agent", fromOutput: 0, to: "Note", toInput: 0 }],
    allow: { tools: [], http: [], sql: [] },
    secrets: [],
  });
  const output = async (agent, answers) => {
    const dir = mkdtempSync(join(tmpdir(), "n2c-agent-"));
    try {
      writeFileSync(join(dir, "definition.json"), JSON.stringify(agentDef(agent)));
      const run = (cmd, pos = [], input = "") => command(cmd, pos, {}, { core, dir, cwd: dir, stdin: () => input });
      await run("start");
      let last;
      for (const [q, text] of answers) last = await run("answer", [q], text);
      assert.match(last.text, /DONE/, last.text);
      return readJson(join(paths(dir).runs, `${readJson(paths(dir).state).runId}.json`)).result.output;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  // n8n 2.47.7's ToolsAgent keeps the model's output as text unless an output parser is attached.
  const text = '{"label": "invoice", "confidence": 0.9}';
  assert.deepEqual(await output({}, [["q1", text]]), [{ kind: "string" }]);
  assert.deepEqual(await output({}, [["q1", '[1, 2]']]), [{ kind: "string" }]);
  // With an output schema the answer is the JSON value, as n8n's parser returns it.
  assert.deepEqual(await output({ outputSchema: { type: "object", properties: { label: { type: "string" } } } }, [["q1", text]]), [{ kind: "object" }]);
  // A tool-call intent is still read as JSON (here for a tool the step does not have: the
  // runner answers the turn with an error and asks again).
  assert.deepEqual(await output({ tools: [] }, [["q1", '{"intent": "tool-calls", "calls": [{"name": "nope", "args": {}}]}'], ["q2", "plain"]]), [{ kind: "string" }]);
});

test("http requests run in the driver: the secret comes from its source, goes only into the request, never into output", async () => {
  const { executeHttp, mcpValue, expandArgs, compactArgs } = await import(pathToFileURL(join(ROOT, "skills/n8n-to-claude/runtime/src/driver.mjs")).href);
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ ok: 1 }), { status: 201, headers: { "content-type": "application/json" } });
  };
  const req = { kind: "http", method: "POST", url: "https://api.example.com/v1/x", headers: { accept: "application/json" }, query: { a: "1" }, body: { b: 2 }, contentType: "json", auth: { credentialType: "httpHeaderAuth", secret: "Accounts API key" } };
  const r = await executeHttp(req, { secrets: (name) => (name === "Accounts API key" ? '{"header":"X-Api-Key","value":"s3cr3t"}' : undefined) }, fakeFetch);
  assert.deepEqual(r.value.body, { ok: 1 });
  assert.equal(r.value.status, 201);
  assert.equal(seen[0].url, "https://api.example.com/v1/x?a=1");
  assert.equal(seen[0].init.headers["x-api-key"], "s3cr3t");
  assert.equal(seen[0].init.body, '{"b":2}');
  assert.ok(!JSON.stringify(r).includes("s3cr3t"));
  const bearer = await executeHttp(req, { secrets: () => "tok" }, fakeFetch);
  assert.equal(seen[1].init.headers.authorization, "Bearer tok");
  assert.equal(bearer.ok, true);
  const missing = await executeHttp(req, { secrets: "env" }, fakeFetch);
  assert.deepEqual(missing, { ok: false, error: { name: "SecretMissing", message: 'secret "Accounts API key" is not available (local: set N2C_SECRET_ACCOUNTS_API_KEY)' } });
  const failing = await executeHttp(req, { secrets: () => "tok" }, async () => {
    throw new Error("connect failed for tok");
  });
  assert.deepEqual(failing.error, { name: "Error", message: "connect failed for [secret]" });
  await executeHttp({ ...req, url: "https://api.example.com/bot{{secret}}/send", auth: { secret: "T", placement: "url" } }, { secrets: () => "123:abc" }, fakeFetch);
  assert.equal(seen[2].url, "https://api.example.com/bot123%3Aabc/send?a=1");
  await executeHttp(req, { secrets: "proxy" }, fakeFetch);
  assert.equal(seen[3].init.headers.authorization, undefined, "proxy: the environment adds the credential");

  // multipart/form-data is sent as a real form (not JSON): text parts as text, lists repeated,
  // file parts with their name and type; the body is bytes with its boundary header.
  const mp = { kind: "http", method: "POST", url: "https://gitlab.example.com/api/v4/x", headers: { "content-type": "application/json" }, query: {}, contentType: "multipart-form-data", body: { body: "# Review\n\nline two", "position[new_line]": 48, flag: true, empty: null, tag: ["a", "b"], meta: { k: 1 }, file: { $file: { fileName: "a.txt", mimeType: "text/plain", data: Buffer.from("hi").toString("base64") } } } };
  await executeHttp(mp, { secrets: "env" }, fakeFetch);
  const sent = seen[4].init;
  assert.ok(Buffer.isBuffer(sent.body));
  assert.match(sent.headers["content-type"], /^multipart\/form-data; boundary=/);
  const form = await new Request("https://x.test", { method: "POST", headers: { "content-type": sent.headers["content-type"] }, body: sent.body }).formData();
  assert.equal(form.get("position[new_line]"), "48");
  assert.ok(sent.body.includes(Buffer.from("# Review\n\nline two\r\n--")), "values go byte for byte (no CRLF rewrite)");
  assert.match(sent.headers["content-type"], /boundary=-{26}[0-9a-f]{24}$/);
  assert.equal(form.get("flag"), "true");
  assert.equal(form.get("empty"), "null", "form-data sends null as text");
  assert.deepEqual(form.getAll("tag"), ["a", "b"]);
  assert.equal(form.get("meta"), '{"k":1}');
  const file = form.get("file");
  assert.equal(file.name, "a.txt");
  assert.equal(file.type, "text/plain");
  assert.equal(await file.text(), "hi");

  assert.deepEqual(mcpValue([{ type: "text", text: '{"a":1}' }]), { a: 1 });
  assert.equal(mcpValue([{ type: "text", text: "plain" }]), "plain");
  assert.deepEqual(mcpValue({ content: [{ type: "text", text: "x" }], structuredContent: { s: 1 } }), { s: 1 });
  const args = { channel_id: "C1", message: "y".repeat(100), list: ["z".repeat(90)] };
  const compact = compactArgs(args, "q4", 80);
  assert.deepEqual(compact, { channel_id: "C1", message: "@n2c:q4:message", list: ["@n2c:q4:list[0]"] });
  assert.deepEqual(expandArgs(compact, "q4", args), args);
  assert.deepEqual(expandArgs({ n2c: "q4" }, "q4", args), args);
  assert.deepEqual(expandArgs(compact, "q5", args), compact, "a placeholder for another request is not expanded");
});

test("hooks off: a response the session cut for size fails the step instead of passing on the size note", () => {
  const { dir, folder } = folderFor(join(ROOT, "tests/fixtures/convert/slice.n8n.json"));
  try {
    const t = readJson(join(folder, "task.json"));
    writeFileSync(join(folder, "task.json"), JSON.stringify({ ...t, hooks: false }));
    runner(folder, ["start"]);
    mkdirSync(join(folder, ".n2c/inbox"), { recursive: true });
    writeFileSync(join(folder, ".n2c/inbox/q1.txt"), "Error: result (144,338 characters across 1 line) exceeds maximum allowed tokens. Output has been saved to /tmp/n2c-gone.txt.");
    const r = runner(folder, ["result", "q1"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /FAILED: .*too large to pass through the model; this step needs the runner's hooks/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("http redirects are followed hop by hop under the allowlist; a public-only step refuses a name that resolves to a private address", async () => {
  const { executeHttp } = await import(pathToFileURL(join(ROOT, "skills/n8n-to-claude/runtime/src/driver.mjs")).href);
  const { checkContainment, publicAddress } = await import(pathToFileURL(join(ROOT, "skills/n8n-to-claude/runtime/src/engine.mjs")).href);
  const def = { allow: { http: [{ method: "GET", host: "api.example.com" }, { method: "GET", host: "cdn.example.com" }] }, secrets: [{ name: "K", hosts: ["api.example.com"] }] };
  const seen = [];
  const hops = { "https://api.example.com/a": "https://cdn.example.com/b", "https://api.example.com/c": "https://evil.example/d", "https://api.example.com/k": "https://cdn.example.com/k2" };
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    if (hops[url]) return new Response(null, { status: 302, headers: { location: hops[url] } });
    return new Response(JSON.stringify({ at: url }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const req = (url, extra = {}) => ({ kind: "http", method: "GET", url, headers: {}, id: "Fetch#0#0", step: "Fetch", ...extra });
  const check = (r) => (url, method) => checkContainment(def, { ...r, url, method });
  const ok = await executeHttp(req("https://api.example.com/a"), { secrets: "env" }, fetchImpl, { check: check(req("https://api.example.com/a")) });
  assert.deepEqual([ok.ok, ok.value.body.at, seen[0].init.redirect], [true, "https://cdn.example.com/b", "manual"]);
  const off = await executeHttp(req("https://api.example.com/c"), { secrets: "env" }, fetchImpl, { check: check(req("https://api.example.com/c")) });
  assert.equal(off.ok, false);
  assert.match(off.error.message, /evil\.example.*not in the definition's allowlist/);
  // A secret never follows a redirect to a host it may not go to.
  const withKey = req("https://api.example.com/k", { auth: { secret: "K", credentialType: "httpHeaderAuth" } });
  const keyed = await executeHttp(withKey, { secrets: () => "tok" }, fetchImpl, { check: check(withKey) });
  assert.match(keyed.error.message, /secret "K" may not be sent to cdn\.example\.com/);
  // Without a check (as before), fetch follows redirects itself.
  await executeHttp(req("https://api.example.com/z"), { secrets: "env" }, fetchImpl);
  assert.equal(seen.at(-1).init.redirect, "follow");
  // A step answered "public": each hop's host must resolve to public addresses only.
  const pub = await executeHttp(req("https://rebind.example/x"), { secrets: "env" }, fetchImpl, { check: () => {}, publicOnly: true, isPublicAddress: publicAddress, resolve: async () => ["93.184.216.34", "127.0.0.1"] });
  assert.match(pub.error.message, /resolves to 127\.0\.0\.1/);
  const fine = await executeHttp(req("https://site.example/x"), { secrets: "env" }, fetchImpl, { check: () => {}, publicOnly: true, isPublicAddress: publicAddress, resolve: async () => ["93.184.216.34"] });
  assert.equal(fine.ok, true);
  assert.deepEqual(["10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"].filter(publicAddress), []);
  assert.deepEqual(["93.184.216.34", "2606:2800:220:1::1"].filter(publicAddress).length, 2);
});

test("http in the driver: a binary body goes as bytes; a file response or a binary type comes back as bodyBase64", async () => {
  const { executeHttp, BINARY_CONTENT_TYPES } = await import(pathToFileURL(join(ROOT, "skills/n8n-to-claude/runtime/src/driver.mjs")).href);
  const nodes2 = await import(pathToFileURL(join(ROOT, "skills/n8n-to-claude/runtime/src/nodes2.mjs")).href);
  assert.deepEqual(BINARY_CONTENT_TYPES, nodes2.BINARY_CONTENT_TYPES, "the driver and the runtime agree on n8n's binary content types");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push(init);
    return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
  };
  const up = await executeHttp({ kind: "http", method: "POST", url: "https://wp.example.com/wp-json/wp/v2/media", headers: { "content-type": "image/png" }, body: png.toString("base64"), bodyEncoding: "base64", contentType: "binaryData", response: { format: "autodetect" } }, { secrets: "env" }, fakeFetch);
  assert.ok(Buffer.isBuffer(seen[0].body) && seen[0].body.equals(png));
  assert.equal(up.value.bodyBase64, png.toString("base64"));
  assert.equal(up.value.body, undefined);
  const text = await executeHttp({ kind: "http", method: "GET", url: "https://x.example.com/a", headers: {}, response: { format: "text" } }, { secrets: "env" }, async () => new Response("héllo", { headers: { "content-type": "image/png" } }));
  assert.equal(text.value.body, "héllo", "an explicit text format stays text whatever the type");
});

test("an HTTP Request whose response may be a file tells the host its response format, so the task driver keeps the bytes", async () => {
  const { run } = await import(pathToFileURL(join(ROOT, "skills/n8n-to-claude/runtime/src/api.mjs")).href);
  const { executeHttp } = await import(pathToFileURL(join(ROOT, "skills/n8n-to-claude/runtime/src/driver.mjs")).href);
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x08, 0x00, 0x8b, 0xff, 0x00, 0xe9]);
  const def = (options) => ({
    schemaVersion: 1,
    name: "Download",
    steps: {
      Start: { kind: "trigger", n8n: { type: "n8n-nodes-base.manualTrigger", typeVersion: 1 }, params: {} },
      Download: { kind: "http", n8n: { type: "n8n-nodes-base.httpRequest", typeVersion: 4.2 }, params: { url: "https://files.example.com/a.xlsx", options } },
    },
    edges: [{ from: "Start", fromOutput: 0, to: "Download", toInput: 0 }],
    allow: { tools: [], http: [{ method: "GET", host: "files.example.com" }], sql: [] },
    secrets: [],
  });
  const fetch = async () => new Response(zip, { status: 200, headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
  const asked = [];
  // The host is the task driver's executeHttp, as in a local task.
  const host = { http: async (p) => (asked.push(p), (await executeHttp({ kind: "http", ...p }, { secrets: "env" }, fetch)).value) };
  const r = await run(def({}), { clock: { startedAt: "2026-11-16T09:00:00Z" }, virtualTime: true, trigger: { node: "Start", items: [{ json: {} }] }, host });
  assert.equal(r.status, "done");
  assert.deepEqual(asked[0].response, { format: "autodetect" });
  const bin = r.runData.Download[0].data.main[0][0].binary.data;
  assert.equal(Buffer.from(bin.data, "base64").equals(zip), true, "the bytes arrive unchanged");
  // A JSON or text response format is the runtime's own business.
  asked.length = 0;
  await run(def({ response: { response: { responseFormat: "json" } } }), { clock: { startedAt: "2026-11-16T09:00:00Z" }, virtualTime: true, trigger: { node: "Start", items: [{ json: {} }] }, host: { http: async (p) => (asked.push(p), { status: 200, headers: { "content-type": "application/json" }, body: {} }) } });
  assert.equal(asked[0].response, undefined);
});
