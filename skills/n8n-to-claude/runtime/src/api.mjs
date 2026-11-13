// Public API of the runner core.
//
//   run(definition, {trigger, clock, host, resultLog, mode, runId, virtualTime})
//     -> {status: "done"|"failed", runData, effects, resultLog, output, response, error?}
//     In-process: host.{tool, model, agent, http, sleep}(payload, {id, effectKey, runId}).
//   start(definition, {trigger, clock, runId, batchSize, mode}) / resume(state, results)
//     -> {status: "needs", requests, state} | {status: "done"|"failed", state, ...}
//     Step mode for the task driver: all state is in `state` (plain JSON). A resume
//     replays the run from the start with the logged results (same clock, same seeds),
//     so it reaches the same point and continues past it.
//   preflight(definition, {availableTools, sourceText}) -> {ok, issues}
//
// Determinism: the clock starts at clock.startedAt (default: now) and advances only by
// waits; Math.random in Code nodes and expressions is seeded from runId, step and run.

import { BadInput, ContainmentViolation, NodeError, errorJson, deepCopy, stableStringify, hasOwn, isObject } from "./util.mjs";
import { hashHex } from "./hash.mjs";
import { createRun, runEngine, Suspend, NodeFailure, serializeRunData } from "./engine.mjs";
import { nodeImplFor, isTriggerStep, SUPPORTED_TYPES } from "./nodes.mjs";
import { canDeriveRequest } from "./nodes2.mjs";
import { methodSupport } from "./extensions.mjs";

export const RUNTIME_VERSION = "0.1.0";
export const DEFINITION_SCHEMA_VERSION = 1;
const STATE_FORMAT = "n8n-to-claude/run-state";
const KINDS = ["tool", "http", "code", "model", "agent", "state", "sleep", "subflow", "branch", "loop", "logic", "trigger", "respond", "blocked"];

// ---------- definition checks ----------

export function definitionHash(definition) {
  return hashHex("sha256", stableStringify(definition));
}

export function validateDefinition(def) {
  const issues = [];
  const add = (path, message) => issues.push({ level: "error", path, message });
  if (!isObject(def)) return [{ level: "error", path: "$", message: "definition is not an object" }];
  if (def.schemaVersion !== DEFINITION_SCHEMA_VERSION) add("$.schemaVersion", `expected ${DEFINITION_SCHEMA_VERSION}`);
  if (typeof def.name !== "string") add("$.name", "missing name");
  if (!isObject(def.steps) || !Object.keys(def.steps).length) add("$.steps", "no steps");
  if (!Array.isArray(def.edges ?? [])) add("$.edges", "not an array");
  for (const [name, s] of Object.entries(def.steps ?? {})) {
    if (!isObject(s)) { add(`$.steps.${name}`, "not an object"); continue; }
    if (!KINDS.includes(s.kind)) add(`$.steps.${name}.kind`, `unknown kind ${JSON.stringify(s.kind)}`);
    if (!isObject(s.n8n) || typeof s.n8n.type !== "string") add(`$.steps.${name}.n8n`, "missing n8n.type");
    if (s.params !== undefined && !isObject(s.params)) add(`$.steps.${name}.params`, "not an object");
  }
  (def.edges ?? []).forEach((e, i) => {
    if (!isObject(e) || !hasOwn(def.steps ?? {}, e.from) || !hasOwn(def.steps ?? {}, e.to)) add(`$.edges[${i}]`, "edge refers to a missing step");
    else if (!Number.isInteger(e.fromOutput) || !Number.isInteger(e.toInput) || e.fromOutput < 0 || e.toInput < 0) add(`$.edges[${i}]`, "fromOutput/toInput must be non-negative integers");
  });
  for (const k of ["tools", "http", "sql"]) if (def.allow?.[k] !== undefined && !Array.isArray(def.allow[k])) add(`$.allow.${k}`, "not an array");
  return issues;
}

