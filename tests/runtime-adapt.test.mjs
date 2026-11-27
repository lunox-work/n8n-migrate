// Result adapters, coercion, request templates, model output shapes, the agent tool-call
// protocol and poll cursors in the runner core.
import { test } from "node:test";
import assert from "node:assert/strict";
import { adaptResult, coerceArgs, advanceCursor, applyCursorArg, queryWindow, insideWindow } from "../skills/n8n-to-claude/runtime/src/adapt.mjs";
import { start as stepStart, resume, preflight } from "../skills/n8n-to-claude/runtime/src/api.mjs";
import { wf, node, start, run, out, CLOCK } from "./runtime-helpers.mjs";

test("adaptResult: paths, flattening with parents, field specs, passthrough and empty", () => {
  const output = { threads: [{ id: "t1", messages: [{ id: "m1", headers: [{ name: "Subject", value: "Hi" }], snippet: "a" }, { id: "m2", snippet: "b" }] }, { id: "t2", messages: [] }], next: "p2" };
  const spec = { items: "threads[*].messages[*]", fields: { threadId: "^.id", Subject: { first: ["subject", "headers[0].value"] }, page: "$.next", "payload.mimeType": { const: "text/plain" }, labels: { split: { const: "A, B" } } } };
  assert.deepEqual(adaptResult(spec, output), [
    { id: "m1", headers: [{ name: "Subject", value: "Hi" }], snippet: "a", threadId: "t1", Subject: "Hi", page: "p2", payload: { mimeType: "text/plain" }, labels: ["A", "B"] },
    { id: "m2", snippet: "b", threadId: "t1", page: "p2", payload: { mimeType: "text/plain" }, labels: ["A", "B"] },
  ]);
  assert.deepEqual(adaptResult({ items: "rows[*]", fields: { name: "n" }, passthrough: false }, { rows: [{ n: 1, x: 2 }] }), [{ name: 1 }]);
  assert.deepEqual(adaptResult({ items: "rows[*]" }, { rows: [] }), []);
  assert.deepEqual(adaptResult({ items: "rows[*]", empty: "one" }, { rows: [] }), [{}]);
  assert.deepEqual(adaptResult(undefined, [{ a: 1 }, 2]), [{ a: 1 }, { value: 2 }]);
  assert.deepEqual(adaptResult({}, '{"ok":true}'), [{ ok: true }]);
  assert.deepEqual(adaptResult({}, "plain text"), [{ text: "plain text" }]);
  assert.deepEqual(adaptResult({ fields: { hdr: { headers: "h" } } }, { h: [{ name: "From", value: "a@x" }] }), [{ h: [{ name: "From", value: "a@x" }], hdr: { From: "a@x" } }]);
});

test("coerceArgs: lists from comma text, numbers, booleans, json; undefined dropped", () => {
  assert.deepEqual(coerceArgs({ to: "string[]", n: "integer", b: "boolean", j: "json", s: "string" }, { to: "a@x, b@x,", n: "12.7", b: "false", j: '{"k":1}', s: 5, gone: undefined, keep: "x" }), { to: ["a@x", "b@x"], n: 12, b: false, j: { k: 1 }, s: "5", keep: "x" });
});

test("coerceArgs: a date coerced to a string is its ISO text, as n8n's request body carries it (never quoted JSON)", async () => {
  const { DateTime } = await import("../skills/n8n-to-claude/runtime/vendor/luxon.mjs");
  const today = DateTime.fromISO("2026-11-15T00:00:00.000-05:00", { setZone: true });
  assert.deepEqual(coerceArgs({ title: "string", at: "string", o: "string" }, { title: today, at: new Date("2026-11-15T05:00:00Z"), o: { a: 1 } }), { title: "2026-11-15T00:00:00.000-05:00", at: "2026-11-15T05:00:00.000Z", o: '{"a":1}' });
});

test("poll cursor: max with ids at the boundary, template into an argument", () => {
  const spec = { field: "internalDate", strategy: "max", idField: "id", arg: "query", template: "after:{seconds}" };
  const first = advanceCursor(spec, [{ id: "a", internalDate: "1000" }, { id: "b", internalDate: "2000" }], null);
  assert.deepEqual(first.cursor, { value: "2000", ids: ["b"] });
  const second = advanceCursor(spec, [{ id: "b", internalDate: "2000" }, { id: "c", internalDate: "2000" }, { id: "d", internalDate: "1500" }], first.cursor);
  assert.deepEqual(second.items.map((x) => x.id), ["c"]);
  assert.deepEqual(second.cursor, { value: "2000", ids: ["b", "c"] });
  assert.deepEqual(applyCursorArg(spec, { query: "in:inbox" }, { value: "1763100000000" }), { query: "in:inbox after:1763100000" });
  assert.deepEqual(applyCursorArg(spec, { query: "in:inbox" }, null), { query: "in:inbox" });
});

