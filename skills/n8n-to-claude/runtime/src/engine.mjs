// Execution engine: runs a definition with n8n's semantics (execution order "v1").
//
// Mirrors n8n-core's WorkflowExecute (n8n 2.47):
// - A stack of node executions starts at the trigger. After a node runs, every output
//   with items schedules its children; children are ordered by canvas position (top to
//   bottom, then left to right) and pushed to the front, so a branch runs depth-first
//   before the next one. Empty outputs schedule nothing: the branch stops.
// - A node with several connected inputs waits until every input got data. When the
//   stack runs dry, a waiting node whose parents are all done runs with the inputs it
//   has (missing ones empty), unless its required inputs (Merge chooseBranch: all) are
//   missing.
// - Input items get `pairedItem: {item: i, input}` before a node runs; output items
//   without pairedItem are paired 1:1 when the counts allow (assignPairedItems).
// - retryOnFail (maxTries 2..5, waitBetweenTries 0..5000 ms), alwaysOutputData,
//   executeOnce (first item of each input), disabled (passes input 0 through),
//   onError continueRegularOutput / continueErrorOutput (items carrying an error move to
//   an extra last output, merged with their input item) / stopWorkflow.
// - A node that throws while continuing on error passes its input through (n8n does).
//
// - pinData (opts.pinData, {name: items}) works like n8n's pinData in manual runs: a pinned
//   enabled step that is reached emits its pinned items instead of running (no retry, no
//   error routing); paired items are assigned as for any output, on the same item objects,
//   so a later run of that step keeps the pairing of the first (n8n reuses the array).
//
// Host requests (tool, http, model, agent, sleep) go through `dispatch`: containment is
// checked first, each request gets a deterministic id, results come from the result log
// (replay) or from the host. In step mode a missing result suspends the run; resuming
// replays from the start with the same clock and seed, which reproduces the same state.

import { RunnerError, ContainmentViolation, NodeError, BadInput, errorJson, deepCopy, seededRandom, seedFrom, sleepMs, hasOwn, stableStringify } from "./util.mjs";
import { hashHex } from "./hash.mjs";
import { resolveParameter } from "./expression.mjs";
import { createScope, enterRun } from "./proxy.mjs";
import { nodeImplFor } from "./nodes.mjs";
import { normalizePath } from "./files.mjs";

export class Suspend extends Error {
  constructor(requests) {
    super("needs host results");
    this.name = "Suspend";
    this.requests = requests;
  }
}

export const DEFAULT_TIMEZONE = "America/New_York"; // n8n's GENERIC_TIMEZONE default
export const SLEEP_THRESHOLD_MS = 65000; // n8n's Wait node sleeps in-process below 65 s

// ---------- graph ----------

export class Graph {
  constructor(definition) {
    this.steps = definition.steps;
    this.bySource = {};
    this.byDest = {};
    for (const e of definition.edges || []) {
      const s = (this.bySource[e.from] ??= { main: [] });
      while (s.main.length <= e.fromOutput) s.main.push([]);
      s.main[e.fromOutput].push({ node: e.to, index: e.toInput });
      const d = (this.byDest[e.to] ??= { main: [] });
      while (d.main.length <= e.toInput) d.main.push([]);
      d.main[e.toInput].push({ node: e.from, index: e.fromOutput });
    }
    this.subnodesOf = {};
    for (const s of definition.subnodes || []) (this.subnodesOf[s.to] ??= []).push(s);
    this._anc = new Map();
  }
  inputCount(name) {
    return this.byDest[name]?.main?.length ?? 0;
  }
  // Main-connection ancestors (n8n getParentNodes(name)).
  ancestors(name) {
    let set = this._anc.get(name);
    if (set) return set;
    set = new Set();
    const queue = [name];
    while (queue.length) {
      const n = queue.shift();
      for (const conns of this.byDest[n]?.main ?? []) for (const c of conns) if (!set.has(c.node)) { set.add(c.node); queue.push(c.node); }
    }
    this._anc.set(name, set);
    return set;
  }
  // n8n Workflow.getNodeConnectionIndexes: BFS up from nodeName to parentName.
  connectionIndexes(nodeName, parentName) {
    if (!hasOwn(this.steps, parentName)) return undefined;
    const visited = new Set();
    const queue = [nodeName];
    while (queue.length) {
      const cur = queue.shift();
      if (visited.has(cur)) continue;
      visited.add(cur);
      const conns = this.byDest[cur]?.main;
      if (!conns) continue;
      for (const byIndex of conns) {
        for (let di = 0; di < byIndex.length; di++) {
          const c = byIndex[di];
          if (c.node === parentName) return { sourceIndex: c.index, destinationIndex: di };
          if (!visited.has(c.node)) queue.push(c.node);
        }
      }
    }
    return undefined;
  }
}

