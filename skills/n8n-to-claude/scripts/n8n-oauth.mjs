// Signing in to an n8n instance with OAuth and reading workflows over its instance-level MCP
// server, for `pull.mjs --login`. Zero dependencies.
//
// n8n (1.121+) is an OAuth 2.1 authorization server for its MCP server only; its REST API takes
// API keys, so a sign-in reads through MCP and sees only workflows set "Available in MCP".
// Flow, as a native app (RFC 8252):
//   discover    /.well-known/oauth-authorization-server, else the MCP endpoint's protected-
//               resource document (RFC 9728), else n8n's fixed /mcp-oauth/* paths once an empty
//               registration proves the server is there behind a proxy that hides .well-known
//   register    dynamic client registration (RFC 7591), once per instance and machine, with the
//               redirect http://localhost:<port>/callback. n8n checks the redirect against the
//               client's registered one exactly, so the port is kept with the client. An admin
//               allowlist (Settings > Instance-level MCP) matches a localhost entry on any port
//               (n8n oauth-server.service.ts isRedirectUriAllowed).
//   authorize   the browser opens n8n's consent page; PKCE S256 (the only method n8n takes),
//               a random state, and the RFC 8707 resource = <origin>/mcp-server/http
//   token       the code grant; the tokens live in memory for this run only and the refresh
//               token is revoked at the end (best effort)
// Scopes: workflow:read and the rest of the read set where the instance names them; 1.x and early
// 2.x name only tool:listWorkflows / tool:getWorkflowDetails.
//
// The registration (client id, n8n's client secret for it, port) is stored in
// <config>/oauth-clients.json, mode 0600; config = $N8M_CONFIG_DIR or ~/.config/n8n-to-claude.
// It grants nothing without the person's consent in the browser. No token is ever written.

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MCP_PATH = "/mcp-server/http";
const OAUTH_BASE = "/mcp-oauth";
export const SCOPES = ["workflow:read", "project:read", "tag:read"];
export const LEGACY_SCOPES = ["tool:listWorkflows", "tool:getWorkflowDetails"];
const CLIENT_NAME = "n8n-to-claude";
const TIMEOUT_MS = 15_000;

export class N8nOAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

