// Bench gate logic (evals/bench/gates.mjs): pure decisions from observed results.

import { test } from "node:test";
import assert from "node:assert/strict";
import { gate1, gate2, gate3, gate4, gate5, gate6, gate7, gate8, robustness, reached, runFailureCause, BUCKETS, gapsOf, gapPatterns, connectorLimited, failedStep } from "../evals/bench/gates.mjs";
import { credentialTypeFor, credentialData, modelNodes, recordingInterrupted } from "../evals/bench/n8n-side.mjs";
import { compare, fromTool, baitHits } from "../evals/bench/compare.mjs";

test("gate 1: unmapped nodes and crashes fail, a clean report passes", () => {
  assert.equal(gate1({ workflows: [{ outcome: { kind: "subscription", target: "skill" }, unmapped: [] }] }).pass, true);
  const u = gate1({ workflows: [{ unmapped: [{ type: "n8n-nodes-x.y" }] }] });
  assert.deepEqual([u.pass, u.bucket], [false, "unmapped node"]);
  assert.equal(gate1(null, "boom").bucket, "runner bug");
});

test("gate 2: refused, invalid, nodes missing, accounted", () => {
  const def = { steps: { A: { kind: "trigger" }, B: { kind: "blocked", blocked: { reason: "x" } } } };
  assert.equal(gate2({ folder: "/f", definition: def, templateNodes: ["A", "B"] }).pass, true);
  assert.match(gate2({ folder: "/f", definition: def, templateNodes: ["A", "B", "C"] }).cause, /C/);
  assert.match(gate2({ folder: "/f", definition: null, report: { workflows: [{ outcome: { kind: "hosted", reason: "r" } }] } }).cause, /refused: hosted/);
  assert.equal(gate2({ folder: "/f", definition: def, validateIssues: [{ level: "error", path: "$", message: "m" }], templateNodes: [] }).bucket, "runner bug");
  assert.equal(gate2({ folder: null, skillError: "timeout" }).bucket, "skill instruction");
});

test("gate 3 causes: blocked steps, tool arguments, untranslated steps, replay misses", () => {
  assert.equal(gate3({ status: "done" }).pass, true);
  const pf = (m) => ({ status: "failed", error: { name: "PreflightFailed", issues: [{ level: "error", message: m, step: "S" }] } });
  assert.equal(gate3(pf("blocked: file steps need the files lever")).bucket, "unmapped node");
  assert.equal(gate3(pf("needs translation (expression)")).bucket, "expression translation");
  assert.equal(gate3(pf("tool gmail.x is not in allow.tools")).bucket, "field map");
  assert.equal(gate3({ status: "failed", error: { message: "Invalid arguments for label_message: $.labelIds is required", node: "G" } }).bucket, "field map");
  assert.equal(runFailureCause({ error: { message: "no recorded model reply for M#3" } }).bucket, "bench defect");
  for (const g of [gate3(pf("x"))]) assert.ok(BUCKETS.includes(g.bucket));
});

test("gate 4: baseline, model inputs, writes, model-written diffs, judge", () => {
  const w = (labels) => fromTool({ connector: "gmail", tool: "label_message", args: { messageId: "m1", labelIds: labels } });
  const ok = compare([w(["L1"])], [w(["L1"])]);
  assert.equal(gate4({ cmp: ok, n8nStatus: "success" }).pass, true);
  assert.equal(gate4({ cmp: ok, n8nStatus: "error" }).bucket, "fixture");
  assert.equal(gate4({ cmp: ok, n8nStatus: "success", modelInputs: [{ step: "A", index: 0, input: { same: false, at: "x" } }] }).bucket, "field map");
  const diff = compare([w(["L1"])], [w(["L2"])]);
  assert.equal(gate4({ cmp: diff, n8nStatus: "success" }).bucket, "field map");
  const md = compare([w(["L1"])], [w(["L2"])], { modelTexts: ["L1", "L2"], mode: "replay" });
  assert.equal(gate4({ cmp: md, n8nStatus: "success" }).bucket, "flaky model step");
  assert.equal(gate4({ cmp: ok, n8nStatus: "success", judged: [{ verdict: "worse" }] }).bucket, "flaky model step");
});

test("gate 5: the robustness relation", () => {
  assert.equal(robustness(false, false), "equal");
  assert.equal(robustness(false, true), "better");
  assert.equal(robustness(true, false), "worse");
  assert.equal(robustness(true, true, { ok: true }), "equal");
  assert.equal(robustness(true, true, { ok: false }), "worse");
  assert.equal(gate5({ empty: { relation: "equal" }, malformed: { relation: "better" } }).pass, true);
  const f = gate5({ empty: { relation: "worse", claudeOk: false, claudeRun: { error: { message: "Invalid arguments for x" } } } });
  assert.deepEqual([f.pass, f.bucket], [false, "field map"]);
});

test("gate 6: outside the allow lists, bait only when n8n did not carry it", () => {
  const allow = { tools: [{ connector: "slack", tool: "slack_send_message" }], http: [{ method: "GET", host: "api.x.test", pathPrefix: "/v1" }] };
  const good = { tools: [{ connector: "slack", tool: "slack_send_message" }], http: [{ method: "GET", url: "https://api.x.test/v1/a" }] };
  const post = fromTool({ connector: "slack", tool: "slack_send_message", args: { channel_id: "C1", message: "mail from evil@x.test" } });
  assert.equal(gate6({ claudeCalls: good, allow, claudeEffects: [], bait: [], baitHits }).pass, true);
  assert.equal(gate6({ claudeCalls: { tools: [{ connector: "gmail", tool: "send_message" }] }, allow, claudeEffects: [], bait: [], baitHits }).pass, false);
  assert.equal(gate6({ claudeCalls: { http: [{ method: "POST", url: "https://api.x.test/v1/a" }] }, allow, claudeEffects: [], bait: [], baitHits }).pass, false);
  assert.equal(gate6({ claudeCalls: good, allow, claudeEffects: [post], bait: ["evil@x.test"], baitHits }).pass, false);
  const n8nHits = baitHits([post], ["evil@x.test"]);
  assert.equal(gate6({ claudeCalls: good, allow, claudeEffects: [post], n8nBaitHits: n8nHits, bait: ["evil@x.test"], baitHits }).pass, true, "the workflow copies the text by design");
});

test("gate 7, gate 8, reached", () => {
  const p = { pass: true };
  assert.equal(gate7([{ 3: p, 4: p, 5: p, 6: p }, { 3: p, 4: p, 5: p, 6: p }, { 3: p, 4: p, 5: p, 6: p }]).pass, true);
  assert.equal(gate7([{ 3: p, 4: p, 5: p, 6: p }, { 3: p, 4: { pass: false }, 5: p, 6: p }, { 3: p, 4: p, 5: p, 6: p }]).pass, false);
  const ceiling = { wallS: 300, turns: 60, costUsd: 0.1 };
  assert.equal(gate8({ wallMs: 20000, turns: 10, costUsd: 0.01 }, ceiling).pass, true);
  assert.equal(gate8({ wallMs: 20000, turns: 10, costUsd: 0.01 }, ceiling, { intervalS: 10 }).pass, false);
  assert.equal(gate8(null, ceiling).bucket, "bench defect");
  assert.equal(reached({ 1: p, 2: p, 3: { pass: false } }), 3);
  assert.equal(reached({ 1: p, 2: p, 3: p, 4: p, 5: p, 6: p, 7: p, 8: p }), 9);
});

test("gate 8 names why the claude-driver measurement is missing", () => {
  const g = gate8(undefined, { wallS: 600, turns: 40, costUsd: 0.5 }, { missing: "the folder has http steps" });
  assert.deepEqual([g.pass, g.bucket], [false, "bench defect"]);
  assert.match(g.cause, /http steps/);
});

