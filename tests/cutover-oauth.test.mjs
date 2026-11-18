// cutover.mjs over a sign-in (--login): n8n-oauth.mjs mcpN8nClient against a fake n8n MCP server
// over real HTTP. MCP cannot read or write static data, so: a workflow without a poll trigger
// cuts over and rolls back fully; Gmail's cursor comes from its executions; rollback of a poll
// trigger, and deactivation of one whose position only static data holds, are refused before
// anything in n8n changes. No network beyond 127.0.0.1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { convertItems, writeFolder, loadReferences } from "../skills/n8n-to-claude/scripts/convert.mjs";
import { loadInput } from "../skills/n8n-to-claude/scripts/analyze.mjs";
import { runStep } from "../skills/n8n-to-claude/scripts/cutover.mjs";
import { mcpN8nClient, CUTOVER_SCOPES } from "../skills/n8n-to-claude/scripts/n8n-oauth.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const refs = loadReferences();
const NOW = Date.parse("2026-11-14T00:00:00Z");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

function folderFor(file, mutate) {
  const dir = mkdtempSync(join(tmpdir(), "n2c-cut-mcp-"));
  const items = loadInput(join(ROOT, file)).items;
  if (mutate) mutate(items);
  const folders = convertItems(items, { refs, now: NOW }).map((res) => writeFolder(dir, res, { refs }));
  for (const f of folders) writeFileSync(join(f, "task.json"), JSON.stringify({ ...readJson(join(f, "task.json")), hooks: false, secrets: "env", store: { kind: "file" } }));
  return { dir, folder: folders[0] };
}

