// Convert-time drafts (experimental, never offered: evals/bench/P137-RESULT.md; references/translation.md
// "Drafted request templates and tool maps"): the rules a drafted app REST request template or
// connector tool map must meet before it goes into a folder's overrides.json `drafts`, checked
// in code. Shared by convert.mjs (which re-checks every stored draft each time it converts, so a
// hand-edited overrides.json cannot slip one past) and draft.mjs (which asks a model for drafts
// and adds the run-time checks: try-step on synthetic items and a dry run with writes held).
// No model here.
//
// A draft is {kind, for, docs, entry, status, ...}: `entry` is an entry in tool-maps.json's own
// format (an `http` request template, or a connector `tool` with `args`), restricted to what a
// reviewer can check against the n8n node: every value is one of the node's parameters, the only
// hosts are the ones the node's parameters and its credential type name, and nothing widens the
// allowlist beyond the step's own request.

import { urlTarget, writtenTargets } from "../runtime/src/convert.mjs";

export const DRAFT_KINDS = ["rest-template", "tool-map"];
export const WRITE_BLOCK_REASON = "drafted write: needs a dry run against the real service and the person's approval";
// overrides.json `approve` id that unblocks one drafted write (the person's go-ahead after a
// dry run against the real service).
export const writeApproval = (step) => `drafted-write:${step}`;

const ENTRY_KEYS = {
  "rest-template": ["http", "credentialType", "placement", "effect", "result", "fidelity", "understood"],
  "tool-map": ["connector", "tool", "args", "effect", "result", "fidelity", "understood"],
};
const HTTP_KEYS = ["method", "url", "query", "body"];
const RESULT_KEYS = ["items", "passthrough", "wrap", "empty"];
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
const OUT_OF_SCOPE_LEVERS = ["vector", "db", "media"];
// A parameter path: dot-separated keys (a key may hold spaces, as a column name does), never an
// expression, a URL or quoted text.
const PATH_RE = /^(?!=)(?!.*:\/\/)[^.{}"'`\\]+(\.[^.{}"'`\\]+)*$/;
// A value that looks like a credential: provider key prefixes or a bearer token anywhere; a long
// opaque run of letters and digits unless the node's own parameters hold that exact value (an id).
const SECRET_RE = /\b(?:sk|pk|rk)_(?:live|test)_\w{6,}|\bsk-[A-Za-z0-9_-]{16,}|\bxox[abpr]-[\w-]{10,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bBearer\s+[\w.~+/-]{8,}|\bAIza[\w-]{30,}/;
const LONG_RUN_RE = /(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{32,}={0,2}/;
const looksSecret = (s, vocabulary) => SECRET_RE.test(s) || (LONG_RUN_RE.test(s) && !vocabulary.has(s));

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const uniq = (xs) => [...new Set(xs)];
const shortType = (t) => String(t).slice(String(t).lastIndexOf(".") + 1);

function getParam(params, path) {
  let v = params;
  for (const k of String(path).split(".")) {
    if (!isObj(v)) return undefined;
    v = v[k];
  }
  return v;
}

function allStrings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => allStrings(x, out));
  else if (isObj(v)) Object.values(v).forEach((x) => allStrings(x, out));
  return out;
}
function allKeys(v, out = []) {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) out.push(k), allKeys(x, out);
  return out;
}

// Hosts the node's own parameters write: literal http(s) URLs, and the addresses an expression
// URL writes itself (runtime/src/convert.mjs).
export function paramHosts(params) {
  const out = [];
  for (const s of allStrings(params ?? {})) {
    const t = urlTarget(s);
    if (t) out.push(t.host);
    for (const w of writtenTargets(s)) out.push(w.host);
  }
  return uniq(out);
}

// The registrable domain of a host (two labels; three under a two-letter country code with a
// generic second level such as co.uk).
export function regDomain(host) {
  const parts = String(host).toLowerCase().replace(/\.$/, "").split(".");
  if (parts.length <= 2) return parts.join(".");
  const [sld, tld] = parts.slice(-2);
  return (tld.length === 2 && ["co", "com", "org", "net", "ac", "gov", "edu"].includes(sld) ? parts.slice(-3) : parts.slice(-2)).join(".");
}