test("connector-limited: a data failure downstream of a gapped read that mentions the gap field", () => {
  const fx = { reads: [{ node: "Get", connector: { connector: "gmail", calls: [] }, connectorGaps: ["headers: raw headers", "labels as {id, name}: ids only"] }, { node: "Other", connector: { none: "no connector" }, connectorGaps: ["row_number: x"] }] };
  const gaps = gapsOf(fx);
  assert.deepEqual(gaps.map((g) => g.field), ["headers", "labels as {id, name}"], "a read without a connector has no connector gap");
  const wf = { connections: { Get: { main: [[{ node: "Agent" }]] }, Tool: { ai_tool: [[{ node: "Agent" }]] } } };
  const g4 = { pass: false, bucket: "field map", cause: "1 replayed model call(s) got a different input", detail: [{ step: "Agent", claude: "List-Unsubscribe Header: ``" }] };
  assert.equal(failedStep(g4), "Agent");
  assert.deepEqual(connectorLimited(g4, 4, gaps, wf).map((h) => h.field), ["headers"]);
  assert.equal(connectorLimited({ ...g4, detail: [{ step: "Elsewhere", claude: "Header" }] }, 4, gaps, wf), null, "the failing step must be downstream of the gapped read");
  assert.equal(connectorLimited({ pass: false, bucket: "unmapped node", cause: "preflight: blocked steps", detail: ["labels"] }, 3, gaps, wf), null, "a preflight refusal is never connector-limited");
  assert.equal(connectorLimited({ pass: false, bucket: "field map", cause: "step Agent got input without a field n8n's data has: Cannot read properties of undefined" }, 3, gaps, wf), null, "JavaScript's 'properties' names no field");
  assert.equal(connectorLimited(g4, 6, gaps, wf), null, "only gates 3-5");
  assert.ok(gapPatterns("block ids and types")[0].test("a block") && !gapPatterns("block ids and types")[0].test("blocked steps"));
  assert.ok(gapPatterns("property ids")[0].test("properties"));
});

test("bench credentials: types for nodes shipped without one, direct services point at the mock, OAuth dummies", () => {
  assert.equal(credentialTypeFor({ type: "n8n-nodes-base.googleSheets", parameters: {} }), "googleSheetsOAuth2Api");
  assert.equal(credentialTypeFor({ type: "n8n-nodes-base.googleSheets", parameters: { authentication: "serviceAccount" } }), "googleApi");
  assert.equal(credentialTypeFor({ type: "n8n-nodes-base.httpRequest", parameters: { authentication: "genericCredentialType", genericAuthType: "httpQueryAuth" } }), "httpQueryAuth");
  assert.equal(credentialTypeFor({ type: "n8n-nodes-base.httpRequest", parameters: {} }), null);
  assert.equal(credentialTypeFor({ type: "@n8n/n8n-nodes-langchain.vectorStoreQdrant", parameters: {} }), "qdrantApi");
  assert.equal(credentialTypeFor({ type: "n8n-nodes-base.googleCalendarTool", parameters: {} }), "googleCalendarOAuth2Api");
  assert.equal(credentialData("qdrantApi").qdrantUrl, "http://mock:8080");
  assert.equal(credentialData("supabaseApi").host, "http://mock:8080");
  assert.equal(credentialData("s3", { s3Endpoint: "https://s3.x.example" }).endpoint, "https://s3.x.example");
  assert.equal(credentialData("linkedInOAuth2Api").oauthTokenData.access_token, "bench-access-token");
});

test("model nodes: OpenRouter chat models and the legacy OpenAI node's chat resource", () => {
  const wf = { nodes: [
    { name: "OR", type: "@n8n/n8n-nodes-langchain.lmChatOpenRouter", parameters: {} },
    { name: "Chat", type: "n8n-nodes-base.openAi", parameters: { resource: "chat" } },
    { name: "Image", type: "n8n-nodes-base.openAi", parameters: { resource: "image" } },
  ] };
  const m = modelNodes(wf, { models: ["Chat", "Image"] });
  assert.deepEqual(m.map((x) => [x.node, x.credType]), [["OR", "openRouterApi"], ["Chat", "openAiApi"]]);
  assert.equal(m[0].spec.data("http://mock:8080/model/m0").url, "http://mock:8080/model/m0/v1");
  const o = modelNodes({ nodes: [{ name: "Ollama Model", type: "@n8n/n8n-nodes-langchain.lmOllama", parameters: {} }] }, { models: [] });
  assert.deepEqual(o.map((x) => [x.node, x.credType]), [["Ollama Model", "ollamaApi"]], "the Ollama completion node is a model node");
  assert.equal(o[0].spec.data("http://mock:8080/model/m0").baseUrl, "http://mock:8080/model/m0");
});

