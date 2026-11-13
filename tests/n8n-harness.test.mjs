// Unit tests for the bench's n8n-side helpers (evals/n8n/). No Docker: the
// container paths are covered by `node evals/n8n/selftest.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseFlatted, pickTrigger, triggerItems, scheduleItem, swapTrigger, credentialRefs, summariseRunData } from "../evals/n8n/run-workflow.mjs";
import { startMock, pickFixture } from "../evals/n8n/mock-server.mjs";

test("flatted: n8n's execution encoding, shared strings and objects", () => {
  const text = JSON.stringify([{ version: 1, startData: "1", resultData: "2", same: "3" }, {}, { runData: "3", lastNodeExecuted: "4" }, { A: "5" }, "A", ["6"], { json: "7" }, { n: 1 }]);
  const v = parseFlatted(text);
  assert.equal(v.version, 1);
  assert.deepEqual(v.startData, {});
  assert.equal(v.resultData.lastNodeExecuted, "A");
  assert.deepEqual(v.resultData.runData.A, [{ json: { n: 1 } }]);
  assert.equal(v.same, v.resultData.runData, "one object stored once stays one object");
});

test("trigger choice, injected items, schedule item, swap", () => {
  const wf = {
    nodes: [
      { name: "Manual", type: "n8n-nodes-base.manualTrigger", parameters: {} },
      { name: "Hourly", type: "n8n-nodes-base.scheduleTrigger", parameters: {}, position: [0, 0] },
      { name: "Off hook", type: "n8n-nodes-base.webhook", parameters: { path: "x" }, disabled: true },
      { name: "Next", type: "n8n-nodes-base.noOp", parameters: {} },
    ],
    connections: { Hourly: { main: [[{ node: "Next", type: "main", index: 0 }]] } },
  };
  assert.equal(pickTrigger(wf).name, "Hourly", "schedule beats manual; disabled triggers never win");
  assert.equal(pickTrigger(wf, "Manual").name, "Manual");
  assert.throws(() => pickTrigger(wf, "Nope"));

  const s = scheduleItem("2026-11-16T09:05:07Z");
  assert.equal(s.timestamp, "2026-11-16T09:05:07.000+00:00");
  assert.equal(s["Readable date"], "November 16th 2026, 9:05:07 am");
  assert.equal(s["Day of week"], "Monday");
  assert.equal(s.Hour, "09");
  assert.deepEqual(triggerItems(wf.nodes[1], undefined, "2026-11-16T09:05:07Z"), [{ json: s }]);
  assert.deepEqual(triggerItems(wf.nodes[0], [{ a: 1 }, { json: { b: 2 } }]), [{ json: { a: 1 } }, { json: { b: 2 } }]);
  assert.deepEqual(triggerItems(wf.nodes[0], { items: [{ a: 1 }] }), [{ json: { a: 1 } }]);
  const hook = triggerItems(wf.nodes[2], { request: { headers: { "X-A": "1" }, query: { q: "2" }, body: { c: 3 } } });
  assert.deepEqual(hook[0].json.headers, { "x-a": "1" });
  assert.deepEqual(hook[0].json.body, { c: 3 });

  const sw = swapTrigger(wf, wf.nodes[1], [{ json: { a: 1 } }]);
  const code = sw.nodes.find((n) => n.name === "Hourly");
  assert.equal(code.type, "n8n-nodes-base.code");
  assert.match(code.parameters.jsCode, /return \[\{"json":\{"a":1\}\}\];/);
  assert.equal(sw.nodes.find((n) => n.name === "Manual").disabled, true, "other triggers are disabled");
  assert.deepEqual(sw.connections.__bench_start.main[0][0].node, "Hourly");
  assert.deepEqual(sw.connections.Hourly, wf.connections.Hourly);
});

