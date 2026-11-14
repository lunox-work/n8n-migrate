// Bench gate logic (evals/bench/gates.mjs): pure decisions from observed results.

import { test } from "node:test";
import assert from "node:assert/strict";
import { gate1, gate2, gate3, gate4, gate5, gate6, gate7, gate8, robustness, reached, runFailureCause, BUCKETS } from "../evals/bench/gates.mjs";
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