// ---------- run state ----------

export function createRun(definition, opts = {}) {
  const startedAt = opts.clock?.startedAt != null ? Date.parse(opts.clock.startedAt) || Number(opts.clock.startedAt) : Date.now();
  if (!Number.isFinite(startedAt)) throw new BadInput("clock.startedAt is not a valid time");
  const runId = opts.runId || `run-${startedAt.toString(36)}`;
  const run = {
    definition,
    graph: new Graph(definition),
    runId,
    mode: opts.mode || "trigger",
    timezone: definition.settings?.timezone || DEFAULT_TIMEZONE,
    clock: { startedAt, now: startedAt },
    vars: Object.freeze({ ...(definition.vars || {}) }),
    workflow: { id: definition.id ?? definition.source?.workflowId ?? "migrated", name: definition.name, active: opts.mode !== "manual" },
    executionInfo: null,
    runData: {},
    effects: [],
    effectIds: new Set(),
    resultLog: opts.resultLog ? { ...opts.resultLog } : {},
    host: opts.host,
    stepMode: !!opts.stepMode,
    batchSize: opts.batchSize ?? 10,
    virtualTime: opts.virtualTime ?? false,
    sleepThresholdMs: opts.sleepThresholdMs ?? SLEEP_THRESHOLD_MS,
    executionIndex: 0,
    logs: [],
    response: undefined,
    nodeContext: {},
    pinData: normalizePinData(opts.pinData),
    cursorsIn: opts.cursors ?? null, // poll cursors by trigger step name (adapt.mjs)
    cursorsOut: {},
    lastNodeExecuted: undefined,
    idPrefix: "",
    depth: 0,
  };
  run.executionInfo = { id: runId, mode: run.mode === "manual" ? "test" : "production", resumeUrl: undefined, customData: customData() };
  run.randomFor = (key) => seededRandom(seedFrom(`${runId}|${key}`));
  run.console = makeConsole(run);
  return run;
}

export function normalizePinData(pinData) {
  if (!pinData || typeof pinData !== "object") return null;
  const out = {};
  for (const [name, items] of Object.entries(pinData)) {
    if (!Array.isArray(items)) throw new BadInput(`pinData for "${name}" must be a list of items`);
    out[name] = items.map((it) =>
      it && typeof it === "object" && !Array.isArray(it) && it.json && typeof it.json === "object" && Object.keys(it).every((k) => ["json", "binary", "pairedItem"].includes(k)) ? deepCopy(it) : { json: it && typeof it === "object" && !Array.isArray(it) ? deepCopy(it) : { value: it } },
    );
  }
  return out;
}

// n8n WorkflowExecute.getPinnedOutput.
function pinnedOutput(run, step, name) {
  if (!run.pinData || step.settings?.disabled === true || !hasOwn(run.pinData, name)) return undefined;
  return [run.pinData[name]];
}

function customData() {
  const data = {};
  return {
    set: (k, v) => void (data[k] = String(v)),
    setAll: (o) => void Object.entries(o || {}).forEach(([k, v]) => (data[k] = String(v))),
    get: (k) => data[k],
    getAll: () => ({ ...data }),
  };
}

function makeConsole(run) {
  const log = (level) => (...args) => {
    if (run.logs.length < 1000) run.logs.push({ level, args: args.map((a) => (typeof a === "string" ? a : safeJson(a))) });
  };
  return { log: log("log"), info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") };
}
const safeJson = (v) => {
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return String(v);
  }
};

// ---------- containment and requests ----------

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function hostOf(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname.toLowerCase(), path: u.pathname || "/" };
  } catch {
    return null;
  }
}

