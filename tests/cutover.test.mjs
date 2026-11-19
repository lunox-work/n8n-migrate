// Cutover (PLAN Phase 7, references/cutover.md): the second-resolution cursor, n8n's poll static
// data mapped to and from it, the task driver's dry run and cutover gate, and the cutover CLI
// against a fake n8n public API over HTTP. No model is called; the live check is
// evals/cutover/e2e.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { convertItems, writeFolder, loadReferences } from "../skills/n8n-migrate/scripts/convert.mjs";
import { loadInput } from "../skills/n8n-migrate/scripts/analyze.mjs";
import { runStep } from "../skills/n8n-migrate/scripts/cutover.mjs";
import { cursorsFromStaticData, staticDataFromCursors, cursorsFromExecutions, laterCursors, createN8nClient } from "../skills/n8n-migrate/scripts/n8n-api.mjs";
import { advanceCursor } from "../skills/n8n-migrate/runtime/src/adapt.mjs";
import * as core from "../skills/n8n-migrate/runtime/src/index.mjs";
import { command } from "../skills/n8n-migrate/runtime/src/driver.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const refs = loadReferences();
const NOW = Date.parse("2026-11-14T00:00:00Z");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const POLL = "New invoice email";
process.env.N8M_SECRET_ACCOUNTS_API_KEY = "test-secret"; // a local task's secret source (env)

function folderFor(file, { task = {}, mutate } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "n8m-cut-"));
  const items = loadInput(join(ROOT, file)).items;
  if (mutate) mutate(items);
  const results = convertItems(items, { refs, now: NOW });
  const folders = results.map((res) => writeFolder(dir, res, { refs }));
  for (const folder of folders) writeFileSync(join(folder, "task.json"), JSON.stringify({ ...readJson(join(folder, "task.json")), hooks: false, secrets: "env", ...task }));
  return { dir, folder: folders[0], folders };
}

// A scripted session with hooks off: it makes the tool call the runner prints and saves the
// response with `result`. mail() is the mailbox; http POSTs land in `posts`.
function session(folder, mail) {
  const posts = [];
  const calls = [];
  const fetch = async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body) });
    return new Response('{"id":"inv"}', { status: 201, headers: { "content-type": "application/json" } });
  };
  const cmd = (c, pos = [], flags = {}) => command(c, pos, flags, { core, dir: folder, cwd: folder, stdin: () => "", fetch });
  async function until(text) {
    for (let i = 0; i < 60; i++) {
      const m = /^NEXT: call one tool \(request (\w+)[^\n]*\nTool: (\S+)\nArguments, exactly as written \(JSON\):\n(.+)$/m.exec(text);
      if (!m) return text;
      const a = JSON.parse(m[3]);
      const tool = m[2].split("__").pop();
      calls.push({ tool, args: a });
      const msgs = mail().threads.flatMap((t) => t.messages);
      const v = tool === "search_threads" ? mail() : tool === "get_message" ? { ...msgs.find((x) => x.id === a.messageId), addressDisplayNames: {} } : { ok: true };
      text = (await cmd("result", [m[1]], { text: JSON.stringify(v) })).text.replace(/^Saved \w+\.\n\n/, "");
    }
    throw new Error("the run did not end");
  }
  return { posts, calls, start: async (flags = {}) => until((await cmd("start", [], flags)).text) };
}
const mailbox = (list) => () => ({ threads: list.map((m) => ({ id: `t-${m.id}`, messages: [{ id: m.id, subject: `Invoice ${m.id}`, sender: "ann@example.com", toRecipients: ["me@example.com"], ccRecipients: [], snippet: `Total $${m.amount ?? 250}`, date: m.date }] })) });

