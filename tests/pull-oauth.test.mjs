// pull.mjs --login (scripts/n8n-oauth.mjs) against a fake n8n over real HTTP: discovery, dynamic
// client registration, the browser's consent and redirect to the loopback callback, PKCE, the
// token grant, MCP over Streamable HTTP (SSE answers, a session id), and revocation. The
// "browser" follows n8n's redirect with fetch. No network beyond 127.0.0.1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pull } from "../skills/n8n-migrate/scripts/pull.mjs";
import { signIn, instanceBase, scopeFor, scopesForVersion, discover } from "../skills/n8n-migrate/scripts/n8n-oauth.mjs";

const NODES = [{ name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {} }];

async function fakeN8n({ wellKnown = true, mcpOn = true, legacyDetail = false } = {}) {
  const st = { registrations: [], codes: new Map(), tokens: new Set(), revoked: [], sessions: 0, calls: [] };
  const workflows = [
    { id: "a1", name: "Shared one", active: true, availableInMCP: true },
    { id: "b2", name: "Private one", active: true, availableInMCP: false },
    { id: "c3", name: "Draft", active: false, availableInMCP: true },
  ];
  let base;
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, base);
    let body = "";
    for await (const c of req) body += c;
    const json = (code, obj, headers = {}) => res.writeHead(code, { "content-type": "application/json", ...headers }).end(JSON.stringify(obj));
    const o = `${base}/mcp-oauth`;
    if (u.pathname === "/.well-known/oauth-authorization-server") {
      if (!wellKnown) return res.writeHead(404).end();
      return json(200, { issuer: base, authorization_endpoint: `${o}/authorize`, token_endpoint: `${o}/token`, registration_endpoint: `${o}/register`, revocation_endpoint: `${o}/revoke`, scopes_supported: ["workflow:read", "workflow:write", "project:read", "tag:read"], code_challenge_methods_supported: ["S256"] });
    }
    if (u.pathname.startsWith("/.well-known/")) return res.writeHead(404).end();
    if (u.pathname === "/rest/settings") return json(200, { data: { versionCli: "2.40.1" } });
    if (u.pathname === "/mcp-oauth/register") {
      const b = JSON.parse(body || "{}");
      if (!b.redirect_uris) return json(400, { error: "invalid_client_metadata" });
      const id = `client-${st.registrations.length + 1}`;
      st.registrations.push({ id, ...b });
      return json(201, { client_id: id, client_secret: `secret-${id}`, redirect_uris: b.redirect_uris });
    }
    if (u.pathname === "/mcp-oauth/authorize") {
      const q = Object.fromEntries(u.searchParams);
      const reg = st.registrations.find((r) => r.id === q.client_id);
      if (!reg || !reg.redirect_uris.includes(q.redirect_uri)) return json(400, { error: "invalid_request" });
      assert.equal(q.code_challenge_method, "S256");
      assert.equal(q.resource, `${base}/mcp-server/http`);
      const code = `code-${st.codes.size + 1}`;
      st.codes.set(code, q);
      return res.writeHead(302, { location: `${q.redirect_uri}?code=${code}&state=${encodeURIComponent(q.state)}` }).end();
    }
    if (u.pathname === "/mcp-oauth/token") {
      const f = Object.fromEntries(new URLSearchParams(body));
      const q = st.codes.get(f.code);
      st.codes.delete(f.code);
      const ok = q && f.client_id === q.client_id && f.client_secret === `secret-${q.client_id}` && f.redirect_uri === q.redirect_uri && createHash("sha256").update(f.code_verifier).digest("base64url") === q.code_challenge;
      if (!ok) return json(400, { error: "invalid_grant" });
      const t = `access-${st.tokens.size + 1}`;
      st.tokens.add(t);
      return json(200, { access_token: t, refresh_token: `refresh-${t}`, expires_in: 3600, token_type: "Bearer" });
    }
    if (u.pathname === "/mcp-oauth/revoke") {
      st.revoked.push(Object.fromEntries(new URLSearchParams(body)).token);
      return res.writeHead(200).end();
    }
    if (u.pathname === "/mcp-server/http") {
      if (!mcpOn) return res.writeHead(404).end();
      const tok = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!st.tokens.has(tok)) return res.writeHead(401).end();
      const m = JSON.parse(body);
      if (m.method === "initialize") {
        st.sessions++;
        // An SSE answer with a session id, as the SDK's server sends.
        return res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "s-1" }).end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "n8n" } } })}\n\n`);
      }
      assert.equal(req.headers["mcp-session-id"], "s-1");
      if (m.method === "notifications/initialized") return res.writeHead(202).end();
      const answer = (result) => json(200, { jsonrpc: "2.0", id: m.id, result });
      if (m.method === "tools/call") {
        const { name, arguments: args } = m.params;
        st.calls.push([name, args]);
        if (name === "search_workflows") return answer({ structuredContent: { data: workflows, count: workflows.length }, content: [{ type: "text", text: "{}" }] });
        if (name === "get_workflow_details") {
          if (legacyDetail && "detailLevel" in args) return answer({ isError: true, content: [{ type: "text", text: "Invalid arguments: unrecognized key detailLevel" }] });
          const w = workflows.find((x) => x.id === args.workflowId);
          if (!w?.availableInMCP) return answer({ isError: true, content: [{ type: "text", text: 'Workflow is not available in MCP. Enable "Available in MCP" in the workflow settings.' }] });
          // Older servers send the JSON only as text.
          return answer({ content: [{ type: "text", text: JSON.stringify({ workflow: { id: w.id, name: w.name, nodes: NODES, connections: {}, shared: [{ user: { email: "o@x" } }], activeVersion: { sameAsDraft: true } }, triggerInfo: "manual" }) }] });
        }
      }
      return json(200, { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no such method" } });
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  return { base, st, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

// The browser: load n8n's consent page (the fake grants at once) and follow its redirect.
const browser = async (url) => {
  const r = await fetch(url, { redirect: "manual" });
  const to = r.headers.get("location");
  if (to) await fetch(to);
};
const login = (b, o) => signIn(b, { ...o, open: (u) => void browser(u), log: () => {}, timeoutMs: 5000 });

test("--login: browser sign-in, every shared workflow read over MCP, the private one named, nothing secret on disk", async () => {
  const n8n = await fakeN8n();
  const out = mkdtempSync(join(tmpdir(), "n8m-oauth-out-"));
  const cfg = mkdtempSync(join(tmpdir(), "n8m-oauth-cfg-"));
  try {
    const r = await pull([], { out, login: `${n8n.base}/home/workflows`, env: { N8M_CONFIG_DIR: cfg }, signIn: login });
    assert.deepEqual(r.written.map((w) => w.file).sort(), ["draft-c3.json", "shared-one-a1.json"]);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0].error, /not shared over MCP \(1\): Private one\. .*Available in MCP/);
    const saved = JSON.parse(readFileSync(join(out, "shared-one-a1.json"), "utf8"));
    assert.equal(saved.shared, undefined);
    assert.equal(saved.activeVersion, undefined);
    assert.deepEqual(saved.nodes, NODES);
    // registered once, read-only scopes only, a localhost redirect
    assert.equal(n8n.st.registrations.length, 1);
    assert.equal(n8n.st.registrations[0].scope, "workflow:read project:read tag:read");
    assert.match(n8n.st.registrations[0].redirect_uris[0], /^http:\/\/localhost:\d+\/callback$/);
    assert.deepEqual(n8n.st.revoked, ["refresh-access-1"]);
    const file = join(cfg, "oauth-clients.json");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const stored = readFileSync(file, "utf8");
    assert.ok(!/access-|refresh-/.test(stored), "no token is stored");
    for (const f of readdirSync(out)) assert.ok(!readFileSync(join(out, f), "utf8").includes("access-1"));
    // a second run reuses the registration and its port; --active keeps published ones
    const again = await pull(["n8n"], { out, active: true, login: n8n.base, env: { N8M_CONFIG_DIR: cfg }, signIn: login });
    assert.equal(n8n.st.registrations.length, 1);
    assert.deepEqual(again.written.map((w) => w.id), ["a1"]);
    // --register-again makes a new client
    await pull([`${n8n.base}/workflow/a1`], { out, login: n8n.base, registerAgain: true, env: { N8M_CONFIG_DIR: cfg }, signIn: login });
    assert.equal(n8n.st.registrations.length, 2);
  } finally {
    await n8n.close();
    rmSync(out, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
  }
});

test("--login behind a proxy that hides .well-known, on a server whose get_workflow_details takes no detailLevel", async () => {
  const n8n = await fakeN8n({ wellKnown: false, legacyDetail: true });
  const out = mkdtempSync(join(tmpdir(), "n8m-oauth-out-"));
  const cfg = mkdtempSync(join(tmpdir(), "n8m-oauth-cfg-"));
  try {
    const m = await discover(n8n.base);
    assert.equal(m.source, "synthesized");
    assert.equal(m.authorization_endpoint, `${n8n.base}/mcp-oauth/authorize`);
    const r = await pull([`${n8n.base}/workflow/a1`, "https://elsewhere.example/workflow/z"], { out, login: n8n.base, env: { N8M_CONFIG_DIR: cfg }, signIn: login });
    assert.deepEqual(r.written.map((w) => w.id), ["a1"]);
    assert.match(r.errors[0].error, /not on http:\/\/127\.0\.0\.1:\d+, the instance you sign in to/);
    assert.deepEqual(n8n.st.calls.filter(([n]) => n === "get_workflow_details").map(([, a]) => Object.keys(a).sort().join(",")), ["detailLevel,workflowId", "workflowId"]);
  } finally {
    await n8n.close();
    rmSync(out, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
  }
});

test("--login with n8n's MCP server switched off says where to switch it on", async () => {
  const n8n = await fakeN8n({ mcpOn: false });
  const cfg = mkdtempSync(join(tmpdir(), "n8m-oauth-cfg-"));
  try {
    const r = await pull([], { out: join(cfg, "out"), login: n8n.base, env: { N8M_CONFIG_DIR: cfg }, signIn: login });
    assert.equal(r.written.length, 0);
    assert.match(r.errors[0].error, /Settings > Instance-level MCP > Enable MCP access/);
  } finally {
    await n8n.close();
    rmSync(cfg, { recursive: true, force: true });
  }
});

test("instanceBase and scopes", () => {
  assert.equal(instanceBase("me.app.n8n.cloud"), "https://me.app.n8n.cloud");
  assert.equal(instanceBase("https://me.app.n8n.cloud/workflow/abc"), "https://me.app.n8n.cloud");
  assert.equal(instanceBase("https://h.example/n8n/mcp-server/http"), "https://h.example/n8n");
  assert.equal(instanceBase("http://localhost:5678/home/workflows"), "http://localhost:5678");
  assert.throws(() => instanceBase("ftp://x"), /not an http/);
  assert.equal(scopeFor({ scopes_supported: ["tool:listWorkflows", "tool:getWorkflowDetails", "tool:executeWorkflow"] }), "tool:listWorkflows tool:getWorkflowDetails");
  assert.equal(scopeFor({ scopes_supported: ["workflow:read", "workflow:write"] }), "workflow:read");
  assert.equal(scopeFor({}), "workflow:read project:read tag:read");
  assert.deepEqual(scopesForVersion("1.121.0"), ["tool:listWorkflows", "tool:getWorkflowDetails"]);
  assert.deepEqual(scopesForVersion(null), ["workflow:read", "project:read", "tag:read"]);
});
