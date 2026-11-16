// Engine semantics (n8n v1 execution order, item pairing, error handling), deterministic
// replay across process restarts, containment and preflight.
import { test } from "node:test";
import assert from "node:assert/strict";
import { wf, node, start, run, out, CLOCK } from "./runtime-helpers.mjs";
import { start as startRun, resume, preflight } from "../skills/n8n-to-claude/runtime/src/api.mjs";
import { BadInput } from "../skills/n8n-to-claude/runtime/src/util.mjs";
import { hashHex } from "../skills/n8n-to-claude/runtime/src/hash.mjs";

const assign = (...list) => ({ assignments: list.map(([name, type, value]) => ({ id: name, name, type, value })) });
const setNode = (name, fields, o = {}) => node(name, "set", { assignments: assign(...fields), includeOtherFields: o.keep ?? false, options: {} }, { v: 3.4, ...o });
const order = (r) => Object.entries(r.runData).flatMap(([n, runs]) => runs.map((t) => [t.executionIndex, n])).sort((a, b) => a[0] - b[0]).map(([, n]) => n);
const ifGt = (name, n, o = {}) => node(name, "if", { conditions: { options: { version: 2, typeValidation: "strict", caseSensitive: true }, combinator: "and", conditions: [{ leftValue: "={{ $json.n }}", rightValue: n, operator: { type: "number", operation: "gt" } }] }, options: {} }, { v: 2.2, ...o });

test("branches run depth-first, the upper branch first (canvas position)", async () => {
  const def = wf(
    [start(), node("Low", "noOp", {}, { pos: [200, 200] }), node("Low 2", "noOp", {}, { pos: [400, 200] }), node("High", "noOp", {}, { pos: [200, -200] }), node("High 2", "noOp", {}, { pos: [400, -200] })],
    [["Start", "Low"], ["Start", "High"], ["Low", "Low 2"], ["High", "High 2"]],
  );
  assert.deepEqual(order(await run(def)), ["Start", "High", "High 2", "Low", "Low 2"]);
});

test("an empty output stops its branch; alwaysOutputData emits one empty item", async () => {
  const def = (always) => wf([start(), ifGt("If", 10, { settings: always ? { alwaysOutputData: true } : {} }), node("Yes", "noOp", {}, { pos: [400, 0] }), node("No", "noOp", {}, { pos: [400, 100] })], [["Start", "If"], ["If", "Yes", 0], ["If", "No", 1]]);
  const r = await run(def(false), { trigger: [{ n: 1 }] });
  assert.equal(r.runData.Yes, undefined);
  assert.deepEqual(out(r, "No"), [{ n: 1 }]);
  const a = await run(def(true), { trigger: [{ n: 1 }] });
  assert.deepEqual(out(a, "If", 0), [{}]);
  assert.deepEqual(out(a, "Yes"), [{}]);
});

test("Merge waits for both inputs; a branch that never fires releases it at the end", async () => {
  const def = (mode) =>
    wf(
      [start(), ifGt("If", 2, { pos: [200, 0] }), setNode("Big", [["big", "boolean", "true"]], { keep: true, pos: [400, -100] }), setNode("Small", [["small", "boolean", "true"]], { keep: true, pos: [400, 100] }), node("Merge", "merge", mode, { v: 3, pos: [600, 0] }), node("After", "noOp", {}, { pos: [800, 0] })],
      [["Start", "If"], ["If", "Big", 0], ["If", "Small", 1], ["Big", "Merge", 0, 0], ["Small", "Merge", 0, 1], ["Merge", "After"]],
    );
  const both = await run(def({}), { trigger: [{ n: 1 }, { n: 5 }] });
  assert.deepEqual(order(both), ["Start", "If", "Big", "Small", "Merge", "After"]);
  assert.deepEqual(out(both, "Merge"), [{ n: 5, big: true }, { n: 1, small: true }]);
  const one = await run(def({}), { trigger: [{ n: 5 }] });
  assert.deepEqual(order(one), ["Start", "If", "Big", "Merge", "After"]);
  assert.deepEqual(out(one, "Merge"), [{ n: 5, big: true }]);
  const choose = await run(def({ mode: "chooseBranch" }), { trigger: [{ n: 5 }] });
  assert.equal(choose.runData.Merge, undefined, "chooseBranch needs both inputs");
});

