// Round 5 setup's bench decisions (evals/bench/PROPOSALS.md P111-P119).
import { test } from "node:test";
import assert from "node:assert/strict";

// PROPOSALS P115: a live recording of n8n's concurrent per-item model calls lists them in
// completion order (the shim numbers a call on arrival and appends it when its reply is ready).
// The claude driver's replay hook read a node's calls by their place in the recording and the
// check read them by call index, so a reply paired by content was checked against the other
// item's request. Both now read call k as `index: k`, whatever order the recording holds.
test("P115: the claude driver's replay and its model-input check read recorded calls by call index, not recording order", async () => {
  const { callsByIndex } = await import("../evals/bench/model-shim.mjs");
  const { replayPick, claudeDriverModelInputs } = await import("../evals/bench/claude-side.mjs");
  const rec = (index, who) => ({ tag: "m0", node: "Summarize", index, format: "openai", request: { messages: [{ role: "system", content: "Summarize." }, { role: "user", content: `Episode: ${who}` }] }, response: { choices: [{ message: { role: "assistant", content: `About ${who}` } }] } });
  // As a live recording saves them when call 1's reply came back first.
  const completionOrder = [rec(1, "mirrors"), rec(0, "kettles")];
  const replayOrder = [rec(0, "kettles"), rec(1, "mirrors")];
  assert.deepEqual(callsByIndex(completionOrder).map((c) => c.index), [0, 1]);
  assert.deepEqual(callsByIndex([{ index: 0 }, { index: 0, dup: true }]).map((c) => !!c.dup), [false, true], "a duplicate index keeps a place after the others");
  const ask = (item, who) => ({ id: `Summarize#${item}`, kind: "model", system: "Summarize.", prompt: `Episode: ${who}` });
  const drive = (recordings, order) => {
    const state = { ids: {}, counts: {}, log: [] };
    const log = [];
    for (const [item, who] of order) {
      const req = ask(item, who);
      const p = replayPick({ recordings, workflow: null, state, reqId: req.id, req });
      log.push({ id: req.id, key: p.key, index: p.index, mode: p.rec ? "replay" : "live", t: `2026-11-16T00:00:0${item}.000Z`, req, reply: p.rec?.response.choices[0].message.content });
    }
    return log;
  };
  for (const recordings of [completionOrder, replayOrder]) {
    for (const order of [[[0, "kettles"], [1, "mirrors"]], [[1, "mirrors"], [0, "kettles"]]]) {
      const log = drive(recordings, order);
      // Each request gets its own item's reply ...
      for (const e of log) assert.equal(e.reply, `About ${e.req.prompt.slice(9)}`, JSON.stringify({ order, e: e.id }));
      // ... and the check compares it with the request n8n sent for that item.
      const checked = claudeDriverModelInputs({ replayLog: log, recordings });
      assert.equal(checked.length, 2);
      assert.ok(checked.every((m) => m.input.same), JSON.stringify(checked));
    }
  }
  // A different question still fails the check.
  const log = drive(completionOrder, [[0, "kettles"], [1, "toasters"]]);
  assert.deepEqual(claudeDriverModelInputs({ replayLog: log, recordings: completionOrder }).map((m) => m.input.same), [true, false]);
});

