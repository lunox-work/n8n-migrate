// Basic converter: n8n workflow JSON -> definition (schemaVersion 1).
//
// Logic steps keep their n8n parameters verbatim; the runtime evaluates expressions
// natively. HTTP Request steps get an allowlist entry when the URL's host is literal, and
// their credential becomes a named secret (never a value). Connector, model and agent
// steps get their kind but no tool/model/agent block yet (a later converter fills them),
// so preflight reports them until then. Unmapped and blocked nodes become `blocked`.
// Workflow content is data: names, notes and parameters are copied, never followed.

import { deepCopy, isObject, stableStringify } from "./util.mjs";
import { hashHex } from "./hash.mjs";
import { DEFINITION_SCHEMA_VERSION } from "./api.mjs";

const BASE = "n8n-nodes-base.";
const BRANCH = new Set(["if", "switch", "filter"].map((t) => BASE + t));
const CODE = new Set(["code", "function", "functionItem"].map((t) => BASE + t));
const SETTING_KEYS = ["alwaysOutputData", "executeOnce", "retryOnFail", "maxTries", "waitBetweenTries", "onError", "continueOnFail", "disabled"];

export function unwrapWorkflow(json) {
  if (json?.workflow?.workflow?.nodes) return json.workflow.workflow;
  if (json?.workflow?.nodes) return json.workflow;
  if (Array.isArray(json?.nodes)) return json;
  throw new Error("not an n8n workflow (no nodes)");
}

function strings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (isObject(v)) Object.values(v).forEach((x) => strings(x, out));
  return out;
}