test("executeOnce uses the first item; disabled nodes pass input through", async () => {
  const def = wf([start(), setNode("Once", [["x", "number", "={{ $json.n }}"]], { settings: { executeOnce: true } }), setNode("Off", [["y", "number", "1"]], { settings: { disabled: true } })], [["Start", "Once"], ["Once", "Off"]]);
  const r = await run(def, { trigger: [{ n: 1 }, { n: 2 }, { n: 3 }] });
  assert.deepEqual(out(r, "Once"), [{ x: 1 }]);
  assert.deepEqual(out(r, "Off"), [{ x: 1 }]);
});

test("retryOnFail retries with fresh request ids, then succeeds", async () => {
  let calls = 0;
  const def = wf([start(), node("Get", "httpRequest", { url: "https://x.test/r", options: {} }, { v: 4.2, settings: { retryOnFail: true, maxTries: 3, waitBetweenTries: 100 } })], [["Start", "Get"]], { allow: { http: [{ method: "GET", host: "x.test", pathPrefix: "/" }] } });
  const r = await run(def, { host: { http: async () => (++calls < 3 ? { status: 503, headers: {}, body: "busy" } : { status: 200, headers: { "content-type": "application/json" }, body: { ok: 1 } }) } });
  assert.equal(r.status, "done");
  assert.deepEqual(r.effects.map((e) => e.id), ["Get#0#0", "Get#0#0@1", "Get#0#0@2"]);
  assert.deepEqual(out(r, "Get"), [{ ok: 1 }]);
  assert.equal(r.endedAt, "2026-11-14T03:00:00.200Z");
});

test("onError: continueErrorOutput routes error items to an extra output, merged with the input", async () => {
  const def = wf([start(), node("Set", "set", { assignments: assign(["n", "number", "={{ $json.v }}"]), options: {} }, { v: 3.4, settings: { onError: "continueErrorOutput" } }), node("Ok", "noOp", {}, { pos: [400, 0] }), node("Bad", "noOp", {}, { pos: [400, 100] })], [["Start", "Set"], ["Set", "Ok", 0], ["Set", "Bad", 1]]);
  const r = await run(def, { trigger: [{ v: "1" }, { v: "x" }] });
  assert.deepEqual(out(r, "Ok"), [{ n: 1 }]);
  assert.deepEqual(out(r, "Bad"), [{ v: "x", error: "'n' expects a number but we got 'x' [item 1]" }]);
});

test("onError: stopWorkflow (default) records the failed node and stops", async () => {
  const def = wf([start(), node("Code", "code", { jsCode: "throw new Error('nope')" }, { v: 2 }), node("Next", "noOp")], [["Start", "Code"], ["Code", "Next"]]);
  const r = await run(def);
  assert.equal(r.status, "failed");
  assert.deepEqual(r.error, { name: "NodeError", message: "nope [line 1]", node: "Code" });
  assert.equal(r.runData.Code[0].error.message, "nope [line 1]");
  assert.equal(r.runData.Next, undefined);
});

test("a node that throws while continuing on error passes its input through (n8n quirk)", async () => {
  const def = wf([start(), node("Stop", "stopAndError", { errorMessage: "x" }, { settings: { onError: "continueRegularOutput" } }), node("Next", "noOp")], [["Start", "Stop"], ["Stop", "Next"]]);
  const r = await run(def, { trigger: [{ a: 1 }] });
  assert.equal(r.status, "done");
  assert.deepEqual(out(r, "Stop"), [{ a: 1 }]);
  assert.equal(r.runData.Stop[0].error.message, "x");
  // When that node is the last to run, n8n still ends the execution as an error with its
  // message (observed from n8n 2.47.7: tests/fixtures/n8n-observed/code-return-shapes.json).
  const last = await run(wf([start(), node("Stop", "stopAndError", { errorMessage: "x" }, { settings: { onError: "continueRegularOutput" } })], [["Start", "Stop"]]), { trigger: [{ a: 1 }] });
  assert.equal(last.status, "failed");
  assert.equal(last.error.message, "x");
  assert.equal(last.lastNodeExecuted, "Stop");
  assert.deepEqual(out(last, "Stop"), [{ a: 1 }]);
});

