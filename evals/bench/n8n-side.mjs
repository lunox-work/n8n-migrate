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
//   - files: `file` reads are copied into the container (containerPath: relative paths under
//     /home/node, n8n's working directory; absolute paths as they are, allowed by benchEnv).
// Everything else (node parameters, connections, settings) is the template as downloaded.

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureLeaf, ensureServiceAccountKey } from "./tls.mjs";
import { routeKey, modelHost } from "../n8n/mock-server.mjs";

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

// PROPOSALS P21, FIXTURES.md "file": where a fixture's `file` path lands in the n8n container.
// A relative path (and ~/) resolves against /home/node, n8n's working directory and home there;
// an absolute path is used as it is.
export const N8N_HOME = "/home/node";
export function containerPath(p) {
  const s = String(p);
  if (s.startsWith("~/")) return posix.join(N8N_HOME, s.slice(2));
  return posix.isAbsolute(s) ? posix.normalize(s) : posix.join(N8N_HOME, s);
}

// The directories n8n 2.x must allow (N8N_RESTRICT_FILE_ACCESS_TO, `;`-separated) so every
// fixture's `file` read can be read: /home/node, plus the directory of each absolute path
// outside it, over all fixtures (so the container does not restart between templates).
export function fileAccessDirs(dir = join(HERE, "fixtures")) {
  const dirs = new Set([N8N_HOME]);
  let ids = [];
  try {
    ids = readdirSync(dir);
  } catch {}
  for (const id of ids) {
    let files = [];
    try {
      files = readdirSync(join(dir, id)).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const f of files) {
      let fx;
      try {
        fx = JSON.parse(readFileSync(join(dir, id, f), "utf8"));
      } catch {
        continue;
      }
      for (const r of fx.reads ?? []) {
        if (!r.file?.path) continue;
        const p = containerPath(r.file.path);
        if (p !== N8N_HOME && !p.startsWith(`${N8N_HOME}/`)) dirs.add(posix.dirname(p));
      }
    }
  }
  return [...dirs].sort((a, b) => (a === N8N_HOME ? -1 : b === N8N_HOME ? 1 : a.localeCompare(b)));
}

// PROPOSALS P25: disk writes the template makes. Node types that write a file and the
// parameter holding its path (n8n-nodes-base 2.47.7: Write Binary File `fileName`; Read/Write
// Files from Disk, operation write, `fileName`). Read nodes are not here: what they read comes
// from the fixture's `file` sources (P21).
export const DISK_WRITERS = {
  "n8n-nodes-base.writeBinaryFile": () => "fileName",
  "n8n-nodes-base.readWriteFile": (n) => (n.parameters?.operation === "write" ? "fileName" : null),
};
// The directory a write's path names before any expression: the literal text up to the last
// `/` before the first `{{` (`=/tmp/{{ $json.name }}.xlsx` -> /tmp), as n8n will resolve it
// (containerPath). A path whose directory is all expression names none.
export function writeDir(param) {
  if (typeof param !== "string" || !param.trim()) return null;
  const raw = param.startsWith("=") ? param.slice(1) : param;
  const lit = raw.includes("{{") ? raw.slice(0, raw.indexOf("{{")) : raw;
  const cut = lit.lastIndexOf("/");
  if (cut < 0) return raw.includes("{{") ? null : N8N_HOME;
  const dir = lit.slice(0, cut) || "/";
  return dir === "/" ? null : containerPath(dir);
}