// What a blocked step may get a draft for, from the converter's block reason. -> null (not a
// kind drafts cover), {skip: reason} (the kind, but no draft could pass: no model call), or
// {kind, type, baseType, typeVersion, operation, credentialTypes, hosts, effect, connector?, tools?}.
// `operation` is the converter's opKey ("resource:operation", or the operation alone).
export function draftTarget(refs, { step, operation, reason }) {
  const type = step?.n8n?.type;
  if (!type || !operation) return null;
  const nodes = refs.nodes.nodes ?? {};
  const baseType = nodes[type]?.toolVariantOf ?? type;
  const node = nodes[baseType] ?? {};
  const rest = /^no request template for /.test(reason ?? "");
  const connectorOp = /^no tool map for (?!polling)/.test(reason ?? "");
  if (!rest && !connectorOp) return null;
  if (node.trigger || /Trigger$/.test(baseType)) return null;
  const levers = [...(node.mapping?.levers ?? []), ...(node.operations?.[operation]?.levers ?? [])];
  const base = { type, baseType, typeVersion: step.n8n.typeVersion ?? 1, operation };
  if (levers.some((l) => OUT_OF_SCOPE_LEVERS.includes(l))) return { ...base, skip: "vector stores, databases and media are out of scope for drafts" };
  const named = Object.keys(step.credentials ?? {});
  const credentialTypes = named.length ? named : [...(node.credentials ?? [])];
  const credHosts = refs.toolMaps.credentialHosts ?? {};
  const hosts = uniq([...credentialTypes.flatMap((t) => credHosts[t] ?? []), ...paramHosts(step.params)]);
  const effect = node.operations?.[operation]?.effect === "read" ? "read" : "write";
  // The credential a request template uses: the first of the node's that names a host.
  const credentialType = credentialTypes.find((c) => (credHosts[c] ?? []).length) ?? credentialTypes[0] ?? null;
  const t = { ...base, credentialTypes, credentialType, hosts, effect };
  if (connectorOp) {
    const connector = node.operations?.[operation]?.connector ?? node.mapping?.connector;
    const tools = connector ? refs.connectors?.[connector]?.tools ?? [] : [];
    if (tools.length) return { ...t, kind: "tool-map", connector, tools: tools.map((x) => x.name) };
    if (!hosts.length) return { ...t, skip: `the ${connector ?? "app's"} connector has no captured tools and the node's credential names no host for its REST API` };
    return { ...t, kind: "rest-template" };
  }
  if (!hosts.length) return { ...t, skip: "the node's parameters and credential name no host, so a drafted request would have nowhere it may go" };
  return { ...t, kind: "rest-template" };
}

// The draft's `for`: what it was drafted against. A draft whose `for` no longer matches the
// step (another operation, version or credential) is stale and not applied.
export function draftFor(target) {
  return { type: target.type, typeVersion: target.typeVersion, operation: target.operation, credentialTypes: [...target.credentialTypes] };
}
export function sameFor(a, b) {
  return isObj(a) && isObj(b) && a.type === b.type && a.typeVersion === b.typeVersion && a.operation === b.operation && JSON.stringify([...(a.credentialTypes ?? [])].sort()) === JSON.stringify([...(b.credentialTypes ?? [])].sort());
}

// The effect the step is treated as having: a write when n8n counts the operation as a write,
// the draft says so, or its request uses a writing method (the runtime's ledger counts it so).
export function draftEffect(target, draft) {
  const e = draft?.entry ?? {};
  if (target.effect === "write" || e.effect !== "read") return "write";
  if (e.http && !["GET", "HEAD"].includes(String(e.http.method).toUpperCase())) return "write";
  return "read";
}

// ---------- the rules ----------

const refuse = (rule, reason) => ({ ok: false, rule, reason });