test("$('Node').item follows paired items through filters and reorderings", async () => {
  const def = wf(
    [start(), ifGt("If", 1, { pos: [200, 0] }), node("Rev", "code", { jsCode: "return $input.all().reverse().map(i => ({ json: { r: i.json.n }, pairedItem: i.pairedItem }))" }, { v: 2, pos: [400, 0] }), setNode("Back", [["orig", "string", "={{ $('Start').item.json.name }}"], ["idx", "number", "={{ $('If').item.json.n }}"]], { pos: [600, 0] })],
    [["Start", "If"], ["If", "Rev", 0], ["Rev", "Back"]],
  );
  const r = await run(def, { trigger: [{ n: 1, name: "a" }, { n: 2, name: "b" }, { n: 3, name: "c" }] });
  assert.deepEqual(out(r, "Back"), [{ orig: "c", idx: 3 }, { orig: "b", idx: 2 }]);
});

test("paired items that lead to two different items raise n8n's 'Multiple matches'", async () => {
  const def = wf([start(), node("Agg", "aggregate", { fieldsToAggregate: { fieldToAggregate: [{ fieldToAggregate: "n" }] } }), setNode("Back", [["x", "string", "={{ $('Start').item.json.n }}"]])], [["Start", "Agg"], ["Agg", "Back"]]);
  const r = await run(def, { trigger: [{ n: 1 }, { n: 2 }] });
  assert.equal(r.status, "failed");
  assert.equal(r.error.message, "Multiple matches found");
});

test("$node['X'].json is index-based and $('X').first/last/all read X's output", async () => {
  const def = wf([start(), setNode("A", [["v", "number", "={{ $json.n * 10 }}"]]), node("Code", "code", { jsCode: "return [{ json: { first: $('A').first().json.v, last: $('A').last().json.v, n: $('A').all().length, byIndex: $node['A'].json.v } }]" }, { v: 2 })], [["Start", "A"], ["A", "Code"]]);
  const r = await run(def, { trigger: [{ n: 1 }, { n: 2 }, { n: 3 }] });
  assert.deepEqual(out(r, "Code"), [{ first: 10, last: 30, n: 3, byIndex: 10 }]);
});

test("the same definition, trigger and clock give identical run data", async () => {
  const def = wf([start(), node("Code", "code", { jsCode: "return items.map(i => ({ json: { r: Math.random(), t: new Date().toISOString() } }))" }, { v: 2 })], [["Start", "Code"]]);
  const a = await run(def, { trigger: [{}, {}], runId: "same" });
  const b = await run(def, { trigger: [{}, {}], runId: "same" });
  assert.deepEqual(a.runData, b.runData);
});

// ---------- deterministic replay ----------

function replayFlow() {
  return wf(
    [
      start(),
      node("Fetch", "httpRequest", { url: "=https://api.example.com/orders/{{ $json.id }}", options: {} }, { v: 4.2, pos: [200, 0] }),
      node("Ask", "@n8n/n8n-nodes-langchain.chainLlm", {}, { kind: "model", model: { prompt: "=Classify order {{ $json.order }}" }, pos: [400, 0] }),
      node("Post", "n8n-nodes-base.slack", {}, { kind: "tool", tool: { connector: "slack", name: "send_message", args: { channel: "#ops", text: "={{ $('Fetch').item.json.order }}: {{ $json.text }} ({{ Math.random() > 2 ? 'x' : 'ok' }})" } }, pos: [600, 0] }),
      setNode("Done", [["at", "string", "={{ $now.toISO() }}"], ["r", "number", "={{ Math.random() }}"]], { keep: true, pos: [800, 0] }),
    ],
    [["Start", "Fetch"], ["Fetch", "Ask"], ["Ask", "Post"], ["Post", "Done"]],
    { allow: { tools: [{ connector: "slack", tool: "send_message" }], http: [{ method: "GET", host: "api.example.com", pathPrefix: "/orders/" }] } },
  );
}
const replayHost = {
  http: async (req) => ({ status: 200, headers: { "content-type": "application/json" }, body: { order: req.url.split("/").pop() } }),
  model: async (req) => `class of ${req.prompt.slice(-2)}`,
  tool: async (req) => ({ ok: true, ts: "1.2", echo: req.args.text }),
};
async function answer(requests) {
  const res = {};
  for (const r of requests) {
    const { id, kind, effectKey, step, ...payload } = r;
    res[id] = { ok: true, value: await replayHost[kind]({ ...payload, step }) };
  }
  return res;
}