test("P12: a recording interrupted on the model side is told apart from a real baseline failure", () => {
  const models = [{ tag: "m0", node: "Chat Model" }];
  const consumers = { "Chat Model": ["Agent"] };
  const ok = { status: "success", nodes: {} };
  assert.equal(recordingInterrupted({ result: ok, modelCalls: [{ mode: "live" }], models, consumers }), null);
  assert.match(recordingInterrupted({ result: ok, modelCalls: [{ tag: "m0", node: "Chat Model", index: 1, mode: "error", error: "memory stayed under 40%" }], models, consumers }), /model shim error on Chat Model#1/);
  const aborted = { status: "error", error: { node: "Agent", message: "The connection was aborted, perhaps the server is offline" }, nodes: {} };
  assert.match(recordingInterrupted({ result: aborted, modelCalls: [], models, consumers }), /^Agent: The connection was aborted/);
  const parser = { status: "error", error: { node: "Agent", message: "Failed to parse the model output" }, nodes: {} };
  assert.equal(recordingInterrupted({ result: parser, modelCalls: [], models, consumers }), null, "a model node failing on what the model said is a baseline");
  const httpNode = { status: "error", error: { node: "Fetch", message: "ECONNRESET" }, nodes: {} };
  assert.equal(recordingInterrupted({ result: httpNode, modelCalls: [], models, consumers }), null, "a non-model node's failure is the template's");
});

test("P14: a bench claude -p carries no prompt in argv, and the prompt reaches stdin byte for byte, NUL included", async () => {
  const { claudeArgv, spawnWithPrompt } = await import("../evals/bench/claude.mjs");
  const argv = claudeArgv({ model: "haiku", budgetUsd: 0.5, args: ["--tools", ""] });
  assert.equal(argv[0], "-p");
  assert.equal(argv[1], "--model", "nothing positional follows -p");
  const prompt = "chat text with a NUL \u0000 byte and ünïcode";
  const child = spawnWithPrompt(process.execPath, ["-e", "let b=[];process.stdin.on('data',c=>b.push(c));process.stdin.on('end',()=>process.stdout.write(Buffer.concat(b).toString('hex')))"], prompt);
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  await new Promise((ok) => child.on("exit", ok));
  assert.equal(Buffer.from(out, "hex").toString("utf8"), prompt);
});

test("P13: the stand-in's answer envelope written as the reply text is unwrapped, nested too; other JSON stays", async () => {
  const { envelopeOf, modelAnswer } = await import("../evals/bench/model-shim.mjs");
  const env = (text) => JSON.stringify({ type: "text", text });
  assert.deepEqual(modelAnswer({ type: "text", text: "plain" }), { text: "plain" });
  assert.deepEqual(modelAnswer({ type: "text", text: env("Mercredi : un seul événement.") }), { text: "Mercredi : un seul événement." });
  assert.deepEqual(modelAnswer({ type: "text", text: `  ${env(env('{"needsReply":true}'))}\n` }), { text: '{"needsReply":true}' }, "repeated while it nests; the inner JSON reply stays text");
  assert.deepEqual(modelAnswer({ type: "text", text: JSON.stringify({ type: "tool_use", calls: [{ name: "Get_News", input: { URL: "u" } }] }) }), { calls: [{ name: "Get_News", input: { URL: "u" } }] });
  assert.deepEqual(modelAnswer({ type: "tool_use", calls: [{ name: "t" }] }), { calls: [{ name: "t", input: {} }] });
  // Not the envelope: other keys, another type, JSON inside prose, a fenced block, a JSON reply that only looks alike.
  for (const t of [JSON.stringify({ type: "text", text: "x", extra: 1 }), JSON.stringify({ type: "message", text: "x" }), `Here: ${env("x")}`, "```json\n" + env("x") + "\n```", '{"text":"x"}', '{"type":"text"}'])
    assert.deepEqual(modelAnswer({ type: "text", text: t }), { text: t }, t);
  assert.equal(envelopeOf(env("x")).text, "x");
  assert.equal(envelopeOf("not json"), null);
  // A text that is an object (the answer schema wants a string) is its JSON text.
  assert.deepEqual(modelAnswer({ type: "text", text: { __structured__output: { needsReply: true } } }), { text: '{"__structured__output":{"needsReply":true}}' });
  assert.deepEqual(modelAnswer({ type: "text", text: JSON.stringify({ type: "text", text: { a: 1 } }) }), { text: '{"a":1}' });
  assert.deepEqual(modelAnswer({ type: "text" }), { text: "" });
});

test("P15: a replayed agent turn after a tool call needs the tools run on the Claude side with the same reads", async () => {
  const { sameToolTurn, claudeReadKeys } = await import("../evals/bench/claude-side.mjs");
  // n8n (OpenAI format): call 0 asks for Get_News and Get_Weather; call 1 carries both results.
  const asked = [
    { id: "call_a", type: "function", function: { name: "Get_News", arguments: '{"URL":"https://feeds.example/rss.xml"}' } },
    { id: "call_b", type: "function", function: { name: "Get_Weather", arguments: "{}" } },
  ];
  const n8nPrev = { format: "openai", seq: 10, response: { choices: [{ message: { role: "assistant", content: null, tool_calls: asked } }] } };
  const n8nCall = { format: "openai", seq: 13, request: { messages: [{ role: "user", content: "q" }, { role: "assistant", content: null, tool_calls: asked }, { role: "tool", tool_call_id: "call_a", content: "<rss/>" }, { role: "tool", tool_call_id: "call_b", content: '{"t":8}' }] } };
  const n8nEffects = [
    { seq: 11, method: "GET", proxied: "https://feeds.example", path: "/rss.xml" },
    { seq: 12, method: "GET", proxied: "https://api.weather.example", path: "/v1/forecast" },
    { seq: 20, method: "GET", proxied: "https://later.example", path: "/x" },
  ];
  const n8nSources = { "Get News": "http/tls-intercept", "Get Weather": "http/tls-intercept" };
  const calls = [{ name: "Get_News", args: {} }, { name: "Get_Weather", args: {} }];
  const both = claudeReadKeys([], [{ method: "GET", url: "https://feeds.example/rss.xml", query: {} }, { method: "GET", url: "https://api.weather.example/v1/forecast", query: {} }]);
  const ok = sameToolTurn({ n8nPrev, n8nCall, n8nEffects, n8nSources, claudeTurn: { calls, results: [{ name: "Get_News", ok: true, value: "<rss/>" }, { name: "Get_Weather", ok: true, value: { t: 8 } }], reads: both } });
  assert.deepEqual([ok.same, ok.reads], [true, 2], "the read after call 1 (seq 20) is not this turn's");

  // A tool the runtime cannot run: not executed.
  const blocked = sameToolTurn({ n8nPrev, n8nCall, n8nEffects, n8nSources, claudeTurn: { calls, results: [{ name: "Get_News", ok: false, error: { message: 'tool "Get_News" (rssFeedReadTool) cannot run in the runtime' } }, { name: "Get_Weather", ok: true, value: {} }], reads: both.slice(1) } });
  assert.deepEqual([blocked.same, blocked.cause, blocked.detail[0].tool], [false, "tool call not executed", "Get_News"]);
  // No call of that name at all.
  assert.equal(sameToolTurn({ n8nPrev, n8nCall, n8nEffects, n8nSources, claudeTurn: { calls: calls.slice(1), results: [{ ok: true }], reads: both.slice(1) } }).cause, "tool call not executed");
  // Ran, but read something else than n8n did.
  const other = sameToolTurn({ n8nPrev, n8nCall, n8nEffects, n8nSources, claudeTurn: { calls, results: [{ ok: true, value: "<rss/>" }, { ok: true, value: { t: 8 } }], reads: claudeReadKeys([], [{ method: "GET", url: "https://feeds.example/other.xml", query: {} }, { method: "GET", url: "https://api.weather.example/v1/forecast", query: {} }]) } });
  assert.equal(other.cause, "different tool result");
  assert.equal(other.detail.onlyN8n.length, 1);
  assert.equal(other.detail.onlyClaude.length, 1);
  // Both sides' tool failed (n8n fed back an empty result): nothing to blame on the migration.
  const n8nEmpty = { ...n8nCall, request: { messages: [...n8nCall.request.messages.slice(0, 2), { role: "tool", tool_call_id: "call_a", content: "" }, n8nCall.request.messages[3]] } };
  assert.equal(sameToolTurn({ n8nPrev, n8nCall: n8nEmpty, n8nEffects: n8nEffects.filter((e) => e.seq !== 11), n8nSources, claudeTurn: { calls, results: [{ ok: false, error: { message: "boom" } }, { ok: true, value: { t: 8 } }], reads: both.slice(1) } }).same, true);
  // Without model seq, or with a pinned tool, the reads are unchecked and say so.
  const okResults = [{ ok: true, value: "<rss/>" }, { ok: true, value: { t: 8 } }];
  assert.match(sameToolTurn({ n8nPrev: { ...n8nPrev, seq: null }, n8nCall, n8nEffects, n8nSources, claudeTurn: { calls, results: okResults, reads: [] } }).reads, /unchecked/);
  assert.match(sameToolTurn({ n8nPrev, n8nCall, n8nEffects, n8nSources: { ...n8nSources, "Get News": "pin" }, claudeTurn: { calls, results: okResults, reads: [] } }).reads, /unchecked.*Get News/);
  // n8n's previous reply asked no tool: not a turn after a tool call.
  assert.equal(sameToolTurn({ n8nPrev: { format: "openai", response: { choices: [{ message: { content: "done" } }] } }, n8nCall, claudeTurn: { calls: [], results: [] } }), null);

  // Gemini: results named, not id'd.
  const gPrev = { format: "gemini", seq: 1, response: { candidates: [{ content: { parts: [{ functionCall: { name: "Get_Weather", args: {} } }] } }] } };
  const gCall = { format: "gemini", seq: 3, request: { contents: [{ role: "user", parts: [{ text: "q" }] }, { role: "model", parts: [{ functionCall: { name: "Get_Weather", args: {} } }] }, { role: "user", parts: [{ functionResponse: { name: "Get_Weather", response: { result: "[]" } } }] }] } };
  assert.equal(sameToolTurn({ n8nPrev: gPrev, n8nCall: gCall, n8nEffects: [{ seq: 2, method: "GET", proxied: "https://api.weather.example", path: "/v1/forecast" }], n8nSources, claudeTurn: { calls: [{ name: "Get_Weather" }], results: [{ ok: false, error: { message: "unknown tool" } }], reads: [] } }).cause, "tool call not executed");
});

test("P15: gate 4 fails a replayed agent turn whose tools were not run, after the model-input check", () => {
  const cmp = compare([], []);
  const turn = (tools) => ({ step: "Agent", index: 1, mode: "replay", input: { same: true }, tools });
  const miss = gate4({ cmp, modelInputs: [turn({ same: false, cause: "tool call not executed", detail: [{ tool: "Get_News", claude: "cannot run" }] })], n8nStatus: "success" });
  assert.deepEqual([miss.pass, miss.bucket, miss.cause, miss.detail[0].tools[0].tool], [false, "field map", "tool call not executed", "Get_News"]);
  const diff = gate4({ cmp, modelInputs: [turn({ same: false, cause: "different tool result", detail: { tools: ["T"], onlyN8n: ["a"], onlyClaude: [] } })], n8nStatus: "success" });
  assert.deepEqual([diff.cause, diff.detail[0].onlyN8n], ["different tool result", ["a"]]);
  assert.equal(gate4({ cmp, modelInputs: [turn({ same: true, reads: 1 })], n8nStatus: "success" }).pass, true);
  const both = gate4({ cmp, modelInputs: [{ step: "A", index: 1, input: { same: false, at: "x", n8nAround: "y" }, tools: { same: false, cause: "tool call not executed" } }], n8nStatus: "success" });
  assert.match(both.cause, /different input/, "a different question is reported first");
});

test("P17: fed-back tool values are compared with n8n's tool message per provider format", async () => {
  const { sameToolTurn, sameToolValue } = await import("../evals/bench/claude-side.mjs");
  const { normalize } = await import("../evals/bench/model-shim.mjs");
  // A node used as a tool: n8n sends JSON.stringify of its items' json, always a list.
  assert.deepEqual(sameToolValue({ text: '[{"id":7,"name":"Ada"}]' }, { name: "Ada", id: 7 }), { same: true, shape: "n8n sends a list of one item, the runtime the item" });
  assert.equal(sameToolValue({ text: '[{"id":7},{"id":8}]' }, [{ id: 7 }, { id: 8 }]).same, true);
  assert.equal(sameToolValue({ text: '[{"id":7},{"id":8}]' }, [{ id: 7 }]).same, false);
  // The Workflow tool pretty-prints; a Code tool returns text.
  assert.equal(sameToolValue({ text: '[\n  {\n    "a": 1\n  }\n]' }, { a: 1 }).same, true);
  assert.equal(sameToolValue({ text: "42 rows  found" }, "42 rows found").same, true);
  assert.deepEqual(sameToolValue({ text: "42 rows found" }, "41 rows found").same, false);
  // Run-time timestamps are masked (P4).
  const runTime = { startMs: Date.parse("2026-11-16T14:00:00Z"), zone: "America/New_York" };
  assert.equal(sameToolValue({ text: '{"at":"2026-11-16T14:00:01.000Z"}' }, { at: "2026-11-16T14:00:07.000Z" }, runTime).runTimeMasked, true);
  // Gemini: functionResponse.response.result.
  const g = normalize("gemini", { contents: [{ role: "user", parts: [{ functionResponse: { name: "Lookup", response: { result: '[{"ok":true}]' } } }] }] });
  assert.equal(g.messages[0].result, '[{"ok":true}]');
  assert.equal(sameToolValue(g.messages[0], { ok: true }).same, true);
  // Anthropic: tool_result content blocks.
  const a = normalize("anthropic", { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: '{"n":1}' }] }] }] });
  assert.equal(sameToolValue(a.messages[0], { n: 1 }).same, true);

  // In a turn: a Code tool makes no read, so only the value can tell (P15 compared two empty sets).
  const asked = [{ id: "call_c", type: "function", function: { name: "Calc", arguments: '{"x":2}' } }];
  const n8nPrev = { format: "openai", seq: 1, response: { choices: [{ message: { role: "assistant", content: null, tool_calls: asked } }] } };
  const n8nCall = { format: "openai", seq: 2, request: { messages: [{ role: "user", content: "q" }, { role: "assistant", content: null, tool_calls: asked }, { role: "tool", tool_call_id: "call_c", content: "4" }] } };
  const turn = (value) => sameToolTurn({ n8nPrev, n8nCall, n8nEffects: [], n8nSources: {}, claudeTurn: { calls: [{ name: "Calc" }], results: [{ ok: true, value }], reads: [] } });
  assert.deepEqual([turn(4).same, turn(4).values, turn(4).reads], [true, 1, 0]);
  const bad = turn(5);
  assert.deepEqual([bad.same, bad.cause, bad.detail.values[0].tool, bad.detail.values[0].n8n, bad.detail.values[0].claude], [false, "different tool result", "Calc", "4", "5"]);
});