test("tool step: coerced args and adapted items; preflight fails on missing required args", async () => {
  const tool = { connector: "slack", name: "slack_send_message", args: { channel_id: "C1", message: "=Hi {{ $json.name }}" }, coerce: { message: "string" }, effect: "write", result: { fields: { ok: { const: true } } } };
  const def = wf([start(), node("Post", "n8n-nodes-base.slack", {}, { kind: "tool", tool, pos: [200, 0] })], [["Start", "Post"]], { allow: { tools: [{ connector: "slack", tool: "slack_send_message" }], http: [] } });
  const seen = [];
  const r = await run(def, { trigger: [{ name: "Ann" }, { name: "Bo" }], host: { tool: async (p) => (seen.push(p.args), { ts: "1.2" }) } });
  assert.equal(r.status, "done");
  assert.deepEqual(seen, [{ channel_id: "C1", message: "Hi Ann" }, { channel_id: "C1", message: "Hi Bo" }]);
  assert.deepEqual(out(r, "Post"), [{ ts: "1.2", ok: true }, { ts: "1.2", ok: true }]);
  def.steps.Post.tool.argsCheck = { ok: false, missing: ["channel_id"], unknown: [] };
  assert.equal(preflight(def).ok, false);
});

test("http template step: secret placeholder stays literal, allowlist and secret hosts apply", async () => {
  const step = node("Send", "n8n-nodes-base.telegram", {}, { kind: "http", pos: [200, 0] })[1];
  step.http = { method: "POST", url: "https://api.telegram.org/bot{{secret}}/sendMessage", body: { chat_id: "={{ $json.chat }}", text: "=Hello" } };
  step.auth = { credentialType: "telegramApi", secret: "Bot", placement: "url" };
  const def = wf([start(), ["Send", step]], [["Start", "Send"]], { allow: { tools: [], http: [{ method: "POST", host: "api.telegram.org", pathPrefix: "/bot" }] }, secrets: [{ name: "Bot", credentialType: "telegramApi", hosts: ["api.telegram.org"] }] });
  const reqs = [];
  const r = await run(def, { trigger: [{ chat: 42 }], host: { http: async (q) => (reqs.push(q), { status: 200, body: '{"ok":true,"result":{"message_id":7}}' }) } });
  assert.equal(r.status, "done");
  assert.equal(reqs[0].url, "https://api.telegram.org/bot{{secret}}/sendMessage");
  assert.deepEqual(reqs[0].auth, { credentialType: "telegramApi", secret: "Bot", placement: "url" });
  assert.deepEqual(reqs[0].body, { chat_id: 42, text: "Hello" });
  assert.deepEqual(out(r, "Send"), [{ ok: true, result: { message_id: 7 } }]);
  def.secrets[0].hosts = ["elsewhere.example"];
  const bad = await run(def, { trigger: [{ chat: 42 }], host: { http: async () => ({ status: 200, body: "{}" }) } });
  assert.equal(bad.status, "failed");
  assert.equal(bad.error.name, "ContainmentViolation");
  def.secrets[0].hosts = [];
  assert.match(preflight(def).issues.map((i) => i.message).join("\n"), /names no host/);
  const none = await run(def, { trigger: [{ chat: 42 }], host: { http: async () => ({ status: 200, body: "{}" }) } });
  assert.equal(none.error.name, "PreflightFailed");
  def.secrets[0].hosts = ["api.telegram.org"];
  def.allow.http.push({ method: "GET", host: "*" });
  assert.match(preflight(def).issues.map((i) => i.message).join("\n"), /narrow it to a host/);
});

