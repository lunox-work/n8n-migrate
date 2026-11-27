#!/usr/bin/env node
// Differential test: one workflow through real n8n (the oracle) and through our runner,
// same trigger, same pins, same HTTP fixtures; prints a diff report and a verdict.
//
//   node evals/diff/differential.mjs <workflow.json> [--trigger t.json] [--pins pins.json]
//        [--fixtures f.json] [--order v0|v1] [--out dir] [--save-fixture tests/fixtures/n8n-observed/x.json] [--quiet]
//
// --save-fixture stores the prepared workflow, pins, HTTP fixtures and n8n's run (status,
// run data, request log) as a regression fixture; replayObserved() reruns our side
// against it without a container (tests/n8n-observed.test.mjs).
//
// n8n side: evals/n8n/run-workflow.mjs over REST in manual mode (the container must be
// up), every pinned node in the workflow's pinData, the trigger pinned too.
// Our side: fromN8n + run() in-process with the same pinData; its `http` host sends each
// request to an in-process copy of the mock server with the same fixture map, so both
// sides see identical responses and both request logs have the same shape.
//
// Pinned on both sides: the trigger and every node that is not logic (connectors, models,
// agents, vector stores, files, sub-workflows, HTTP Request with a credential, pagination
// or a file response). Before running, both sides get the same rewrites, listed in the
// report: https:// in HTTP Request URLs becomes http:// (so the mock answers instead of
// refusing CONNECT), a Wait node becomes a NoOp of the same name, credentials are dropped
// (n8n redacts execution data that touches a credential the user cannot open), and a
// missing executionOrder becomes "v1" (what n8n's editor saves; --order overrides).
//
// Compared: workflow status and failing node; per node the run count, each run's output
// branches and items (json after a canonical key sort, pairedItem as its own class) and
// error; the execution order; the ordered HTTP requests (method, origin, path, query as
// sent, body, headers minus volatile ones, content-type kept). Time: two ISO timestamps
// (alone or inside strings) or two epoch numbers within TIME_TOLERANCE_MS count as equal;
// the report says how many comparisons that touched.
//
// Verdict: "same", "diff:<class,...>", or "skip:<reason>" when the workflow does not
// qualify (unknown node type, the runner cannot preflight it, n8n refuses it).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { request as httpRequest } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runWorkflow, pickTrigger, scheduleItem } from "../n8n/run-workflow.mjs";
import { startMock } from "../n8n/mock-server.mjs";
// DIFF_RUNTIME_SRC points at another copy of runtime/src (e.g. an older commit's, for a
// before/after count); default: this checkout's.
const RUNTIME_SRC = resolve(process.env.DIFF_RUNTIME_SRC || join(dirname(fileURLToPath(import.meta.url)), "../../skills/n8n-to-claude/runtime/src"));
const { fromN8n } = await import(pathToFileURL(join(RUNTIME_SRC, "convert.mjs")).href);
const { run: runnerRun, preflight } = await import(pathToFileURL(join(RUNTIME_SRC, "api.mjs")).href);
import { makePins } from "./pins.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
export const CATALOGUE = JSON.parse(readFileSync(join(ROOT, "skills/n8n-to-claude/references/nodes.json"), "utf8"));
export const DIFF_WORK = resolve(process.env.DIFF_WORK || join(HERE, ".work"));
export const TIME_TOLERANCE_MS = 120_000;
export const DEFAULT_FIXTURES = { default: { status: 200, body: { ok: true, id: "mock-1", data: [{ id: 1, name: "one" }, { id: 2, name: "two" }] } } };
const BASE = "n8n-nodes-base.";

// ---------- classification ----------

const CODE_TYPES = new Set([BASE + "code", BASE + "function", BASE + "functionItem"]);

function httpIsLogic(node) {
  const p = node.parameters ?? {};
  if ((node.typeVersion ?? 1) < 3) return "HTTP Request below v3";
  if (p.authentication && p.authentication !== "none") return "credential";
  if (p.options?.pagination) return "pagination";
  if (p.options?.response?.response?.responseFormat === "file") return "file response";
  if (["binaryData"].includes(p.contentType)) return "binary body";
  if ((p.bodyParameters?.parameters ?? []).some((x) => x.parameterType === "formBinaryData")) return "binary form field";
  return true;
}

