#!/usr/bin/env node
// n8n-to-claude converter: an n8n export -> one self-contained folder per workflow.
//
//   convert.mjs <export|-> --out <dir> [--workflow <id|name>] [--answers answers.json]
//               [--approve <id>[,<id>...]] [--force-convert]
//   convert.mjs --regenerate <folder>
//
// Per workflow, <out>/<slug>/ holds:
//   definition.json  the workflow definition (references/definition.schema.json), steps keyed
//                    by n8n node name, with `review` flags on what code could not settle
//   source.n8n.json  the export with inline secrets redacted; its sha256 is in the definition
//                    (an array [workflow, ...sub-workflows it calls] when it calls others)
//   report.json      the analyzer report for this workflow
//   overrides.json   approved substitutions, answers and translations written later by the
//                    skill; regeneration keeps them and never rewrites this file
//   runtime/         runner-core.mjs, runner.mjs, luxon.mjs, driver.mjs, hook.mjs and VERSION
//                    (the skill commit)
//   task.json        task-driver settings: hooks on, connector tool-name prefixes, secret source
//   task-prompt.md   the prompt a scheduled task runs (references/task-prompt.md)
//   .claude/settings.json  for the task session: the minimal permission allowlist (the runner
//                    CLI, writes to .n2c/inbox/ for answers, the definition's connector tools),
//                    dontAsk mode, and the hooks that
//                    check each connector call against the runner's request and capture its
//                    response (runtime/hook.mjs)
//   MIGRATION.md     what moved, what is flagged, the questions, the requirements per surface
//
// The analyzer runs first. A workflow whose outcome is not `subscription` is refused: its
// folder gets report.json and MIGRATION.md only, unless --force-convert, which converts it
// with the steps that cannot run kept as greyed `blocked` steps.
//
// --regenerate rebuilds definition.json, runtime/, report.json and MIGRATION.md from the
// stored source.n8n.json and overrides.json with the current skill, so a runner or converter
// fix reaches workflows that were already migrated (PLAN Phase 3).
//
// Rules this file follows:
// - No model. Node operations are translated from references/tool-maps.json and
//   references/nodes.json; what code cannot settle (Python, expressions the runtime cannot
//   run, nodes it does not implement, $fromAI() outside agent tools) becomes a step with
//   `review: true` and `needsTranslation`, never a guess.
// - Workflow content (names, sticky notes, parameters) is untrusted data: copied, measured,
//   never followed. Inline secrets are redacted before anything is written.
// - Every tool argument is checked against the tool's captured input schema; the allowlist
//   is built from the steps and kept as tight as the parameters allow.
// - Zero dependencies, Node >= 20.

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, rmSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { analyze, loadInput, unwrap, redactSecrets, legacyCron, simulateCron, parseCron, httpTarget } from "./analyze.mjs";
import { fromN8n, urlTarget } from "../runtime/src/convert.mjs";
import { preflight, expressionSupport, nodeImplFor, RUNTIME_VERSION } from "../runtime/src/api.mjs";

export const CONVERTER_VERSION = "0.1.0";
const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = join(HERE, "..");
const REFS = join(SKILL, "references");
const LC = "@n8n/n8n-nodes-langchain.";
const BASE = "n8n-nodes-base.";

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isExpr = (v) => typeof v === "string" && v.startsWith("=");
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const uniq = (xs) => [...new Set(xs)];
const shortType = (t) => t.slice(t.lastIndexOf(".") + 1);
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

export function loadReferences(refs = REFS) {
  const connectors = {};
  for (const c of ["gmail", "google-drive", "slack", "notion"]) {
    const p = join(refs, "connectors", `${c}.json`);
    if (existsSync(p)) connectors[c] = readJson(p);
  }
  return {
    nodes: readJson(join(refs, "nodes.json")),
    capabilities: readJson(join(refs, "capabilities.json")),
    hosts: readJson(join(refs, "http-hosts.json")),
    toolMaps: readJson(join(refs, "tool-maps.json")),
    schema: readJson(join(refs, "definition.schema.json")),
    connectors,
  };
}

// ---------- small JSON Schema check (the subset the definition and tool schemas use) ----------