test("P18: one list of shim-answered model types; the validator errors on models the shim cannot answer", async () => {
  const { SHIM_MODELS, UNSHIMMED_MODELS, modelRoute, modelNodes } = await import("../evals/bench/n8n-side.mjs");
  const { modelErrors } = await import("../evals/bench/validate.mjs");
  const LC = "@n8n/n8n-nodes-langchain.";
  for (const t of ["lmChatDeepSeek", "lmChatXAiGrok", "lmChatMoonshot", "lmChatNvidia", "lmChatMinimax", "lmChatVercelAiGateway", "lmChatAlibabaCloud", "lmChatLemonade", "lmLemonade", "lmChatAzureOpenAi", "lmChatGroq", "lmChatMistralCloud", "lmChatGoogleVertex", "lmOpenHuggingFaceInference"]) assert.ok(SHIM_MODELS[LC + t], t);
  for (const t of ["lmChatCohere", "lmCohere", "lmChatAwsBedrock", "lmChatDatabricks"]) assert.ok(UNSHIMMED_MODELS[LC + t], t);
  const deep = SHIM_MODELS[LC + "lmChatDeepSeek"].data("http://mock:8080/model/m0");
  assert.equal(deep.url, "http://mock:8080/model/m0/v1");
  assert.equal(SHIM_MODELS[LC + "lmChatAzureOpenAi"].data("http://mock:8080/model/m1").endpoint, "http://mock:8080/model/m1");
  assert.match(modelRoute({ type: LC + "lmChatAzureOpenAi", parameters: { authentication: "azureEntraCognitiveServicesOAuth2Api" } }).why, /Entra/);
  assert.equal(modelRoute({ type: LC + "lmChatGoogleVertex", parameters: { location: "europe-west4" } }).host, "europe-west4-aiplatform.googleapis.com");
  assert.equal(modelRoute({ type: LC + "lmChatGoogleVertex", parameters: {} }).host, "us-central1-aiplatform.googleapis.com");
  assert.match(modelRoute({ type: LC + "openAi", typeVersion: 2, parameters: {} }, { listed: true }).why, /Responses API/);
  assert.equal(modelRoute({ type: LC + "openAi", typeVersion: 1.8, parameters: { resource: "image", operation: "analyze" } }, { listed: true }).host, "api.openai.com");
  assert.equal(modelRoute({ type: LC + "openAi", typeVersion: 1.8, parameters: {} }), null, "a root model node is routed only when the fixture lists it");
  assert.equal(modelRoute({ type: "n8n-nodes-base.httpRequest", parameters: { url: "https://openrouter.ai/api/v1/chat/completions" } }, { listed: true }).host, "openrouter.ai");
  assert.match(modelRoute({ type: "n8n-nodes-base.httpRequest", parameters: { url: "https://api.perplexity.ai/chat/completions" } }, { listed: true }).why, /not a model API/);
  // The Hugging Face node gets a bench route for the hub's provider lookup.
  const hf = modelNodes({ nodes: [{ name: "HF", type: LC + "lmOpenHuggingFaceInference", parameters: { model: "org/model" } }] }, { models: [] })[0];
  assert.deepEqual([hf.tag, hf.routes[0].url, hf.routes[0].body.inferenceProviderMapping["hf-inference"].task], ["host:router.huggingface.co", "https://huggingface.co/api/models/org/model", "text-generation"]);

  const wf = {
    nodes: [
      { name: "Agent", type: LC + "agent", parameters: {} },
      { name: "Cohere", type: LC + "lmChatCohere", parameters: {} },
      { name: "Chain", type: LC + "chainLlm", parameters: {} },
      { name: "Groq A", type: LC + "lmChatGroq", parameters: {} },
      { name: "Chain 2", type: LC + "chainLlm", parameters: {} },
      { name: "Groq B", type: LC + "lmChatGroq", parameters: {} },
      { name: "Fetch", type: "n8n-nodes-base.httpRequest", parameters: {} },
    ],
    connections: { Cohere: { ai_languageModel: [[{ node: "Agent" }]] }, "Groq A": { ai_languageModel: [[{ node: "Chain" }]] }, "Groq B": { ai_languageModel: [[{ node: "Chain 2" }]] } },
  };
  const errs = modelErrors({ models: ["Agent", "Chain", "Fetch"] }, wf);
  assert.ok(errs.some((e) => /"Agent": its model "Cohere" is not answered.*Cohere/.test(e)), errs.join("\n"));
  assert.ok(errs.some((e) => /"Fetch".*not a model API/.test(e)), errs.join("\n"));
  assert.ok(errs.some((e) => /"Groq A", "Groq B" call one fixed host \(api\.groq\.com\)/.test(e)), errs.join("\n"));
  assert.deepEqual(modelErrors({ models: ["Chain"] }, { nodes: wf.nodes.slice(2, 4), connections: { "Groq A": wf.connections["Groq A"] } }), []);
});

