#!/usr/bin/env node
// Artifact page check (an eval, not a test): builds artifact.html with scripts/convert.mjs for
// the Phase 2 slice, the poll + HTTP workflow and the chat agent, serves each page inside the
// publish skeleton with an artifact-like CSP and the runtime shim (shim.js), and drives it
// with Playwright (Chromium, headless, one browser).
//
//   node evals/artifact/check.mjs [--out <dir>] [--playwright <path to playwright/index.mjs>]
//
// Checks: the graph draws every step at its n8n position; a dry run ends with the expected
// statuses and the Slack step's would-send arguments equal the in-process runner's for the same
// fixtures; a real run writes ledger entries sending -> sent and sends exactly those arguments;
// the lock refuses a second Run now (same page, another page, a task-held lock) and a stale task
// lock is broken; a tampered definition fails preflight with nothing sent; an http step stops
// the run with "handoff"; a send cut off mid-call is shown as unknown and not resent; the agent
// workflow runs through sample with tool-call intents; a form renders every field type,
// validates, runs with the form item, and a hand-off form stores the submission; missed
// scheduled runs show in the history; screenshots at 375, 768, 1440 and 1915 px
// in light and dark, with no horizontal scroll. Screenshots go to --out (scratch), not git.

import { createServer } from "node:http";
import { readFileSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { toolHost, modelHost } from "../../tests/convert-mocks.mjs";
import { run } from "../../skills/n8n-to-claude/runtime/src/api.mjs";
import { missedRuns, definitionSchedule } from "../../skills/n8n-to-claude/runtime/src/schedule.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const flag = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const OUT = resolve(flag("--out", join(tmpdir(), "n2c-artifact-check")));
const PW = flag("--playwright", "/Users/charlieangriawan/Repositories/lunox-work/public/sandbox-factory/node_modules/playwright/index.mjs");
const { chromium } = await import(pathToFileURL(PW).href);
const SHIM = readFileSync(join(ROOT, "evals/artifact/shim.js"), "utf8");
const CLOCK = { startedAt: "2026-11-14T03:00:00Z" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- build ----------
rmSync(join(OUT, "folders"), { recursive: true, force: true });
mkdirSync(join(OUT, "shots"), { recursive: true });
const folders = {};
// A form with every field type n8n's Form Trigger offers that the page renders, then a Set.
const FORM_ALL = {
  id: "form-all", name: "Every field", settings: { executionOrder: "v1" },
  nodes: [
    { id: "1", name: "Signup", type: "n8n-nodes-base.formTrigger", typeVersion: 2.2, position: [0, 0], parameters: { formTitle: "Sign up", formDescription: "All the field types", formFields: { values: [
      { fieldLabel: "Name", requiredField: true },
      { fieldLabel: "Seats", fieldType: "number", requiredField: true },
      { fieldLabel: "Email", fieldType: "email" },
      { fieldLabel: "Start", fieldType: "date" },
      { fieldLabel: "Team", fieldType: "dropdown", fieldOptions: { values: [{ option: "Ops" }, { option: "Sales" }] } },
      { fieldLabel: "Notes", fieldType: "textarea" },
      { fieldLabel: "Agree", fieldType: "checkbox", fieldOptions: { values: [{ option: "Yes" }] }, requiredField: true },
    ] }, options: {} } },
    { id: "2", name: "Tag", type: "n8n-nodes-base.set", typeVersion: 3.4, position: [220, 0], parameters: { assignments: { assignments: [{ id: "a", name: "source", value: "form", type: "string" }] }, includeOtherFields: true, options: {} } },
  ],
  connections: { Signup: { main: [[{ node: "Tag", type: "main", index: 0 }]] } },
};
mkdirSync(join(OUT, "folders"), { recursive: true });
writeFileSync(join(OUT, "folders", "form-all.n8n.json"), JSON.stringify(FORM_ALL));
const SOURCES = {
  slice: join(ROOT, "tests/fixtures/convert/slice.n8n.json"),
  "poll-code-http": join(ROOT, "tests/fixtures/convert/poll-code-http.n8n.json"),
  "chat-agent": join(ROOT, "tests/fixtures/convert/chat-agent.n8n.json"),
  "form-public": join(ROOT, "tests/fixtures/form-public.json"),
  "form-artifact": join(ROOT, "tests/fixtures/form-artifact.json"),
  "form-all": join(OUT, "folders", "form-all.n8n.json"),
};
for (const [name, file] of Object.entries(SOURCES)) {
  const res = JSON.parse(execFileSync("node", [join(ROOT, "skills/n8n-to-claude/scripts/convert.mjs"), file, "--out", join(OUT, "folders", name)], { encoding: "utf8" }));
  folders[name] = join(res.out, res.workflows[0].folder);
}
const load = (name) => ({
  html: readFileSync(join(folders[name], "artifact.html"), "utf8"),
  def: JSON.parse(readFileSync(join(folders[name], "definition.json"), "utf8")),
  caps: JSON.parse(readFileSync(join(folders[name], "artifact.capabilities.json"), "utf8")),
});
const pages = { slice: load("slice"), poll: load("poll-code-http"), agent: load("chat-agent"), form: load("form-public"), formHandoff: load("form-artifact"), formAll: load("form-all") };
const buildOf = (html) => JSON.parse(/<script type="application\/json" id="n2c-build">([^<]*)<\/script>/.exec(html)[1]);
// A tampered copy: the Slack channel changed inside the embedded definition only.
const tamperedHtml = pages.slice.html.replace(/(<script type="application\/json" id="n2c-definition">[^<]*?)C0123456789/, "$1C0ATTACKER1");
assert.notEqual(tamperedHtml, pages.slice.html);

// ---------- what the in-process runner computes for the same fixtures ----------
// The scripted agent: the same decisions whether it reads the runner's request (in process) or
// the composed sample input (in the page).
function scriptedAgent(transcript) {
  if (transcript.length === 0) return { intent: "tool-calls", calls: [{ name: "Search_mail", args: { query: "from:ann is:unread" } }] };
  if (transcript.length === 1) {
    const v = transcript[0].results[0].value;
    return { intent: "tool-calls", calls: [{ name: "Post_to_Slack", args: { message: `Ann wrote: ${(Array.isArray(v) ? v[0] : v)?.Subject}` } }] };
  }
  return { final: `Posted. Last tool said ok=${transcript[1].results[0].value?.ok}` };
}
async function reference(def, opts = {}) {
  const calls = [];
  const r = await run(def, { clock: CLOCK, virtualTime: true, mode: "manual", ...opts, host: { tool: toolHost(calls), model: modelHost(), agent: async (p) => { const v = scriptedAgent(p.transcript); return v.final !== undefined ? v.final : v; } } });
  assert.equal(r.status, "done", JSON.stringify(r.error));
  return { calls, effects: r.effects };
}
const refSlice = await reference(pages.slice.def);
const refSlack = refSlice.calls.filter((c) => c.tool === "slack.slack_send_message").map((c) => c.args);
assert.equal(refSlack.length, 2);
const refAgent = await reference(pages.agent.def, { trigger: [{ sessionId: "s-1", action: "sendMessage", chatInput: "What did Ann send? Post it." }] });

// ---------- shim backend (shared by every page of one browser context) ----------
function backend(caps, servers) {
  const docs = new Map();
  const leases = new Map();
  const ctl = { delay: {}, hang: new Set(), clockOffset: 0 };
  const log = { tools: [], samples: [], writes: [] };
  const now = () => Date.now() + ctl.clockOffset;
  const host = toolHost([]);
  const connectorOf = (server) => Object.keys(servers).find((c) => servers[c] === server);
  const parentOf = (path) => path.split("/").slice(0, -1).join("/");
  const block = (input, label) => {
    const m = new RegExp(`----- ${label} -----\\n([\\s\\S]*?)\\n----- END ${label} -----`).exec(input);
    return m ? m[1] : null;
  };
  const ops = {
    async "mcp.callTool"({ server, tool, input }, page) {
      const connector = connectorOf(server);
      const allowed = (caps.mcp?.servers ?? []).find((s) => s.server === server)?.tools ?? [];
      if (!connector) throw { code: "server_not_connected", message: `${server} is not connected` };
      if (!allowed.includes(tool)) throw { code: "not_in_manifest", message: `${server}.${tool} is not in the manifest` };
      log.tools.push({ page, connector, tool, args: input });
      if (ctl.hang.has(tool)) return new Promise(() => {});
      if (ctl.delay[tool]) await sleep(ctl.delay[tool]);
      let value;
      try {
        value = await host({ connector, tool, args: input });
      } catch (e) {
        throw { code: "tool_error", message: e.message };
      }
      return { content: [{ type: "text", text: JSON.stringify(value) }], payload: value };
    },
    async "mcp.listTools"({ server }) {
      return { servers: (caps.mcp?.servers ?? []).filter((s) => !server || s.server === server).map((s) => ({ server: s.server, kind: "connector", authStatus: "connected", tools: s.tools.map((name) => ({ name, description: "" })) })) };
    },
    async sample({ input, json }, page) {
      log.samples.push({ page, input, json });
      if (ctl.delay.sample) await sleep(ctl.delay.sample);
      if (!json) return { text: `Summary: ${String(block(input, "PROMPT") ?? "").split("\n")[0].slice(0, 40)}` };
      const transcript = JSON.parse(block(input, "TOOL RESULTS SO FAR") ?? "[]");
      return { value: scriptedAgent(transcript) };
    },
    async "db.get"({ path }) {
      return docs.has(path) ? structuredClone(docs.get(path)) : null;
    },
    async "db.set"({ path, data }) {
      docs.set(path, structuredClone(data));
      log.writes.push({ path, data: structuredClone(data), op: "set" });
      return null;
    },
    async "db.update"({ path, data }) {
      if (!docs.has(path)) throw { code: "invalid_argument", message: "document does not exist" };
      docs.set(path, { ...docs.get(path), ...structuredClone(data) });
      log.writes.push({ path, data: structuredClone(data), op: "update" });
      return null;
    },
    async "db.delete"({ path }) {
      docs.delete(path);
      log.writes.push({ path, op: "delete" });
      return null;
    },
    async "db.query"({ path, where, orderBy, limit }) {
      let rows = [...docs].filter(([p]) => parentOf(p) === path).map(([p, data]) => ({ path: p, data: structuredClone(data) }));
      for (const w of where ?? []) rows = rows.filter((r) => ({ "==": (a, b) => a === b, "!=": (a, b) => a !== b, "<": (a, b) => a < b, "<=": (a, b) => a <= b, ">": (a, b) => a > b, ">=": (a, b) => a >= b })[w.op](r.data[w.field], w.value));
      if (orderBy) rows.sort((a, b) => {
        const x = a.data[orderBy.field], y = b.data[orderBy.field];
        if (x === undefined) return 1;
        if (y === undefined) return -1;
        return (x < y ? -1 : x > y ? 1 : 0) * (orderBy.dir === "desc" ? -1 : 1);
      });
      else rows.sort((a, b) => (a.path < b.path ? -1 : 1));
      return limit ? rows.slice(0, limit) : rows;
    },
    async "db.acquire"({ path, holder, ttlMs, data }) {
      const l = leases.get(path);
      const ttl = Math.min(600000, Math.max(1000, ttlMs || 30000));
      if (l && l.expiresAt > now() && l.holder !== holder) return { acquired: false, expiresAt: new Date(l.expiresAt).toISOString() };
      leases.set(path, { holder, expiresAt: now() + ttl });
      if (data) docs.set(path, { ...(docs.get(path) ?? {}), ...data });
      return { acquired: true, version: 1, expiresAt: new Date(now() + ttl).toISOString(), holder };
    },
  };
  return {
    docs, leases, ctl, log,
    async handle(op, a, page) {
      try {
        return await ops[op](a, page);
      } catch (e) {
        return { __error: e && e.code ? { code: e.code, message: e.message } : { code: "upstream_error", message: String(e?.message ?? e) } };
      }
    },
    ledger: () => [...docs].filter(([p]) => p.startsWith("ledger/")).map(([, d]) => d),
    ledgerHistory: (key) => log.writes.filter((w) => w.path === `ledger/${key}` && w.op === "set").map((w) => w.data.status),
    runs: () => [...docs].filter(([p]) => /^runs\/[^/]+$/.test(p)).map(([, d]) => d),
  };
}

// ---------- server: the page inside the publish skeleton, with an artifact-like CSP ----------
const SKELETON_HEAD = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style></head><body>';
const served = { slice: pages.slice.html, poll: pages.poll.html, agent: pages.agent.html, tampered: tamperedHtml, form: pages.form.html, formHandoff: pages.formHandoff.html, formAll: pages.formAll.html };
const extFetches = [];
const server = createServer((req, res) => {
  const name = /^\/page\/([\w-]+)$/.exec(req.url)?.[1];
  if (!name || !served[name]) {
    extFetches.push(req.url);
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'self'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; img-src 'self' data: blob:",
  });
  res.end(SKELETON_HEAD + served[name] + "</body></html>");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ---------- checks ----------
const results = [];
async function check(name, fn) {
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t, detail });
    console.log(`ok    ${name}${detail ? ` (${detail})` : ""}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t, detail: e.message });
    console.log(`FAIL  ${name}\n      ${String(e.stack ?? e.message).split("\n").slice(0, 6).join("\n      ")}`);
  }
}

const browser = await chromium.launch({ headless: true });
const consoleErrors = [];
async function context(which, { colorScheme = "light", deny } = {}) {
  const page0 = pages[which] ?? pages.slice;
  const be = backend(page0.caps, buildOf(page0.html).servers);
  const ctx = await browser.newContext({ colorScheme, viewport: { width: 1440, height: 900 } });
  let seq = 0;
  const ids = new WeakMap();
  await ctx.exposeBinding("__n2cShimCall", (source, op, a) => {
    if (!ids.has(source.page)) ids.set(source.page, ++seq);
    return be.handle(op, a, ids.get(source.page));
  });
  await ctx.addInitScript(`window.__n2cShimConfig = ${JSON.stringify({ deny: deny ?? [] })};\n${SHIM}`);
  return { ctx, be };
}
async function open(ctx, name, { ready = true } = {}) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => consoleErrors.push(`${name}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(`${name}: ${m.text()}`));
  await page.goto(`${BASE}/page/${name}`);
  if (ready) await page.waitForFunction(() => window.n2cApp?.driver && !document.getElementById("run-now").disabled, null, { timeout: 10000 });
  return page;
}
async function runAndWait(page, { dry = true, message } = {}) {
  await page.evaluate((d) => { const c = document.getElementById("dry-run"); if (c.checked !== d) c.click(); }, dry);
  if (message !== undefined) await page.fill("#chat-input", message);
  await page.click("#run-now");
  await page.waitForFunction(() => document.getElementById("run-now").textContent === "Run now", null, { timeout: 20000 });
  return page.evaluate(() => ({ statuses: Object.fromEntries(Object.entries(window.n2cApp.view.statuses).map(([k, v]) => [k, v.status])), full: window.n2cApp.view.statuses, effects: window.n2cApp.view.effects, summary: document.getElementById("run-summary").textContent, banner: document.getElementById("banner").hidden ? "" : document.getElementById("banner").textContent }));
}
const slackArgs = (effects) => effects.filter((e) => e.effect === "write" && e.request.tool === "slack_send_message").map((e) => e.request.args);

// 1. graph
await check("graph renders every step at its n8n position", async () => {
  const { ctx } = await context("slice");
  const page = await open(ctx, "slice");
  const nodes = await page.$$eval("#graph g.node", (gs) => gs.map((g) => ({ step: g.getAttribute("data-step"), t: g.getAttribute("transform") })));
  const steps = Object.entries(pages.slice.def.steps);
  assert.equal(nodes.length, steps.length);
  for (const [name, s] of steps) assert.equal(nodes.find((n) => n.step === name)?.t, `translate(${s.n8n.position[0]},${s.n8n.position[1]})`, name);
  const vb = await page.$eval("#graph", (g) => g.getBoundingClientRect().width);
  assert.ok(vb > 300, "graph fits the panel width");
  await ctx.close();
  return `${nodes.length} nodes; sub-node ${(await Promise.resolve(pages.slice.def.subnodes.length))} drawn as circle`;
});

// 2. dry run
let dryRecordShown;
await check("Run now in dry run: statuses, would-send args equal the in-process runner, record in history", async () => {
  const { ctx, be } = await context("slice");
  const page = await open(ctx, "slice");
  const r = await runAndWait(page, { dry: true });
  assert.deepEqual(r.statuses, { "Every morning": "done", "Get unread mail": "done", Summarise: "done", "Anthropic Chat Model": "done", "Post to Slack": "would-send" });
  assert.deepEqual(slackArgs(r.effects), refSlack, "would-send args differ from the in-process runner");
  assert.equal(be.log.tools.filter((t) => t.tool === "slack_send_message").length, 0, "a dry run sent a write");
  assert.deepEqual(be.log.tools.map((t) => [t.tool, t.args]), [["search_threads", { query: "newer_than:1d is:unread", pageSize: 10 }]]);
  assert.equal(be.log.samples.length, 2);
  // the step panel shows the same arguments
  await page.click('#graph g.node[data-step="Post to Slack"]');
  const shown = JSON.parse(await page.$eval("#detail details[open] pre", (p) => p.textContent));
  assert.deepEqual(shown.map((x) => x.args), refSlack);
  await page.waitForFunction(() => document.querySelectorAll("#history .hrow").length === 1, null, { timeout: 5000 });
  const runs = be.runs();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "done");
  assert.equal(runs[0].dryRun, true);
  assert.equal(runs[0].effects.wouldSend, 2);
  assert.deepEqual(runs[0].wouldSend.map((w) => w.args), refSlack);
  const hist = await page.$eval("#history .hrow", (b) => b.textContent);
  assert.match(hist, /done/);
  assert.match(hist, /2 would send/);
  dryRecordShown = r.summary;
  await ctx.close();
  return r.summary;
});

