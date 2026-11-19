// Bench changes of round 4 batch 3 (R4l): P109 (a Gmail send no fixture answers gets the API's
// sent message on both sides), P110 (the Drive CSV export answered from the fixture's Sheets
// REST data: the first sheet).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { gmailSentMessage, serviceAnswer, startMock } from "../evals/n8n/mock-server.mjs";
import { connectorDefault } from "../evals/mocks/limits.mjs";
import { createServer } from "../evals/mocks/mcp-server.mjs";
import { connectorFixtures, csvExport, sheetsExportCalls } from "../evals/bench/claude-side.mjs";

const SEND = "/gmail/v1/users/me/messages/send";

test("P109: the REST send and the connector's send_message answer the same sent message", () => {
  const first = gmailSentMessage(1);
  assert.match(first.id, /^[0-9a-f]{16}$/);
  assert.equal(first.threadId, first.id, "a message that starts a thread is its own thread");
  assert.deepEqual(first.labelIds, ["SENT"]);
  assert.notEqual(gmailSentMessage(2).id, first.id);
  assert.deepEqual(serviceAnswer("POST", "https://www.googleapis.com", SEND, { raw: "x" }, 1).f.body, first);
  assert.equal(serviceAnswer("POST", "https://www.googleapis.com", SEND, { raw: "x", threadId: "t1" }, 1).f.body.threadId, "t1", "a reply stays in its thread");
  assert.equal(serviceAnswer("POST", "https://api.example.test", SEND, {}, 1), null, "another host");
  assert.equal(serviceAnswer("GET", "https://www.googleapis.com", SEND, {}, 1), null);
  assert.deepEqual(connectorDefault("gmail", "send_message", { to: ["a@b.example"] }, 1), first);
  assert.deepEqual(connectorDefault("slack", "slack_send_message", {}, 1), { ok: true });
  assert.deepEqual(connectorDefault("gmail", "reply", {}, 1), { ok: true }, "a reply's thread is not known to the mock");
});

test("P109: the mock answers an unrouted Gmail send per run, and a route still wins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "n8m-p109-"));
  const fixtures = join(dir, "fixtures.json");
  writeFileSync(fixtures, JSON.stringify({ __routes: [], __writeDefault: { status: 200, body: {} } }));
  const mock = await startMock({ port: 0, host: "127.0.0.1", fixtures });
  const port = mock.server?.address?.().port ?? mock.address?.().port;
  const post = (url, body) =>
    new Promise((ok, fail) => {
      const r = request({ host: "127.0.0.1", port, method: "POST", path: url, headers: { "content-type": "application/json" } }, (res) => {
        let s = "";
        res.on("data", (c) => (s += c));
        res.on("end", () => ok(JSON.parse(s)));
      });
      r.on("error", fail);
      r.end(JSON.stringify(body));
    });
  try {
    const raw = Buffer.from("To: a@b.example\r\nSubject: Hi\r\n\r\nHello").toString("base64url");
    assert.deepEqual(await post(`https://www.googleapis.com${SEND}`, { raw }), gmailSentMessage(1));
    assert.deepEqual(await post(`https://www.googleapis.com${SEND}`, { raw }), gmailSentMessage(2));
    assert.deepEqual(await post("https://api.example.test/v1/items", { a: 1 }), {}, "other writes keep the write default");
    // A rewritten fixture file starts a new run, and the count again.
    writeFileSync(fixtures, JSON.stringify({ __routes: [], __writeDefault: { status: 200, body: {} } }) + " ");
    assert.deepEqual(await post(`https://www.googleapis.com${SEND}`, { raw }), gmailSentMessage(1));
    writeFileSync(fixtures, JSON.stringify({ __routes: [{ method: "POST", url: `https://www.googleapis.com${SEND}`, status: 200, body: { id: "fixture" } }] }));
    assert.deepEqual(await post(`https://www.googleapis.com${SEND}`, { raw }), { id: "fixture" });
  } finally {
    await new Promise((ok) => (mock.server ?? mock).close(ok));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P109: the MCP mock answers an unfixtured send_message with the n-th sent message", () => {
  const doc = { tools: [{ name: "send_message", inputSchema: { type: "object", properties: { to: { type: "array" } } } }] };
  const handle = createServer({ connector: "gmail", doc, fixtures: {} });
  const call = (id) => JSON.parse(handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "send_message", arguments: { to: ["a@b.example"] } } }).result.content[0].text);
  assert.deepEqual(call(1), gmailSentMessage(1));
  assert.deepEqual(call(2), gmailSentMessage(2));
});

test("P110: a Sheets read answered over REST only gets the Drive export of the first sheet", () => {
  const book = "https://sheets.googleapis.com/v4/spreadsheets/book1";
  const meta = { method: "GET", url: book, status: 200, body: { properties: { title: "Leads" }, sheets: [{ properties: { sheetId: 7, title: "Second", index: 1 } }, { properties: { sheetId: 0, title: "First tab", index: 0 } }] } };
  const first = { method: "GET", url: `${book}/values/'First tab'`, status: 200, body: { values: [["name", "note", "ok"], ["Ann", 'says "hi", twice', true], ["Bo"]] } };
  const second = { method: "GET", url: `${book}/values/'Second'`, status: 200, body: { values: [["x"], ["1"]] } };
  const fx = {
    reads: [
      { node: "Read first", connector: { none: "no captured Sheets connector" }, http: { responses: [meta, first] } },
      { node: "Read second", http: { responses: [meta, second] } },
      { node: "Has rows", connector: { connector: "google-drive", calls: [{ tool: "download_file_content", result: { content: "" } }] }, http: { responses: [meta, first] } },
      { node: "Other book", http: { responses: [{ method: "GET", url: "https://sheets.googleapis.com/v4/spreadsheets/book2/values/Sheet1", status: 200, body: { values: [["a"]] } }] } },
    ],
    writeReplies: [{ node: "Append", http: { responses: [meta, first] } }],
  };
  const calls = sheetsExportCalls(fx);
  assert.deepEqual(calls.map((c) => c.node), ["Read first", "Read second"], "rows of their own, writes and unknown first sheets get none");
  const csv = 'name,note,ok\nAnn,"says ""hi"", twice",TRUE\nBo,,';
  assert.equal(csvExport(first.body.values), csv);
  for (const c of calls) {
    assert.deepEqual(c.args, { fileId: "book1", exportMimeType: "text/csv" });
    assert.equal(Buffer.from(c.result.content, "base64").toString("utf8"), csv, "Drive exports the first sheet whatever tab the step names");
    assert.equal(c.result.title, "Leads");
  }
  assert.equal(connectorFixtures(fx)["google-drive.download_file_content"].length, 3);
});
