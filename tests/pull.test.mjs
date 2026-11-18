// Ways in (SKILL.md step 1): scripts/pull.mjs against a fake api.n8n.io and n8n public API,
// and analyze.mjs reading MCP tool results saved as they came. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSource, readEnvFile, pull } from "../skills/n8n-to-claude/scripts/pull.mjs";
import { loadInput, unwrap } from "../skills/n8n-to-claude/scripts/analyze.mjs";

const WF = (id, name, extra = {}) => ({ id, name, nodes: [{ name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {} }], connections: {}, settings: {}, ...extra });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const tmp = () => mkdtempSync(join(tmpdir(), "n2c-pull-"));

test("parseSource: template links, template:<id>, n8n, editor links; anything else is refused", () => {
  assert.deepEqual(parseSource("https://n8n.io/workflows/42-some-slug"), { kind: "template", id: "42" });
  assert.deepEqual(parseSource("www.n8n.io/workflows/42"), { kind: "template", id: "42" });
  assert.deepEqual(parseSource("n8n.io/workflows/42/?utm=x"), { kind: "template", id: "42" });
  assert.deepEqual(parseSource("template:42"), { kind: "template", id: "42" });
  assert.deepEqual(parseSource("n8n"), { kind: "instance" });
  assert.deepEqual(parseSource("https://me.app.n8n.cloud/workflow/AbC12"), { kind: "editor", base: "https://me.app.n8n.cloud", id: "AbC12" });
  assert.deepEqual(parseSource("http://host:5678/n8n/workflow/x9/"), { kind: "editor", base: "http://host:5678/n8n", id: "x9" });
  for (const bad of ["https://me.app.n8n.cloud/workflow/new", "ftp://h/workflow/1", "workflows.json", "https://evil.example/n8n.io/workflows/1"]) assert.equal(parseSource(bad).kind, "bad", bad);
});

test("readEnvFile takes only N8N_BASE_URL and N8N_API_KEY", () => {
  assert.deepEqual(readEnvFile('export N8N_BASE_URL="https://h"\nN8N_API_KEY=k1 # comment\nOTHER=x\n'), { N8N_BASE_URL: "https://h", N8N_API_KEY: "k1" });
});

test("a template is written in export shape without the author's profile, and analyze reads it", async () => {
  const out = tmp();
  try {
    const seen = [];
    const fetch = async (url) => {
      seen.push(url);
      if (url.endsWith("/42")) return json({ workflow: { id: 42, name: "Daily digest", user: { name: "Author", username: "a" }, workflow: { nodes: WF().nodes, connections: {} } } });
      return json({ message: "bad" }, 400);
    };
    const r = await pull(["https://n8n.io/workflows/42-daily", "template:7"], { out, fetch, env: {} });
    assert.deepEqual(seen, ["https://api.n8n.io/api/templates/workflows/42", "https://api.n8n.io/api/templates/workflows/7"]);
    assert.deepEqual(r.written.map((w) => w.file), ["daily-digest-42.json"]);
    assert.match(r.errors[0].error, /template 7: HTTP 400 \(no such template\)/);
    const saved = JSON.parse(readFileSync(join(out, "daily-digest-42.json"), "utf8"));
    assert.equal(saved.user, undefined);
    assert.equal(saved.name, "Daily digest");
    const loaded = loadInput(out);
    assert.deepEqual(loaded.items.map((i) => [i.id, i.name]), [["42", "Daily digest"]]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("n8n: every workflow across pages, archived left out, `shared` dropped; the key never reaches the output", async () => {
  const out = tmp();
  try {
    const seen = [];
    const fetch = async (url, init) => {
      assert.equal(init.headers["X-N8N-API-KEY"], "sekret");
      seen.push(url.replace("https://me.example", ""));
      if (url.includes("/workflows?") && !url.includes("cursor=")) return json({ data: [WF("a", "One", { shared: [{ user: { email: "x@y" } }] }), WF("z", "Old", { isArchived: true })], nextCursor: "p2" });
      if (url.includes("cursor=p2")) return json({ data: [{ id: "b", name: "Two" }], nextCursor: null });
      if (url.endsWith("/workflows/b")) return json(WF("b", "Two"));
      throw new Error(`unexpected ${url} sekret`);
    };
    const r = await pull(["n8n"], { out, fetch, env: { N8N_BASE_URL: "https://me.example/api/v1/", N8N_API_KEY: "sekret" } });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(seen, ["/api/v1/workflows?limit=250", "/api/v1/workflows?limit=250&cursor=p2", "/api/v1/workflows/b"]);
    assert.deepEqual(readdirSync(out).sort(), ["one-a.json", "two-b.json"]);
    assert.equal(JSON.parse(readFileSync(join(out, "one-a.json"), "utf8")).shared, undefined);
    for (const f of readdirSync(out)) assert.ok(!readFileSync(join(out, f), "utf8").includes("sekret"));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("instance sources without the env vars, or an editor link on another host, never send the key", async () => {
  const out = tmp();
  try {
    let calls = 0;
    const fetch = async () => {
      calls++;
      return json({});
    };
    const none = await pull(["n8n", "https://me.example/workflow/a"], { out, fetch, env: {} });
    assert.equal(none.written.length, 0);
    assert.match(none.errors[0].error, /set N8N_BASE_URL and N8N_API_KEY/);
    assert.match(none.errors[1].error, /set N8N_BASE_URL=https:\/\/me\.example/);
    const other = await pull(["https://other.example/workflow/a"], { out, fetch, env: { N8N_BASE_URL: "https://me.example", N8N_API_KEY: "sekret" } });
    assert.match(other.errors[0].error, /not on N8N_BASE_URL's instance/);
    assert.equal(calls, 0);
    const failing = await pull(["https://me.example/workflow/a"], { out, fetch: async () => { throw new Error("boom sekret"); }, env: { N8N_BASE_URL: "https://me.example", N8N_API_KEY: "sekret" } });
    assert.ok(!failing.errors[0].error.includes("sekret"));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("MCP tool results saved as they came are read as workflows", () => {
  const wf = WF("w1", "From MCP");
  // n8n's instance-level MCP server, get_workflow_details
  assert.deepEqual(unwrap({ workflow: { ...wf, nodeCount: 1 }, triggerInfo: "x" }, "f").map((x) => [x.id, x.name]), [["w1", "From MCP"]]);
  // n8n-mcp, n8n_get_workflow
  assert.deepEqual(unwrap({ success: true, data: wf }, "f").map((x) => x.id), ["w1"]);
  // a raw tool result envelope
  assert.deepEqual(unwrap({ content: [{ type: "text", text: JSON.stringify({ workflow: wf }) }, { type: "text", text: "not json" }] }, "f").map((x) => x.id), ["w1"]);
  assert.deepEqual(unwrap({ structuredContent: { workflow: wf } }, "f").map((x) => x.id), ["w1"]);
  // the editor's clipboard (select all, copy): nodes and connections, no name
  assert.equal(unwrap({ nodes: wf.nodes, connections: {}, pinData: {} }, "pasted")[0].name, "pasted");
  // a search_workflows preview has no nodes and is not a workflow
  assert.equal(unwrap({ data: [{ id: "w1", name: "x", active: true }] }, "f"), null);
  const dir = tmp();
  try {
    writeFileSync(join(dir, "w1.json"), JSON.stringify({ workflow: wf }));
    assert.equal(loadInput(dir).items[0].name, "From MCP");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