// PROPOSALS P116: n8n's legacy OpenAI text edit posts to the retired /v1/edits, which the fixture
// answers as a route, so no recorded model call existed for the node and the Claude side's model
// step was neither replayed nor checked (the claude driver's session had to answer an empty prompt
// itself). The fixture-answered request is now a recorded call of the fixture read's node, and a
// Claude request that asks nothing is not the same question as one that asked something.
test("P116: a fixture-answered /v1/edits call is a recorded model call of its node; an empty prompt is a different input", async () => {
  const { fixtureModelCalls, recordedCalls, sameModelInput, replayPick } = await import("../evals/bench/claude-side.mjs");
  const { protocolSlip } = await import("../evals/bench/claude-driver.mjs");
  const { normalize, answerOf } = await import("../evals/bench/model-shim.mjs");
  const reply = { object: "edit", choices: [{ text: "Hallo Welt", index: 0 }] };
  const fx = { reads: [{ node: "Edit", http: { responses: [{ method: "POST", url: "https://api.openai.com/v1/edits", status: 200, body: reply }] } }] };
  const rec = {
    modelCalls: [{ tag: "m0", node: "Complete", index: 0, format: "openai-completions", request: { prompt: "x" }, response: { choices: [{ text: "Hello world" }] } }],
    effects: [
      { seq: 5, method: "POST", proxied: "https://api.openai.com", path: "/v1/edits", body: { model: "text-davinci-edit-001", input: "Hello world", instruction: "translate to German" }, fixture: "route POST https://api.openai.com/v1/edits" },
      { seq: 6, method: "POST", proxied: "https://api.example", path: "/v1/edits", body: {}, fixture: "route POST https://api.example/v1/edits" },
    ],
  };
  const calls = fixtureModelCalls(rec, fx);
  assert.deepEqual(calls.map((c) => [c.node, c.index, c.format, c.mode]), [["Edit", 0, "openai-edits", "fixture"]], "only the Edits API on its own host");
  assert.equal(answerOf("openai-edits", calls[0].response).text, "Hallo Welt");
  assert.deepEqual(normalize("openai-edits", calls[0].request).messages.map((m) => m.text), ["translate to German", "Hello world"]);
  assert.equal(recordedCalls(rec, fx).length, 2);
  assert.equal(fixtureModelCalls({ ...rec, effects: [{ ...rec.effects[0], fixture: "write-default" }] }, fx).length, 0, "a request no route answered is not a recorded reply");
  assert.equal(fixtureModelCalls({ ...rec, modelCalls: [{ ...rec.modelCalls[0], node: "Edit" }] }, fx).length, 0, "a node the shim recorded keeps its own calls");
  // The question: instruction and text asked, as the converter would carry them, match; the
  // empty prompt the converter wrote for 1900 does not (before, it matched anything).
  assert.equal(sameModelInput(calls[0], { kind: "model", prompt: "translate to German\n\nHello world" }).same, true);
  const empty = sameModelInput(calls[0], { kind: "model", prompt: "" });
  assert.deepEqual([empty.same, empty.emptyPrompt], [false, true]);
  assert.equal(sameModelInput({ format: "openai-completions", request: { prompt: "" } }, { kind: "model", prompt: "" }).same, true, "nothing asked on both sides is the same");
  // The claude driver now has n8n's reply to replay for the step, so a session that ends without
  // writing it is a P40 slip (retried once), not a verdict on the folder.
  const state = { ids: {}, counts: {}, log: [] };
  assert.equal(replayPick({ recordings: calls, state, reqId: "Edit#0", req: { kind: "model", prompt: "translate to German Hello world" } }).rec, calls[0]);
  const slip = protocolSlip({ state: { status: "needs", requests: [{ id: "Edit#0", kind: "model" }] }, resultOk: true, replayState: {}, recordings: calls });
  assert.ok(slip && slip.outstanding.length === 1);
  assert.equal(protocolSlip({ state: { status: "needs", requests: [{ id: "Edit#0", kind: "model" }] }, resultOk: true, replayState: {}, recordings: [] }), null, "without a recorded reply (before P116) it was not a slip");
});

// PROPOSALS P112: a connector row whose args name another value for an argument the call carries
// answers a different call, so it is never a fallback, in process or in the claude driver's MCP mock.
test("P112: a connector row that contradicts the call's arguments is not a fallback", async () => {
  const { pickConnector, contradicts } = await import("../evals/bench/claude-side.mjs");
  const rows = [{ node: "Read", args: { fileId: "abc123" }, result: "rows of abc123" }, { node: "Read", result: "any" }];
  assert.equal(contradicts({ fileId: "abc123" }, { fileId: "https://docs.google.com/spreadsheets/d/abc123/edit" }), true);
  assert.equal(contradicts({ fileId: "abc123" }, { query: "x" }), false, "an argument the call does not carry is no contradiction");
  assert.equal(contradicts({ query: "createdTime > '2026-11-16T08:58:00'" }, { query: "createdTime > '2026-11-16T09:01:00'" }), false, "a free-text argument may differ (2614 in r5-base: the run's time in a Drive search)");
  assert.equal(contradicts(undefined, { fileId: "x" }), false);
  const used = new Set();
  assert.equal(pickConnector(rows, { fileId: "https://docs.google.com/spreadsheets/d/abc123/edit" }, used, "Read", { read: true }).result, "any", "the row without args still answers");
  assert.equal(pickConnector([rows[0]], { fileId: "https://docs.google.com/spreadsheets/d/abc123/edit" }, new Set(), "Read", { read: true }), null, "no row fits: the connector's default");
  assert.equal(pickConnector([rows[0]], { fileId: "abc123", exportMimeType: "text/csv" }, new Set(), "Read", { read: true }).result, "rows of abc123");
  // The MCP mock (claude driver) the same way.
  const { createServer, schemaFile } = await import("../evals/mocks/mcp-server.mjs");
  const { readFileSync } = await import("node:fs");
  const doc = JSON.parse(readFileSync(schemaFile("google-drive"), "utf8"));
  const handle = createServer({ connector: "google-drive", doc, fixtures: { "google-drive": { download_file_content: { reuse: true, responses: [{ args: { fileId: "abc123" }, result: { content: "rows of abc123" } }] } } } });
  const call = async (id, args) => JSON.stringify(await handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "download_file_content", arguments: args } }));
  assert.ok(!(await call(1, { fileId: "https://docs.google.com/spreadsheets/d/abc123/edit", exportMimeType: "text/csv" })).includes("rows of abc123"));
  assert.ok((await call(2, { fileId: "abc123", exportMimeType: "text/csv" })).includes("rows of abc123"));
});

