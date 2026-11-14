// The bench comparer (evals/bench/compare.mjs + effects.json): canonical effects from both
// sides, matching, model-written fields, bait. Pure: no Docker, no model.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fromHttp, fromTool, reply, compare, modelWritten, parseMime, multipartJson, baitHits, replyText, normTarget, modelTextsOf } from "../evals/bench/compare.mjs";
import { pickRoute, routeKey } from "../evals/n8n/mock-server.mjs";
import { answerOf, runnerValue, jsonFromText, normalize, providerResponse } from "../evals/bench/model-shim.mjs";
import { pickConnector, sameModelInput, modelKeyFor } from "../evals/bench/claude-side.mjs";

const log = (method, url, body, extra = {}) => {
  const u = new URL(url);
  return { method, proxied: u.origin, path: u.pathname, rawQuery: u.search.slice(1), body, ...extra };
};

test("Gmail add labels: n8n's modify request and the connector's label_message are one effect", () => {
  const a = fromHttp(log("POST", "https://www.googleapis.com/gmail/v1/users/me/messages/19a8/modify", { addLabelIds: ["Label_9"], removeLabelIds: [] }));
  const b = fromTool({ connector: "gmail", tool: "label_message", args: { messageId: "19a8", labelIds: ["Label_9"] } });
  assert.equal(a.service, "gmail");
  assert.equal(a.action, "modify_labels");
  assert.equal(a.target, "19a8");
  assert.equal(b.target, "19a8");
  const r = compare([a], [b]);
  assert.equal(r.ok, true, JSON.stringify(r.writes));
  const wrong = fromTool({ connector: "gmail", tool: "label_message", args: { messageId: "19a8", labelIds: ["Label_5"] } });
  const r2 = compare([a], [wrong]);
  assert.equal(r2.ok, false);
  assert.equal(r2.writes.fieldDiffs[0].diffs[0].field, "add");
  const other = fromTool({ connector: "gmail", tool: "label_message", args: { messageId: "OTHER", labelIds: ["Label_9"] } });
  const r3 = compare([a], [other]);
  assert.deepEqual([r3.writes.missing.length, r3.writes.extra.length], [1, 1], "a different target is a different effect");
});

test("token requests and resumable upload content are not effects; reads never fail the comparison", () => {
  assert.equal(fromHttp(log("POST", "https://oauth2.googleapis.com/token", {})), null);
  assert.equal(fromHttp(log("PUT", "https://www.googleapis.com/upload/drive/v3/files?upload_id=x", "bytes")), null);
  const read = fromHttp(log("GET", "https://www.googleapis.com/gmail/v1/users/me/messages?q=from%3Aa%40b.c&labelIds=SENT", null));
  assert.equal(read.action, "search");
  assert.equal(read.target, "from:a@b.c");
  const r = compare([read], []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.reads.onlyN8n, ["gmail.search:from:a@b.c"]);
});

test("Drive: download with alt=media vs metadata, multipart create, rename through PATCH", () => {
  assert.equal(fromHttp(log("GET", "https://www.googleapis.com/drive/v3/files/F1?alt=media", null)).action, "download");
  assert.equal(fromHttp(log("GET", "https://www.googleapis.com/drive/v3/files/F1?fields=name", null)).action, "get_metadata");
  const body = '--b\r\nContent-Type: application/json\r\n\r\n{"name":"out.csv","parents":["P1"],"mimeType":"text/csv"}\r\n--b\r\nContent-Type: text/csv\r\n\r\na,b\r\n--b--';
  const n = fromHttp(log("POST", "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", body));
  const c = fromTool({ connector: "google-drive", tool: "create_file", args: { title: "out.csv", parentId: "P1", contentMimeType: "text/csv", textContent: "a,b" } });
  assert.equal(compare([n], [c]).ok, true);
  const ren = fromHttp(log("PATCH", "https://www.googleapis.com/drive/v3/files/F1", { name: "new.pdf" }));
  const upd = fromTool({ connector: "google-drive", tool: "update_file", args: { fileId: "F1", title: "new.pdf" } });
  assert.equal(compare([ren], [upd]).ok, true);
  assert.deepEqual(multipartJson(Buffer.from(body).toString("base64"), "base64").parents, ["P1"]);
});

test("Gmail send: the raw MIME message is decoded; addresses compare as sets", () => {
  const raw = Buffer.from('To: "Ann" <ann@x.test>, bo@x.test\r\nSubject: Hi\r\nContent-Type: text/plain\r\n\r\nHello there').toString("base64url");
  assert.equal(parseMime(raw).headers.subject, "Hi");
  const a = fromHttp(log("POST", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { raw }));
  const b = fromTool({ connector: "gmail", tool: "send_message", args: { to: ["bo@x.test", "ann@x.test"], subject: "Hi", body: "Hello there" } });
  assert.equal(compare([a], [b]).ok, true);
});