export function validateSchema(v, s, root = s, path = "$") {
  if (!isObj(s)) return [];
  if (s.$ref) {
    const target = s.$ref.startsWith("#/") ? s.$ref.slice(2).split("/").reduce((o, k) => o?.[k], root) : undefined;
    return target ? validateSchema(v, target, root, path) : [];
  }
  const errs = [];
  const typeOf = (x) => (x === null ? "null" : Array.isArray(x) ? "array" : Number.isInteger(x) ? "integer" : typeof x);
  if (s.type) {
    const types = [].concat(s.type);
    const t = typeOf(v);
    if (!types.includes(t) && !(t === "integer" && types.includes("number"))) return [`${path}: ${t} is not ${types.join("|")}`];
  }
  if ("const" in s && v !== s.const) errs.push(`${path}: not ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(v)) errs.push(`${path}: ${JSON.stringify(v)} not in enum`);
  if (s.pattern && typeof v === "string" && !new RegExp(s.pattern, "u").test(v)) errs.push(`${path}: does not match ${s.pattern}`);
  if (isObj(v)) {
    for (const k of s.required || []) if (!(k in v)) errs.push(`${path}: missing ${k}`);
    for (const [k, x] of Object.entries(v)) {
      if (s.properties?.[k]) errs.push(...validateSchema(x, s.properties[k], root, `${path}.${k}`));
      else if (s.additionalProperties === false) errs.push(`${path}: unexpected ${k}`);
      else if (isObj(s.additionalProperties)) errs.push(...validateSchema(x, s.additionalProperties, root, `${path}.${k}`));
    }
  }
  if (Array.isArray(v) && isObj(s.items)) v.forEach((x, i) => errs.push(...validateSchema(x, s.items, root, `${path}[${i}]`)));
  return errs;
}

// ---------- parameters ----------

function getParam(params, path) {
  let v = params;
  for (const k of String(path).split(".")) {
    if (!isObj(v)) return undefined;
    v = v[k];
  }
  return v;
}

function isEmpty(v) {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length) || (isObj(v) && !Object.keys(v).length);
}

// Leaf parameter paths that hold a value (empty objects and lists do not count).
function setPaths(params, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(params ?? {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (isObj(v) && !v.__rl) {
      const sub = setPaths(v, p);
      if (sub.length) out.push(...sub);
    } else if (!isEmpty(v)) out.push(p);
  }
  return out;
}

// n8n template text ("=Hi {{ $json.a }}!") or a literal as JavaScript source.
function toJs(v) {
  if (!isExpr(v)) return JSON.stringify(v ?? null);
  const s = v.slice(1);
  const parts = [];
  let i = 0;
  while (i < s.length) {
    const a = s.indexOf("{{", i);
    if (a < 0) {
      parts.push(JSON.stringify(s.slice(i)));
      break;
    }
    if (a > i) parts.push(JSON.stringify(s.slice(i, a)));
    const b = s.indexOf("}}", a + 2);
    if (b < 0) {
      parts.push(JSON.stringify(s.slice(a)));
      break;
    }
    parts.push(`(${s.slice(a + 2, b).trim()})`);
    i = b + 2;
  }
  const real = parts.filter((p) => p !== '""');
  if (!real.length) return '""';
  if (real.length === 1 && real[0].startsWith("(")) return real[0];
  return real.map((p) => (p.startsWith("(") ? `String(${p} ?? "")` : p)).join(" + ");
}

const GOOGLE_ID = /\/d\/([a-zA-Z0-9_-]{10,})/;

// Resolves one tool-maps.json arg spec against node parameters. Returns {value, issues}:
// value undefined means "leave the argument out"; issues are review reasons.
function resolveSpec(spec, params, issues) {
  if (typeof spec === "string") return unwrapParam(getParam(params, spec), spec, issues);
  if (!isObj(spec)) return undefined;
  if ("const" in spec) return spec.const === null ? undefined : clone(spec.const);
  if (spec.concat) {
    const parts = spec.concat.map((p) => resolveSpec(p, params, issues)).filter((p) => !isEmpty(p));
    if (!parts.length) return undefined;
    if (parts.length === 1) return typeof parts[0] === "string" ? parts[0] : String(parts[0]);
    const sep = spec.sep ?? " ";
    if (parts.every((p) => !isExpr(p))) return parts.map(String).join(sep);
    if (sep === "") return `={{ ${parts.map((p) => (isExpr(p) ? `String(${toJs(p)} ?? "")` : JSON.stringify(String(p)))).join(" + ")} }}`;
    return `={{ [${parts.map((p) => toJs(typeof p === "string" ? p : String(p))).join(", ")}].filter((x) => x !== undefined && x !== null && x !== "").join(${JSON.stringify(sep)}) }}`;
  }
  if (spec.if) {
    const c = spec.if;
    let v = unwrapParam(getParam(params, c.param), c.param, issues);
    if (v === undefined) v = c.default;
    if (isExpr(v)) {
      issues.push(`parameter "${c.param}" is set by an expression, so the mapping cannot pick a branch`);
      return undefined;
    }
    return resolveSpec(v === c.equals ? spec.then : spec.else, params, issues);
  }
  if (spec.binary !== undefined) {
    const prop = unwrapParam(getParam(params, spec.binary), spec.binary, issues) ?? spec.default ?? "data";
    if (isExpr(prop)) {
      issues.push(`the binary property name "${spec.binary}" is set by an expression`);
      return undefined;
    }
    return `={{ $binary[${JSON.stringify(prop)}]?.${spec.field ?? "data"} }}`;
  }
  if (spec.param !== undefined) {
    let v = unwrapParam(getParam(params, spec.param), spec.param, issues);
    if (v === undefined || v === "") v = spec.default;
    if (v === undefined) return undefined;
    if (spec.map) {
      if (isExpr(v)) {
        issues.push(`parameter "${spec.param}" is set by an expression; its tool value cannot be mapped`);
        return undefined;
      }
      const m = spec.map[String(v)];
      return m === undefined || m === null || m === "" ? undefined : clone(m);
    }
    if (spec.extract === "googleId") {
      if (!isExpr(v)) return GOOGLE_ID.exec(String(v))?.[1] ?? v;
      return `={{ ((s) => (s.match(/\\/d\\/([a-zA-Z0-9_-]{10,})/) || [])[1] || s)(String(${toJs(v)})) }}`;
    }
    if (spec.json && typeof v === "string" && !isExpr(v)) {
      try {
        return JSON.parse(v);
      } catch {
        issues.push(`parameter "${spec.param}" is not valid JSON`);
        return undefined;
      }
    }
    if (spec.prefix) return isExpr(v) ? `={{ ${JSON.stringify(spec.prefix)} + ${toJs(v)} }}` : `${spec.prefix}${v}`;
    return v;
  }
  if (isObj(spec)) {
    // A nested object of specs (request bodies).
    const out = {};
    for (const [k, s] of Object.entries(spec)) {
      const v = resolveSpec(s, params, issues);
      if (v !== undefined) out[k] = v;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return undefined;
}

function unwrapParam(v, path, issues) {
  if (isObj(v) && v.__rl) {
    if (v.mode === "url" && !isExpr(v.value) && typeof v.value === "string") {
      const id = GOOGLE_ID.exec(v.value)?.[1];
      if (id) return id;
      issues.push(`parameter "${path}" is given as a URL; the tool needs an id`);
    }
    return v.value === "" ? undefined : v.value;
  }
  return v;
}

function versionMatches(range, v) {
  if (range === "*") return true;
  return range.split(",").every((part) => {
    const m = /^(>=|<=|>|<|=)?\s*([\d.]+)(?:-([\d.]+))?$/.exec(part.trim());
    if (!m) return false;
    const a = Number(m[2]);
    if (m[3] !== undefined) return v >= a && v <= Number(m[3]);
    switch (m[1]) {
      case ">=":
        return v >= a;
      case "<=":
        return v <= a;
      case ">":
        return v > a;
      case "<":
        return v < a;
      default:
        return v === a;
    }
  });
}

function findMap(toolMaps, type, version, resource, operation) {
  const byType = toolMaps.maps?.[type];
  if (!byType) return null;
  for (const [range, byRes] of Object.entries(byType)) {
    if (!versionMatches(range, version)) continue;
    const entry = byRes?.[resource ?? "_"]?.[operation];
    if (entry) return { entry, key: `${type}@${range} ${resource && resource !== "_" ? `${resource}:` : ""}${operation}` };
  }
  return null;
}

function toolSchema(refs, connector, tool) {
  return refs.connectors[connector]?.tools?.find((t) => t.name === tool)?.inputSchema ?? null;
}

function coerceFor(schema, args) {
  const out = {};
  for (const k of Object.keys(args)) {
    const p = schema?.properties?.[k];
    if (!p) continue;
    const t = [].concat(p.type ?? [])[0];
    if (t === "array") out[k] = p.items?.type === "string" || !p.items ? "string[]" : "json";
    else if (t === "integer" || t === "number" || t === "boolean" || t === "string") out[k] = t;
    else if (t === "object") out[k] = "json";
  }
  return out;
}

function checkArgs(schema, args) {
  if (!schema) return { ok: false, missing: [], unknown: Object.keys(args), noSchema: true };
  const missing = (schema.required ?? []).filter((k) => args[k] === undefined);
  const unknown = Object.keys(args).filter((k) => !(k in (schema.properties ?? {})));
  return { ok: !missing.length && !unknown.length, missing, unknown };
}

// Caveats that apply to this node: {text, unless: {param, equals}} drops out when it does not.
function caveatsFor(params, list) {
  const out = [];
  for (const c of list ?? []) {
    if (typeof c === "string") out.push(c);
    else if (isObj(c) && typeof c.text === "string") {
      const v = c.unless ? unwrapParam(getParam(params, c.unless.param), c.unless.param, []) : undefined;
      if (!c.unless || v !== c.unless.equals) out.push(c.text);
    }
  }
  return out;
}

// The parameters a map does not account for: each is a review reason.
function unexplainedParams(params, entry) {
  const known = new Set([...(entry.understood ?? []), "resource", "operation", "authentication", "descriptionType", "toolDescription", "nodeCredentialType"]);
  const covered = (p) => [...known].some((k) => p === k || p.startsWith(`${k}.`));
  const reviewed = new Set((entry.review ?? []).filter((r) => r.param).map((r) => r.param));
  return setPaths(params).filter((p) => !covered(p) && ![...reviewed].some((k) => p === k || p.startsWith(`${k}.`)));
}

function mapReviews(params, entry) {
  const out = [];
  for (const r of entry.review ?? []) {
    if (!r.param) {
      out.push(r.reason);
      continue;
    }
    const v = unwrapParam(getParam(params, r.param), r.param, []);
    if (isEmpty(v)) continue;
    if (!("equals" in r) || v === r.equals) out.push(r.reason);
  }
  return out;
}

// ---------- $fromAI ----------

const FROM_AI = /\$fromA[Ii]\s*\(\s*(['"`])((?:(?!\1).)+)\1\s*(?:,\s*(['"`])((?:(?!\3).)*)\3\s*)?(?:,\s*(['"`])(\w*)\5\s*)?(?:,\s*([^)]*?)\s*)?\)/g;

function allStrings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => allStrings(x, out));
  else if (isObj(v)) Object.values(v).forEach((x) => allStrings(x, out));
  return out;
}

export function fromAiSchema(params) {
  const props = {};
  const required = [];
  for (const s of allStrings(params)) {
    FROM_AI.lastIndex = 0;
    for (let m; (m = FROM_AI.exec(s)); ) {
      const key = m[2];
      if (props[key]) continue;
      const type = ["string", "number", "boolean", "json"].includes(m[6]) ? (m[6] === "json" ? "object" : m[6]) : "string";
      props[key] = { type, ...(m[4] ? { description: m[4] } : {}) };
      if (m[7] === undefined || m[7] === "") required.push(key);
    }
  }
  if (!Object.keys(props).length) return null;
  return { type: "object", properties: props, required };
}

// ---------- expressions the runtime cannot run ----------

function exprSegments(s) {
  if (!isExpr(s)) return [];
  const segs = [];
  let i = 0;
  while ((i = s.indexOf("{{", i)) >= 0) {
    const j = s.indexOf("}}", i + 2);
    segs.push(s.slice(i + 2, j < 0 ? undefined : j));
    if (j < 0) break;
    i = j + 2;
  }
  return segs;
}

function expressionIssues(params, { allowFromAi = false } = {}) {
  const sup = expressionSupport();
  const issues = [];
  for (const s of allStrings(params)) {
    for (const seg of exprSegments(s)) {
      for (const m of seg.matchAll(/\$[A-Za-z_]\w*/g)) {
        const name = m[0];
        if (/^\$fromA[Ii]$/.test(name)) {
          if (!allowFromAi) issues.push({ kind: "from-ai", original: s, reason: "$fromAI() only has a value inside a tool an agent calls" });
          continue;
        }
        const g = sup.global(name);
        if (g === "blocked") issues.push({ kind: "expression", original: s, reason: `${name} is blocked in n8n and in the runtime` });
        else if (g === "missing") issues.push({ kind: "expression", original: s, reason: `${name} is not supported by the runtime` });
      }
      for (const m of seg.matchAll(/\.\s*([A-Za-z_]\w*)\s*\(/g)) {
        if (sup.method(m[1]) === "missing") issues.push({ kind: "expression", original: s, reason: `.${m[1]}() is an n8n extension the runtime lacks` });
      }
    }
  }
  const seen = new Set();
  return issues.filter((i) => !seen.has(i.reason) && seen.add(i.reason));
}

// ---------- schedule ----------

function scheduleCron(item) {
  const i = isObj(item) ? item : {};
  const field = i.field ?? "days";
  const h = i.triggerAtHour ?? 0;
  const mi = i.triggerAtMinute ?? 0;
  switch (field) {
    case "seconds":
      return { cron: `*/${i.secondsInterval ?? 30} * * * * *` };
    case "minutes":
      return { cron: `0 */${i.minutesInterval ?? 5} * * * *`, everySeconds: (i.minutesInterval ?? 5) * 60 };
    case "hours":
      return { cron: `0 ${mi} */${i.hoursInterval ?? 1} * * *`, everySeconds: (i.hoursInterval ?? 1) * 3600 };
    case "days":
      return { cron: `0 ${mi} ${h} ${(i.daysInterval ?? 1) === 1 ? "*" : `*/${i.daysInterval}`} * *`, ...((i.daysInterval ?? 1) > 1 ? { everySeconds: i.daysInterval * 86400 } : {}) };
    case "weeks": {
      const days = uniq([].concat(i.triggerAtDay ?? [0]).map(Number)).sort((a, b) => a - b);
      return { cron: `0 ${mi} ${h} * * ${days.length ? days.join(",") : "*"}`, ...((i.weeksInterval ?? 1) > 1 ? { everySeconds: (i.weeksInterval ?? 1) * 7 * 86400 } : {}) };
    }
    case "months":
      return { cron: `0 ${mi} ${h} ${i.triggerAtDayOfMonth ?? 1} ${(i.monthsInterval ?? 1) === 1 ? "*" : `*/${i.monthsInterval}`} *` };
    case "cronExpression":
      return { cron: String(i.expression ?? "").trim() };
    default:
      return { cron: null };
  }
}

function scheduleFor(step, report, now) {
  const p = step.params ?? {};
  const type = step.n8n.type;
  const crons = [];
  let every;
  let unreadable;
  if (allStrings(type === BASE + "scheduleTrigger" ? p.rule ?? {} : p).some(isExpr) && type !== BASE + "interval") unreadable = "the schedule is set by an expression";
  if (type === BASE + "scheduleTrigger") {
    for (const item of [].concat((p.rule ?? { interval: [{ field: "days" }] }).interval ?? [])) {
      const c = scheduleCron(item);
      if (c.cron) crons.push(c.cron);
      if (c.everySeconds) every = Math.min(every ?? Infinity, c.everySeconds);
    }
  } else if (type === BASE + "interval") {
    every = Number(p.interval ?? 1) * ({ seconds: 1, minutes: 60, hours: 3600 }[p.unit ?? "seconds"] ?? 1);
  } else {
    const coll = type === BASE + "cron" ? p.triggerTimes ?? {} : p.pollTimes ?? { item: [{ mode: "everyMinute" }] };
    for (const item of [].concat(coll.item ?? [])) crons.push(legacyCron(item));
  }
  const out = { cron: crons, ...(every ? { everySeconds: every } : {}), timezone: report.schedule?.timezone ?? "America/New_York" };
  let runs = null;
  let shortest = null;
  try {
    if (unreadable) throw new Error(unreadable);
    crons.forEach((c) => parseCron(c));
    if (every && !crons.length) (runs = 86400 / every), (shortest = every);
    else if (crons.length) {
      const sim = simulateCron(crons, now);
      runs = sim.runsPerDay;
      shortest = sim.shortestSec;
      if (every) {
        // A fixed rhythm n8n enforces on top of the cron (minutes/hours/days intervals).
        runs = Math.min(runs, 86400 / every);
        shortest = Math.max(shortest ?? every, every);
      }
    }
  } catch (e) {
    out.note = e.message;
  }
  out.runsPerDay = runs === null ? null : Math.round(runs * 1000) / 1000;
  out.shortestIntervalSec = shortest === null ? null : Math.round(shortest);
  out.fits = report.schedule?.fits ?? "n/a";
  if (report.schedule?.timezoneSource === "n8n-default") out.note = [out.note, "the export names no timezone; n8n's default is used"].filter(Boolean).join("; ");
  if (report.schedule?.dstNote) out.note = [out.note, "the timezone moves its clocks: a time-of-day run can shift, be skipped or repeat around the change"].filter(Boolean).join("; ");
  if (!out.note) delete out.note;
  return out;
}

// ---------- model steps ----------

function promptFor(step) {
  const p = step.params ?? {};
  const v = step.n8n.typeVersion ?? 1;
  const t = step.n8n.type;
  if (t === LC + "chainLlm" && v <= 1.3) return p.prompt ?? (v === 1 ? "={{ $json.input }}" : v === 1.1 ? "={{ $json.chat_input }}" : "={{ $json.chatInput }}");
  const type = p.promptType ?? (t === LC + "agent" && v >= 1.7 ? "auto" : "auto");
  if (type === "define") return p.text ?? "";
  if (type === "guardrails") return p.guardrailsInput ?? "";
  return "={{ $json.chatInput }}";
}

function schemaFromExample(v) {
  if (Array.isArray(v)) return { type: "array", items: v.length ? schemaFromExample(v[0]) : {} };
  if (v === null) return { type: "null" };
  if (typeof v === "object") return { type: "object", properties: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, schemaFromExample(x)])) };
  return { type: typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v };
}