// "logic" (runs on both sides), "pin", "annotation", "subnode", or {skip: reason}.
export function classify(node) {
  const entry = CATALOGUE.nodes[node.type];
  if (!entry) return { skip: `node type ${node.type} is not in n8n 2.47's catalogue` };
  if (!["n8n-nodes-base", "@n8n/n8n-nodes-langchain"].includes(entry.package)) return { skip: `community node ${node.type} (not installed in the bench)` };
  const m = entry.mapping;
  if (m === "unmapped") return "pin";
  if (m.role === "annotation") return "annotation";
  if (m.role === "subnode") return "subnode";
  if (m.role === "trigger" || entry.trigger) return "pin";
  if (node.type === BASE + "httpRequest") return httpIsLogic(node) === true ? "logic" : "pin";
  if (node.type === BASE + "wait") return "logic"; // becomes a NoOp
  if (CODE_TYPES.has(node.type)) return "logic";
  if (node.type === BASE + "executionData") return "logic";
  if (m.role === "step" && m.kind === "logic") return "logic";
  return "pin";
}

// ---------- preparation (identical for both sides) ----------

const clone = (v) => JSON.parse(JSON.stringify(v));

export function unwrapAny(raw) {
  if (raw?.workflow?.workflow?.nodes) return { ...raw.workflow.workflow, name: raw.workflow.name ?? raw.workflow.workflow.name };
  if (raw?.workflow?.nodes) return raw.workflow;
  if (Array.isArray(raw?.nodes)) return raw;
  throw new Error("not an n8n workflow");
}

// -> {wf, triggerName, pinned: [names], pinData, pinSources, transforms, skip?}
export function prepare(raw, { pins, trigger, order, items } = {}) {
  const wf = clone(unwrapAny(raw));
  wf.name = String(wf.name ?? "workflow");
  const transforms = [];
  const pinned = new Set();
  wf.nodes = (wf.nodes ?? []).filter((n) => n && typeof n.name === "string" && typeof n.type === "string");
  for (const node of wf.nodes) {
    const c = classify(node);
    if (c?.skip) return { skip: c.skip, wf, transforms };
    if (c === "pin" && !node.disabled) pinned.add(node.name);
    if (node.credentials) {
      delete node.credentials;
      transforms.push(`credentials dropped: ${node.name}`);
    }
    if (node.type === BASE + "wait") {
      Object.assign(node, { type: BASE + "noOp", typeVersion: 1, parameters: {} });
      delete node.webhookId;
      transforms.push(`Wait -> NoOp: ${node.name}`);
    }
    if (node.type === BASE + "httpRequest" && typeof node.parameters?.url === "string" && /https:\/\//i.test(node.parameters.url)) {
      node.parameters.url = node.parameters.url.replace(/https:\/\//gi, "http://");
      transforms.push(`https -> http: ${node.name}`);
    }
  }
  let t;
  try {
    t = pickTrigger(wf);
  } catch (e) {
    return { skip: e.message, wf, transforms };
  }
  pinned.add(t.name);
  wf.settings = { ...(wf.settings ?? {}) };
  if (order) wf.settings.executionOrder = order;
  else if (!wf.settings.executionOrder) {
    wf.settings.executionOrder = "v1";
    transforms.push("executionOrder absent -> v1");
  }
  const made = makePins(wf, pinned, { items: items ?? 2, triggerName: t.name, scheduleItem: () => scheduleItem("2026-11-16T09:00:00Z") });
  const pinData = { ...made.pinData, ...(pins ?? {}) };
  if (trigger) pinData[t.name] = (Array.isArray(trigger) ? trigger : trigger.items ?? [trigger]).map((x) => (x && typeof x === "object" && x.json ? { json: x.json } : { json: x ?? {} }));
  delete wf.pinData;
  return { wf, triggerName: t.name, pinned: [...pinned], pinData, pinSources: made.sources, transforms };
}

// ---------- our side ----------

// Converts the prepared workflow; -> {def, issues} (issues: preflight errors).
export function convertOurs(wf, pinned) {
  const def = fromN8n(wf, { nodes: CATALOGUE });
  def.settings.executionOrder = wf.settings?.executionOrder ?? "v0";
  def.settings.timezone ??= "UTC"; // the bench's GENERIC_TIMEZONE
  const pf = preflight(def, { pinned });
  return { def, issues: pf.issues.filter((i) => i.level === "error") };
}

const ACCEPT = {
  json: "application/json,text/*;q=0.99",
  text: "application/json,text/html,application/xhtml+xml,application/xml,text/*;q=0.9, */*;q=0.1",
  other: "application/json,text/html,application/xhtml+xml,application/xml,text/*;q=0.9, image/*;q=0.8, */*;q=0.7",
};

// qs.stringify for flat values and lists (arrayFormat indices / brackets / repeat).
function encodeQuery(query, arrayFormat = "indices") {
  const parts = [];
  const enc = (x) => encodeURIComponent(x === null ? "" : typeof x === "object" ? JSON.stringify(x) : String(x));
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined) continue;
    if (!Array.isArray(v)) parts.push(`${encodeURIComponent(k)}=${enc(v)}`);
    else v.forEach((x, i) => x !== undefined && parts.push(`${encodeURIComponent(arrayFormat === "repeat" ? k : arrayFormat === "brackets" ? `${k}[]` : `${k}[${i}]`)}=${enc(x)}`));
  }
  return parts.join("&");
}