// A fake n8n public API (v1) with one workflow, over HTTP so the client's paths are exercised.
function fakeN8n(wf, { executions = [] } = {}) {
  const log = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      const u = new URL(req.url, "http://x");
      log.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, key: req.headers["x-n8n-api-key"] });
      const send = (status, v) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(v)));
      if (req.headers["x-n8n-api-key"] !== "test-key") return send(401, { message: "unauthorized" });
      const m = /^\/api\/v1\/workflows\/([^/]+)(\/(\w+))?$/.exec(u.pathname);
      if (u.pathname === "/api/v1/executions") return send(200, { data: u.searchParams.get("status") === "running" ? [] : executions });
      if (!m || m[1] !== wf.id) return send(404, { message: "not found" });
      if (req.method === "GET" && !m[2]) return send(200, wf);
      if (req.method === "PUT" && !m[2]) return Object.assign(wf, { staticData: body.staticData }), send(200, wf);
      if (req.method === "POST" && m[3] === "unpublish") return (wf.activeVersionId = null), send(200, wf);
      if (req.method === "POST" && m[3] === "publish") return (wf.activeVersionId = body.versionId ?? "v-new"), send(200, wf);
      send(404, { message: "no route" });
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, log, wf, base: `http://127.0.0.1:${server.address().port}` })));
}

test("cursor resolution: items in the cursor's second are told apart by id, as Gmail's after: is inclusive at the second", () => {
  const spec = { field: "date", strategy: "max", idField: "id", arg: "query", template: "after:{seconds}", resolutionMs: 1000 };
  const a = { id: "a", date: "2026-11-14T00:00:01.200Z" };
  const b = { id: "b", date: "2026-11-14T00:00:01.700Z" };
  const first = advanceCursor(spec, [a, b], null);
  assert.deepEqual(first.cursor, { value: b.date, ids: ["a", "b"] }, "every id of the max second, not only the max item's");
  // A message dated earlier in the same second, seen late: new (n8n would deliver it too).
  const late = { id: "c", date: "2026-11-14T00:00:01.100Z" };
  const second = advanceCursor(spec, [a, b, late], first.cursor);
  assert.deepEqual(second.items.map((x) => x.id), ["c"]);
  assert.deepEqual(second.cursor.ids, ["a", "b", "c"]);
  // Without a resolution the late one would be lost (older than the max).
  assert.deepEqual(advanceCursor({ ...spec, resolutionMs: undefined }, [a, b, late], { value: b.date, ids: ["b"] }).items, []);
  // An n8n cursor (whole second, its possibleDuplicates) reads the same way.
  const fromN8n = advanceCursor(spec, [a, b, late, { id: "d", date: "2026-11-14T00:00:02.000Z" }], { value: "2026-11-14T00:00:01.000Z", ids: ["a", "b"] });
  assert.deepEqual(fromN8n.items.map((x) => x.id), ["c", "d"]);
});