// 3. real run
await check("Run now with dry run off: ledger sending -> sent, the shim got exactly those arguments", async () => {
  const { ctx, be } = await context("slice");
  const page = await open(ctx, "slice");
  const r = await runAndWait(page, { dry: false });
  assert.equal(r.statuses["Post to Slack"], "done");
  const sent = be.log.tools.filter((t) => t.tool === "slack_send_message").map((t) => t.args);
  assert.deepEqual(sent, refSlack);
  const ledger = be.ledger();
  assert.equal(ledger.length, 2);
  for (const e of ledger) {
    assert.equal(e.status, "sent");
    assert.deepEqual(be.ledgerHistory(e.effectKey), ["sending", "sent"]);
  }
  const keys = r.effects.filter((e) => e.effect === "write").map((e) => e.effectKey).sort();
  assert.deepEqual(ledger.map((e) => e.effectKey).sort(), keys);
  const [rec] = be.runs();
  assert.equal(rec.effects.sent, 2);
  assert.equal(rec.dryRun, false);
  await ctx.close();
  return `${sent.length} sent, ledger ${ledger.map((e) => be.ledgerHistory(e.effectKey).join("->")).join(", ")}`;
});

// 4. lock
await check("a second Run now during a running run is refused by the lock", async () => {
  const { ctx, be } = await context("slice");
  be.ctl.delay.search_threads = 2500;
  const a = await open(ctx, "slice");
  const b = await open(ctx, "slice");
  await a.click("#run-now");
  await a.waitForFunction(() => document.getElementById("run-now").textContent === "Running…");
  await sleep(400);
  const same = await a.evaluate(() => window.n2cApp.runNow());
  assert.equal(same.refused, true);
  const other = await runAndWait(b, { dry: true });
  assert.match(other.banner, /refused/i);
  assert.match(other.banner, /lock/i);
  await a.waitForFunction(() => document.getElementById("run-now").textContent === "Run now", null, { timeout: 15000 });
  assert.equal(be.runs().length, 1, "only the first run ran");
  assert.equal(be.log.tools.filter((t) => t.page === 2).length, 0, "the refused page made no connector call");
  // A lock written by a scheduled task (no lease, via: "task") blocks until its expiry, then breaks.
  const c = await open(ctx, "slice");
  be.docs.set("lock/run", { format: 1, holder: "task-1", kind: "scheduled", runId: "t-1", via: "task", acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(), released: false });
  be.leases.clear();
  const held = await runAndWait(c, { dry: true });
  assert.match(held.banner, /scheduled run holds the lock/);
  be.docs.set("lock/run", { ...be.docs.get("lock/run"), expiresAt: new Date(Date.now() - 1000).toISOString() });
  const broke = await runAndWait(c, { dry: true });
  assert.equal(broke.banner, "");
  assert.match(broke.summary, /done/);
  await ctx.close();
  return `same page: "${same.message}"; other page: refused; stale task lock broken`;
});

