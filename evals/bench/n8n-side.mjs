// The n8n side of the bench: one template, one fixture variant, run in the local n8n
// (evals/n8n/container.mjs) with every outgoing call answered by the mock.
//
// What is changed in the template before it runs, and only this (each is recorded):
//   - credentials: every credential the nodes reference is created with bench dummies
//     (credentialData below); a node that needs one but ships without any (a template exported
//     with its credentials stripped) gets the bench dummy of its node type (credentialTypeFor),
//     recorded as `credentialsAttached`. Model nodes get their own credential whose base URL is
//     http://mock:8080/model/<tag>, so the mock forwards their calls to the model shim tagged
//     with the node (tags m0, m1, ... -> node names in `models`).
//   - the bench config overlay (evals/bench/config/<id>.json, README): `n8n` parameter patches
//     by node name that fill placeholders (an empty chat id, a demo host), never logic;
//     `timeCompression.n8n` patches that only shorten a wait (recorded as non-placeholder);
//     `env` values the container is started with (overlayEnv).
//   - activation: a workflow that calls itself (sub-workflow or workflow tool on $workflow.id)
//     is activated for the run, since n8n 2.x runs only active workflows as sub-workflows.
//   - the trigger: the fixture's trigger node (not run-workflow's pick among several), pinned
//     (`--via pin`); when the fixture's trigger items carry binary (an upload, which a pin
//     drops), a Form Trigger gets a multipart submission (`--via form`) and any other trigger is
//     replaced by a Code node that returns them (`--via cli`).
//   - pins: the trigger's items (FIXTURES.md), the template's own pinData, and an `n8n` pin for
//     a read only when its `http` source cannot be used (no http source, or the node failed
//     with the http source and the fixture has a pin: `pin-fallback`).
//   - files: `file` reads are copied into the container's working directory.
// Everything else (node parameters, connections, settings) is the template as downloaded.

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureLeaf, ensureServiceAccountKey } from "./tls.mjs";
import { routeKey } from "../n8n/mock-server.mjs";

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

// The container's bench env: every overlay's `env`, merged over all of config/ (so the
// container does not restart between templates). With any env value present, n8n's $env
// block (N8N_BLOCK_ENV_ACCESS_IN_NODE, on by default in 2.x) is lifted for the run.
export function overlayEnv() {
  const env = {};
  let files = [];
  try {
    files = readdirSync(join(HERE, "config")).filter((f) => f.endsWith(".json"));
  } catch {}
  for (const f of files) {
    const o = JSON.parse(readFileSync(join(HERE, "config", f), "utf8"));
    for (const [k, v] of Object.entries(o.env ?? {})) {
      if (k in env && env[k] !== String(v)) throw new Error(`config/${f}: env ${k} differs from another overlay's value`);
      env[k] = String(v);
    }
  }
  return Object.keys(env).length ? { ...env, N8N_BLOCK_ENV_ACCESS_IN_NODE: "false" } : {};
}

// Model credential types by node type; the base-URL field differs per type.
const MODEL_CRED = {
  lmChatAnthropic: { type: "anthropicApi", data: (url) => ({ apiKey: "bench-dummy", url }) },
  lmChatOpenAi: { type: "openAiApi", data: (url) => ({ apiKey: "bench-dummy", url: `${url}/v1` }) },
  lmOpenAi: { type: "openAiApi", data: (url) => ({ apiKey: "bench-dummy", url: `${url}/v1` }) },
  openAi: { type: "openAiApi", data: (url) => ({ apiKey: "bench-dummy", url: `${url}/v1` }) },
  lmChatGoogleGemini: { type: "googlePalmApi", data: (url) => ({ apiKey: "bench-dummy", host: url }) },
  lmChatOllama: { type: "ollamaApi", data: (url) => ({ baseUrl: url }) },
  lmChatOpenRouter: { type: "openRouterApi", data: (url) => ({ apiKey: "bench-dummy", url: `${url}/v1` }) },
};

const oauth = (extra = {}) => ({ clientId: "bench", clientSecret: "bench", oauthTokenData: { access_token: "bench-access-token", refresh_token: "bench-refresh", token_type: "Bearer", expires_in: 315360000, scope: "bench" }, ...extra });