function parserSchema(step, reasons) {
  const p = step.params ?? {};
  const type = p.schemaType ?? ((step.n8n.typeVersion ?? 1) >= 1.2 ? "fromJson" : "manual");
  try {
    if (type === "manual") return typeof p.inputSchema === "string" ? JSON.parse(p.inputSchema) : p.inputSchema ?? { type: "object" };
    const ex = typeof p.jsonSchemaExample === "string" ? JSON.parse(p.jsonSchemaExample.replace(/,\s*([}\]])/g, "$1")) : p.jsonSchemaExample ?? { state: "California", cities: ["Los Angeles", "San Francisco", "San Diego"] };
    return schemaFromExample(ex);
  } catch {
    reasons.push(`the output parser "${step.name}" schema is not valid JSON`);
    return { type: "object" };
  }
}

function attrType(t) {
  return { number: "number", boolean: "boolean", date: "string", string: "string" }[t] ?? "string";
}

// ---------- the converter ----------

const SURFACE_LABEL = { cloudTask: "cloud task", localTask: "local task", artifact: "artifact" };

function slugify(name, id, used) {
  let s =
    String(name ?? "workflow")
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 60)
      .replace(/^-|-$/g, "") || "workflow";
  if (used.has(s)) s = `${s}-${String(id).replace(/[^\w-]/g, "").slice(0, 20) || used.size}`;
  used.add(s);
  return s;
}

// The workflows `rootId` calls by id, transitively (not itself).
function calleesOf(report, rootId) {
  const byId = new Map(report.workflows.map((w) => [w.id, w]));
  const seen = new Set([rootId]);
  const order = [];
  const visit = (id) => {
    for (const c of byId.get(id)?.calls ?? []) {
      if (c.target && !seen.has(c.target) && byId.has(c.target)) {
        seen.add(c.target);
        order.push(c.target);
        visit(c.target);
      }
    }
  };
  visit(rootId);
  return order;
}

function sourceText(item, callees) {
  const doc = callees.length ? [item.wf, ...callees.map((c) => c.wf)] : item.wf;
  return JSON.stringify(doc, null, 2) + "\n";
}

class Ctx {
  constructor(refs, opts) {
    this.refs = refs;
    this.approve = new Set(opts.approve ?? []);
    this.now = opts.now ?? Date.now();
    this.force = !!opts.forceConvert;
  }
}