test("model step: output template, trimming, flag routing and value routing with the input merged", async () => {
  const openAi = node("Ask", "@n8n/n8n-nodes-langchain.openAi", {}, { kind: "model", model: { prompt: "=Q: {{ $json.q }}", outputTemplate: { index: 0, message: { role: "assistant", content: "$output" } } }, pos: [200, 0] });
  const classify = node("Classify", "@n8n/n8n-nodes-langchain.textClassifier", {}, { kind: "model", model: { prompt: "={{ $json.q }}", outputSchema: { type: "object" }, route: { mode: "flags", outputs: ["billing", "bug", "fallback"] } }, pos: [400, 0] });
  const sentiment = node("Mood", "@n8n/n8n-nodes-langchain.sentimentAnalysis", {}, { kind: "model", model: { prompt: "=mood: {{ $json.q }}", outputSchema: { type: "object" }, outputTemplate: { sentimentAnalysis: { category: "$output.sentiment" } }, passInput: true, route: { mode: "value", field: "sentiment", outputs: ["Positive", "Negative"] } }, pos: [400, 200] });
  const def = wf([start(), openAi, classify, sentiment], [["Start", "Ask"], ["Start", "Classify"], ["Start", "Mood"]]);
  const host = {
    model: async (p) => {
      if (p.prompt.startsWith("Q:")) return " fine ";
      if (p.prompt.startsWith("refund")) return { billing: true, bug: true, fallback: false };
      return { sentiment: "negative" };
    },
  };
  const r = await run(def, { trigger: [{ q: "refund please" }], host });
  assert.equal(r.status, "done");
  assert.deepEqual(out(r, "Ask"), [{ index: 0, message: { role: "assistant", content: " fine " } }]);
  assert.deepEqual([out(r, "Classify", 0), out(r, "Classify", 1), out(r, "Classify", 2)], [[{ q: "refund please" }], [{ q: "refund please" }], []]);
  assert.deepEqual(out(r, "Mood", 1), [{ q: "refund please", sentimentAnalysis: { category: "negative" } }]);
});

function agentDef(extra = {}) {
  const search = node("Search mail", "n8n-nodes-base.gmailTool", {}, { kind: "tool", subnode: true, tool: { connector: "gmail", name: "search_threads", args: { query: "={{ $fromAI('query', 'Gmail search', 'string') }}", pageSize: 5 }, effect: "read", result: { items: "threads[*]" } } });
  const agent = node("Agent", "@n8n/n8n-nodes-langchain.agent", {}, {
    kind: "agent",
    agent: { prompt: "={{ $json.chatInput }}", system: "Help.", memory: { kind: "conversation", key: "={{ $json.sessionId }}", window: 3 }, maxIterations: 2, tools: [{ name: "Search_mail", node: "Search mail", kind: "connector", description: "Search Gmail", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, effect: "read" }] },
    pos: [200, 0],
  });
  const d = wf([start(), agent, search], [["Start", "Agent"]], { allow: { tools: [{ connector: "gmail", tool: "search_threads" }], http: [] }, ...extra });
  d.subnodes = [{ from: "Search mail", to: "Agent", type: "ai_tool" }];
  return d;
}

test("agent: tool-call intents run through the runner with $fromAI args; schema errors and unknown tools go back to the model", async () => {
  const calls = [];
  const host = {
    agent: async (p) => {
      if (p.turn === 0) return { intent: "tool-calls", calls: [{ name: "Search_mail", args: { query: "from:ann" } }, { name: "Search_mail", args: {} }, { name: "Delete_all", args: {} }] };
      return { answer: p.transcript[0].results.map((r) => (r.ok ? r.value.length : r.error.message)) };
    },
    tool: async (p) => (calls.push(p), { threads: [{ id: "t1" }, { id: "t2" }] }),
  };
  const r = await run(agentDef(), { trigger: [{ chatInput: "mail from ann?", sessionId: "s1" }], host });
  assert.equal(r.status, "done");
  assert.deepEqual(calls.map((c) => c.args), [{ query: "from:ann", pageSize: 5 }]);
  assert.deepEqual(out(r, "Agent"), [{ output: { answer: [2, "missing required argument: query", 'unknown tool "Delete_all"'] } }]);
  assert.deepEqual(r.effects.map((e) => [e.kind, e.effect]), [["agent", "none"], ["tool", "read"], ["agent", "none"]]);
});

test("agent: memory key and window reach the host; max iterations stop the step; containment applies to tool calls", async () => {
  const seen = [];
  const loop = { agent: async (p) => (seen.push(p), { intent: "tool-calls", calls: [{ name: "Search_mail", args: { query: "x" } }] }), tool: async () => ({ threads: [] }) };
  const r = await run(agentDef(), { trigger: [{ chatInput: "hi", sessionId: "s9" }], host: loop });
  assert.equal(r.status, "failed");
  assert.match(r.error.message, /max iterations/);
  assert.deepEqual(seen[0].memory, { key: "s9", window: 3 });
  assert.deepEqual(seen[0].tools, [{ name: "Search_mail", description: "Search Gmail", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }]);
  const d = agentDef();
  d.allow.tools = [];
  assert.equal(preflight(d).ok, false);
});