// The directories n8n must allow for the disk writes of the nodes a fixture names in `writes`
// (over every template with fixtures, so the container does not restart between templates):
// a write the bench compares must not fail on the bench's file restriction (1826's Write
// Binary File to /tmp). `/` is never allowed whole.
export function writeAccessDirs(dir = join(HERE, "fixtures"), wfDir = join(HERE, "data", "wf")) {
  const dirs = new Set();
  let ids = [];
  try {
    ids = readdirSync(dir);
  } catch {}
  for (const id of ids) {
    let wf;
    try {
      const raw = JSON.parse(readFileSync(join(wfDir, `${id}.json`), "utf8"));
      wf = raw.workflow?.workflow ?? raw;
    } catch {
      continue;
    }
    const named = new Set();
    let files = [];
    try {
      files = readdirSync(join(dir, id)).filter((f) => f.endsWith(".json"));
    } catch {}
    for (const f of files) {
      try {
        for (const w of JSON.parse(readFileSync(join(dir, id, f), "utf8")).writes ?? []) named.add(typeof w === "string" ? w : w?.node);
      } catch {}
    }
    for (const n of wf.nodes ?? []) {
      const param = named.has(n.name) && DISK_WRITERS[n.type]?.(n);
      const d = param ? writeDir(n.parameters?.[param]) : null;
      if (d && d !== N8N_HOME && !d.startsWith(`${N8N_HOME}/`)) dirs.add(d);
    }
  }
  return [...dirs].sort();
}

// The n8n container's env for the bench: the overlays' `env` and the file-access directories
// (reads, P21; the writes the fixtures compare, P25).
export function benchEnv() {
  const dirs = [...new Set([...fileAccessDirs(), ...writeAccessDirs()])];
  return { ...overlayEnv(), N8N_RESTRICT_FILE_ACCESS_TO: dirs.join(";") };
}

// PROPOSALS P44: the files n8n's disk-write nodes wrote in a run, from their output items
// (both write nodes put the path they were given in json.fileName), resolved as n8n resolves
// a path (containerPath). [{node, path}], each path once, in the order first written.
export function writtenFiles(wf, result) {
  const out = [];
  for (const n of wf.nodes ?? []) {
    if (n.disabled || !DISK_WRITERS[n.type]?.(n)) continue;
    for (const run of result?.nodes?.[n.name] ?? []) {
      for (const j of run.items?.main?.[0] ?? []) {
        if (typeof j?.fileName !== "string" || !j.fileName) continue;
        const path = containerPath(j.fileName);
        if (!out.some((x) => x.path === path)) out.push({ node: n.name, path });
      }
    }
  }
  return out;
}

