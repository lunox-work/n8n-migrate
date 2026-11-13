// The basic converter (fromN8n) on the bench workflows, and the converted definitions run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fromN8n, urlTarget } from "../skills/n8n-to-claude/runtime/src/convert.mjs";
import { run, preflight } from "../skills/n8n-to-claude/runtime/src/api.mjs";
import { hashHex } from "../skills/n8n-to-claude/runtime/src/hash.mjs";
import { validate } from "./schema-check.mjs";
import { CLOCK } from "./runtime-helpers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WF = join(ROOT, "evals/n8n/workflows");
const nodes = JSON.parse(readFileSync(join(ROOT, "skills/n8n-to-claude/references/nodes.json"), "utf8"));
const defSchema = JSON.parse(readFileSync(join(ROOT, "skills/n8n-to-claude/references/definition.schema.json"), "utf8"));
const load = (f) => {
  const text = readFileSync(join(WF, f), "utf8");
  return { text, def: fromN8n(JSON.parse(text), { nodes, sourceText: text, file: f }) };
};
const mockHost = (fixtures) => ({
  http: async (req) => {
    const u = new URL(req.url);
    const f = fixtures[`${req.method} ${u.pathname}`] ?? fixtures[`* ${u.pathname}`] ?? { status: 404, body: "no fixture" };
    return { status: f.status ?? 200, headers: { "content-type": typeof f.body === "string" ? "text/plain" : "application/json" }, body: f.body ?? "" };
  },
});

test("every bench workflow converts to a schema-valid definition that keeps names, edges and the source hash", () => {
  for (const f of readdirSync(WF).filter((f) => /^[a-f]-[^.]+\.json$/.test(f))) {
    const { text, def } = load(f);
    assert.deepEqual(validate(def, defSchema), [], f);
    const wf = JSON.parse(text);
    assert.deepEqual(Object.keys(def.steps).sort(), wf.nodes.filter((n) => n.type !== "n8n-nodes-base.stickyNote").map((n) => n.name).sort(), f);
    assert.equal(def.source.sha256, hashHex("sha256", text));
    assert.equal(preflight(def, { sourceText: text }).issues.some((i) => /source hash/.test(i.message)), false);
  }
});

test("convert: http allowlist from literal hosts, credentials become named secrets, LLM nodes keep their kind", () => {
  const b = load("b-http-if-http.json").def;
  assert.deepEqual(b.allow.http, [{ method: "GET", host: "mock", pathPrefix: "/api/orders" }, { method: "POST", host: "mock", pathPrefix: "/api/notify" }, { method: "POST", host: "mock", pathPrefix: "/api/archive" }]);
  assert.deepEqual(b.secrets, [{ name: "Bench Token", credentialType: "httpHeaderAuth", hosts: ["mock"] }]);
  assert.deepEqual(b.steps.Notify.auth, { credentialType: "httpHeaderAuth", secret: "Bench Token" });
  assert.equal(b.steps["Open?"].kind, "branch");
  const d = load("d-llm-chain.json").def;
  assert.equal(d.steps.Summarise.kind, "model");
  assert.equal(d.steps.Claude.subnode, true);
  assert.deepEqual(d.subnodes, [{ from: "Claude", to: "Summarise", type: "ai_languageModel" }]);
  assert.match(preflight(d).issues.find((i) => i.level === "error").message, /model step without model.prompt/);
  assert.deepEqual(urlTarget("=https://api.x.com/v1/{{ $json.id }}/items"), { host: "api.x.com", pathPrefix: "/v1/" });
  assert.equal(urlTarget("={{ $json.base }}/x"), null);
  assert.equal(urlTarget("=https://{{ $json.tenant }}.x.com/"), null);
});

test("bench a (manual -> Set -> Code) runs to the expected items", async () => {
  const r = await run(load("a-manual-set-code.json").def, { clock: CLOCK });
  assert.equal(r.status, "done");
  assert.deepEqual(r.output, [{ line: "hello 1", i: 1 }, { line: "hello 2", i: 2 }, { line: "hello 3", i: 3 }]);
});

test("bench b (http -> if -> http) hands out the same effects n8n would send, in order", async () => {
  const fixtures = JSON.parse(readFileSync(join(WF, "b.mock.json"), "utf8"));
  const trigger = JSON.parse(readFileSync(join(WF, "b.trigger.json"), "utf8"));
  const r = await run(load("b-http-if-http.json").def, { trigger, clock: CLOCK, host: mockHost(fixtures) });
  assert.equal(r.status, "done");
  assert.deepEqual(
    r.effects.map((e) => [e.request.method, new URL(e.request.url).pathname, e.request.query, e.request.body ?? null]),
    [
      ["GET", "/api/orders", { since: "2026-11-10" }, null],
      ["POST", "/api/notify", {}, { orderId: 1, text: "Order 1 is open" }],
      ["POST", "/api/notify", {}, { orderId: 3, text: "Order 3 is open" }],
      ["POST", "/api/archive", {}, { orderId: 2 }],
    ],
  );
  assert.deepEqual(r.effects[1].request.auth, { credentialType: "httpHeaderAuth", secret: "Bench Token" });
});

test("bench c (schedule, webhook with Respond to Webhook) run on the clock and record the reply", async () => {
  const s = await run(load("c-schedule.json").def, { clock: { startedAt: "2026-11-14T15:00:00Z" }, host: mockHost(JSON.parse(readFileSync(join(WF, "c-schedule.mock.json"), "utf8"))) });
  assert.equal(s.status, "done");
  assert.deepEqual(s.effects[0].request.body, { text: "tick at 2026-11-14T10:00:00.000-05:00 (Saturday)", hour: "10" });
  const req = JSON.parse(readFileSync(join(WF, "c-webhook.trigger.json"), "utf8")).request;
  const w = await run(load("c-webhook.json").def, { trigger: [{ headers: req.headers, params: {}, query: req.query, body: req.body }], clock: CLOCK, host: mockHost(JSON.parse(readFileSync(join(WF, "c-webhook.mock.json"), "utf8"))) });
  assert.equal(w.status, "done");
  assert.deepEqual(w.effects[0].request.body, { customer: "c-42", total: 17.5 });
  assert.deepEqual(w.response, { body: { accepted: true, total: 17.5, ref: "ord-1001" }, headers: {}, statusCode: 200 });
});