test("agent in step mode: each turn and tool call is a request; resume replays to the same point", async () => {
  let res = await stepStart(agentDef(), { trigger: [{ chatInput: "hi", sessionId: "s1" }], clock: CLOCK, runId: "r1" });
  assert.equal(res.status, "needs");
  assert.deepEqual(res.requests.map((q) => [q.id, q.kind, q.turn]), [["Agent#0#0", "agent", 0]]);
  res = await resume(res.state, { "Agent#0#0": { ok: true, value: { intent: "tool-calls", calls: [{ name: "Search_mail", args: { query: "is:unread" } }] } } });
  assert.deepEqual(res.requests.map((q) => [q.id, q.kind, q.args]), [["Agent#0#0.1", "tool", { query: "is:unread", pageSize: 5 }]]);
  res = await resume(res.state, { "Agent#0#0.1": { ok: true, value: { threads: [{ id: "t1" }] } } });
  assert.deepEqual(res.requests[0].transcript, [{ calls: [{ name: "Search_mail", args: { query: "is:unread" } }], results: [{ name: "Search_mail", ok: true, value: [{ id: "t1" }] }] }]);
  res = await resume(res.state, { "Agent#0#0.2": { ok: true, value: "one unread thread" } });
  assert.equal(res.status, "done");
  assert.deepEqual(res.output, [{ output: "one unread thread" }]);
});

test("poll trigger: first production run seeds the cursor and emits nothing; the next emits only new items", async () => {
  const trig = node("New mail", "n8n-nodes-base.gmailTrigger", {}, { kind: "trigger" })[1];
  trig.poll = { tool: { connector: "gmail", name: "search_threads", args: { query: "in:inbox" } }, result: { items: "threads[*]", fields: { internalDate: "date" } }, cursor: { field: "internalDate", strategy: "max", idField: "id", arg: "query", template: "after:{seconds}" } };
  const def = wf([["New mail", trig], node("Keep", "noOp", {}, { pos: [200, 0] })], [["New mail", "Keep"]], { allow: { tools: [{ connector: "gmail", tool: "search_threads" }], http: [] } });
  const queries = [];
  let page = { threads: [{ id: "a", date: "1763100000000" }] };
  const host = { tool: async (p) => (queries.push(p.args.query), page) };
  const r1 = await run(def, { host });
  assert.equal(r1.status, "done");
  assert.equal(r1.runData.Keep, undefined);
  assert.deepEqual(r1.cursors, { "New mail": { value: "1763100000000", ids: ["a"] } });
  page = { threads: [{ id: "a", date: "1763100000000" }, { id: "b", date: "1763100005000" }] };
  const r2 = await run(def, { host, cursors: r1.cursors });
  assert.deepEqual(out(r2, "Keep"), [{ id: "b", date: "1763100005000", internalDate: "1763100005000" }]);
  assert.deepEqual(queries, ["in:inbox", "in:inbox after:1763100000"]);
  const manual = await run(def, { host, mode: "manual" });
  assert.equal(out(manual, "Keep").length, 2);
});

test("adaptResult: a text answer where JSON is read fails the step instead of emitting 0 items", async () => {
  assert.throws(() => adaptResult({ items: "threads[*].messages[*]" }, "Error: rate limit exceeded, try later"), /answered with text where this step reads JSON/);
  assert.throws(() => adaptResult({ fields: { id: "message.id" } }, "not json"), /reads JSON/);
  assert.deepEqual(adaptResult({ items: "threads[*]" }, '{"threads":[]}'), [], "JSON text still parses");
  assert.deepEqual(adaptResult({ parse: "csv" }, "a,b\n1,2"), [{ a: "1", b: "2" }], "CSV expects text");
  assert.deepEqual(adaptResult({ fields: { kind: { const: "x" } } }, "hello"), [{ text: "hello", kind: "x" }], "no paths read: text kept");
  // In a run: the step fails with the node named, not "done" with nothing.
  const def = wf([
    node("Go", "n8n-nodes-base.manualTrigger", {}, { kind: "trigger" }),
    node("Read", "n8n-nodes-base.gmail", {}, { kind: "tool", tool: { connector: "gmail", name: "search_threads", args: {}, effect: "read", result: { items: "threads[*]" } }, pos: [200, 0] }),
  ], [["Go", "Read"]]);
  def.allow = { tools: [{ connector: "gmail", tool: "search_threads" }], http: [], sql: [] };
  const r = await run(def, { host: { tool: async () => "Quota exceeded for this user" } });
  assert.equal(r.status, "failed");
  assert.equal(r.error.node, "Read");
  assert.match(r.error.message, /answered with text/);
});