// Converts one analysed workflow. items: every loaded workflow (redacted), report: the
// analyzer report over them, id: the workflow to convert. Returns the definition.
export function buildDefinition(ctx, items, report, id, { stack = [], file = "source.n8n.json", text } = {}) {
  const item = items.find((x) => x.id === id);
  const wr = report.workflows.find((w) => w.id === id);
  const wf = item.wf;
  const refs = ctx.refs;
  const base = fromN8n(wf, { nodes: refs.nodes, sourceText: text ?? JSON.stringify(wf, null, 2) + "\n" });
  const steps = base.steps;
  const infoOf = new Map(wr.steps.map((s) => [s.node, s]));
  const notes = [];
  const allow = { tools: [], http: [], sql: [] };
  const secrets = new Map();
  const nodesByName = new Map((wf.nodes ?? []).filter((n) => isObj(n) && typeof n.name === "string").map((n) => [n.name, n]));
  const subnodesTo = (name, type) => base.subnodes.filter((s) => s.to === name && s.type === type).map((s) => s.from).filter((n) => steps[n]);

  const review = (step, reason) => {
    step.review = true;
    step.reviewReasons = uniq([...(step.reviewReasons ?? []), reason]);
  };
  const translate = (step, kind, original, reason) => {
    step.needsTranslation ??= { kind, original, reason };
    review(step, reason);
  };
  const block = (step, kind, reason, extra = {}) => {
    step.kind = "blocked";
    step.blocked = { reason, kind, ...extra };
    for (const k of ["tool", "http", "model", "agent", "auth", "connector", "poll"]) delete step[k];
  };
  const addTool = (connector, tool) => {
    if (!allow.tools.some((t) => t.connector === connector && t.tool === tool)) allow.tools.push({ connector, tool });
  };
  const addHttp = (method, host, pathPrefix, note) => {
    if (!allow.http.some((a) => a.method === method && a.host === host && (a.pathPrefix ?? "") === (pathPrefix ?? ""))) allow.http.push({ method, host, ...(pathPrefix !== undefined ? { pathPrefix } : {}), ...(note ? { note } : {}) });
  };
  const addSecret = (name, credentialType, host) => {
    const s = secrets.get(name) ?? { name, credentialType, hosts: [] };
    if (host && host !== "*" && !s.hosts.includes(host)) s.hosts.push(host);
    secrets.set(name, s);
  };

  for (const s of Object.values(steps)) {
    delete s.review;
    delete s.reviewReasons;
  }

  // Applies a tool map entry (connector tool or REST template) to a step.
  const applyMap = (name, step, found, params) => {
    const { entry, key } = found;
    if (entry.blocked) {
      block(step, entry.blocked.kind ?? "no-tool", entry.blocked.reason, entry.blocked.alternative ? { alternative: entry.blocked.alternative } : {});
      return;
    }
    const issues = [];
    if (entry.http) {
      const h = entry.http;
      const urlIssues = [];
      // A literal URL (it may hold the {{secret}} placeholder) or a spec.
      const url = typeof h.url === "string" && /^https?:\/\//.test(h.url) ? h.url : resolveSpec(h.url, params, urlIssues);
      const body = h.body ? resolveSpec(h.body, params, issues) : undefined;
      const query = h.query ? resolveSpec(h.query, params, issues) : undefined;
      step.kind = "http";
      const cav = caveatsFor(params, entry.caveats);
      step.http = { method: h.method, url, ...(query ? { query } : {}), ...(body ? { body } : {}), ...(h.coerce ? { coerce: h.coerce } : {}), result: entry.result ?? {}, fidelity: entry.fidelity, ...(cav.length ? { caveats: cav } : {}), map: key };
      issues.push(...urlIssues);
      const cred = Object.entries(step.credentials ?? {}).find(([t]) => t === entry.credentialType) ?? Object.entries(step.credentials ?? {})[0];
      const secretName = cred?.[1] ?? `${entry.credentialType} (no credential named in the export)`;
      step.auth = { credentialType: entry.credentialType, secret: secretName, ...(entry.placement && entry.placement !== "header" ? { placement: entry.placement } : {}) };
      const target = staticTarget(url);
      if (target) {
        addHttp(h.method, target.host, target.pathPrefix);
        addSecret(secretName, entry.credentialType, target.host);
      } else {
        addHttp(h.method, "*", undefined, `step "${name}": URL built at run time`);
        review(step, "the request URL is built at run time; narrow allow.http to its host in overrides.json");
        addSecret(secretName, entry.credentialType);
      }
      for (const host of refs.toolMaps.credentialHosts?.[entry.credentialType] ?? []) addSecret(secretName, entry.credentialType, host);
    } else {
      const args = {};
      for (const [k, spec] of Object.entries(entry.args ?? {})) {
        const v = resolveSpec(spec, params, issues);
        if (v !== undefined) args[k] = v;
      }
      const schema = toolSchema(refs, entry.connector, entry.tool);
      const argsCheck = checkArgs(schema, args);
      step.kind = "tool";
      step.connector = entry.connector;
      step.tool = {
        connector: entry.connector,
        name: entry.tool,
        args,
        effect: entry.effect ?? "write",
        coerce: coerceFor(schema, args),
        result: entry.result ?? {},
        fidelity: entry.fidelity ?? "unverified",
        ...(entry.missingFields?.length ? { missingFields: entry.missingFields } : {}),
        ...(caveatsFor(params, entry.caveats).length ? { caveats: caveatsFor(params, entry.caveats) } : {}),
        argsCheck: { ok: argsCheck.ok, missing: argsCheck.missing, unknown: argsCheck.unknown },
        map: key,
      };
      if (argsCheck.noSchema) review(step, `no captured input schema for ${entry.connector}.${entry.tool}`);
      if (argsCheck.unknown.length) review(step, `arguments the tool does not take: ${argsCheck.unknown.join(", ")}`);
      if (entry.argsNeedTranslation) translate(step, "code", clone(params), entry.argsNeedTranslation);
      else if (argsCheck.missing.length) review(step, `required tool arguments without a value: ${argsCheck.missing.join(", ")}`);
      addTool(entry.connector, entry.tool);
    }
    for (const r of [...issues, ...mapReviews(params, entry)]) review(step, r);
    for (const p of unexplainedParams(params, entry)) review(step, `parameter "${p}" has no counterpart in ${entry.tool ?? "the request"}`);
    if (entry.reviewSheetNotFirstTab) {
      const sheet = unwrapParam(params.sheetName, "sheetName", []);
      if (sheet !== undefined && !/^(gid=)?0$/.test(String(sheet)) && String(sheet) !== "") review(step, `the sheet "${params.sheetName?.cachedResultName ?? sheet}" may not be the first tab; the export reads the first tab only`);
    }
  };

  const capOps = (type, opKey) => {
    for (const c of Object.values(refs.capabilities.connectors ?? {})) {
      const e = c.operations?.[type]?.ops?.[opKey];
      if (e) return e;
    }
    return null;
  };

  // ---------- first pass: every step on its own ----------
  for (const [name, step] of Object.entries(steps)) {
    const info = infoOf.get(name) ?? {};
    const node = nodesByName.get(name) ?? {};
    const params = step.params ?? {};
    const type = step.n8n.type;
    const v = step.n8n.typeVersion ?? 1;
    const entry = refs.nodes.nodes[type];
    const baseType = entry?.toolVariantOf ?? type;
    const opKey = info.resource ? `${info.resource}:${info.operation}` : info.operation ?? null;
    const disabled = step.settings?.disabled === true;
    const offBranch = info.branch === "unreached";

    // Substitutions offered by tool-maps.json (SMTP -> Gmail, IMAP -> Gmail poll).
    const sub = Object.entries(refs.toolMaps.substitutions ?? {}).find(([, s]) => s.from === type && (s.operation === "poll" || !info.operation || s.operation === info.operation));
    if (sub) {
      const [subId, s] = sub;
      const approved = ctx.approve.has(subId) || ctx.approve.has(`${subId}:${name}`);
      step.substitution = { id: subId, from: shortType(type), to: s.to, approved };
      if (!approved) {
        block(step, "substitution", `${shortType(type)} cannot run on Claude as it is: ${s.to}`, { offer: `approve with --approve ${subId}` });
        continue;
      }
      if (s.operation === "poll") {
        step.kind = "trigger";
        const issues = [];
        const args = {};
        for (const [k, spec] of Object.entries(s.args ?? {})) {
          const val = resolveSpec(spec, params, issues);
          if (val !== undefined) args[k] = val;
        }
        step.poll = { tool: { connector: s.connector, name: s.tool, args }, result: s.result ?? {}, cursor: s.cursor, fidelity: s.fidelity, ...(s.caveats ? { caveats: caveatsFor(params, s.caveats) } : {}), map: `substitution ${subId}` };
        step.schedule = scheduleFor(step, wr, ctx.now);
        addTool(s.connector, s.tool);
        review(step, `substituted (${subId}): check the poll query matches the mailbox n8n read`);
      } else applyMap(name, step, { entry: s, key: `substitution ${subId}` }, params);
      continue;
    }

    // An operation the catalogue blocks (send-and-wait, n8n-internal ones).
    if (info.kind === "blocked") {
      const why = (opKey && entry?.operations?.[opKey]?.reason) || entry?.mapping?.reason || `${shortType(type)} ${opKey ?? ""} is not supported`.trim();
      block(step, offBranch ? "dropped" : "unsupported", why);
      continue;
    }

    // Levers the analyzer knows but the runtime does not have yet.
    if (["db", "vector", "files", "media"].includes(info.kind)) {
      const why = {
        db: "a database step needs the bundled server or a database connector (open decision 1)",
        vector: "a vector store needs an MCP server (lever not built yet)",
        files: "file steps need the files lever (not built yet)",
        media: "media steps (transcription, image generation) go through the original provider (lever not built yet)",
      }[info.kind];
      block(step, offBranch ? "dropped" : "unsupported", why);
      continue;
    }

    if (step.kind === "blocked") {
      // The basic converter's reason, made specific.
      if (info.role === "unknown" || entry?.mapping === "unmapped" || !entry) block(step, "unmapped", step.blocked?.reason ?? "node type not in the catalogue");
      else if (type === BASE + "errorTrigger") block(step, "dropped", "error workflows are replaced by the runner's failure alert");
      else if (entry?.mapping?.role === "n8n-internal" || info.role === "n8n-internal") block(step, "unsupported", `n8n-internal node: ${entry?.mapping?.notes ?? shortType(type)}`);
      else block(step, offBranch ? "dropped" : "unsupported", step.blocked?.reason ?? `${shortType(type)} is not supported`);
      continue;
    }

    // ----- triggers -----
    if (step.kind === "trigger") {
      const wake = entry?.mapping?.wakeup;
      if (type === BASE + "scheduleTrigger" || type === BASE + "cron" || type === BASE + "interval") step.schedule = scheduleFor(step, wr, ctx.now);
      else if (type === LC + "chatTrigger") {
        step.chat = true;
        if (params.public === true) review(step, "the chat page is public: outsiders cannot reach a Claude skill");
      } else if (type === BASE + "formTrigger") {
        step.form = { ...(params.formTitle ? { title: String(params.formTitle) } : {}), ...(params.formDescription ? { description: String(params.formDescription) } : {}), fields: clone(params.formFields?.values ?? []) };
      } else if (type === BASE + "webhook") {
        step.relay = { method: String(params.httpMethod ?? "GET"), path: String(params.path ?? ""), payloadShape: "the request as n8n's Webhook gives it: {headers, params, query, body}" };
        if (params.responseMode && params.responseMode !== "onReceived") review(step, "the caller waits for a reply; a relay cannot answer it");
      } else if (type === LC + "mcpTrigger") block(step, "unsupported", "n8n as an MCP server: replaced by Claude itself");
      else if (info.kind === "connector" || /poll/.test(String(wake))) {
        const found = findMap(refs.toolMaps, type, v, "_", "poll");
        if (found) {
          const e = found.entry;
          const issues = [];
          const args = {};
          for (const [k, spec] of Object.entries(e.args ?? {})) {
            const val = resolveSpec(spec, params, issues);
            if (val !== undefined) args[k] = val;
          }
          let cursor = e.cursor;
          if (e.cursorByParam) {
            const pv = params[e.cursorByParam.param];
            if (!isExpr(pv) && e.cursorByParam.values[pv]) cursor = e.cursorByParam.values[pv];
          }
          const schema = toolSchema(refs, e.connector, e.tool);
          step.poll = { tool: { connector: e.connector, name: e.tool, args, coerce: coerceFor(schema, args) }, result: e.result ?? {}, cursor, fidelity: e.fidelity, ...(e.missingFields?.length ? { missingFields: e.missingFields } : {}), ...(e.caveats ? { caveats: caveatsFor(params, e.caveats) } : {}), map: found.key };
          step.schedule = scheduleFor(step, wr, ctx.now);
          addTool(e.connector, e.tool);
          const chk = checkArgs(schema, args);
          if (!chk.ok) review(step, `poll arguments do not fit ${e.tool}: ${[...chk.missing, ...chk.unknown].join(", ")}`);
          for (const r of [...issues, ...mapReviews(params, e)]) review(step, r);
          for (const p of unexplainedParams(params, e)) review(step, `parameter "${p}" has no counterpart in ${e.tool}`);
        } else if (wake === "poll" || /Trigger$/.test(type)) {
          const cap = capOps(type, "poll");
          if (cap?.confirmed === "not-captured") block(step, "not-captured", `the ${info.kind === "connector" ? "connector" : "app"}'s tools are not captured yet, so its poll cannot be mapped`);
          else if (wake === "poll") block(step, "no-tool", `no tool map for polling ${shortType(type)}`);
          else step.relay = { payloadShape: `the event as n8n's ${shortType(type)} gives it` };
        }
      } else if (wake === "relay" || wake === "endpoint" || /Trigger$/.test(type)) {
        if (![BASE + "manualTrigger", BASE + "executeWorkflowTrigger", BASE + "start"].includes(type)) step.relay = { payloadShape: `the event as n8n's ${shortType(type)} gives it` };
      }
      continue;
    }

    // ----- sub-nodes consumed by their parent -----
    if (step.subnode && (step.kind === "model" || step.kind === "agent" || /outputParser|memoryBufferWindow/.test(type))) {
      if (/outputParserAutofixing/.test(type)) review(step, "the auto-fixing parser re-asks the model on bad output; the structured output schema covers it");
      continue;
    }

    // ----- connectors (steps and agent tools) -----
    if (info.kind === "connector" || step.kind === "tool") {
      if (info.kind === "connector" && entry?.mapping?.connector === "custom-mcp") {
        block(step, "unsupported", "an MCP server tool: add the server as a custom connector, then map its tools", {});
        continue;
      }
      const found = info.operation != null ? findMap(refs.toolMaps, baseType, v, info.resource ?? "_", info.operation) : null;
      if (found) {
        applyMap(name, step, found, params);
        if (step.subnode && step.kind === "tool") {
          step.subnode = true;
        }
        continue;
      }
      const cap = capOps(baseType, opKey);
      if (info.operation == null) block(step, "input-incomplete", "the operation is set by an expression, so no tool can be chosen");
      else if (cap?.confirmed === "no-tool") block(step, "no-tool", cap.note ?? "the connector has no tool for this operation");
      else if (cap?.confirmed === "not-captured") block(step, "not-captured", `${cap.note ?? "the connector's tools are not captured"}; map ${opKey} once they are`);
      else block(step, "no-tool", `no tool map for ${shortType(baseType)} ${opKey} yet`);
      continue;
    }

    // ----- app nodes over HTTP (REST templates) -----
    if (step.kind === "http" && type !== BASE + "httpRequest") {
      if (info.kind === "model" && info.levers?.includes("llm-api")) {
        // handled below with the HTTP Request node
      } else {
        const found = info.operation != null ? findMap(refs.toolMaps, baseType, v, info.resource ?? "_", info.operation) : null;
        if (found) applyMap(name, step, found, params);
        else if (type === LC + "toolHttpRequest" || type === BASE + "httpRequestTool") {
          // agent http tools are built in the agent pass
        } else block(step, "no-tool", `no request template for ${shortType(baseType)}${opKey ? ` ${opKey}` : ""} yet (it needs the app's REST API with a stored secret)`);
        continue;
      }
    }

    // ----- HTTP Request -----
    if (type === BASE + "httpRequest") {
      if (info.levers?.includes("llm-api") || info.kind === "model") {
        const id = "llm-api-to-claude";
        const approved = ctx.approve.has(id) || ctx.approve.has(`${id}:${name}`);
        step.substitution = { id, from: "HTTP request to an LLM API", to: "a model step on Claude", approved };
        if (!approved) {
          block(step, "substitution", "a request to an LLM API with an API key", { offer: `approve with --approve ${id} to run it as a model step on Claude` });
          continue;
        }
        step.kind = "model";
        delete step.auth;
        step.model = { prompt: "", outputKey: "text" };
        translate(step, "llm-api-body", clone({ url: params.url, method: params.method, jsonBody: params.jsonBody, bodyParameters: params.bodyParameters }), "the request body has to become a prompt, and the response shape n8n's next steps read has to be rebuilt");
        continue;
      }
      if (v < 3) {
        translate(step, "node", clone(params), `HTTP Request v${v} is not implemented by the runtime (v3 and later are)`);
        continue;
      }
      const method = params.method ?? params.requestMethod ?? "GET";
      const methodOut = isExpr(method) ? "*" : String(method).toUpperCase();
      if (isExpr(method)) review(step, "the HTTP method is set by an expression");
      const target = urlTarget(params.url);
      if (target) addHttp(methodOut, target.host, target.pathPrefix);
      else {
        addHttp(methodOut, "*", undefined, `step "${name}": URL built at run time`);
        review(step, "the request URL is built at run time; narrow allow.http to its host in overrides.json");
      }
      if (step.auth?.secret) {
        addSecret(step.auth.secret, step.auth.credentialType, target?.host);
        for (const host of refs.toolMaps.credentialHosts?.[step.auth.credentialType] ?? []) addSecret(step.auth.secret, step.auth.credentialType, host);
      }
      if (params.options?.pagination) translate(step, "node", clone(params.options.pagination), "HTTP pagination is not implemented by the runtime");
      if (params.options?.response?.response?.responseFormat === "file") review(step, "the response is a file (binary data), which the runtime does not keep");
      if (params.sendBody && params.contentType === "binaryData") review(step, "the body is binary data, which the runtime does not send");
      continue;
    }

    // ----- models -----
    if (step.kind === "model" && !step.subnode) {
      convertModel(name, step, { params, type, v, review, translate, subnodesTo, steps, block });
      continue;
    }

    // ----- agents -----
    if (step.kind === "agent" && !step.subnode) {
      if (type !== LC + "agent") {
        block(step, "unsupported", `${shortType(type)} ${opKey ?? ""} runs on the provider's own agent service`.trim());
        continue;
      }
      continue; // second pass
    }

    // ----- code -----
    if (step.kind === "code" && !step.subnode) {
      const lang = params.language ?? (type === BASE + "code" ? "javaScript" : "javaScript");
      const src = String(params.jsCode ?? params.functionCode ?? params.code ?? params.pythonCode ?? "");
      if (/python/i.test(lang)) translate(step, "python", params.pythonCode ?? "", "Python Code runs only after translation to JavaScript");
      else {
        if (/\brequire\s*\(/.test(src)) translate(step, "code", src, "the code calls require(), which the runtime does not offer");
        if (/\bhelpers\s*\.\s*\w+/.test(src) || /this\.helpers/.test(src)) translate(step, "code", src, "the code uses n8n's helpers (HTTP or binary), which the runtime does not offer");
        if (/\$getWorkflowStaticData/.test(src)) translate(step, "code", src, "the code keeps workflow static data, which needs the state lever");
      }
      continue;
    }

    // ----- sub-workflows -----
    if (type === BASE + "executeWorkflow") {
      const call = wr.calls.find((c) => c.node === name);
      if (step.subflow) continue; // self or inline (basic converter)
      if (call?.status === "inline") {
        try {
          const json = JSON.parse(params.workflowJson);
          const subItems = unwrap(json, `${id}#${name}`) ?? [];
          if (subItems.length) step.subflow = { definition: convertDetached(ctx, subItems[0].wf, `${id}#${name}`, stack) };
        } catch {
          block(step, "input-incomplete", "the inline sub-workflow JSON cannot be read");
        }
        continue;
      }
      if (call?.target && call.target !== id) {
        if (stack.includes(call.target)) block(step, "unsupported", `workflows that call each other in a loop (${[...stack, id, call.target].join(" → ")}) are not supported`);
        else {
          step.subflow = { workflowId: call.target, definition: buildDefinition(ctx, items, report, call.target, { stack: [...stack, id] }) };
          mergeAllow(allow, secrets, step.subflow.definition);
        }
        continue;
      }
      block(step, "input-incomplete", "the sub-workflow is not in the export (or is set by an expression)");
      continue;
    }

    // ----- waits -----
    if (step.kind === "sleep") {
      const resume = params.resume ?? "timeInterval";
      if (type === BASE + "wait" && resume !== "timeInterval" && resume !== "specificTime") block(step, "unsupported", `a Wait that resumes on ${resume} (out of scope v1)`);
      else if (type !== BASE + "wait") block(step, "unsupported", `${shortType(type)} waits for a person (out of scope v1)`);
      continue;
    }

    // Logic nodes the runtime does not implement.
    if (!step.subnode && !disabled && !nodeImplFor(step)) translate(step, "node", { type, typeVersion: v }, `${shortType(type)} v${v} is not implemented by the runtime`);
  }

  // ---------- second pass: agents and their tools ----------
  for (const [name, step] of Object.entries(steps)) {
    if (step.kind !== "agent" || step.subnode) continue;
    const p = step.params ?? {};
    const v = step.n8n.typeVersion ?? 1;
    const reasons = [];
    const agent = { prompt: promptFor(step), system: p.options?.systemMessage ?? "You are a helpful assistant", tools: [], maxIterations: p.options?.maxIterations ?? 10 };
    const [lm] = subnodesTo(name, "ai_languageModel");
    if (lm) agent.hint = hintOf(lm, steps[lm]);
    else reasons.push("no chat model is connected");
    const [mem] = subnodesTo(name, "ai_memory");
    if (mem) {
      const mt = steps[mem].n8n.type;
      if (mt === LC + "memoryBufferWindow") {
        const mp = steps[mem].params ?? {};
        const custom = mp.sessionIdType === "customKey";
        agent.memory = { kind: "conversation", key: custom ? String(mp.sessionKey ?? "") : "={{ $json.sessionId }}", window: mp.contextWindowLength ?? 5, node: mem };
      } else {
        reasons.push(`memory ${shortType(mt)} needs a database (not built yet)`);
        block(steps[mem], "unsupported", `${shortType(mt)} keeps chat memory in a database (lever not built yet)`);
      }
    }
    const hasParser = p.hasOutputParser === true || (v < 1.7 && subnodesTo(name, "ai_outputParser").length > 0);
    if (hasParser) {
      const [ps] = subnodesTo(name, "ai_outputParser");
      if (ps) agent.outputSchema = parserSchema({ ...steps[ps], name: ps }, reasons);
    }
    for (const tn of subnodesTo(name, "ai_tool")) {
      const ts = steps[tn];
      if (ts.settings?.disabled) continue;
      const tp = ts.params ?? {};
      const toolName = tn.replace(/[^a-zA-Z0-9_-]/g, "_");
      const description = String(tp.toolDescription ?? tp.description ?? `${shortType(ts.n8n.type).replace(/Tool$/, "")} ${[tp.resource, tp.operation].filter(Boolean).join(" ")}`.trim());
      const t = { name: toolName, description, node: tn, n8nType: ts.n8n.type };
      if (ts.kind === "tool" && ts.tool) {
        Object.assign(t, { kind: "connector", effect: ts.tool.effect === "read" ? "read" : "write" });
        const schema = fromAiSchema(tp);
        if (schema) t.inputSchema = schema;
      } else if (ts.n8n.type === LC + "toolWorkflow") {
        const call = buildToolWorkflow(ctx, items, report, wr, tn, ts, stack, id, allow, secrets);
        if (call.blocked) {
          block(ts, "input-incomplete", call.blocked);
          reasons.push(`tool "${tn}": ${call.blocked}`);
          continue;
        }
        Object.assign(t, { kind: "subflow", effect: "write", inputSchema: call.inputSchema });
      } else if (ts.n8n.type === LC + "toolCode") {
        if (/python/i.test(tp.language ?? "")) {
          translate(ts, "python", tp.pythonCode ?? "", "a Python code tool runs only after translation to JavaScript");
          reasons.push(`tool "${tn}" needs translation`);
        }
        let schema = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };
        if (tp.specifyInputSchema) schema = parserSchema({ ...ts, name: tn, params: { schemaType: tp.schemaType, jsonSchemaExample: tp.jsonSchemaExample, inputSchema: tp.inputSchema } }, reasons);
        Object.assign(t, { kind: "code", effect: "none", inputSchema: schema });
      } else if (ts.n8n.type === LC + "toolHttpRequest" || ts.n8n.type === BASE + "httpRequestTool") {
        const built = buildHttpTool(tn, ts, review, addHttp, addSecret, refs);
        Object.assign(t, { kind: "http", effect: built.effect, inputSchema: built.inputSchema });
      } else {
        const why = ts.kind === "blocked" ? ts.blocked.reason : `${shortType(ts.n8n.type)} cannot run in the runtime`;
        if (ts.kind !== "blocked") block(ts, "unsupported", why);
        reasons.push(`tool "${tn}" is left out: ${why}`);
        continue;
      }
      agent.tools.push(t);
    }
    if (p.options?.returnIntermediateSteps) reasons.push("intermediate steps are not returned");
    if (p.promptType === "auto" || p.promptType === undefined) {
      /* chat input */
    }
    step.agent = agent;
    for (const r of reasons) review(step, r);
    for (const i of expressionIssues({ text: agent.prompt, system: agent.system })) translate(step, i.kind, i.original, i.reason);
  }

  // ---------- expressions on every step ----------
  for (const [name, step] of Object.entries(steps)) {
    if (step.kind === "blocked" || step.settings?.disabled) continue;
    const inAgentTool = step.subnode && base.subnodes.some((s) => s.from === name && s.type === "ai_tool");
    const targets = step.kind === "tool" ? { args: step.tool.args } : step.kind === "agent" ? {} : step.model ? { model: step.model } : step.params;
    for (const i of expressionIssues(targets, { allowFromAi: inAgentTool })) translate(step, i.kind, i.original, i.reason);
  }

  // ---------- fields the next steps read that a tool does not supply ----------
  // Downstream expressions use n8n's output field names. When a mapped tool cannot supply
  // one (missingFields), the step that reads it is flagged instead of failing at run time.
  const missingOf = new Map();
  for (const [n, s] of Object.entries(steps)) {
    const miss = s.tool?.missingFields ?? s.poll?.missingFields;
    if (miss?.length) missingOf.set(n, { fields: new Set(miss.map((f) => f.split(".")[0])), what: `${(s.tool ?? s.poll.tool).connector} ${(s.tool ?? s.poll.tool).name}` });
  }
  if (missingOf.size) {
    const REF = /\$\(\s*(['"`])((?:(?!\1).)+)\1\s*\)(?:\.(?:item|first\(\s*\)|last\(\s*\)|all\(\s*\)\[\d+\]|itemMatching\([^)]*\)))?\.json(?:\.([A-Za-z_$][\w$]*)|\[\s*(['"])([^'"]+)\4\s*\])/g;
    const NODE = /\$node\[\s*(['"])((?:(?!\1).)+)\1\s*\]\.json(?:\.([A-Za-z_$][\w$]*)|\[\s*(['"])([^'"]+)\4\s*\])/g;
    const JSONREF = /\$json(?:\.([A-Za-z_$][\w$]*)|\[\s*(['"])([^'"]+)\2\s*\])/g;
    for (const [n, s] of Object.entries(steps)) {
      if (s.kind === "blocked" || s.settings?.disabled) continue;
      const texts = allStrings(s.kind === "tool" ? s.tool.args : s.model ?? s.agent ?? s.params).filter((t) => isExpr(t) || s.kind === "code");
      const parents = base.edges.filter((e) => e.to === n).map((e) => e.from);
      const hits = new Set();
      for (const t of texts) {
        for (const re of [REF, NODE]) {
          re.lastIndex = 0;
          for (let m; (m = re.exec(t)); ) {
            const src = missingOf.get(m[2]);
            const field = m[3] ?? m[5];
            if (src && src.fields.has(field)) hits.add(`reads "${field}" from "${m[2]}", which ${src.what} does not supply`);
          }
        }
        if (parents.length === 1 && missingOf.has(parents[0])) {
          JSONREF.lastIndex = 0;
          for (let m; (m = JSONREF.exec(t)); ) {
            const field = m[1] ?? m[3];
            const src = missingOf.get(parents[0]);
            if (src.fields.has(field)) hits.add(`reads "${field}" from "${parents[0]}", which ${src.what} does not supply`);
          }
        }
      }
      for (const h of hits) review(s, h);
    }
  }

  // ---------- inline secrets (already redacted in the source) ----------
  for (const s of wr.inlineSecrets ?? []) {
    const step = steps[s.node];
    if (!step || step.kind === "blocked") continue;
    translate(step, "inline-secret", s.path, `an inline ${s.kind} key was redacted; store it as a secret and reference it`);
  }

  const settings = { ...base.settings };
  if (!settings.timezone && wr.schedule?.timezoneSource === "answer") settings.timezone = wr.schedule.timezone;
  const def = {
    schemaVersion: 1,
    name: base.name,
    ...(base.id !== undefined ? { id: base.id } : {}),
    converter: { version: CONVERTER_VERSION, toolMaps: String(refs.toolMaps.version ?? "") },
    source: { file, sha256: base.source.sha256, ...(wf.id !== undefined ? { workflowId: String(wf.id) } : {}) },
    settings,
    steps,
    edges: base.edges,
    subnodes: base.subnodes,
    allow,
    secrets: [...secrets.values()],
  };
  for (const b of wr.blockers ?? []) if (b.kind === "dropped-branch") notes.push(`dropped: ${b.reason} (${b.nodes.join(", ")})`);
  for (const s of def.secrets) if (!s.hosts.length) notes.push(`secret "${s.name}" has no known host; name its hosts in overrides.json (preflight refuses it until then)`);
  if (notes.length) def.notes = notes;
  return def;
}

function hintOf(name, step) {
  const m = step.params?.model ?? step.params?.modelName ?? step.params?.modelId;
  const model = isObj(m) ? m.value : m;
  return { provider: shortType(step.n8n.type), ...(model !== undefined && model !== "" ? { model: String(model) } : {}), node: name };
}

function convertModel(name, step, { params, type, v, review, translate, subnodesTo, steps, block }) {
  const p = params;
  const [lm] = subnodesTo(name, "ai_languageModel");
  const hint = lm ? hintOf(lm, steps[lm]) : undefined;
  const reasons = [];
  const parserOf = () => {
    const [ps] = subnodesTo(name, "ai_outputParser");
    return ps ? parserSchema({ ...steps[ps], name: ps }, reasons) : undefined;
  };
  let model;
  if (type === LC + "chainLlm") {
    const msgs = (p.messages?.messageValues ?? []).map((x) => ({ role: { AIMessagePromptTemplate: "assistant", HumanMessagePromptTemplate: "user" }[x.type] ?? "system", kind: x.messageType ?? "text", content: x.message ?? x.imageUrl }));
    if (msgs.some((m) => m.kind !== "text")) reasons.push("image messages are not mapped");
    const system = msgs.filter((m) => m.role === "system").map((m) => m.content);
    const rest = msgs.filter((m) => m.role !== "system").map(({ role, content }) => ({ role, content }));
    const schema = p.hasOutputParser || v < 1.4 ? parserOf() : undefined;
    model = { prompt: promptFor(step), ...(system.length ? { system: system.join("\n") } : {}), ...(rest.length ? { messages: rest } : {}) };
    if (schema) Object.assign(model, { outputSchema: schema, outputKey: "output" });
    else Object.assign(model, { outputKey: "text", trim: true });
  } else if (type === LC + "openAi") {
    const op = `${p.resource ?? "text"}:${p.operation ?? "message"}`;
    if (op === "text:message" || op === "text:response") {
      const list = op === "text:message" ? p.messages?.values ?? [] : p.responses?.values ?? [];
      const system = list.filter((m) => m.role === "system").map((m) => m.content);
      const rest = list.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content ?? "" }));
      if (p.options?.instructions) system.unshift(p.options.instructions);
      model = { ...(system.length ? { system: system.join("\n") } : {}), messages: rest };
      if (p.jsonOutput) model.outputSchema = { type: "object" };
      if (p.simplify === false) reasons.push("the raw OpenAI response (choices, usage) is not rebuilt; only the simplified message is");
      model.outputTemplate = op === "text:message" ? { index: 0, message: { role: "assistant", content: "$output", refusal: null, annotations: [] }, logprobs: null, finish_reason: "stop" } : { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "$output" }] }] };
      if (subnodesTo(name, "ai_tool").length) reasons.push("tools attached to the OpenAI node are not mapped");
    } else if (op === "image:analyze") {
      model = { prompt: p.text ?? "What's in this image?", outputTemplate: { index: 0, message: { role: "assistant", content: "$output" } } };
      translate(step, "node", clone(p), "image analysis needs the image handed to the model, which the model step does not carry yet");
    } else {
      block(step, "unsupported", `OpenAI ${op} is not a text model call`);
      return;
    }
    const mid = p.modelId;
    model.hint = { provider: "openAi", ...(mid !== undefined ? { model: String(isObj(mid) ? mid.value : mid) } : {}) };
  } else if (type === BASE + "openAi") {
    const op = `${p.resource ?? "text"}:${p.operation ?? "complete"}`;
    if (op === "chat:complete") model = { messages: (p.prompt?.messages ?? []).map((m) => ({ role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user", content: m.content ?? "" })) };
    else model = { prompt: p.prompt ?? "" };
    const sys = (model.messages ?? []).filter((m) => m.role === "system").map((m) => m.content);
    if (sys.length) (model.system = sys.join("\n")), (model.messages = model.messages.filter((m) => m.role !== "system"));
    model.outputTemplate = op === "chat:complete" ? { index: 0, message: { role: "assistant", content: "$output" }, finish_reason: "stop" } : { index: 0, text: "$output", finish_reason: "stop" };
    model.hint = { provider: "openAi (legacy node)", ...(p.model ? { model: String(isObj(p.model) ? p.model.value : p.model) } : {}) };
    reasons.push("the legacy OpenAI node's output (choices) is rebuilt from n8n's simplified shape; check the fields the next steps read");
  } else if (type === LC + "informationExtractor") {
    let schema;
    const st = p.schemaType ?? "fromAttributes";
    if (st === "fromAttributes") {
      const attrs = p.attributes?.attributes ?? [];
      schema = { type: "object", properties: Object.fromEntries(attrs.map((a) => [a.name, { type: attrType(a.type), ...(a.description ? { description: a.description } : {}) }])), required: attrs.filter((a) => a.required).map((a) => a.name) };
    } else if (st === "fromJson") schema = parserSchema({ ...step, name, params: { schemaType: "fromJson", jsonSchemaExample: p.jsonSchemaExample } }, reasons);
    else schema = parserSchema({ ...step, name, params: { schemaType: "manual", inputSchema: p.inputSchema } }, reasons);
    model = { prompt: p.text ?? "", system: p.options?.systemPromptTemplate ?? "You are an expert extraction algorithm.\nOnly extract relevant information from the text.\nIf you do not know the value of an attribute asked to extract, you may omit the attribute's value.", outputSchema: schema, outputKey: "output" };
  } else if (type === LC + "textClassifier") {
    const cats = p.categories?.categories ?? [];
    const multi = p.options?.multiClass ?? false;
    const fallback = p.options?.fallback ?? "discard";
    const props = Object.fromEntries(cats.map((c) => [c.category, { type: "boolean", description: `Should be true if the input has category "${c.category}" (description: ${c.description ?? ""})` }]));
    if (fallback === "other") props.fallback = { type: "boolean", description: "Should be true if none of the other categories apply" };
    const tmpl = String(p.options?.systemPromptTemplate ?? "Please classify the text provided by the user into one of the following categories: {categories}, and use the provided formatting instructions below. Don't explain, and only output the json.").replace("{categories}", cats.map((c) => c.category).join(", "));
    model = {
      prompt: p.inputText ?? "",
      system: [tmpl, multi ? "Categories are not mutually exclusive, and multiple can be true" : "Categories are mutually exclusive, and only one can be true", fallback === "other" ? 'If no categories apply, select the "fallback" option.' : "If there is not a very fitting category, select none of the categories."].join("\n"),
      outputSchema: { type: "object", properties: props, required: Object.keys(props) },
      route: { mode: "flags", outputs: [...cats.map((c) => c.category), ...(fallback === "other" ? ["fallback"] : [])] },
    };
    if (p.options?.includeConfidenceScores) reasons.push("confidence scores are not added to the routed items");
  } else if (type === LC + "sentimentAnalysis") {
    const cats = String(p.options?.categories ?? "Positive, Neutral, Negative").split(",").map((c) => c.trim()).filter(Boolean);
    const detailed = !!p.options?.includeDetailedResults;
    const props = { sentiment: { type: "string", enum: cats } };
    if (detailed) Object.assign(props, { strength: { type: "number", description: "Strength score for sentiment in relation to the category" }, confidence: { type: "number", description: "Confidence score for the analysis" } });
    model = {
      prompt: p.inputText ?? "",
      system: String(p.options?.systemPromptTemplate ?? "You are highly intelligent and accurate sentiment analyzer. Analyze the sentiment of the provided text. Categorize it into one of the following: {categories}. Use the provided formatting instructions. Only output the JSON.").replace("{categories}", cats.join(", ")),
      outputSchema: { type: "object", properties: props, required: ["sentiment"] },
      outputTemplate: { sentimentAnalysis: { category: "$output.sentiment", ...(detailed ? { strength: "$output.strength", confidence: "$output.confidence" } : {}) } },
      passInput: true,
      route: { mode: "value", field: "sentiment", outputs: cats },
    };
  } else if (type === LC + "chainSummarization") {
    model = { prompt: '=Write a concise summary of the following:\n\n"{{ JSON.stringify($json) }}"\n\nCONCISE SUMMARY:', outputTemplate: v >= 2 ? { output: { text: "$output" } } : { response: { text: "$output" } } };
    translate(step, "node", clone(p), "the summarisation chain splits long input into chunks (map-reduce) and has its own prompts; the model step summarises in one call with n8n's default prompt");
  } else {
    translate(step, "node", { type, typeVersion: v }, `${shortType(type)} has no model mapping yet`);
    return;
  }
  if (hint && !model.hint) model.hint = hint;
  step.model = model;
  for (const r of reasons) review(step, r);
}

function staticTarget(url) {
  if (typeof url !== "string") return null;
  const lit = url.startsWith("=") ? url : url.replace(/\{\{secret\}\}.*$/, "");
  const t = urlTarget(lit);
  if (!t) return null;
  if (!url.startsWith("=") && url.includes("{{secret}}")) {
    const before = url.slice(0, url.indexOf("{{secret}}"));
    const m = /^https?:\/\/[^/]+(\/.*)?$/.exec(before);
    return { host: t.host, pathPrefix: m?.[1] || "/" };
  }
  return t;
}

function mergeAllow(allow, secrets, sub) {
  for (const t of sub.allow?.tools ?? []) if (!allow.tools.some((x) => x.connector === t.connector && x.tool === t.tool)) allow.tools.push(clone(t));
  for (const h of sub.allow?.http ?? []) if (!allow.http.some((x) => x.method === h.method && x.host === h.host && (x.pathPrefix ?? "") === (h.pathPrefix ?? ""))) allow.http.push(clone(h));
  for (const s of sub.secrets ?? []) {
    const e = secrets.get(s.name) ?? { name: s.name, credentialType: s.credentialType, hosts: [] };
    for (const h of s.hosts ?? []) if (!e.hosts.includes(h)) e.hosts.push(h);
    secrets.set(s.name, e);
  }
}

// A sub-workflow given inline (Execute Workflow "parameter" source): analysed on its own.
function convertDetached(ctx, wf, id, stack) {
  const item = { id, name: wf.name ?? id, wf, file: null };
  const rep = analyze([item], { nodes: ctx.refs.nodes, capabilities: ctx.refs.capabilities, hosts: ctx.refs.hosts, now: ctx.now });
  return buildDefinition(ctx, [item], rep, id, { stack: [...stack, id], file: "inline" });
}

// toolWorkflow: the sub-workflow and the input the model fills.
function buildToolWorkflow(ctx, items, report, wr, tn, ts, stack, rootId, allow, secrets) {
  const tp = ts.params ?? {};
  const source = tp.source ?? "database";
  let target;
  if (source === "parameter") {
    try {
      const subItems = unwrap(JSON.parse(tp.workflowJson), `${rootId}#${tn}`) ?? [];
      if (subItems.length) ts.subflow = { definition: convertDetached(ctx, subItems[0].wf, `${rootId}#${tn}`, stack) };
    } catch {
      return { blocked: "the inline sub-workflow JSON cannot be read" };
    }
  } else {
    const raw = isObj(tp.workflowId) ? tp.workflowId.value : tp.workflowId;
    if (typeof raw === "string" && raw.replace(/[={}\s]/g, "") === "$workflow.id") ts.subflow = { self: true };
    else if (typeof raw === "string" && !isExpr(raw) && raw === rootId) ts.subflow = { self: true };
    else if (typeof raw === "string" && !isExpr(raw)) {
      target = report.workflows.find((w) => w.id === raw) ? raw : undefined;
      if (!target) return { blocked: `the sub-workflow "${raw}" is not in the export` };
      if (stack.includes(target)) return { blocked: "workflows that call each other in a loop are not supported" };
      ts.subflow = { workflowId: target, definition: buildDefinition(ctx, items, report, target, { stack: [...stack, rootId] }) };
      mergeAllow(allow, secrets, ts.subflow.definition);
    } else return { blocked: "the sub-workflow id is set by an expression" };
  }
  // Inputs: v2 workflowInputs (values may hold $fromAI); v1 fields + the model's query.
  let inputSchema = fromAiSchema(tp.workflowInputs?.value ?? {});
  if (isObj(tp.workflowInputs?.value)) ts.subflow.inputs = clone(tp.workflowInputs.value);
  else if (Array.isArray(tp.fields?.values) && tp.fields.values.length) {
    ts.subflow.inputs = Object.fromEntries(tp.fields.values.map((f) => [f.name, f.stringValue ?? f.numberValue ?? f.booleanValue ?? f.objectValue ?? f.arrayValue ?? ""]));
    ts.subflow.inputs.query = "={{ $fromAI('query') }}";
    inputSchema = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };
  }
  if (!inputSchema) {
    inputSchema = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };
    ts.subflow.inputs ??= { query: "={{ $fromAI('query') }}" };
  }
  ts.kind = "subflow";
  return { inputSchema };
}

// toolHttpRequest / httpRequestTool: a request template with {placeholders} or $fromAI.
function buildHttpTool(tn, ts, review, addHttp, addSecret, refs) {
  const tp = ts.params ?? {};
  const method = String(tp.method ?? "GET").toUpperCase();
  const url = tp.url ?? "";
  const http = { method, url };
  const kv = (list) => Object.fromEntries((list ?? []).filter((x) => x?.name).map((x) => [x.name, x.value ?? ""]));
  if (tp.sendQuery) http.query = tp.specifyQuery === "json" ? tp.jsonQuery : kv(tp.parametersQuery?.values ?? tp.queryParameters?.parameters);
  if (tp.sendHeaders) http.headers = tp.specifyHeaders === "json" ? tp.jsonHeaders : kv(tp.parametersHeaders?.values ?? tp.headerParameters?.parameters);
  if (tp.sendBody) http.body = tp.specifyBody === "json" ? tp.jsonBody : kv(tp.parametersBody?.values ?? tp.bodyParameters?.parameters);
  http.result = {};
  ts.http = http;
  ts.kind = "http";
  const props = {};
  for (const d of tp.placeholderDefinitions?.values ?? []) props[d.name] = { type: d.type === "number" ? "number" : d.type === "boolean" ? "boolean" : "string", ...(d.description ? { description: d.description } : {}) };
  for (const m of String(url).matchAll(/\{([A-Za-z_][\w-]*)\}/g)) props[m[1]] ??= { type: "string" };
  const fa = fromAiSchema(tp);
  if (fa) Object.assign(props, fa.properties);
  const inputSchema = { type: "object", properties: props, required: Object.keys(props) };
  const lit = String(url).replace(/\{[A-Za-z_][\w-]*\}.*$/, "");
  const target = lit.startsWith("=") ? urlTarget(lit) : urlTarget(lit.replace(/[^/]*$/, "") || lit);
  if (target) addHttp(method, target.host, target.pathPrefix);
  else {
    addHttp(method, "*", undefined, `agent tool "${tn}": URL built at run time`);
    review(ts, "the tool's URL is built at run time; narrow allow.http to its host in overrides.json");
  }
  const auth = tp.authentication;
  const creds = Object.entries(ts.credentials ?? {});
  if (auth && auth !== "none" && creds.length) {
    const credType = auth === "genericCredentialType" ? tp.genericAuthType : tp.nodeCredentialType ?? creds[0][0];
    const name = ts.credentials[credType] ?? creds[0][1];
    ts.auth = { credentialType: credType, secret: name };
    addSecret(name, credType, target?.host);
    for (const host of refs.toolMaps.credentialHosts?.[credType] ?? []) addSecret(name, credType, host);
  }
  return { inputSchema, effect: method === "GET" ? "read" : "write" };
}

// ---------- overrides ----------

export function emptyOverrides() {
  return { schemaVersion: 1, approve: [], answers: {}, steps: {}, allow: { http: [] }, secrets: {} };
}

function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === null) delete target[k];
    else if (isObj(v) && isObj(target[k])) deepMerge(target[k], v);
    else target[k] = clone(v);
  }
  return target;
}