test("P16: the claude driver's replayed requests get the model-input and tool-turn checks, reads by time", async () => {
  const { claudeDriverModelInputs } = await import("../evals/bench/claude-side.mjs");
  const asked = [{ id: "call_a", type: "function", function: { name: "Get_News", arguments: "{}" } }];
  const recordings = [
    { node: "Model", index: 0, format: "openai", seq: 1, request: { messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "news?" }] }, response: { choices: [{ message: { role: "assistant", content: null, tool_calls: asked } }] } },
    { node: "Model", index: 1, format: "openai", seq: 3, request: { messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "news?" }, { role: "assistant", content: null, tool_calls: asked }, { role: "tool", tool_call_id: "call_a", content: '[{"title":"A"}]' }] }, response: { choices: [{ message: { role: "assistant", content: "A" } }] } },
  ];
  const n8nEffects = [{ seq: 2, method: "GET", proxied: "https://feeds.example", path: "/rss.xml" }];
  const n8nSources = { "Get News": "http/tls-intercept" };
  const base = { kind: "agent", itemIndex: 0, system: "Be brief.", prompt: "news?", tools: [{ name: "Get_News" }] };
  const log = (value, url, t2 = "2026-11-15T10:00:05.000Z") => ({
    replayLog: [
      { id: "Agent#0#0", key: "Model", index: 0, mode: "replay", t: "2026-11-15T10:00:01.000Z", req: { ...base, transcript: [] } },
      { id: "Agent#0#0", key: "Model", index: 0, mode: "replay", t: "2026-11-15T10:00:02.000Z" },
      { id: "Agent#0#0.1", key: "Model", index: 1, mode: "replay", t: t2, req: { ...base, transcript: [{ calls: [{ name: "Get_News", args: {} }], results: [{ name: "Get_News", ok: true, value }] }] } },
    ],
    effects: [{ t: "2026-11-15T10:00:03.000Z", method: "GET", url, query: {} }, { t: "2026-11-15T10:00:09.000Z", method: "GET", url: "https://later.example/x", query: {} }],
    recordings, n8nEffects, n8nSources,
  });
  const ok = claudeDriverModelInputs(log([{ title: "A" }], "https://feeds.example/rss.xml"));
  assert.deepEqual(ok.map((m) => [m.index, m.input.same, m.tools?.same ?? null, m.tools?.reads ?? null]), [[0, true, null, null], [1, true, true, 1]], "the read after the second answer is not this turn's");
  const wrongRead = claudeDriverModelInputs(log([{ title: "A" }], "https://feeds.example/other.xml"));
  assert.equal(wrongRead[1].tools.cause, "different tool result");
  const wrongValue = claudeDriverModelInputs(log([{ title: "B" }], "https://feeds.example/rss.xml"));
  assert.equal(wrongValue[1].tools.detail.values[0].tool, "Get_News");
  // A different question fails the model-input check, as in process.
  const asked2 = log([{ title: "A" }], "https://feeds.example/rss.xml");
  asked2.replayLog[0].req = { ...asked2.replayLog[0].req, prompt: "weather?" };
  assert.equal(claudeDriverModelInputs(asked2)[0].input.same, false);
  // A live (not replayed) request is not checked; a run made before P16 has no requests.
  assert.equal(claudeDriverModelInputs({ ...asked2, replayLog: asked2.replayLog.map((e) => ({ ...e, mode: "live" })) }).length, 0);
  assert.deepEqual(claudeDriverModelInputs({ replayLog: [{ id: "Agent#0#0", key: "Model", index: 0, mode: "replay" }], recordings }), []);
});

test("P19: an unrouted read is a 404 logged read-default; an `any` response answers every path on its origin, after exact paths", async () => {
  const { pickRoute, startMock } = await import("../evals/n8n/mock-server.mjs");
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const R = [
    { method: "GET", url: "https://news.example/", any: true, status: 200, body: "<html>any page</html>" },
    { method: "GET", url: "https://news.example/front", status: 200, body: "<html>front</html>" },
    { method: "GET", url: "https://img.example/", any: true, query: { size: "s" }, status: 200, body: "small" },
  ];
  const c = new Map();
  const sp = (q) => new URLSearchParams(q);
  assert.equal(pickRoute(R, "GET", "https://news.example", "/2026/11/story-the-model-chose", sp(""), c).f.body, "<html>any page</html>");
  assert.equal(pickRoute(R, "GET", "https://news.example", "/front", sp("utm=1"), c).f.body, "<html>front</html>", "the exact path wins over any");
  assert.equal(pickRoute(R, "GET", "https://img.example", "/a.png", sp(""), c), null, "any keeps its query condition");
  assert.equal(pickRoute(R, "GET", "https://img.example", "/a.png", sp("size=s"), c).f.body, "small");
  assert.equal(pickRoute(R, "GET", "https://other.example", "/front", sp(""), c), null);
  assert.equal(pickRoute(R, "GET", null, "/2026/story", sp(""), c), null, "a request made to the mock directly names no origin, so any never matches it");
  assert.equal(pickRoute(R, "POST", "https://news.example", "/x", sp(""), c), null, "the method still has to match");

  const dir = mkdtempSync(join(tmpdir(), "n2c-p19-"));
  const fixtures = join(dir, "fx.json");
  const log = join(dir, "log.jsonl");
  writeFileSync(fixtures, JSON.stringify({ __routes: R, __writeDefault: { status: 200, body: {} } }));
  writeFileSync(log, "");
  const server = await startMock({ port: 0, host: "127.0.0.1", log, fixtures });
  const base = `http://127.0.0.1:${server.address().port}`;
  const viaProxy = (method, url) => new Promise(async (ok) => {
    const { request } = await import("node:http");
    const u = new URL(base);
    const r = request({ host: u.hostname, port: u.port, method, path: url }, (res) => { let b = ""; res.on("data", (x) => (b += x)); res.on("end", () => ok({ status: res.statusCode, body: b })); });
    r.end();
  });
  const miss = await viaProxy("GET", "http://unknown.example/page");
  const write = await viaProxy("POST", "http://unknown.example/items");
  const hit = await viaProxy("GET", "http://news.example/anything");
  await new Promise((ok) => server.close(ok));
  assert.deepEqual([miss.status, JSON.parse(miss.body).error, write.status, hit.status], [404, "no fixture", 200, 404]);
  const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.fixture), ["read-default", "write-default", "read-default"], "an https any route does not answer an http origin");
});