const toolKey = (t) => (typeof t === "string" ? t : `${t.connector}.${t.tool ?? t.name}`);

export function preflight(definition, { availableTools, sourceText } = {}) {
  const issues = validateDefinition(definition);
  if (issues.length) return { ok: false, issues };
  const err = (path, message, extra = {}) => issues.push({ level: "error", path, message, ...extra });
  const warn = (path, message, extra = {}) => issues.push({ level: "warning", path, message, ...extra });
  const steps = definition.steps;
  if (definition.settings?.executionOrder && definition.settings.executionOrder !== "v1") {
    warn("$.settings.executionOrder", `execution order "${definition.settings.executionOrder}" runs with v1 semantics; it differs from n8n's legacy order when branches interleave or a Merge waits`);
  }
  for (const [name, s] of Object.entries(steps)) {
    if (s.settings?.disabled === true || s.subnode) continue;
    if (s.n8n.type === "n8n-nodes-base.executeWorkflow" && !s.subflow) err(`$.steps.${name}`, "the sub-workflow is not in the definition (only inline and self-referencing sub-workflows run)", { step: name });
    if (s.kind === "blocked") err(`$.steps.${name}`, `blocked: ${s.blocked?.reason ?? "no reason given"}`, { step: name });
    else if (!nodeImplFor(s)) err(`$.steps.${name}`, `not implemented: ${s.n8n.type} v${s.n8n.typeVersion ?? 1} (kind ${s.kind})`, { step: name });
    if (s.kind === "model" && !s.model && canDeriveRequest(s) && !(definition.subnodes ?? []).some((x) => x.to === name && x.type === "ai_languageModel")) err(`$.steps.${name}`, "model step without a connected chat model", { step: name });
    else if (s.kind === "model" && !canDeriveRequest(s) && s.model?.prompt === undefined && !s.model?.messages) err(`$.steps.${name}`, "model step without model.prompt (not converted yet)", { step: name });
    if (s.kind === "agent" && !s.agent && !canDeriveRequest(s)) err(`$.steps.${name}`, "agent step without agent.prompt (not converted yet)", { step: name });
    if (s.kind === "tool" && (!s.tool?.connector || !s.tool?.name)) err(`$.steps.${name}`, "tool step without tool.connector and tool.name (not converted yet)", { step: name });
    else if (s.kind === "tool") {
      const allowed = (definition.allow?.tools ?? []).some((t) => t.connector === s.tool?.connector && t.tool === s.tool?.name);
      if (!allowed) err(`$.steps.${name}.tool`, `tool ${s.tool?.connector}.${s.tool?.name} is not in allow.tools`, { step: name });
    }
    if (s.kind === "code" && /python/i.test(s.params?.language ?? "")) err(`$.steps.${name}`, "Python Code nodes need translation (review)", { step: name });
    if (s.review) warn(`$.steps.${name}`, `flagged for review${s.reviewReasons?.length ? ": " + s.reviewReasons.join("; ") : ""}`, { step: name });
  }
  if (!Object.values(steps).some((s) => isTriggerStep(s) && s.settings?.disabled !== true)) warn("$.steps", "no trigger step; runs start at the first step without inputs");
  if (availableTools) {
    const have = new Set(availableTools.map(toolKey));
    for (const t of definition.allow?.tools ?? []) if (!have.has(toolKey(t))) err("$.allow.tools", `tool ${toolKey(t)} is not available`);
    for (const s of Object.values(steps)) for (const t of s.agent?.tools ?? []) if (t.connector && !have.has(toolKey(t))) err("$.allow.tools", `agent tool ${toolKey(t)} is not available`);
  }
  if (sourceText !== undefined) {
    const want = definition.source?.sha256;
    if (!want) err("$.source.sha256", "definition has no source hash to check");
    else if (hashHex("sha256", sourceText) !== want) err("$.source.sha256", "the stored export does not match the definition's source hash (regenerate the definition)");
  }
  return { ok: !issues.some((i) => i.level === "error"), issues };
}