test("n8n static data <-> cursor: Gmail v1 flat and v1.1+ nested, Drive by time, Sheets rowAdded by row; unsupported cases say why", () => {
  const step = (type, typeVersion, params = {}, cursor = {}) => ({ kind: "trigger", n8n: { type: `n8n-nodes-base.${type}`, typeVersion }, params, poll: { tool: {}, cursor } });
  const gmailCursor = { field: "date", strategy: "max", idField: "id", resolutionMs: 1000 };
  const def = (s) => ({ steps: { T: s } });
  const nested = { "node:T": { T: { lastTimeChecked: 1794614400, possibleDuplicates: ["m2", "m1"], pendingMessageIds: ["m9"] } } };
  const g12 = def(step("gmailTrigger", 1.2, {}, gmailCursor));
  assert.deepEqual(cursorsFromStaticData(g12, nested).cursors, { T: { value: "2026-11-14T00:00:00.000Z", ids: ["m1", "m2"] } });
  const back = staticDataFromCursors(g12, { T: { value: "2026-11-14T00:05:07.900Z", ids: ["m7"] } }, nested);
  assert.deepEqual(back.staticData, { "node:T": { T: { lastTimeChecked: 1794614707, possibleDuplicates: ["m7"] } } }, "pending ids go: the task delivered them");
  assert.deepEqual(back.carried, ["T"]);
  const g1 = def(step("gmailTrigger", 1, {}, gmailCursor));
  assert.deepEqual(staticDataFromCursors(g1, { T: { value: "2026-11-14T00:00:00.000Z", ids: [] } }, null).staticData, { "node:T": { lastTimeChecked: 1794614400, possibleDuplicates: [] } });
  assert.deepEqual(cursorsFromStaticData(g12, null), { cursors: {}, missing: ["T"], unsupported: [] }, "no cursor before n8n's first poll");
  assert.match(cursorsFromStaticData(def(step("gmailTrigger", 1.2, {}, { field: "date" })), nested).unsupported[0].reason, /whole seconds/);
  const drive = def(step("googleDriveTrigger", 3, { triggerOn: "specificFolder", event: "fileCreated" }));
  assert.deepEqual(cursorsFromStaticData(drive, { "node:T": { lastTimeChecked: "2026-11-14T00:00:00Z" } }).cursors, { T: { value: "2026-11-14T00:00:00Z", ids: [] } });
  assert.deepEqual(staticDataFromCursors(drive, { T: { value: "2026-11-14T01:00:00.250Z", ids: ["f1"] } }, {}).staticData, { "node:T": { lastTimeChecked: "2026-11-14T01:00:00.250Z" } });
  const sheets = def(step("googleSheetsTrigger", 1, { event: "rowAdded" }));
  assert.deepEqual(cursorsFromStaticData(sheets, { "node:T": { documentId: "d", sheetId: 0, lastIndexChecked: 7 } }).cursors, { T: { value: 7 } });
  assert.deepEqual(staticDataFromCursors(sheets, { T: { value: 9 } }, { "node:T": { documentId: "d", sheetId: 0, lastIndexChecked: 7 } }).staticData, { "node:T": { documentId: "d", sheetId: 0, lastIndexChecked: 9 } });
  assert.match(staticDataFromCursors(sheets, { T: { value: 9 } }, {}).unsupported[0].reason, /resets its cursor/);
  assert.match(cursorsFromStaticData(def(step("googleSheetsTrigger", 1, { event: "rowUpdate" })), {}).unsupported[0].reason, /rowAdded/);
  // n8n's executions say what it delivered when its saved static data lags (n8n 2.47.7).
  const runs = [{ data: { resultData: { runData: { T: [{ data: { main: [[{ json: { id: "m4", internalDate: "1794614460300" } }, { json: { id: "m5", internalDate: "1794614460900" } }, { json: { id: "m3", internalDate: "1794614459000" } }]] } }] } } } }];
  const fromRuns = cursorsFromExecutions(g12, runs);
  assert.deepEqual(fromRuns.cursors, { T: { value: "2026-11-14T00:01:00.000Z", ids: ["m4", "m5"] } });
  assert.deepEqual(laterCursors(g12, { T: { value: "2026-11-14T00:00:00.000Z", ids: [] } }, fromRuns.cursors), fromRuns.cursors);
  assert.deepEqual(laterCursors(g12, { T: { value: "2026-11-14T00:01:00.000Z", ids: ["m9"] } }, fromRuns.cursors).T.ids, ["m4", "m5", "m9"], "same second: the ids join");
});

