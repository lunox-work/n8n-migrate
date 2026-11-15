// Levers (evals/bench/levers.mjs, LEVERS.md): the ranking of missing converter features over the
// gallery, and the held-out guard (PROPOSALS P51): no committed levers file names a template that
// is held out now or in round 4.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { blockersOf, rankLevers, byPlanned, plannedOf, ROUND, runtimeBlockersOf, runTimeRefusals, ANSWER_KINDS } from "../evals/bench/levers.mjs";
import { readSplits, roundOf, unreadableIds } from "../evals/bench/rounds.mjs";

const BENCH = join(dirname(fileURLToPath(import.meta.url)), "..", "evals", "bench");
const lists = JSON.parse(readFileSync(join(BENCH, "eligibility.json"), "utf8"));

test("levers: blockers are keyed by node type and operation; disabled steps do not count", () => {
  const def = {
    steps: {
      Mongo: { kind: "blocked", n8n: { type: "n8n-nodes-base.mongoDb" }, blocked: { kind: "unsupported", reason: 'a database step needs "x" (open decision 1)' } },
      Off: { kind: "blocked", n8n: { type: "n8n-nodes-base.mongoDb" }, settings: { disabled: true }, blocked: { kind: "unsupported", reason: "r" } },
      Orphan: { kind: "blocked", n8n: { type: "n8n-nodes-base.s3" }, blocked: { kind: "no-tool", reason: "no request template" } },
      Set: { kind: "logic", n8n: { type: "n8n-nodes-base.set" } },
    },
  };
  const report = { steps: [{ node: "Mongo", resource: "document", operation: "insert" }] };
  const wf = { nodes: [{ name: "Orphan", type: "n8n-nodes-base.s3", parameters: { resource: "file", operation: "upload" } }] };
  assert.deepEqual(blockersOf(def, report, wf), [
    { key: "n8n-nodes-base.mongoDb document:insert", type: "n8n-nodes-base.mongoDb", op: "document:insert", kind: "unsupported", reason: 'a database step needs "…" (open decision N)' },
    { key: "n8n-nodes-base.s3 file:upload", type: "n8n-nodes-base.s3", op: "file:upload", kind: "no-tool", reason: "no request template" },
  ]);
});

test("levers: planned feature from eligibility.json, Tool variants and operations included", () => {
  assert.equal(plannedOf(lists.features, "n8n-nodes-base.mongoDb", "document:insert"), "db");
  assert.equal(plannedOf(lists.features, "n8n-nodes-base.gmailTool", "message:send"), "connector");
  assert.equal(plannedOf(lists.features, "n8n-nodes-base.removeDuplicates", "removeItemsSeenInPreviousExecutions"), "state");
  assert.equal(plannedOf(lists.features, "n8n-nodes-base.wait", "webhook"), "unplanned");
  assert.equal(plannedOf(lists.features, "n8n-nodes-base.nonexistent", ""), "unplanned");
});

test("levers: ranked by alone blocks, then total; dev unlocks counted; unnamed rows give counts only", () => {
  const meta = new Map();
  const gallery = [
    { id: 1, keys: ["A"], named: true },
    { id: 2, keys: ["A", "B"], named: true },
    { id: 3, keys: ["B", "B"], named: true },
    { id: 4, keys: ["B"], named: false },
    { id: 5, keys: ["C", "A"], named: true },
  ];
  const dev = [
    { id: 10, keys: ["A"], named: true },
    { id: 11, keys: ["A", "C"], named: false },
  ];
  const r = rankLevers(gallery, dev, meta, lists.features);
  assert.deepEqual(r.map((f) => [f.key, f.galleryAlone, f.galleryTotal, f.devUnlock, f.devTotal]), [
    ["B", 2, 3, 0, 0],
    ["A", 1, 3, 1, 2],
    ["C", 0, 1, 0, 1],
  ]);
  assert.deepEqual(r[0].ids.galleryAlone, [3]);
  assert.deepEqual(r[1].ids.devTotal, [10]);
  const g = byPlanned(gallery, dev, r);
  assert.equal(g.length, 1);
  assert.deepEqual([g[0].group, g[0].galleryUnlock, g[0].devUnlock], ["unplanned", 5, 2]);
});