// overrides.steps[name] = {patch: {...}} merges into the converted step (a translation the
// skill wrote: Python -> JavaScript, an expression, a narrowed URL). The step keeps its
// review flag until a dry run passes; `override: true` records that it was patched.
export function applyOverrides(def, ov) {
  for (const [name, o] of Object.entries(ov?.steps ?? {})) {
    const step = def.steps[name];
    if (!step || !isObj(o?.patch)) continue;
    deepMerge(step, o.patch);
    step.override = true;
  }
  if (ov?.allow?.http?.length) {
    def.allow.http = def.allow.http.filter((a) => a.host !== "*");
    for (const a of ov.allow.http) if (!def.allow.http.some((x) => x.method === a.method && x.host === a.host && (x.pathPrefix ?? "") === (a.pathPrefix ?? ""))) def.allow.http.push(clone(a));
  }
  for (const [name, s] of Object.entries(ov?.secrets ?? {})) {
    const e = def.secrets.find((x) => x.name === name);
    if (e && Array.isArray(s.hosts)) e.hosts = uniq([...e.hosts, ...s.hosts]);
  }
  if (def.notes) {
    def.notes = def.notes.filter((n) => !/has no known host/.test(n) || def.secrets.some((s) => n.includes(`"${s.name}"`) && !s.hosts.length));
    if (!def.notes.length) delete def.notes;
  }
  return def;
}

