// Convert-time drafts (experimental, never offered: evals/bench/P137-RESULT.md; references/translation.md "Drafted request
// templates and tool maps"; bench PROPOSALS P137): the validator's rules (each with a refusing
// case), the overrides.json `drafts` format as the converter applies it, the write block, the
// drafting pass with a stand-in model, and the bench's --arm switch (arm B+approved's default
// approval and its secondary-bar outcomes, P137 amendment 2). Synthetic workflows only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { convertItems, writeFolder, loadReferences, convertFolder, applyOverrides, regenerate } from "../skills/n8n-to-claude/scripts/convert.mjs";
import { loadInput } from "../skills/n8n-to-claude/scripts/analyze.mjs";
import { draftTarget, validateDraft, checkAllowDiff, compileUrl, compileReply, draftEffect, WRITE_BLOCK_REASON, writeApproval, draftFor } from "../skills/n8n-to-claude/scripts/drafts.mjs";
import { draftFolder, draftableSteps, draftPrompt, syntheticItems } from "../skills/n8n-to-claude/scripts/draft.mjs";
import { validate } from "./schema-check.mjs";

const refs = loadReferences();
const NOW = Date.parse("2026-11-16T00:00:00Z");
const AIR = { airtableTokenApi: { id: "1", name: "Airtable account" } };
const rl = (value) => ({ __rl: true, value, mode: "id" });

const WF = {
  id: "wfdrafts",
  name: "Drafts test",
  nodes: [
    { id: "a", name: "Every hour", type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.2, position: [0, 0], parameters: { rule: { interval: [{ field: "hours" }] } } },
    { id: "b", name: "Get record", type: "n8n-nodes-base.airtable", typeVersion: 2.1, position: [200, 0], parameters: { resource: "record", operation: "get", base: rl("appAbc123"), table: rl("tblXyz789"), id: "={{ $json.recordId }}", options: {} }, credentials: AIR },
    { id: "c", name: "Create record", type: "n8n-nodes-base.airtable", typeVersion: 2.1, position: [400, 0], parameters: { resource: "record", operation: "create", base: rl("appAbc123"), table: rl("tblXyz789"), columns: { mappingMode: "defineBelow", value: { Name: "={{ $('Get record').item.json.fields.Name }}" } }, options: {} }, credentials: AIR },
    { id: "d", name: "Read blocks", type: "n8n-nodes-base.notion", typeVersion: 2.2, position: [600, 0], parameters: { resource: "block", operation: "getAll", blockId: { __rl: true, value: "abc123def456", mode: "id" }, returnAll: true }, credentials: { notionApi: { id: "2", name: "Notion account" } } },
  ],
  connections: {
    "Every hour": { main: [[{ node: "Get record", type: "main", index: 0 }]] },
    "Get record": { main: [[{ node: "Create record", type: "main", index: 0 }]] },
    "Create record": { main: [[{ node: "Read blocks", type: "main", index: 0 }]] },
  },
  settings: {},
};

function folderOf(wf = WF) {
  const dir = mkdtempSync(join(tmpdir(), "n8m-drafts-"));
  const file = join(dir, "wf.json");
  writeFileSync(file, JSON.stringify(wf));
  const [res] = convertItems(loadInput(file).items, { refs, now: NOW });
  return { dir, folder: writeFolder(join(dir, "out"), res, { refs }) };
}
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const targets = (folder) => Object.fromEntries(draftableSteps(folder, refs).map((d) => [d.name, d]));

const GOOD = {
  "Get record": { kind: "rest-template", docs: "https://airtable.com/developers/web/api/get-record", entry: { http: { method: "GET", url: compileUrl("https://api.airtable.com/v0/{base}/{table}/{id}") }, credentialType: "airtableTokenApi", effect: "read", result: {}, fidelity: "unverified" } },
  "Create record": { kind: "rest-template", docs: "https://airtable.com/developers/web/api/create-records", entry: { http: { method: "POST", url: compileUrl("https://api.airtable.com/v0/{base}/{table}"), body: { fields: "columns.value" } }, credentialType: "airtableTokenApi", effect: "write", result: {}, fidelity: "unverified" } },
  "Read blocks": { kind: "tool-map", docs: "https://developers.notion.com/reference/get-block-children", entry: { connector: "notion", tool: "notion-fetch", args: { id: "blockId" }, effect: "read", result: {}, fidelity: "unverified" } },
};
const clone = (x) => JSON.parse(JSON.stringify(x));
const mutate = (name, fn) => {
  const d = clone(GOOD[name]);
  fn(d);
  return d;
};