function multipart(fields) {
  const boundary = "----benchboundary";
  let s = "";
  for (const [k, v] of Object.entries(fields ?? {})) for (const x of Array.isArray(v) ? v : [v]) s += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${typeof x === "object" ? JSON.stringify(x) : String(x)}\r\n`;
  return { body: s + `--${boundary}--\r\n`, type: `multipart/form-data; boundary=${boundary}` };
}

// The reference `http` host: sends the runner's request to a mock at mockPort, the way the
// bench's n8n reaches its mock (http://mock:8080 directly, any other origin as a proxied
// absolute URL, https as a refused CONNECT).
export function makeHttpHost(mockPort) {
  return async (req) => {
    const u = new URL(req.url);
    const q = encodeQuery(req.query, req.queryArrayFormat);
    const search = u.search ? u.search + (q ? "&" + q : "") : q ? "?" + q : "";
    // axios drops headers whose value is undefined or null; n8n's requests close the connection.
    const headers = Object.fromEntries(Object.entries({ ...(req.headers ?? {}), connection: "close" }).filter(([, v]) => v !== undefined && v !== null));
    let body;
    if (req.body !== undefined) {
      const ct = req.contentType ?? "json";
      if (ct === "json") {
        body = JSON.stringify(req.body);
        headers["content-type"] ??= "application/json";
      } else if (ct === "form-urlencoded") {
        body = typeof req.body === "string" ? req.body : encodeQuery(req.body, req.formArrayFormat);
        headers["content-type"] ??= "application/x-www-form-urlencoded";
      } else if (ct === "multipart-form-data") {
        const m = multipart(req.body);
        body = m.body;
        headers["content-type"] = m.type;
      } else body = String(req.body);
    }
    if (u.protocol === "https:") {
      // n8n's proxy agent sends CONNECT to the mock, which logs it and answers 502; the
      // HTTP Request node then sees a 502 response.
      await new Promise((ok) => {
        const r = httpRequest({ host: "127.0.0.1", port: mockPort, method: "CONNECT", path: `${u.hostname}:${u.port || 443}` });
        r.on("connect", (res, socket) => (socket.destroy(), ok()));
        r.on("error", () => ok());
        r.on("response", () => ok());
        r.end();
      });
      return { status: 502, statusMessage: "Bad Gateway", headers: {}, body: "" };
    }
    if (body !== undefined) headers["content-length"] = Buffer.byteLength(body);
    const direct = u.host === "mock:8080";
    const path = direct ? u.pathname + search : `${u.protocol}//${u.host}${u.pathname}${search}`;
    return await new Promise((ok, fail) => {
      const r = httpRequest({ host: "127.0.0.1", port: mockPort, method: req.method, path, headers: { ...headers, host: u.host } }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => ok({ status: res.statusCode, statusMessage: res.statusMessage, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      });
      r.on("error", fail);
      if (body !== undefined) r.write(body);
      r.end();
    });
  };
}

async function runOurs(def, { triggerName, pinData, fixturesPath, logPath, clock, runId }) {
  writeFileSync(logPath, "");
  const server = await startMock({ port: 0, host: "127.0.0.1", log: logPath, fixtures: fixturesPath });
  try {
    const port = server.address().port;
    const res = await runnerRun(def, { trigger: { node: triggerName }, pinData, host: { http: makeHttpHost(port) }, clock: { startedAt: clock }, runId, mode: "manual", virtualTime: true });
    return res;
  } finally {
    await new Promise((ok) => server.close(ok));
  }
}