// 5. tampered definition
await check("a tampered embedded definition fails preflight and nothing is sent", async () => {
  const { ctx, be } = await context("slice");
  const page = await open(ctx, "tampered");
  const pre = await page.$eval("#banner", (b) => b.textContent);
  assert.match(pre, /does not match the hash/);
  const r = await runAndWait(page, { dry: false });
  assert.match(r.banner, /does not match the hash/);
  assert.equal(be.log.tools.length, 0, "a connector was called");
  assert.equal(be.log.samples.length, 0, "Claude was asked");
  assert.equal(be.ledger().length, 0);
  assert.equal(be.runs()[0]?.status, "preflight-failed");
  await ctx.close();
  return "0 connector calls, record preflight-failed";
});

// 6. http handoff
await check("a workflow with an http step stops at it with handoff", async () => {
  const { ctx, be } = await context("poll");
  const page = await open(ctx, "poll");
  const flag = await page.$eval('#graph g.node[data-step="Notify accounts"] .flag', (t) => t.textContent);
  assert.match(flag, /task only/);
  const r = await runAndWait(page, { dry: true });
  assert.equal(r.statuses["Notify accounts"], "handoff");
  assert.equal(r.statuses["New invoice email"], "done");
  assert.equal(r.statuses["Extract amount"], "done");
  const [rec] = be.runs();
  assert.equal(rec.status, "handoff");
  assert.equal(rec.handoff.step, "Notify accounts");
  assert.equal(rec.effects.wouldSend, 0, "the pending http write counted as would-send");
  assert.deepEqual({ method: rec.handoff.request.method, url: rec.handoff.request.url, secret: rec.handoff.request.secret }, { method: "POST", url: "https://api.accounts.example.com/v1/invoices", secret: "Accounts API key" });
  assert.match(r.banner, /Stopped at Notify accounts/);
  assert.equal([...be.docs.keys()].some((k) => k.startsWith("cursors/")), false, "a dry run saved a cursor");
  await ctx.close();
  return `record status ${rec.status} at ${rec.handoff.step}`;
});