test("draft targets: the two block kinds, hosts from the credential type, the operation's effect", () => {
  const { dir, folder } = folderOf();
  const t = targets(folder);
  assert.equal(t["Get record"].target.kind, "rest-template");
  assert.deepEqual(t["Get record"].target.hosts, ["api.airtable.com"]);
  assert.equal(t["Get record"].target.effect, "read");
  assert.equal(t["Create record"].target.effect, "write");
  assert.equal(t["Read blocks"].target.kind, "tool-map");
  assert.equal(t["Read blocks"].target.connector, "notion");
  // A node that names no host (no credential with a known host, no URL parameter) gets no draft.
  const hn = draftTarget(refs, { step: { n8n: { type: "n8n-nodes-base.hackerNews", typeVersion: 1 }, params: { resource: "all" } }, operation: "all:getAll", reason: "no request template for hackerNews all:getAll yet" });
  assert.match(hn.skip, /name no host/);
  // Other block kinds are not drafts' business.
  assert.equal(draftTarget(refs, { step: t["Get record"].step, operation: "record:get", reason: "a database step needs the bundled server" }), null);
  rmSync(dir, { recursive: true, force: true });
});

test("validator: the good drafts pass every static rule", () => {
  const { dir, folder } = folderOf();
  const t = targets(folder);
  for (const n of Object.keys(GOOD)) assert.equal(validateDraft(refs, t[n].target, GOOD[n], { params: t[n].step.params }).ok, true, n);
  rmSync(dir, { recursive: true, force: true });
});