export function checkContainment(definition, req) {
  const allow = definition.allow || {};
  if (req.kind === "tool") {
    const ok = (allow.tools || []).some((t) => t.connector === req.connector && t.tool === req.tool);
    if (!ok) throw new ContainmentViolation(`tool ${req.connector}.${req.tool} is not in the definition's allowlist`, { requestId: req.id });
  } else if (req.kind === "http") {
    const t = hostOf(req.url);
    if (!t || !/^https?:$/.test(new URL(req.url).protocol)) throw new ContainmentViolation(`http request to "${req.url}" is not an http(s) URL`, { requestId: req.id });
    const method = String(req.method || "GET").toUpperCase();
    const ok = (allow.http || []).some((a) => (a.method === "*" || String(a.method).toUpperCase() === method) && String(a.host).toLowerCase() === t.host && t.path.startsWith(a.pathPrefix || "/"));
    if (!ok) throw new ContainmentViolation(`http ${method} ${t.host}${t.path} is not in the definition's allowlist`, { requestId: req.id });
    if (req.auth?.secret) {
      const secret = (definition.secrets || []).find((s) => s.name === req.auth.secret);
      if (!secret) throw new ContainmentViolation(`secret "${req.auth.secret}" is not declared in the definition`, { requestId: req.id });
      // Fail closed: a secret with no hosts is sent nowhere.
      if (!secret.hosts?.length || !secret.hosts.map((h) => String(h).toLowerCase()).includes(t.host)) {
        throw new ContainmentViolation(`secret "${req.auth.secret}" may not be sent to ${t.host}`, { requestId: req.id });
      }
    }
  } else if (req.kind === "file") {
    // Local disk (files.mjs): the path must lie in a directory the definition names for this
    // operation (allow.files: {op, dir}); ".." never climbs out of it.
    const p = normalizePath(req.path);
    const op = req.op === "write" ? "write" : "read";
    const ok = p && (allow.files || []).some((a) => a.op === op && a.dir !== "*" && pathWithin(p, a.dir));
    if (!ok) throw new ContainmentViolation(`file ${op} of "${req.path}" is not in the definition's allowlist`, { requestId: req.id });
  } else if (req.kind === "agent") {
    for (const tool of req.tools || []) {
      if (tool.connector) checkContainment(definition, { kind: "tool", connector: tool.connector, tool: tool.tool, id: req.id });
      else if (tool.kind === "http" && tool.url) {
        const t = hostOf(tool.url);
        if (!t || !(allow.http || []).some((a) => String(a.host).toLowerCase() === t.host)) throw new ContainmentViolation(`agent tool ${tool.name} targets ${tool.url}, which is not allowed`, { requestId: req.id });
      }
    }
  }
}

// A normalized path within an allowed directory (or the allowed file itself).
export function pathWithin(p, dir) {
  const d = normalizePath(dir);
  if (!d) return false;
  if (p === d) return true;
  return p.startsWith(d.endsWith("/") ? d : `${d}/`);
}

export function requestEffect(req) {
  if (req.kind === "file") return req.op === "write" ? "write" : "read";
  if (req.kind === "http") return WRITE_METHODS.has(String(req.method || "GET").toUpperCase()) ? "write" : "read";
  if (req.kind === "tool") return req.effect === "read" ? "read" : "write";
  // An agent turn has no effect of its own: each tool call it asks for is a separate tool or
  // http request with its own effect entry (nodes2.mjs, executeAgentTool).
  if (req.kind === "agent") return "none";
  return "none";
}

async function callHost(run, req) {
  const fn = run.host?.[req.kind];
  if (req.kind === "sleep" && !fn) {
    if (!run.virtualTime) await sleepMs(Math.max(0, Date.parse(req.until) - run.clock.now));
    return { ok: true, value: { resumedAt: req.until } };
  }
  if (typeof fn !== "function") return { ok: false, error: { name: "NoHost", message: `no host handler for "${req.kind}" requests` } };
  try {
    const { id, kind, effectKey, ...payload } = req;
    const value = await fn(payload, { id, effectKey, runId: run.runId });
    return { ok: true, value: value === undefined ? null : deepCopy(value) };
  } catch (e) {
    return { ok: false, error: errorJson(e) };
  }
}

