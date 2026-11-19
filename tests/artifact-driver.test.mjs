// The artifact driver (runtime/src/artifact-driver.mjs) against an in-memory artifact runtime,
// the shared records (records.mjs) and the page the converter emits. The browser run of the
// same page is evals/artifact/check.mjs (Playwright), not a test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as core from "../skills/n8n-to-claude/runtime/src/index.mjs";
import { createArtifactDriver, composeModelInput, agentValue, mcpPayload } from "../skills/n8n-to-claude/runtime/src/artifact-driver.mjs";
import { convertItems, writeFolder, loadReferences, artifactCapabilities, artifactServers } from "../skills/n8n-to-claude/scripts/convert.mjs";
import { loadInput } from "../skills/n8n-to-claude/scripts/analyze.mjs";
import { toolHost, modelHost } from "./convert-mocks.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = join(ROOT, "tests/fixtures/convert");
const refs = loadReferences();
const NOW = Date.parse("2026-11-14T00:00:00Z");
const defOf = (name) => convertItems(loadInput(join(FIX, `${name}.n8n.json`)).items, { refs, now: NOW })[0].definition;

// ---------- an in-memory artifact runtime (the call shapes of references/artifact-runtime.md) ----------
function fakeRuntime(def, { hang = new Set(), fail = {} } = {}) {
  const servers = artifactServers(def, refs);
  const docs = new Map();
  const leases = new Map();
  const log = { tools: [], samples: [], ledger: [] };
  const host = toolHost([]);
  const parent = (p) => p.split("/").slice(0, -1).join("/");
  const ref = (path) => ({
    path,
    async get() {
      const d = docs.get(path);
      return { id: path.split("/").pop(), exists: !!d, data: () => (d ? structuredClone(d) : undefined) };
    },
    async set(data) {
      docs.set(path, structuredClone(data));
      if (path.startsWith("ledger/")) log.ledger.push([path.slice(7), data.status]);
    },
    async update(data) {
      if (!docs.has(path)) throw { code: "invalid_argument", message: "missing" };
      docs.set(path, { ...docs.get(path), ...structuredClone(data) });
    },
    async delete() {
      docs.delete(path);
    },
    async acquire({ holder, ttlMs }) {
      const l = leases.get(path);
      if (l && l.until > Date.now() && l.holder !== holder) return { acquired: false, expiresAt: new Date(l.until).toISOString() };
      leases.set(path, { holder, until: Date.now() + (ttlMs || 30000) });
      return { acquired: true, holder, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
    },
  });
  const query = (path, spec = {}) => ({
    orderBy: (field, dir) => query(path, { ...spec, field, dir }),
    limit: (n) => query(path, { ...spec, n }),
    async get() {
      let rows = [...docs].filter(([p]) => parent(p) === path);
      if (spec.field) rows.sort((a, b) => (a[1][spec.field] < b[1][spec.field] ? -1 : 1) * (spec.dir === "desc" ? -1 : 1));
      if (spec.n) rows = rows.slice(0, spec.n);
      return { docs: rows.map(([p, d]) => ({ id: p.split("/").pop(), exists: true, data: () => structuredClone(d) })) };
    },
  });
  const mcp = {
    async listTools() {
      return { servers: Object.values(servers).map((server) => ({ server, authStatus: "connected", tools: def.allow.tools.filter((t) => servers[t.connector] === server).map((t) => ({ name: t.tool, description: "" })) })) };
    },
    async callTool(server, tool, input) {
      const connector = Object.keys(servers).find((c) => servers[c] === server);
      log.tools.push({ connector, tool, args: input });
      if (hang.has(tool)) return new Promise(() => {});
      if (fail[tool]) throw fail[tool];
      const value = await host({ connector, tool, args: input });
      return { content: [{ type: "text", text: JSON.stringify(value) }], payload: value };
    },
  };
  const block = (input, label) => new RegExp(`----- ${label} -----\\n([\\s\\S]*?)\\n----- END ${label} -----`).exec(input)?.[1] ?? "";
  const sample = async (input) => {
    log.samples.push(input);
    return { text: `Summary: ${block(input, "PROMPT").split("\n")[0].slice(0, 40)}`, truncated: false };
  };
  sample.json = async (input) => {
    log.samples.push(input);
    return { final: "ok" };
  };
  return { rt: { mcp, sample, db: { doc: ref, collection: (p) => query(p) } }, servers, docs, leases, log };
}
const driverFor = (def, fake, extra = {}) => createArtifactDriver({ core, definition: def, embeddedHash: core.definitionHash(def), commit: "test", servers: fake.servers, rt: fake.rt, ...extra });
async function referenceSlack(def) {
  const calls = [];
  const r = await core.run(def, { clock: { startedAt: "2026-11-14T03:00:00Z" }, virtualTime: true, mode: "manual", host: { tool: toolHost(calls), model: modelHost() } });
  assert.equal(r.status, "done");
  return calls.filter((c) => c.tool === "slack.slack_send_message").map((c) => c.args);
}

test("dry run: reads run, writes are held with the exact arguments the in-process runner computes", async () => {
  const def = defOf("slice");
  const fake = fakeRuntime(def);
  const res = await driverFor(def, fake).runNow({ dryRun: true });
  assert.equal(res.status, "done");
  assert.deepEqual(fake.log.tools.map((t) => t.tool), ["search_threads"]);
  assert.equal(fake.log.samples.length, 2);
  const rec = res.record;
  assert.deepEqual(rec.wouldSend.map((w) => w.args), await referenceSlack(def));
  assert.equal(rec.effects.wouldSend, 2);
  assert.deepEqual(Object.fromEntries(Object.entries(rec.steps).map(([k, v]) => [k, v.status])), { "Every morning": "done", "Get unread mail": "done", Summarise: "done", "Anthropic Chat Model": "done", "Post to Slack": "would-send" });
  assert.deepEqual(fake.docs.get(core.runPath(rec.runId)), rec);
  assert.equal([...fake.docs.keys()].some((k) => k.startsWith("ledger/") || k.startsWith("cursors/")), false, "a dry run wrote the ledger or a cursor");
  assert.equal(fake.docs.has(core.statePath(rec.runId)), false, "the resume state is dropped when the run ends");
  assert.equal(fake.docs.get(core.LOCK_PATH).released, true);
});

test("real run: each write is in the ledger as sending before it goes out and sent after", async () => {
  const def = defOf("slice");
  const fake = fakeRuntime(def);
  const res = await driverFor(def, fake).runNow({ dryRun: false });
  assert.equal(res.status, "done");
  assert.deepEqual(fake.log.tools.filter((t) => t.tool === "slack_send_message").map((t) => t.args), await referenceSlack(def));
  const keys = [...new Set(fake.log.ledger.map(([k]) => k))];
  assert.equal(keys.length, 2);
  for (const k of keys) assert.deepEqual(fake.log.ledger.filter(([x]) => x === k).map(([, s]) => s), ["sending", "sent"]);
  assert.equal(res.record.effects.sent, 2);
});

test("an http step stops the run with handoff and the pending request, without secret values", async () => {
  const def = defOf("poll-code-http");
  const fake = fakeRuntime(def);
  const res = await driverFor(def, fake).runNow({ dryRun: true });
  assert.equal(res.status, "handoff");
  assert.equal(res.record.handoff.step, "Notify accounts");
  assert.deepEqual(res.record.handoff.request, { kind: "http", step: "Notify accounts", method: "POST", url: "https://api.accounts.example.com/v1/invoices", secret: "Accounts API key", body: { from: '"Ann Lee" <ann@example.com>', subject: "Invoice 42", amount: 250 } });
  assert.equal(res.record.effects.wouldSend, 0);
  assert.equal(res.record.steps["Notify accounts"].status, "handoff");
});

test("preflight fails closed: tampered definition, missing connector, task on another definition", async () => {
  const def = defOf("slice");
  const fake = fakeRuntime(def);
  const tampered = createArtifactDriver({ core, definition: def, embeddedHash: "0".repeat(64), servers: fake.servers, rt: fake.rt });
  const res = await tampered.runNow({ dryRun: false });
  assert.equal(res.status, "preflight-failed");
  assert.match(res.record.error.message, /does not match the hash/);
  assert.deepEqual(fake.log.tools, []);
  const missing = fakeRuntime(def);
  missing.rt.mcp.listTools = async () => ({ servers: [{ server: "Gmail", authStatus: "connected", tools: [{ name: "search_threads" }] }] });
  const pf = await driverFor(def, missing).preflight();
  assert.equal(pf.ok, false);
  assert.match(pf.issues.find((i) => i.level === "error").message, /Slack is not connected/);
  const other = fakeRuntime(def);
  other.docs.set(core.META_CURRENT, { definitionHash: "f".repeat(64) });
  assert.match((await driverFor(def, other).preflight()).issues[0].message, /scheduled task runs a different definition/);
  const noDb = fakeRuntime(def);
  delete noDb.rt.db;
  const refused = await driverFor(def, noDb).runNow({ dryRun: false });
  assert.equal(refused.refused, true, "a real run needs the db for the lock and ledger");
});

test("lock: a lease held elsewhere or a live task lock refuses Run now; an expired task lock is broken", async () => {
  const def = defOf("slice");
  const fake = fakeRuntime(def);
  fake.leases.set(core.LOCK_PATH, { holder: "other-tab", until: Date.now() + 30000 });
  assert.match((await driverFor(def, fake).runNow()).message, /Another run holds the lock/);
  fake.leases.clear();
  fake.docs.set(core.LOCK_PATH, core.lockBody({ holder: "task", kind: "scheduled", runId: "t1", now: Date.now(), ttlMs: 600000, via: "task" }));
  assert.match((await driverFor(def, fake).runNow()).message, /scheduled run holds the lock/);
  fake.docs.set(core.LOCK_PATH, core.lockBody({ holder: "task", kind: "scheduled", runId: "t1", now: Date.now() - 700000, ttlMs: 600000, via: "task" }));
  assert.equal((await driverFor(def, fake).runNow()).status, "done");
});

test("an ambiguous write failure leaves the ledger at sending: the run stops and a resume never resends on its own", async () => {
  const def = defOf("slice");
  const fake = fakeRuntime(def, { fail: { slack_send_message: { code: "server_unavailable", message: "timeout", retryable: true } } });
  const d = driverFor(def, fake);
  const res = await d.runNow({ dryRun: false });
  assert.equal(res.status, "needs-check");
  assert.equal(res.record.unknown.length, 1);
  const key = res.record.unknown[0].effectKey;
  assert.equal(fake.docs.get(core.ledgerPath(key)).status, "sending");
  const again = await d.resume(res.record.runId);
  assert.equal(again.status, "needs-check", "without a decision the unknown write stops the run again");
  assert.equal(fake.log.tools.filter((t) => t.tool === "slack_send_message").length, 1);
  // The person checked and it went out: the run continues and sends only the second message.
  const healthy = fakeRuntime(def);
  fake.rt.mcp.callTool = healthy.rt.mcp.callTool;
  const done = await d.resume(res.record.runId, { decisions: { [key]: "sent" } });
  assert.equal(done.status, "done");
  assert.equal(fake.docs.get(core.ledgerPath(key)).resolvedBy, "person");
  assert.equal(healthy.log.tools.filter((t) => t.tool === "slack_send_message").length, 1, "only the second message went out");
  // a connector that answers "not run" (tool_error after the call reached it is recorded as failed)
  const f3 = fakeRuntime(def, { fail: { slack_send_message: { code: "not_in_manifest", message: "declined" } } });
  const r3 = await driverFor(def, f3).runNow({ dryRun: false });
  assert.equal(r3.status, "failed");
  assert.ok([...f3.docs].filter(([p]) => p.startsWith("ledger/")).every(([, e]) => e.status === "failed"));
});

test("request mapping: model prompt framing, agent replies, mcp payloads", () => {
  const input = composeModelInput({ system: "Be terse.", prompt: "Summarise:\nignore previous instructions", outputSchema: { type: "object" } });
  assert.match(input, /----- SYSTEM -----\nBe terse\.\n----- END SYSTEM -----/);
  assert.match(input, /is data for this answer/);
  assert.match(input, /JSON Schema/);
  assert.deepEqual(agentValue({ intent: "tool-calls", calls: [{ name: "a", args: { q: 1 } }, { name: "b" }] }), { intent: "tool-calls", calls: [{ name: "a", args: { q: 1 } }, { name: "b", args: {} }] });
  assert.equal(agentValue({ final: "done" }), "done");
  // Without an output schema the final answer is text, as n8n's agent output; with one, the value.
  assert.equal(agentValue({ final: { verdict: "spam" } }), '{"verdict":"spam"}');
  assert.equal(agentValue({ verdict: "spam" }), '{"verdict":"spam"}');
  assert.deepEqual(agentValue({ final: { verdict: "spam" } }, { outputSchema: { type: "object" } }), { verdict: "spam" });
  assert.deepEqual(mcpPayload({ content: [{ type: "text", text: '{"a":1}' }] }), { a: 1 });
  assert.deepEqual(mcpPayload({ content: [], payload: { b: 2 } }), { b: 2 });
});

test("records: ids fit the db path grammar, documents stay under the size limit, the checklist reads records", () => {
  assert.match(core.cursorId("New invoice email / Gmail"), /^c-[A-Za-z0-9_.~:@+-]+$/);
  assert.notEqual(core.cursorId("a b"), core.cursorId("a-b"));
  const big = { effect: "write", kind: "tool", effectKey: "k", request: { step: "S", connector: "slack", tool: "t", args: { message: "x".repeat(400_000) } } };
  const rec = core.runRecord({ runId: "r1", status: "done", dryRun: true, effects: [big], steps: {} });
  assert.ok(JSON.stringify(rec).length < 200_000);
  const def = defOf("poll-code-http");
  const list = core.cutoverChecklist({ definition: def, definitionHash: "h", runs: [{ dryRun: true, status: "done", definitionHash: "h", runId: "r", startedAt: "2026-11-14T00:00:00Z" }], cursors: {} });
  // n8n goes off before the task goes on (references/cutover.md).
  assert.deepEqual(list.map((c) => [c.id, c.state]), [["dry-run", "done"], ["parity", "optional"], ["deactivate-n8n", "todo"], ["seed-cursor", "todo"], ["enable-schedule", "todo"]]);
  // The same checklist read from the cutover log; a rollback starts a new round.
  const e = (step, at, detail = {}) => core.cutoverEntry({ step, at, detail });
  const log = [e("dry-run", "2026-11-14T01:00:00.000Z", { runId: "d1", definitionHash: "h" }), e("deactivate-n8n", "2026-11-14T01:01:00.000Z", { via: "api", cursor: true }), e("seed", "2026-11-14T01:02:00.000Z", { source: "n8n" }), e("enable", "2026-11-14T01:03:00.000Z")];
  const states = (l, runs = []) => core.cutoverChecklist({ definition: def, definitionHash: "h", runs, log: l }).map((c) => c.state);
  assert.deepEqual(states(log), ["done", "optional", "done", "done", "done"]);
  assert.deepEqual(states([...log, e("rollback", "2026-11-14T02:00:00.000Z")]), ["todo", "optional", "todo", "todo", "todo"], "a dry run before the rollback no longer counts");
  assert.deepEqual(states([e("seed", "2026-11-14T01:00:00.000Z", { source: "dry-run" }), e("deactivate-n8n", "2026-11-14T01:01:00.000Z")]).slice(2, 4), ["done", "todo"], "a seed older than the deactivation is stale");
  assert.equal(core.cutoverPath("2026-11-14T01:00:00.000Z", "deactivate-n8n"), "cutover/20261114T010000000Z-deactivate-n8n");
  assert.equal(core.cutoverOwner({ owner: "n8n" }), "n8n");
  assert.equal(core.cutoverOwner(null), null);
  assert.equal(core.lockBlocks(core.lockBody({ holder: "x", kind: "manual", now: Date.now() }), { now: Date.now(), holder: "y" }), false, "a page-written lock is governed by its lease");
});

test("convert writes artifact.html with the definition, its hash and the runtime inlined, and the capabilities beside it", () => {
  const dir = mkdtempSync(join(tmpdir(), "n2c-artifact-"));
  for (const name of ["slice", "chat-agent", "poll-code-http", "subflow-merge"]) {
    const [res] = convertItems(loadInput(join(FIX, `${name}.n8n.json`)).items, { refs, now: NOW });
    const folder = writeFolder(dir, res, { refs });
    const html = readFileSync(join(folder, "artifact.html"), "utf8");
    const def = JSON.parse(readFileSync(join(folder, "definition.json"), "utf8"));
    const embedded = JSON.parse(/<script type="application\/json" id="n2c-definition">([^<]*)<\/script>/.exec(html)[1]);
    const build = JSON.parse(/<script type="application\/json" id="n2c-build">([^<]*)<\/script>/.exec(html)[1]);
    assert.deepEqual(embedded, def, name);
    assert.equal(build.definitionHash, core.definitionHash(def));
    assert.equal(html.includes("__N2C_"), false, `${name}: an unfilled marker`);
    assert.equal(/<script[^>]+src=/i.test(html), false, `${name}: an external script`);
    assert.ok(html.includes(readFileSync(join(ROOT, "skills/n8n-to-claude/runtime/dist/artifact-runtime.js"), "utf8")));
    assert.match(html.slice(0, 8192), /<title>[^<]+<\/title>/);
    assert.deepEqual(JSON.parse(readFileSync(join(folder, "artifact.capabilities.json"), "utf8")), artifactCapabilities(def, refs));
  }
  const caps = artifactCapabilities(defOf("slice"), refs);
  assert.deepEqual(caps, { mcp: { servers: [{ server: "Gmail", tools: ["search_threads"] }, { server: "Slack", tools: ["slack_send_message"] }] }, sample: {}, db: { rules: [{ path: "", read: "admin", write: "admin" }] } });
  assert.deepEqual(artifactCapabilities(defOf("subflow-merge"), refs), { db: { rules: [{ path: "", read: "admin", write: "admin" }] } });
  rmSync(dir, { recursive: true, force: true });
});

test("with the person's server (gateway), an http step goes to its n2c_http instead of a handoff; a dry run holds the write", async () => {
  const { createGateway, loadFolders } = await import("../skills/n8n-to-claude/scripts/gateway.mjs");
  const { handleRpc } = await import("../skills/n8n-to-claude/scripts/serve.mjs");
  const dir = mkdtempSync(join(tmpdir(), "n2c-art-gw-"));
  try {
    const [res] = convertItems(loadInput(join(FIX, "poll-code-http.n8n.json")).items, { refs, now: NOW });
    const slug = writeFolder(dir, res, { refs, server: "n8n workflows" }).split("/").pop();
    const def = JSON.parse(readFileSync(join(dir, slug, "definition.json"), "utf8"));
    const caps = JSON.parse(readFileSync(join(dir, slug, "artifact.capabilities.json"), "utf8"));
    assert.deepEqual(caps.mcp.servers.find((s) => s.server === "n8n workflows"), { server: "n8n workflows", tools: ["n2c_http"] });
    assert.match(readFileSync(join(dir, slug, "artifact.html"), "utf8"), /"gateway":\{"server":"n8n workflows","workflow":"[\w-]+"\}/);
    const fetched = [];
    const fetch = async (url, init = {}) => {
      fetched.push({ url: String(url), auth: init.headers?.authorization });
      return new Response(JSON.stringify({ id: "inv-9" }), { status: 201, headers: { "content-type": "application/json" } });
    };
    const gw = createGateway({ core, folders: loadFolders(dir), secrets: (n) => (n === "Accounts API key" ? "sk-art-0123456789" : undefined), fetch, resolveHost: async () => ["93.184.216.34"], stateRoot: join(dir, ".n2c", "gateway") });
    const fake = fakeRuntime(def);
    const inner = fake.rt.mcp.callTool;
    let id = 0;
    fake.rt.mcp.callTool = async (server, tool, input, o) => {
      if (server !== "n8n workflows") return inner(server, tool, input, o);
      fake.log.tools.push({ connector: "gateway", tool, args: input });
      return (await handleRpc(gw, { jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: tool, arguments: input } })).result;
    };
    const gateway = { server: "n8n workflows", workflow: slug };
    const driver = driverFor(def, fake, { gateway });
    const dry = await driver.runNow({ dryRun: true });
    assert.equal(dry.status, "done", JSON.stringify(dry.record?.error));
    assert.equal(fetched.length, 0, "a dry run sends no http write");
    assert.equal(dry.record.effects.wouldSend, 1);
    const real = await driver.runNow({ dryRun: false });
    assert.equal(real.status, "done", JSON.stringify(real.record?.error));
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0].auth, "Bearer sk-art-0123456789", "the server added its key");
    assert.equal(new URL(fetched[0].url).hostname, "api.accounts.example.com");
    const call = fake.log.tools.find((t) => t.connector === "gateway");
    assert.equal(call.tool, "n2c_http");
    assert.equal(call.args.definitionHash, core.definitionHash(def));
    assert.equal(JSON.stringify(call.args).includes("sk-art"), false, "the page never sees the key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