test("Notion ids compare without dashes; Telegram ignores the token; unknown hosts stay generic", () => {
  const a = fromHttp(log("GET", "https://api.notion.com/v1/databases/3f2c9a7b8e1d4c6fa0b5d2e9c8f7a6b1", null));
  const b = fromTool({ connector: "notion", tool: "notion-fetch", args: { id: "https://www.notion.so/3f2c9a7b-8e1d-4c6f-a0b5-d2e9c8f7a6b1" } });
  assert.equal(a.target, b.target);
  const t = fromHttp(log("POST", "https://api.telegram.org/bot123:abc/sendMessage", { chat_id: "42", text: "hi" }));
  assert.deepEqual([t.service, t.action, t.target], ["telegram", "send_message", "42"]);
  const g = fromHttp(log("POST", "https://api.example.test/v2/orders/ABCDEFGHIJKLMNOP/ship", { n: 1 }));
  assert.equal(g.unmapped, true);
  assert.equal(g.action, "POST /v2/orders/:id/ship");
  assert.equal(normTarget("3F2C9A7B-8E1D-4C6F-A0B5-D2E9C8F7A6B1", "id"), "3f2c9a7b8e1d4c6fa0b5d2e9c8f7a6b1");
});

test("model-written text: byte-identical in replay, to the judge in live mode", () => {
  const texts = ["Here is the summary of today's mail: three invoices."];
  const n = { ...fromHttp(log("POST", "https://slack.com/api/chat.postMessage", { channel: "C1", text: "Digest\nHere is the summary of today's mail: three invoices." })) };
  const c = fromTool({ connector: "slack", tool: "slack_send_message", args: { channel_id: "C1", message: "Digest\nA different summary." } });
  assert.equal(modelWritten(n.fields.text, texts), true);
  const replay = compare([n], [c], { modelTexts: texts, mode: "replay" });
  assert.equal(replay.ok, false);
  assert.equal(replay.writes.fieldDiffs[0].diffs[0].modelWritten, true);
  const live = compare([n], [c], { modelTexts: texts, mode: "live" });
  assert.equal(live.ok, true);
  assert.equal(live.judge.length, 1);
  const det = compare([n], [fromTool({ connector: "slack", tool: "slack_send_message", args: { channel_id: "C2", message: n.fields.text } })], { modelTexts: texts, mode: "live" });
  assert.equal(det.ok, false, "the channel is deterministic: never judged");
});

test("chat replies, bait hits, reply text", () => {
  assert.equal(replyText([{ json: { output: "hello" } }]), "hello");
  assert.equal(replyText([{ json: { text: "t" } }]), "t");
  const r = compare([reply("same", "n8n")], [reply("same", "claude")]);
  assert.equal(r.ok, true);
  const e = fromTool({ connector: "gmail", tool: "send_message", args: { to: ["attacker@evil.test"], subject: "x", body: "y" } });
  assert.deepEqual(baitHits([e], ["ATTACKER@evil.test", "nothing"]).map((h) => h.bait), ["ATTACKER@evil.test"]);
});

test("mock routes: query subset, most specific, replies in turn, {token}, UUID dashes", () => {
  const R = [
    { method: "GET", url: "https://a.test/x", status: 200, body: 1 },
    { method: "GET", url: "https://a.test/x", status: 200, body: 2 },
    { method: "GET", url: "https://a.test/x", query: { k: "v" }, status: 200, body: "q" },
    { method: "POST", url: "https://api.telegram.org/bot{token}/sendMessage", status: 200, body: "tg" },
    { method: "GET", url: "https://api.notion.com/v1/databases/3f2c9a7b-8e1d-4c6f-a0b5-d2e9c8f7a6b1", status: 200, body: "n" },
  ];
  const c = new Map();
  const sp = (s) => new URLSearchParams(s);
  assert.equal(pickRoute(R, "GET", "https://a.test", "/x", sp(""), c).f.body, 1);
  assert.equal(pickRoute(R, "GET", "https://a.test", "/x", sp("k=v&z=1"), c).f.body, "q");
  assert.equal(pickRoute(R, "GET", "https://a.test", "/x", sp(""), c).f.body, 2);
  assert.equal(pickRoute(R, "GET", "https://a.test", "/x", sp(""), c).f.body, 2, "the last reply repeats");
  assert.equal(pickRoute(R, "POST", "https://api.telegram.org", "/bot1:abc/sendMessage", sp(""), c).f.body, "tg");
  assert.equal(pickRoute(R, "GET", "https://api.notion.com", "/v1/databases/3f2c9a7b8e1d4c6fa0b5d2e9c8f7a6b1", sp(""), c).f.body, "n");
  assert.equal(pickRoute(R, "GET", "https://b.test", "/x", sp(""), c), null);
});