async function timed(fetchImpl, url, init = {}, ms = TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetchImpl(url, { ...init, redirect: "manual", signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

async function getJson(fetchImpl, url) {
  let r;
  try {
    r = await timed(fetchImpl, url, { headers: { accept: "application/json" } });
  } catch {
    return { reached: false, json: undefined };
  }
  if (!r.ok) return { reached: true, json: undefined };
  return { reached: true, json: await r.json().catch(() => undefined) };
}

const form = (fields) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) p.set(k, v);
  return p.toString();
};

// The instance's origin plus any path prefix (n8n behind /n8n/), without a trailing slash, from
// whatever the person typed: an editor link, the MCP server URL, or the bare address.
export function instanceBase(address) {
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? address : `https://${address}`);
  } catch {
    throw new N8nOAuthError("bad_address", `not an address: ${address}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new N8nOAuthError("bad_address", `not an http(s) address: ${address}`);
  const path = u.pathname
    .replace(/\/mcp-server\/http\/?$/, "")
    .replace(/\/(workflow|workflows|home|projects|settings)(\/.*)?$/, "")
    .replace(/\/+$/, "");
  return `${u.origin}${path}`;
}

// ---------- discovery ----------

function asMetadata(json) {
  if (!isObj(json) || typeof json.authorization_endpoint !== "string" || typeof json.token_endpoint !== "string") return undefined;
  return json;
}

function usable(m) {
  if (typeof m.registration_endpoint !== "string") throw new N8nOAuthError("not_oauth_server", "the instance does not offer client registration");
  if (Array.isArray(m.code_challenge_methods_supported) && !m.code_challenge_methods_supported.includes("S256")) throw new N8nOAuthError("not_oauth_server", "the instance does not accept PKCE S256");
  return m;
}

// Which scope names an instance speaks, from its version (1.x and 2.x to 2.14: tool:*).
export function scopesForVersion(version) {
  const m = typeof version === "string" ? /^(\d+)\.(\d+)/.exec(version) : null;
  if (m && (Number(m[1]) < 2 || (Number(m[1]) === 2 && Number(m[2]) <= 14))) return [...LEGACY_SCOPES];
  return [...SCOPES];
}

export async function discover(base, fetchImpl = globalThis.fetch) {
  const origin = new URL(base).origin;
  const path = base.slice(origin.length);
  const direct = await getJson(fetchImpl, `${origin}/.well-known/oauth-authorization-server${path}`);
  const found = asMetadata(direct.json);
  if (found) return usable(found);
  if (!direct.reached) throw new N8nOAuthError("not_reachable", `${base} did not answer`);
  if (path) {
    const atRoot = asMetadata((await getJson(fetchImpl, `${origin}/.well-known/oauth-authorization-server`)).json);
    if (atRoot) return usable(atRoot);
  }
  const pr = (await getJson(fetchImpl, `${origin}/.well-known/oauth-protected-resource${path}${MCP_PATH}`)).json;
  const server = Array.isArray(pr?.authorization_servers) ? pr.authorization_servers[0] : undefined;
  if (typeof server === "string") {
    try {
      const u = new URL(server);
      const p = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
      const m = asMetadata((await getJson(fetchImpl, `${u.origin}/.well-known/oauth-authorization-server${p}`)).json);
      if (m) return usable(m);
    } catch {}
  }
  // Behind a proxy that eats /.well-known/: n8n answers an empty registration with its own error.
  let answers = false;
  try {
    const r = await timed(fetchImpl, `${base}${OAUTH_BASE}/register`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: "{}" });
    answers = r.status === 400 && typeof (await r.json().catch(() => undefined))?.error === "string";
  } catch {}
  if (answers) {
    const s = (await getJson(fetchImpl, `${base}/rest/settings`)).json;
    const data = isObj(s?.data) ? s.data : s;
    const o = `${base}${OAUTH_BASE}`;
    return {
      issuer: base,
      authorization_endpoint: `${o}/authorize`,
      token_endpoint: `${o}/token`,
      registration_endpoint: `${o}/register`,
      revocation_endpoint: `${o}/revoke`,
      scopes_supported: scopesForVersion(data?.versionCli ?? null),
      code_challenge_methods_supported: ["S256"],
      source: "synthesized",
    };
  }
  throw new N8nOAuthError("oauth_unavailable", `no OAuth server answered at ${base} (n8n 1.121 or later, with Settings > Instance-level MCP switched on)`);
}

// What to ask for: the read set (plus `extra`, e.g. the cutover's workflow:write and
// execution:read) as far as the instance names them, or the legacy tool:* names on old versions.
export function scopeFor(metadata, extra = []) {
  const want = [...SCOPES, ...extra.filter((s) => !SCOPES.includes(s))];
  const supported = Array.isArray(metadata.scopes_supported) ? metadata.scopes_supported : [];
  if (!supported.length) return want.join(" ");
  if (!supported.some((s) => want.includes(s))) {
    const legacy = LEGACY_SCOPES.filter((s) => supported.includes(s));
    if (legacy.length) return legacy.join(" ");
  }
  const wanted = want.filter((s) => supported.includes(s));
  return (wanted.length ? wanted : want).join(" ");
}

// The scopes cutover.mjs asks for on top of the read set: publish/unpublish and executions.
export const CUTOVER_SCOPES = ["workflow:write", "execution:read"];

// ---------- registration, stored per instance ----------

export const configDir = (env = process.env) => env.N8M_CONFIG_DIR || join(homedir(), ".config", "n8n-to-claude");

export function loadClients(dir) {
  try {
    const j = JSON.parse(readFileSync(join(dir, "oauth-clients.json"), "utf8"));
    return isObj(j) ? j : {};
  } catch {
    return {};
  }
}

export function saveClient(dir, base, client) {
  const all = loadClients(dir);
  all[base] = client;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "oauth-clients.json");
  writeFileSync(file, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
}

export async function register(metadata, { redirectUri, scope }, fetchImpl = globalThis.fetch) {
  let r;
  try {
    r = await timed(fetchImpl, metadata.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_name: CLIENT_NAME, redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope, token_endpoint_auth_method: "client_secret_post" }),
    });
  } catch {
    throw new N8nOAuthError("not_reachable", "client registration did not answer");
  }
  if (r.status === 503) /* Service Unavailable: the instance is at its client cap */ throw new N8nOAuthError("registration_full", "the instance has no room for another OAuth client; remove an old one in n8n or use an API key");
  if (!r.ok) throw new N8nOAuthError("registration_refused", `the instance refused to register ${redirectUri} (HTTP ${r.status}); an admin can allow http://localhost/callback under Settings > Instance-level MCP, or use an API key`);
  const j = await r.json().catch(() => undefined);
  if (typeof j?.client_id !== "string" || !j.client_id) throw new N8nOAuthError("not_oauth_server", "the registration answer has no client_id");
  return { clientId: j.client_id, clientSecret: typeof j.client_secret === "string" ? j.client_secret : null };
}

// ---------- PKCE, authorization, tokens ----------

export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function authorizationUrl(metadata, { clientId, redirectUri, scope, state, challenge, resource }) {
  const u = new URL(metadata.authorization_endpoint);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope, state, code_challenge: challenge, code_challenge_method: "S256", resource })) u.searchParams.set(k, v);
  return u.toString();
}