// Hands requests to the host (or the result log). Returns results aligned with reqs.
export async function dispatch(run, reqs) {
  for (const r of reqs) checkContainment(run.definition, r);
  for (const r of reqs) {
    const effect = requestEffect(r);
    if (effect === "write") r.effectKey = hashHex("sha256", `${run.runId}|${r.id}`).slice(0, 32);
    if (!run.effectIds.has(r.id)) {
      run.effectIds.add(r.id);
      run.effects.push({ seq: run.effects.length, id: r.id, kind: r.kind, effect, ...(r.effectKey ? { effectKey: r.effectKey } : {}), request: summarize(r) });
    }
  }
  const missing = reqs.filter((r) => !hasOwn(run.resultLog, r.id));
  if (missing.length) {
    if (run.stepMode) throw new Suspend(missing.slice(0, run.batchSize).map((r) => deepCopy(r)));
    for (const r of missing) run.resultLog[r.id] = await callHost(run, r);
  }
  // A copy: a step may change what it was handed (the Sheets programs add header columns to
  // the rows they read), and the log is what a resumed run replays, so it must stay as the
  // host answered.
  return reqs.map((r) => deepCopy(run.resultLog[r.id]));
}

function summarize(r) {
  const { id, effectKey, ...rest } = r;
  return deepCopy(rest);
}

// ---------- node execution context ----------

export class NodeExecution {
  constructor(run, name, runIndex, inputData, source, tryIndex) {
    this.run = run;
    this.name = name;
    this.step = run.definition.steps[name];
    this.runIndex = runIndex;
    this.inputData = inputData; // {main: [[items]|null, ...]}
    this.source = source; // {main: [{previousNode, previousNodeOutput, previousNodeRun}|null]} | null
    this.tryIndex = tryIndex;
    this.impl = nodeImplFor(this.step);
    this.params = { ...(this.impl?.defaults?.(this.step.n8n?.typeVersion ?? 1, this.step.params || {}) ?? {}), ...(this.step.params || {}) };
    this.connectionInputData = connectionInput(inputData);
    this._scopes = new Map();
    this._seq = new Map();
    this.hints = [];
  }
  get typeVersion() {
    return this.step.n8n?.typeVersion ?? 1;
  }
  getInputData(inputIndex = 0) {
    return this.inputData.main?.[inputIndex] ?? [];
  }
  scope(itemIndex = 0, extras) {
    if (extras) return createScope(this, itemIndex, extras);
    let s = this._scopes.get(itemIndex);
    if (!s) {
      s = createScope(this, itemIndex);
      this._scopes.set(itemIndex, s);
    }
    return s;
  }
  // n8n getNodeParameter(path, itemIndex, fallback, {rawExpressions}).
  param(path, itemIndex = 0, fallback, opts = {}) {
    const keys = String(path).split(".");
    let v = this.params;
    for (const k of keys) {
      if (v == null) { v = undefined; break; }
      const m = /^(\w+)\[(\d+)\]$/.exec(k);
      v = m ? v[m[1]]?.[Number(m[2])] : v[k];
    }
    if (v === undefined) v = fallback;
    if (v === undefined) throw new NodeError(`Could not get parameter "${path}"`, { node: this.name });
    if (opts.rawExpressions) return v;
    return resolveParameter(v, () => this.scope(itemIndex));
  }
  evaluate(expression, itemIndex = 0) {
    return resolveParameter(expression, () => this.scope(itemIndex));
  }
  continueOnFail() {
    const s = this.step.settings || {};
    return s.continueOnFail === true || s.onError === "continueRegularOutput" || s.onError === "continueErrorOutput";
  }
  requestId(itemIndex) {
    const seq = this._seq.get(itemIndex) ?? 0;
    this._seq.set(itemIndex, seq + 1);
    return `${this.run.idPrefix}${this.name}#${this.runIndex}#${itemIndex}${seq ? "." + seq : ""}${this.tryIndex ? "@" + this.tryIndex : ""}`;
  }
  // reqs: [{kind, itemIndex, ...payload}] -> results [{ok, value} | {ok: false, error}]
  async request(reqs) {
    const full = reqs.map(({ itemIndex, ...rest }) => ({ id: this.requestId(itemIndex ?? 0), ...rest, step: this.name }));
    return dispatch(this.run, full);
  }
  async sleepUntil(untilMs, itemIndex = 0) {
    const run = this.run;
    const ms = untilMs - run.clock.now;
    if (ms <= 0) return;
    if (ms < run.sleepThresholdMs) {
      if (!run.virtualTime) await (run.host?.wait ? run.host.wait(ms) : sleepMs(ms));
    } else {
      const [r] = await this.request([{ kind: "sleep", itemIndex, until: new Date(untilMs).toISOString() }]);
      if (!r.ok) throw new NodeError(r.error?.message || "sleep failed", { node: this.name });
    }
    run.clock.now = Math.max(run.clock.now, untilMs);
  }
}