// ---------- comparison ----------

// ISO 8601 timestamps and HTTP dates ("Fri, 13 Nov 2026 21:36:21 GMT").
const ISO = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT/g;
const ISO_FULL = new RegExp(`^${ISO.source}$`);

function timeEqual(a, b, ctx) {
  if (typeof a === "number" && typeof b === "number") {
    // A duration computed from "now" on each side differs in the last digits.
    if (Number.isFinite(a) && Number.isFinite(b) && !Number.isInteger(a) && !Number.isInteger(b) && Math.abs(a - b) <= 1e-6 * Math.max(Math.abs(a), Math.abs(b))) return true;
    const ms = a > 1.5e12 && a < 2.5e12 && b > 1.5e12 && b < 2.5e12;
    const s = a > 1.5e9 && a < 2.5e9 && b > 1.5e9 && b < 2.5e9;
    if ((ms && Math.abs(a - b) <= ctx.tolerance) || (s && Math.abs(a - b) <= ctx.tolerance / 1000)) return true;
    return false;
  }
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (ISO_FULL.test(a) && ISO_FULL.test(b)) return Math.abs(Date.parse(a) - Date.parse(b)) <= ctx.tolerance;
  const ma = a.match(ISO) ?? [];
  const mb = b.match(ISO) ?? [];
  if (!ma.length || ma.length !== mb.length) return false;
  for (let i = 0; i < ma.length; i++) if (!(Math.abs(Date.parse(ma[i]) - Date.parse(mb[i])) <= ctx.tolerance)) return false;
  let k = 0;
  const ra = a.replace(ISO, () => `\u0000${k++}`);
  k = 0;
  const rb = b.replace(ISO, () => `\u0000${k++}`);
  return ra === rb;
}

// Deep compare with time tolerance; pushes {path, n8n, ours} into ctx.diffs.
function deepDiff(a, b, path, ctx, out) {
  if (a === b) return;
  if (Number.isNaN(a) && Number.isNaN(b)) return;
  if (timeEqual(a, b, ctx)) {
    ctx.timeTouched++;
    return;
  }
  const ta = Array.isArray(a) ? "array" : a === null ? "null" : typeof a;
  const tb = Array.isArray(b) ? "array" : b === null ? "null" : typeof b;
  if (ta !== tb || (ta !== "object" && ta !== "array")) {
    out.push({ path, n8n: a, ours: b });
    return;
  }
  if (ta === "array") {
    if (a.length !== b.length) out.push({ path: `${path}.length`, n8n: a.length, ours: b.length });
    for (let i = 0; i < Math.min(a.length, b.length); i++) deepDiff(a[i], b[i], `${path}[${i}]`, ctx, out);
    return;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  // An error object's stack is the server's own (n8n's paths): never comparable.
  if ("message" in a && "name" in a && "stack" in a && !("stack" in b)) {
    keys.delete("stack");
    ctx.stackSkipped = (ctx.stackSkipped ?? 0) + 1;
  }
  for (const k of [...keys].sort()) {
    if (!(k in a)) out.push({ path: `${path}.${k}`, n8n: "<absent>", ours: b[k] });
    else if (!(k in b)) out.push({ path: `${path}.${k}`, n8n: a[k], ours: "<absent>" });
    else deepDiff(a[k], b[k], `${path}.${k}`, ctx, out);
  }
}

// Two strings of one length that differ only in letters and digits, in several places:
// values from Math.random, crypto or uuid, which no runner reproduces.
function looksRandom(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || a.length < 6) return false;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (!/[0-9a-zA-Z]/.test(a[i]) || !/[0-9a-zA-Z]/.test(b[i])) return false;
    n++;
  }
  return n >= 3;
}

const normPaired = (p) => {
  if (p === undefined || p === null) return null;
  const list = (Array.isArray(p) ? p : [p]).map((x) => (typeof x === "number" ? { item: x } : { item: x?.item, input: x?.input ?? 0 }));
  return list.map((x) => `${x.item}${x.input ? "/" + x.input : ""}`).join(",");
};