async function postToken(metadata, fields, fetchImpl) {
  let r;
  try {
    r = await timed(fetchImpl, metadata.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form(fields) });
  } catch {
    throw new N8nOAuthError("not_reachable", "the token request did not answer");
  }
  const j = await r.json().catch(() => undefined);
  if (!r.ok || typeof j?.access_token !== "string") throw new N8nOAuthError("token_refused", `n8n did not issue a token: ${j?.error_description ?? j?.error ?? `HTTP ${r.status}`}`);
  return { accessToken: j.access_token, refreshToken: typeof j.refresh_token === "string" ? j.refresh_token : null };
}

export const exchangeCode = (metadata, { client, code, verifier, redirectUri, resource }, fetchImpl = globalThis.fetch) =>
  postToken(metadata, { grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: client.clientId, client_secret: client.clientSecret, code_verifier: verifier, resource }, fetchImpl);

export async function revoke(metadata, client, token, fetchImpl = globalThis.fetch) {
  if (!token || typeof metadata.revocation_endpoint !== "string") return false;
  try {
    const r = await timed(fetchImpl, metadata.revocation_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ token, token_type_hint: "refresh_token", client_id: client.clientId, client_secret: client.clientSecret }) }, 5000);
    return r.ok;
  } catch {
    return false;
  }
}

// ---------- the loopback redirect ----------

const PAGE = (title, text) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:4rem auto;max-width:32rem;color:#111"><h1 style="font-size:20px">${title}</h1><p>${text}</p></body>`;