// 7. interrupted send
await check("a send cut off mid-call is shown as unknown on resume and never resent on its own", async () => {
  const { ctx, be } = await context("slice");
  be.ctl.hang.add("slack_send_message");
  const a = await open(ctx, "slice");
  await a.evaluate(() => { const c = document.getElementById("dry-run"); if (c.checked) c.click(); });
  await a.click("#run-now");
  const deadline = Date.now() + 10000;
  while (!be.ledger().some((e) => e.status === "sending") && Date.now() < deadline) await sleep(100);
  assert.ok(be.ledger().some((e) => e.status === "sending"), "no ledger entry went to sending");
  await a.close();
  // the page went away: its lease and the lock body expire
  be.ctl.hang.clear();
  be.leases.clear();
  be.docs.set("lock/run", { ...be.docs.get("lock/run"), expiresAt: new Date(Date.now() - 1000).toISOString() });
  const b = await open(ctx, "slice");
  await b.waitForFunction(() => [...document.querySelectorAll("#history .pill")].some((p) => p.textContent === "interrupted"), null, { timeout: 5000 });
  await b.click("#history .actions button");
  await b.waitForFunction(() => document.getElementById("run-now").textContent === "Run now" && window.n2cApp.view.unknown?.length, null, { timeout: 10000 });
  const detail = await b.$eval("#detail", (d) => d.textContent);
  assert.match(detail, /Unknown: check before re-sending/);
  assert.equal(be.log.tools.filter((t) => t.tool === "slack_send_message").length, 1, "the unknown write was resent");
  assert.equal(be.runs()[0].status, "needs-check");
  // The person checked: it went out. The run goes on and sends only the second message.
  await b.click("text=It was sent: continue without sending");
  await b.waitForFunction(() => document.getElementById("run-now").textContent === "Run now" && /done/.test(document.getElementById("run-summary").textContent), null, { timeout: 10000 });
  const slack = be.log.tools.filter((t) => t.tool === "slack_send_message").map((t) => t.args);
  assert.deepEqual(slack, refSlack, "each message went out exactly once");
  assert.equal(be.runs()[0].status, "done");
  await ctx.close();
  return "1 unknown, 0 resent, then 1 more sent after the person's choice";
});