function taskSummary(task) {
  const main = task?.data?.main ?? [];
  return {
    error: task?.error ? String(task.error.message ?? task.error) : null,
    branches: main.map((items) => (items ?? []).map((it) => ({ json: it.json, paired: normPaired(it.pairedItem), ...(it.binary ? { binary: Object.keys(it.binary) } : {}) }))),
  };
}

function executionOrder(runData) {
  const tasks = [];
  for (const [name, runs] of Object.entries(runData ?? {})) runs.forEach((t, i) => tasks.push({ name, i, ei: t.executionIndex ?? 0 }));
  return tasks.sort((x, y) => x.ei - y.ei).map((t) => t.name);
}

const VOLATILE_HEADERS = new Set(["user-agent", "content-length", "accept-encoding", "host", "connection", "proxy-connection", "transfer-encoding", "keep-alive"]);

function parseMultipart(text, ct) {
  const m = /boundary=([^;]+)/.exec(ct ?? "");
  if (!m || typeof text !== "string") return text;
  const fields = {};
  for (const part of text.split(`--${m[1]}`)) {
    const nm = /name="([^"]*)"/.exec(part);
    if (!nm) continue;
    const value = part.split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n$/, "");
    fields[nm[1]] = fields[nm[1]] === undefined ? value : [].concat(fields[nm[1]], value);
  }
  return fields;
}

export function normaliseEffect(e) {
  const headers = {};
  for (const [k, v] of Object.entries(e.headers ?? {})) if (!VOLATILE_HEADERS.has(k)) headers[k] = v;
  let body = e.body;
  if (/multipart\/form-data/.test(headers["content-type"] ?? "")) {
    body = parseMultipart(body, headers["content-type"]);
    headers["content-type"] = "multipart/form-data";
  }
  return { method: e.method, ...(e.proxied ? { origin: e.proxied } : {}), path: e.path, query: e.rawQuery ?? (e.method === "CONNECT" ? undefined : ""), headers, body };
}