// Listens on localhost:<port> (IPv4 and, where the system has it, IPv6, since browsers resolve
// localhost to either). port 0 picks a free one. Resolves {port, wait(state, ms), close()}.
export async function loopback(port = 0) {
  let settle = null;
  const early = [];
  const handler = (req, res) => {
    const u = new URL(req.url, "http://localhost");
    if (u.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const q = Object.fromEntries(u.searchParams);
    const ok = !!q.code;
    res.writeHead(ok ? 200 : 400, { "content-type": "text/html;charset=utf-8" });
    res.end(ok ? PAGE("Signed in to n8n", "n8n-to-claude is reading your workflows. You can close this tab.") : PAGE("Sign-in did not finish", `n8n answered: ${String(q.error_description ?? q.error ?? "no code").replace(/[<>&"]/g, "")}. Go back to the terminal.`));
    if (settle) settle(q);
    else early.push(q);
  };
  const v4 = createServer(handler);
  await new Promise((res, rej) => {
    v4.once("error", rej);
    v4.listen(port, "127.0.0.1", res);
  });
  const bound = v4.address().port;
  const v6 = createServer(handler);
  await new Promise((res) => {
    v6.once("error", () => res());
    v6.listen(bound, "::1", res);
  });
  const close = () => {
    v4.close();
    v6.close();
    v4.closeAllConnections?.();
    v6.closeAllConnections?.();
  };
  const wait = (state, ms) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new N8nOAuthError("timeout", `no answer from the browser within ${Math.round(ms / 1000)} s`)), ms);
      settle = (q) => {
        clearTimeout(timer);
        if (q.state !== state) reject(new N8nOAuthError("bad_state", "the browser came back with another sign-in's state; start again"));
        else if (!q.code) reject(new N8nOAuthError("denied", `n8n did not sign you in: ${q.error_description ?? q.error ?? "no code"}`));
        else resolve(q.code);
      };
      if (early.length) settle(early.shift());
    });
  return { port: bound, wait, close };
}

export function openBrowser(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const p = spawn(cmd, args, { stdio: "ignore", detached: true });
    p.on("error", () => {});
    p.unref();
  } catch {}
}

// Signs in and returns {base, token, client, metadata, done()}; done() revokes the refresh token.
// `log` gets the lines a person needs (the consent link, in case no browser opened).
// One stored client per instance and scope set (a read sign-in and a cutover sign-in each keep
// theirs, so switching between them never registers again). Every sign-in shows n8n's consent
// page: n8n 2.47 reuses a consent only for its first-party resources, and its MCP server is not
// one (oauth-consent.service.ts tryReuseConsent), so each is one Approve click.
export async function signIn(address, { fetch: fetchImpl = globalThis.fetch, env = process.env, open = openBrowser, log = (s) => console.error(s), timeoutMs = 300_000, registerAgain = false, scopes = [] } = {}) {
  const base = instanceBase(address);
  const metadata = await discover(base, fetchImpl);
  const dir = configDir(env);
  const scope = scopeFor(metadata, scopes);
  const key = scopes.length ? `${base} ${scope}` : base;
  let client = registerAgain ? null : loadClients(dir)[key];
  let server = null;
  if (client?.port) {
    try {
      server = await loopback(client.port);
    } catch {
      client = null; // the port is taken now: register again on a new one
    }
  }
  if (!server) server = await loopback(0);
  const redirectUri = `http://localhost:${server.port}/callback`;
  try {
    if (!client || client.redirectUri !== redirectUri || client.scope !== scope) {
      const reg = await register(metadata, { redirectUri, scope }, fetchImpl);
      client = { ...reg, redirectUri, port: server.port, scope, registeredAt: new Date().toISOString() };
      saveClient(dir, key, client);
    }
    const { verifier, challenge } = pkce();
    const state = randomBytes(32).toString("base64url");
    const resource = `${base}${MCP_PATH}`;
    const url = authorizationUrl(metadata, { clientId: client.clientId, redirectUri, scope, state, challenge, resource });
    log(`Opening n8n's sign-in page. If no browser opens, open this link on this computer:\n${url}\n(If n8n says the client is unknown, run again with --register-again.)`);
    open(url);
    const code = await server.wait(state, timeoutMs);
    const tokens = await exchangeCode(metadata, { client, code, verifier, redirectUri, resource }, fetchImpl);
    return { base, token: tokens.accessToken, client, metadata, done: () => revoke(metadata, client, tokens.refreshToken, fetchImpl) };
  } finally {
    server.close();
  }
}