// 8. agent
await check("chat agent: sample answers turns, tool-call intents run through the runner, write is would-send", async () => {
  const { ctx, be } = await context("agent");
  const page = await open(ctx, "agent");
  const r = await runAndWait(page, { dry: true, message: "What did Ann send? Post it." });
  assert.equal(r.statuses["AI Agent"], "done");
  assert.equal(r.statuses["Search mail"], "done");
  assert.equal(r.statuses["Post to Slack"], "would-send");
  assert.equal(r.statuses["Anthropic Chat Model"], "done");
  assert.deepEqual(be.log.tools.map((t) => [t.tool, t.args]), [["search_threads", { query: "from:ann is:unread", pageSize: 5 }]]);
  const refWrite = refAgent.effects.filter((e) => e.effect === "write").map((e) => e.request.args);
  assert.deepEqual(slackArgs(r.effects), refWrite);
  assert.deepEqual(refWrite, [{ channel_id: "C0123456789", message: "Ann wrote: Invoice 42" }]);
  assert.equal(be.log.samples.length, 3);
  assert.ok(be.log.samples.every((s) => s.json && !s.input.includes("slack_send_message") && !s.input.includes("search_threads")), "the model saw connector tool names");
  const output = await page.evaluate(() => window.n2cApp.view.runData["AI Agent"][0].data.main[0][0].json);
  assert.deepEqual(output, { output: "Posted. Last tool said ok=true" });
  await ctx.close();
  return `3 sample turns, 1 read through mcp, 1 would-send`;
});