// Dummies per credential type (n8n credential property names). None is a real secret.
// Services the fixtures answer `via: direct` (self-hosted Ollama, Qdrant, a Supabase project)
// point at the mock itself, which matches those requests by path.
export function credentialData(type, { wordpressUrl, s3Endpoint } = {}) {
  const t = {
    openAiApi: { apiKey: "bench-dummy", url: "https://api.openai.com/v1" },
    anthropicApi: { apiKey: "bench-dummy", url: "https://api.anthropic.com" },
    googlePalmApi: { apiKey: "bench-dummy", host: "https://generativelanguage.googleapis.com" },
    // Embeddings and other non-chat Ollama nodes; chat models get their own (MODEL_CRED).
    ollamaApi: { baseUrl: MOCK },
    openRouterApi: { apiKey: "bench-dummy", url: "https://openrouter.ai/api/v1" },
    qdrantApi: { apiKey: "bench-dummy", qdrantUrl: MOCK },
    supabaseApi: { host: MOCK, serviceRole: "bench-dummy" },
    s3: { endpoint: s3Endpoint ?? "https://s3.bench.example", region: "us-east-1", accessKeyId: "bench", secretAccessKey: "bench-dummy", forcePathStyle: false, ignoreSSLIssues: false },
    httpQueryAuth: { name: "api_key", value: "bench-dummy" },
    httpBearerAuth: { token: "bench-dummy" },
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
  if (t) return t;
  if (/OAuth2/i.test(type)) return oauth();
  return { apiKey: "bench-dummy", accessToken: "bench-dummy", token: "bench-dummy" };
}

// The credential type a node of this type uses when the template ships it without one.
// Google nodes follow their `authentication` parameter; an HTTP Request node its generic or
// predefined credential type. Null: the node needs none (or the bench cannot tell).
const google = (oauthType) => (n) => (n.parameters?.authentication === "serviceAccount" ? "googleApi" : oauthType);
const NODE_CREDENTIAL = {
  googleSheets: google("googleSheetsOAuth2Api"),
  googleDrive: google("googleDriveOAuth2Api"),
  gmail: google("gmailOAuth2"),
  googleDocs: google("googleDocsOAuth2Api"),
  googleCalendar: google("googleCalendarOAuth2Api"),
  embeddingsGoogleGemini: () => "googlePalmApi",
  lmChatGoogleGemini: () => "googlePalmApi",
  embeddingsOpenAi: () => "openAiApi",
  lmChatOpenAi: () => "openAiApi",
  embeddingsOllama: () => "ollamaApi",
  lmChatOllama: () => "ollamaApi",
  vectorStoreQdrant: () => "qdrantApi",
  vectorStoreSupabase: () => "supabaseApi",
  supabase: () => "supabaseApi",
  vectorStorePinecone: () => "pineconeApi",
  telegram: () => "telegramApi",
  notion: () => "notionApi",
  httpRequest: (n) => (n.parameters?.authentication === "genericCredentialType" ? n.parameters.genericAuthType : n.parameters?.authentication === "predefinedCredentialType" ? n.parameters.nodeCredentialType : null) ?? null,
};
export function credentialTypeFor(node) {
  const f = NODE_CREDENTIAL[node.type.replace(LC, "").replace("n8n-nodes-base.", "").replace(/Tool$/, "")];
  return f ? f(node) : null;
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
    // The legacy OpenAI node (n8n-nodes-base.openAi v1) answers its chat resource through
    // /v1/chat/completions on the credential's base URL, like a chat model.
    const resource = n.parameters?.resource ?? "text";
    const isRootModel = st === "openAi" && fixture.models.includes(n.name) && (resource === "text" || (n.type === "n8n-nodes-base.openAi" && resource === "chat"));
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
      routes.push({ node: r.node, method: x.method, url: x.url, ...(x.query ? { query: x.query } : {}), ...(x.bodyMatch !== undefined ? { bodyMatch: x.bodyMatch } : {}), status: x.status, ...(x.headers ? { headers: x.headers } : {}), ...(x.body !== undefined ? { body: x.body } : {}), ...(x.bodyBase64 !== undefined ? { bodyBase64: x.bodyBase64 } : {}) });
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
  for (const [kind, section] of [["placeholder", overlay?.n8n], ["time-compression", overlay?.timeCompression?.n8n]]) {
    for (const [node, patches] of Object.entries(section ?? {})) {
      const n = wf.nodes.find((x) => x.name === node);
      if (!n) throw new Error(`overlay ${id}: no node "${node}"`);
      for (const [path, value] of Object.entries(patches)) {
        setPath(n, path, value);
        applied.push({ node, path, ...(kind === "placeholder" ? {} : { kind }) });
      }
    }
  }
  const credentialsAttached = [];
  for (const n of wf.nodes) {
    if (n.disabled || Object.keys(n.credentials ?? {}).length) continue;
    const type = credentialTypeFor(n);
    if (!type) continue;
    n.credentials = { [type]: { id: null, name: `${type} (bench)` } };
    credentialsAttached.push({ node: n.name, type });
  }
  const models = modelNodes(wf, fx);
  const credentials = {};
  const allResponses = [...fx.reads, ...(fx.writeReplies ?? [])].flatMap((r) => (r.http?.responses ?? []).map((x) => ({ ...x, node: r.node })));
  const wordpressUrl = (fx.writeReplies ?? []).flatMap((r) => r.http?.responses ?? []).map((x) => x.url).find((u) => /\/wp-json\//.test(u))?.replace(/\/wp-json\/.*$/, "");
  // The S3 endpoint: the shortest host among the S3 nodes' routes (virtual-hosted routes put
  // the bucket in front of it).
  const s3Nodes = new Set(wf.nodes.filter((n) => n.type === "n8n-nodes-base.s3").map((n) => n.name));
  const s3Endpoint = allResponses.filter((x) => s3Nodes.has(x.node)).map((x) => new URL(x.url).origin).sort((a, b) => a.length - b.length)[0];
  for (const n of wf.nodes) for (const t of Object.keys(n.credentials ?? {})) credentials[t] ??= credentialData(t, { wordpressUrl, s3Endpoint });
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
  // Binary trigger items (uploads) are dropped by a pin: a Form Trigger gets a real multipart
  // submission (its Form ending nodes need it), any other trigger the Code-node swap.
  const binary = pinTrigger && (fx.trigger.items ?? []).some((i) => i && typeof i === "object" && i.binary);
  const isForm = wf.nodes.find((n) => n.name === fx.trigger.node)?.type === "n8n-nodes-base.formTrigger";
  const via = binary ? (isForm ? "form" : "cli") : "pin";
  if (via !== "pin") sources[fx.trigger.node] = via === "form" ? "form (multipart submission: binary trigger items)" : "cli (Code-node swap: binary trigger items)";
  // A workflow that calls itself must be active for its sub-workflow calls to run (n8n 2.x).
  const selfCall = wf.nodes.some((n) => !n.disabled && /\.(executeWorkflow|toolWorkflow)$/.test(n.type) && /\$workflow\.id/.test(JSON.stringify(n.parameters?.workflowId ?? "")));
  return { pinTrigger, via, activate: selfCall, id, variant, name, wf: { ...wf, name: `${id} ${name}` }, fixture: fx, credentials, credentialsAttached, routes, models, overlayApplied: applied, sources, files };
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
    const key = `route ${routeKey(r)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!used.has(key)) unused.push({ node: r.node, method: r.method, url: r.url, ...(r.query ? { query: r.query } : {}), ...(r.bodyMatch !== undefined ? { bodyMatch: r.bodyMatch } : {}) });
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
  const r = await runWorkflow(prep.wf, { trigger: prep.fixture.trigger.items, mock: { __routes: prep.routes, __writeDefault: { status: 200, body: {} } }, credentials: prep.credentials, via: prep.via ?? "pin", triggerNode: prep.fixture.trigger.node, activate: !!prep.activate, keepPin: true, timeoutS, now: prep.fixture.now, pinTrigger: prep.pinTrigger });
  const calls = shim.session.calls.map((c) => ({ ...c, node: tagToNode[c.tag] ?? c.tag }));
  const failedNode = r.error?.node ?? Object.entries(r.nodes ?? {}).find(([, runs]) => runs.some((x) => x.error))?.[0];
  const fallbackable = allowFallback && failedNode && prep.fixture.reads.some((x) => x.node === failedNode && x.n8n && x.http?.responses?.length) && prep.sources[failedNode]?.startsWith("http");
  return { result: r, modelCalls: calls, failedNode, fallbackable };
}