test("replay: killed after every host result, the run resumes to identical run data and effects", async () => {
  const def = replayFlow();
  const trigger = [{ id: "A1" }];
  const inProcess = await run(def, { trigger, runId: "rp", host: replayHost, virtualTime: false });
  assert.equal(inProcess.status, "done");

  let res = await startRun(def, { trigger, clock: CLOCK, runId: "rp" });
  let hops = 0;
  while (res.status === "needs") {
    // Simulate a process restart: only the JSON state file survives.
    const state = JSON.parse(JSON.stringify(res.state));
    assert.equal(res.requests.length, 1);
    res = await resume(state, await answer(res.requests));
    hops++;
  }
  assert.equal(hops, 3);
  assert.equal(res.status, "done");
  assert.deepEqual(res.runData, inProcess.runData);
  assert.deepEqual(res.effects, inProcess.effects);
  assert.deepEqual(res.effects.map((e) => e.id), ["Fetch#0#0", "Ask#0#0", "Post#0#0"]);
  assert.equal(res.effects[2].effectKey, hashHex("sha256", "rp|Post#0#0").slice(0, 32));
});

test("step mode batches a step's items (batch size) and resumes until all are answered", async () => {
  const def = wf([start(), node("Fetch", "httpRequest", { url: "=https://api.example.com/orders/{{ $json.id }}", options: {} }, { v: 4.2 })], [["Start", "Fetch"]], { allow: { http: [{ method: "GET", host: "api.example.com", pathPrefix: "/orders/" }] } });
  const trigger = Array.from({ length: 25 }, (_, i) => ({ id: `o${i}` }));
  let res = await startRun(def, { trigger, clock: CLOCK, batchSize: 10 });
  const sizes = [];
  while (res.status === "needs") {
    sizes.push(res.requests.length);
    res = await resume(JSON.parse(JSON.stringify(res.state)), await answer(res.requests));
  }
  assert.deepEqual(sizes, [10, 10, 5]);
  assert.equal(res.output.length, 25);
});