function readLog(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// n8n result (runWorkflow) vs our result (run) -> report body.
export function compare(n8n, ours, n8nEffects, ourEffects, { tolerance = TIME_TOLERANCE_MS } = {}) {
  const ctx = { tolerance, timeTouched: 0 };
  const diffs = [];
  const add = (cls, detail) => diffs.push({ class: cls, ...detail });
  const nStatus = n8n.status === "success" ? "success" : "error";
  const oStatus = ours.status === "done" ? "success" : "error";
  if (nStatus !== oStatus) add("status", { n8n: `${n8n.status}${n8n.error ? ": " + n8n.error.message : ""}`, ours: `${ours.status}${ours.error ? ": " + ours.error.message : ""}` });
  else if (nStatus === "error" && (n8n.error?.node ?? n8n.lastNode ?? null) !== (ours.error?.node ?? ours.lastNodeExecuted ?? null)) add("status", { what: "failing node", n8n: n8n.error?.node ?? n8n.lastNode, ours: ours.error?.node ?? ours.lastNodeExecuted });
  const nRun = n8n.executionData?.runData ?? {};
  const oRun = ours.runData ?? {};
  const names = [...new Set([...Object.keys(nRun), ...Object.keys(oRun)])];
  const nodes = {};
  for (const name of names) {
    const a = nRun[name] ?? [];
    const b = oRun[name] ?? [];
    nodes[name] = { runs: [a.length, b.length] };
    if (a.length !== b.length) add("runs", { node: name, n8n: a.length, ours: b.length });
    for (let r = 0; r < Math.min(a.length, b.length); r++) {
      const sa = taskSummary(a[r]);
      const sb = taskSummary(b[r]);
      if (!!sa.error !== !!sb.error) add("node-error", { node: name, run: r, n8n: sa.error, ours: sb.error });
      else if (sa.error && sa.error !== sb.error) add("error-message", { node: name, run: r, n8n: sa.error, ours: sb.error });
      const ba = sa.branches;
      const bb = sb.branches;
      const trimmed = (x) => {
        const y = [...x];
        while (y.length && !y[y.length - 1].length) y.pop();
        return y;
      };
      if (ba.length !== bb.length && trimmed(ba).length !== trimmed(bb).length) add("branches", { node: name, run: r, n8n: ba.map((x) => x.length), ours: bb.map((x) => x.length) });
      else if (ba.length !== bb.length) add("branch-padding", { node: name, run: r, n8n: ba.map((x) => x.length), ours: bb.map((x) => x.length) });
      for (let o = 0; o < Math.max(ba.length, bb.length); o++) {
        const ia = ba[o] ?? [];
        const ib = bb[o] ?? [];
        const jd = [];
        deepDiff(ia.map((x) => x.json), ib.map((x) => x.json), `out${o}`, ctx, jd);
        if (jd.length && jd.every((d) => looksRandom(d.n8n, d.ours))) add("random", { node: name, run: r, output: o, diffs: jd.slice(0, 4) });
        else if (jd.length) add("items", { node: name, run: r, output: o, count: [ia.length, ib.length], diffs: jd.slice(0, 8), more: Math.max(0, jd.length - 8) });
        const pa = ia.map((x) => x.paired);
        const pb = ib.map((x) => x.paired);
        if (ia.length === ib.length && JSON.stringify(pa) !== JSON.stringify(pb)) add("pairedItem", { node: name, run: r, output: o, n8n: pa, ours: pb });
        const xa = ia.map((x) => x.binary ?? null);
        const xb = ib.map((x) => x.binary ?? null);
        if (ia.length === ib.length && JSON.stringify(xa) !== JSON.stringify(xb)) add("binary", { node: name, run: r, output: o, n8n: xa, ours: xb });
      }
    }
  }
  const orderA = executionOrder(nRun);
  const orderB = executionOrder(oRun);
  if (JSON.stringify(orderA) !== JSON.stringify(orderB)) add("order", { n8n: orderA, ours: orderB });
  const ea = n8nEffects.map(normaliseEffect);
  const eb = ourEffects.map(normaliseEffect);
  const hd = [];
  deepDiff(ea, eb, "http", ctx, hd);
  if (hd.length) {
    // n8n's HTTP Request sends a node's requests concurrently, so their order on the wire
    // is not defined. Same requests in another order: "http-order".
    const sorted = (l) => [...l].sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1));
    const sd = [];
    deepDiff(sorted(ea), sorted(eb), "http", { ...ctx, timeTouched: 0 }, sd);
    if (!sd.length) add("http-order", { n8n: ea.map((e) => `${e.method} ${e.origin ?? ""}${e.path}`), ours: eb.map((e) => `${e.method} ${e.origin ?? ""}${e.path}`) });
    else if (hd.every((d) => looksRandom(d.n8n, d.ours))) add("random", { what: "http", diffs: hd.slice(0, 4) });
    else add("http", { count: [ea.length, eb.length], diffs: hd.slice(0, 10), more: Math.max(0, hd.length - 10) });
  }
  const classes = [...new Set(diffs.map((d) => d.class))].sort();
  return { verdict: classes.length ? `diff:${classes.join(",")}` : "same", classes, timeNormalised: ctx.timeTouched, status: { n8n: n8n.status, ours: ours.status, n8nError: n8n.error ?? null, oursError: ours.error ?? null }, order: { n8n: orderA, ours: orderB }, nodes, http: { n8n: ea, ours: eb }, diffs };
}

// ---------- our side of one run ----------

// Runs the converted definition with n8n's run identity (workflow id and name, execution
// id, start time), so $workflow, $execution and $now line up with the n8n run.
export async function oursSide(def, { prep, fixturesPath, logPath, n8n }) {
  // Containment stays on: our side may reach the hosts n8n reached (and literal ones).
  for (const e of n8n.effects) {
    const host = e.proxied ? new URL(e.proxied).hostname : e.method === "CONNECT" ? String(e.path).split(":")[0] : "mock";
    if (!def.allow.http.some((a) => a.method === "*" && a.host === host)) def.allow.http.push({ method: "*", host, pathPrefix: "/" });
  }
  def.name = `bench: ${prep.wf.name}`;
  def.id = String(n8n.workflowId);
  let ours;
  try {
    ours = await runOurs(def, { triggerName: prep.triggerName, pinData: prep.pinData, fixturesPath, logPath, clock: n8n.startedAt, runId: String(n8n.executionId) });
  } catch (e) {
    ours = { status: "crashed", error: { name: e.name, message: e.message, stack: e.stack?.split("\n").slice(0, 4).join(" | ") }, runData: {} };
  }
  return { ours, ourEffects: readLog(logPath) };
}

// ---------- observed fixtures (regression tests) ----------

export const OBSERVED = "observed from n8n 2.47.7 on 2026-11-14 (evals/diff/differential.mjs --save-fixture)";