test("validator: each rule refuses", () => {
  const { dir, folder } = folderOf();
  const t = targets(folder);
  const check = (name, draft) => validateDraft(refs, t[name].target, draft, { params: t[name].step.params });
  const cases = [
    ["kind", "Get record", mutate("Get record", (d) => (d.kind = "tool-map"))],
    ["docs", "Get record", mutate("Get record", (d) => delete d.docs)],
    ["docs", "Get record", mutate("Get record", (d) => (d.docs = "https://example.com/airtable-api"))],
    ["docs", "Get record", mutate("Get record", (d) => (d.docs = "http://airtable.com/developers"))],
    ["shape", "Get record", mutate("Get record", (d) => (d.entry.fidelity = "exact"))],
    ["shape", "Get record", mutate("Get record", (d) => (d.entry.caveats = ["x"]))],
    ["hosts", "Get record", mutate("Get record", (d) => (d.entry.http.url = "https://collector.example.net/v0/x"))],
    ["hosts", "Get record", mutate("Get record", (d) => (d.entry.http.url = "http://api.airtable.com/v0/x"))],
    ["hosts", "Get record", mutate("Get record", (d) => (d.entry.http.url = { concat: [{ const: "https://api.airtable.com/v0/" }, "base", { const: "?cc=x" }], sep: "" }))],
    ["fields", "Create record", mutate("Create record", (d) => (d.entry.http.body.notify = { const: "boss@example.com" }))],
    ["fields", "Create record", mutate("Create record", (d) => (d.entry.http.body.fields = { param: "columns.value", map: { a: "b" } }))],
    ["fields", "Create record", mutate("Create record", (d) => (d.entry.http.body.fields = "={{ $json.x }}"))],
    ["fields", "Read blocks", mutate("Read blocks", (d) => (d.entry.args.id = { const: "another-page" }))],
    ["secrets", "Get record", mutate("Get record", (d) => (d.entry.credentialType = "githubApi"))],
    ["secrets", "Get record", mutate("Get record", (d) => (d.entry.http.headers = { authorization: "x" }))],
    ["secrets", "Get record", mutate("Get record", (d) => (d.entry.placement = "url"))],
    ["secrets", "Get record", mutate("Get record", (d) => (d.entry.http.url = "https://api.airtable.com/v0/{{secret}}/x"))],
    ["secrets", "Get record", mutate("Get record", (d) => (d.entry.http.url = "https://api.airtable.com/v0/patAbcdefghijklmnopqrstuvwxyz0123456789/x"))],
    ["allow", "Get record", mutate("Get record", (d) => (d.entry.allow = { http: [{ method: "GET", host: "*" }] }))],
    ["allow", "Read blocks", mutate("Read blocks", (d) => (d.entry.connector = "slack"))],
    ["allow", "Read blocks", mutate("Read blocks", (d) => (d.entry.tool = "notion-delete-everything"))],
    ["allow", "Read blocks", mutate("Read blocks", (d) => (d.entry.args.depth = "returnAll"))],
    ["allow", "Read blocks", mutate("Read blocks", (d) => delete d.entry.args.id)],
    ["effect", "Create record", mutate("Create record", (d) => (d.entry.effect = "read"))],
    ["effect", "Get record", mutate("Get record", (d) => (d.entry.effect = "maybe"))],
  ];
  for (const [rule, name, draft] of cases) {
    const r = check(name, draft);
    assert.equal(r.ok, false, `${rule}: ${JSON.stringify(draft.entry).slice(0, 120)}`);
    assert.equal(r.rule, rule, `${rule} expected, got ${r.rule}: ${r.reason}`);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("validator: lists in a body and keys with spaces pass; a list element is checked like any value", () => {
  const { dir, folder } = folderOf();
  const t = targets(folder);
  const check = (draft) => validateDraft(refs, t["Create record"].target, draft, { params: t["Create record"].step.params });
  const list = mutate("Create record", (d) => (d.entry.http.body = { records: [{ fields: { "Full Name": "columns.value.Full Name" } }], typecast: { const: true } }));
  assert.equal(check(list).ok, true, check(list).reason);
  const bad = mutate("Create record", (d) => (d.entry.http.body = { records: [{ fields: "columns.value" }, { const: "extra@example.com" }] }));
  assert.equal(check(bad).rule, "fields");
  const expr = mutate("Create record", (d) => (d.entry.http.body = { fields: "{{ $json.x }}" }));
  assert.equal(check(expr).rule, "fields");
  rmSync(dir, { recursive: true, force: true });
});

test("a list body reaches the request as written (try-step)", async () => {
  const { tryDefinition } = await import("../skills/n8n-to-claude/scripts/try-step.mjs");
  const { dir, folder } = folderOf();
  const t = targets(folder);
  const ov = readJson(join(folder, "overrides.json"));
  ov.approve = [writeApproval("Create record")];
  ov.drafts = { "Create record": { ...mutate("Create record", (d) => (d.entry.http.body = { records: [{ fields: "columns.value" }] })), for: draftFor(t["Create record"].target), status: "accepted" } };
  writeFileSync(join(folder, "overrides.json"), JSON.stringify(ov));
  regenerate(folder, { refs, now: NOW });
  const def = readJson(join(folder, "definition.json"));
  const r = await tryDefinition(def, "Create record", { items: [{ fields: { Name: "Ada" } }], upstream: ["Get record"] });
  assert.equal(r.status, "done", JSON.stringify(r.error));
  assert.deepEqual(r.requests[0].body, { records: [{ fields: { Name: "Ada" } }] });
  assert.equal(r.requests[0].url, "https://api.airtable.com/v0/appAbc123/tblXyz789");
  rmSync(dir, { recursive: true, force: true });
});

test("allow diff: a drafted definition allows only the step's own request", () => {
  const target = { hosts: ["api.airtable.com"], connector: "notion" };
  const base = { allow: { tools: [], http: [], sql: [] }, secrets: [{ name: "A", hosts: [] }] };
  const ok = { allow: { tools: [{ connector: "notion", tool: "notion-fetch" }], http: [{ method: "GET", host: "api.airtable.com", pathPrefix: "/v0/" }], sql: [] }, secrets: [{ name: "A", hosts: ["api.airtable.com"] }] };
  assert.equal(checkAllowDiff(base, ok, { s: target }), null);
  const bad = [
    { ...ok, allow: { ...ok.allow, http: [{ method: "GET", host: "evil.example.net" }] } },
    { ...ok, allow: { ...ok.allow, http: [{ method: "GET", host: "*", scope: "public", step: "s" }] } },
    { ...ok, allow: { ...ok.allow, tools: [{ connector: "gmail", tool: "send_message" }] } },
    { ...ok, allow: { ...ok.allow, db: [{ engine: "postgres", host: "h", port: 5432, database: "d" }] } },
    { ...ok, secrets: [{ name: "A", hosts: ["api.airtable.com", "evil.example.net"] }] },
  ];
  for (const d of bad) assert.equal(checkAllowDiff(base, d, { s: target })?.rule, "allow", JSON.stringify(d).slice(0, 160));
});

test("compile: URL templates and the model's reply", () => {
  assert.equal(compileUrl("https://api.airtable.com/v0/meta"), "https://api.airtable.com/v0/meta");
  assert.deepEqual(compileUrl("https://api.airtable.com/v0/{base}/{table}"), { concat: [{ const: "https://api.airtable.com/v0/" }, "base", { const: "/" }, "table"], sep: "" });
  assert.equal(compileUrl("https://api.telegram.org/bot{{secret}}/getMe"), "https://api.telegram.org/bot{{secret}}/getMe");
  const target = { kind: "rest-template", credentialTypes: ["airtableTokenApi"], credentialType: "airtableTokenApi", hosts: ["api.airtable.com"] };
  const { draft } = compileReply(target, { docs: "https://airtable.com/x", method: "get", url: "https://api.airtable.com/v0/{base}", effect: "read", fidelity: "exact", understood: ["everything"], headers: { a: 1 } });
  assert.equal(draft.entry.http.method, "GET");
  assert.equal(draft.entry.fidelity, "unverified");
  assert.equal(draft.entry.understood, undefined);
  assert.equal(draft.entry.http.headers, undefined);
  assert.deepEqual(compileReply(target, { decline: "needs two requests" }), { decline: "needs two requests" });
});

test("overrides format: accepted read built and flagged, write blocked, rejected and stale blocked, rules re-checked", () => {
  const { dir, folder } = folderOf();
  const t = targets(folder);
  const ov = readJson(join(folder, "overrides.json"));
  const stamp = (n) => ({ for: draftFor(t[n].target), status: "accepted" });
  ov.drafts = {
    "Get record": { ...GOOD["Get record"], ...stamp("Get record") },
    "Create record": { ...GOOD["Create record"], ...stamp("Create record") },
    // Hand-edited after acceptance to send to another host: the converter re-checks and refuses.
    "Read blocks": { ...mutate("Read blocks", (d) => (d.entry.connector = "slack")), ...stamp("Read blocks") },
  };
  writeFileSync(join(folder, "overrides.json"), JSON.stringify(ov));
  regenerate(folder, { refs, now: NOW });
  const def = readJson(join(folder, "definition.json"));
  assert.deepEqual(validate(def, refs.schema), []);
  const get = def.steps["Get record"];
  assert.equal(get.kind, "http");
  assert.equal(get.draft.status, "accepted");
  assert.equal(get.review, true);
  assert.ok(get.reviewReasons.some((r) => /drafted at convert time/.test(r)));
  assert.ok(def.allow.http.some((a) => a.host === "api.airtable.com" && a.method === "GET"));
  const create = def.steps["Create record"];
  assert.equal(create.kind, "blocked");
  assert.equal(create.blocked.kind, "drafted-write");
  assert.equal(create.blocked.reason, WRITE_BLOCK_REASON);
  assert.ok(!def.allow.http.some((a) => a.method === "POST"), "a blocked drafted write adds nothing to allow");
  const blocks = def.steps["Read blocks"];
  assert.equal(blocks.kind, "blocked");
  assert.equal(blocks.draft.status, "rejected");
  assert.match(blocks.blocked.reason, /^no tool map for notion block:getAll yet; the drafted tool-map was rejected: connector slack/);
  const md = readFileSync(join(folder, "MIGRATION.md"), "utf8");
  assert.match(md, /## Drafted at convert time/);
  assert.match(md, /\*\*Get record\*\*: rest-template, docs https:\/\/airtable\.com\/developers\/web\/api\/get-record: in use, flagged for review/);
  assert.match(md, /\*\*Create record\*\*: .*drafted write: needs a dry run against the real service and the person's approval/);

  // The person's approval unblocks the write (after a dry run against the real service); a
  // person's `reviewed` clears the review flag and the MIGRATION.md listing; a stale `for` is
  // not applied; a rejected draft keeps the step blocked with its reason.
  ov.approve = [writeApproval("Create record")];
  ov.drafts["Get record"].reviewed = "the person, 2026-11-17";
  ov.drafts["Read blocks"] = { ...GOOD["Read blocks"], ...stamp("Read blocks"), for: { ...draftFor(t["Read blocks"].target), operation: "block:append" } };
  writeFileSync(join(folder, "overrides.json"), JSON.stringify(ov));
  regenerate(folder, { refs, now: NOW });
  const def2 = readJson(join(folder, "definition.json"));
  assert.equal(def2.steps["Create record"].kind, "http");
  assert.ok(def2.allow.http.some((a) => a.method === "POST" && a.host === "api.airtable.com"));
  assert.equal(def2.steps["Get record"].draft.status, "reviewed");
  assert.ok(!(def2.steps["Get record"].reviewReasons ?? []).some((r) => /drafted at convert time/.test(r)));
  assert.equal(def2.steps["Read blocks"].draft.status, "stale");
  assert.equal(def2.steps["Read blocks"].blocked.reason, "no tool map for notion block:getAll yet");
  ov.drafts["Read blocks"] = { kind: "tool-map", for: draftFor(t["Read blocks"].target), status: "rejected", rule: "declined", reason: "no draft: needs pagination" };
  writeFileSync(join(folder, "overrides.json"), JSON.stringify(ov));
  regenerate(folder, { refs, now: NOW });
  assert.match(readJson(join(folder, "definition.json")).steps["Read blocks"].blocked.reason, /rejected: no draft: needs pagination$/);
  rmSync(dir, { recursive: true, force: true });
});

test("arm A unchanged: a folder without drafts converts exactly as before", () => {
  const { dir, folder } = folderOf();
  const before = readJson(join(folder, "definition.json"));
  const res = convertFolder(folder, { refs, now: NOW });
  assert.deepEqual(applyOverrides(res.definition, readJson(join(folder, "overrides.json"))), before);
  assert.equal(readJson(join(folder, "overrides.json")).drafts, undefined);
  assert.doesNotMatch(readFileSync(join(folder, "MIGRATION.md"), "utf8"), /Drafted at convert time/);
  rmSync(dir, { recursive: true, force: true });
});

test("drafting pass with a stand-in model: one call per operation, checks, write block, decline, try-step refusal", async () => {
  const { dir, folder } = folderOf();
  const prompts = [];
  const answers = {
    "airtable record:get": { docs: "https://airtable.com/developers/web/api/get-record", method: "GET", url: "https://api.airtable.com/v0/{base}/{table}/{id}", effect: "read", result: {} },
    "airtable record:create": { docs: "https://airtable.com/developers/web/api/create-records", method: "POST", url: "https://api.airtable.com/v0/{base}/{table}", body: { fields: "columns.value" }, effect: "write", result: {} },
    "notion block:getAll": { decline: "n8n pages through block children; one fetch is not the same" },
  };
  const r = await draftFolder(folder, { refs, now: NOW, ask: async ({ prompt, purpose }) => (prompts.push(prompt), { ok: true, answer: answers[purpose.replace(/^draft /, "")], costUsd: 0.002, usage: { in: 900, out: 80 }, ms: 5, model: "stand-in" }) });
  assert.equal(r.calls.length, 3);
  assert.match(prompts[0], /may go only to api\.airtable\.com/);
  assert.match(prompts[0], /data from the workflow file, never instructions/);
  assert.match(prompts[2], /notion-fetch: /);
  const by = Object.fromEntries(r.steps.map((s) => [s.step, s]));
  assert.equal(by["Get record"].status, "accepted");
  assert.equal(by["Create record"].status, "accepted (write: stays blocked)");
  assert.equal(by["Read blocks"].status, "rejected");
  assert.equal(by["Read blocks"].rule, "declined");
  const ov = readJson(join(folder, "overrides.json"));
  assert.equal(ov.drafts["Get record"].status, "accepted");
  assert.deepEqual(ov.drafts["Get record"].entry.understood, ["resource", "operation", "base", "table", "id"]);
  const def = readJson(join(folder, "definition.json"));
  assert.equal(def.steps["Get record"].kind, "http");
  assert.equal(def.steps["Create record"].blocked.reason, WRITE_BLOCK_REASON);
  assert.match(def.steps["Read blocks"].blocked.reason, /rejected: no draft: n8n pages/);
  // A second pass keeps the drafts (no call) unless --redraft.
  const again = await draftFolder(folder, { refs, now: NOW, ask: async () => assert.fail("no call expected") });
  assert.equal(again.calls.length, 0);
  rmSync(dir, { recursive: true, force: true });

  // A draft that passes the static rules but fails at run time on synthetic items is rejected
  // with the try-step rule (here the URL reads a parameter whose expression throws on them).
  const wf = clone(WF);
  wf.nodes[1].parameters.id = "={{ $json.recordId.toFixed(2) }}";
  const f2 = folderOf(wf);
  const r2 = await draftFolder(f2.folder, { refs, now: NOW, ask: async ({ purpose }) => ({ ok: true, answer: answers[purpose.replace(/^draft /, "")] ?? { decline: "no" }, ms: 1 }) });
  const get2 = r2.steps.find((s) => s.step === "Get record");
  assert.equal(get2.status, "rejected");
  assert.equal(get2.rule, "try-step");
  assert.equal(readJson(join(f2.folder, "definition.json")).steps["Get record"].kind, "blocked");
  rmSync(f2.dir, { recursive: true, force: true });
});

test("drafting checks do not fail on another step's open hosts question", async () => {
  const wf = clone(WF);
  wf.nodes.push({ id: "e", name: "Fetch page", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [800, 0], parameters: { url: "={{ $json.url }}", options: {} } });
  wf.connections["Read blocks"] = { main: [[{ node: "Fetch page", type: "main", index: 0 }]] };
  const { dir, folder } = folderOf(wf);
  assert.ok(readJson(join(folder, "definition.json")).allow.http.some((a) => a.host === "*"));
  const r = await draftFolder(folder, { refs, now: NOW, ask: async ({ purpose }) => ({ ok: true, answer: /record:get/.test(purpose) ? { docs: "https://airtable.com/developers/web/api/get-record", method: "GET", url: "https://api.airtable.com/v0/{base}/{table}/{id}", effect: "read", result: {} } : { decline: "no" } }) });
  assert.equal(r.steps.find((x) => x.step === "Get record").status, "accepted");
  rmSync(dir, { recursive: true, force: true });
});

test("synthetic items cover the fields the step's expressions read, upstream nodes included", () => {
  const items = syntheticItems({ a: "={{ $json.email }}", b: "={{ $('Form').item.json['full name'] }}" });
  assert.equal(items.length, 3);
  assert.deepEqual(Object.keys(items[0][0]).sort(), ["email", "full name"]);
  assert.equal(items[1][0].email, "");
});

test("draft effect: a write method or a write operation counts as a write", () => {
  const read = { effect: "read" };
  assert.equal(draftEffect(read, { entry: { effect: "read", http: { method: "GET" } } }), "read");
  assert.equal(draftEffect(read, { entry: { effect: "read", http: { method: "POST" } } }), "write");
  assert.equal(draftEffect({ effect: "write" }, { entry: { effect: "read", http: { method: "GET" } } }), "write");
  assert.equal(draftEffect(read, { entry: { effect: "read", tool: "x" } }), "read");
});

test("bench --arm: plain by default, drafts accepted, anything else refused; draftArm records calls and tokens", async () => {
  const { parseArgs, ARMS } = await import("../evals/bench/run.mjs");
  assert.deepEqual(ARMS, ["plain", "drafts", "drafts-approved"]);
  assert.equal(parseArgs(["123"]).arm, "plain");
  assert.equal(parseArgs(["123", "--arm", "drafts"]).arm, "drafts");
  assert.equal(parseArgs(["123", "--arm", "drafts-approved", "--drafts-from", "b1"]).draftsFrom, "b1");
  assert.throws(() => parseArgs(["123", "--arm", "skill"]), /--arm skill: one of plain, drafts, drafts-approved/);
  assert.throws(() => parseArgs(["123", "--arm", "drafts", "--drafts-from", "b1"]), /--drafts-from is for --arm drafts-approved only/);
  const { draftArm } = await import("../evals/bench/claude-side.mjs");
  const { dir, folder } = folderOf();
  const purposes = [];
  const claude = async ({ purpose, model, args }) => {
    purposes.push(purpose);
    assert.equal(model, "haiku");
    assert.ok(args.includes("--tools") && args.includes("--json-schema"));
    const answer = /record:get/.test(purpose) ? { docs: "https://airtable.com/developers/web/api/get-record", method: "GET", url: "https://api.airtable.com/v0/{base}/{table}/{id}", effect: "read", result: {} } : { decline: "not drafted in this test" };
    return { json: { structured_output: answer }, text: "", costUsd: 0.0015, usage: { in: 1000, out: 100, cacheRead: 0, cacheWrite: 0 }, ms: 3 };
  };
  const s = await draftArm(4242, folder, { claude, log: () => {} });
  assert.equal(s.callCount, 3);
  assert.ok(purposes.every((p) => / 4242$/.test(p)));
  assert.equal(s.costUsd, 0.0045);
  assert.deepEqual(s.tokens, { in: 3000, out: 300, cacheRead: 0, cacheWrite: 0 });
  assert.equal(s.steps.find((x) => x.step === "Get record").status, "accepted");
  assert.equal(readJson(join(folder, "definition.json")).steps["Get record"].kind, "http");
  rmSync(dir, { recursive: true, force: true });
});

test("arm B+approved (P137 amendment 2): the bench approves only accepted drafted writes; arm B keeps them blocked; drafts reused from arm B", async () => {
  const { approveDraftedWrites, reuseDrafts } = await import("../evals/bench/claude-side.mjs");
  const answers = {
    "airtable record:get": { docs: "https://airtable.com/developers/web/api/get-record", method: "GET", url: "https://api.airtable.com/v0/{base}/{table}/{id}", effect: "read", result: {} },
    "airtable record:create": { docs: "https://airtable.com/developers/web/api/create-records", method: "POST", url: "https://api.airtable.com/v0/{base}/{table}", body: { fields: "columns.value" }, effect: "write", result: {} },
    "notion block:getAll": { decline: "pages through children" },
  };
  const ask = async ({ purpose }) => ({ ok: true, answer: answers[purpose.replace(/^draft /, "")], ms: 1 });
  // Arm B: the drafted write stays blocked; nothing approves it.
  const b = folderOf();
  await draftFolder(b.folder, { refs, now: NOW, ask });
  assert.equal(readJson(join(b.folder, "definition.json")).steps["Create record"].blocked.kind, "drafted-write");
  // Arm B+approved: the same drafts, then the bench's default answer for each drafted write.
  const a = folderOf();
  const reused = reuseDrafts({ drafts: { steps: [{ step: "Create record", status: "accepted (write: stays blocked)" }] }, folder: b.folder }, a.folder, "armB-tag");
  assert.equal(reused.from, "armB-tag");
  assert.equal(reused.callCount, 0);
  assert.equal(reused.regenerate, 0);
  assert.equal(readJson(join(a.folder, "definition.json")).steps["Create record"].blocked.kind, "drafted-write");
  const r = await approveDraftedWrites(a.folder);
  assert.deepEqual(r.steps, ["Create record"]);
  assert.equal(r.status, 0);
  const def = readJson(join(a.folder, "definition.json"));
  assert.equal(def.steps["Create record"].kind, "http");
  assert.ok(def.allow.http.some((x) => x.method === "POST" && x.host === "api.airtable.com"));
  assert.deepEqual(readJson(join(a.folder, "overrides.json")).approve, [writeApproval("Create record")]);
  // A rejected draft is never approved: its step stays blocked with the rule's reason.
  assert.equal(def.steps["Read blocks"].kind, "blocked");
  assert.notEqual(def.steps["Read blocks"].blocked.kind, "drafted-write");
  // Nothing left to approve: no change, no regenerate.
  assert.deepEqual(await approveDraftedWrites(a.folder), { steps: [], status: null });
  rmSync(a.dir, { recursive: true, force: true });
  rmSync(b.dir, { recursive: true, force: true });
});

test("P137 amendment 2: drafted-write outcomes and the secondary bar", async () => {
  const { draftedWriteOutcomes, secondaryBar, wrongEffectFailure, SECONDARY_BAR } = await import("../evals/bench/gates.mjs");
  const w = (step, key, extra = {}) => ({ service: "api.airtable.com", action: "POST /v0/:id/:id", target: key, effect: "write", step, ...extra });
  const cmp = {
    writes: {
      matched: ["api.airtable.com.POST /v0/:id/:id:/a", "api.airtable.com.POST /v0/:id/:id:/b"],
      missing: [],
      extra: [{ key: "api.airtable.com.POST /v0/:id/:id:/c" }, { key: "api.airtable.com.POST /v0/:id/:id:/u", unmapped: true }],
      fieldDiffs: [{ effect: "api.airtable.com.POST /v0/:id/:id:/b", diffs: [{ field: "body" }] }],
    },
  };
  const effects = [w("Same", "/a"), w("Diff", "/b"), w("Extra", "/c"), w("Uncompared", "/u", { unmapped: true }), { ...w("Other", "/a"), effect: "read" }];
  const out = Object.fromEntries(draftedWriteOutcomes(["Same", "Diff", "Extra", "Uncompared", "Idle"], { claudeEffects: effects, cmp }).map((o) => [o.step, o]));
  assert.equal(out.Same.outcome, "same effect");
  assert.equal(out.Diff.outcome, "wrong effect");
  assert.match(out.Diff.why, /different fields in .*: body/);
  assert.equal(out.Extra.outcome, "wrong effect");
  assert.match(out.Extra.why, /a write n8n did not make/);
  assert.equal(out.Uncompared.outcome, "uncompared");
  assert.equal(out.Idle.outcome, "not exercised");
  const missing = draftedWriteOutcomes(["Idle"], { claudeEffects: [], cmp: { writes: { matched: [], missing: [{ key: "x.y:z" }], extra: [], fieldDiffs: [] } } });
  assert.equal(missing[0].outcome, "wrong effect");
  assert.match(missing[0].why, /made no write while n8n made writes the Claude side lacks: x\.y:z/);
  assert.deepEqual(draftedWriteOutcomes(["S"], { stopped: { gate: 3, cause: "unmapped node" } })[0], { step: "S", outcome: "not reached", why: "the template stopped at gate 3: unmapped node" });

  assert.equal(wrongEffectFailure({ gate: 4, cause: "different fields" }), true);
  assert.equal(wrongEffectFailure({ gate: 4, cause: "1 replayed model call(s) got a different input" }), false);
  assert.equal(wrongEffectFailure({ gate: 5, cause: "different fields" }), false);

  assert.deepEqual(SECONDARY_BAR, { share: 0.8, min: 5 });
  const row = (template, outcomes, extra = {}) => ({ template, passedAll: false, gate: 3, draftedWrites: outcomes.map((o, i) => ({ step: `s${i}`, outcome: o })), gates: {}, ...extra });
  const few = secondaryBar([row(1, ["same effect", "same effect"]), row(2, ["not reached"])]);
  assert.equal(few.reachedGate4, 2);
  assert.equal(few.verdict, "too few drafted writes reached gate 4 to say");
  const good = secondaryBar([row(1, ["same effect", "same effect", "same effect"], { passedAll: true, gate: null, gates: { 6: { pass: true } } }), row(2, ["same effect", "wrong effect", "not exercised"], { gate: 4, cause: "different fields" })]);
  assert.equal(good.reachedGate4, 5);
  assert.equal(good.share, 80);
  assert.equal(good.passes, 1);
  assert.deepEqual(good.gate4WrongEffect, [2]);
  assert.equal(good.verdict, "reliable enough to offer behind approval");
  const g6 = secondaryBar([row(1, ["same effect", "same effect", "same effect", "same effect", "same effect"], { gate: 6, gates: { 6: { pass: false } } })]);
  assert.deepEqual(g6.gate6Failures, [1]);
  assert.equal(g6.verdict, "not reliable enough");
  const low = secondaryBar([row(1, ["same effect", "same effect", "same effect", "wrong effect", "uncompared"])]);
  assert.equal(low.share, 60);
  assert.equal(low.verdict, "not reliable enough");
});

test("credentialHosts from n8n 2.47.7's credential definitions: fixed or field-default hosts give a target; field-only hosts stay skipped", () => {
  const ch = refs.toolMaps.credentialHosts;
  for (const [type, hosts] of Object.entries(ch)) {
    if (type === "$doc") continue;
    assert.ok(Array.isArray(hosts), type);
    for (const h of hosts) assert.match(h, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, `${type}: ${h} is a bare host name`);
  }
  const target = (type, credentials, operation, params = {}) => draftTarget(refs, { step: { n8n: { type, typeVersion: 1 }, params, credentials }, operation, reason: `no request template for ${type.split(".").pop()} ${operation} yet` });
  // Dropbox: test baseURL api.dropboxapi.com, uploads on content.dropboxapi.com (the node's transport).
  const dbx = target("n8n-nodes-base.dropbox", { dropboxApi: { id: "1", name: "Dropbox" } }, "file:upload");
  assert.equal(dbx.kind, "rest-template");
  assert.deepEqual(dbx.hosts, ["api.dropboxapi.com", "content.dropboxapi.com"]);
  // YouTube (OAuth2, no base URL in the definition): the node's fixed host.
  assert.deepEqual(target("n8n-nodes-base.youTube", { youTubeOAuth2Api: { id: "2", name: "YouTube" } }, "video:update").hosts, ["www.googleapis.com"]);
  // Microsoft Graph: microsoftOAuth2Api's graphApiBaseUrl default.
  assert.deepEqual(target("n8n-nodes-base.microsoftExcel", { microsoftExcelOAuth2Api: { id: "3", name: "Excel" } }, "worksheet:append").hosts, ["graph.microsoft.com"]);
  // A host only the person's own credential field holds (NocoDB's host, no default): still no draft.
  assert.match(target("n8n-nodes-base.nocoDb", { nocoDbApiToken: { id: "4", name: "NocoDB" } }, "row:create").skip, /name no host/);
  assert.equal(ch.nocoDbApiToken, undefined);
  assert.equal(ch.aws, undefined);
  assert.equal(ch.s3, undefined);
});