test("resume rejects unknown, extra or missing result ids and a changed definition", async () => {
  const first = await startRun(replayFlow(), { trigger: [{ id: "A1" }], clock: CLOCK, runId: "f" });
  const good = await answer(first.requests);
  await assert.rejects(resume(JSON.parse(JSON.stringify(first.state)), { ...good, "Post#0#0": { ok: true, value: {} } }), (e) => e instanceof BadInput && /not outstanding: Post#0#0/.test(e.message));
  await assert.rejects(resume(JSON.parse(JSON.stringify(first.state)), {}), (e) => e instanceof BadInput && /missing results/.test(e.message));
  await assert.rejects(resume(JSON.parse(JSON.stringify(first.state)), { "Fetch#0#0": { value: 1 } }), BadInput);
  const tampered = JSON.parse(JSON.stringify(first.state));
  tampered.definition.allow.http.push({ method: "*", host: "evil.test", pathPrefix: "/" });
  await assert.rejects(resume(tampered, good), (e) => e instanceof BadInput && /definition in the state file changed/.test(e.message));
});

// ---------- containment ----------

test("containment: a non-allowed host produced by an expression is never handed out", async () => {
  const def = wf([start(), node("Fetch", "httpRequest", { url: "={{ $json.url }}", options: {} }, { v: 4.2 })], [["Start", "Fetch"]], { allow: { http: [{ method: "GET", host: "api.example.com", pathPrefix: "/" }] } });
  let called = 0;
  const r = await run(def, { trigger: [{ url: "https://evil.test/steal?d=1" }], host: { http: async () => (called++, {}) } });
  assert.equal(r.status, "failed");
  assert.equal(r.error.name, "ContainmentViolation");
  assert.equal(called, 0);
  assert.deepEqual(r.effects, []);
  const s = await startRun(def, { trigger: [{ url: "https://api.example.com.evil.test/" }], clock: CLOCK });
  assert.equal(s.status, "failed");
  assert.equal(s.requests, undefined);
});

test("containment: tools outside the allowlist, secrets sent to other hosts, continueOnFail does not help", async () => {
  const tool = wf([start(), node("Post", "n8n-nodes-base.slack", {}, { kind: "tool", tool: { connector: "slack", name: "delete_channel", args: {} }, settings: { onError: "continueRegularOutput" } })], [["Start", "Post"]], { allow: { tools: [{ connector: "slack", tool: "send_message" }] } });
  const pf = preflight(tool);
  assert.equal(pf.ok, false);
  const secret = wf(
    [start(), node("Call", "httpRequest", { url: "={{ $json.u }}", authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth", options: {} }, { v: 4.2, auth: { credentialType: "httpHeaderAuth", secret: "Key" }, settings: { onError: "continueRegularOutput" } })],
    [["Start", "Call"]],
    { allow: { http: [{ method: "GET", host: "a.test", pathPrefix: "/" }, { method: "GET", host: "b.test", pathPrefix: "/" }] }, secrets: [{ name: "Key", credentialType: "httpHeaderAuth", hosts: ["a.test"] }] },
  );
  const ok = await run(secret, { trigger: [{ u: "https://a.test/x" }], host: { http: async () => ({ status: 200, headers: {}, body: "" }) } });
  assert.equal(ok.status, "done");
  const bad = await run(secret, { trigger: [{ u: "https://b.test/x" }], host: { http: async () => ({ status: 200, headers: {}, body: "" }) } });
  assert.equal(bad.status, "failed");
  assert.match(bad.error.message, /secret "Key" may not be sent to b.test/);
});

// ---------- preflight ----------

test("preflight fails closed: unsupported and blocked steps, missing tools, source hash", () => {
  const base = replayFlow();
  assert.deepEqual(preflight(base).issues, []);
  const missing = preflight(base, { availableTools: [{ connector: "gmail", tool: "send_message" }] });
  assert.equal(missing.ok, false);
  assert.match(missing.issues[0].message, /tool slack.send_message is not available/);
  assert.equal(preflight(base, { availableTools: ["slack.send_message"] }).ok, true);
  const unsupported = wf([start(), node("MD", "compareDatasets", {}, { v: 2.3 })], [["Start", "MD"]]);
  assert.match(preflight(unsupported).issues[0].message, /not implemented: n8n-nodes-base.compareDatasets v2.3/);
  const blocked = wf([start(), node("X", "n8n-nodes-base.n8n", {}, { kind: "blocked", blocked: { reason: "manages n8n itself" } })], [["Start", "X"]]);
  assert.match(preflight(blocked).issues[0].message, /blocked: manages n8n itself/);
  const withSource = { ...base, source: { sha256: hashHex("sha256", "export v1") } };
  assert.equal(preflight(withSource, { sourceText: "export v1" }).ok, true);
  assert.equal(preflight(withSource, { sourceText: "export v2" }).ok, false);
  assert.equal(preflight({ schemaVersion: 2, name: "x", steps: {} }).ok, false);
});

test("preflight: a blocked or unimplemented step no trigger reaches is a warning, not a refusal", async () => {
  const orphan = node("X", "n8n-nodes-base.n8n", {}, { kind: "blocked", blocked: { reason: "manages n8n itself" } });
  const def = wf([start(), node("Set", "set", { mode: "manual", assignments: { assignments: [{ name: "a", value: "1", type: "string" }] } }, { v: 3.4 }), orphan, node("MD", "compareDatasets", {}, { v: 2.3 }), node("After X", "set", {}, { v: 3.4 })], [["Start", "Set"], ["X", "After X"]]);
  const pf = preflight(def);
  assert.equal(pf.ok, true, JSON.stringify(pf.issues));
  assert.deepEqual(pf.issues.filter((i) => /never runs/.test(i.message)).map((i) => i.step).sort(), ["After X", "MD", "X"]);
  assert.match(pf.issues.find((i) => i.step === "X").message, /never runs \(no trigger reaches it\); blocked: manages n8n itself/);
  const r = await run(def);
  assert.equal(r.status, "done");
  assert.equal(r.runData.X, undefined);
  // Reached from the trigger, the same step still refuses the run.
  assert.equal(preflight(wf([start(), orphan], [["Start", "X"]])).ok, false);
  // Without a trigger every step without inputs may start a run, so none of them is skipped.
  assert.equal(preflight(wf([orphan, node("Set", "set", {}, { v: 3.4 })], [])).ok, false);
});

test("run() refuses to start when preflight fails, with every issue listed", async () => {
  const r = await run(wf([start(), node("MD", "compareDatasets", {}, { v: 2.3 })], [["Start", "MD"]]));
  assert.equal(r.status, "failed");
  assert.equal(r.error.name, "PreflightFailed");
  assert.equal(r.error.issues.length, 1);
});