// Rule "docs": an https URL on the app's own domain (a host the node names, or a domain whose
// name is the app's or the connector's).
function checkDocs(target, docs) {
  let u;
  try {
    u = new URL(String(docs ?? ""));
  } catch {
    return refuse("docs", "cites no API docs (docs must be an https URL of the app's API reference)");
  }
  if (u.protocol !== "https:" || u.username || u.password || /^[\d.]+$|:/.test(u.hostname)) return refuse("docs", `docs ${docs} is not a plain https URL`);
  const dom = regDomain(u.hostname);
  const label = dom.split(".")[0];
  const names = uniq([shortType(target.baseType), ...String(shortType(target.baseType)).split(/(?=[A-Z])/), ...String(target.connector ?? "").split("-")].map((s) => s.toLowerCase()).filter((s) => s.length >= 3));
  if (target.hosts.map(regDomain).includes(dom) || names.includes(label)) return null;
  return refuse("docs", `docs ${docs} is not on the app's own domain (${uniq([...target.hosts.map(regDomain), ...names.map((n) => `${n}.*`)]).join(", ")})`);
}

// Rule "fields": every value comes from the node's parameters. A spec is a parameter path, a
// {param, default} with a constant default, a constant, or an object or list of specs. A constant may
// be a number, a boolean or null, or a string the node's parameters hold as a value or a name.
function checkSpec(spec, where, ctx) {
  const constOk = (v, w) => {
    if (v === null || typeof v === "number" || typeof v === "boolean") return null;
    if (typeof v === "string") return ctx.vocabulary.has(v) ? null : refuse("fields", `${w} adds the value ${JSON.stringify(v.slice(0, 60))}, which is not among the node's parameters`);
    if (Array.isArray(v)) {
      for (const [i, x] of v.entries()) {
        const r = constOk(x, `${w}[${i}]`);
        if (r) return r;
      }
      return null;
    }
    if (isObj(v)) {
      for (const [k, x] of Object.entries(v)) {
        const r = constOk(x, `${w}.${k}`);
        if (r) return r;
      }
      return null;
    }
    return refuse("fields", `${w} holds a value of an unknown type`);
  };
  if (Array.isArray(spec)) {
    for (const [i, s] of spec.entries()) {
      const r = checkSpec(s, `${where}[${i}]`, ctx);
      if (r) return r;
    }
    return null;
  }
  if (typeof spec === "string") {
    if (!PATH_RE.test(spec)) return refuse("fields", `${where} reads "${spec.slice(0, 60)}", which is not a parameter path of the node`);
    ctx.reads.add(spec);
    return null;
  }
  if (!isObj(spec)) return refuse("fields", `${where} is neither a parameter path nor a constant`);
  if ("const" in spec) return Object.keys(spec).length === 1 ? constOk(spec.const, where) : refuse("fields", `${where} mixes const with other keys`);
  if ("param" in spec) {
    if (Object.keys(spec).some((k) => !["param", "default"].includes(k))) return refuse("fields", `${where} uses a spec form drafts may not use (${Object.keys(spec).filter((k) => !["param", "default"].includes(k)).join(", ")})`);
    if (typeof spec.param !== "string" || !PATH_RE.test(spec.param)) return refuse("fields", `${where} reads a parameter path that is not one`);
    ctx.reads.add(spec.param);
    return "default" in spec ? constOk(spec.default, `${where} (default)`) : null;
  }
  for (const k of ["concat", "if", "map", "binary", "extract", "json", "prefix", "when"]) if (k in spec) return refuse("fields", `${where} uses a spec form drafts may not use (${k})`);
  for (const [k, s] of Object.entries(spec)) {
    const r = checkSpec(s, `${where}.${k}`, ctx);
    if (r) return r;
  }
  return null;
}