// ---------- a minimal MCP client (Streamable HTTP) ----------

const NOT_IN_MCP = /available in mcp|not (?:available|accessible|enabled) (?:for|via|in|to|over) mcp/i;

function rpcFromBody(text, contentType, id) {
  if (/text\/event-stream/i.test(contentType ?? "")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      try {
        const m = JSON.parse(data);
        if (m?.id === id) return m;
      } catch {}
    }
    return undefined;
  }
  try {
    const m = JSON.parse(text);
    return Array.isArray(m) ? m.find((x) => x?.id === id) : m;
  } catch {
    return undefined;
  }
}

export function mcpClient({ url, token, fetch: fetchImpl = globalThis.fetch }) {
  let session = null;
  let version = null;
  let nextId = 1;
  let ready = null;
  const redact = (s) => String(s).split(token).join("[token]");
  async function post(body) {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (session) headers["mcp-session-id"] = session;
    if (version) headers["mcp-protocol-version"] = version;
    let r;
    try {
      r = await timed(fetchImpl, url, { method: "POST", headers, body: JSON.stringify(body) }, 60_000);
    } catch (e) {
      throw new N8nOAuthError("not_reachable", `n8n's MCP server did not answer: ${redact(e.cause?.code ?? e.message)}`);
    }
    if (r.status === 401 || r.status === 403) throw new N8nOAuthError("unauthorized", "n8n refused the sign-in for its MCP server; sign in again");
    if (r.status === 404) throw new N8nOAuthError("mcp_disabled", "n8n's MCP server is off: Settings > Instance-level MCP > Enable MCP access (owner or admin)");
    const sid = r.headers.get("mcp-session-id");
    if (sid) session = sid;
    return r;
  }
  async function rpc(method, params) {
    const id = nextId++;
    const r = await post({ jsonrpc: "2.0", id, method, params });
    const text = await r.text();
    if (!r.ok) throw new N8nOAuthError("mcp_error", `n8n's MCP server: HTTP ${r.status} ${redact(text).slice(0, 200)}`);
    const m = rpcFromBody(text, r.headers.get("content-type"), id);
    if (!m) throw new N8nOAuthError("mcp_error", `n8n's MCP server gave no answer to ${method}`);
    if (m.error) throw new N8nOAuthError("mcp_error", `${method}: ${redact(m.error.message ?? JSON.stringify(m.error))}`);
    return m.result;
  }
  const connect = () =>
    (ready ??= (async () => {
      const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: CLIENT_NAME, version: "1" } });
      version = init?.protocolVersion ?? "2025-06-18";
      await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    })());
  async function callTool(name, args) {
    await connect();
    const res = await rpc("tools/call", { name, arguments: args });
    const text = (Array.isArray(res?.content) ? res.content : []).filter((c) => c?.type === "text").map((c) => c.text).join("\n");
    if (res?.isError) {
      const e = new N8nOAuthError(NOT_IN_MCP.test(text) ? "not_in_mcp" : "tool_error", `${name}: ${text || "error"}`);
      throw e;
    }
    let payload = res?.structuredContent;
    if (payload === undefined) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new N8nOAuthError("mcp_error", `${name} answered in an unexpected shape`);
      }
    }
    if (typeof payload?.error === "string") throw new N8nOAuthError(NOT_IN_MCP.test(payload.error) ? "not_in_mcp" : "tool_error", `${name}: ${payload.error}`);
    return payload;
  }
  return {
    callTool,
    async listTools() {
      await connect();
      return ((await rpc("tools/list", {}))?.tools ?? []).map((t) => t.name);
    },
    // Workflow previews (no nodes); n8n caps one call at 200.
    async searchWorkflows() {
      const r = await callTool("search_workflows", { limit: 200, sortBy: "updatedAt:desc" });
      return { data: Array.isArray(r?.data) ? r.data : [], count: typeof r?.count === "number" ? r.count : null };
    },
    async workflow(id) {
      let r;
      try {
        r = await callTool("get_workflow_details", { workflowId: id, detailLevel: "full" });
      } catch (e) {
        // Before 2.35 the tool takes no detailLevel.
        if (e.code !== "tool_error" || !/detailLevel/i.test(e.message)) throw e;
        r = await callTool("get_workflow_details", { workflowId: id });
      }
      const wf = isObj(r?.workflow) ? r.workflow : r;
      if (!Array.isArray(wf?.nodes)) throw new N8nOAuthError("mcp_error", `get_workflow_details for ${id} has no nodes`);
      return wf;
    },
  };
}