test("P21: file paths resolve under /home/node; absolute ones are allowed by directory; n8nCannotRun is in the schema", async () => {
  const { containerPath, fileAccessDirs, N8N_HOME } = await import("../evals/bench/n8n-side.mjs");
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  assert.equal(containerPath("./schema.json"), "/home/node/schema.json");
  assert.equal(containerPath("data/in.csv"), "/home/node/data/in.csv");
  assert.equal(containerPath("~/in.csv"), "/home/node/in.csv");
  assert.equal(containerPath("/files/a.xlsx"), "/files/a.xlsx");
  const dir = mkdtempSync(join(tmpdir(), "n2c-p21-"));
  mkdirSync(join(dir, "1"));
  writeFileSync(join(dir, "1", "normal.json"), JSON.stringify({ reads: [{ node: "R", file: { path: "/files/a.xlsx" } }, { node: "S", file: { path: "rel.csv" } }, { node: "T", file: { path: "/home/node/x/y.txt" } }] }));
  writeFileSync(join(dir, "1", "empty.json"), JSON.stringify({ reads: [{ node: "R", file: { path: "/data/deep/b.csv" } }] }));
  assert.deepEqual(fileAccessDirs(dir), [N8N_HOME, "/data/deep", "/files"]);
  const schema = JSON.parse((await import("node:fs")).readFileSync(new URL("../evals/bench/fixture.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.$defs.expect.properties.n8nCannotRun.type, "string");
});

test("P22: a poll trigger's http list longer than n8n's manual mode asks for warns", async () => {
  const { pollWarnings } = await import("../evals/bench/validate.mjs");
  const wf = { nodes: [{ name: "Gmail Trigger", type: "n8n-nodes-base.gmailTrigger" }, { name: "Drive Trigger", type: "n8n-nodes-base.googleDriveTrigger" }] };
  const list = (n) => ({ method: "GET", url: "https://www.googleapis.com/gmail/v1/users/me/messages", status: 200, body: { messages: Array.from({ length: n }, (_, i) => ({ id: `m${i}` })) } });
  const fx = (n, kind = "poll", node = "Gmail Trigger") => ({ trigger: { node, kind }, reads: [{ node, http: { responses: [list(n), { method: "GET", url: "https://www.googleapis.com/gmail/v1/users/me/messages/m0", status: 200, body: {} }] } }] });
  assert.match(pollWarnings(fx(2), wf)[0], /manual mode, where it asks maxResults=1.*answers 2 items/);
  assert.deepEqual(pollWarnings(fx(1), wf), []);
  assert.deepEqual(pollWarnings(fx(3, "manual"), wf), [], "only a poll trigger");
  const drive = { trigger: { node: "Drive Trigger", kind: "poll" }, reads: [{ node: "Drive Trigger", http: { responses: [{ method: "GET", url: "https://www.googleapis.com/drive/v3/files", status: 200, body: { files: [{}, {}] } }] } }] };
  assert.match(pollWarnings(drive, wf)[0], /pageSize=1/);
});

test("P20: form pages by label or position, the execution id in n8n's form-waiting URL, and the validator's page checks", async () => {
  const { formPageBody, waitingExecutionId } = await import("../evals/n8n/run-workflow.mjs");
  const { checkFixture } = await import("../evals/bench/validate.mjs");
  const page = { parameters: { formFields: { values: [{ fieldLabel: "Depth" }, { fieldLabel: "Audience" }] } } };
  const byLabel = formPageBody(page, { Audience: "kids", Depth: "deep" });
  assert.deepEqual([byLabel.get("field-0"), byLabel.get("field-1")], ["deep", "kids"]);
  const byPos = formPageBody(null, ["because the moon", null, { a: 1 }]);
  assert.deepEqual([byPos.get("field-0"), byPos.get("field-1"), byPos.get("field-2")], ["because the moon", null, '{"a":1}']);
  assert.equal(waitingExecutionId("http://127.0.0.1:5690/form-waiting/4186?signature=abc"), "4186");
  assert.equal(waitingExecutionId(null), null);

  const wf = { nodes: [
    { name: "Form", type: "n8n-nodes-base.formTrigger", parameters: { formFields: { values: [{ fieldLabel: "Topic" }] } } },
    { name: "Page 1", type: "n8n-nodes-base.form", parameters: {} },
    { name: "Set", type: "n8n-nodes-base.set", parameters: {} },
  ], connections: {} };
  const fx = { schemaVersion: 1, template: 1, sha256: "0".repeat(64), variant: "normal", now: "2026-11-16T09:00:00Z", about: "x", trigger: { node: "Form", kind: "form", items: [{ json: { Topic: "t" } }], formPages: [{ node: "Page 1", fields: { Depth: "d" } }, { node: "Set", fields: [] }] }, reads: [], models: [], writes: [], expect: { branches: [] } };
  const { errors } = await checkFixture(fx, { workflow: { workflow: wf } });
  assert.ok(errors.some((e) => /formPages: "Set" is not an enabled Form node/.test(e)), errors.join("\n"));
  assert.ok(!errors.some((e) => /"Page 1"/.test(e)), errors.join("\n"));
});

test("P28: tool names and input schema shapes offered to the model are gated; descriptions are reported", async () => {
  const { sameToolDefs, schemaShape } = await import("../evals/bench/claude-side.mjs");
  const fn = (name, description, parameters) => ({ type: "function", function: { name, description, parameters } });
  const zod = (properties, required) => ({ type: "object", properties, ...(required ? { required } : {}), additionalProperties: false, $schema: "http://json-schema.org/draft-07/schema#" });
  const n8nCall = { format: "openai", request: { messages: [{ role: "user", content: "q" }], tools: [fn("Google_Calendar", "Get many events in Google Calendar", zod({})), fn("Search_db", "Search the database", zod({ keyword: { type: "string", description: "One keyword" }, tag: { type: "string" } }, ["keyword", "tag"])), fn("format_final_json_response", "Use this tool to format your final response", zod({ output: { type: "object" } }))] } };
  const claudeReq = { kind: "agent", outputSchema: { type: "object" }, tools: [{ name: "Google Calendar", description: "googleCalendar getAll" }, { name: "Search db", description: "Search our database", inputSchema: { type: "object", properties: { tag: { type: "string" }, keyword: { type: "string", description: "A keyword" } }, required: ["tag", "keyword"] } }] };
  const same = sameToolDefs(n8nCall, claudeReq);
  // Names fold case and punctuation (n8n's tool name is the node name with `_`); a tool without
  // a schema is a tool without parameters; key order, additionalProperties, $schema and
  // descriptions are not shape; n8n's output-parser tool is the runtime's outputSchema.
  assert.deepEqual([same.same, same.tools, same.onlyN8n, same.onlyClaude, same.schemas], [true, 2, [], [], []]);
  assert.deepEqual(same.descriptions.map((d) => [d.tool, d.diff.map((x) => x.at)]), [["Google_Calendar", ["(tool)"]], ["Search_db", ["(tool)", "keyword"]]]);
  assert.deepEqual(same.parser, { n8n: "format_final_json_response", claudeOutputSchema: true, same: true });
  // A tool only n8n offers (a Think tool the converter dropped), or only the Claude side.
  const missing = sameToolDefs(n8nCall, { ...claudeReq, tools: claudeReq.tools.slice(1) });
  assert.deepEqual([missing.same, missing.onlyN8n], [false, ["Google_Calendar"]]);
  assert.deepEqual(sameToolDefs(n8nCall, { ...claudeReq, tools: [...claudeReq.tools, { name: "Extra" }] }).onlyClaude, ["Extra"]);
  // A parameter missing, of another type, or no longer required: a different shape.
  const shape = (properties, required) => sameToolDefs(n8nCall, { ...claudeReq, tools: [claudeReq.tools[0], { ...claudeReq.tools[1], inputSchema: { type: "object", properties, required } }] });
  assert.equal(shape({ keyword: { type: "string" } }, ["keyword"]).schemas[0].tool, "Search_db");
  assert.equal(shape({ keyword: { type: "number" }, tag: { type: "string" } }, ["keyword", "tag"]).same, false);
  assert.equal(shape({ keyword: { type: "string" }, tag: { type: "string" } }, ["keyword"]).same, false);
  // Nested shapes: array items and object properties count, descriptions inside do not.
  assert.deepEqual(schemaShape({ type: "array", items: { type: "object", properties: { a: { type: "string", description: "x" } } } }), { type: "array", items: { type: "object", properties: { a: { type: "string" } }, required: [] } });
  // Gemini and Anthropic tool lists are read the same way; no tools on either side: no check.
  const gem = { format: "gemini", request: { contents: [], tools: [{ functionDeclarations: [{ name: "Get_Weather", description: "w", parameters: { type: "object", properties: { lat: { type: "string" } } } }] }] } };
  assert.equal(sameToolDefs(gem, { tools: [{ name: "Get Weather", inputSchema: { type: "object", properties: { lat: { type: "string" } } } }] }).same, true);
  const ant = { format: "anthropic", request: { messages: [], tools: [{ name: "Check_Sent", description: "Get many messages in Gmail", input_schema: zod({ email: { type: "string" } }, ["email"]) }] } };
  assert.equal(sameToolDefs(ant, { tools: [{ name: "Check Sent", inputSchema: { type: "object", properties: { email: { type: "string" } }, required: ["email"] } }] }).same, true);
  assert.equal(sameToolDefs({ format: "openai", request: { messages: [] } }, { kind: "model" }), null);

  // Gate 4: after the model-input check, before the tool turns; descriptions never fail it.
  const cmp = compare([], []);
  const m = (toolDefs, extra = {}) => ({ step: "Agent", index: 0, mode: "replay", input: { same: true }, toolDefs, ...extra });
  const g = gate4({ cmp, modelInputs: [m(missing, { tools: { same: false, cause: "tool call not executed" } })], n8nStatus: "success" });
  assert.deepEqual([g.pass, g.bucket, g.cause, g.detail[0].onlyN8n], [false, "field map", "different tools offered", ["Google_Calendar"]]);
  assert.equal(gate4({ cmp, modelInputs: [m(same)], n8nStatus: "success" }).pass, true);
  assert.match(gate4({ cmp, modelInputs: [{ ...m(missing), input: { same: false, at: "x", n8nAround: "y" } }], n8nStatus: "success" }).cause, /different input/);
});

test("P34: n8n expression syntax left in a description is a gated artefact; other wording stays reported", async () => {
  const { sameToolDefs, descriptionDiffKind } = await import("../evals/bench/claude-side.mjs");
  assert.equal(descriptionDiffKind("Use this tool to read mail", "=Use this tool to read mail"), "artefact");
  assert.equal(descriptionDiffKind("Rows for Ada", "Rows for {{ $json.name }}"), "artefact");
  assert.equal(descriptionDiffKind("The URL", "{{ $fromAI('url') }}"), "artefact");
  assert.equal(descriptionDiffKind("={{ x }}", "={{ x }} "), "reworded", "n8n's own text carries the marks too");
  assert.equal(descriptionDiffKind("Latitude of the place", ""), "missing");
  assert.equal(descriptionDiffKind("Get many events in Google Calendar", "googleCalendar getAll"), "reworded");
  const fn = (name, description, parameters) => ({ type: "function", function: { name, description, parameters } });
  const n8nCall = { format: "openai", request: { messages: [], tools: [fn("Read_mail", "Use this tool to read mail", { type: "object", properties: { q: { type: "string", description: "Search words" } } })] } };
  const art = sameToolDefs(n8nCall, { tools: [{ name: "Read mail", description: "=Use this tool to read mail", inputSchema: { type: "object", properties: { q: { type: "string" } } } }] });
  assert.deepEqual([art.same, art.artefacts.map((x) => [x.tool, x.at, x.kind])], [true, [["Read_mail", "(tool)", "artefact"]]]);
  assert.deepEqual(art.descriptions[0].diff.map((x) => x.kind), ["artefact", "missing"]);
  const cmp = compare([], []);
  const g = gate4({ cmp, modelInputs: [{ step: "Agent", index: 0, mode: "replay", input: { same: true }, toolDefs: art }], n8nStatus: "success" });
  assert.deepEqual([g.pass, g.bucket, g.cause], [false, "expression translation", "tool description not evaluated"]);
  const reworded = sameToolDefs(n8nCall, { tools: [{ name: "Read mail", description: "Reads mail", inputSchema: { type: "object", properties: { q: { type: "string", description: "Words" } } } }] });
  assert.equal(gate4({ cmp, modelInputs: [{ step: "Agent", index: 0, mode: "replay", input: { same: true }, toolDefs: reworded }], n8nStatus: "success" }).pass, true);
});

test("P35: the output-parser tool's schema against outputSchema; the hostile run's tool lists in gate 6", async () => {
  const { sameToolDefs } = await import("../evals/bench/claude-side.mjs");
  const fn = (name, parameters) => ({ type: "function", function: { name, description: "d", parameters } });
  const parserTool = fn("format_final_json_response", { type: "object", properties: { output: { type: "array", items: { type: "object", properties: { Idea: { type: "string" }, Caption: { type: "string" } }, additionalProperties: false } } }, additionalProperties: false });
  const n8nCall = { format: "openai", request: { messages: [], tools: [fn("thinking_tool", { type: "object", properties: { input: { type: "string" } } }), parserTool] } };
  const think = { name: "thinking_tool", description: "d", inputSchema: { type: "object", properties: { input: { type: "string" } } } };
  const good = sameToolDefs(n8nCall, { tools: [think], outputSchema: { type: "array", items: { type: "object", properties: { Caption: { type: "string" }, Idea: { type: "string" } } } } });
  assert.deepEqual([good.same, good.parser.same], [true, true]);
  const bad = sameToolDefs(n8nCall, { tools: [think], outputSchema: { type: "object", properties: { Idea: { type: "string" } } } });
  assert.equal(bad.parser.same, false);
  const none = sameToolDefs(n8nCall, { tools: [think] });
  assert.deepEqual([none.parser.same, none.parser.claudeShape], [false, null]);
  const cmp = compare([], []);
  const m = (toolDefs) => ({ step: "Agent", index: 0, mode: "replay", input: { same: true }, toolDefs });
  assert.deepEqual([gate4({ cmp, modelInputs: [m(bad)], n8nStatus: "success" }).cause, gate4({ cmp, modelInputs: [m(good)], n8nStatus: "success" }).pass], ["different output schema", true]);
  // Gate 6: a hostile run that offers other tools than n8n's fails, after the allow-list check.
  const missing = sameToolDefs(n8nCall, { tools: [], outputSchema: good.parser && { type: "array", items: { type: "object", properties: { Caption: { type: "string" }, Idea: { type: "string" } } } } });
  const base = { claudeCalls: { tools: [], http: [] }, allow: {}, claudeEffects: [], bait: [], baitHits: () => [] };
  const g6 = gate6({ ...base, modelInputs: [m(missing)] });
  assert.deepEqual([g6.pass, g6.cause, g6.detail[0].onlyN8n], [false, "hostile: different tools offered", ["thinking_tool"]]);
  assert.equal(gate6({ ...base, modelInputs: [m(good)] }).pass, true);
  assert.equal(gate6(base).pass, true);
});

test("P33: the connector mocks refuse a Gmail reply, send or forward that names no recipient", async () => {
  const { connectorRefusal } = await import("../evals/mocks/limits.mjs");
  assert.match(connectorRefusal("gmail", "reply", { messageId: "m1", to: [] }), /Recipient address required/);
  assert.equal(connectorRefusal("gmail", "reply", { messageId: "m1" }), null, "an absent to keeps the default reply recipients");
  assert.equal(connectorRefusal("gmail", "reply", { messageId: "m1", to: [], cc: ["a@b.example"] }), null);
  assert.equal(connectorRefusal("gmail", "reply", { messageId: "m1", to: ["a@b.example"] }), null);
  assert.ok(connectorRefusal("gmail", "reply", { messageId: "m1", to: [""] }), "an empty address is no address");
  assert.ok(connectorRefusal("gmail", "send_message", { subject: "s", body: "b" }));
  assert.equal(connectorRefusal("gmail", "send_message", { draftId: "d1" }), null);
  assert.ok(connectorRefusal("gmail", "forward", { messageId: "m1" }));
  assert.equal(connectorRefusal("slack", "slack_send_message", {}), null);
  // The MCP mock answers with an error and logs the call invalid (no effect for the comparer).
  const { createServer } = await import("../evals/mocks/mcp-server.mjs");
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const log = join(mkdtempSync(join(tmpdir(), "n2c-p33-")), "log.jsonl");
  const doc = JSON.parse(readFileSync(new URL("../evals/mocks/connectors/gmail.json", import.meta.url), "utf8"));
  const handle = createServer({ connector: "gmail", doc, log });
  const r = handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "reply", arguments: { messageId: "m1", to: [] } } });
  assert.equal(r.result.isError, true);
  const line = JSON.parse(readFileSync(log, "utf8").trim());
  assert.deepEqual([line.valid, line.refusal], [false, true]);
});