async function fakeMcp(wf, { executions = [], running = [] } = {}) {
  const log = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.headers.authorization !== "Bearer tok") return res.writeHead(401).end();
    const m = JSON.parse(body);
    if (m.method === "notifications/initialized") return res.writeHead(202).end();
    const answer = (result) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
    if (m.method === "initialize") return answer({ protocolVersion: "2025-06-18", capabilities: {} });
    const { name, arguments: a } = m.params;
    log.push([name, a]);
    const sc = (structuredContent) => answer({ structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent) }] });
    if (name === "get_workflow_details") return a.workflowId === wf.id ? sc({ workflow: wf }) : answer({ isError: true, content: [{ type: "text", text: "Workflow not found or you don't have permission to access it." }] });
    if (name === "unpublish_workflow") {
      wf.active = false;
      wf.activeVersionId = null;
      return sc({ success: true, workflowId: wf.id });
    }
    if (name === "publish_workflow") {
      wf.active = true;
      wf.activeVersionId = a.versionId ?? "draft";
      return sc({ success: true, workflowId: wf.id, activeVersionId: wf.activeVersionId });
    }
    if (name === "search_workflow_executions") return sc({ data: (a.status?.includes("running") ? running.splice(0) : executions).map((e) => ({ id: e.id, workflowId: wf.id, status: e.status ?? "success", mode: "trigger", startedAt: null, stoppedAt: null })), count: executions.length, estimated: false });
    if (name === "get_workflow_execution") {
      const e = executions.find((x) => x.id === a.executionId);
      return sc({ execution: { id: e.id, workflowId: wf.id, status: "success", mode: "trigger", startedAt: null, stoppedAt: null }, data: e.data });
    }
    answer({ isError: true, content: [{ type: "text", text: `no tool ${name}` }] });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let revoked = 0;
  const client = mcpN8nClient(async () => ({ base, token: "tok", done: async () => void revoked++ }), { sleep: async () => {} });
  return { wf, log, client, revoked: () => revoked, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

test("over a sign-in, a scheduled workflow cuts over and rolls back through publish/unpublish; the session is revoked after each step", async () => {
  const { dir, folder } = folderFor("tests/fixtures/convert/slice.n8n.json");
  const def = readJson(join(folder, "definition.json"));
  const n8n = await fakeMcp({ id: "sl1", name: def.name, active: true, activeVersionId: "v7", nodes: [], connections: {} }, { running: [{ id: "r1", status: "running" }] });
  const step = (name, flags = {}) => runStep(folder, name, { flags: { "n8n-id": "sl1", ...flags }, env: {}, n8n: n8n.client });
  try {
    const de = await step("deactivate-n8n", { force: true });
    assert.equal(de.code, 0, de.text);
    assert.equal(n8n.wf.activeVersionId, null);
    assert.ok(n8n.log.some(([t, a]) => t === "search_workflow_executions" && a.status?.includes("running")), "waited for running executions");
    assert.equal(readJson(join(folder, ".n2c/records/meta/cutover.json")).n8n.workflowId, "sl1");
    assert.equal((await step("seed")).code, 0);
    const en = await step("enable", { force: true });
    assert.equal(en.code, 0, en.text);
    const rb = await step("rollback");
    assert.equal(rb.code, 0, rb.text);
    assert.equal(n8n.wf.activeVersionId, "v7", "the version that was live is published again");
    assert.ok(!n8n.log.some(([t]) => /static/i.test(t)));
    await n8n.client.close();
    assert.equal(n8n.revoked(), 1, "close() revokes the sign-in");
  } finally {
    await n8n.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("over a sign-in, Gmail's cursor comes from n8n's executions; rollback is refused with n8n left off", async () => {
  const { dir, folder } = folderFor("tests/fixtures/convert/poll-code-http.n8n.json");
  const def = readJson(join(folder, "definition.json"));
  const POLL = Object.entries(def.steps).find(([, s]) => s.n8n?.type === "n8n-nodes-base.gmailTrigger")[0];
  const executions = [{ id: "1", data: { resultData: { runData: { [POLL]: [{ data: { main: [[{ json: { id: "m1", internalDate: String(Date.parse("2026-11-14T00:01:00.400Z")) } }]] } }] } } } }];
  const n8n = await fakeMcp({ id: "poll01", name: def.name, active: true, activeVersionId: "v1", nodes: [], connections: {} }, { executions });
  const step = (name, flags = {}) => runStep(folder, name, { flags: { "n8n-id": "poll01", ...flags }, env: {}, n8n: n8n.client });
  try {
    const de = await step("deactivate-n8n", { force: true });
    assert.equal(de.code, 0, de.text);
    assert.deepEqual(de.data.cursor, { [POLL]: { value: "2026-11-14T00:01:00.000Z", ids: ["m1"] } });
    assert.deepEqual(n8n.log.find(([t]) => t === "get_workflow_execution")[1].nodeNames, [POLL], "only the poll step's data is asked for");
    assert.equal((await step("seed")).code, 0);
    assert.equal((await step("enable", { force: true })).code, 0);
    const rb = await step("rollback");
    assert.equal(rb.code, 1);
    assert.match(rb.text, /cannot be written.*n8n stays off and the task is held.*N8N_API_KEY/s);
    assert.equal(n8n.wf.activeVersionId, null, "n8n not switched on");
  } finally {
    await n8n.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("over a sign-in, a poll trigger whose position only static data holds is refused before n8n is touched", async () => {
  const { dir, folder } = folderFor("tests/fixtures/convert/poll-code-http.n8n.json");
  const n8n = await fakeMcp({ id: "poll01", name: "x", active: true, activeVersionId: "v1", nodes: [], connections: {} });
  try {
    // Gmail without its executions mapping stands in for Drive/Sheets: drop fromEmitted.
    const api = await import("../skills/n8n-to-claude/scripts/n8n-api.mjs");
    const spec = api.POLL_STATE["n8n-nodes-base.gmailTrigger"];
    const saved = spec.fromEmitted;
    delete spec.fromEmitted;
    try {
      const r = await runStep(folder, "deactivate-n8n", { flags: { "n8n-id": "poll01", force: true }, env: {}, n8n: n8n.client });
      assert.equal(r.code, 1);
      assert.match(r.text, /does not share its saved poll position.*Nothing changed in n8n/s);
      assert.equal(n8n.log.length, 0, "no call reached n8n");
    } finally {
      spec.fromEmitted = saved;
    }
  } finally {
    await n8n.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--login builds the sign-in client with the cutover scopes and revokes it when the step ends", async () => {
  const { dir, folder } = folderFor("tests/fixtures/convert/slice.n8n.json");
  const calls = [];
  try {
    const r = await runStep(folder, "status", { flags: { login: "https://me.example", "n8n-id": "x" }, env: {}, signIn: async (address, o) => { calls.push([address, o.scopes]); throw new Error("no browser here"); } });
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(calls, [["https://me.example", CUTOVER_SCOPES]]);
    assert.match(r.data.n8n.error, /no browser here/);
    const k = await runStep(folder, "status", { flags: { login: true }, env: {} });
    assert.equal(k.code, 2);
    assert.match(k.text, /--login needs your n8n address/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
