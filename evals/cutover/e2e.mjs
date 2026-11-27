#!/usr/bin/env node
// The cutover done test: "a person can migrate a workflow, and roll it back, without any
// message being sent by both systems". Runs against the local n8n container (evals/n8n,
// n8nmigrate-bench) and a feed this script keeps; never a real n8n, connector or Claude task.
//
//   node evals/cutover/e2e.mjs [--keep] [--out <file.jsonl>]
//
// The workflow is the poll fixture tests/fixtures/convert/poll-code-http.n8n.json (Gmail poll
// trigger -> Code -> If -> HTTP POST to an accounts API, the POST standing in for a Slack
// message), polled every minute on the n8n side. One feed serves both sides:
//   - n8n's Gmail poll node calls the Gmail REST API (list with `after:<seconds>`, inclusive;
//     get per message) and POSTs to the accounts API. Both go through the bench mock, which
//     forwards these two origins to this script (mock-server.mjs "__forward").
//   - The migrated folder runs as a scheduled task would: its own runtime's driver, in this
//     process, on a timer this script controls, with the Claude Code hooks spawned as processes
//     and a scripted session making the tool calls the runner prints (Gmail search_threads and
//     get_message in the connector's shapes, answered from the same feed). Its http POST goes
//     through an injected fetch to the same sink.
// Every POST lands in the sink tagged with the system that sent it.
//
// Phases: n8n live (with a dry run of ours, which must send nothing) -> deactivate-n8n ->
// an interrupted cutover (items arrive while neither side is on; a task started early is held)
// -> seed -> enable -> our runs -> rollback (n8n re-published with our cursor; our runs held)
// -> n8n runs. Pass: every item meant to be sent was sent exactly once, by exactly one system,
// and in each phase only the system that owned it sent. A second copy of the folder runs the
// rejected order (task enabled while n8n is still on, first run seeds and emits nothing) to
// show the double send it causes; its sends are counted apart.
//
// Memory: checks memory_pressure first (CLAUDE.md), one n8n container (1 GB cap), stopped at
// the end unless --keep. No model is called.

import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { up, down, rest, BASE, WORK, MODEL_SHIM_PORT, memoryFree, waitForMemory, docker, MOCK_NAME } from "../n8n/container.mjs";
import { ensureLeaf } from "../bench/tls.mjs";
import { convertItems, writeFolder, loadReferences } from "../../skills/n8n-to-claude/scripts/convert.mjs";
import { loadInput } from "../../skills/n8n-to-claude/scripts/analyze.mjs";
import { runStep } from "../../skills/n8n-to-claude/scripts/cutover.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const OUT = resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : join(HERE, "results.jsonl"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);
const GMAIL = "https://www.googleapis.com"; // n8n's Gmail nodes call www.googleapis.com/gmail/v1
const ACCOUNTS = "https://api.accounts.example.com";

// ---------- the feed: one mailbox and one sink for both systems ----------
const feed = { items: [], sends: [], reads: [] };
let phase = "setup";
function addItem(label, amount, { history = false } = {}) {
  const ms = Date.now();
  const item = { id: `m-${label}`, threadId: `t-${label}`, label, amount, history, subject: `Invoice ${label}`, snippet: `Invoice ${label}: total $${amount}.00 due`, internalDate: ms };
  feed.items.push(item);
  log(`feed: ${item.id} ($${amount}) at ${new Date(ms).toISOString()}`);
  return item;
}
const afterOf = (q) => {
  const m = /after:(\d+)/.exec(String(q ?? ""));
  return m ? Number(m[1]) * 1000 : -Infinity;
};
const listed = (q) => feed.items.filter((it) => it.internalDate >= afterOf(q) && /invoice/i.test(it.subject)).sort((a, b) => b.internalDate - a.internalDate);
function recordSend(system, body) {
  const b = typeof body === "string" ? JSON.parse(body || "{}") : body ?? {};
  const label = /^Invoice (\S+)$/.exec(String(b.subject ?? ""))?.[1] ?? "?";
  feed.sends.push({ system, phase, label, at: new Date().toISOString(), amount: Number(b.amount) });
  log(`SEND by ${system}: Invoice ${label} (${phase})`);
}