// PROPOSALS P51: LEVERS.md and levers.json never name a round-4 held-out template (nor any later
// round's, nor one the current round still holds out); they give only the count skipped.
test("levers: no current or round-4 held-out id in LEVERS.md or levers.json", () => {
  const json = join(BENCH, "levers.json");
  const md = join(BENCH, "LEVERS.md");
  if (!existsSync(json)) return;
  const splits = readSplits();
  const held = new Set([...unreadableIds(splits, ROUND), ...unreadableIds(splits)].map(String));
  assert.ok(held.size >= 20);
  const doc = JSON.parse(readFileSync(json, "utf8"));
  const named = doc.features.flatMap((f) => Object.values(f.ids).flat()).map(String);
  for (const id of named) assert.ok(!held.has(id), `levers.json names held-out template ${id}`);
  for (const file of [json, md]) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/(?<![\w.\-])\d{3,6}(?![\w.\-])/g)) assert.ok(!held.has(m[0]), `${file} contains held-out id ${m[0]}`);
  }
  // Dev ids named are round-4 dev ids.
  const dev = new Set(roundOf(splits, ROUND).dev.map((r) => String(r.id)));
  for (const f of doc.features) for (const id of [...f.ids.devUnlock, ...f.ids.devTotal]) assert.ok(dev.has(String(id)), `${id} is not round-${ROUND} dev`);
  assert.equal(typeof doc.population.heldOutSkipped, "number");
});

test("levers P105: preflight refusals of unblocked steps and run-time refusals are blockers; substitutions and hosts questions are answers", () => {
  assert.ok(ANSWER_KINDS.has("substitution") && ANSWER_KINDS.has("input-incomplete"));
  const def = {
    steps: {
      Md: { kind: "logic", n8n: { type: "n8n-nodes-base.markdown", typeVersion: 1 } },
      Rss: { kind: "http", n8n: { type: "n8n-nodes-base.rssFeedRead", typeVersion: 1 } },
      Fetch: { kind: "http", n8n: { type: "n8n-nodes-base.httpRequest", typeVersion: 4.2 }, params: { url: "={{ $json.u }}" } },
      Up: { kind: "http", n8n: { type: "n8n-nodes-base.httpRequest", typeVersion: 4.2 }, params: { method: "POST", sendBody: true, contentType: "binaryData" } },
      Dl: { kind: "http", n8n: { type: "n8n-nodes-base.httpRequest", typeVersion: 4.2 }, params: { options: { response: { response: { responseFormat: "file" } } } } },
      Ex: { kind: "logic", n8n: { type: "n8n-nodes-base.html", typeVersion: 1.2 }, params: { operation: "extractHtmlContent" } },
      Tpl: { kind: "logic", n8n: { type: "n8n-nodes-base.html", typeVersion: 1.2 }, params: {} },
      Page: { kind: "tool", n8n: { type: "n8n-nodes-base.notion", typeVersion: 2.2 } },
      Mail: { kind: "blocked", n8n: { type: "n8n-nodes-base.emailSend" }, blocked: { kind: "substitution", reason: "send through Gmail" } },
    },
  };
  const issues = [
    { level: "error", step: "Md", message: "not implemented: n8n-nodes-base.markdown v1 (kind logic)" },
    { level: "error", step: "Rss", message: 'step "Rss": a request with a URL built at run time is allowed to any host (GET *); its host cannot be known' },
    { level: "error", step: "Fetch", message: 'step "Fetch": a request with a URL built at run time is allowed to any host (GET *); its host cannot be known' },
    { level: "error", step: "Page", message: "tool notion.notion-create-pages lacks required arguments: pages" },
    { level: "error", step: "Mail", message: "blocked: emailSend cannot run on Claude as it is" },
  ];
  const report = { steps: [{ node: "Page", resource: "databasePage", operation: "create" }], questions: [{ id: "1/hosts/Fetch" }] };
  const got = runtimeBlockersOf(def, report, null, issues).map((b) => [b.key, b.kind]);
  assert.deepEqual(got, [
    ["n8n-nodes-base.markdown v1", "runtime"],
    ["n8n-nodes-base.rssFeedRead (URL built at run time)", "runtime"],
    ["n8n-nodes-base.httpRequest (URL built at run time)", "input-incomplete"],
    ["n8n-nodes-base.notion databasePage:create (required arguments)", "arguments"],
    ["n8n-nodes-base.httpRequest (binary body)", "run-time"],
    ["n8n-nodes-base.httpRequest (file response)", "run-time"],
    ["n8n-nodes-base.html (extractHtmlContent)", "run-time"],
  ]);
  assert.deepEqual(runTimeRefusals({ n8n: { type: "n8n-nodes-base.httpRequest", typeVersion: 4.2 }, params: { method: "GET", sendBody: true, contentType: "binaryData" } }), []);
});
