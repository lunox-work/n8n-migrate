// The n8n side of the bench: one template, one fixture variant, run in the local n8n
// (evals/n8n/container.mjs) with every outgoing call answered by the mock.
//
// What is changed in the template before it runs, and only this (each is recorded):
//   - credentials: every credential the nodes reference is created with bench dummies
//     (CREDENTIALS below). Model nodes get their own credential whose base URL is
//     http://mock:8080/model/<tag>, so the mock forwards their calls to the model shim tagged
//     with the node (tags m0, m1, ... -> node names in `models`).
//   - the bench config overlay (evals/bench/config/<id>.json `n8n`): parameter patches by node
//     name that fill placeholders (an empty chat id, a demo host). Never logic.
//   - pins: the trigger's items (FIXTURES.md), the template's own pinData, and an `n8n` pin for
//     a read only when its `http` source cannot be used (no http source, or the node failed
//     with the http source and the fixture has a pin: `pin-fallback`).
//   - files: `file` reads are copied into the container's working directory.
// Everything else (node parameters, connections, settings) is the template as downloaded.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureLeaf, ensureServiceAccountKey } from "./tls.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
export const MOCK = "http://mock:8080";
const LC = "@n8n/n8n-nodes-langchain.";

export function loadTemplate(id) {
  const raw = JSON.parse(readFileSync(join(HERE, "data", "wf", `${id}.json`), "utf8"));
  const wf = raw.workflow?.workflow ?? raw;
  return { raw, wf: structuredClone(wf), name: raw.workflow?.name ?? wf.name ?? String(id) };
}

export function loadFixture(id, variant) {
  return JSON.parse(readFileSync(join(HERE, "fixtures", String(id), `${variant}.json`), "utf8"));
}

