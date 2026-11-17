// Bench changes of round 6 setup (R6a): P132 (relative fixture times filled from one instant on
// both sides), P133 (a write field built with a randomness source compared by type and shape),
// P134 and P135 (the recording pass alone, with one redraw of a baseline a model reply stopped),
// P138 (the in-process Claude side logs a text body as the mock logs n8n's). P136 is decided as a
// task-prompt change (iteration 58, tests/task-driver.test.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fillRelativeTimes, fixtureClock, modelFedNodes, modelDrawFailure } from "../evals/bench/n8n-side.mjs";
import { compare, randomWriteNodes, randomShape, sameRandomShape } from "../evals/bench/compare.mjs";
import { decodeTextBody } from "../evals/n8n/mock-server.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("P132: both sides fill relative fixture times from n8n's fill instant, a day-old value included", () => {
  const fx = { items: [{ pubDate: "{{bench.now-1d}}", seen: "{{bench.now-10d|date}}", at: "{{bench.now|epochMs}}" }] };
  const fixtureAt = "2026-11-16T21:57:19.119Z";
  const rec = { startedAt: "2026-11-16T21:57:19.475Z", fixtureAt };
  const n8n = fillRelativeTimes(fx, fixtureAt);
  const claude = fillRelativeTimes(fx, fixtureClock(rec));
  assert.deepEqual(claude, n8n);
  assert.equal(n8n.items[0].pubDate, "2026-11-15T21:57:19.119Z");
  // A recording from before P132 keeps today's behaviour (its startedAt).
  assert.equal(fixtureClock({ startedAt: rec.startedAt }), rec.startedAt);
  assert.equal(fixtureClock(null), undefined);
});

test("P133: a write node whose own expression draws randomness, from n8n's workflow", () => {
  const wf = {
    nodes: [
      { name: "Create Task", parameters: { jsonBody: '=[{"tag": "{{ $json.d + Math.floor(10000 + Math.random() * 90000) }}"}]' } },
      { name: "Plain", parameters: { jsonBody: '={"a": "{{ $json.a }}"}' } },
      { name: "Code", parameters: { jsCode: "return [{ json: { r: Math.random() } }]" } },
      { name: "Off", disabled: true, parameters: { url: "={{ crypto.randomUUID() }}" } },
      { name: "Literal", parameters: { text: "Math.random() is not an expression here" } },
    ],
  };
  assert.deepEqual(randomWriteNodes(wf, ["Create Task", "Plain", "Off", "Literal"]), ["Create Task"]);
  assert.deepEqual(randomWriteNodes(wf, ["Plain"]), []);
  assert.deepEqual(randomShape({ tag: "site.com42819", n: 3, id: "0f8fad5b-d9cb-469f-a165-70867728950e" }), { tag: "site.com#", n: "#", id: "<uuid>" });
  assert.ok(sameRandomShape("exact", "site.com42819", "site.com38922"));
  assert.ok(!sameRandomShape("exact", "site.com42819", "other.com38922"));
  assert.ok(!sameRandomShape("id", "a1", "a2"));
});

test("P133: compare masks a random-only difference when asked, and nothing else", () => {
  const w = (tag, target = "x") => ({ service: "api", action: "POST /t", target: "/t", effect: "write", fields: { body: [{ target, tag }] }, cmp: { body: "exact" } });
  const off = compare([w("d42819")], [w("d38922")]);
  assert.equal(off.ok, false);
  const on = compare([w("d42819")], [w("d38922")], { random: true });
  assert.equal(on.ok, true);
  assert.deepEqual(on.randomMasked.map((m) => m.field), ["body"]);
  // A difference beyond the digits still fails.
  assert.equal(compare([w("d42819", "x")], [w("d38922", "y")], { random: true }).ok, false);
});

test("P134: a baseline failure at a node a model reply feeds, with the canned check clean", () => {
  const wf = {
    nodes: [{ name: "Trigger" }, { name: "Extract" }, { name: "Model" }, { name: "Email" }, { name: "Side" }],
    connections: { Trigger: { main: [[{ node: "Extract" }, { node: "Side" }]] }, Model: { ai_languageModel: [[{ node: "Extract" }]] }, Extract: { main: [[{ node: "Email" }]] } },
  };
  const models = [{ node: "Model", tag: "m0" }];
  assert.deepEqual([...modelFedNodes(wf, models)].sort(), ["Email", "Extract", "Model"]);
  const rec = (node) => ({ status: "error", error: { node, message: "x.join is not a function" } });
  assert.deepEqual(modelDrawFailure(wf, models, rec("Email")), { node: "Email", message: "x.join is not a function" });
  assert.equal(modelDrawFailure(wf, models, rec("Side")), null, "a node no model reply feeds");
  assert.equal(modelDrawFailure(wf, models, rec("Email"), false), null, "the canned check fails too: the template, not the draw");
  assert.equal(modelDrawFailure(wf, models, { status: "success" }), null);
  assert.equal(modelDrawFailure(wf, [], rec("Email")), null);
});

test("P135: --record-only needs ids", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "evals", "bench", "run.mjs"), "--record-only"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--record-only needs template ids/);
});

test("P138: a text body is logged by the mock's rule (JSON by content type or by its look)", () => {
  assert.deepEqual(decodeTextBody('{\n  "a": 1\n}', "JSON"), { body: { a: 1 }, bodyEncoding: "json" });
  assert.deepEqual(decodeTextBody('[{"a":1}]', "text/plain"), { body: [{ a: 1 }], bodyEncoding: "json" });
  assert.deepEqual(decodeTextBody("a,b\n1,2", "text/csv"), { body: "a,b\n1,2", bodyEncoding: "text" });
  assert.deepEqual(decodeTextBody("a=1&b=2", "application/x-www-form-urlencoded"), { body: { a: "1", b: "2" }, bodyEncoding: "form" });
  assert.deepEqual(decodeTextBody("{ not json", "application/json"), { body: "{ not json", bodyEncoding: "text" });
});