// Iteration 57: n8n's Drive trigger gives each new file's `name` and `webViewLink`; the
// connector's search rows may name them `title` and `viewUrl`. The trigger's poll adapter
// carries both names, the connector's own name first when it is there.
test("adaptResult: the Drive trigger's poll rows carry n8n's name and webViewLink", async () => {
  const { readFileSync } = await import("node:fs");
  const maps = JSON.parse(readFileSync(new URL("../skills/n8n-to-claude/references/tool-maps.json", import.meta.url), "utf8"));
  const poll = maps.nodes?.["n8n-nodes-base.googleDriveTrigger"]?.[">=1"]?._.poll ?? Object.values(maps).find((m) => m?.["n8n-nodes-base.googleDriveTrigger"])?.["n8n-nodes-base.googleDriveTrigger"][">=1"]._.poll;
  const rows = adaptResult(poll.result, { files: [{ id: "f1", title: "Q4 deck.pdf", viewUrl: "https://drive.example/f1" }, { id: "f2", name: "kept.pdf", title: "other", webViewLink: "https://drive.example/f2" }] });
  assert.deepEqual(rows.map((r) => [r.id, r.name, r.webViewLink]), [
    ["f1", "Q4 deck.pdf", "https://drive.example/f1"],
    ["f2", "kept.pdf", "https://drive.example/f2"],
  ]);
});

// Observed on a real account (2026-11-20): Gmail's connector answers a search with whole
// threads, so "newer_than:1d" brought a four-day-old message along with yesterday's reply in
// the same thread; n8n's node lists single messages and returns only the reply.
test("tool.window: a thread search keeps only the messages inside the query's dates", async () => {
  const now = Date.parse(CLOCK.startedAt); // 2026-11-14T03:00:00Z
  const day = 86400000;
  assert.deepEqual(queryWindow("gmail", "from:ann newer_than:1d", now), { from: now - day, to: Infinity });
  assert.deepEqual(queryWindow("gmail", "older_than:2h newer_than:1y", now), { from: now - 366 * day, to: now - 7200000 });
  assert.deepEqual(queryWindow("gmail", "after:1763100000 before:1763200000", now), { from: 1763100000000, to: 1763200000000 });
  // A calendar date is a day in the mailbox's timezone: widened so nothing n8n may return is dropped.
  assert.deepEqual(queryWindow("gmail", "after:2026/11/13 before:2026-11-15", now), { from: Date.UTC(2026, 10, 13) - 14 * 3600000, to: Date.UTC(2026, 10, 15) + 12 * 3600000 });
  for (const q of ["is:unread", "subject:after:hours", "newer_than:soon", "{after:2026/11/13 from:ann}", "from:ann OR newer_than:1d", "-newer_than:1d", undefined]) assert.equal(queryWindow("gmail", q, now), null, String(q));
  assert.equal(queryWindow("other", "newer_than:1d", now), null);
  const win = { from: 10, to: 20 };
  assert.deepEqual([9, 10, 20, 21, undefined, "not a date"].map((v) => insideWindow(win, v)), [false, true, true, false, true, true]);

  const read = (query) => node("Read mail", "n8n-nodes-base.gmail", {}, { kind: "tool", pos: [200, 0], tool: { connector: "gmail", name: "search_threads", args: { query }, effect: "read", result: { items: "threads[*].messages[*]", fields: { threadId: "^.id" } }, window: { arg: "query", field: "date", syntax: "gmail" } } });
  const threads = { threads: [{ id: "t1", messages: [{ id: "old", date: "2026-11-10T09:00:00Z" }, { id: "reply", date: "2026-11-13T20:00:00Z" }] }, { id: "t2", messages: [{ id: "undated" }, { id: "ms", date: String(now - 3600000) }] }] };
  const go = async (query) => {
    const def = wf([node("Go", "n8n-nodes-base.manualTrigger", {}, { kind: "trigger" }), read(query)], [["Go", "Read mail"]], { allow: { tools: [{ connector: "gmail", tool: "search_threads" }], http: [] } });
    const r = await run(def, { host: { tool: async () => threads } });
    assert.equal(r.status, "done", JSON.stringify(r.error));
    return out(r, "Read mail").map((j) => j.id);
  };
  assert.deepEqual(await go("newer_than:1d"), ["reply", "undated", "ms"], "the old message of the replied-to thread is dropped");
  assert.deepEqual(await go("is:unread"), ["old", "reply", "undated", "ms"], "no dates in the query: every message");
  assert.deepEqual(await go("={{ 'before:' + '2026/11/12' }}"), ["old", "undated"], "the evaluated argument is read");
});