// PROPOSALS P111: n8n's Slack node (v2.1 on, a text message) appends a workflow link line naming
// the instance; the comparer removes exactly that line from the end of n8n-side text only.
test("P111: Slack's workflow link is stripped from n8n-side message text only", async () => {
  const { compare, fromHttp, fromTool, stripAttribution } = await import("../evals/bench/compare.mjs");
  const line = "\n_Automated with this <http://127.0.0.1:5690/workflow/yMksP830k596SvgJ?utm_source=n8n-internal&utm_medium=powered_by&utm_campaign=n8n-nodes-base.slack_7610af69|n8n workflow>_";
  assert.deepEqual(stripAttribution(`New article${line}`, "n8n-nodes-base.slack"), { text: "New article", stripped: "slack" });
  assert.equal(stripAttribution(`${line}`.slice(1), "n8n-nodes-base.slack").text, "", "an empty text keeps only the line");
  assert.equal(stripAttribution(`New article${line} and more`, "n8n-nodes-base.slack").stripped, false, "only at the end");
  assert.equal(stripAttribution(`New article${line.replace("n8n-nodes-base.slack", "n8n-nodes-base.discord")}`, "n8n-nodes-base.slack").stripped, false, "another node type's link stays");
  const n8n = fromHttp({ method: "POST", proxied: "https://slack.com", path: "/api/chat.postMessage", body: { channel: "C1", text: `New article${line}` } }, "n8n");
  const claude = fromTool({ connector: "slack", tool: "slack_send_message", args: { channel_id: "C1", message: "New article" } }, "claude");
  const viaHttp = fromHttp({ method: "POST", url: "https://slack.com/api/chat.postMessage", body: { channel: "C1", text: "New article" } }, "claude");
  const c = compare([n8n], [claude.unmapped ? viaHttp : claude]);
  assert.equal(c.ok, true, JSON.stringify(c.writes));
  assert.equal(c.attributionStripped[0].form, "slack");
  // A Claude-side line is never stripped.
  assert.equal(compare([fromHttp({ method: "POST", proxied: "https://slack.com", path: "/api/chat.postMessage", body: { channel: "C1", text: "New article" } }, "n8n")], [fromHttp({ method: "POST", url: "https://slack.com/api/chat.postMessage", body: { channel: "C1", text: `New article${line}` } }, "claude")]).ok, false);
});

// PROPOSALS P113: Graph page photos and feed posts have their own rule, and a generic effect's
// query leaves out an `access_token` (n8n's dummy against the Claude side's secret placeholder).
test("P113: Graph page photos compare message, link and the file part; a query access token is never compared", async () => {
  const { compare, fromHttp } = await import("../evals/bench/compare.mjs");
  const file = { filename: "data", contentType: "image/png", size: 88, sha256: "5562bac6" };
  const n8n = fromHttp({ method: "POST", proxied: "https://graph.facebook.com", path: "/v21.0/4337/photos", query: {}, rawQuery: "access_token=bench-dummy&message=Ciao&link=https%3A%2F%2Fex.example%2Fa", bodyEncoding: "multipart", body: { file } }, "n8n");
  const claude = fromHttp({ method: "POST", url: "https://graph.facebook.com/v21.0/4337/photos", query: { access_token: "{{secret}}", message: "Ciao", link: "https://ex.example/a" }, contentType: "multipart/form-data", body: { file } }, "claude");
  assert.deepEqual([n8n.service, n8n.action, n8n.target], ["facebook", "page_photo", "4337"]);
  assert.deepEqual(n8n.fields, { message: "Ciao", link: "https://ex.example/a", fileType: "image/png", fileSha256: "5562bac6" });
  assert.equal(compare([n8n], [claude]).ok, true);
  const otherPhoto = fromHttp({ method: "POST", url: "https://graph.facebook.com/v21.0/4337/photos", query: { access_token: "{{secret}}", message: "Ciao", link: "https://ex.example/a" }, contentType: "multipart/form-data", body: { file: { ...file, sha256: "ffff" } } }, "claude");
  assert.equal(compare([n8n], [otherPhoto]).ok, false, "a different file still differs");
  const feed = fromHttp({ method: "POST", url: "https://graph.facebook.com/v21.0/4337/feed", body: { message: "Hi", link: "https://ex.example" } }, "claude");
  assert.deepEqual([feed.action, feed.fields.message, feed.fields.link], ["page_post", "Hi", "https://ex.example"]);
  // A request no rule maps: the query compares without its access token, the rest still exact.
  const gen = (token, q) => fromHttp({ method: "POST", url: `https://api.unknown.example/v1/things?access_token=${token}&q=${q}`, body: {} }, "claude");
  assert.deepEqual(gen("a", "x").fields.query, { q: "x" });
  assert.equal(compare([{ ...gen("bench-dummy", "x"), side: "n8n" }], [gen("{{secret}}", "x")]).ok, true);
  assert.equal(compare([{ ...gen("bench-dummy", "x"), side: "n8n" }], [gen("{{secret}}", "y")]).ok, false);
});

