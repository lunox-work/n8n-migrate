// The bench comparer (evals/bench/compare.mjs + effects.json): canonical effects from both
// sides, matching, model-written fields, bait. Pure: no Docker, no model.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fromHttp, fromTool, reply, compare, modelWritten, parseMime, multipartJson, baitHits, replyText, normTarget, modelTextsOf, maskRunTime, formStrings, pairWrites, maxAssignment, refsOf, replyFields, decodeQuotedPrintable } from "../evals/bench/compare.mjs";
import { pickRoute, routeKey, parseMultipart } from "../evals/n8n/mock-server.mjs";
import { answerOf, runnerValue, jsonFromText, normalize, providerResponse, formatOf } from "../evals/bench/model-shim.mjs";
import { pickConnector, sameModelInput, modelKeyFor, decodeFileParts } from "../evals/bench/claude-side.mjs";
import { multipartBody } from "../skills/n8n-migrate/runtime/src/driver.mjs";

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

test("model shim: Ollama's completion endpoint (/api/generate) round-trips", () => {
  assert.equal(formatOf("/model/m0/api/generate"), "ollama-generate");
  assert.deepEqual(normalize("ollama-generate", { prompt: "Q", system: "S" }).messages, [{ role: "user", text: "Q" }]);
  const r = providerResponse("ollama-generate", { text: '{"Prompt":"a"}' }, { model: "llama3.2:latest" });
  assert.equal(r.response, '{"Prompt":"a"}');
  assert.deepEqual(answerOf("ollama-generate", r), { text: '{"Prompt":"a"}' });
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

test("P3: n8n's multipart/form-data body is decoded and compared as string fields", () => {
  const b = "XyZb0undary";
  const file = Buffer.from([0, 255, 1, 2, 3]);
  const raw = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="body"\r\n\r\n# Review\nline two\r\n`),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="position[new_line]"\r\n\r\n48\r\n`),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="tag"\r\n\r\na\r\n--${b}\r\nContent-Disposition: form-data; name="tag"\r\n\r\nb\r\n`),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="x.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  const body = parseMultipart(raw, b);
  assert.equal(body.body, "# Review\nline two");
  assert.equal(body["position[new_line]"], "48");
  assert.deepEqual(body.tag, ["a", "b"]);
  assert.equal(body.file.filename, "x.bin");
  assert.equal(body.file.size, 5);
  assert.equal(body.file.contentType, "application/octet-stream");
  assert.match(body.file.sha256, /^[0-9a-f]{64}$/);
  const n = fromHttp(log("POST", "https://gitlab.com/api/v4/projects/4821/merge_requests/57/discussions", { body: "# Review", "position[new_line]": "48", "position[old_line]": "" }, { bodyEncoding: "multipart" }));
  const c = fromHttp({ method: "POST", url: "https://gitlab.com/api/v4/projects/4821/merge_requests/57/discussions", query: {}, body: { "position[old_line]": null, body: "# Review", "position[new_line]": 48 }, contentType: "multipart-form-data" }, "claude");
  assert.equal(compare([n], [c]).ok, true, "same fields, numbers and strings alike, any key order");
  const w = fromHttp({ method: "POST", url: "https://gitlab.com/api/v4/projects/4821/merge_requests/57/discussions", query: {}, body: { body: "# Review", "position[new_line]": 49, "position[old_line]": "" }, contentType: "multipart-form-data" }, "claude");
  assert.equal(compare([n], [w]).ok, false, "a different value still differs");
  const j = fromHttp({ method: "POST", url: "https://gitlab.com/api/v4/projects/4821/merge_requests/57/discussions", query: {}, body: { body: "# Review", "position[new_line]": 48, "position[old_line]": "" } }, "claude");
  assert.equal(compare([n], [j]).ok, false, "a JSON body keeps its types: only form bodies compare as strings");
  assert.deepEqual(formStrings({ b: { x: 1 }, a: [1, "2"] }), { a: ["1", "2"], b: '{"x":1}' });
});

test("P9: an in-process file part is recorded as the mock decodes the bytes sent for it", () => {
  const data = Buffer.from("%PDF-1.4 invoice\r\n\x00\xff", "latin1").toString("base64");
  const fields = { note: "two\nlines", file: { $file: { fileName: "dir/invoice.pdf", mimeType: "application/pdf; charset=binary", data } }, tags: ["a", { $file: { fileName: "b.txt", mimeType: "text/plain", data: "aGk=" } }] };
  const mp = multipartBody(fields);
  const wire = parseMultipart(mp.body, /boundary=(.+)$/.exec(mp.contentType)[1]);
  assert.deepEqual(decodeFileParts(fields), wire, "the in-process record equals the mock's decoding of the task driver's bytes");
  const n = fromHttp(log("POST", "https://api.example.test/upload", wire, { bodyEncoding: "multipart" }));
  const c = fromHttp({ method: "POST", url: "https://api.example.test/upload", query: {}, body: decodeFileParts(fields), contentType: "multipart-form-data" }, "claude");
  assert.equal(compare([n], [c]).ok, true, "same file on both sides compares equal");
  assert.equal(decodeFileParts(fields).file.size, Buffer.from(data, "base64").length);
});

test("P4: run-time timestamps are masked only where the sides differ by them alone", () => {
  const rt = { startMs: Date.parse("2026-11-14T05:00:43.621Z"), zone: "America/New_York" };
  const n8nIso = "Today is 2026-11-14T00:00:51.679-05:00.";
  const claudeIso = "Today is 2026-11-14T00:00:43.655-05:00.";
  assert.equal(maskRunTime(n8nIso, rt), maskRunTime(claudeIso, rt));
  assert.equal(maskRunTime(n8nIso, rt), "Today is <run-time:####-##-##T##:##:##.###>-05:00.");
  assert.notEqual(maskRunTime("at 2026-11-14T05:00:51.679Z", rt), maskRunTime("at 2026-11-14T00:00:43.655-05:00", rt), "a zone difference still shows");
  assert.equal(maskRunTime("due 2026-11-14T05:30:00Z", rt), "due 2026-11-14T05:30:00Z", "outside ±10 minutes: kept");
  assert.equal(maskRunTime("on 2026-11-14", rt), "on 2026-11-14", "date-only: kept");
  assert.equal(maskRunTime("2026-11-14 00:02", rt), "<run-time:####-##-## ##:##>", "no zone: read in the run's zone");
  assert.equal(maskRunTime("2026-11-14 05:02", rt), "2026-11-14 05:02", "a UTC wall time without zone is 5 hours off in New York");
  assert.equal(maskRunTime("Sat Nov 14 2026 00:03:00 GMT-0500 (Eastern Standard Time)", rt), "<run-time:Sat Nov ## #### ##:##:##> GMT-0500 (Eastern Standard Time)");
  assert.equal(maskRunTime("Sat, 14 Nov 2026 05:04:00 GMT", rt), "<run-time:Sat, ## Nov #### ##:##:##> GMT");
  assert.equal(maskRunTime("11/14/2026, 12:05:10 AM", rt), "<run-time:##/##/####, ##:##:## AM>");
  assert.equal(maskRunTime("November 14th 2026, 12:01:00 am", rt), "<run-time:November ##th ####, ##:##:## am>");
  assert.equal(maskRunTime(`id ${rt.startMs + 4000}`, rt), "id <run-time:#############>");
  const write = (text) => fromHttp(log("POST", "https://slack.com/api/chat.postMessage", { channel: "C1", text }));
  const tool = (text) => fromTool({ connector: "slack", tool: "slack_send_message", args: { channel_id: "C1", message: text } });
  const a = compare([write(n8nIso)], [tool(claudeIso)], { runTime: rt });
  assert.equal(a.ok, true, JSON.stringify(a.writes));
  assert.equal(a.runTimeMasked.length, 1);
  assert.equal(compare([write(n8nIso)], [tool(claudeIso)]).ok, false, "without the run's start nothing is masked");
  assert.equal(compare([write(n8nIso)], [tool(claudeIso + " Extra.")], { runTime: rt }).ok, false, "any other difference keeps the field different");
  const rec = { format: "anthropic", request: { system: `Assistant. ${n8nIso}`, messages: [{ role: "user", content: "Hi" }] } };
  const m = sameModelInput(rec, { kind: "agent", system: `Assistant. ${claudeIso}`, prompt: "Hi" }, rt);
  assert.deepEqual(m, { same: true, runTimeMasked: true });
  assert.equal(sameModelInput(rec, { kind: "agent", system: `Assistant. ${claudeIso}`, prompt: "Hi" }).same, false);
});

test("P6: writes to one target pair by content, deterministically, not by list order", () => {
  const url = "https://gitlab.com/api/v4/projects/4821/merge_requests/57/discussions";
  const post = (side, path, line) => fromHttp({ method: "POST", url, query: {}, body: { body: `Review of ${path}`, "position[new_path]": path, "position[new_line]": line } }, side);
  const n8n = [post("n8n", "test/b.test.ts", 9), post("n8n", "src/a.ts", 48)];
  const claude = [post("claude", "src/a.ts", 48), post("claude", "test/b.test.ts", 9)];
  const r = compare(n8n, claude);
  assert.equal(r.ok, true, JSON.stringify(r.writes));
  assert.equal(r.writes.matched.length, 2);
  assert.deepEqual(pairWrites(n8n, claude), [1, 0]);
  // A real difference still shows, against the closest partner.
  const off = compare(n8n, [post("claude", "src/a.ts", 48), post("claude", "test/b.test.ts", 10)]);
  assert.equal(off.ok, false);
  assert.equal(off.writes.fieldDiffs.length, 1);
  assert.equal(off.writes.fieldDiffs[0].diffs[0].n8n["position[new_path]"], "test/b.test.ts", "the differing write is compared with the same file's post");
  // Equal content keeps list order; extra writes stay extra.
  const same = [post("claude", "src/a.ts", 48), post("claude", "src/a.ts", 48)];
  assert.deepEqual(pairWrites([post("n8n", "src/a.ts", 48), post("n8n", "src/a.ts", 48)], same), [0, 1]);
  const more = compare([post("n8n", "src/a.ts", 48)], [post("claude", "test/b.test.ts", 9), post("claude", "src/a.ts", 48)]);
  assert.equal(more.writes.extra.length, 1);
  assert.equal(more.writes.extra[0].fields.body["position[new_path]"], "test/b.test.ts");
  assert.equal(more.writes.fieldDiffs.length, 0);
  // Within a generic body the share of equal keys decides.
  const near = [post("claude", "test/b.test.ts", 10), post("claude", "src/a.ts", 47)];
  assert.deepEqual(pairWrites(n8n, near), [0, 1]);
  assert.deepEqual(pairWrites([post("n8n", "src/a.ts", 47), post("n8n", "test/b.test.ts", 10)], [post("claude", "test/b.test.ts", 9), post("claude", "src/a.ts", 48)]), [1, 0]);
  // The assignment maximises the total, not the first row's pick.
  assert.deepEqual(maxAssignment([[5, 4], [4, 0]]), [1, 0]);
  assert.deepEqual(maxAssignment([[1], [3], [2]]), [-1, 0, -1]);
  assert.deepEqual(maxAssignment([[2, 2, 2]]), [0]);
});

test("P10: a Gmail reply tool call pairs with n8n's REST send of the reply (thread, recipients, subject, quoted-printable body)", () => {
  const fx = {
    trigger: { items: [] },
    reads: [{ node: "Trigger", connector: { calls: [{ tool: "search_threads", result: { threads: [{ id: "T1", messages: [{ id: "M1", sender: "ann@x.test", toRecipients: ["me@x.test"], subject: "Lunch?" }] }] } }] } }],
    writeReplies: [
      {
        node: "Reply",
        http: {
          responses: [
            { method: "GET", url: "https://www.googleapis.com/gmail/v1/users/me/messages/M1", body: { id: "M1", threadId: "T1", payload: { headers: [{ name: "From", value: '"Ann" <ann@x.test>' }, { name: "To", value: "me@x.test" }, { name: "Cc", value: "bo@x.test" }, { name: "Subject", value: "Lunch?" }] } } },
            { method: "GET", url: "https://www.googleapis.com/gmail/v1/users/me/profile", body: { emailAddress: "me@x.test", messagesTotal: 3 } },
          ],
        },
      },
    ],
  };
  const refs = refsOf(fx);
  assert.deepEqual(replyFields(refs.gmail, "M1", {}), { thread: "T1", recipient: ['"Ann" <ann@x.test>'], cc: undefined, subject: "Lunch?" });
  assert.deepEqual(replyFields(refs.gmail, "M1", { replyAll: true }).recipient, ['"Ann" <ann@x.test>'], "reply-all drops the account's own address");
  assert.deepEqual(replyFields(refs.gmail, "M1", { replyAll: true }).cc, ["bo@x.test"]);
  assert.deepEqual(replyFields(refs.gmail, "NOPE", {}), {});
  assert.equal(decodeQuotedPrintable("a long =\r\nline caf=C3=A9 =3D x"), "a long line café = x");
  const mime = ["To: Ann <ann@x.test>", "Subject: Lunch?", "Content-Transfer-Encoding: quoted-printable", "Content-Type: text/html; charset=utf-8", "", "Hi Ann,\n\nYes, noon works for =\r\nme.\n\nBest"].join("\r\n");
  const raw = Buffer.from(mime).toString("base64url");
  const n = fromHttp({ method: "POST", url: "https://www.googleapis.com/gmail/v1/users/me/messages/send", query: {}, body: { raw, threadId: "T1" } }, "n8n");
  assert.equal(n.fields.body, "Hi Ann,\n\nYes, noon works for me.\n\nBest");
  const c = fromTool({ connector: "gmail", tool: "reply", args: { messageId: "M1", htmlBody: "Hi Ann,\n\nYes, noon works for me.\n\nBest" } }, "claude", refs);
  assert.equal(c.target, "ann@x.test");
  const r = compare([n], [c]);
  assert.equal(r.ok, true, JSON.stringify(r.writes));
  // "Re: " is not an effect; the thread and the body are.
  const re = fromTool({ connector: "gmail", tool: "reply", args: { messageId: "M1", body: "Hi Ann,\n\nYes, noon works for me.\n\nBest" } }, "claude", { gmail: { ...refs.gmail, messages: new Map([["M1", { ...refs.gmail.messages.get("M1"), subject: "Re: Lunch?" }]]) } });
  assert.equal(compare([n], [re]).ok, true);
  const otherThread = fromTool({ connector: "gmail", tool: "reply", args: { messageId: "M1", body: "Hi Ann,\n\nYes, noon works for me.\n\nBest" } }, "claude", { gmail: { ...refs.gmail, messages: new Map([["M1", { ...refs.gmail.messages.get("M1"), thread: "T9" }]]) } });
  assert.equal(compare([n], [otherThread]).ok, false);
  assert.equal(compare([n], [fromTool({ connector: "gmail", tool: "reply", args: { messageId: "M1", body: "Different" } }, "claude", refs)]).ok, false);
  // Without the fixture's message the reply has no target and cannot pair.
  assert.equal(compare([n], [fromTool({ connector: "gmail", tool: "reply", args: { messageId: "M1", body: "x" } }, "claude")]).writes.extra[0].key, "gmail.send:");
});

test("P11: a read's rows are served again by args and per calling step; writes stay single-use", () => {
  const list = [{ node: "Get", args: { messageId: "m1" }, result: "one" }, { node: "Get", args: { messageId: "m2" }, result: "two" }];
  const trig = new Set();
  const get = new Set();
  assert.equal(pickConnector(list, { messageId: "m1", messageFormat: "FULL_CONTENT" }, trig, "Trigger", { read: true }).result, "one");
  assert.equal(pickConnector(list, { messageId: "m2" }, trig, "Trigger", { read: true }).result, "two");
  assert.equal(pickConnector(list, { messageId: "m1" }, get, "Get", { read: true }).result, "one", "the get read has its own rows");
  assert.equal(pickConnector(list, { messageId: "m1" }, trig, "Trigger", { read: true }).result, "one", "a used row with the same args answers again");
  const w = new Set();
  assert.equal(pickConnector(list, { messageId: "m1" }, w, "Get").result, "one");
  assert.equal(pickConnector(list, { messageId: "m1" }, w, "Get"), null, "a write does not reuse, and the row for m2 does not answer m1 (P112): the connector's default does");
  const plain = [{ node: "Poll", result: "a" }, { node: "Poll", result: "b" }];
  assert.equal(pickConnector(plain, {}, new Set(), "Later", { read: true }).result, "a", "another step reuses the read's rows from the start");
});

// PROPOSALS P30: an agent's final answer that reads as JSON, through the task driver path the
// claude driver uses (replay hook value -> `runner answer` -> run output -> chat reply effect).
test("P30: the chat reply carries its value type, so JSON text and an object with the same characters differ", async () => {
  const { replyOf, replyValueType } = await import("../evals/bench/compare.mjs");
  const text = '{"verdict":"spam","score":0.9}';
  assert.deepEqual([replyValueType([{ json: { output: text } }]), replyValueType([{ output: JSON.parse(text) }]), replyValueType([{ json: { text: "hi" } }]), replyValueType([{ json: { a: 1 } }]), replyValueType([])], ["text", "json", "text", "json", undefined]);
  const n8n = replyOf([{ json: { output: text } }], "n8n");
  const typed = replyOf([{ output: JSON.parse(text) }], "claude");
  assert.equal(typed.fields.text, text, "the serialised object reads the same as n8n's text");
  const c = compare([n8n], [typed]);
  assert.equal(c.ok, false);
  assert.deepEqual(c.writes.fieldDiffs[0].diffs.map((d) => [d.field, d.n8n, d.claude, !!d.modelWritten]), [["valueType", "text", "json", false]]);
  assert.equal(compare([n8n], [replyOf([{ output: text }], "claude")]).ok, true);
});

test("P30: through the task driver, an agent answer that reads as JSON stays text, as n8n's agent output", async () => {
  const { command, paths } = await import("../skills/n8n-migrate/runtime/src/driver.mjs");
  const core = await import("../skills/n8n-migrate/runtime/src/index.mjs");
  const { replyOf } = await import("../evals/bench/compare.mjs");
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "n8m-p30-"));
  try {
    const def = {
      schemaVersion: 1,
      name: "JSON-looking answer",
      steps: {
        Chat: { kind: "trigger", n8n: { type: "@n8n/n8n-nodes-langchain.chatTrigger", typeVersion: 1.1 }, params: {}, chat: true },
        Agent: { kind: "agent", n8n: { type: "@n8n/n8n-nodes-langchain.agent", typeVersion: 1.7 }, params: {}, agent: { prompt: "={{ $json.chatInput }}", system: "Answer with a JSON verdict.", tools: [] } },
      },
      edges: [{ from: "Chat", fromOutput: 0, to: "Agent", toInput: 0 }],
      allow: { tools: [], http: [], sql: [] },
      secrets: [],
    };
    writeFileSync(join(dir, "definition.json"), JSON.stringify(def));
    const run = (cmd, pos = [], flags = {}, input = "") => command(cmd, pos, flags, { core, dir, cwd: dir, stdin: () => input });
    await run("start", [], { trigger: JSON.stringify([{ chatInput: "Is this spam?" }]) });
    // The replay hook writes runnerValue(req, n8n's reply): the reply's text, unchanged.
    const text = '{"verdict": "spam", "score": 0.9}';
    assert.equal(runnerValue({ kind: "agent", tools: [] }, { text }), text);
    assert.match((await run("answer", ["q1"], {}, text)).text, /DONE/);
    const out = JSON.parse(readFileSync(join(paths(dir).runs, `${JSON.parse(readFileSync(paths(dir).state, "utf8")).runId}.json`), "utf8")).result.output;
    const n8n = replyOf([{ json: { output: text } }], "n8n");
    assert.deepEqual(compare([n8n], [replyOf(out, "claude")]).writes.fieldDiffs, [], `task driver output ${JSON.stringify(out)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