// Keeps what compare() reads from an n8n run (server stacks in error items left out).
const dropStacks = (v) => (v === null || typeof v !== "object" ? v : Array.isArray(v) ? v.map(dropStacks) : Object.fromEntries(Object.entries(v).filter(([k]) => !(k === "stack" && "message" in v && "name" in v)).map(([k, x]) => [k, dropStacks(x)])));
export function trimRunData(runData) {
  const out = {};
  for (const [name, runs] of Object.entries(runData ?? {})) {
    out[name] = runs.map((t) => ({ executionIndex: t.executionIndex, executionStatus: t.executionStatus, ...(t.error ? { error: { message: t.error.message } } : {}), ...(t.data ? { data: dropStacks(t.data) } : {}) }));
  }
  return out;
}

export function saveObserved(path, { label, prep, fixtures, n8n }) {
  const fixture = {
    note: OBSERVED,
    label,
    workflow: prep.wf,
    triggerName: prep.triggerName,
    pinned: prep.pinned,
    pinData: prep.pinData,
    fixtures,
    n8n: { status: n8n.status, error: n8n.error ?? null, lastNode: n8n.lastNode, startedAt: n8n.startedAt, executionId: n8n.executionId, workflowId: n8n.workflow.id, executionData: { runData: trimRunData(n8n.executionData?.runData) }, effects: n8n.effects.map(({ seq, t, ...e }) => e) },
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(fixture, null, 1) + "\n");
}

// Reruns our side against a stored n8n observation; -> the compare() report.
export async function replayObserved(fixture, { workDir } = {}) {
  const dir = workDir ?? join(DIFF_WORK, "replay", slug(fixture.label ?? "fixture"));
  mkdirSync(dir, { recursive: true });
  const prep = { wf: fixture.workflow, triggerName: fixture.triggerName, pinned: fixture.pinned, pinData: fixture.pinData };
  const { def, issues } = convertOurs(prep.wf, prep.pinned);
  if (issues.length) return { verdict: "skip:preflight", issues };
  const fixturesPath = join(dir, "fixtures.json");
  writeFileSync(fixturesPath, JSON.stringify(fixture.fixtures ?? {}, null, 2) + "\n");
  const n8n = fixture.n8n;
  const { ours, ourEffects } = await oursSide(def, { prep, fixturesPath, logPath: join(dir, "ours-effects.jsonl"), n8n });
  return { ...compare(n8n, ours, n8n.effects, ourEffects), ours };
}

// ---------- one workflow ----------

// Execution data decoded from flatted can hold cycles (a node output with parent/child
// links); comparison and logs need trees.
export function decycle(v, stack = []) {
  if (v === null || typeof v !== "object") return v;
  if (stack.includes(v)) return "[Circular]";
  stack.push(v);
  const out = Array.isArray(v) ? v.map((x) => decycle(x, stack)) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decycle(x, stack)]));
  stack.pop();
  return out;
}

export const slug = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);