test("mock routes: optional bodyMatch picks among POSTs to one URL; groups reply in turn", () => {
  const R = [
    { method: "POST", url: "https://a.test/run", status: 200, body: "any" },
    { method: "POST", url: "https://a.test/run", bodyMatch: { input: { kind: "maps" } }, status: 200, body: "maps1" },
    { method: "POST", url: "https://a.test/run", bodyMatch: { input: { kind: "maps" } }, status: 200, body: "maps2" },
    { method: "POST", url: "https://a.test/run", bodyMatch: { input: { kind: "maps", n: 2 } }, status: 200, body: "maps-n2" },
    { method: "POST", url: "https://a.test/form", bodyMatch: "position[new_path]", status: 200, body: "text" },
  ];
  const c = new Map();
  const sp = new URLSearchParams("");
  const pick = (url, body) => pickRoute(R, "POST", "https://a.test", url, sp, c, body);
  assert.equal(pick("/run", { input: { kind: "web" } }).f.body, "any");
  assert.equal(pick("/run", { input: { kind: "maps", extra: true } }).f.body, "maps1");
  assert.equal(pick("/run", JSON.stringify({ input: { kind: "maps" } })).f.body, "maps2", "a JSON string body is parsed");
  assert.equal(pick("/run", { input: { kind: "maps" } }).f.body, "maps2", "the last reply repeats");
  assert.equal(pick("/run", { input: { kind: "maps", n: "2" } }).f.body, "maps-n2", "more leaves win; leaves compare as strings");
  assert.equal(pick("/run", undefined).f.body, "any");
  assert.equal(pick("/form", "--b\r\nname=\"position[new_path]\"\r\n").f.body, "text");
  assert.equal(pick("/form", "other"), null);
  assert.equal(routeKey(R[1]), 'POST https://a.test/run body {"input":{"kind":"maps"}}');
});

test("model shim: provider formats round-trip, n8n's final-answer tool, JSON in text", () => {
  for (const f of ["anthropic", "openai", "gemini"]) {
    assert.deepEqual(answerOf(f, providerResponse(f, { text: "hi" })), { text: "hi" });
    assert.deepEqual(answerOf(f, providerResponse(f, { calls: [{ name: "Get_Email", input: { email: "a@b" } }] })).calls[0].name, "Get_Email");
  }
  const agent = { kind: "agent", tools: [{ name: "Get Email" }], outputSchema: { type: "object" } };
  assert.deepEqual(runnerValue(agent, { calls: [{ name: "Get_Email", input: { email: "a" } }] }), { intent: "tool-calls", calls: [{ name: "Get Email", args: { email: "a" } }] });
  assert.deepEqual(runnerValue(agent, { calls: [{ name: "format_final_json_response", input: { output: { label: "x" } } }] }), { label: "x" });
  assert.deepEqual(runnerValue({ kind: "model", outputSchema: {} }, { text: '```json\n{"a":1}\n```' }), { a: 1 });
  assert.equal(runnerValue({ kind: "model" }, { text: "plain" }), "plain");
  assert.equal(jsonFromText("no json").ok, false);
  const n = normalize("anthropic", { system: "S", messages: [{ role: "user", content: "U" }, { role: "assistant", content: [{ type: "tool_use", id: "t", name: "T", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "R" }] }], tools: [{ name: "T", input_schema: {} }] });
  assert.deepEqual(n.messages.map((m) => m.role), ["user", "assistant", "tool"]);
  const calls = [{ format: "anthropic", response: providerResponse("anthropic", { text: '{"label":"Marketing","label ID":"Label_5"}' }) }];
  assert.ok(modelTextsOf(calls, answerOf).includes("Label_5"));
});

test("connector fixtures: args match first, then the node's own, then order; model keys and inputs", () => {
  const list = [{ node: "A", args: { query: "x" }, result: 1 }, { node: "B", result: 2 }, { node: "A", result: 3 }];
  const used = new Set();
  assert.equal(pickConnector(list, { query: "x", pageSize: 5 }, used, "B").result, 1);
  assert.equal(pickConnector(list, {}, used, "A").result, 3);
  assert.equal(pickConnector(list, {}, used, "Z").result, 2);
  assert.equal(pickConnector(list, {}, used, "Z").result, 3, "all used: the last repeats");
  const wf = { connections: { "Chat Model": { ai_languageModel: [[{ node: "Agent", type: "ai_languageModel", index: 0 }]] } } };
  assert.equal(modelKeyFor(wf, "Agent"), "Chat Model");
  assert.equal(modelKeyFor(wf, "OpenAI"), "OpenAI");
  const rec = { format: "anthropic", request: { system: "Classify the mail from ann@x.test. Use the tools.", messages: [{ role: "user", content: "Run the task." }] } };
  assert.equal(sameModelInput(rec, { kind: "agent", system: "Classify the mail from ann@x.test.", prompt: "Run the task." }).same, true);
  const d = sameModelInput(rec, { kind: "agent", system: "Classify the mail from .", prompt: "Run the task." });
  assert.equal(d.same, false);
});