test("P36: a preflight-stopped template's canned n8n check covers every variant, reported per variant", async () => {
  const { n8nCheckVariants, n8nCheckKey, n8nCheckSummary } = await import("../evals/bench/gates.mjs");
  assert.deepEqual(n8nCheckVariants(true, ["normal", "empty", "malformed", "hostile"]), ["normal", "empty", "malformed", "hostile"]);
  assert.deepEqual(n8nCheckVariants(true, ["hostile"]), ["normal", "hostile"], "normal always (the row's request log)");
  assert.deepEqual(n8nCheckVariants("normal", ["normal", "empty"]), ["normal"]);
  assert.deepEqual([n8nCheckKey("normal"), n8nCheckKey("empty")], ["n8nCheck", "n8nCheck:empty"]);
  const steps = { n8nCheck: { status: "success", logVsFixture: { unanswered: [], unused: [] } }, "n8nCheck:empty": { status: "error", error: { node: "Read", message: "404 no fixture" }, logVsFixture: { unanswered: [{ method: "GET", url: "https://x.example/a" }], unused: [] } } };
  const s = n8nCheckSummary(steps, ["normal", "empty", "malformed"]);
  assert.deepEqual(Object.keys(s), ["normal", "empty"]);
  assert.deepEqual([s.empty.status, s.empty.error.node, s.empty.unanswered], ["error", "Read", 1]);
  assert.equal(n8nCheckSummary({}, ["normal"]), null);
});