// ---------- trigger ----------

function normalizeItems(items) {
  return items.map((it) => (isObject(it) && isObject(it.json) && Object.keys(it).every((k) => ["json", "binary", "pairedItem"].includes(k)) ? { json: it.json, ...(it.binary ? { binary: it.binary } : {}) } : { json: isObject(it) ? it : { value: it } }));
}

export function resolveTrigger(definition, trigger) {
  const steps = definition.steps;
  let node;
  let items;
  if (Array.isArray(trigger)) items = trigger;
  else if (isObject(trigger)) {
    node = trigger.node;
    items = trigger.items ?? (trigger.json !== undefined ? [{ json: trigger.json }] : undefined);
  } else if (trigger !== undefined && trigger !== null) throw new BadInput("trigger must be an array of items or {node, items}");
  if (node !== undefined && !hasOwn(steps, node)) throw new BadInput(`trigger node "${node}" is not a step`);
  if (node === undefined) {
    node = Object.keys(steps).find((n) => isTriggerStep(steps[n]) && steps[n].settings?.disabled !== true && !(definition.edges ?? []).some((e) => e.to === n));
    node ??= Object.keys(steps).find((n) => !(definition.edges ?? []).some((e) => e.to === n));
  }
  if (node === undefined) throw new BadInput("no step to start from");
  return { node, items: items === undefined ? [{ json: {} }] : normalizeItems(items), provided: items !== undefined };
}

// ---------- sub-workflows ----------

function backtrackFactory(child, startName) {
  return (item, idx) => {
    const walk = (p, task, depth) => {
      if (depth > 200) return undefined;
      const ps = p == null ? [] : (Array.isArray(p) ? p : [p]).map((x) => (typeof x === "number" ? { item: x } : x));
      const out = [];
      for (const q of ps) {
        const src = task?.source?.[q.input ?? 0];
        if (!src) {
          out.push({ item: q.item });
          continue;
        }
        const prevTask = child.runData[src.previousNode]?.[src.previousNodeRun || 0];
        const prevItem = prevTask?.data?.main?.[src.previousNodeOutput || 0]?.[q.item];
        if (!prevItem) return undefined;
        if (src.previousNode === startName) {
          out.push({ item: q.item });
          continue;
        }
        const r = walk(prevItem.pairedItem, prevTask, depth + 1);
        if (r === undefined) return undefined;
        out.push(...(Array.isArray(r) ? r : [r]));
      }
      if (!out.length) return undefined;
      return out.length === 1 ? out[0] : out;
    };
    const runs = child.runData[child.lastNodeExecuted];
    return walk(item.pairedItem ?? idx, runs?.[runs.length - 1], 0);
  };
}

async function runSubflow(parentExec, sub, items, prefix) {
  const parent = parentExec.run;
  if (parent.depth >= 10) throw new NodeError("Sub-workflow nesting is deeper than 10 levels", { node: parentExec.name });
  const def = sub.self ? parent.rootDefinition : sub.definition;
  if (!def?.steps) throw new NodeError("Sub-workflow definition is missing", { node: parentExec.name });
  const child = createRun(def, { clock: { startedAt: parent.clock.startedAt }, runId: parent.runId, mode: parent.mode });
  for (const k of ["clock", "resultLog", "effects", "effectIds", "host", "stepMode", "batchSize", "virtualTime", "sleepThresholdMs", "logs", "console", "randomFor", "executionInfo"]) child[k] = parent[k];
  child.idPrefix = `${parent.idPrefix}${prefix}/`;
  child.depth = parent.depth + 1;
  child.api = parent.api;
  child.nodeContext = {};
  child.rootDefinition = parent.rootDefinition;
  const startName = sub.trigger ?? Object.keys(def.steps).find((n) => def.steps[n].n8n?.type === "n8n-nodes-base.executeWorkflowTrigger" && def.steps[n].settings?.disabled !== true);
  if (!startName) throw new NodeError("Sub-workflow has no Execute Workflow Trigger", { node: parentExec.name });
  try {
    await runEngine(child, startName, items.map((it) => ({ json: it.json, ...(it.binary ? { binary: it.binary } : {}) })), true);
  } catch (e) {
    if (e instanceof NodeFailure) throw e.cause;
    throw e;
  }
  const runs = child.runData[child.lastNodeExecuted];
  const output = (runs?.[runs.length - 1]?.data?.main ?? [[]]).map((o) => (o ?? []).map((it) => ({ ...it })));
  return { output, backtrack: backtrackFactory(child, startName) };
}