// PROPOSALS P18: the one list of model node types the shim answers (README "Credentials"),
// read by modelNodes() and by validate.mjs (a `models` entry the shim cannot answer is an
// error). Built from n8n 2.47.7's node and credential sources (@n8n/n8n-nodes-langchain).
//   credential: the node gets its own credential whose base-URL field is
//               http://mock:8080/model/<tag> (the field and any path n8n appends differ per type);
//   host:       the node calls a fixed host (its credential takes no base URL); the mock forwards
//               that host's model path to the shim (mock-server.mjs MODEL_HOSTS), tagged
//               host:<host>, so only one such node per host can be told apart.
// `when(node)`: null when the route holds, a reason when it cannot, or {host} when these
// parameters call a fixed model host instead. Root nodes (OpenAI and
// the vendor nodes) are routed only when the fixture lists them as models, and only for their
// text resource (and the legacy OpenAI node's chat resource).
const K = "bench-dummy";
const viaCred = (type, data, when) => ({ via: "credential", type, data, ...(when ? { when } : {}) });
const viaHost = (credType, host, when) => ({ via: "host", type: credType, host, ...(when ? { when } : {}) });
const openAiCred = viaCred("openAiApi", (url) => ({ apiKey: K, url: `${url}/v1` }));
const textOnly = (resources = ["text"]) => (n) => (resources.includes(n.parameters?.resource ?? "text") ? null : `resource ${n.parameters?.resource} is not a text model call`);
const vertexHost = (n) => {
  const loc = typeof n.parameters?.location === "string" && n.parameters.location ? n.parameters.location : "us-central1";
  return loc === "global" ? "aiplatform.googleapis.com" : ["eu", "us"].includes(loc) ? `aiplatform.${loc}.rep.googleapis.com` : `${loc}-aiplatform.googleapis.com`;
};
export const SHIM_MODELS = {
  [`${LC}lmChatAnthropic`]: viaCred("anthropicApi", (url) => ({ apiKey: K, url })),
  [`${LC}lmChatOpenAi`]: openAiCred,
  // The completion node (POST /v1/completions on the base URL).
  [`${LC}lmOpenAi`]: openAiCred,
  [`${LC}lmChatGoogleGemini`]: viaCred("googlePalmApi", (url) => ({ apiKey: K, host: url })),
  [`${LC}lmChatOllama`]: viaCred("ollamaApi", (url) => ({ baseUrl: url })),
  // The completion node (POST /api/generate on the base URL), not the chat model.
  [`${LC}lmOllama`]: viaCred("ollamaApi", (url) => ({ baseUrl: url })),
  [`${LC}lmChatOpenRouter`]: viaCred("openRouterApi", (url) => ({ apiKey: K, url: `${url}/v1` })),
  // OpenAI-compatible chat models whose credential takes the base URL (ChatOpenAI on `url`).
  [`${LC}lmChatDeepSeek`]: viaCred("deepSeekApi", (url) => ({ apiKey: K, url: `${url}/v1` })),
  [`${LC}lmChatXAiGrok`]: viaCred("xAiApi", (url) => ({ apiKey: K, url: `${url}/v1` })),
  [`${LC}lmChatMoonshot`]: viaCred("moonshotApi", (url) => ({ apiKey: K, region: "international", url: `${url}/v1` })),
  [`${LC}lmChatNvidia`]: viaCred("nvidiaApi", (url) => ({ apiKey: K, url: `${url}/v1` })),
  [`${LC}lmChatMinimax`]: viaCred("minimaxApi", (url) => ({ apiKey: K, region: "international", url: `${url}/v1` })),
  [`${LC}lmChatVercelAiGateway`]: viaCred("vercelAiGatewayApi", (url) => ({ apiKey: K, url: `${url}/v1` })),
  // n8n appends /compatible-mode/v1 to the credential's url.
  [`${LC}lmChatAlibabaCloud`]: viaCred("alibabaCloudApi", (url) => ({ apiKey: K, region: "ap-southeast-1", workspaceId: "", url })),
  [`${LC}lmChatLemonade`]: viaCred("lemonadeApi", (url) => ({ apiKey: K, baseUrl: `${url}/v1` })),
  [`${LC}lmLemonade`]: viaCred("lemonadeApi", (url) => ({ apiKey: K, baseUrl: `${url}/v1` })),
  // Classic endpoint type with the optional endpoint field: AzureChatOpenAI posts to
  // <endpoint>/openai/deployments/<model>/chat/completions. Entra ID sign-in and the Claude
  // (Foundry, origin-only URL) model family cannot point at the shim.
  [`${LC}lmChatAzureOpenAi`]: viaCred("azureOpenAiApi", (url) => ({ endpointType: "classic", apiKey: K, resourceName: "bench", apiVersion: "2025-03-01-preview", endpoint: url }), (n) => {
    const p = n.parameters ?? {};
    if ((p.authentication ?? "azureOpenAiApi") !== "azureOpenAiApi") return "Entra ID (OAuth2) sign-in goes to Microsoft's token service, not the shim";
    if ((p.modelFamily ?? "openai") !== "openai") return "the Claude model family builds an origin-only Foundry URL that cannot carry the shim's tag";
    if (p.responsesApiEnabled) return "the Responses API needs a Foundry endpoint and a format the shim does not speak";
    return null;
  }),
  // Fixed hosts, OpenAI's chat format.
  [`${LC}lmChatGroq`]: viaHost("groqApi", () => "api.groq.com"),
  [`${LC}lmChatMistralCloud`]: viaHost("mistralCloudApi", () => "api.mistral.ai"),
  // Gemini's format on the Vertex host of the node's location (the bench's googleApi region
  // when the node names none); the service-account token exchange is a bench route.
  [`${LC}lmChatGoogleVertex`]: viaHost("googleApi", vertexHost, (n) => ((n.parameters?.authentication ?? "googleApi") === "googleApi" ? null : "the Vertex AI credential type has no bench dummy")),
  // @huggingface/inference 4.0.5 (provider "auto"): the hub lookup
  // GET huggingface.co/api/models/<model>?expand[]=inferenceProviderMapping is a bench route
  // (benchRoutes) naming hf-inference, then POST router.huggingface.co/hf-inference/models/<model>
  // ({inputs, parameters} -> [{generated_text}]) is forwarded to the shim.
  [`${LC}lmOpenHuggingFaceInference`]: {
    ...viaHost("huggingFaceApi", () => "router.huggingface.co", (n) => {
      if (n.parameters?.options?.endpointUrl) return "a node endpoint URL (options.endpointUrl) the bench does not route";
      const m = n.parameters?.model;
      return typeof m === "string" && m && !m.startsWith("=") ? null : "the model id is empty or an expression, so the hub lookup cannot be answered";
    }),
    benchRoutes: (n) => [{ method: "GET", url: `https://huggingface.co/api/models/${n.parameters.model}`, status: 200, headers: { "content-type": "application/json" }, body: { _id: "bench", id: n.parameters.model, inferenceProviderMapping: { "hf-inference": { status: "live", providerId: n.parameters.model, task: "text-generation" } } } }],
    benchHosts: ["huggingface.co"],
  },
  // Root nodes the fixture lists as models.
  // v1.x: text through /v1/chat/completions on the credential; image analysis through the same
  // path on api.openai.com (forwarded by host). v2 uses the Responses API, which the shim does
  // not speak.
  [`${LC}openAi`]: { ...openAiCred, root: true, when: (n) => (Number(n.typeVersion ?? 1) >= 2 ? "OpenAI node v2 calls the Responses API (/v1/responses), a format the shim does not speak" : n.parameters?.resource === "image" && n.parameters?.operation === "analyze" ? { host: "api.openai.com" } : textOnly()(n)) },
  "n8n-nodes-base.openAi": { ...openAiCred, root: true, when: textOnly(["text", "chat"]) },
  [`${LC}anthropic`]: { ...viaCred("anthropicApi", (url) => ({ apiKey: K, url })), root: true, when: textOnly() },
  [`${LC}googleGemini`]: { ...viaCred("googlePalmApi", (url) => ({ apiKey: K, host: url })), root: true, when: textOnly() },
  [`${LC}ollama`]: { ...viaCred("ollamaApi", (url) => ({ baseUrl: url })), root: true, when: textOnly() },
  [`${LC}moonshot`]: { ...viaCred("moonshotApi", (url) => ({ apiKey: K, region: "international", url: `${url}/v1` })), root: true, when: textOnly() },
};