test("task driver dry run: reads go out, connector and http writes are held with their arguments, no ledger, no cursor saved", async () => {
  const { dir, folder } = folderFor("tests/fixtures/convert/poll-code-http.n8n.json");
  try {
    const s = session(folder, mailbox([{ id: "m1", date: "2026-11-14T00:01:00Z" }, { id: "m2", date: "2026-11-14T00:02:00Z", amount: 40 }]));
    const text = await s.start({ "dry-run": true });
    assert.match(text, /^DONE: dry run \S+ finished: 1 write\(s\) held and recorded, nothing sent/);
    assert.equal(s.posts.length, 0);
    assert.deepEqual(s.calls.map((c) => c.tool), ["search_threads", "get_message", "get_message"], "manual mode with no cursor: it shows every message read");
    const recs = join(folder, ".n8m/records");
    const meta = readJson(join(recs, "meta/dry-run.json"));
    assert.equal(meta.status, "done");
    const rec = readJson(join(recs, `runs/${meta.runId}.json`));
    assert.equal(rec.dryRun, true);
    assert.equal(rec.effects.sent, 0);
    assert.deepEqual(rec.wouldSend.map((w) => w.args.body.subject), ["Invoice m1"]);
    assert.equal(rec.steps["Notify accounts"].status, "would-send");
    assert.ok(rec.cursors[POLL], "the record carries the cursor the dry run reached");
    assert.equal(existsSync(join(recs, "cursors")), false, "no cursor saved");
    assert.equal(existsSync(join(recs, "ledger")), false, "no ledger entry");
    // A real run afterwards is not blocked by "a run just finished" and starts from no cursor.
    const live = await s.start();
    assert.match(live, /^DONE: run \S+ finished \(0 write\(s\)\)/, "first scheduled run without a cursor only seeds");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cutover gate: once a cutover starts, scheduled runs are HELD (nothing read) until enable, and again after rollback", async () => {
  const { dir: d2, folder: f2 } = folderFor("tests/fixtures/convert/poll-code-http.n8n.json");
  try {
    const { openStore, loadTask, paths } = await import("../skills/n8n-migrate/runtime/src/driver.mjs");
    const P = paths(f2, f2);
    const store = openStore(P, loadTask(P));
    store.set(core.META_CUTOVER, core.cutoverMeta({ owner: "n8n", at: "2026-11-14T00:00:00.000Z" }));
    const s = session(f2, mailbox([{ id: "m1", date: "2026-11-14T00:01:00Z" }]));
    assert.match(await s.start(), /^HELD: the n8n workflow still runs this workflow/);
    assert.equal(s.calls.length, 0, "a held run reads nothing");
    assert.match(await s.start({ "dry-run": true }), /^DONE: dry run/, "a dry run is not held");
    store.set(core.META_CUTOVER, core.cutoverMeta({ owner: "claude", at: "2026-11-14T00:00:01.000Z" }));
    assert.match(await s.start(), /^DONE: run/);
  } finally {
    rmSync(d2, { recursive: true, force: true });
  }
});

test("cutover CLI: order and --force rules, deactivate through n8n's API, seed from n8n's cursor, enable, rollback carries the task's cursor back", async () => {
  const { dir, folder } = folderFor("tests/fixtures/convert/poll-code-http.n8n.json", { task: { store: { kind: "file" } } });
  // n8n's saved cursor lags (activation time); its executions show it delivered m1 at 00:01:00.
  const wf = { id: "poll01", name: "Invoice mail to accounts", activeVersionId: "v1", nodes: [{ name: POLL }], connections: {}, settings: { executionOrder: "v1" }, staticData: { [`node:${POLL}`]: { [POLL]: { lastTimeChecked: Math.floor(Date.parse("2026-11-14T00:00:30Z") / 1000) } } } };
  const executions = [{ id: "1", status: "success", data: { resultData: { runData: { [POLL]: [{ data: { main: [[{ json: { id: "m1", internalDate: String(Date.parse("2026-11-14T00:01:00.400Z")) } }]] } }] } } } }];
  const api = await fakeN8n(wf, { executions });
  const env = { N8N_BASE_URL: api.base, N8N_API_KEY: "test-key" };
  const step = (name, flags = {}, extra = {}) => runStep(folder, name, { flags, env, sleep: async () => {}, ...extra });
  try {
    let mail = [{ id: "m0", date: "2026-11-14T00:00:10Z" }, { id: "m1", date: "2026-11-14T00:01:00.400Z" }];
    const s = session(folder, () => mailbox(mail)());
    // Out of order: nothing recorded yet.
    assert.equal((await step("seed")).code, 1);
    assert.equal((await step("enable", { force: true })).code, 1, "--force cannot enable while n8n may still send");
    assert.match((await step("deactivate-n8n")).text, /clean dry run first/);
    const dryText = await step("dry-run");
    assert.equal(dryText.code, 3, "the dry run needs a session: connector reads");
    assert.match(dryText.text, /start --dry-run/);
    await s.start({ "dry-run": true });
    const dry = await step("dry-run");
    assert.equal(dry.code, 0);
    assert.match(dry.text, /would send: Notify accounts: POST https:\/\/api\.accounts\.example\.com\/v1\/invoices/);
    assert.equal((await step("seed", { force: true })).code, 1, "seed before deactivate is refused even with --force");
    const deact = await step("deactivate-n8n");
    assert.equal(deact.code, 0, deact.text);
    assert.match(deact.text, /from its executions/);
    assert.deepEqual(deact.data.cursor, { [POLL]: { value: "2026-11-14T00:01:00.000Z", ids: ["m1"] } });
    assert.equal(api.wf.activeVersionId, null, "unpublished");
    assert.ok(api.log.every((r) => r.key === "test-key"));
    assert.equal(JSON.stringify(readdirSync(join(folder, ".n8m/records/cutover")).map((f) => readFileSync(join(folder, ".n8m/records/cutover", f), "utf8"))).includes("test-key"), false, "the key is never stored");
    assert.equal((await step("seed", { from: "dry-run" })).code, 1);
    assert.equal((await step("enable")).code, 1, "enable wants the seed first");
    assert.equal((await step("seed")).code, 0);
    const en = await step("enable");
    assert.equal(en.code, 0);
    assert.match(en.text, /Create the cloud task now/);
    // The task's first run sends only what n8n had not: m2 (m0 and m1 went out from n8n).
    mail = [...mail, { id: "m2", date: "2026-11-14T00:02:00.100Z" }, { id: "m3", date: "2026-11-14T00:02:00.900Z" }];
    await s.start({ force: true });
    assert.deepEqual(s.posts.map((p) => p.body.subject).sort(), ["Invoice m2", "Invoice m3"]);
    const list = (await step("checklist")).data.checklist;
    assert.deepEqual(list.map((c) => c.state), ["done", "optional", "done", "done", "done"]);
    // Rollback: held first, the cursor carried into n8n's static data, published again.
    const rb = await step("rollback");
    assert.equal(rb.code, 0, rb.text);
    assert.deepEqual(api.wf.staticData, { [`node:${POLL}`]: { [POLL]: { lastTimeChecked: Math.floor(Date.parse("2026-11-14T00:02:00Z") / 1000), possibleDuplicates: ["m2", "m3"] } } });
    assert.equal(api.wf.activeVersionId, "v1", "the version that was live is published again");
    const put = api.log.find((r) => r.method === "PUT");
    assert.equal(put.query.publishIfActive, "false");
    assert.match(await s.start({ force: true }), /^HELD/);
    assert.deepEqual((await step("checklist")).data.checklist.map((c) => c.state), ["todo", "optional", "todo", "todo", "todo"], "a rollback starts a new round");
    const st = await step("status");
    assert.match(st.text, /Who sends: n8n/);
    assert.equal(st.data.n8n.published, true);
  } finally {
    api.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without n8n API access, deactivate-n8n and rollback print the steps by hand (exit 3) and record with --done", async () => {
  const { dir, folder } = folderFor("tests/fixtures/convert/poll-code-http.n8n.json");
  const step = (name, flags = {}) => runStep(folder, name, { flags, env: {} });
  try {
    const s = session(folder, mailbox([{ id: "m1", date: "2026-11-14T00:01:00Z" }]));
    await s.start({ "dry-run": true });
    const manual = await step("deactivate-n8n");
    assert.equal(manual.code, 3);
    assert.match(manual.text, /n8n export:workflow --id=poll01/);
    const exp = join(dir, "export.json");
    writeFileSync(exp, JSON.stringify([{ id: "poll01", name: "Invoice mail to accounts", active: false, staticData: { [`node:${POLL}`]: { [POLL]: { lastTimeChecked: 1794614460, possibleDuplicates: ["m1"] } } } }]));
    const done = await step("deactivate-n8n", { done: true, "n8n-export": exp });
    assert.equal(done.code, 0, done.text);
    assert.equal((await step("seed")).code, 0);
    assert.equal((await step("enable")).code, 0);
    const rb = await step("rollback");
    assert.equal(rb.code, 3);
    assert.match(rb.text, /"staticData" to exactly: \{"node:New invoice email":\{"New invoice email":\{"lastTimeChecked":1794614460,"possibleDuplicates":\["m1"\]\}\}\}/);
    assert.equal((await step("rollback", { done: true })).code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shared state: a workflow sharing a Data Table cannot move alone until the table moved; parity compares pinned outputs", async () => {
  const { dir, folders } = folderFor("tests/fixtures/datatable-shared.json");
  try {
    const f = folders.find((x) => x.endsWith("log-signups"));
    const r = await runStep(f, "deactivate-n8n", { flags: { force: true }, env: {} });
    assert.equal(r.code, 1);
    assert.match(r.text, /data-table "signups".*also used by wf-signup-report/s);
    assert.equal((await runStep(f, "shared-moved", { pos: ["data-table:signups"], flags: {} })).code, 2, "needs --to");
    assert.equal((await runStep(f, "shared-moved", { pos: ["data-table:signups"], flags: { to: "Postgres table signups" } })).code, 0);
    assert.equal((await runStep(f, "deactivate-n8n", { flags: { force: true }, env: {} })).code, 3, "past the shared-state check: waits for the person");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // Parity: the trigger's pinned items are fed in, the Code node's pinned output compared.
  const pinned = (wf) => {
    wf.pinData = {
      [POLL]: [{ json: { id: "m1", From: "ann@example.com", Subject: "Invoice 1", snippet: "Total $250" } }, { json: { id: "m2", From: "bo@example.com", Subject: "Invoice 2", snippet: "Total $40" } }],
      "Extract amount": [{ json: { from: "ann@example.com", subject: "Invoice 1", amount: 250 } }, { json: { from: "bo@example.com", subject: "Invoice 2", amount: 41 } }],
    };
  };
  const { dir: d2, folder } = folderFor("tests/fixtures/convert/poll-code-http.n8n.json", { mutate: (items) => pinned(items[0].json ?? items[0]) });
  try {
    const src = readJson(join(folder, "source.n8n.json"));
    if (!src.pinData) {
      pinned(src);
      writeFileSync(join(folder, "source.n8n.json"), JSON.stringify(src));
    }
    const p = await runStep(folder, "parity", { flags: {} });
    assert.equal(p.code, 0, p.text);
    assert.equal(p.data.compared, 1);
    assert.equal(p.data.differ, 1);
    assert.match(p.text, /differs\s+Extract amount: n8n 2 item\(s\), ours 2; first difference at \$\[1\]\.amount: n8n 41 \| ours 40/);
    assert.match(p.text, /would send: Notify accounts: POST https:\/\/api\.accounts\.example\.com\/v1\/invoices/);
  } finally {
    rmSync(d2, { recursive: true, force: true });
  }
});

test("the n8n client never prints its key and falls back to the deprecated activate/deactivate routes", async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push([init.method, url.replace(/^http:\/\/n8n/, "")]);
    if (/\/(unpublish|publish)$/.test(url)) return new Response('{"message":"not found"}', { status: 404 });
    if (/\/deactivate$|\/activate$/.test(url)) return new Response("{}", { status: 200 });
    throw new Error(`connect failed with secret-key in it`);
  };
  const c = createN8nClient({ base: "http://n8n", key: "secret-key", fetch });
  await c.unpublish("w1");
  await c.publish("w1", "v1");
  assert.deepEqual(seen.map((x) => x.join(" ")), ["POST /api/v1/workflows/w1/unpublish", "POST /api/v1/workflows/w1/deactivate", "POST /api/v1/workflows/w1/publish", "POST /api/v1/workflows/w1/activate"]);
  await assert.rejects(c.getWorkflow("w1"), (e) => !e.message.includes("secret-key") && /\[key\]/.test(e.message));
});

test("schedule times between deactivate-n8n and enable are reported as run by neither side; run-now says how, finds the run, or records --skip", async () => {
  const { paths, loadTask, openStore } = await import("../skills/n8n-migrate/runtime/src/driver.mjs");
  // slice: a Schedule Trigger daily at 08:00 Asia/Singapore (00:00 UTC), Gmail -> model -> Slack.
  const { dir, folder } = folderFor("tests/fixtures/convert/slice.n8n.json", { task: { store: { kind: "file" } } });
  let clock = "2026-11-14T23:30:00.000Z";
  const step = (name, flags = {}) => runStep(folder, name, { flags, env: {}, now: () => clock });
  try {
    const def = readJson(join(folder, "definition.json"));
    assert.deepEqual(def.steps["Every morning"].schedule.cron, ["0 0 8 * * *"]);
    // A clean dry run in the task's records (the session that ran it is not needed here).
    const P = paths(folder, folder);
    const store = openStore(P, loadTask(P));
    const hash = core.definitionHash(def);
    store.set(core.runPath("run-dry"), core.runRecord({ runId: "run-dry", trigger: "manual", driver: "task", status: "done", dryRun: true, startedAt: "2026-11-14T23:00:00.000Z", endedAt: "2026-11-14T23:01:00.000Z", definitionHash: hash }));
    store.set("meta/dry-run", { runId: "run-dry", status: "done", definitionHash: hash, startedAt: "2026-11-14T23:00:00.000Z", endedAt: "2026-11-14T23:01:00.000Z", wouldSend: 1 });
    store.flush?.("test");
    // By hand, switched off at 23:30 UTC.
    assert.equal((await step("deactivate-n8n", { done: true, "off-at": "2026-11-20T00:00:00Z" })).code, 2, "--off-at in the future is refused");
    const off = await step("deactivate-n8n", { done: true, "off-at": "2026-11-14T23:30:00Z" });
    assert.equal(off.code, 0, off.text);
    assert.equal((await step("seed")).code, 0, "no poll trigger: nothing to seed");
    // Before enable, status counts the fires so far; enable stays the next step.
    clock = "2026-11-15T01:00:00.000Z";
    const st = await step("status");
    assert.deepEqual([st.data.gap.count, st.data.gap.times, st.data.next], [1, ["2026-11-15T00:00:00.000Z"], "enable"]);
    assert.match(st.text, /\[ \] Schedule times while neither side ran: 1 schedule time\(s\) \(cron 0 0 8 \* \* \* in Asia\/Singapore\): 2026-11-15T00:00:00\.000Z, between n8n going off \(2026-11-14T23:30:00\.000Z\) and now/);
    // Enable a day later: two fires ran nowhere; reported, never run by itself.
    clock = "2026-11-16T02:00:00.000Z";
    const en = await step("enable");
    assert.equal(en.code, 0, en.text);
    assert.deepEqual(en.data.missedWhileOff, { from: "2026-11-14T23:30:00.000Z", to: "2026-11-16T02:00:00.000Z", exact: true, count: 2, capped: false, times: ["2026-11-15T00:00:00.000Z", "2026-11-16T00:00:00.000Z"] });
    assert.match(en.text, /Missed while neither side ran: 2 schedule time\(s\).*Neither n8n nor the task ran them, and nothing runs them by itself\. To run the workflow once now: cutover\.mjs .* run-now/s);
    assert.deepEqual(readdirSync(join(folder, ".n8m/records/runs")), ["run-dry.json"], "enable ran nothing");
    const list = (await step("checklist")).data;
    assert.deepEqual([list.checklist.at(-1).id, list.checklist.at(-1).state, list.next], ["missed-in-gap", "todo", "run-now"]);
    // run-now: how, for this target (exit 3: the person runs it).
    const how = await step("run-now");
    assert.equal(how.code, 3);
    assert.match(how.text, /run it once now; it should end with DONE\. It is one run at the current time/);
    // The task's run after enable (before the next 08:00) answers it, found in its records.
    store.set(core.runPath("run-catchup"), core.runRecord({ runId: "run-catchup", trigger: "scheduled", driver: "task", status: "done", startedAt: "2026-11-16T02:05:00.000Z", endedAt: "2026-11-16T02:06:00.000Z" }));
    store.flush?.("test");
    clock = "2026-11-16T02:10:00.000Z";
    const found = await step("run-now");
    assert.deepEqual([found.code, found.data.runId], [0, "run-catchup"]);
    const after = (await step("checklist")).data;
    assert.deepEqual([after.checklist.at(-1).state, after.next], ["done", null]);
    assert.match(after.checklist.at(-1).detail, /the task ran once after enable: run run-catchup \(done\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missed schedule times: none when enable follows at once, --skip records the person's choice, poll triggers never count, API deactivation stamps n8n's stop", async () => {
  const { dir, folders } = folderFor("tests/fixtures/convert/slice.n8n.json", { task: { store: { kind: "file" } } });
  const folder = folders[0];
  let clock = "2026-11-14T23:50:00.000Z";
  const step = (f, name, flags = {}, extra = {}) => runStep(f, name, { flags, env: {}, now: () => clock, ...extra });
  try {
    assert.equal((await step(folder, "run-now")).code, 1, "run-now before enable is refused");
    await step(folder, "deactivate-n8n", { done: true, force: true });
    clock = "2026-11-14T23:55:00.000Z";
    await step(folder, "seed");
    const en = await step(folder, "enable");
    assert.equal(en.data.missedWhileOff.count, 0);
    assert.equal(en.data.missedWhileOff.exact, false, "by hand without --off-at: counted from when it was recorded");
    assert.doesNotMatch(en.text, /Missed while/);
    const item = (await step(folder, "checklist")).data.checklist.at(-1);
    assert.deepEqual([item.state, /none: no schedule time fell/.test(item.detail)], ["done", true]);
    assert.match((await step(folder, "run-now")).text, /nothing to catch up/);
    // A round with a gap, left unrun on purpose.
    clock = "2026-11-15T00:30:00.000Z";
    await step(folder, "rollback", { done: true });
    clock = "2026-11-15T01:00:00.000Z";
    await step(folder, "deactivate-n8n", { done: true, force: true });
    clock = "2026-11-17T01:00:00.000Z";
    assert.equal((await step(folder, "enable")).data.missedWhileOff.count, 2, "a new round counts from its own deactivation");
    clock = "2026-11-17T01:05:00.000Z";
    const skip = await step(folder, "run-now", { skip: true });
    assert.equal(skip.code, 0);
    assert.deepEqual((await step(folder, "checklist")).data.checklist.at(-1).state, "done");
    assert.match((await step(folder, "run-now")).text, /stay unrun/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // A poll trigger's items wait behind the cursor: no such item; through n8n's API offAt is
  // stamped just before the unpublish.
  const poll = folderFor("tests/fixtures/convert/poll-code-http.n8n.json", { task: { store: { kind: "file" } } });
  const wf = { id: "poll01", name: "Invoice mail to accounts", activeVersionId: "v1", nodes: [{ name: POLL }], connections: {}, settings: { executionOrder: "v1" }, staticData: { [`node:${POLL}`]: { [POLL]: { lastTimeChecked: 1794614460 } } } };
  const api = await fakeN8n(wf);
  try {
    clock = "2026-11-15T03:00:00.000Z";
    const d = await step(poll.folder, "deactivate-n8n", { force: true }, { env: { N8N_BASE_URL: api.base, N8N_API_KEY: "test-key" }, sleep: async () => {} });
    assert.equal(d.code, 0, d.text);
    const entry = readdirSync(join(poll.folder, ".n8m/records/cutover")).map((f) => readJson(join(poll.folder, ".n8m/records/cutover", f))).find((e) => e.step === "deactivate-n8n");
    assert.deepEqual([entry.detail.offAtExact, entry.detail.offAt < entry.at], [true, true]);
    assert.equal((await step(poll.folder, "checklist")).data.checklist.some((c) => c.id === "missed-in-gap"), false);
  } finally {
    api.server.close();
    rmSync(poll.dir, { recursive: true, force: true });
  }
});