// n8n's side (forwarded by the mock): Gmail REST and the accounts API.
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const origin = req.headers["x-bench-forward-origin"];
    const u = new URL(req.url, "http://feed");
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (origin === GMAIL && req.method === "GET" && u.pathname === "/gmail/v1/users/me/messages") {
      const q = u.searchParams.get("q");
      const found = listed(q);
      feed.reads.push({ system: "n8n", phase, kind: "list", q, n: found.length, at: new Date().toISOString() });
      return reply(200, { messages: found.map((it) => ({ id: it.id, threadId: it.threadId })), resultSizeEstimate: found.length });
    }
    // The node's simplified output names the labels and lifts the headers (From, Subject).
    if (origin === GMAIL && req.method === "GET" && u.pathname === "/gmail/v1/users/me/labels") return reply(200, { labels: [{ id: "INBOX", name: "INBOX" }, { id: "UNREAD", name: "UNREAD" }] });
    const m = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(u.pathname);
    if (origin === GMAIL && req.method === "GET" && m) {
      const it = feed.items.find((x) => x.id === decodeURIComponent(m[1]));
      if (!it) return reply(404, { error: { code: 404, message: "Not Found" } });
      return reply(200, { id: it.id, threadId: it.threadId, labelIds: ["INBOX", "UNREAD"], snippet: it.snippet, sizeEstimate: 900, historyId: "1", internalDate: String(it.internalDate), payload: { mimeType: "text/plain", headers: [{ name: "From", value: "Ann Lee <ann@example.com>" }, { name: "To", value: "accounts@example.com" }, { name: "Subject", value: it.subject }] } });
    }
    if (origin === ACCOUNTS && req.method === "POST" && u.pathname === "/v1/invoices") {
      recordSend("n8n", Buffer.concat(chunks).toString("utf8"));
      return reply(201, { id: `inv-${feed.sends.length}`, status: "queued" });
    }
    reply(404, { error: "no route in the cutover feed", origin, path: u.pathname });
  });
});

// Our side: the connector tools in the shapes the Gmail connector returns.
function connectorTool(system, tool, a) {
  if (tool === "search_threads") {
    const found = listed(a.query);
    feed.reads.push({ system, phase, kind: "list", q: a.query, n: found.length, at: new Date().toISOString() });
    return { threads: found.map((it) => ({ id: it.threadId, messageCount: 1, messages: [{ id: it.id, snippet: it.snippet, subject: it.subject, sender: "ann@example.com", toRecipients: ["accounts@example.com"], ccRecipients: [], date: new Date(it.internalDate).toISOString(), labelIds: ["INBOX", "UNREAD"] }] })), query: a.query };
  }
  if (tool === "get_message") {
    const it = feed.items.find((x) => x.id === a.messageId);
    if (!it) return { error: "not found" };
    return { id: it.id, threadId: it.threadId, snippet: it.snippet, subject: it.subject, sender: "ann@example.com", toRecipients: ["accounts@example.com"], ccRecipients: [], date: new Date(it.internalDate).toISOString(), labelIds: ["INBOX", "UNREAD"], addressDisplayNames: { "ann@example.com": "Ann Lee" } };
  }
  throw new Error(`the feed has no tool ${tool}`);
}