// n8n prepareConnectionInputData (v1): the first input that has items.
function connectionInput(inputData) {
  const main = inputData.main || [];
  if (!main.length) return [];
  for (const d of main) if (d?.length) return d;
  return main[0] || [];
}

// ---------- the loop ----------

function addPairedItemLineage(data) {
  return {
    main: (data.main || []).map((input, inputIndex) =>
      input === null ? null : input.map((item, i) => ({ ...item, pairedItem: inputIndex ? { item: i, input: inputIndex } : { item: i } })),
    ),
  };
}

function assignPairedItems(out, inputData) {
  if (!out?.length) return out ?? null;
  out = Array.from(out, (o) => o ?? []);
  const main = inputData.main || [];
  const singleInOut = main.length === 1 && main[0]?.length === 1;
  const sameCount = out.length === 1 && main.length === 1 && main[0]?.length === out[0].length;
  const singleOut = out.length === 1 && out[0]?.length === 1 && main.length === 1 && (main[0]?.length ?? 0) > 1;
  outer: for (const o of out) {
    for (const [i, item] of o.entries()) {
      if (item.pairedItem === undefined) {
        if (singleInOut) item.pairedItem = { item: 0 };
        else if (sameCount) item.pairedItem = { item: i };
        else if (singleOut) item.pairedItem = { item: 0 };
        else break outer;
      }
    }
  }
  return out;
}

function ensureAlwaysOutputData(out, step, inputData) {
  if (out?.[0]?.[0]) return out;
  if (step.settings?.alwaysOutputData !== true) return out;
  const pairedItem = [];
  (inputData.main || []).forEach((input, inputIndex) => input?.forEach((_, i) => pairedItem.push({ item: i, input: inputIndex })));
  out ??= [];
  out[0] = [{ json: {}, pairedItem }];
  return out;
}

function isErrorItem(item) {
  if (item.error) return item.error;
  if (item.json?.error && Object.keys(item.json).every((k) => ["error", "message", "details"].includes(k))) return item.json.error;
  return undefined;
}

// n8n handleNodeErrorOutput: error items go to the extra last output.
function routeErrorOutput(exec, out, mainOutputs) {
  const errorItems = [];
  for (let oi = 0; oi < mainOutputs; oi++) {
    const keep = [];
    for (const item of out[oi] ?? []) {
      if (!isErrorItem(item)) {
        keep.push(item);
        continue;
      }
      const p = Array.isArray(item.pairedItem) ? item.pairedItem[0] : item.pairedItem;
      let inputItem;
      if (exec.source && p && typeof p === "object") {
        const src = exec.source.main[p.input || 0];
        const prev = src && exec.run.runData[src.previousNode]?.[src.previousNodeRun || 0]?.data?.main?.[src.previousNodeOutput || 0];
        inputItem = prev?.[p.item];
      }
      errorItems.push(inputItem ? { ...item, json: { ...inputItem.json, ...item.json } } : item);
    }
    out[oi] = keep;
  }
  out[mainOutputs] = errorItems;
  return out;
}

function normalizeNodeErrors(out) {
  for (const o of out ?? []) for (const item of o ?? []) if (item.error !== undefined) item.json = { error: item.error.message ?? String(item.error) };
}

function retryParams(step) {
  const s = step.settings || {};
  if (s.retryOnFail !== true) return [1, 0];
  return [Math.min(5, Math.max(2, s.maxTries || 3)), Math.min(5000, Math.max(0, s.waitBetweenTries ?? 1000))];
}

function outputsOf(exec) {
  return exec.impl?.outputs?.(exec) ?? 1;
}

function childOrder(graph, a, b) {
  // n8n sorts children by position: higher y first, then higher x first, and unshifts
  // each, so the top-left child ends up first on the stack.
  const pa = graph.steps[a.connection.node]?.n8n?.position || [0, 0];
  const pb = graph.steps[b.connection.node]?.n8n?.position || [0, 0];
  if (pa[1] < pb[1]) return 1;
  if (pa[1] > pb[1]) return -1;
  if (pa[0] > pb[0]) return -1;
  return 0;
}