// Model node types the shim does not answer, and why (validate.mjs names the reason).
export const UNSHIMMED_MODELS = {
  [`${LC}lmChatCohere`]: "fixed host (api.cohere.com, the credential's url is not used for chat) and Cohere's v2 chat format, which the shim does not speak",
  [`${LC}lmCohere`]: "fixed host and Cohere's generate format, which the shim does not speak",
  [`${LC}lmChatAwsBedrock`]: "AWS-signed Bedrock Converse API, a format the shim does not speak",
  [`${LC}lmChatDatabricks`]: "OAuth2 client credentials against an https workspace host (token route and host tag not built)",
  [`${LC}alibabaCloud`]: "the vendor node's text call is not OpenAI's chat path on the credential url (unverified)",
  [`${LC}miniMax`]: "the vendor node strips /v1 from the credential url and uses its own paths (unverified)",
};

// The route for a node: {spec, host?} or {why} (the shim cannot answer it) or null (not a
// model node). HTTP Request nodes listed as models are answered when they call a host+path the
// mock forwards to the shim (an LLM API over HTTP).
export function modelRoute(n, { listed = false } = {}) {
  const spec = SHIM_MODELS[n.type];
  if (spec) {
    if (spec.root && !listed) return null;
    const why = spec.when?.(n);
    if (why && typeof why === "object") return { spec: null, host: why.host };
    if (why) return { why: `${shortType(n.type)}: ${why}` };
    return spec.via === "host" ? { spec, host: spec.host(n) } : { spec };
  }
  if (UNSHIMMED_MODELS[n.type]) return { why: `${shortType(n.type)}: ${UNSHIMMED_MODELS[n.type]}` };
  if (n.type === "n8n-nodes-base.httpRequest" && listed) {
    let u = null;
    try {
      u = typeof n.parameters?.url === "string" && !n.parameters.url.startsWith("=") ? new URL(n.parameters.url) : null;
    } catch {}
    if (u && modelHost(u.hostname, u.pathname)) return { spec: null, host: u.hostname };
    return { why: `HTTP Request ${u ? u.hostname + u.pathname : "(URL built at run time)"} is not a model API the mock forwards to the shim` };
  }
  if (n.type.startsWith(LC) && /^lm/.test(shortType(n.type))) return { why: `${shortType(n.type)}: not a model type the shim answers` };
  return null;
}

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