export function loadOverlay(id) {
  try {
    return JSON.parse(readFileSync(join(HERE, "config", `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

// Model credential types by node type; the base-URL field differs per type.
const MODEL_CRED = {
  lmChatAnthropic: { type: "anthropicApi", data: (url) => ({ apiKey: "bench-dummy", url }) },
  lmChatOpenAi: { type: "openAiApi", data: (url) => ({ apiKey: "bench-dummy", url: `${url}/v1` }) },
  lmOpenAi: { type: "openAiApi", data: (url) => ({ apiKey: "bench-dummy", url: `${url}/v1` }) },
  openAi: { type: "openAiApi", data: (url) => ({ apiKey: "bench-dummy", url: `${url}/v1` }) },
  lmChatGoogleGemini: { type: "googlePalmApi", data: (url) => ({ apiKey: "bench-dummy", host: url }) },
  lmChatOllama: { type: "ollamaApi", data: (url) => ({ baseUrl: url }) },
};

const oauth = (extra = {}) => ({ clientId: "bench", clientSecret: "bench", oauthTokenData: { access_token: "bench-access-token", refresh_token: "bench-refresh", token_type: "Bearer", expires_in: 315360000, scope: "bench" }, ...extra });

// Dummies per credential type (n8n credential property names). None is a real secret.
export function credentialData(type, { wordpressUrl } = {}) {
  const t = {
    openAiApi: { apiKey: "bench-dummy", url: "https://api.openai.com/v1" },
    anthropicApi: { apiKey: "bench-dummy", url: "https://api.anthropic.com" },
    googlePalmApi: { apiKey: "bench-dummy", host: "https://generativelanguage.googleapis.com" },
    ollamaApi: { baseUrl: "http://localhost:11434" },
    notionApi: { apiKey: "bench-dummy" },
    telegramApi: { accessToken: "123456:bench-dummy", baseUrl: "https://api.telegram.org" },
    facebookGraphApi: { accessToken: "bench-dummy" },
    httpHeaderAuth: { name: "Authorization", value: "Bearer bench-dummy" },
    wordpressApi: { username: "bench", password: "bench-dummy", url: wordpressUrl ?? "https://wordpress.example", allowUnauthorizedCerts: false },
    mySql: { host: "mysql.invalid", database: "bench", user: "bench", password: "bench", port: 3306 },
    postgres: { host: "postgres.invalid", database: "bench", user: "bench", password: "bench", port: 5432 },
    gmailOAuth2: oauth(),
    googleDriveOAuth2Api: oauth(),
    googleSheetsOAuth2Api: oauth(),
    googleApi: { email: "bench@bench-project.iam.gserviceaccount.com", privateKey: readFileSync(ensureServiceAccountKey(), "utf8"), region: "us-central1" },
  }[type];
  return t ?? { apiKey: "bench-dummy", accessToken: "bench-dummy", token: "bench-dummy" };
}

const shortType = (t) => t.replace(LC, "").replace("n8n-nodes-base.", "");

// Model nodes: chat-model sub-nodes, plus root OpenAI nodes the fixture lists as models (a
// text message). Returns [{tag, node, type, credType}].
export function modelNodes(wf, fixture) {
  const out = [];
  for (const n of wf.nodes) {
    if (n.disabled) continue;
    const st = shortType(n.type);
    const isSub = /^lm(Chat)?/.test(st) && n.type.startsWith(LC);
    const isRootModel = st === "openAi" && fixture.models.includes(n.name) && /message|text/i.test(`${n.parameters?.resource ?? "text"}:${n.parameters?.operation ?? "message"}`) && (n.parameters?.resource ?? "text") === "text";
    if (!isSub && !isRootModel) continue;
    const spec = MODEL_CRED[st] ?? MODEL_CRED[st.replace(/^lmChat/, "lmChat")];
    out.push({ tag: `m${out.length}`, node: n.name, type: n.type, credType: spec?.type ?? Object.keys(n.credentials ?? {})[0] ?? null, spec });
  }
  return out;
}

// Which root node consumes a model sub-node (ai_languageModel edges); a root model is itself.
export function modelConsumers(wf) {
  const map = {};
  for (const [from, outs] of Object.entries(wf.connections ?? {})) for (const list of outs.ai_languageModel ?? []) for (const e of list ?? []) (map[from] ??= []).push(e.node);
  return map;
}

function setPath(obj, path, value) {
  const keys = path.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys.at(-1)] = value;
}

// The bench's routes for the mock and the hosts that need a TLS leaf.
export function routesOf(fixture) {
  const routes = [];
  const hosts = new Set();
  for (const r of [...fixture.reads, ...(fixture.writeReplies ?? [])]) {
    for (const x of r.http?.responses ?? []) {
      routes.push({ node: r.node, method: x.method, url: x.url, ...(x.query ? { query: x.query } : {}), status: x.status, ...(x.headers ? { headers: x.headers } : {}), ...(x.body !== undefined ? { body: x.body } : {}), ...(x.bodyBase64 !== undefined ? { bodyBase64: x.bodyBase64 } : {}) });
      const u = new URL(x.url);
      if (u.protocol === "https:") hosts.add(u.hostname);
    }
  }
  return { routes, hosts: [...hosts] };
}

// Builds everything runWorkflow needs. `pinFallback`: node names to pin from their `n8n` source.
export function prepare(id, variant, { overlay = loadOverlay(id), pinFallback = [] } = {}) {
  const { wf, name } = loadTemplate(id);
  const fx = loadFixture(id, variant);
  const applied = [];
  for (const [node, patches] of Object.entries(overlay?.n8n ?? {})) {
    const n = wf.nodes.find((x) => x.name === node);
    if (!n) throw new Error(`overlay ${id}: no node "${node}"`);
    for (const [path, value] of Object.entries(patches)) {
      setPath(n, path, value);
      applied.push({ node, path });
    }
  }
  const models = modelNodes(wf, fx);
  const credentials = {};
  const wordpressUrl = (fx.writeReplies ?? []).flatMap((r) => r.http?.responses ?? []).map((x) => x.url).find((u) => /\/wp-json\//.test(u))?.replace(/\/wp-json\/.*$/, "");
  for (const n of wf.nodes) for (const t of Object.keys(n.credentials ?? {})) credentials[t] ??= credentialData(t, { wordpressUrl });
  for (const m of models) {
    const n = wf.nodes.find((x) => x.name === m.node);
    if (!m.spec) continue;
    const credName = `bench-model ${m.tag}`;
    n.credentials = { ...(n.credentials ?? {}), [m.spec.type]: { id: null, name: credName } };
    credentials[credName] = m.spec.data(`${MOCK}/model/${m.tag}`);
  }
  const { routes, hosts } = routesOf(fx);
  for (const h of hosts) ensureLeaf(h);
  // OAuth refreshes and the service-account token exchange stay inside the mock too.
  for (const h of ["oauth2.googleapis.com", "www.googleapis.com", "api.anthropic.com", "api.openai.com"]) ensureLeaf(h);
  routes.push({ node: "(bench)", method: "POST", url: "https://oauth2.googleapis.com/token", status: 200, body: { access_token: "bench-access-token", token_type: "Bearer", expires_in: 3599 } });
  routes.push({ node: "(bench)", method: "POST", url: "https://www.googleapis.com/oauth2/v4/token", status: 200, body: { access_token: "bench-access-token", token_type: "Bearer", expires_in: 3599 } });

  // Pins: template pinData, then n8n-only reads, then fallbacks. The trigger is pinned by runWorkflow.
  const pinData = { ...(wf.pinData ?? {}) };
  const sources = {};
  for (const r of fx.reads) {
    if (r.node === fx.trigger.node) continue;
    const usable = r.http?.responses?.length;
    if ((!usable || pinFallback.includes(r.node)) && r.n8n) {
      pinData[r.node] = r.n8n.items;
      sources[r.node] = usable ? "pin-fallback" : "pin";
    } else if (usable) sources[r.node] = `http/${r.http.via}`;
    else if (r.file) sources[r.node] = "file";
    else sources[r.node] = "none";
  }
  wf.pinData = pinData;
  const files = fx.reads.filter((r) => r.file).map((r) => r.file);
  // A poll trigger whose read has http responses polls once through the mock instead of being
  // pinned: that is the only way binary data (attachments) reaches the n8n side.
  const triggerRead = fx.reads.find((r) => r.node === fx.trigger.node && r.http?.responses?.length);
  const pinTrigger = !(triggerRead && fx.trigger.kind === "poll");
  if (!pinTrigger) sources[fx.trigger.node] = `http/${triggerRead.http.via} (trigger polls)`;
  return { pinTrigger, id, variant, name, wf: { ...wf, name: `${id} ${name}` }, fixture: fx, credentials, routes, models, overlayApplied: applied, sources, files };
}

// Splits the mock log into service calls and model calls.
export function splitLog(effects) {
  const service = [];
  const model = [];
  for (const e of effects) {
    if (e.model) model.push(e);
    else service.push(e);
  }
  return { service, model };
}

// The mock log against the fixture's expected HTTP calls: requests no route answered, and
// fixture routes nobody asked for (the fixture writer's sequences are from memory).
export function logVsFixture(prep, effects) {
  const { service } = splitLog(effects);
  const unanswered = service
    .filter((e) => !e.fixture || e.fixture === "default")
    .filter((e) => !(e.method === "CONNECT" && /oauth2\.googleapis/.test(e.path)))
    .map((e) => ({ method: e.method, url: e.method === "CONNECT" ? `CONNECT ${e.path}` : `${e.proxied ?? ""}${e.path}`, query: e.rawQuery ?? "" }));
  const writeDefaults = service.filter((e) => e.fixture === "write-default").map((e) => ({ method: e.method, url: `${e.proxied ?? ""}${e.path}` }));
  const used = new Set(service.map((e) => e.fixture).filter(Boolean));
  const unused = [];
  const seen = new Set();
  for (const r of prep.routes) {
    if (r.node === "(bench)") continue;
    const key = `route ${r.method} ${r.url}${r.query && Object.keys(r.query).length ? " " + JSON.stringify(r.query) : ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!used.has(key)) unused.push({ node: r.node, method: r.method, url: r.url, ...(r.query ? { query: r.query } : {}) });
  }
  return { unanswered, unused, writeDefaults };
}

// Runs one prepared template in n8n. `shim` is the started model shim; `modelSession` its
// session for this run. Retries once with pins for nodes that failed on their http source.
export async function runN8n(prep, { shim, modelSession, runWorkflow, copyIn, timeoutS = 240, allowFallback = true }) {
  const tagToNode = Object.fromEntries(prep.models.map((m) => [m.tag, m.node]));
  for (const f of prep.files) {
    const local = join(HERE, ".work", "files", f.path.replace(/[^\w.-]+/g, "_"));
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, f.base64 !== undefined ? Buffer.from(f.base64, "base64") : f.text ?? "");
    copyIn(local, join("/home/node", f.path));
  }
  shim.setSession({ ...modelSession, label: `${prep.id}/${prep.variant}` });
  const r = await runWorkflow(prep.wf, { trigger: prep.fixture.trigger.items, mock: { __routes: prep.routes, __writeDefault: { status: 200, body: {} } }, credentials: prep.credentials, via: "pin", keepPin: true, timeoutS, now: prep.fixture.now, pinTrigger: prep.pinTrigger });
  const calls = shim.session.calls.map((c) => ({ ...c, node: tagToNode[c.tag] ?? c.tag }));
  const failedNode = r.error?.node ?? Object.entries(r.nodes ?? {}).find(([, runs]) => runs.some((x) => x.error))?.[0];
  const fallbackable = allowFallback && failedNode && prep.fixture.reads.some((x) => x.node === failedNode && x.n8n && x.http?.responses?.length) && prep.sources[failedNode]?.startsWith("http");
  return { result: r, modelCalls: calls, failedNode, fallbackable };
}