export async function runEngine(run, startName, triggerItems, provided = false) {
  enterRun(run);
  const { graph } = run;
  const stack = [{ node: startName, data: { main: [triggerItems] }, source: null, isStart: true, triggerProvided: provided }];
  const waiting = {};
  const waitingSource = {};

  const enqueue = (connection, outputIndex, parent, out, runIndex) => {
    const target = connection.node;
    const inputs = graph.inputCount(target);
    if (inputs > 1) {
      waiting[target] ??= {};
      waitingSource[target] ??= {};
      let wi;
      let create = true;
      for (const k of Object.keys(waiting[target])) {
        if (!waiting[target][k].main[connection.index]) {
          wi = Number(k);
          create = false;
          break;
        }
      }
      if (wi === undefined) wi = Object.values(waiting[target]).length;
      if (create) {
        waiting[target][wi] = { main: new Array(inputs).fill(null) };
        waitingSource[target][wi] = { main: new Array(inputs).fill(null) };
      }
      waiting[target][wi].main[connection.index] = out[outputIndex];
      waitingSource[target][wi].main[connection.index] = { previousNode: parent, previousNodeOutput: outputIndex, previousNodeRun: runIndex };
      if (waiting[target][wi].main.every((d) => d !== null)) {
        stack.unshift({ node: target, data: waiting[target][wi], source: waitingSource[target][wi] });
        delete waiting[target][wi];
        delete waitingSource[target][wi];
        if (!Object.keys(waiting[target]).length) {
          delete waiting[target];
          delete waitingSource[target];
        }
      }
      return;
    }
    const main = [];
    for (let i = connection.index; i >= 0; i--) main[i] = null;
    main[connection.index] = out[outputIndex];
    stack.unshift({ node: target, data: { main }, source: { main: [{ previousNode: parent, previousNodeOutput: outputIndex, previousNodeRun: runIndex }] } });
  };

  const releaseWaiting = () => {
    let names = Object.keys(waiting);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const step = graph.steps[name];
      if (!step) continue;
      const probe = new NodeExecution(run, name, 0, { main: [] }, null, 0);
      const required = probe.impl?.requiredInputs?.(probe);
      const declaredInputs = probe.impl?.inputs?.(probe) ?? graph.inputCount(name);
      if (required !== undefined && ((Array.isArray(required) && required.length === declaredInputs) || required === declaredInputs)) continue;
      const anc = graph.ancestors(name);
      if ([...anc].some((p) => names.includes(p))) continue;
      const first = Number(Object.keys(waiting[name]).sort()[0]);
      const entry = waiting[name][first];
      const withData = entry.main.map((d, idx) => (d === null ? null : idx)).filter((x) => x !== null);
      if (Array.isArray(required) && required.some((r) => !withData.includes(r))) continue;
      if (typeof required === "number" && withData.length < required) continue;
      const main = entry.main.map((d) => (d === null ? [] : d));
      const hasData = main.some((d) => d.length);
      if (hasData) {
        while (main.length < declaredInputs) main.push([]);
        stack.push({ node: name, data: { main }, source: waitingSource[name][first] });
      }
      delete waiting[name][first];
      delete waitingSource[name][first];
      if (!Object.keys(waiting[name]).length) {
        delete waiting[name];
        delete waitingSource[name];
      }
      if (hasData) break;
      names = Object.keys(waiting);
      i = -1;
    }
  };

  // n8n keeps the error of the last loop iteration: when the last node to run failed and
  // continued (onError), the execution still ends as an error with that message.
  let lastIterationError;
  while (stack.length) {
    lastIterationError = undefined;
    const ed = stack.shift();
    const name = ed.node;
    const step = graph.steps[name];
    if (!step) throw new RunnerError(`Destination node not found: ${name}`);
    const startTime = run.clock.now;
    const executionIndex = run.executionIndex++;
    const sourceList = ed.source ? ed.source.main : [];
    const inputData = addPairedItemLineage(ed.data);
    const runIndex = run.runData[name]?.length ?? 0;
    let out = null;
    let execError;
    let exec;
    const [maxTries, wait] = retryParams(step);
    for (let tryIndex = 0; tryIndex < maxTries; tryIndex++) {
      try {
        if (tryIndex !== 0) {
          run.clock.now += wait;
          if (!run.virtualTime && wait) await sleepMs(wait);
          execError = undefined;
        }
        const pinned = pinnedOutput(run, step, name);
        if (pinned) {
          out = assignPairedItems(pinned, inputData);
          if (out) run.lastNodeExecuted = name;
          out = ensureAlwaysOutputData(out, step, inputData);
          break;
        }
        exec = new NodeExecution(run, name, runIndex, inputData, ed.source, tryIndex);
        out = await runNode(exec, ed);
        const failed = !!(out && out[0]?.[0]?.json?.error !== undefined && out[0][0].json.error !== null && out[0][0].json.error !== false);
        if (failed && tryIndex < maxTries - 1) continue;
        if (out && step.settings?.onError === "continueErrorOutput") {
          out = assignPairedItems(out, inputData);
          out = routeErrorOutput(exec, out, outputsOf(exec));
        }
        out = assignPairedItems(out, inputData);
        if (out) run.lastNodeExecuted = name;
        out = ensureAlwaysOutputData(out, step, inputData);
        break;
      } catch (e) {
        if (e instanceof Suspend || e instanceof ContainmentViolation || e instanceof BadInput) throw e;
        execError = e;
      }
    }
    if (out === null && execError === undefined) continue;
    run.runData[name] ??= [];
    const task = { startTime, executionIndex, source: sourceList, executionTime: 0, executionStatus: "success" };
    if (execError !== undefined) {
      task.error = errorJson(execError);
      task.executionStatus = "error";
      run.lastNodeExecuted = name; // n8n reportNodeExecutionError
      if (exec?.continueOnFail() || step.settings?.continueOnFail === true) {
        lastIterationError = execError;
        out = inputData.main?.length && inputData.main[0] !== null ? [inputData.main[0]] : out;
      } else {
        run.runData[name].push(task);
        run.lastNodeExecuted = name;
        const err = execError instanceof Error ? execError : new NodeError(String(execError));
        err.node ??= name;
        throw new NodeFailure(err, name);
      }
    }
    normalizeNodeErrors(out);
    task.data = { main: out };
    run.runData[name].push(task);
    if (exec?.hints?.length) task.hints = exec.hints;
    if (exec?.stop) throw new NodeFailure(exec.stop, name);

    const outputs = graph.bySource[name]?.main;
    if (outputs && out) {
      const toAdd = [];
      outputs.forEach((conns, outputIndex) => {
        for (const connection of conns) {
          if (!graph.steps[connection.node]) throw new RunnerError(`Destination node not found: ${connection.node}`);
          if (out[outputIndex] && out[outputIndex].length !== 0) toAdd.push({ connection, outputIndex });
        }
      });
      toAdd.sort((a, b) => childOrder(graph, a, b));
      for (const t of toAdd) enqueue(t.connection, t.outputIndex, name, out, runIndex);
    }
    if (!stack.length && Object.keys(waiting).length) releaseWaiting();
  }
  if (lastIterationError !== undefined) throw new NodeFailure(lastIterationError instanceof Error ? lastIterationError : new NodeError(String(lastIterationError)), undefined);
}

export class NodeFailure extends Error {
  constructor(cause, node) {
    super(cause.message);
    this.name = "NodeFailure";
    this.cause = cause;
    this.node = node;
  }
}

async function runNode(exec, ed) {
  const step = exec.step;
  if (step.settings?.disabled === true) {
    const main = exec.inputData.main || [];
    if (exec.impl?.forwardAllWhenDisabled) return main;
    if (!main.length || main[0] === null) return null;
    return [main[0]];
  }
  if (!exec.impl) throw new NodeError(`Step "${exec.name}" (${step.n8n?.type} v${exec.typeVersion}) is not supported by the runtime`, { node: exec.name });
  if (step.settings?.executeOnce === true && !ed.isStart) {
    exec.inputData = { main: exec.inputData.main.map((input) => input && input.slice(0, 1)) };
    exec.connectionInputData = connectionInput(exec.inputData);
  }
  if (!ed.isStart && !exec.impl.trigger && !exec.connectionInputData.length) return null;
  return await exec.impl.execute(exec, ed);
}

// JSON-safe copy of run data (DateTimes become ISO strings, like n8n's stored executions).
export function serializeRunData(runData) {
  return JSON.parse(JSON.stringify(runData));
}

export { stableStringify };