// Model nodes the shim answers: LLM sub-nodes on the list, plus root nodes and LLM APIs over
// HTTP the fixture lists as models. Returns [{tag, node, type, credType, spec}]; a node routed
// by host has tag host:<host> (shared: another model node calls the same host, so their calls
// cannot be told apart). Nodes the shim cannot answer are left out (validate.mjs errors on
// them).
export function modelNodes(wf, fixture) {
  const out = [];
  let k = 0;
  for (const n of wf.nodes) {
    if (n.disabled) continue;
    const r = modelRoute(n, { listed: fixture.models.includes(n.name) });
    if (!r || r.why) continue;
    const tag = r.host ? `host:${r.host}` : `m${k++}`;
    const shared = r.host ? out.some((m) => m.tag === tag) : false;
    if (shared) for (const m of out) if (m.tag === tag) m.shared = true;
    out.push({ tag, node: n.name, type: n.type, credType: r.spec?.type ?? Object.keys(n.credentials ?? {})[0] ?? null, spec: r.spec?.via === "credential" ? r.spec : null, ...(r.host ? { host: r.host } : {}), ...(shared ? { shared: true } : {}), ...(r.spec?.benchRoutes ? { routes: r.spec.benchRoutes(n), hosts: r.spec.benchHosts ?? [] } : {}) });
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

// The bench's routes for the mock and the hosts that need a TLS leaf. PROPOSALS P48: a route
// whose URL cannot be parsed is left out and returned in `bad` ({node, method, url, error}), so
// the run reports a fixture error on that variant instead of throwing for the whole template.
export function routesOf(fixture) {
  const routes = [];
  const hosts = new Set();
  const bad = [];
  for (const r of [...fixture.reads, ...(fixture.writeReplies ?? [])]) {
    for (const x of r.http?.responses ?? []) {
      let u;
      try {
        u = new URL(x.url);
      } catch (e) {
        bad.push({ node: r.node, method: x.method, url: x.url, error: String(e.message) });
        continue;
      }
      routes.push({ node: r.node, method: x.method, url: x.url, ...(x.any ? { any: true } : {}), ...(x.query ? { query: x.query } : {}), ...(x.bodyMatch !== undefined ? { bodyMatch: x.bodyMatch } : {}), status: x.status, ...(x.headers ? { headers: x.headers } : {}), ...(x.body !== undefined ? { body: x.body } : {}), ...(x.bodyBase64 !== undefined ? { bodyBase64: x.bodyBase64 } : {}) });
      if (u.protocol === "https:") hosts.add(u.hostname);
    }
  }
  return { routes, hosts: [...hosts], bad };
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
  const originOf = (url) => {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  };
  const s3Endpoint = allResponses.filter((x) => s3Nodes.has(x.node)).map((x) => originOf(x.url)).filter(Boolean).sort((a, b) => a.length - b.length)[0];
  for (const n of wf.nodes) for (const t of Object.keys(n.credentials ?? {})) credentials[t] ??= credentialData(t, { wordpressUrl, s3Endpoint });
  // Overlay `credentials` (placeholder fills on a dummy, e.g. a service's domain the fixture
  // assumes): merged over the dummy of that credential type.
  for (const [t, fields] of Object.entries(overlay?.credentials ?? {})) {
    if (!credentials[t]) throw new Error(`overlay ${id}: no node uses credential type ${t}`);
    credentials[t] = { ...credentials[t], ...fields };
    for (const k of Object.keys(fields)) applied.push({ credential: t, field: k });
  }
  for (const m of models) {
    const n = wf.nodes.find((x) => x.name === m.node);
    // Routed by host (P18): the node keeps its own credential, or gets its type's dummy.
    if (m.host) {
      ensureLeaf(m.host);
      for (const h of m.hosts ?? []) ensureLeaf(h);
      if (m.credType && !Object.keys(n.credentials ?? {}).length) {
        n.credentials = { [m.credType]: { id: null, name: `${m.credType} (bench)` } };
        credentials[m.credType] ??= credentialData(m.credType);
        credentialsAttached.push({ node: n.name, type: m.credType });
      }
    }
    if (!m.spec) continue;
    const credName = `bench-model ${m.tag}`;
    n.credentials = { ...(n.credentials ?? {}), [m.spec.type]: { id: null, name: credName } };
    credentials[credName] = m.spec.data(`${MOCK}/model/${m.tag}`);
  }
  const { routes, hosts, bad: badRoutes } = routesOf(fx);
  for (const h of hosts) ensureLeaf(h);
  // OAuth refreshes and the service-account token exchange stay inside the mock too.
  for (const h of ["oauth2.googleapis.com", "www.googleapis.com", "api.anthropic.com", "api.openai.com"]) ensureLeaf(h);
  for (const m of models) for (const r of m.routes ?? []) routes.push({ node: "(bench)", ...r });
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
  // PROPOSALS P20: Form node pages after the trigger need the real submission too (a pinned
  // trigger runs in manual mode, where the first page waits for a test submission).
  const formPages = isForm && pinTrigger ? fx.trigger.formPages ?? [] : [];
  const via = binary || formPages.length ? (isForm ? "form" : "cli") : "pin";
  if (via !== "pin") sources[fx.trigger.node] = via === "form" ? `form (multipart submission: ${[binary && "binary trigger items", formPages.length && `${formPages.length} form page(s)`].filter(Boolean).join(", ")})` : "cli (Code-node swap: binary trigger items)";
  // A workflow that calls itself must be active for its sub-workflow calls to run (n8n 2.x).
  const selfCall = wf.nodes.some((n) => !n.disabled && /\.(executeWorkflow|toolWorkflow)$/.test(n.type) && /\$workflow\.id/.test(JSON.stringify(n.parameters?.workflowId ?? "")));
  return { pinTrigger, via, formPages, activate: selfCall || formPages.length > 0, id, variant, name, wf: { ...wf, name: `${id} ${name}` }, fixture: fx, credentials, credentialsAttached, routes, badRoutes, models, overlayApplied: applied, sources, files };
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
    .filter((e) => !e.fixture || e.fixture === "default" || e.fixture === "read-default")
    .filter((e) => !(e.method === "CONNECT" && /oauth2\.googleapis/.test(e.path)))
    .map((e) => ({ method: e.method, url: e.method === "CONNECT" ? `CONNECT ${e.path}` : `${e.proxied ?? ""}${e.path}`, query: e.rawQuery ?? "" }));
  const writeDefaults = service.filter((e) => e.fixture === "write-default").map((e) => ({ method: e.method, url: `${e.proxied ?? ""}${e.path}` }));
  // PROPOSALS P26: hosts the fixtures name no route for, reached through a leaf the mock made
  // from the bench CA (their requests are in `unanswered` or `writeDefaults` above).
  const noFixtureHosts = [...new Set(service.filter((e) => e.mintedLeaf).map((e) => String(e.proxied ?? "").replace(/^https?:\/\//, "")))];
  const used = new Set(service.map((e) => e.fixture).filter(Boolean));
  const unused = [];
  const seen = new Set();
  for (const r of prep.routes) {
    if (r.node === "(bench)") continue;
    const key = `route ${routeKey(r)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!used.has(key)) unused.push({ node: r.node, method: r.method, url: r.url, ...(r.any ? { any: true } : {}), ...(r.query ? { query: r.query } : {}), ...(r.bodyMatch !== undefined ? { bodyMatch: r.bodyMatch } : {}) });
  }
  return { unanswered, unused, writeDefaults, ...(noFixtureHosts.length ? { noFixtureHosts } : {}) };
}

// PROPOSALS P12: did a run with live model calls fail because the shim did not answer? A shim
// error, or n8n's run failing on a model node (or the root node it serves) with a transport
// error (n8n aborts a model request that waits too long). Such a run is about the machine,
// not the template, and is never saved as a recording. A model node that fails on what the
// model answered (a parser error) is a real baseline and is kept. Returns a reason or null.
const TRANSPORT_RE = /abort|offline|ECONNRESET|ECONNREFUSED|socket hang up|ETIMEDOUT|timed? ?out|overloaded|bench shim/i;
export function recordingInterrupted({ result, modelCalls = [], models = [], consumers = {} }) {
  const shimError = modelCalls.find((c) => c.mode === "error");
  if (shimError) return `model shim error on ${shimError.node ?? shimError.tag}#${shimError.index}: ${String(shimError.error ?? "").slice(0, 200)}`;
  if (!result || result.status === "success") return null;
  const modelSide = new Set(models.flatMap((m) => [m.node, ...(consumers[m.node] ?? [])]));
  const errs = [];
  if (result.error?.node || result.error?.message) errs.push({ node: result.error.node, message: result.error.message ?? "" });
  for (const [node, runs] of Object.entries(result.nodes ?? {})) for (const x of runs ?? []) if (x.error) errs.push({ node, message: typeof x.error === "string" ? x.error : x.error?.message ?? JSON.stringify(x.error) });
  const hit = errs.find((e) => modelSide.has(e.node) && TRANSPORT_RE.test(String(e.message)));
  return hit ? `${hit.node}: ${String(hit.message).slice(0, 200)}` : null;
}

// Runs one prepared template in n8n. `shim` is the started model shim; `modelSession` its
// session for this run. Retries once with pins for nodes that failed on their http source.
export async function runN8n(prep, { shim, modelSession, runWorkflow, copyIn, timeoutS = 240, allowFallback = true }) {
  // A host tag shared by two model nodes maps to the first (validate.mjs errors on such a fixture).
  const tagToNode = {};
  for (const m of prep.models) tagToNode[m.tag] ??= m.node;
  for (const f of prep.files) {
    const local = join(HERE, ".work", "files", f.path.replace(/[^\w.-]+/g, "_"));
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, f.base64 !== undefined ? Buffer.from(f.base64, "base64") : f.text ?? "");
    copyIn(local, containerPath(f.path));
  }
  shim.setSession({ ...modelSession, label: `${prep.id}/${prep.variant}` });
  const r = await runWorkflow(prep.wf, { trigger: prep.fixture.trigger.items, mock: { __routes: prep.routes, __writeDefault: { status: 200, body: {} } }, credentials: prep.credentials, via: prep.via ?? "pin", formPages: prep.formPages ?? [], triggerNode: prep.fixture.trigger.node, activate: !!prep.activate, keepPin: true, timeoutS, now: prep.fixture.now, pinTrigger: prep.pinTrigger });
  const calls = shim.session.calls.map((c) => ({ ...c, node: tagToNode[c.tag] ?? c.tag }));
  const failedNode = r.error?.node ?? Object.entries(r.nodes ?? {}).find(([, runs]) => runs.some((x) => x.error))?.[0];
  const fallbackable = allowFallback && failedNode && prep.fixture.reads.some((x) => x.node === failedNode && x.n8n && x.http?.responses?.length) && prep.sources[failedNode]?.startsWith("http");
  return { result: r, modelCalls: calls, failedNode, fallbackable };
}