// Literal host and path prefix of an http(s) URL parameter, if the host is not an expression.
export function urlTarget(url) {
  if (typeof url !== "string") return null;
  let s = url;
  if (s.startsWith("=")) {
    s = s.slice(1);
    const i = s.indexOf("{{");
    if (i === 0) return null;
    if (i > 0) s = s.slice(0, i);
  }
  const m = /^(https?):\/\/([^/?#{}\s]+)(\/[^?#{}\s]*)?/i.exec(s.trim());
  if (!m) return null;
  const host = m[2].replace(/:\d+$/, "").toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  const full = s.trim().length === m[0].length;
  let path = m[3] || "/";
  if (!full) path = path.slice(0, path.lastIndexOf("/") + 1) || "/";
  return { host, pathPrefix: path };
}

function kindFor(node, entry) {
  const type = node.type;
  if (!entry) return { kind: "blocked", reason: "node type not in the catalogue" };
  if (entry.mapping === "unmapped") return { kind: "blocked", reason: "unmapped node type" };
  const m = entry.mapping;
  const role = typeof m.role === "string" ? m.role : "step";
  if (role === "annotation") return { kind: null };
  if (role === "trigger" || (role === "n8n-internal" && entry.trigger)) return { kind: "trigger" };
  const subnode = role === "subnode";
  if (BRANCH.has(type)) return { kind: "branch" };
  if (CODE.has(type)) return { kind: "code" };
  if (type === BASE + "splitInBatches") return { kind: "loop" };
  if (type === BASE + "wait") return { kind: "sleep" };
  if (type === BASE + "executeWorkflow") return { kind: "subflow" };
  if (type === BASE + "respondToWebhook") return { kind: "respond" };
  if (type === BASE + "httpRequest") return { kind: "http" };
  switch (m.kind) {
    case "logic":
    case undefined:
      return { kind: "logic", subnode };
    case "code":
      return { kind: "code", subnode };
    case "http":
      return { kind: "http", subnode };
    case "connector":
      return { kind: "tool", subnode, connector: m.connector };
    case "model":
      return { kind: "model", subnode };
    case "agent":
      return { kind: "agent", subnode };
    case "subworkflow":
      return { kind: "subflow", subnode };
    case "wait":
      return { kind: "sleep", subnode };
    case "blocked":
      return { kind: "blocked", reason: m.reason || "blocked node type", subnode };
    default:
      return { kind: "blocked", reason: `${m.kind} step: not converted by the basic converter`, subnode };
  }
}

function reviewReasons(node, kind, subnode) {
  const r = [];
  const all = strings(node.parameters ?? {}).join("\n");
  if (kind === "code") {
    r.push("Code runs natively from the workflow; review it");
    if (/python/i.test(node.parameters?.language ?? "")) r.push("Python code needs translation");
    if (/\brequire\s*\(/.test(all)) r.push("uses require()");
    if (/\bhelpers\s*\./.test(all)) r.push("uses this.helpers");
    if (/\$getWorkflowStaticData/.test(all)) r.push("uses workflow static data");
  }
  if (!subnode && /\$fromA[Ii]\s*\(/.test(all)) r.push("$fromAI() outside an agent tool");
  if (/\$env\b/.test(all)) r.push("reads $env (blocked)");
  return r;
}

export function fromN8n(workflowJson, { nodes, sourceText, file } = {}) {
  const wf = unwrapWorkflow(workflowJson);
  const catalogue = nodes?.nodes ?? nodes ?? {};
  const steps = {};
  const allow = { tools: [], http: [], sql: [] };
  const secrets = new Map();
  const notes = [];
  for (const node of wf.nodes ?? []) {
    if (typeof node?.name !== "string" || typeof node?.type !== "string") continue;
    const k = kindFor(node, catalogue[node.type]);
    if (k.kind === null) continue;
    const step = {
      kind: k.kind,
      n8n: { type: node.type, typeVersion: node.typeVersion ?? 1, ...(typeof node.id === "string" ? { id: node.id } : {}), position: node.position ?? [0, 0], ...(node.webhookId ? { webhookId: node.webhookId } : {}) },
      params: deepCopy(node.parameters ?? {}),
      settings: Object.fromEntries(SETTING_KEYS.filter((s) => node[s] !== undefined && node[s] !== null).map((s) => [s, node[s]])),
    };
    if (k.subnode) step.subnode = true;
    if (k.kind === "blocked") step.blocked = { reason: k.reason };
    if (k.kind === "tool" && k.connector) step.connector = k.connector;
    const creds = Object.entries(node.credentials ?? {});
    if (creds.length) {
      step.credentials = Object.fromEntries(creds.map(([type, ref]) => [type, ref?.name ?? String(ref?.id ?? "")]));
    }
    if (k.kind === "http" && node.type === BASE + "httpRequest") {
      const target = urlTarget(node.parameters?.url);
      const method = String(node.parameters?.method ?? node.parameters?.requestMethod ?? "GET").toUpperCase();
      if (target) {
        if (!allow.http.some((a) => a.method === method && a.host === target.host && a.pathPrefix === target.pathPrefix)) allow.http.push({ method, host: target.host, pathPrefix: target.pathPrefix });
      } else notes.push(`step "${node.name}": the URL host is an expression, so no allowlist entry was made`);
      const auth = node.parameters?.authentication;
      if (auth && auth !== "none" && creds.length) {
        const credType = auth === "genericCredentialType" ? node.parameters?.genericAuthType : node.parameters?.nodeCredentialType;
        const ref = node.credentials?.[credType] ?? creds[0][1];
        const name = ref?.name ?? String(ref?.id ?? credType);
        step.auth = { credentialType: credType ?? creds[0][0], secret: name };
        const s = secrets.get(name) ?? { name, credentialType: step.auth.credentialType, hosts: [] };
        if (target && !s.hosts.includes(target.host)) s.hosts.push(target.host);
        secrets.set(name, s);
      }
    }
    if (node.type === BASE + "executeWorkflow") {
      const src = node.parameters?.source ?? "database";
      if (src === "parameter" && typeof node.parameters?.workflowJson === "string" && !node.parameters.workflowJson.startsWith("=")) {
        try {
          step.subflow = { definition: fromN8n(JSON.parse(node.parameters.workflowJson), { nodes }) };
        } catch {
          notes.push(`step "${node.name}": the inline sub-workflow JSON could not be read`);
        }
      } else if (src === "database") {
        const id = node.parameters?.workflowId;
        const value = typeof id === "object" && id !== null ? id.value : id;
        if (typeof value === "string" && (/^=?\s*\{\{\s*\$workflow\.id\s*\}\}\s*$/.test(value) || (wf.id !== undefined && value === String(wf.id)))) step.subflow = { self: true };
      }
    }
    const reasons = reviewReasons(node, k.kind, k.subnode);
    if (reasons.length) {
      step.review = true;
      step.reviewReasons = reasons;
    }
    if (node.notes) step.notes = String(node.notes);
    steps[node.name] = step;
  }
  const edges = [];
  const subnodes = [];
  for (const [from, byType] of Object.entries(wf.connections ?? {})) {
    for (const [type, outputs] of Object.entries(byType ?? {})) {
      (outputs ?? []).forEach((conns, outIndex) => {
        for (const c of conns ?? []) {
          if (!c || typeof c.node !== "string") continue;
          if (type === "main") edges.push({ from, fromOutput: outIndex, to: c.node, toInput: c.index ?? 0 });
          else subnodes.push({ from, to: c.node, type });
        }
      });
    }
  }
  const text = sourceText ?? stableStringify(workflowJson);
  return {
    schemaVersion: DEFINITION_SCHEMA_VERSION,
    name: String(wf.name ?? "workflow"),
    ...(wf.id !== undefined ? { id: String(wf.id) } : {}),
    source: { ...(file ? { file } : {}), sha256: hashHex("sha256", text), ...(sourceText === undefined ? { canonical: true } : {}) },
    // A missing executionOrder becomes "v1": n8n's editor saves v1 when a template or file is
    // imported. (Created through the REST API or CLI without it, n8n runs its legacy v0 order;
    // on the corpus that changed the order of nodes, not their outputs: evals/diff/REPORT.md.)
    settings: { ...(wf.settings?.timezone ? { timezone: wf.settings.timezone } : {}), executionOrder: wf.settings?.executionOrder ?? "v1" },
    steps,
    edges,
    subnodes,
    allow,
    secrets: [...secrets.values()],
    ...(notes.length ? { notes } : {}),
  };
}