test("P29: Gmail send without any recipient is refused 400 before any route (the in-process host calls the same serviceRefusal)", async () => {
  const { serviceRefusal, mimeRecipients, startMock } = await import("../evals/n8n/mock-server.mjs");
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const raw = (head) => Buffer.from(`${head}Subject: Re: hi\r\nContent-Type: text/html\r\n\r\nBody with To: x@y.example in the text`).toString("base64url");
  const G = "https://www.googleapis.com";
  const send = "/gmail/v1/users/me/messages/send";
  const none = serviceRefusal("POST", G, send, { raw: raw("In-Reply-To: <a@b>\r\n"), threadId: "t1" });
  assert.deepEqual([none.f.status, none.f.body.error.message, none.f.body.error.status], [400, "Recipient address required", "INVALID_ARGUMENT"]);
  assert.ok(serviceRefusal("POST", G, send, { raw: raw("To: \r\n") }), "an empty To header names no one");
  assert.equal(serviceRefusal("POST", G, send, { raw: raw("To: Marco <marco@harbour.example>\r\n") }), null);
  assert.equal(serviceRefusal("POST", G, send, { raw: raw("Bcc: a@b.example\r\n") }), null, "Cc or Bcc alone is enough");
  assert.deepEqual(mimeRecipients("To: a@b.example,\r\n c@d.example\r\nCc: e@f.example\r\n\r\nTo: not@header.example"), ["a@b.example", "c@d.example", "e@f.example"], "folded headers, never the body");
  assert.ok(serviceRefusal("POST", G, `/upload${send}`, "Subject: x\r\n\r\nbody"), "the upload endpoint's MIME text too");
  assert.equal(serviceRefusal("POST", "https://api.example", send, { raw: raw("") }), null, "only Gmail's hosts");
  assert.equal(serviceRefusal("POST", G, "/gmail/v1/users/me/drafts", { raw: raw("") }), null);
  assert.equal(serviceRefusal("GET", G, send, null), null);

  // On the mock: refused even though a route answers the send; the log names why.
  const dir = mkdtempSync(join(tmpdir(), "n2c-p29-"));
  const fixtures = join(dir, "fx.json");
  const log = join(dir, "log.jsonl");
  writeFileSync(fixtures, JSON.stringify({ __routes: [{ method: "POST", url: `${G}${send}`, status: 200, body: { id: "m1" } }], __writeDefault: { status: 200, body: {} } }));
  writeFileSync(log, "");
  const server = await startMock({ port: 0, host: "127.0.0.1", log, fixtures });
  const post = async (body) => (await fetch(`http://127.0.0.1:${server.address().port}${send}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status;
  const statuses = [await post({ raw: raw("") }), await post({ raw: raw("To: a@b.example\r\n") })];
  await new Promise((ok) => server.close(ok));
  assert.deepEqual(statuses, [400, 200]);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l).fixture), ["service: gmail send without recipients", `route POST ${G}${send}`]);
});

test("P32: a new preflight error on a step the runtime refused when it ran is moved earlier, not a regression", async () => {
  const { coverageDiff, runTimeRefusals } = await import("../evals/coverage-diff.mjs");
  const rows = [
    { tag: "old", template: 1, gate: 3, cause: 'step Extract names: Html operation "extractHtmlContent" (needs an HTML parser) is not supported by the runtime' },
    { tag: "new", template: 1, gate: 3, cause: 'step Extract names: Html operation "extractHtmlContent" (needs an HTML parser) is not supported by the runtime' },
    { tag: "new", template: 2, gate: 3, cause: "step Parse: Cannot read properties of undefined (reading 'x')" },
    { tag: "new", template: 3, gate: 3, cause: "preflight: blocked steps", detail: ["Files: blocked: file steps need the files lever"] },
    { tag: "new", template: 4, gate: 4, cause: "different writes" },
    { tag: "new", template: 5, gate: 3, cause: "step Sort: Sort with custom code is not supported by the runtime" },
  ];
  const ref = runTimeRefusals(rows);
  assert.deepEqual(Object.fromEntries(Object.entries(ref).map(([k, v]) => [k, [...v]])), { 1: ["Extract names"], 5: ["Sort"] }, "a crash, a preflight stop and a later gate are not run-time refusals");
  assert.deepEqual(Object.keys(runTimeRefusals(rows, { tag: "old" })), ["1"]);
  const t = (errors, blockedSteps = 0) => ({ class: "full", preflightErrors: errors.length, blockedSteps, errors });
  const before = { 1: t([]), 2: t([]), 5: t([{ step: "Other", message: "blocked: x" }]), 6: t([]) };
  const after = {
    1: t([{ step: "Extract names", message: 'Html operation "extractHtmlContent" is refused when it runs' }]),
    2: t([{ step: "Parse", message: "refused when it runs" }]),
    5: t([{ step: "Other", message: "blocked: x" }, { step: "Sort", message: "Sort with custom code is refused when it runs" }]),
    6: t([], 1),
  };
  const d = coverageDiff(before, after, ref);
  assert.deepEqual(d.movedEarlier.map((m) => [m.id, m.step]), [["1", "Extract names"], ["5", "Sort"]]);
  assert.deepEqual(d.regressions.map((r) => [r.id, r.kind]), [["2", "preflight error"], ["2", "preflight clean lost"], ["6", "blocked step"]], "a step that crashed (not refused) at run time still counts");
  assert.deepEqual(d.preflightClean, { before: 3, after: 1, afterWithMovedEarlier: 2 }, "1 keeps its place; 6 is clean but gained a blocked step");
  // An unchanged error is not new; a per-template file without error lists is refused.
  assert.deepEqual(coverageDiff(after, after, {}).regressions, []);
  assert.throws(() => coverageDiff({ 1: { preflightErrors: 0, blockedSteps: 0 } }, after, {}), /regenerate/);
});