// raw: workflow JSON (any wrapping). opts: {label, pins, trigger, fixtures, order, outDir, items}
export async function differential(raw, opts = {}) {
  const label = opts.label ?? "workflow";
  const outDir = opts.outDir ?? join(DIFF_WORK, slug(label));
  mkdirSync(outDir, { recursive: true });
  const prep = prepare(raw, opts);
  const base = { label, transforms: prep.transforms };
  const finish = (rep) => {
    writeFileSync(join(outDir, "report.json"), JSON.stringify(rep, null, 2) + "\n");
    return rep;
  };
  if (prep.skip) return finish({ ...base, verdict: `skip:${prep.skip}`, qualified: false, reason: prep.skip });
  const { def, issues } = convertOurs(prep.wf, prep.pinned);
  if (issues.length) {
    const reason = issues.map((i) => i.message).join("; ");
    return finish({ ...base, verdict: `skip:preflight`, qualified: false, reason, issues });
  }
  const fixtures = opts.fixtures ?? DEFAULT_FIXTURES;
  const fixturesPath = join(outDir, "fixtures.json");
  writeFileSync(fixturesPath, JSON.stringify(fixtures, null, 2) + "\n");
  const n8nPins = Object.fromEntries(Object.entries(prep.pinData).filter(([k]) => k !== prep.triggerName));
  let n8n;
  try {
    n8n = await runWorkflow({ ...prep.wf, pinData: n8nPins }, { trigger: { items: prep.pinData[prep.triggerName] }, mock: fixtures, keepPin: true, timeoutS: opts.timeoutS ?? 60, triggerNode: prep.triggerName });
  } catch (e) {
    return finish({ ...base, verdict: "skip:n8n-refused", qualified: false, reason: String(e.message).slice(0, 600) });
  }
  n8n.executionData = decycle(n8n.executionData);
  // n8n checks every node's parameters before a manual run and refuses the whole run.
  if (n8n.status !== "success" && !Object.keys(n8n.executionData?.runData ?? {}).length) return finish({ ...base, verdict: "skip:n8n-refused", qualified: false, reason: String(n8n.error?.message ?? "n8n ran no node").slice(0, 600) });
  writeFileSync(join(outDir, "n8n-effects.jsonl"), n8n.effects.map((e) => JSON.stringify(e)).join("\n") + (n8n.effects.length ? "\n" : ""));
  writeFileSync(join(outDir, "n8n-run.json"), JSON.stringify({ status: n8n.status, error: n8n.error, startedAt: n8n.startedAt, runData: n8n.executionData?.runData }, null, 1) + "\n");
  const { ours, ourEffects } = await oursSide(def, { prep, fixturesPath, logPath: join(outDir, "ours-effects.jsonl"), n8n: { startedAt: n8n.startedAt, executionId: n8n.executionId, workflowId: n8n.workflow.id, effects: n8n.effects } });
  writeFileSync(join(outDir, "ours-run.json"), JSON.stringify({ status: ours.status, error: ours.error, runData: ours.runData }, null, 1) + "\n");
  if (opts.saveFixture) saveObserved(opts.saveFixture, { label, prep, fixtures, n8n });
  const cmp = compare(n8n, ours, n8n.effects, ourEffects);
  // A step the runner accepts at preflight but cannot run with these parameters is a
  // coverage gap, not a divergence: reported as "unsupported" with the runner's message.
  const unsupported = ours.status === "failed" && /is not supported by the runtime/.test(ours.error?.message ?? "") ? ours.error.message : null;
  if (unsupported) return finish({ ...base, qualified: true, triggerName: prep.triggerName, pinned: prep.pinned, ...cmp, verdict: "unsupported", reason: unsupported, classes: ["unsupported"] });
  if (ours.status === "crashed") {
    cmp.classes = [...new Set([...cmp.classes, "crash"])].sort();
    cmp.verdict = `diff:${cmp.classes.join(",")}`;
  }
  return finish({ ...base, qualified: true, triggerName: prep.triggerName, executionOrder: prep.wf.settings.executionOrder, pinned: prep.pinned, pinSources: prep.pinSources, n8nMs: n8n.executionMs, ...cmp });
}

// ---------- CLI ----------

async function main() {
  const args = process.argv.slice(2);
  const vals = { "--trigger": "trigger", "--pins": "pins", "--fixtures": "fixtures", "--order": "order", "--out": "outDir", "--label": "label", "--save-fixture": "saveFixture" };
  const o = {};
  let file;
  for (let i = 0; i < args.length; i++) {
    if (args[i] in vals) o[vals[args[i]]] = args[++i];
    else if (args[i] === "--quiet") o.quiet = true;
    else if (args[i].startsWith("--")) {
      console.error(`unknown flag ${args[i]}`);
      process.exit(2);
    } else file = args[i];
  }
  if (!file) {
    console.error("usage: differential.mjs <workflow.json> [--trigger t.json] [--pins pins.json] [--fixtures f.json] [--order v0|v1] [--out dir]");
    process.exit(2);
  }
  const read = (p) => JSON.parse(readFileSync(p, "utf8"));
  const pins = o.pins ? read(o.pins) : undefined;
  const rep = await differential(read(file), { label: o.label ?? basename(file, ".json"), trigger: o.trigger ? read(o.trigger) : undefined, pins: pins?.pinData ?? pins, fixtures: o.fixtures ? read(o.fixtures) : undefined, order: o.order, outDir: o.outDir, saveFixture: o.saveFixture });
  if (!o.quiet) process.stdout.write(JSON.stringify(rep, null, 2) + "\n");
  console.error(`${rep.label}: ${rep.verdict}${rep.reason ? ` (${rep.reason.slice(0, 200)})` : ""}`);
  process.exit(rep.verdict === "same" || rep.verdict.startsWith("skip") ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