// The cutover's view of n8n over MCP, with the interface of n8n-api.mjs createN8nClient (kind
// "mcp"). What MCP cannot do: read or write a workflow's static data, so getWorkflow has
// staticData null and there is no putStaticData; cutover.mjs refuses the steps that need them
// before changing anything. `session` resolves {base, token, done} (signIn with CUTOVER_SCOPES)
// on first use; close() revokes it.
export function mcpN8nClient(session, { fetch: fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let ready = null;
  const get = () =>
    (ready ??= (async () => {
      const s = await session();
      return { s, mcp: mcpClient({ url: `${s.base}${MCP_PATH}`, token: s.token, fetch: fetchImpl }) };
    })());
  const tool = async (name, args) => (await get()).mcp.callTool(name, args);
  const isPublished = (wf) => !!(wf?.activeVersionId ?? wf?.active);
  const ok = (r, what) => {
    if (r?.success === false) throw new N8nOAuthError("tool_error", `${what}: ${r.error ?? "n8n said no"}`);
    return r;
  };
  const client = {
    kind: "mcp",
    isPublished,
    async getWorkflow(id) {
      try {
        const wf = await (await get()).mcp.workflow(id);
        return { ...wf, staticData: null };
      } catch (e) {
        if (/not found/i.test(e.message)) return null;
        throw e;
      }
    },
    unpublish: async (id) => ok(await tool("unpublish_workflow", { workflowId: id }), `unpublish ${id}`),
    publish: async (id, versionId) => ok(await tool("publish_workflow", { workflowId: id, ...(versionId ? { versionId } : {}) }), `publish ${id}`),
    async runningExecutions(id) {
      const r = await tool("search_workflow_executions", { workflowId: id, status: ["running"], limit: 50 });
      return Array.isArray(r?.data) ? r.data : [];
    },
    // The latest executions with their data, in the public API's shape ({id, status, data}),
    // limited to `nodeNames` (the poll steps) to keep answers small.
    async recentExecutions(id, limit = 10, nodeNames) {
      const r = await tool("search_workflow_executions", { workflowId: id, limit });
      const out = [];
      for (const e of Array.isArray(r?.data) ? r.data : []) {
        const d = await tool("get_workflow_execution", { workflowId: id, executionId: String(e.id), includeData: true, ...(nodeNames?.length ? { nodeNames } : {}) });
        out.push({ id: e.id, status: e.status, startedAt: e.startedAt, data: d?.data ?? null });
      }
      return out;
    },
    // No static data over MCP: wait until nothing runs, then read the workflow.
    async settledStaticData(id, { timeoutMs = 120_000, gapMs = 1500 } = {}) {
      const t0 = Date.now();
      while ((await client.runningExecutions(id)).length) {
        if (Date.now() - t0 > timeoutMs) throw new N8nOAuthError("timeout", `n8n still runs an execution of workflow ${id} after ${timeoutMs / 1000}s; try again when it ends`);
        await sleep(gapMs);
      }
      return { workflow: await client.getWorkflow(id), staticData: null };
    },
    async close() {
      if (ready) await (await ready).s.done?.();
    },
  };
  return client;
}