// ---------- running ----------

function finish(run, status, extra = {}) {
  const runs = run.runData[run.lastNodeExecuted];
  const last = runs?.[runs.length - 1]?.data?.main;
  return {
    status,
    runId: run.runId,
    startedAt: new Date(run.clock.startedAt).toISOString(),
    endedAt: new Date(run.clock.now).toISOString(),
    lastNodeExecuted: run.lastNodeExecuted,
    output: last ? serializeRunData(last[0] ?? []).map((it) => it.json) : [],
    runData: serializeRunData(run.runData),
    effects: deepCopy(run.effects),
    resultLog: deepCopy(run.resultLog),
    ...(run.response !== undefined ? { response: run.response } : {}),
    ...(run.logs.length ? { logs: run.logs } : {}),
    ...extra,
  };
}

async function execute(run, trigger) {
  run.api = { runSubflow, nodeImplFor };
  run.nodeContext = {};
  run.rootDefinition = run.definition;
  const t = resolveTrigger(run.definition, trigger);
  try {
    await runEngineWithStart(run, t);
    return finish(run, "done");
  } catch (e) {
    if (e instanceof Suspend) return finish(run, "needs", { requests: e.requests });
    if (e instanceof NodeFailure) return finish(run, "failed", { error: { ...errorJson(e.cause), node: e.node } });
    if (e instanceof ContainmentViolation || e instanceof BadInput) return finish(run, "failed", { error: errorJson(e) });
    return finish(run, "failed", { error: errorJson(e) });
  }
}

function runEngineWithStart(run, t) {
  return runEngine(run, t.node, t.items, t.provided);
}

function preflightOrThrow(definition, opts) {
  const pf = preflight(definition, opts);
  if (!pf.ok) return { status: "failed", error: { name: "PreflightFailed", message: pf.issues.filter((i) => i.level === "error").map((i) => `${i.path}: ${i.message}`).join("; "), issues: pf.issues }, runData: {}, effects: [], resultLog: {} };
  return null;
}

export async function run(definition, opts = {}) {
  const pf = preflightOrThrow(definition, { availableTools: opts.availableTools, sourceText: opts.sourceText });
  if (pf) return pf;
  const r = createRun(definition, { ...opts, stepMode: false });
  return execute(r, opts.trigger);
}

// ---------- step mode ----------

async function step(state) {
  const r = createRun(state.definition, { clock: { startedAt: state.startedAt }, runId: state.runId, resultLog: state.resultLog, stepMode: true, batchSize: state.batchSize, mode: state.mode, virtualTime: state.virtualTime });
  const res = await execute(r, state.trigger);
  state.status = res.status;
  state.outstanding = res.status === "needs" ? res.requests.map((q) => q.id) : [];
  state.requests = res.status === "needs" ? res.requests : [];
  state.effects = res.effects;
  if (res.status !== "needs") state.result = { runData: res.runData, output: res.output, lastNodeExecuted: res.lastNodeExecuted, ...(res.response !== undefined ? { response: res.response } : {}), ...(res.error ? { error: res.error } : {}), endedAt: res.endedAt };
  const out = { status: res.status, runId: state.runId, state };
  if (res.status === "needs") out.requests = res.requests;
  else {
    out.output = res.output;
    out.runData = res.runData;
    out.effects = res.effects;
    if (res.response !== undefined) out.response = res.response;
    if (res.error) out.error = res.error;
  }
  return out;
}