// Rule "hosts": the URL is https on a host the node names; literal parts carry no query,
// fragment, user info or port, and parameter parts are parameter paths (rule "fields").
// Accepted forms: a literal URL, or {concat: [{const: "https://host/..."}, "param", {const}...], sep: ""}.
function checkUrl(target, url, ctx) {
  let parts;
  if (typeof url === "string") parts = [{ const: url }];
  else if (isObj(url) && Array.isArray(url.concat) && url.sep === "" && Object.keys(url).length === 2) parts = url.concat;
  else return refuse("hosts", "the URL must be a literal https URL or a concat of literal parts and parameter paths");
  const first = parts[0];
  if (!isObj(first) || typeof first.const !== "string") return refuse("hosts", "the URL must start with a literal https://host/");
  const m = /^https:\/\/([^/?#{}\s]+)(\/[^?#\s]*)?$/.exec(first.const);
  if (!m) return refuse("hosts", `the URL ${JSON.stringify(first.const.slice(0, 80))} is not an https URL with a literal host and path`);
  const host = m[1].toLowerCase();
  if (/[@:]/.test(host)) return refuse("hosts", `the URL's host ${host} carries user info or a port`);
  if (!target.hosts.includes(host)) return refuse("hosts", `adds the host ${host} beyond what the node's parameters and credential name (${target.hosts.join(", ") || "none"})`);
  for (const [i, p] of parts.entries()) {
    if (isObj(p) && typeof p.const === "string" && Object.keys(p).length === 1) {
      const lit = i === 0 ? p.const.replace(/^https:\/\/[^/]+/, "") : p.const;
      if (/[?#]|:\/\//.test(lit)) return refuse("hosts", `the URL's literal part ${JSON.stringify(lit.slice(0, 60))} adds a query, a fragment or another address (query fields go in http.query)`);
      if (lit.replace(/\{\{secret\}\}/g, "").includes("{{")) return refuse("hosts", "the URL's literal part holds an expression");
      ctx.secretSlots += (lit.match(/\{\{secret\}\}/g) ?? []).length;
      if (looksSecret(lit, ctx.vocabulary)) return refuse("secrets", "the URL holds a value that looks like a secret");
    } else {
      const r = checkSpec(p, `http.url part ${i}`, ctx);
      if (r) return r;
      if (!(typeof p === "string" || (isObj(p) && "param" in p))) return refuse("hosts", "a URL part is neither literal text nor a parameter");
    }
  }
  ctx.host = host;
  return null;
}

function checkResult(result) {
  if (result === undefined) return null;
  if (!isObj(result)) return refuse("shape", "result must be an object");
  const extra = Object.keys(result).filter((k) => !RESULT_KEYS.includes(k));
  if (extra.length) return refuse("shape", `result keys drafts may not use: ${extra.join(", ")}`);
  if (result.items !== undefined && (typeof result.items !== "string" || result.items.length > 120)) return refuse("shape", "result.items must be a path");
  return null;
}

function checkArgsAgainst(schema, args) {
  if (!schema) return refuse("allow", "the tool has no captured input schema");
  const missing = (schema.required ?? []).filter((k) => args[k] === undefined);
  const unknown = Object.keys(args).filter((k) => !(k in (schema.properties ?? {})));
  if (missing.length) return refuse("allow", `required tool arguments without a value: ${missing.join(", ")}`);
  if (unknown.length) return refuse("allow", `arguments the tool does not take: ${unknown.join(", ")}`);
  return null;
}

// The static rules, in order. `params` are the step's n8n parameters (as the converter has
// them: inline secrets already redacted). -> {ok: true, reads: [parameter paths]} | {ok: false,
// rule, reason}. Rules: kind, docs, shape, hosts, fields, secrets, allow, effect.
export function validateDraft(refs, target, draft, { params = {} } = {}) {
  if (!target || target.skip) return refuse("kind", target?.skip ?? "the step is not one drafts cover");
  if (!isObj(draft) || !DRAFT_KINDS.includes(draft.kind)) return refuse("kind", `kind must be one of ${DRAFT_KINDS.join(", ")}`);
  if (draft.kind !== target.kind) return refuse("kind", `the step needs a ${target.kind}, not a ${draft.kind}`);
  const docs = checkDocs(target, draft.docs);
  if (docs) return docs;
  const e = draft.entry;
  if (!isObj(e)) return refuse("shape", "entry is missing");
  const extra = Object.keys(e).filter((k) => !ENTRY_KEYS[draft.kind].includes(k));
  if (extra.length) return refuse(extra.some((k) => ["allow", "hosts", "secrets", "site", "rest"].includes(k)) ? "allow" : "shape", `entry keys drafts may not use: ${extra.join(", ")}`);
  if (e.fidelity !== undefined && e.fidelity !== "unverified") return refuse("shape", "a draft's fidelity is unverified until a person reviews it");
  if (!["read", "write"].includes(e.effect)) return refuse("effect", "effect must be read or write");
  const r0 = checkResult(e.result);
  if (r0) return r0;
  const vocabulary = new Set([...allStrings(params), ...allKeys(params)].filter((s) => typeof s === "string" && !s.startsWith("=")));
  const ctx = { vocabulary, reads: new Set(), secretSlots: 0, host: null };
  if (draft.kind === "rest-template") {
    const h = e.http;
    if (!isObj(h)) return refuse("shape", "a request template needs http");
    const hx = Object.keys(h).filter((k) => !HTTP_KEYS.includes(k));
    if (hx.length) return refuse(hx.includes("headers") ? "secrets" : "shape", `http keys drafts may not use: ${hx.join(", ")}${hx.includes("headers") ? " (the credential is attached by the runtime; headers could carry one)" : ""}`);
    if (!METHODS.includes(h.method)) return refuse("shape", `http.method must be one of ${METHODS.join(", ")} (a literal, never an expression)`);
    const u = checkUrl(target, h.url, ctx);
    if (u) return u;
    for (const k of ["query", "body"]) {
      if (h[k] === undefined) continue;
      if (!isObj(h[k])) return refuse("fields", `http.${k} must be an object of fields`);
      const r = checkSpec(h[k], `http.${k}`, ctx);
      if (r) return r;
    }
    if (!target.credentialTypes.includes(e.credentialType)) return refuse("secrets", `credentialType ${e.credentialType} is not the node's (${target.credentialTypes.join(", ") || "none"})`);
    const ch = refs.toolMaps.credentialHosts?.[e.credentialType] ?? [];
    if (ch.length && !ch.includes(ctx.host) && !paramHosts(params).includes(ctx.host)) return refuse("secrets", `the ${e.credentialType} secret may go only to ${ch.join(", ")}, not ${ctx.host}`);
    const placement = e.placement ?? "header";
    if (!["header", "url"].includes(placement)) return refuse("secrets", `placement must be header or url, not ${placement}`);
    if (placement === "url" && (typeof h.url !== "string" || ctx.secretSlots !== 1)) return refuse("secrets", "placement url needs a literal URL with exactly one {{secret}}");
    if (placement === "header" && ctx.secretSlots) return refuse("secrets", "{{secret}} in the URL needs placement url");
  } else {
    if (e.connector !== target.connector) return refuse("allow", `connector ${e.connector} is not the node's (${target.connector}): a draft never widens allow to another connector`);
    if (!target.tools.includes(e.tool)) return refuse("allow", `${e.connector} has no tool ${e.tool} in its captured catalogue`);
    if (!isObj(e.args)) return refuse("fields", "args must be an object");
    for (const [k, s] of Object.entries(e.args)) {
      const r = checkSpec(s, `args.${k}`, ctx);
      if (r) return r;
    }
    const schema = refs.connectors?.[e.connector]?.tools?.find((x) => x.name === e.tool)?.inputSchema;
    const a = checkArgsAgainst(schema, e.args);
    if (a) return a;
  }
  for (const s of [...allStrings(e), String(draft.docs ?? "")]) if (looksSecret(s, vocabulary)) return refuse("secrets", "the draft holds a value that looks like a secret; secrets go by name only");
  if (allStrings(e).some((s) => s.includes("{{secret}}")) && !(draft.kind === "rest-template" && e.placement === "url")) return refuse("secrets", "{{secret}} appears outside a placement-url URL");
  if (target.effect === "write" && e.effect === "read") return refuse("effect", "claims read for an operation n8n counts as a write");
  if (e.http && e.effect === "read" && !["GET", "HEAD"].includes(e.http.method) && target.effect !== "read") return refuse("effect", `claims read for a ${e.http.method} request`);
  return { ok: true, reads: [...ctx.reads] };
}

// Rule "allow", after conversion: what the drafted definition allows beyond the plain one is only
// the drafted steps' own requests (http to a host each step's target names, tools of each step's
// connector) and their secrets to those hosts. -> null | {ok: false, rule, reason}
export function checkAllowDiff(base, drafted, targets) {
  const hosts = new Set(Object.values(targets).flatMap((t) => t.hosts));
  const connectors = new Set(Object.values(targets).map((t) => t.connector).filter(Boolean));
  const key = (x) => JSON.stringify(x);
  const had = (list, x) => (list ?? []).some((y) => key({ ...y, note: undefined }) === key({ ...x, note: undefined }));
  for (const a of drafted.allow?.http ?? []) {
    if (had(base.allow?.http, a)) continue;
    if (a.host === "*" || a.scope || !hosts.has(a.host)) return refuse("allow", `widens allow.http to ${a.method} ${a.host}${a.pathPrefix ?? ""}`);
  }
  for (const t of drafted.allow?.tools ?? []) if (!had(base.allow?.tools, t) && !connectors.has(t.connector)) return refuse("allow", `widens allow.tools to ${t.connector}.${t.tool}`);
  for (const k of Object.keys(drafted.allow ?? {})) {
    if (["http", "tools"].includes(k)) continue;
    if (key(drafted.allow[k] ?? []) !== key(base.allow?.[k] ?? [])) return refuse("allow", `widens allow.${k}`);
  }
  for (const s of drafted.secrets ?? []) {
    const b = (base.secrets ?? []).find((x) => x.name === s.name);
    const added = s.hosts.filter((h) => !(b?.hosts ?? []).includes(h));
    const bad = added.filter((h) => !hosts.has(h));
    if (bad.length) return refuse("allow", `sends the secret "${s.name}" to ${bad.join(", ")}`);
  }
  return null;
}

// ---------- the model's reply -> a draft ----------

// A URL template "https://host/v0/{base}/{table}" (each {…} a parameter path) -> the URL spec
// of a tool-maps entry: a literal string, or a concat of literal parts and parameter paths.
export function compileUrl(template) {
  const s = String(template ?? "");
  if (!/\{(?!\{secret\}\})[^{}]+\}/.test(s.replace(/\{\{secret\}\}/g, ""))) return s;
  const parts = [];
  let last = 0;
  for (const m of s.matchAll(/\{\{secret\}\}|\{([^{}]+)\}/g)) {
    if (m[0] === "{{secret}}") continue;
    if (m.index > last) parts.push({ const: s.slice(last, m.index) });
    parts.push(m[1].trim());
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push({ const: s.slice(last) });
  return { concat: parts, sep: "" };
}

// The model's reply (draft-prompt.md's answer shape) -> {draft} | {decline}. Fields the code
// sets itself (connector, fidelity, understood, credentialType when the node has one) are never
// taken from the reply.
export function compileReply(target, reply) {
  if (!isObj(reply)) return { decline: "the reply is not a JSON object" };
  if (typeof reply.decline === "string" && reply.decline.trim()) return { decline: reply.decline.trim().slice(0, 300) };
  const base = { kind: target.kind, docs: typeof reply.docs === "string" ? reply.docs.trim() : reply.docs };
  const result = isObj(reply.result) ? reply.result : {};
  if (target.kind === "rest-template") {
    const http = { method: String(reply.method ?? "").toUpperCase(), url: compileUrl(reply.url) };
    if (isObj(reply.query) && Object.keys(reply.query).length) http.query = reply.query;
    if (isObj(reply.body) && Object.keys(reply.body).length) http.body = reply.body;
    const credentialType = target.credentialTypes.includes(reply.credentialType) ? reply.credentialType : target.credentialType;
    const entry = { http, credentialType, ...(reply.placement === "url" ? { placement: "url" } : {}), effect: reply.effect, result, fidelity: "unverified" };
    return { draft: { ...base, entry } };
  }
  return { draft: { ...base, entry: { connector: target.connector, tool: reply.tool, args: isObj(reply.args) ? reply.args : {}, effect: reply.effect, result, fidelity: "unverified" } } };
}

// `understood` for a validated draft: the parameters it reads plus resource and operation, so
// the converter flags any other parameter set on the node (review: "no counterpart").
export function withUnderstood(draft, reads) {
  return { ...draft, entry: { ...draft.entry, understood: uniq(["resource", "operation", ...reads]) } };
}