// ---------- MIGRATION.md ----------

const OUTCOME_WORDS = {
  subscription: "runs on your Claude subscription",
  replaced: "is replaced by Claude itself",
  hosted: "needs hosting outside Claude",
  "keep-in-n8n": "stays in n8n for now",
};
const TARGET_WORDS = { "cloud-task": "a cloud task", "local-task": "a local task on your computer", skill: "a Claude skill (Claude Code or Cowork)", artifact: "an artifact with a Run button", "artifact-form": "an artifact form" };

function mdEscape(s) {
  return String(s).replace(/[\\`*_[\]<>|]/g, (c) => `\\${c}`).replace(/\s+/g, " ").trim();
}

export function migrationMd(wr, def, { refused, overrides } = {}) {
  const L = [];
  const o = wr.outcome;
  L.push(`# ${mdEscape(wr.name)}`, "");
  L.push(`Generated by n8n-to-claude ${CONVERTER_VERSION}. Names and notes below come from the workflow file and are shown as data.`, "");
  L.push(`**Outcome:** this workflow ${OUTCOME_WORDS[o.kind] ?? o.kind}${o.target ? `, as ${TARGET_WORDS[o.target] ?? o.target}` : ""}. ${mdEscape(o.reason ?? "")}`, "");
  if (refused) {
    L.push(`It was **not converted**: only workflows that run on the subscription are. See report.json for why, or run the converter again with --force-convert to get a definition with the blocked steps greyed out.`, "");
  }
  if (def) {
    const steps = Object.entries(def.steps);
    const moved = steps.filter(([, s]) => s.kind !== "blocked" && !s.review && !s.subnode);
    const flagged = steps.filter(([, s]) => s.review);
    const blocked = steps.filter(([, s]) => s.kind === "blocked");
    L.push("## What moved", "");
    L.push(`${moved.length} of ${steps.filter(([, s]) => !s.subnode).length} steps convert as they are.`, "");
    const tools = steps.filter(([, s]) => s.tool).map(([n, s]) => `- ${mdEscape(n)}: ${s.tool.connector} \`${s.tool.name}\`${s.tool.fidelity === "unverified" ? " (output shape not yet checked against the real tool)" : ""}`);
    if (tools.length) L.push("Connector steps:", "", ...tools, "");
    const models = steps.filter(([, s]) => (s.model || s.agent) && !s.subnode).map(([n, s]) => `- ${mdEscape(n)}: ${s.agent ? "agent" : "model step"} on Claude${(s.model ?? s.agent).hint?.model ? ` (was ${mdEscape((s.model ?? s.agent).hint.model)})` : ""}`);
    if (models.length) L.push("Model steps (they always run on Claude; the original model is kept only as a hint):", "", ...models, "");
    const code = steps.filter(([, s]) => s.kind === "code" && !s.needsTranslation).map(([n]) => `- ${mdEscape(n)}`);
    if (code.length) L.push("Code that runs as written (read it before the first run):", "", ...code, "");
    const caveats = steps.flatMap(([n, s]) => (s.tool?.caveats ?? s.http?.caveats ?? s.poll?.caveats ?? []).map((c) => `- ${mdEscape(n)}: ${mdEscape(c)}`));
    if (caveats.length) L.push("Known differences from n8n:", "", ...caveats, "");
    if (flagged.length) {
      L.push("## Flagged for review", "");
      for (const [n, s] of flagged) L.push(`- **${mdEscape(n)}**: ${(s.reviewReasons ?? []).map(mdEscape).join("; ")}${s.needsTranslation ? ` (needs a ${s.needsTranslation.kind} translation${s.override ? "; a translation is in overrides.json" : ""})` : ""}`);
      L.push("");
    }
    if (blocked.length) {
      L.push("## Blocked (greyed out in the graph)", "");
      for (const [n, s] of blocked) L.push(`- **${mdEscape(n)}**: ${mdEscape(s.blocked.reason)}${s.blocked.offer ? `. Offer: ${mdEscape(s.blocked.offer)}` : ""}${s.blocked.alternative ? `. Alternative: ${mdEscape(s.blocked.alternative)}` : ""}`);
      L.push("");
    }
    const subs = steps.filter(([, s]) => s.substitution);
    if (subs.length) {
      L.push("## Substitutions", "");
      for (const [n, s] of subs) L.push(`- ${mdEscape(n)}: ${mdEscape(s.substitution.to)} (${s.substitution.approved ? "approved" : `not approved; to approve: --approve ${s.substitution.id}`})`);
      L.push("");
    }
    L.push("## Allowed targets", "", "The run can only reach these. Anything else is refused.", "");
    for (const t of def.allow.tools) L.push(`- tool ${t.connector} \`${t.tool}\``);
    for (const h of def.allow.http) L.push(`- ${h.method} ${h.host}${h.pathPrefix ?? ""}${h.host === "*" ? " (refused until narrowed in overrides.json)" : ""}`);
    if (!def.allow.tools.length && !def.allow.http.length) L.push("- nothing outside the runner");
    L.push("");
    if (def.secrets.length) {
      L.push("## Secrets", "", "Store each under its n8n credential name. The value is never written to these files.", "");
      for (const s of def.secrets) L.push(`- ${mdEscape(s.name)} (${s.credentialType ?? "credential"}): sent only to ${s.hosts.length ? s.hosts.join(", ") : "no host yet: name it in overrides.json"}`);
      L.push("");
    }
  }
  if (wr.questions?.length) {
    L.push("## Questions", "", "Answer in answers.json (or overrides.json `answers`) and regenerate.", "");
    for (const q of wr.questions) L.push(`- \`${q.id}\`: ${mdEscape(q.text)}${q.answer !== null ? ` Answered: ${mdEscape(JSON.stringify(q.answer))}.` : ` Assumed: ${mdEscape(JSON.stringify(q.assumed))}.`}`);
    L.push("");
  }
  const reqs = wr.requires ?? [];
  if (reqs.length) {
    L.push("## Requirements per surface", "", "| Needs | Cloud task | Local task | Artifact |", "| --- | --- | --- | --- |");
    for (const r of reqs) L.push(`| ${mdEscape(`${r.kind}: ${r.name}`)} | ${["cloudTask", "localTask", "artifact"].map((k) => mdEscape(r.surfaces?.[k] ?? "?")).join(" | ")} |`);
    L.push("");
  }
  if (wr.schedule?.runsPerDay != null) L.push(`Schedule: about ${wr.schedule.runsPerDay} runs a day, in ${wr.schedule.timezone}; fits ${wr.schedule.fits}.`, "");
  if (overrides && (overrides.approve?.length || Object.keys(overrides.answers ?? {}).length || Object.keys(overrides.steps ?? {}).length)) L.push(`overrides.json holds ${overrides.approve?.length ?? 0} approval(s), ${Object.keys(overrides.answers ?? {}).length} answer(s) and ${Object.keys(overrides.steps ?? {}).length} step translation(s); regeneration keeps them.`, "");
  return L.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

// ---------- whole exports ----------

function redactItems(items) {
  return items.map((it) => {
    const r = redactSecrets(it.wf, "");
    return { ...it, wf: r.value, redactedSecrets: r.found };
  });
}

// Converts loaded items. Returns [{id, name, slug, refused, definition?, report, source?}].
export function convertItems(rawItems, opts = {}) {
  const refs = opts.refs ?? loadReferences();
  const ctx = new Ctx(refs, opts);
  const items = redactItems(rawItems);
  const report = analyze(items, { nodes: refs.nodes, capabilities: refs.capabilities, hosts: refs.hosts, answers: opts.answers ?? {}, now: ctx.now });
  const wanted = opts.workflow ? items.filter((it) => it.id === opts.workflow || it.name === opts.workflow) : items;
  if (opts.workflow && !wanted.length) throw new Error(`no workflow with id or name "${opts.workflow}" in the export`);
  const used = new Set(opts.usedSlugs ?? []);
  const out = [];
  for (const it of wanted) {
    const wr = report.workflows.find((w) => w.id === it.id);
    const slug = opts.slug ?? slugify(it.name, it.id, used);
    const callees = calleesOf(report, it.id).map((cid) => items.find((x) => x.id === cid)).filter(Boolean);
    const text = sourceText(it, callees);
    const refused = wr.outcome.kind !== "subscription" && !ctx.force;
    const res = { id: it.id, name: it.name, slug, refused, report: { ...report, summary: undefined, workflows: [wr] }, source: text };
    delete res.report.summary;
    if (!refused) {
      const def = buildDefinition(ctx, items, report, it.id, { text });
      def.source.sha256 = sha256(text);
      if (wr.outcome.kind !== "subscription") (def.notes ??= []).unshift(`converted with --force-convert although the outcome is ${wr.outcome.kind}: ${wr.outcome.reason}`);
      res.definition = def;
    }
    out.push(res);
  }
  return out;
}

function skillCommit() {
  try {
    return execFileSync("git", ["-C", SKILL, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

function writeJson(path, data) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, path);
}

export const RUNTIME_FILES = ["runner-core.mjs", "runner.mjs", "luxon.mjs", "driver.mjs", "hook.mjs"];
export function writeRuntime(dir) {
  const rt = join(dir, "runtime");
  mkdirSync(rt, { recursive: true });
  for (const f of RUNTIME_FILES) copyFileSync(join(SKILL, "runtime", "dist", f), join(rt, f));
  writeFileSync(join(rt, "VERSION"), `skill ${skillCommit()}\nruntime ${RUNTIME_VERSION}\nconverter ${CONVERTER_VERSION}\n`);
}

// ---------- task driver files ----------

// The connector tool name a Claude session shows: <toolPrefix><tool>, from the captured schemas.
export function toolPrefixes(def, refs) {
  const out = {};
  for (const t of def.allow?.tools ?? []) {
    const p = refs.connectors[t.connector]?.toolPrefix;
    if (p) out[t.connector] = p;
  }
  return out;
}
export function taskJson(def, refs) {
  return { hooks: true, compactWhole: true, compactOver: 80, hideToolOutput: true, secrets: "env", toolPrefixes: toolPrefixes(def, refs) };
}
// .claude/settings.json for the task session. Measured in evals/task-driver/MEASUREMENTS.md.
export function taskSettings(def, refs) {
  const prefixes = toolPrefixes(def, refs);
  const tools = (def.allow?.tools ?? []).map((t) => (prefixes[t.connector] ?? `mcp__${t.connector}__`) + t.tool);
  const hook = (which) => [{ matcher: "^mcp__", hooks: [{ type: "command", command: `node "$CLAUDE_PROJECT_DIR/runtime/hook.mjs" ${which}`, timeout: 30 }] }];
  return {
    permissions: { defaultMode: "dontAsk", allow: ["Bash(node runtime/runner.mjs *)", "Edit(.n2c/inbox/**)", ...uniq(tools)], deny: ["WebFetch", "WebSearch"] },
    hooks: { PreToolUse: hook("pre"), PostToolUse: hook("post") },
  };
}
export function writeTaskFiles(dir, def, refs) {
  writeJson(join(dir, "task.json"), taskJson(def, refs));
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeJson(join(dir, ".claude", "settings.json"), taskSettings(def, refs));
  copyFileSync(join(REFS, "task-prompt.md"), join(dir, "task-prompt.md"));
}

// Writes one result folder. overrides.json is created when missing and never rewritten.
export function writeFolder(outDir, res, { overrides, refs } = {}) {
  const dir = join(outDir, res.slug);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, "report.json"), res.report);
  writeFileSync(join(dir, "source.n8n.json"), res.source);
  const ovPath = join(dir, "overrides.json");
  if (!existsSync(ovPath)) writeJson(ovPath, overrides ?? emptyOverrides());
  const ov = readJson(ovPath);
  if (res.definition) {
    const def = applyOverrides(res.definition, ov);
    const errs = validateSchema(def, (refs ?? loadReferences()).schema);
    if (errs.length) throw new Error(`definition for "${res.name}" is not valid against the schema: ${errs.slice(0, 5).join("; ")}`);
    writeJson(join(dir, "definition.json"), def);
    writeRuntime(dir);
    writeTaskFiles(dir, def, refs ?? loadReferences());
  } else {
    for (const f of ["definition.json", "task.json", "task-prompt.md", ".claude/settings.json"]) if (existsSync(join(dir, f))) rmSync(join(dir, f));
  }
  writeFileSync(join(dir, "MIGRATION.md"), migrationMd(res.report.workflows[0], res.definition, { refused: res.refused, overrides: ov }));
  return dir;
}

export function regenerate(folder, opts = {}) {
  const refs = opts.refs ?? loadReferences();
  const ovPath = join(folder, "overrides.json");
  const ov = existsSync(ovPath) ? readJson(ovPath) : emptyOverrides();
  const text = readFileSync(join(folder, "source.n8n.json"), "utf8");
  const items = unwrap(JSON.parse(text), "source") ?? [];
  if (!items.length) throw new Error(`${folder}/source.n8n.json holds no n8n workflow`);
  const prev = existsSync(join(folder, "definition.json")) ? readJson(join(folder, "definition.json")) : null;
  const force = opts.forceConvert ?? (prev ? !!prev.notes?.some((n) => n.startsWith("converted with --force-convert")) : false);
  const [res] = convertItems(items.map((it) => ({ ...it, file: "source.n8n.json" })), { refs, answers: ov.answers ?? {}, approve: ov.approve ?? [], workflow: items[0].id, slug: basename(folder), forceConvert: force, now: opts.now });
  // The stored source is the source of truth: keep its bytes (and hash) as they are.
  res.source = text;
  if (res.definition) res.definition.source.sha256 = sha256(text);
  writeFolder(dirname(resolve(folder)), res, { refs });
  return res;
}

// ---------- CLI ----------

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const n = argv[i + 1];
      if (["force-convert", "json"].includes(k) || n === undefined || n.startsWith("--")) flags[k] = true;
      else (flags[k] = n), i++;
    } else pos.push(a);
  }
  return { pos, flags };
}