export async function start(definition, opts = {}) {
  const pf = preflightOrThrow(definition, { availableTools: opts.availableTools, sourceText: opts.sourceText });
  if (pf) return pf;
  const startedAt = opts.clock?.startedAt != null ? new Date(Date.parse(opts.clock.startedAt) || Number(opts.clock.startedAt)).toISOString() : new Date().toISOString();
  const state = {
    format: STATE_FORMAT,
    version: 1,
    runtime: RUNTIME_VERSION,
    runId: opts.runId || `run-${hashHex("sha256", startedAt + definitionHash(definition)).slice(0, 12)}`,
    startedAt,
    mode: opts.mode || "trigger",
    batchSize: opts.batchSize ?? 10,
    virtualTime: opts.virtualTime ?? false,
    trigger: opts.trigger ?? null,
    definitionHash: definitionHash(definition),
    definition,
    resultLog: {},
    outstanding: [],
    status: "running",
  };
  return step(state);
}

function normalizeResult(id, r) {
  if (!isObject(r)) throw new BadInput(`result for ${id} must be an object {ok, value} or {ok: false, error}`);
  if (r.ok === true) return { ok: true, value: r.value === undefined ? null : deepCopy(r.value) };
  if (r.ok === false) return { ok: false, error: isObject(r.error) ? { name: r.error.name ?? "Error", message: String(r.error.message ?? "error") } : { name: "Error", message: String(r.error ?? "error") } };
  throw new BadInput(`result for ${id} needs "ok": true or false`);
}

export async function resume(state, results) {
  if (!isObject(state) || state.format !== STATE_FORMAT) throw new BadInput("not a run state file");
  if (state.status !== "needs") throw new BadInput(`run is ${state.status}, nothing to resume`);
  if (definitionHash(state.definition) !== state.definitionHash) throw new BadInput("the definition in the state file changed since the run started");
  const map = Array.isArray(results) ? Object.fromEntries(results.map((r) => [r?.id, r])) : results;
  if (!isObject(map)) throw new BadInput("results must be an object keyed by request id or an array of {id, ok, value|error}");
  const want = new Set(state.outstanding);
  const got = Object.keys(map);
  const unknown = got.filter((id) => !want.has(id));
  if (unknown.length) throw new BadInput(`results for ids that are not outstanding: ${unknown.join(", ")}`);
  const missing = [...want].filter((id) => !hasOwn(map, id));
  if (missing.length) throw new BadInput(`missing results for: ${missing.join(", ")}`);
  for (const id of got) {
    const { id: _ignored, ...r } = map[id];
    state.resultLog[id] = normalizeResult(id, r);
  }
  return step(state);
}

// ---------- coverage ----------

export function expressionSupport() {
  const globals = new Set(["$json", "$data", "$binary", "$input", "$", "$node", "$items", "$item", "$parameter", "$rawParameter", "$prevNode", "$runIndex", "$itemIndex", "$position", "$thisItem", "$thisItemIndex", "$thisRunIndex", "$mode", "$workflow", "$execution", "$vars", "$now", "$today", "$jmespath", "$jmesPath", "$getPairedItem", "$evaluateExpression", "$nodeVersion", "$nodeId", "$webhookId", "$if", "$min", "$max", "$average", "$not", "$ifEmpty"]);
  const known = new Set([...globals, "$env", "$fromAI", "$fromAi", "$fromai", "$tool", "$agentInfo", "$self", "$getWorkflowStaticData", "$response", "$request", "$pageCount"]);
  return {
    method: (name) => methodSupport(name),
    global: (name) => (globals.has(name) ? "extension" : name === "$env" ? "blocked" : known.has(name) ? "missing" : "other"),
  };
}

export { SUPPORTED_TYPES, nodeImplFor, isTriggerStep };