// 9a. form
await check("form: fields per type, validation, submit runs with the form item; hand-off stores the submission", async () => {
  const notes = [];
  // Every field type renders as its control; the submitted item is n8n's Form Trigger item.
  {
    const { ctx, be } = await context("formAll");
    const page = await open(ctx, "formAll");
    assert.equal(await page.$eval("#run-now", (b) => b.hidden), true, "a form page submits instead of Run now");
    const kinds = await page.$$eval("#form-fields .field", (fs) => fs.map((f) => { const c = f.querySelector("input:not([type=checkbox]), select, textarea"); return c ? (c.tagName === "INPUT" ? c.type : c.tagName.toLowerCase()) : f.querySelector("input[type=checkbox]") ? "checkbox" : "?"; }));
    assert.deepEqual(kinds, ["text", "number", "email", "date", "select", "textarea", "checkbox"]);
    await page.click("#form-submit");
    await page.waitForFunction(() => /Check the marked fields/.test(document.getElementById("form-note").textContent));
    const errs = await page.$$eval(".field[data-invalid]", (fs) => fs.map((f) => f.getAttribute("data-label")));
    assert.deepEqual(errs, ["Name", "Seats", "Agree"]);
    assert.equal(be.runs().length, 0, "an invalid form ran nothing");
    await page.fill("#ff-0", "Ann");
    await page.fill("#ff-1", "3");
    await page.fill("#ff-2", "not-an-email");
    await page.click("#form-submit");
    await page.waitForFunction(() => document.querySelector('.field[data-label="Email"]')?.hasAttribute("data-invalid"));
    await page.fill("#ff-2", "ann@example.com");
    await page.fill("#ff-3", "2026-12-01");
    await page.selectOption("#ff-4", "Sales");
    await page.fill("#ff-5", "Window seat");
    await page.check('.field[data-label="Agree"] input[type=checkbox]');
    await page.click("#form-submit");
    await page.waitForFunction(() => /Dry run done/.test(document.getElementById("form-note").textContent), null, { timeout: 15000 });
    const item = await page.evaluate(() => window.n2cApp.view.runData.Tag[0].data.main[0][0].json);
    const { submittedAt, ...rest } = item;
    assert.deepEqual(rest, { Name: "Ann", Seats: 3, Email: "ann@example.com", Start: "2026-12-01", Team: "Sales", Notes: "Window seat", Agree: ["Yes"], formMode: "production", source: "form" });
    assert.ok(Number.isFinite(Date.parse(submittedAt)));
    assert.equal(be.runs()[0].status, "done");
    assert.ok(be.runs()[0].submissionId);
    for (const width of [375, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await sleep(150);
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      assert.ok(m.sw <= m.cw, `form ${width}: horizontal scroll`);
      await page.screenshot({ path: join(OUT, "shots", `form-${width}-light.png`), fullPage: true });
    }
    await ctx.close();
    notes.push("7 field types, 3 required errors, item exact");
  }
  // In-artifact form: dry run holds the send; live sends it once through mcp with a ledger entry.
  {
    const { ctx, be } = await context("form");
    const page = await open(ctx, "form");
    await page.fill("#ff-0", "bo@example.com");
    await page.fill("#ff-1", "Hello there");
    await page.click("#form-submit");
    await page.waitForFunction(() => /Dry run done/.test(document.getElementById("form-note").textContent), null, { timeout: 15000 });
    assert.equal(be.log.tools.length, 0);
    assert.equal(be.runs()[0].wouldSend[0].args.subject, "New message from bo@example.com");
    await page.evaluate(() => document.getElementById("dry-run").click());
    await page.fill("#ff-0", "bo@example.com");
    await page.click("#form-submit");
    await page.waitForFunction(() => document.getElementById("form-note").textContent === "Submitted.", null, { timeout: 15000 });
    assert.deepEqual(be.log.tools.map((t) => [t.tool, t.args.to, t.args.subject]), [["send_message", ["team@example.com"], "New message from bo@example.com"]]);
    assert.deepEqual(be.ledgerHistory(be.ledger()[0].effectKey), ["sending", "sent"]);
    await ctx.close();
    notes.push("in-artifact: 1 held, 1 sent");
  }
  // Hand-off form (its Sheets step needs a task): the submission is stored, nothing runs here.
  {
    const { ctx, be } = await context("formHandoff");
    const page = await open(ctx, "formHandoff");
    assert.match(await page.$eval("#form-submit", (b) => b.textContent), /scheduled task/);
    assert.match(await page.$eval("#mode-note", (n) => n.textContent), /run by the scheduled cloud task/);
    await page.fill("#ff-0", "12.5");
    await page.click("#form-submit");
    await page.waitForFunction(() => !document.getElementById("banner").hidden && /Submitted/.test(document.getElementById("banner").textContent));
    const subs = [...be.docs].filter(([p]) => p.startsWith("submissions/")).map(([, d]) => d);
    assert.equal(subs.length, 1);
    assert.deepEqual([subs[0].status, subs[0].trigger, subs[0].item.Amount, subs[0].item.formMode], ["new", "Expense form", 12.5, "production"]);
    assert.match(await page.$eval("#banner", (b) => b.textContent), /processes it at its next run/);
    assert.equal(be.runs().length, 0);
    assert.equal(be.log.tools.length + be.log.samples.length, 0);
    assert.deepEqual(pages.formHandoff.caps.db.rules, [{ path: "", read: "admin", write: "admin" }, { path: "submissions", read: "admin", write: "interact" }]);
    await page.screenshot({ path: join(OUT, "shots", "form-handoff-1440-light.png"), fullPage: true });
    await ctx.close();
    notes.push("hand-off: 1 submission stored, 0 runs");
  }
  return notes.join("; ");
});

// 9b. missed runs in the history
await check("missed scheduled runs show in the history", async () => {
  const { ctx, be } = await context("slice");
  const lastRunAt = new Date(Date.now() - 3 * 86400000 - 3600000).toISOString();
  be.docs.set("runs/t-old", { format: 1, runId: "t-old", trigger: "scheduled", driver: "task", status: "done", dryRun: false, startedAt: lastRunAt, effects: { reads: 1, writes: 2, sent: 2, wouldSend: 0, unknown: 0 }, steps: {} });
  const want = missedRuns({ schedule: definitionSchedule(pages.slice.def), lastRunAt, now: Date.now() }).count;
  assert.ok(want >= 3, `expected at least 3 missed, computed ${want}`);
  const page = await open(ctx, "slice");
  await page.waitForFunction(() => document.querySelector("#history .hmissed"), null, { timeout: 5000 });
  const text = await page.$eval("#history .hmissed", (x) => x.textContent);
  assert.match(text, new RegExp(`missed\\s*${want} scheduled runs did not happen`));
  await ctx.close();
  return text.replace(/\s+/g, " ").slice(0, 80);
});

// 9. no runtime: read-only page
await check("outside Claude (no capabilities) the page renders read-only", async () => {
  const { ctx } = await context("slice", { deny: ["mcp", "sample", "db"] });
  const page = await open(ctx, "slice", { ready: false });
  await page.waitForFunction(() => !document.getElementById("banner").hidden, null, { timeout: 5000 });
  assert.match(await page.$eval("#banner", (b) => b.textContent), /Read-only here/);
  assert.equal(await page.$eval("#run-now", (b) => b.disabled), true);
  await ctx.close();
});

// 10. screenshots and layout
await check("screenshots at 375, 768, 1440, 1915 px in light and dark; no horizontal scroll; list view on phones", async () => {
  const notes = [];
  for (const scheme of ["light", "dark"]) {
    const { ctx } = await context("slice", { colorScheme: scheme });
    const page = await open(ctx, "slice");
    await runAndWait(page, { dry: true });
    await page.evaluate(() => window.n2cApp.select("Post to Slack"));
    for (const width of [375, 768, 1440, 1915]) {
      await page.setViewportSize({ width, height: 900 });
      await sleep(150);
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, svg: getComputedStyle(document.getElementById("canvas")).display, list: getComputedStyle(document.getElementById("steplist")).display }));
      assert.ok(m.sw <= m.cw, `${scheme} ${width}: horizontal scroll (${m.sw} > ${m.cw})`);
      if (width < 600) assert.deepEqual([m.svg, m.list], ["none", "block"], "phone width shows the list view");
      else assert.equal(m.svg, "block");
      await page.screenshot({ path: join(OUT, "shots", `slice-${width}-${scheme}.png`), fullPage: true });
    }
    notes.push(scheme);
    await ctx.close();
  }
  for (const [name, which] of [["poll", "poll"], ["agent", "agent"]]) {
    const { ctx } = await context(which);
    const page = await open(ctx, name);
    await runAndWait(page, { dry: true, message: which === "agent" ? "What did Ann send? Post it." : undefined });
    await page.screenshot({ path: join(OUT, "shots", `${name}-1440-light.png`), fullPage: true });
    await ctx.close();
  }
  return `${join(OUT, "shots")}`;
});

await check("no page errors, no request outside the page", async () => {
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(extFetches.filter((u) => u !== "/favicon.ico"), []);
});

await browser.close();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Page size: ${(Buffer.byteLength(pages.slice.html) / 1024).toFixed(0)} KB (slice).`);
process.exitCode = failed.length ? 1 : 0;