const USAGE = "usage: convert.mjs <export|-> --out <dir> [--workflow <id|name>] [--answers answers.json] [--approve id,id] [--force-convert] [--now ISO]\n       convert.mjs --regenerate <folder>";

export function main(argv = process.argv.slice(2)) {
  const { pos, flags } = parseArgs(argv);
  const now = flags.now ? Date.parse(flags.now) : undefined;
  if (flags.regenerate) {
    const res = regenerate(String(flags.regenerate), { now, forceConvert: flags["force-convert"] === true ? true : undefined });
    process.stdout.write(JSON.stringify({ status: res.refused ? "refused" : "regenerated", folder: flags.regenerate, steps: res.definition ? Object.keys(res.definition.steps).length : 0 }) + "\n");
    return 0;
  }
  if (!pos[0] || !flags.out || flags.out === true) {
    process.stderr.write(USAGE + "\n");
    return 2;
  }
  const loaded = loadInput(pos[0]);
  if (loaded.fatal) {
    process.stderr.write(`${loaded.fatal}\n`);
    return 2;
  }
  const answers = flags.answers && flags.answers !== true ? readJson(flags.answers) : {};
  const approve = flags.approve && flags.approve !== true ? String(flags.approve).split(",").map((s) => s.trim()).filter(Boolean) : [];
  const results = convertItems(loaded.items, { answers, approve, workflow: flags.workflow && flags.workflow !== true ? String(flags.workflow) : undefined, forceConvert: flags["force-convert"] === true, now });
  const outDir = resolve(String(flags.out));
  mkdirSync(outDir, { recursive: true });
  const summary = [];
  for (const res of results) {
    const ov = { ...emptyOverrides(), approve, answers: Object.fromEntries(Object.entries(answers).filter(([k]) => k.startsWith(`${res.id}/`))) };
    writeFolder(outDir, res, { overrides: ov });
    const steps = res.definition ? Object.values(res.definition.steps) : [];
    summary.push({ id: res.id, name: res.name, folder: res.slug, status: res.refused ? "refused" : steps.some((s) => s.kind === "blocked") ? "blocked-steps" : steps.some((s) => s.review) ? "review" : "converted", outcome: res.report.workflows[0].outcome.kind, review: steps.filter((s) => s.review).length, blocked: steps.filter((s) => s.kind === "blocked").length });
  }
  process.stdout.write(JSON.stringify({ out: outDir, workflows: summary }, null, 2) + "\n");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main();
  } catch (e) {
    process.stderr.write(`convert: ${e.message}\n`);
    process.exitCode = 1;
  }
}

// Preflight for tests and the skill: the definition against the stored source.
export function checkFolder(folder) {
  const def = readJson(join(folder, "definition.json"));
  return preflight(def, { sourceText: readFileSync(join(folder, "source.n8n.json"), "utf8") });
}
export { httpTarget };