// PROPOSALS P114: in an agent's tool turn, a Drive CSV export of a spreadsheet is the same read as
// n8n's Sheets API read of it; other Drive downloads keep their own key.
test("P114: a Drive CSV export of a spreadsheet counts as the Sheets read of it in a tool turn", async () => {
  const { claudeReadKeys } = await import("../evals/bench/claude-side.mjs");
  const { fromHttp, keyOf } = await import("../evals/bench/compare.mjs");
  const n8nKey = keyOf(fromHttp({ method: "GET", proxied: "https://sheets.googleapis.com", path: "/v4/spreadsheets/1AbC/values/Sheet1", query: {} }, "n8n"));
  assert.equal(n8nKey, "sheets.get:1AbC");
  assert.deepEqual(claudeReadKeys([{ connector: "google-drive", tool: "download_file_content", args: { fileId: "1AbC", exportMimeType: "text/csv" } }]), [n8nKey]);
  assert.deepEqual(claudeReadKeys([{ connector: "google-drive", tool: "download_file_content", args: { fileId: "1AbC" } }]), ["drive.download:1AbC"], "a plain download is a Drive read");
  assert.deepEqual(claudeReadKeys([{ connector: "google-drive", tool: "download_file_content", args: { fileId: "1XyZ", exportMimeType: "text/csv" } }]), ["sheets.get:1XyZ"], "another spreadsheet stays another read");
});

// PROPOSALS P117: the two round-4 held-out fixtures written while P66 was pending now seed their
// databases (typed, from the template and fixture data alone), and a current-round template whose
// main path reaches a database node without a seeded database fails validation.
test("P117: promoted fixtures seed their databases; a current-round database node without one is a validation error", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const FX = join(import.meta.dirname, "..", "evals", "bench", "fixtures");
  for (const v of ["normal", "empty", "malformed", "hostile"]) {
    const mongo = JSON.parse(readFileSync(join(FX, "503", `${v}.json`), "utf8"));
    assert.deepEqual(mongo.db, { mongodb: { collections: { "n8n-collection": [] } } }, `503/${v}`);
    const pg = JSON.parse(readFileSync(join(FX, "2612", `${v}.json`), "utf8"));
    assert.deepEqual(Object.keys(pg.db.postgres.tables), ["public.customers", "public.orders"], `2612/${v}`);
    assert.equal(pg.db.postgres.tables["public.orders"].columns.details, "jsonb");
    for (const r of pg.reads.filter((x) => x.db)) assert.deepEqual(r.db, { engine: "postgres" }, "no legacy seed left");
  }
  const r = spawnSync(process.execPath, [join(import.meta.dirname, "..", "evals", "bench", "validate.mjs"), "--ids", "503,2612"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /8 fixture files, 0 failing/);
  assert.doesNotMatch(r.stdout, /has no db\.|legacy db\.seed/);
});

// PROPOSALS P101: a route that answers a retired service or API version says so, and each run
// reports the retired routes it used.
test("P101: retired routes are marked in the fixture and reported per run", async () => {
  const { logVsFixture } = await import("../evals/bench/n8n-side.mjs");
  const routes = [
    { node: "Edit", method: "POST", url: "https://api.openai.com/v1/edits", retired: "OpenAI Edits API, shut down 2024", status: 200 },
    { node: "Other", method: "GET", url: "https://api.example/x", status: 200 },
  ];
  const effects = [{ seq: 1, method: "POST", proxied: "https://api.openai.com", path: "/v1/edits", fixture: "route POST https://api.openai.com/v1/edits" }];
  const out = logVsFixture({ routes }, effects);
  assert.deepEqual(out.retired, [{ node: "Edit", method: "POST", url: "https://api.openai.com/v1/edits", retired: "OpenAI Edits API, shut down 2024" }]);
  assert.equal(logVsFixture({ routes }, []).retired, undefined, "an unused retired route is not reported");
});