test("credential references, legacy string form included", () => {
  const refs = credentialRefs({ nodes: [{ name: "A", credentials: { httpHeaderAuth: { id: "1", name: "Tok" } } }, { name: "B", credentials: { mongoDb: "db" } }, { name: "C" }] });
  assert.deepEqual(refs, [
    { node: "A", type: "httpHeaderAuth", id: "1", name: "Tok" },
    { node: "B", type: "mongoDb", id: null, name: "db" },
  ]);
});

test("run data summary keeps every output and the error", () => {
  const s = summariseRunData({ If: [{ executionStatus: "success", executionTime: 2, data: { main: [[{ json: { a: 1 } }], [{ json: { b: 2 } }]] } }], Bad: [{ executionStatus: "error", error: { message: "boom" }, data: {} }] });
  assert.deepEqual(s.If[0].items.main, [[{ a: 1 }], [{ b: 2 }]]);
  assert.equal(s.Bad[0].error, "boom");
});

test("mock: fixture precedence and reply lists", () => {
  const map = { "GET /a?x=1": { body: "q" }, "GET /a": [{ body: 1 }, { body: 2 }], "* /b": { body: "any" }, default: { status: 418 } };
  const c = new Map();
  assert.equal(pickFixture(map, "GET", "/a", "x=1", c).key, "GET /a?x=1");
  assert.equal(pickFixture(map, "GET", "/a", "", c).f.body, 1);
  assert.equal(pickFixture(map, "GET", "/a", "", c).f.body, 2);
  assert.equal(pickFixture(map, "GET", "/a", "", c).f.body, 2, "the last reply repeats");
  assert.equal(pickFixture(map, "DELETE", "/b", "", c).key, "* /b");
  assert.equal(pickFixture(map, "GET", "/zzz", "", c).key, "default");
  assert.equal(pickFixture({}, "GET", "/zzz", "", c).f.status, 404);
});

test("mock: records method, path, query, headers and body in order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "n2c-mock-"));
  const log = join(dir, "effects.jsonl");
  const fixtures = join(dir, "fixtures.json");
  writeFileSync(fixtures, JSON.stringify({ "POST /v1/x": [{ status: 201, body: { n: 1 } }, { body: { n: 2 } }] }));
  const server = await startMock({ port: 0, log, fixtures, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = (body) => fetch(`${base}/v1/x?k=v`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer t" }, body: JSON.stringify(body) });
    const r1 = await post({ a: 1 });
    assert.equal(r1.status, 201);
    assert.deepEqual(await r1.json(), { n: 1 });
    assert.deepEqual(await (await post({ a: 2 })).json(), { n: 2 });
    // Rewriting the fixture file (as the runner does before each run) restarts the list.
    writeFileSync(`${fixtures}.tmp`, readFileSync(fixtures));
    renameSync(`${fixtures}.tmp`, fixtures);
    assert.deepEqual(await (await post({ a: 3 })).json(), { n: 1 });
    const form = await fetch(`${base}/form`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=1&b=two" });
    assert.equal(form.status, 404);
    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.seq), [1, 2, 3, 4]);
    assert.deepEqual(lines[0].query, { k: "v" });
    assert.equal(lines[0].headers.authorization, "Bearer t");
    assert.deepEqual(lines[0].body, { a: 1 });
    assert.equal(lines[0].fixture, "POST /v1/x");
    assert.deepEqual(lines[3].body, { a: "1", b: "two" });
    assert.equal(lines[3].fixture, null);
  } finally {
    server.close();
  }
});

test("mock: proxied requests match origin-qualified keys first", () => {
  const map = { "GET http://a.test/x": { body: "a" }, "GET /x": { body: "any host" } };
  const c = new Map();
  assert.equal(pickFixture(map, "GET", "/x", "", c, "http://a.test").f.body, "a");
  assert.equal(pickFixture(map, "GET", "/x", "", c, "http://b.test").f.body, "any host");
  assert.equal(pickFixture(map, "GET", "/x", "", c).f.body, "any host");
});