// ---------- a scheduled task's session, scripted ----------
async function taskSession(folder, system) {
  const driver = await import(pathToFileURL(join(folder, "runtime/driver.mjs")).href);
  const core = await import(pathToFileURL(join(folder, "runtime/runner-core.mjs")).href);
  const task = JSON.parse(readFileSync(join(folder, "task.json"), "utf8"));
  const fetch = async (url, init) => {
    if (!String(url).startsWith(`${ACCOUNTS}/v1/invoices`)) throw new Error(`unexpected host ${url}`);
    recordSend(system, init.body);
    return new Response(JSON.stringify({ id: `inv-${feed.sends.length}`, status: "queued" }), { status: 201, headers: { "content-type": "application/json" } });
  };
  const run = (cmd, pos = [], flags = {}) => driver.command(cmd, pos, flags, { core, dir: folder, cwd: folder, stdin: () => "", fetch });
  const hook = (which, input) => {
    const r = spawnSync(process.execPath, ["--max-old-space-size=256", join(folder, "runtime/hook.mjs"), which], { cwd: folder, encoding: "utf8", input: JSON.stringify(input) });
    if (r.status !== 0) throw new Error(`hook ${which}: ${r.stderr}`);
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  };
  let n = 0;
  const calls = [];
  async function until(text) {
    for (let i = 0; i < 80; i++) {
      const m = /^NEXT: call one tool \(request (\w+)[^\n]*\nTool: (\S+)\nArguments, exactly as written \(JSON\):\n(.+)$/m.exec(text);
      if (!m) return text;
      const [, , name, argText] = m;
      const input = JSON.parse(argText);
      const id = `tu-${system}-${++n}`;
      const pre = hook("pre", { tool_name: name, tool_input: input, tool_use_id: id, cwd: folder });
      if (pre?.hookSpecificOutput?.permissionDecision === "deny") throw new Error(`hook denied ${name}: ${pre.hookSpecificOutput.permissionDecisionReason}`);
      const a = pre?.hookSpecificOutput?.updatedInput ?? input;
      const prefix = Object.values(task.toolPrefixes).find((p) => name.startsWith(p)) ?? "";
      const tool = name.slice(prefix.length);
      calls.push({ tool, args: a, phase });
      const value = connectorTool(system, tool, a);
      hook("post", { tool_name: name, tool_input: input, tool_use_id: id, tool_response: [{ type: "text", text: JSON.stringify(value) }], cwd: folder });
      text = (await run("next")).text;
    }
    throw new Error("the run did not end");
  }
  return {
    calls,
    async start(flags = {}) {
      const r = await run("start", [], flags);
      const text = await until(r.text);
      log(`${system}: ${text.split("\n")[0]}`);
      return text;
    },
  };
}

// ---------- n8n setup ----------
function workflowJson() {
  const wf = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/convert/poll-code-http.n8n.json"), "utf8"));
  // n8n polls at most once a minute; the fixture's hourly poll would take hours here.
  wf.nodes.find((x) => x.type === "n8n-nodes-base.gmailTrigger").parameters.pollTimes = { item: [{ mode: "everyMinute" }] };
  return wf;
}
async function n8nSetup(source) {
  const wf = structuredClone(source); // the export the folder is converted from stays as is
  // Workflows a crashed earlier run left behind would poll the same feed.
  for (const w of (await rest("GET", "/workflows")) ?? []) if (w.name === wf.name) await rest("POST", `/workflows/${w.id}/archive`).catch(() => {}), await rest("DELETE", `/workflows/${w.id}`).catch(() => {});
  const creds = {};
  for (const [type, data] of [
    ["gmailOAuth2", { clientId: "e2e", clientSecret: "e2e", oauthTokenData: { access_token: "e2e-access", refresh_token: "e2e-refresh", token_type: "Bearer", expires_in: 315360000, scope: "e2e" } }],
    ["httpHeaderAuth", { name: "X-Api-Key", value: "e2e-n8n-key" }],
  ]) {
    const node = wf.nodes.find((x) => x.credentials?.[type]);
    const c = await rest("POST", "/credentials", { name: node.credentials[type].name, type, data });
    creds[type] = c.id;
    node.credentials[type] = { id: c.id, name: c.name };
  }
  const created = await rest("POST", "/workflows", { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings });
  const key = await rest("POST", "/api-keys", { label: `cutover-e2e-${Date.now()}`, scopes: await rest("GET", "/api-keys/scopes"), expiresAt: null });
  return { id: created.id, creds, apiKey: key.rawApiKey, apiKeyId: key.id };
}
async function n8nStaticData(id, apiKey) {
  const r = await fetch(`${BASE}/api/v1/workflows/${id}`, { headers: { "X-N8N-API-KEY": apiKey } });
  return (await r.json()).staticData ?? null;
}

// ---------- main ----------
const free0 = memoryFree();
log(`memory free ${free0}%`);
if (free0 !== null && free0 < 25) await waitForMemory(25, { log });
for (const h of ["www.googleapis.com", "api.accounts.example.com", "oauth2.googleapis.com"]) ensureLeaf(h);
await new Promise((r, j) => server.once("error", j).listen(MODEL_SHIM_PORT, "127.0.0.1", r));
mkdirSync(WORK, { recursive: true });
writeFileSync(join(WORK, "fixtures.json"), JSON.stringify({ __forward: [{ origin: GMAIL }, { origin: ACCOUNTS }], default: { status: 404, body: { error: "no fixture (cutover e2e)" } } }));
writeFileSync(join(WORK, "effects.jsonl"), "");
await up({ log });
// The sidecar loads mock-server.mjs at start: restart it so it runs the forward route.
docker(["restart", MOCK_NAME]);
for (let i = 0; i < 30; i++) {
  if (await fetch(`${BASE}/healthz/readiness`).then((r) => r.ok, () => false)) break;
  await sleep(500);
}

const result = { at: new Date().toISOString(), ok: false, steps: [] };
let n8n;
let folder;
const work = mkdtempSync(join(tmpdir(), "n8m-cutover-e2e-"));
try {
  const wf = workflowJson();
  n8n = await n8nSetup(wf);
  const env = { N8N_BASE_URL: BASE, N8N_API_KEY: n8n.apiKey };
  const cut = async (step, flags = {}) => {
    const r = await runStep(folder, step, { flags: { "n8n-id": n8n.id, ...flags }, env });
    log(`cutover ${step}${Object.keys(flags).length ? " " + JSON.stringify(flags) : ""} -> exit ${r.code}\n    ${r.text.split("\n").join("\n    ")}`);
    result.steps.push({ step, flags, code: r.code, phase });
    return r;
  };

  // The migrated folder, from the same export n8n runs (credential names, not n8n's ids).
  writeFileSync(join(work, "wf.json"), JSON.stringify(wf));
  const [res] = convertItems(loadInput(join(work, "wf.json")).items, { refs: loadReferences(), now: Date.now() });
  folder = writeFolder(join(work, "repo"), res, { refs: loadReferences() });
  process.env.N8M_SECRET_ACCOUNTS_API_KEY = "e2e-claude-key"; // a local task's secret source
  // The rejected order, for contrast: a copy enabled while n8n is still on (no cutover log).
  const optionA = join(work, "repo-option-a");
  cpSync(join(work, "repo"), optionA, { recursive: true });
  const folderA = join(optionA, folder.split("/").pop());
  const ours = await taskSession(folder, "claude");
  const theirs = await taskSession(folderA, "option-a");
  result.folder = { target: res.report?.outcome?.target, steps: Object.keys(res.definition.steps) };

  // ---- phase 0: n8n is live ----
  phase = "0-n8n-live";
  // Mail from before the migration: neither side may ever send it.
  addItem("H0", 900, { history: true });
  await sleep(1300);
  const pub = await fetch(`${BASE}/api/v1/workflows/${n8n.id}/publish`, { method: "POST", headers: { "X-N8N-API-KEY": n8n.apiKey, "content-type": "application/json" }, body: "{}" });
  assert.equal(pub.status, 200, `publish: ${await pub.text()}`);
  log("n8n workflow published (its activation poll sets its cursor to now)");
  await sleep(1200);
  await theirs.start(); // option A's first run: no cursor, so it reads H0, seeds and sends nothing
  addItem("A1", 250);
  await sleep(700);
  addItem("A2", 40); // under 100: the If sends nothing for it on either side
  await sleep(700);
  addItem("A3", 300);
  // Our dry run while n8n is live: reads go out, writes are held.
  const sendsBeforeDry = feed.sends.filter((s) => s.system === "claude").length;
  const dry = await ours.start({ "dry-run": true });
  assert.match(dry, /^DONE: dry run .* 3 write\(s\) held and recorded, nothing sent/, "H0, A1 and A3 held");
  assert.equal(feed.sends.filter((s) => s.system === "claude").length, sendsBeforeDry, "the dry run sent something");
  await cut("status");
  assert.equal((await cut("dry-run")).code, 0);
  assert.equal((await cut("parity")).code, 0);
  assert.equal((await cut("seed")).code, 1, "seed before deactivate must be refused");
  assert.equal((await cut("enable", { force: true })).code, 1, "enable before deactivate must be refused, even with --force");
  log("waiting for n8n's next poll to send A1 and A3");
  for (let i = 0; i < 150 && !["A1", "A3"].every((l) => feed.sends.some((s) => s.system === "n8n" && s.label === l)); i++) await sleep(1000);
  assert.ok(["A1", "A3"].every((l) => feed.sends.some((s) => s.system === "n8n" && s.label === l)), "n8n did not send A1 and A3 within 150 s");
  await sleep(2000);
  await theirs.start({ force: true }); // option A's second run: n8n is still on, so these go out twice
  result.n8nStaticAfterP0 = await n8nStaticData(n8n.id, n8n.apiKey);
  addItem("A4", 500); // just before n8n goes off: whichever side gets it, it goes out once

  // ---- phase 1: cutover, interrupted between deactivate-n8n and enable ----
  // n8n owns the phase until deactivate-n8n returns (it waits out a running execution).
  const tDeact = Date.now();
  const deact = await cut("deactivate-n8n");
  assert.equal(deact.code, 0);
  result.n8nCursorAtDeactivate = deact.data?.cursor ?? null;
  // What seeding from n8n's saved static data alone would have sent again.
  const saved = deact.data?.cursorFromStaticData?.["New invoice email"];
  const sec = (ms) => Math.floor(ms / 1000);
  result.replayIfStaticDataOnly = saved ? feed.sends.filter((x) => x.system === "n8n").map((x) => feed.items.find((it) => it.label === x.label)).filter((it) => sec(it.internalDate) > sec(Date.parse(saved.value)) || (sec(it.internalDate) === sec(Date.parse(saved.value)) && !(saved.ids ?? []).includes(it.id))).map((it) => it.label) : null;
  result.n8nCursorFromStaticData = saved ?? null;
  phase = "1-cutover";
  // The interruption: the person stops here. Items keep arriving; nobody sends them yet.
  phase = "1-gap";
  addItem("G1", 120);
  addItem("G2", 130); // same second as G1: Gmail's after: cannot tell them apart, ids do
  await sleep(1100);
  const readsBefore = ours.calls.length;
  const held = await ours.start(); // a task created early (before enable) is held by the gate
  assert.match(held, /^HELD:/);
  assert.equal(ours.calls.length, readsBefore, "a held run read something");
  addItem("G3", 40);
  await sleep(4000);
  // The person resumes the cutover.
  phase = "1-cutover";
  assert.equal((await cut("seed")).code, 0);
  assert.equal((await cut("enable")).code, 0);
  phase = "1-claude";
  await ours.start({ force: true });
  addItem("B1", 610);
  await sleep(1100);
  addItem("B3", 20);
  addItem("B2", 620); // the last item we send: n8n's `after:` returns its second again after the rollback
  await sleep(1100);
  await ours.start({ force: true });
  await cut("checklist");
  // n8n is off: prove it, by waiting past its poll interval with no call from it.
  const wait = 66_000 - (Date.now() - tDeact);
  if (wait > 0) {
    log(`waiting ${Math.ceil(wait / 1000)} s past n8n's poll interval to show it stays quiet`);
    await sleep(wait);
  }
  result.n8nReadsWhileOff = feed.reads.filter((r) => r.system === "n8n" && Date.parse(r.at) > tDeact + 3000).length;
  assert.equal(result.n8nReadsWhileOff, 0, "n8n polled while it was off");

  // ---- phase 2: rollback ----
  phase = "2-rollback";
  addItem("R0", 700); // after our last run: n8n must pick it up from the carried cursor
  await sleep(1100);
  const rb = await cut("rollback");
  assert.equal(rb.code, 0);
  result.n8nStaticAfterRollback = await n8nStaticData(n8n.id, n8n.apiKey);
  phase = "2-n8n-live";
  const readsBefore2 = ours.calls.length;
  assert.match(await ours.start({ force: true }), /^HELD:/, "our task must be held after a rollback");
  assert.equal(ours.calls.length, readsBefore2);
  addItem("R1", 800);
  await sleep(700);
  addItem("R2", 10);
  log("waiting for n8n to send R0 and R1");
  for (let i = 0; i < 150 && !["R0", "R1"].every((l) => feed.sends.some((s) => s.system === "n8n" && s.label === l)); i++) await sleep(1000);
  await sleep(3000);
  await cut("status");

  // ---- the verdict ----
  const real = feed.sends.filter((s) => s.system !== "option-a");
  const expected = feed.items.filter((it) => it.amount > 100 && !it.history).map((it) => it.label);
  const per = {};
  for (const s of real) per[s.label] = [...(per[s.label] ?? []), s.system];
  result.items = feed.items.map((it) => ({ label: it.label, amount: it.amount, ...(it.history ? { history: true } : {}), sentBy: per[it.label] ?? [] }));
  result.counts = {};
  for (const s of real) {
    const p = s.phase.replace(/^(\d).*/, "$1");
    result.counts[`phase ${p}`] ??= { n8n: 0, claude: 0 };
    result.counts[`phase ${p}`][s.system]++;
  }
  result.dryRun = { heldWrites: 3, sent: 0 };
  result.optionA = { sends: feed.sends.filter((s) => s.system === "option-a").map((s) => s.label), doubleSent: feed.sends.filter((s) => s.system === "option-a" && real.some((x) => x.label === s.label)).map((s) => s.label) };
  result.reads = feed.reads.map(({ system, phase: ph, n }) => ({ system, phase: ph, n }));
  for (const l of expected) assert.equal((per[l] ?? []).length, 1, `item ${l} sent ${(per[l] ?? []).length} times (${(per[l] ?? []).join(", ")})`);
  for (const it of feed.items.filter((x) => x.amount <= 100 || x.history)) assert.equal((per[it.label] ?? []).length, 0, `item ${it.label} should never be sent`);
  for (const s of real) {
    const owner = s.phase.startsWith("0") || s.phase.startsWith("2") ? "n8n" : "claude";
    assert.equal(s.system, owner, `Invoice ${s.label} was sent by ${s.system} in phase ${s.phase}, which ${owner} owned`);
  }
  assert.ok(result.optionA.doubleSent.length >= 2, "the rejected order should have shown a double send");
  result.ok = true;
  log("PASS: every item sent exactly once, by the system that owned its phase");
} catch (e) {
  result.error = String(e.stack ?? e).split("\n").slice(0, 4).join(" | ");
  log(`FAIL: ${e.message}`);
  process.exitCode = 1;
} finally {
  result.wallS = Math.round((Date.now() - t0) / 1000);
  result.sends = feed.sends;
  result.memoryFree = memoryFree();
  try {
    if (n8n) {
      await fetch(`${BASE}/api/v1/workflows/${n8n.id}/unpublish`, { method: "POST", headers: { "X-N8N-API-KEY": n8n.apiKey } }).catch(() => {});
      await rest("POST", `/workflows/${n8n.id}/archive`).catch(() => {});
      await rest("DELETE", `/workflows/${n8n.id}`).catch(() => {});
      for (const id of Object.values(n8n.creds)) await rest("DELETE", `/credentials/${id}`).catch(() => {});
      await rest("DELETE", `/api-keys/${n8n.apiKeyId}`).catch(() => {});
    }
  } catch {}
  appendFileSync(OUT, JSON.stringify(result) + "\n");
  console.log(JSON.stringify({ ok: result.ok, counts: result.counts, items: result.items, optionA: result.optionA, n8nReadsWhileOff: result.n8nReadsWhileOff, wallS: result.wallS, error: result.error }, null, 2));
  server.close();
  rmSync(work, { recursive: true, force: true });
  if (!KEEP) {
    down();
    log("n8n container stopped");
  }
}
