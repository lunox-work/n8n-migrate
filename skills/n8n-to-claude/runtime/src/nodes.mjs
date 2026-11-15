// Node implementations, group 1: triggers, Set, If, Filter, Switch, Merge, NoOp, Code,
// SplitOut, Aggregate, Limit, SplitInBatches, StopAndError, Wait, Execute Workflow.
//
// Each implementation mirrors the n8n-nodes-base node of the same type (n8n 2.47) and
// says which behaviour it follows. An implementation is
//   { versions(v) -> bool, defaults?(v, params), inputs?(exec), outputs?(exec),
//     requiredInputs?(exec), trigger?, execute(exec, ed) -> [[items], ...] | null }
// `defaults` stands in for the parameter defaults n8n fills from the node description.

import { NodeError, UnsupportedNode, deepCopy, getPath, setPath, unsetPath, isEqual, isObject, hasOwn, RunnerError } from "./util.mjs";
import { compileCode, makeScope } from "./expression.mjs";
import { createLookup } from "./proxy.mjs";
import { executeFilter, validateFieldType } from "./filter.mjs";
import { DateTime } from "../vendor/luxon.mjs";
import { GROUP2, requestImplFor } from "./nodes2.mjs";
import { FILES } from "./files.mjs";

const BASE = "n8n-nodes-base.";
const inRange = (lo, hi) => (v) => v >= lo && v <= hi;
const oneOf = (...vs) => (v) => vs.includes(v);

export function nodeError(exec, message, extra = {}) {
  return new NodeError(message, { node: exec.name, ...extra });
}
const preparePaired = (p) => (p === undefined ? [] : typeof p === "number" ? [{ item: p }] : Array.isArray(p) ? p : [p]);
export const generatePaired = (n) => Array.from({ length: n }, (_, item) => ({ item }));

function triggerItems(ed) {
  return (ed.data?.main?.[0] ?? []).map((it) => ({ json: it.json ?? {}, ...(it.binary ? { binary: it.binary } : {}) }));
}

// ---------- triggers ----------

const manualTrigger = { versions: () => true, trigger: true, execute: (exec, ed) => [triggerItems(ed)] };

// n8n ScheduleTrigger emits one item describing the fire time (moment formats).
function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
export function scheduleItem(ms, tz) {
  const d = DateTime.fromMillis(ms, { zone: tz });
  const ampm = d.toFormat("a").toLowerCase();
  return {
    timestamp: d.toISO(),
    "Readable date": `${d.toFormat("LLLL")} ${ordinal(d.day)} ${d.toFormat("yyyy")}, ${d.toFormat("h:mm:ss")} ${ampm}`,
    "Readable time": `${d.toFormat("h:mm:ss")} ${ampm}`,
    "Day of week": d.toFormat("cccc"),
    Year: d.toFormat("yyyy"),
    Month: d.toFormat("LLLL"),
    "Day of month": d.toFormat("dd"),
    Hour: d.toFormat("HH"),
    Minute: d.toFormat("mm"),
    Second: d.toFormat("ss"),
    Timezone: `${tz} (UTC${d.toFormat("ZZ")})`,
  };
}
const scheduleTrigger = {
  versions: inRange(1, 1.4),
  trigger: true,
  execute(exec, ed) {
    if (ed.triggerProvided) return [triggerItems(ed)];
    return [[{ json: scheduleItem(exec.run.clock.now, exec.run.timezone) }]];
  },
};

// Execute Workflow Trigger: passthrough, or keep only the declared input fields.
const executeWorkflowTrigger = {
  versions: () => true,
  trigger: true,
  execute(exec, ed) {
    const items = triggerItems(ed);
    const source = exec.params.inputSource ?? "passthrough";
    if (exec.typeVersion < 1.1 || source === "passthrough") return [items];
    let names = [];
    if (source === "workflowInputs") names = (exec.params.workflowInputs?.values ?? []).map((v) => v.name);
    else if (source === "jsonExample") {
      try {
        names = Object.keys(JSON.parse(exec.params.jsonExample || "{}"));
      } catch {
        throw nodeError(exec, "The JSON example is not valid JSON");
      }
    }
    const keep = new Set(names);
    return [items.map((it, index) => ({ json: { ...Object.fromEntries(names.map((n) => [n, null])), ...Object.fromEntries(Object.entries(it.json).filter(([k]) => keep.has(k))) }, index, ...(it.binary ? { binary: it.binary } : {}) }))];
  },
};

// Any other trigger (webhook, chat, form, app triggers): emits the trigger input as given.
const genericTrigger = {
  versions: () => true,
  trigger: true,
  execute(exec, ed) {
    if (!ed.triggerProvided) throw nodeError(exec, `Trigger "${exec.name}" (${exec.step.n8n?.type}) needs trigger input items`);
    return [triggerItems(ed)];
  },
};

// ---------- Set ----------

// lodash-style field helpers (n8n Set configureFieldHelper).
function fieldHelper(dotNotation) {
  if (dotNotation !== false) return { set: setPath, get: (o, k) => getPath(o, k), unset: unsetPath };
  const key = (o, k) => {
    if (o[k] !== undefined) return k;
    if ((k.startsWith("['") && k.endsWith("']")) || (k.startsWith('["') && k.endsWith('"]'))) {
      const inner = k.slice(2, -2);
      if (o[inner] !== undefined) return inner;
    }
    return k;
  };
  return { set: (o, k, v) => (o[key(o, k)] = v), get: (o, k) => o[key(o, k)], unset: (o, k) => delete o[key(o, k)] };
}

const typeDescription = (v) => (typeof v === "object" ? (v === null ? "'null'" : Array.isArray(v) ? "array" : "object") : `'${String(v)}'`);
const splitList = (s) => String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

function composeReturnItem(exec, itemIndex, inputItem, newFields, options) {
  const v = exec.typeVersion;
  const out = { json: {}, pairedItem: { item: itemIndex } };
  const includeBinary = (v >= 3.4 && !options.stripBinary && options.include !== "none") || (v < 3.4 && !!options.includeBinary);
  if (includeBinary && inputItem.binary !== undefined) out.binary = { ...inputItem.binary };
  const fh = fieldHelper(options.dotNotation);
  switch (options.include) {
    case "all":
      out.json = deepCopy(inputItem.json);
      break;
    case "selected":
      for (const key of splitList(exec.param("includeFields", itemIndex, ""))) {
        const val = fh.get(inputItem.json, key);
        const target = options.dotNotation !== false && key.includes(".") ? key.split(".").pop() : key;
        fh.set(out.json, target, val);
      }
      break;
    case "except": {
      const copy = deepCopy(inputItem.json);
      for (const key of splitList(exec.param("excludeFields", itemIndex, ""))) fh.unset(copy, key);
      out.json = copy;
      break;
    }
    case "none":
      break;
    default:
      throw nodeError(exec, `The include option "${options.include}" is not known!`);
  }
  for (const key of Object.keys(newFields)) fh.set(out.json, key, newFields[key]);
  return out;
}

// n8n Set v3 validateEntry.
function validateEntry(exec, name, type, value, itemIndex, ignoreErrors) {
  const v = exec.typeVersion;
  if (v >= 3.2 && (value === undefined || value === null)) return { name, value: null };
  if (type === "string") {
    if (v > 3 && (value === undefined || value === null)) {
      if (ignoreErrors) return { name, value: null };
      throw nodeError(exec, `'${name}' expects a ${type} but we got ${typeDescription(value)} [item ${itemIndex}]`);
    } else if (typeof value === "object") value = JSON.stringify(value);
    else value = String(value);
  }
  const r = validateFieldType(value, type);
  if (!r.valid) {
    if (ignoreErrors) return { name, value: value ?? null };
    throw nodeError(exec, `'${name}' expects a ${type} but we got ${typeDescription(value)} [item ${itemIndex}]`, { itemIndex });
  }
  const nv = r.newValue;
  if (v >= 3.5 && nv !== undefined && nv !== null) return { name, value: deepCopy(nv) };
  return { name, value: nv ?? null };
}

// n8n jsonParse(..., {repairJSON: true}) uses the jsonrepair package; this repairs the
// common cases (trailing commas, single quotes, unquoted keys, comments) and otherwise fails.
export function parseJsonLenient(text) {
  try {
    return JSON.parse(text);
  } catch {}
  const repaired = String(text)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'])\/\/[^\n]*/g, "$1")
    .replace(/'((?:[^'\\]|\\.)*)'/g, (_, s) => JSON.stringify(s.replace(/\\'/g, "'")))
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/,\s*([}\]])/g, "$1")
    // jsonrepair (n8n's repairJSON) turns a bare undefined into null, and quotes an
    // unquoted value up to the end of its line.
    .replace(/([:[,]\s*)undefined(?=\s*[,}\]])/g, "$1null")
    .replace(/(:[ \t]*)(?!["{[\-\d]|true\b|false\b|null\b)([^\s,{}[\]][^\n]*?)([ \t]*,?[ \t]*)$/gm, (_, a, v, b) => `${a}${JSON.stringify(v)}${b}`);
  return JSON.parse(repaired);
}

function parseJsonParameter(exec, json, itemIndex, entryName) {
  const where = entryName ? `entry "${entryName}" inside 'Fields to Set'` : "'JSON Output'";
  let data = json;
  if (typeof json === "string") {
    try {
      data = parseJsonLenient(json);
    } catch {
      throw nodeError(exec, `The ${where} in item ${itemIndex} contains invalid JSON`, { description: json });
    }
  }
  if (data === undefined || data === null || typeof data !== "object" || Array.isArray(data)) throw nodeError(exec, `The ${where} in item ${itemIndex} does not contain a valid JSON object`);
  return data;
}

// n8n Set resolveRawData: each {{ }} in the raw JSON text is evaluated and spliced in.
function resolveRawData(exec, raw, itemIndex) {
  let out = raw;
  for (const m of raw.match(/{{[\s\S]*?}}/g) ?? []) {
    const v = exec.evaluate("=" + m, itemIndex);
    out = out.replace(m, () => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)));
  }
  return out;
}

const setV1 = {
  versions: inRange(1, 2),
  defaults: () => ({ keepOnlySet: false, values: {}, options: {} }),
  execute(exec) {
    const items = exec.getInputData();
    const out = [];
    items.forEach((item, i) => {
      const keepOnlySet = exec.param("keepOnlySet", i, false);
      const options = exec.param("options", i, {});
      const n = { json: {}, pairedItem: { item: i } };
      if (!keepOnlySet) {
        if (item.binary !== undefined) n.binary = { ...item.binary };
        n.json = deepCopy(item.json);
      }
      const put = (name, value) => (options.dotNotation === false ? (n.json[name] = value) : setPath(n.json, name, value));
      // The value default (false / 0 / "") applies only when the entry has no value; an
      // expression that evaluates to undefined is set as undefined (the key then drops out).
      const raw = (type) => exec.params.values?.[type] ?? [];
      const valueOf = (type, e, j, dflt) => (raw(type)[j] && hasOwn(raw(type)[j], "value") ? e.value : dflt);
      exec.param("values.boolean", i, []).forEach((e, j) => put(e.name ?? "propertyName", !!valueOf("boolean", e, j, false)));
      exec.param("values.number", i, []).forEach((e, j) => {
        let value = valueOf("number", e, j, 0);
        if (exec.typeVersion >= 2 && typeof value === "string" && !Number.isNaN(Number(value))) value = Number(value);
        put(e.name ?? "propertyName", value);
      });
      exec.param("values.string", i, []).forEach((e, j) => put(e.name ?? "propertyName", valueOf("string", e, j, "")));
      out.push(n);
    });
    return [out];
  },
};

const setV3 = {
  versions: inRange(3, 3.5),
  defaults: (v) => ({ mode: "manual", duplicateItem: false, include: "all", includeOtherFields: false, options: {}, ...(v < 3.3 ? { fields: {} } : { assignments: {} }), jsonOutput: '{\n  "my_field_1": "value",\n  "my_field_2": 1\n}\n' }),
  execute(exec) {
    const items = exec.getInputData();
    const v = exec.typeVersion;
    const mode = exec.param("mode", 0);
    const rawData = {};
    if (mode === "raw") {
      const jo = exec.param("jsonOutput", 0, "", { rawExpressions: true });
      if (typeof jo === "string" && jo.startsWith("=")) rawData.jsonOutput = jo.replace(/^=+/, "");
    } else if (v < 3.3) {
      for (const e of exec.param("fields.values", 0, [], { rawExpressions: true })) {
        if (e.type === "objectValue" && typeof e.objectValue === "string" && e.objectValue.startsWith("=")) rawData[e.name] = e.objectValue.replace(/^=+/, "");
      }
    }
    const out = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const includeOther = exec.param("includeOtherFields", i, false);
        const include = exec.param("include", i, "all");
        const options = { ...exec.param("options", i, {}) };
        options.include = v >= 3.3 ? (includeOther ? include : "none") : include;
        let newItem;
        if (mode === "raw") {
          const data =
            rawData.jsonOutput === undefined ? parseJsonParameter(exec, exec.param("jsonOutput", i), i) : parseJsonParameter(exec, resolveRawData(exec, rawData.jsonOutput, i), i);
          newItem = composeReturnItem(exec, i, items[i], data, options);
        } else if (v < 3.3) {
          const fields = exec.param("fields.values", i, []);
          const data = {};
          for (const entry of fields) {
            const type = entry.type ?? "stringValue";
            if (type === "objectValue" && rawData[entry.name] !== undefined && entry.objectValue !== undefined && entry.objectValue !== null) {
              entry.objectValue = parseJsonParameter(exec, resolveRawData(exec, rawData[entry.name], i), i, entry.name);
            }
            const { name, value } = validateEntry(exec, entry.name, type.replace("Value", ""), entry[type], i, options.ignoreConversionErrors);
            data[name] = value;
          }
          newItem = composeReturnItem(exec, i, items[i], data, options);
        } else {
          const collection = exec.param("assignments", i);
          const data = {};
          for (const a of collection?.assignments ?? []) {
            if (a.type === "binary") throw new UnsupportedNode("Set: binary assignments are not supported by the runtime", { node: exec.name });
            const { name, value } = validateEntry(exec, a.name, a.type ?? "string", a.value, i, options.ignoreConversionErrors);
            data[name] = value;
          }
          newItem = composeReturnItem(exec, i, items[i], data, options);
        }
        const dup = exec.param("duplicateItem", 0, false);
        if (dup && exec.run.mode === "manual") {
          const count = exec.param("duplicateCount", 0, 0);
          for (let j = 0; j <= count; j++) out.push(newItem);
        } else out.push(newItem);
      } catch (e) {
        if (e instanceof UnsupportedNode) throw e;
        if (exec.continueOnFail()) {
          out.push({ json: { error: e.message }, pairedItem: { item: i } });
          continue;
        }
        throw e;
      }
    }
    return [out];
  },
};

// ---------- legacy comparisons (If v1, Filter v1, Switch v1/v2) ----------

function matchesRegex(a, b) {
  const lit = String(b || "");
  const m = /^\/(.*?)\/([gimusy]*)$/.exec(lit);
  const [source, flags] = m ? [m[1], m[2].replace("g", "")] : [lit, ""];
  return new RegExp(source, flags).test(String(a || ""));
}
const isDateObject = (v) => Object.prototype.toString.call(v) === "[object Date]";
const legacyEmpty = (v) => [undefined, null, ""].includes(v) || Number.isNaN(v) || (typeof v === "object" && v !== null && !isDateObject(v) ? Object.entries(v).length === 0 : false) || (isDateObject(v) && v.toString() === "Invalid Date");
// Parameter names as in n8n's IfV1/FilterV1, so a TypeError reads the same ("value1.startsWith is not a function").
const LEGACY_OPS = {
  after: (value1, value2) => (value1 || 0) > (value2 || 0),
  before: (value1, value2) => (value1 || 0) < (value2 || 0),
  contains: (value1, value2) => (value1 || "").toString().includes((value2 || "").toString()),
  notContains: (value1, value2) => !(value1 || "").toString().includes((value2 || "").toString()),
  endsWith: (value1, value2) => value1.endsWith(value2),
  notEndsWith: (value1, value2) => !value1.endsWith(value2),
  equal: (value1, value2) => value1 === value2,
  notEqual: (value1, value2) => value1 !== value2,
  larger: (value1, value2) => (value1 || 0) > (value2 || 0),
  largerEqual: (value1, value2) => (value1 || 0) >= (value2 || 0),
  smaller: (value1, value2) => (value1 || 0) < (value2 || 0),
  smallerEqual: (value1, value2) => (value1 || 0) <= (value2 || 0),
  startsWith: (value1, value2) => value1.startsWith(value2),
  notStartsWith: (value1, value2) => !value1.startsWith(value2),
  isEmpty: (value1) => legacyEmpty(value1),
  isNotEmpty: (value1) => !legacyEmpty(value1),
  regex: matchesRegex,
  notRegex: (value1, value2) => !matchesRegex(value1, value2),
};
const LEGACY_DEFAULT_OP = { boolean: "equal", dateTime: "after", number: "smaller", string: "equal" };
const LEGACY_DEFAULT_VALUE = { boolean: false, dateTime: "", number: 0, string: "" };
function legacyDate(exec, v) {
  let r;
  if (typeof v === "string") r = new Date(v).getTime();
  else if (typeof v === "number") r = v;
  if (v instanceof Date) r = v.getTime();
  if (DateTime.isDateTime(v)) r = v.toMillis();
  if (r === undefined || Number.isNaN(r)) throw nodeError(exec, `The value "${v}" is not a valid DateTime.`);
  return r;
}
function legacyCompare(exec, dataType, op, a, b) {
  const fn = LEGACY_OPS[op];
  if (!fn) throw nodeError(exec, `Unknown comparison operation "${op}"`);
  return fn(a, b);
}

const ifV1 = {
  versions: oneOf(1),
  outputs: () => 2,
  defaults: () => ({ conditions: {}, combineOperation: "all" }),
  execute(exec) {
    const t = [];
    const f = [];
    exec.getInputData().forEach((item, i) => {
      const combine = exec.param("combineOperation", i);
      for (const dt of ["boolean", "dateTime", "number", "string"]) {
        for (const c of exec.param(`conditions.${dt}`, i, [])) {
          let a = c.value1 ?? LEGACY_DEFAULT_VALUE[dt];
          let b = c.value2 ?? LEGACY_DEFAULT_VALUE[dt];
          if (dt === "dateTime") [a, b] = [legacyDate(exec, a), legacyDate(exec, b)];
          const r = legacyCompare(exec, dt, c.operation ?? LEGACY_DEFAULT_OP[dt], a, b);
          if (r && combine === "any") return void t.push(item);
          if (!r && combine === "all") return void f.push(item);
        }
      }
      (combine === "all" ? t : f).push(item);
    });
    return [t, f];
  },
};

const filterV1 = {
  versions: oneOf(1),
  outputs: () => 2,
  defaults: () => ({ conditions: {}, combineConditions: "AND" }),
  execute(exec) {
    const kept = [];
    const dropped = [];
    exec.getInputData().forEach((item, i) => {
      const combine = exec.param("combineConditions", i);
      for (const dt of ["boolean", "dateTime", "number", "string"]) {
        for (const c of exec.param(`conditions.${dt}`, i, [])) {
          let a = c.value1 ?? LEGACY_DEFAULT_VALUE[dt];
          let b = c.value2 ?? LEGACY_DEFAULT_VALUE[dt];
          if (dt === "dateTime") [a, b] = [legacyDate(exec, a), legacyDate(exec, b)];
          const r = legacyCompare(exec, dt, c.operation ?? LEGACY_DEFAULT_OP[dt], a, b);
          if (item.pairedItem === undefined) item.pairedItem = [{ item: i }];
          if (r && combine === "OR") return void kept.push(item);
          if (!r && combine === "AND") return void dropped.push(item);
        }
      }
      (combine === "AND" ? kept : dropped).push(item);
    });
    return [kept, dropped];
  },
};

// ---------- If v2, Filter v2 (filter parameter) ----------

function filterNode(exec) {
  const pass = [];
  const fail = [];
  exec.getInputData().forEach((item, i) => {
    try {
      exec.param("options", i, {});
      const ok = executeFilter(exec.param("conditions", i, {}), { itemIndex: i });
      if (item.pairedItem === undefined) item.pairedItem = { item: i };
      (ok ? pass : fail).push(item);
    } catch (e) {
      if (exec.continueOnFail()) return void fail.push(item);
      throw e instanceof NodeError ? e : nodeError(exec, e.message, { itemIndex: i });
    }
  });
  return [pass, fail];
}
const ifV2 = { versions: inRange(2, 2.4), outputs: () => 2, defaults: () => ({ conditions: {}, options: {}, looseTypeValidation: false }), execute: filterNode };
const filterV2 = { versions: inRange(2, 2.4), outputs: () => 2, defaults: () => ({ conditions: {}, options: {}, looseTypeValidation: false }), execute: filterNode };

// ---------- Switch ----------

const switchV1V2 = {
  versions: oneOf(1, 2),
  outputs: (exec) => (exec.typeVersion === 1 ? 4 : exec.params.mode === "expression" ? Number(exec.params.outputsAmount ?? 4) : (exec.params.rules?.rules ?? []).length),
  defaults: (v) => ({ mode: "rules", dataType: "number", rules: {}, fallbackOutput: v === 1 ? -1 : -1, outputsAmount: 4, output: 0 }),
  execute(exec) {
    const v = exec.typeVersion;
    const items = exec.getInputData();
    let out = v === 1 ? [[], [], [], []] : [];
    const check = (idx) => {
      const len = out.length;
      if (idx < 0 || idx >= len) throw nodeError(exec, `The ouput ${idx} is not allowed. It has to be between 0 and ${len - 1}!`);
    };
    itemLoop: for (let i = 0; i < items.length; i++) {
      try {
        const item = items[i];
        const mode = exec.param("mode", i);
        if (v === 2) item.pairedItem = { item: i };
        if (mode === "expression") {
          if (v === 2 && i === 0) out = new Array(exec.param("outputsAmount", i)).fill(0).map(() => []);
          const oi = exec.param("output", i);
          check(oi);
          out[oi].push(item);
        } else {
          const rules = exec.param("rules.rules", i, []);
          if (v === 2 && i === 0) out = new Array(rules.length).fill(0).map(() => []);
          const dt = exec.param("dataType", 0);
          let a = exec.param("value1", i, LEGACY_DEFAULT_VALUE[dt]);
          if (dt === "dateTime") a = legacyDate(exec, a);
          for (const [ri, rule] of rules.entries()) {
            let b = rule.value2 ?? LEGACY_DEFAULT_VALUE[dt];
            if (dt === "dateTime") b = legacyDate(exec, b);
            if (legacyCompare(exec, dt, rule.operation ?? (v === 1 ? "equal" : LEGACY_DEFAULT_OP[dt]), a, b)) {
              check(rule.output ?? 0);
              out[v === 1 ? rule.output ?? 0 : ri].push(item);
              continue itemLoop;
            }
          }
          const fb = exec.param("fallbackOutput", i, -1);
          if (fb !== -1) {
            check(fb);
            out[fb].push(item);
          }
        }
      } catch (e) {
        if (exec.continueOnFail()) {
          (out[0] ??= []).push({ json: { error: e.message } });
          continue;
        }
        throw e;
      }
    }
    return out;
  },
};

const switchV3 = {
  versions: inRange(3, 3.5),
  outputs(exec) {
    const p = exec.params;
    if (p.mode === "expression") return Number(p.numberOutputs ?? 4);
    const n = (p.rules?.values ?? []).length;
    return p.options?.fallbackOutput === "extra" ? n + 1 : n;
  },
  defaults: () => ({ mode: "rules", numberOutputs: 4, rules: { values: [{ conditions: { options: { caseSensitive: true, leftValue: "", typeValidation: "strict" }, conditions: [{ leftValue: "", rightValue: "", operator: { type: "string", operation: "equals" } }], combinator: "and" } }] }, looseTypeValidation: false, options: {} }),
  execute(exec) {
    const items = exec.getInputData();
    const mode = exec.param("mode", 0);
    let out = [];
    const check = (len, idx, i) => {
      if (Number(idx) === len) throw nodeError(exec, `The ouput ${idx} is not allowed. `, { itemIndex: i, description: `Output indexes are zero based, if you want to use the extra output use ${idx - 1}` });
      if (idx < 0 || idx > len) throw nodeError(exec, `The ouput ${idx} is not allowed`, { itemIndex: i, description: `It has to be between 0 and ${len - 1}` });
    };
    itemLoop: for (let i = 0; i < items.length; i++) {
      try {
        const item = items[i];
        item.pairedItem = { item: i };
        if (mode === "expression") {
          const n = exec.param("numberOutputs", i);
          if (i === 0) out = new Array(n).fill(0).map(() => []);
          const oi = exec.param("output", i);
          if (typeof oi !== "number" && !(typeof oi === "string" && oi.trim() !== "" && !Number.isNaN(Number(oi)))) {
            throw nodeError(exec, `The value '${oi}' of parameter 'output' is not a number`, { itemIndex: i });
          }
          check(out.length, Number(oi), i);
          out[Number(oi)].push(item);
        } else {
          const rules = exec.param("rules.values", i, []);
          if (!rules.length) continue;
          const options = exec.param("options", i, {});
          const fallback = options.fallbackOutput;
          if (i === 0) {
            out = new Array(rules.length).fill(0).map(() => []);
            if (fallback === "extra") out.push([]);
          }
          let matched = false;
          for (const [ri, rule] of rules.entries()) {
            if (executeFilter(rule.conditions ?? {}, { itemIndex: i })) {
              matched = true;
              check(out.length, rule.output, i);
              out[ri].push(item);
              if (!options.allMatchingOutputs) continue itemLoop;
            }
          }
          if (fallback !== undefined && fallback !== "none" && !matched) {
            if (fallback === "extra") {
              out[out.length - 1].push(item);
              continue;
            }
            check(out.length, fallback, i);
            out[fallback].push(item);
          }
        }
      } catch (e) {
        if (exec.continueOnFail()) {
          (out[0] ??= []).push({ json: { error: e.message } });
          continue;
        }
        throw e instanceof NodeError ? e : nodeError(exec, e.message, { itemIndex: i });
      }
    }
    if (!out.length) return [[]];
    return out;
  },
};

// ---------- Merge (v2, v3) ----------

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !DateTime.isDateTime(v);
// lodash merge: deep-merges plain objects and arrays (by index); undefined in a source
// does not overwrite an existing value.
function lodashMergeInto(target, src, customizer) {
  if (src == null) return target;
  for (const k of Object.keys(src)) {
    const sv = src[k];
    const tv = target[k];
    if (customizer) {
      const c = customizer(tv, sv);
      if (c !== undefined) {
        target[k] = c;
        continue;
      }
    }
    if ((isPlain(sv) || Array.isArray(sv)) && sv !== tv) {
      const base = Array.isArray(sv) ? (Array.isArray(tv) ? tv : isPlain(tv) ? Object.assign([], tv) : []) : isPlain(tv) || Array.isArray(tv) ? tv : {};
      target[k] = lodashMergeInto(base === tv ? (Array.isArray(tv) ? [...tv] : { ...tv }) : base, sv);
    } else if (sv !== undefined || !(k in target)) {
      target[k] = sv;
    }
  }
  return target;
}
const lodashMerge = (target, ...sources) => sources.reduce((t, s) => lodashMergeInto(t, s), target);
function selectMergeMethod(clash) {
  const mode = clash.mergeMode;
  if (clash.overrideEmpty) {
    const custom = (t, s) => (s === undefined || s === null || s === "" ? t : undefined);
    if (mode === "shallowMerge") return (t, ...srcs) => srcs.reduce((acc, s) => { for (const [k, v] of Object.entries(s ?? {})) { const c = custom(acc[k], v); acc[k] = c !== undefined ? c : v; } return acc; }, { ...t });
    return (t, ...srcs) => srcs.reduce((acc, s) => lodashMergeInto(acc, s, custom), { ...t });
  }
  if (mode === "shallowMerge") return (t, ...srcs) => Object.assign({}, t, ...srcs);
  return (t, ...srcs) => lodashMerge({}, t, ...srcs);
}
const addSuffix = (data, suffix) => data.map((e) => ({ ...e, json: Object.fromEntries(Object.keys(e.json).map((k) => [`${k}_${suffix}`, e.json[k]])) }));
function fuzzyCompare(use, version = 1) {
  if (!use) return (a, b) => isEqual(a, b);
  const isFalsy = (v) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
  const isNull = (v) => v === null || v === undefined;
  return (a, b) => {
    if (!isNull(a) && !isNull(b) && typeof a === typeof b) return isEqual(a, b);
    if (version >= 2) {
      if (isNull(a) && (isNull(b) || b === 0 || b === "0")) return true;
      if (isNull(b) && (isNull(a) || a === 0 || a === "0")) return true;
    }
    if (isFalsy(a) && isFalsy(b)) return true;
    if (isFalsy(a) && b === undefined) return true;
    if (a === undefined && isFalsy(b)) return true;
    if (typeof a === "number" && typeof b === "string") return a.toString() === b;
    if (typeof a === "string" && typeof b === "number") return a === b.toString();
    const cmpParsed = (s, o) => {
      try {
        return isEqual(JSON.parse(s), o);
      } catch {
        return false;
      }
    };
    if (!isNull(a) && typeof a === "object" && typeof b === "string") return cmpParsed(b, a);
    if (!isNull(b) && typeof a === "string" && typeof b === "object") return cmpParsed(a, b);
    if (typeof a === "boolean" && typeof b === "string") return (a === true && b.toLocaleLowerCase() === "true") || (a === false && b.toLocaleLowerCase() === "false");
    if (typeof b === "boolean" && typeof a === "string") return (b === true && a.toLocaleLowerCase() === "true") || (b === false && a.toLocaleLowerCase() === "false");
    if (typeof a === "boolean" && typeof b === "number") return (a === true && b === 1) || (a === false && b === 0);
    if (typeof b === "boolean" && typeof a === "number") return (b === true && a === 1) || (b === false && a === 0);
    if (typeof a === "boolean" && typeof b === "string") return (a === true && b === "1") || (a === false && b === "0");
    if (typeof b === "boolean" && typeof a === "string") return (b === true && a === "1") || (b === false && a === "0");
    return isEqual(a, b);
  };
}
function findMatches(input1, input2, fields, options) {
  const eq = fuzzyCompare(options.fuzzyCompare, options.compareVersion);
  const noDot = options.disableDotNotation || false;
  const all = (options.multipleMatches || "all") === "all";
  const read = (e, k) => (noDot ? e.json[k] : getPath(e.json, k));
  const out = { matched: [], matched2: [], unmatched1: [], unmatched2: [] };
  const seen2 = new Set();
  outer: for (const e1 of input1) {
    const lookup = {};
    for (const f of fields) lookup[f.field2] = noDot ? e1.json[f.field1] : getPath(e1.json, f.field1);
    for (const v of Object.values(lookup)) if (v === undefined) { out.unmatched1.push(e1); continue outer; }
    const found = [];
    for (let i = 0; i < input2.length; i++) {
      const e2 = input2[i];
      if (e2 === undefined) continue;
      if (Object.keys(lookup).every((k) => eq(lookup[k], read(e2, k)))) {
        found.push({ entry: e2, index: i });
        if (!all) break;
      }
    }
    found.forEach((m) => seen2.add(m.index));
    const matches = found.map((m) => m.entry);
    if (matches.length) {
      if (options.outputDataFrom === "both" || options.joinMode === "enrichInput1" || options.joinMode === "enrichInput2") matches.forEach((m) => out.matched.push({ entry: e1, matches: [m] }));
      else out.matched.push({ entry: e1, matches });
    } else out.unmatched1.push(e1);
  }
  input2.forEach((e, i) => (seen2.has(i) ? out.matched2 : out.unmatched2).push(e));
  return out;
}
function mergeMatched(matched, clash, joinMode) {
  let resolve = clash.resolveClash;
  const merge = selectMergeMethod(clash);
  return matched.map(({ entry, matches }) => {
    let json, binary, pairedItem;
    if (resolve === "addSuffix") {
      [entry] = addSuffix([entry], "1");
      matches = addSuffix(matches, "2");
      json = merge({ ...entry.json }, ...matches.map((m) => m.json));
      binary = merge({ ...entry.binary }, ...matches.map((m) => m.binary));
      pairedItem = [...preparePaired(entry.pairedItem), ...matches.flatMap((m) => preparePaired(m.pairedItem))];
    } else {
      if (resolve === undefined) resolve = joinMode !== "enrichInput2" ? "preferLast" : "preferInput1";
      if (resolve === "preferInput1") {
        const [first, ...rest] = matches;
        json = merge({ ...first.json }, ...rest.map((m) => m.json), entry.json);
        binary = merge({ ...first.binary }, ...rest.map((m) => m.binary), entry.binary);
        pairedItem = [...preparePaired(first.pairedItem), ...rest.flatMap((m) => preparePaired(m.pairedItem)), ...preparePaired(entry.pairedItem)];
      } else {
        json = merge({ ...entry.json }, ...matches.map((m) => m.json));
        binary = merge({ ...entry.binary }, ...matches.map((m) => m.binary));
        pairedItem = [...preparePaired(entry.pairedItem), ...matches.flatMap((m) => preparePaired(m.pairedItem))];
      }
    }
    return { json, binary, pairedItem };
  });
}
function checkMatchFields(exec, data) {
  if (data.length === 1 && data[0].field1 === "" && data[0].field2 === "") throw nodeError(exec, 'You need to define at least one pair of fields in "Fields to Match" to match on');
  data.forEach((p, i) => {
    if (p.field1 === "" || p.field2 === "") throw nodeError(exec, `You need to define both fields in "Fields to Match" for pair ${i + 1},\n\t\t\t\t field 1 = '${p.field1}'\n\t\t\t\t field 2 = '${p.field2}'`);
  });
  return data;
}
function checkInput(exec, input, fields, noDot, label) {
  for (const f of fields) {
    const present = (input || []).some((e) => (noDot ? hasOwn(e.json, f) : getPath(e.json, f) !== undefined));
    if (!present) throw nodeError(exec, `Field '${f}' is not present in any of items in '${label}'`);
  }
  return input;
}
function combineByFields(exec, input1, input2, matchFields) {
  const v = exec.typeVersion;
  const joinMode = exec.param("joinMode", 0);
  const outputDataFrom = exec.param("outputDataFrom", 0, "both");
  const options = { ...exec.param("options", 0, {}), joinMode, outputDataFrom };
  if (v >= 3.1) options.compareVersion = 2;
  if (v < 2.1) {
    input1 = checkInput(exec, input1, matchFields.map((p) => p.field1), options.disableDotNotation || false, "Input 1");
    input2 = checkInput(exec, input2, matchFields.map((p) => p.field2), options.disableDotNotation || false, "Input 2");
  }
  if (input1.length === 0 || input2.length === 0) {
    if (!input1.length && joinMode === "keepNonMatches" && outputDataFrom === "input1") return [[]];
    if (!input2.length && joinMode === "keepNonMatches" && outputDataFrom === "input2") return [[]];
    if (joinMode === "keepMatches") return v >= 3 ? [] : [[]];
    if (joinMode === "enrichInput1" && input1.length === 0) return v >= 3 ? [] : [[]];
    if (joinMode === "enrichInput2" && input2.length === 0) return v >= 3 ? [] : [[]];
    return [[...input1, ...input2]];
  }
  if (!matchFields.length) return joinMode === "keepMatches" || joinMode === "keepEverything" || joinMode === "enrichInput2" ? [[]] : [input1];
  const m = findMatches(input1, input2, matchFields, options);
  const clash = exec.param("options.clashHandling.values", 0, {});
  let out = [];
  if (joinMode === "keepMatches" || joinMode === "keepEverything") {
    let o = outputDataFrom === "input1" ? m.matched.map((x) => x.entry) : outputDataFrom === "input2" ? m.matched2 : mergeMatched(m.matched, clash);
    if (joinMode === "keepEverything") {
      const [u1, u2] = clash.resolveClash === "addSuffix" ? [addSuffix(m.unmatched1, "1"), addSuffix(m.unmatched2, "2")] : [m.unmatched1, m.unmatched2];
      o = [...o, ...u1, ...u2];
    }
    out = out.concat(o);
  }
  if (joinMode === "keepNonMatches") {
    if (outputDataFrom === "input1") return [m.unmatched1];
    if (outputDataFrom === "input2") return [m.unmatched2];
    const src = (data, s) => data.map((e) => ({ ...e, json: { ...e.json, _source: s } }));
    return [[...src(m.unmatched1, "input1"), ...src(m.unmatched2, "input2")]];
  }
  if (joinMode === "enrichInput1" || joinMode === "enrichInput2") {
    const merged = mergeMatched(m.matched, clash, joinMode);
    const rest = joinMode === "enrichInput1" ? m.unmatched1 : m.unmatched2;
    out = out.concat(merged, clash.resolveClash === "addSuffix" ? addSuffix(rest, joinMode === "enrichInput1" ? "1" : "2") : rest);
  }
  return [out];
}
function combineAllPairs(exec, inputs) {
  const clash = exec.param("options.clashHandling.values", 0, {});
  let [a, b] = inputs;
  if (clash.resolveClash === "preferInput1") [a, b] = [b, a];
  if (clash.resolveClash === "addSuffix") [a, b] = [addSuffix(a, "1"), addSuffix(b, "2")];
  const merge = selectMergeMethod(clash);
  const out = [];
  if (!a || !b) return [out];
  for (const e1 of a) for (const e2 of b) out.push({ json: { ...merge(e1.json, e2.json) }, binary: { ...lodashMerge({}, e1.binary, e2.binary) }, pairedItem: [e1.pairedItem, e2.pairedItem] });
  return [out];
}

const merge = {
  versions: (v) => inRange(2, 2.1)(v) || inRange(3, 3.2)(v),
  inputs: (exec) => (exec.typeVersion >= 3 ? Number(exec.params.numberInputs ?? 2) : 2),
  requiredInputs: (exec) => (exec.params.mode === "chooseBranch" ? [0, 1] : 1),
  defaults: (v) =>
    v >= 3
      ? { mode: "append", combineBy: "combineByFields", numberInputs: 2, advanced: false, fieldsToMatchString: "", mergeByFields: { values: [{ field1: "", field2: "" }] }, joinMode: "keepMatches", outputDataFrom: "both", chooseBranchMode: "waitForAll", output: "specifiedInput", useDataOfInput: 1, options: {} }
      : { mode: "append", combinationMode: "mergeByFields", mergeByFields: { values: [{ field1: "", field2: "" }] }, joinMode: "keepMatches", outputDataFrom: "both", chooseBranchMode: "waitForBoth", output: "input1", options: {} },
  execute(exec) {
    const v = exec.typeVersion;
    const n = this.inputs(exec);
    const inputs = Array.from({ length: n }, (_, i) => exec.getInputData(i) ?? []);
    let mode = exec.param("mode", 0);
    if (v >= 3) {
      if (mode === "combine") mode = exec.param("combineBy", 0);
      if (mode === "append") return [inputs.flat()];
      if (mode === "combineAll") return combineAllPairs(exec, inputs);
      if (mode === "combineBySql") throw new UnsupportedNode("Merge: SQL query mode is not supported by the runtime", { node: exec.name });
      if (mode === "combineByPosition") {
        const clash = exec.param("options.clashHandling.values", 0, {});
        const includeUnpaired = exec.param("options.includeUnpaired", 0, false);
        const pref = clash?.resolveClash?.includes("preferInput") ? Number(clash.resolveClash.replace("preferInput", "")) - 1 : inputs.length - 1;
        const preferred = inputs[pref];
        let data = inputs;
        if (clash.resolveClash === "addSuffix") data = inputs.map((inp, i) => addSuffix(inp, String(i + 1)));
        const count = includeUnpaired ? Math.max(...data.map((x) => x.length), preferred.length) : Math.min(...data.map((x) => x.length), preferred.length);
        if (!includeUnpaired && count === 0) return [[]];
        const mergeFn = selectMergeMethod(clash);
        const out = [];
        for (let i = 0; i < count; i++) {
          const pe = preferred[i] ?? {};
          const rest = data.map((inp) => inp[i] ?? {});
          out.push({
            json: { ...mergeFn({}, ...rest.map((e) => e.json ?? {}), pe.json ?? {}) },
            binary: { ...lodashMerge({}, ...rest.map((e) => e.binary ?? {}), pe.binary ?? {}) },
            pairedItem: [...rest.map((e) => e.pairedItem).flat(), pe.pairedItem].filter((x) => x !== undefined),
          });
        }
        return [out];
      }
      if (mode === "combineByFields") {
        const advanced = exec.param("advanced", 0);
        const fields = advanced
          ? exec.param("mergeByFields.values", 0, [])
          : String(exec.param("fieldsToMatchString", 0, "")).split(",").map((f) => ({ field1: f.trim(), field2: f.trim() }));
        return combineByFields(exec, inputs[0], inputs[1], checkMatchFields(exec, fields));
      }
      if (mode === "chooseBranch") {
        if (exec.param("chooseBranchMode", 0) !== "waitForAll") return [[]];
        const output = exec.param("output", 0);
        if (output === "specifiedInput") {
          const use = exec.param("useDataOfInput", 0);
          if (use > inputs.length) throw nodeError(exec, `Input ${use} doesn't exist`);
          return [[...(inputs[use - 1] ?? [])]];
        }
        if (output === "empty") return [[{ json: {}, pairedItem: [...inputs[0].map((x) => x.pairedItem), ...inputs[1].map((x) => x.pairedItem)].flatMap(preparePaired) }]];
        return [[]];
      }
      throw new UnsupportedNode(`Merge: mode "${mode}" is not supported`, { node: exec.name });
    }
    // v2 / v2.1
    if (mode === "append") return [[...inputs[0], ...inputs[1]]];
    if (mode === "combine") {
      const cm = exec.param("combinationMode", 0);
      if (cm === "multiplex") return combineAllPairs(exec, inputs);
      if (cm === "mergeByPosition") {
        const clash = exec.param("options.clashHandling.values", 0, {});
        const includeUnpaired = exec.param("options.includeUnpaired", 0, false);
        let [a, b] = inputs;
        if (a?.length === 0 || b?.length === 0) return [[...a, ...b]];
        if (clash.resolveClash === "preferInput1") [a, b] = [b, a];
        if (clash.resolveClash === "addSuffix") [a, b] = [addSuffix(a, "1"), addSuffix(b, "2")];
        const count = includeUnpaired ? Math.max(a.length, b.length) : Math.min(a.length, b.length);
        const mergeFn = selectMergeMethod(clash);
        const out = [];
        for (let i = 0; i < count; i++) {
          if (i >= a.length) { out.push(b[i]); continue; }
          if (i >= b.length) { out.push(a[i]); continue; }
          out.push({ json: { ...mergeFn(a[i].json, b[i].json) }, binary: { ...lodashMerge({}, a[i].binary, b[i].binary) }, pairedItem: [a[i].pairedItem, b[i].pairedItem] });
        }
        return [out];
      }
      if (cm === "mergeByFields") return combineByFields(exec, inputs[0], inputs[1], checkMatchFields(exec, exec.param("mergeByFields.values", 0, [])));
    }
    if (mode === "chooseBranch") {
      if (exec.param("chooseBranchMode", 0) !== "waitForBoth") return [[]];
      const output = exec.param("output", 0);
      if (output === "input1") return [[...inputs[0]]];
      if (output === "input2") return [[...inputs[1]]];
      if (output === "empty") return [[{ json: {}, pairedItem: [...inputs[0].map((x) => x.pairedItem), ...inputs[1].map((x) => x.pairedItem)].flatMap(preparePaired) }]];
    }
    return [[]];
  },
};

// ---------- NoOp, StopAndError, Limit, SplitOut, Aggregate ----------

const noOp = { versions: () => true, execute: (exec) => [exec.getInputData()] };

const stopAndError = {
  versions: oneOf(1),
  defaults: () => ({ errorType: "errorMessage", errorMessage: "", errorObject: "" }),
  execute(exec) {
    const type = exec.param("errorType", 0);
    if (type === "errorMessage") throw nodeError(exec, String(exec.param("errorMessage", 0)));
    const raw = exec.param("errorObject", 0);
    const o = typeof raw === "string" ? parseJsonLenient(raw) : raw;
    const s = (v) => typeof v === "string" && v.length > 0;
    const msg = (s(o.message) ? o.message : "") || (s(o.description) ? o.description : "") || (s(o.error) ? o.error : "") || `Error: ${JSON.stringify(o)}`;
    throw nodeError(exec, msg, { description: s(o.description) ? o.description : undefined, metadata: o });
  },
};

const limit = {
  versions: oneOf(1),
  defaults: () => ({ maxItems: 1, keep: "firstItems" }),
  execute(exec) {
    const items = exec.getInputData();
    const max = exec.param("maxItems", 0);
    if (max > items.length) return [items];
    return [exec.param("keep", 0) === "firstItems" ? items.slice(0, max) : items.slice(items.length - max)];
  },
};

const fieldsArray = (exec, v, label) => {
  if (typeof v === "string") return v.split(",").map((x) => x.trim()).filter((x) => x !== "");
  if (Array.isArray(v)) return v;
  throw nodeError(exec, `The '${label}' parameter must be a string of fields separated by commas or an array of strings.`);
};
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const splitOut = {
  versions: inRange(1, 1.1),
  defaults: () => ({ fieldToSplitOut: "", include: "noOtherFields", fieldsToInclude: "", options: {} }),
  execute(exec) {
    const items = exec.getInputData();
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const fields = fieldsArray(exec, exec.param("fieldToSplitOut", i), "Fields To Split Out").map((f) => String(f).replace(/^\$json\./, ""));
      const options = exec.param("options", i, {});
      const noDot = options.disableDotNotation;
      const dests = String(options.destinationFieldName || "").split(",").filter((f) => f.trim() !== "").map((f) => f.trim());
      const destPaths = exec.typeVersion >= 1.1 && !noDot && dests.length > 0;
      if (dests.length && dests.length !== fields.length) throw nodeError(exec, "If multiple fields to split out are given, the same number of destination fields must be given");
      const include = exec.param("include", i);
      const multi = fields.length > 1;
      const item = { ...items[i].json };
      const split = [];
      const pending = [];
      const setOut = (target, idx, field, value) => {
        if (destPaths) (pending[idx] ??= []).push([field, deepCopy(value)]);
        else if (!UNSAFE_KEYS.has(field)) target[field] = value;
      };
      for (const [fi, field] of fields.entries()) {
        const dest = dests[fi] || "";
        const name = dest || field;
        let entity;
        if (field === "$binary") entity = Object.entries(items[i].binary || {}).map(([k, v]) => ({ [k]: v }));
        else {
          entity = noDot ? item[field] : getPath(item, field);
          if (entity === undefined) entity = [];
          if (typeof entity !== "object" || entity === null) entity = [entity];
          if (!Array.isArray(entity)) entity = Object.values(entity);
        }
        for (const [ei, el] of entity.entries()) {
          if (split[ei] === undefined) split[ei] = { json: {}, pairedItem: { item: i } };
          if (field === "$binary") {
            split[ei].binary ??= {};
            split[ei].binary[Object.keys(el)[0]] = Object.values(el)[0];
            continue;
          }
          if (typeof el === "object" && el !== null && include === "noOtherFields" && dest === "" && !multi) split[ei] = { json: { ...split[ei].json, ...el }, pairedItem: { item: i } };
          else setOut(split[ei].json, ei, name, el);
        }
      }
      for (const [ei, entry] of split.entries()) {
        let n = entry;
        if (include === "allOtherFields") {
          const copy = deepCopy(item);
          for (const f of fields) noDot ? delete copy[f] : unsetPath(copy, f);
          n.json = { ...copy, ...entry.json };
        }
        if (include === "selectedOtherFields") {
          const inc = fieldsArray(exec, exec.param("fieldsToInclude", i, ""), "Fields To Include");
          if (!inc.length) throw nodeError(exec, "No fields specified", { description: "Please add a field to include" });
          for (const f of inc) entry.json[f] = noDot ? item[f] : getPath(item, f);
          n = entry;
        }
        const writes = pending[ei] ?? [];
        if (writes.length) n.json = deepCopy(n.json);
        for (const [f, val] of writes) setPath(n.json, f, val);
        if (options.includeBinary && items[i].binary && !n.binary) n.binary = items[i].binary;
        out.push(n);
      }
    }
    return [out];
  },
};

const aggregate = {
  versions: oneOf(1),
  defaults: () => ({ aggregate: "aggregateIndividualFields", fieldsToAggregate: { fieldToAggregate: [{ fieldToAggregate: "", renameField: false }] }, destinationFieldName: "data", include: "allFields", fieldsToExclude: "", fieldsToInclude: "", options: {} }),
  execute(exec) {
    const items = exec.getInputData();
    let result;
    if (exec.param("aggregate", 0, "") === "aggregateIndividualFields") {
      const noDot = exec.param("options.disableDotNotation", 0, false);
      const mergeLists = exec.param("options.mergeLists", 0, false);
      const keepMissing = exec.param("options.keepMissing", 0, false);
      const fields = exec.param("fieldsToAggregate.fieldToAggregate", 0, []);
      if (!fields.length) throw nodeError(exec, "No fields specified", { description: "Please add a field to aggregate" });
      const n = { json: {}, pairedItem: items.map((_, i) => ({ item: i })) };
      const values = {};
      const used = [];
      for (const { fieldToAggregate = "", outputFieldName = "", renameField = false } of fields) {
        const f = renameField ? outputFieldName : fieldToAggregate;
        if (used.includes(f)) throw nodeError(exec, `The '${f}' output field is used more than once`, { description: "Please make sure each output field name is unique" });
        used.push(f);
        const outName = outputFieldName || (!noDot && fieldToAggregate.includes(".") ? fieldToAggregate.split(".").pop() : fieldToAggregate);
        if (fieldToAggregate === "") continue;
        values[outName] = [];
        for (const it of items) {
          let value = noDot ? it.json[fieldToAggregate] : getPath(it.json, fieldToAggregate);
          if (!keepMissing) {
            if (Array.isArray(value)) value = value.filter((x) => x !== null);
            else if (value === null || value === undefined) continue;
          }
          if (Array.isArray(value) && mergeLists) values[outName].push(...value);
          else values[outName].push(value);
        }
      }
      for (const k of Object.keys(values)) noDot ? (n.json[k] = values[k]) : setPath(n.json, k, values[k]);
      result = n;
    } else {
      let rows = items.map((it) => it.json);
      let pairedItem = [];
      const dest = exec.param("destinationFieldName", 0);
      const exclude = fieldsArray(exec, exec.param("fieldsToExclude", 0, ""), "Fields To Exclude");
      const include = fieldsArray(exec, exec.param("fieldsToInclude", 0, ""), "Fields To Include");
      if (exclude.length || include.length) {
        rows = rows.reduce((acc, row, index) => {
          let keys = Object.keys(row);
          if (exclude.length) keys = keys.filter((k) => !exclude.includes(k));
          if (include.length) keys = keys.filter((k) => include.includes(k));
          const o = {};
          keys.forEach((k) => (o[k] = row[k]));
          if (!Object.keys(o).length) return acc;
          pairedItem.push({ item: index });
          return acc.concat([o]);
        }, []);
      } else pairedItem = items.map((_, item) => ({ item }));
      result = { json: { [dest]: rows }, pairedItem };
    }
    if (exec.param("options.includeBinaries", 0, false)) {
      const unique = exec.param("options.keepOnlyUnique", 0, false);
      const binary = {};
      const seen = [];
      let idx = 0;
      for (const p of result.pairedItem || []) {
        for (const b of Object.values(items[p.item]?.binary || {})) {
          if (unique && seen.some((s) => s.data === b.data)) continue;
          seen.push(b);
          binary[`data_${idx++}`] = b;
        }
      }
      if (idx) result.binary = binary;
    }
    return [[result]];
  },
};

// ---------- SplitInBatches v1, v2, v3 (Loop Over Items) ----------
// Batches are kept in the node context ($node["X"].context.noItemsLeft works).
// v1: one output, no output when done. v2: [loop, done]. v3: [done, loop].

const splitInBatches = {
  versions: oneOf(1, 2, 3),
  outputs: (exec) => (exec.typeVersion === 1 ? 1 : 2),
  defaults: (v) => ({ batchSize: v === 3 ? 1 : 10, options: {} }),
  execute(exec) {
    const v = exec.typeVersion;
    const items = exec.getInputData().slice();
    const ctx = (exec.run.nodeContext[exec.name] ??= {});
    const batchSize = exec.param("batchSize", 0);
    const options = exec.param("options", 0, {});
    const ret = [];
    const sourceData = exec.source?.main?.[0] ?? null;
    if (ctx.items === undefined || options.reset === true) {
      ctx.currentRunIndex = 0;
      ctx.maxRunIndex = Math.ceil(items.length / batchSize);
      ctx.sourceData = deepCopy(sourceData);
      ret.push(...items.splice(0, batchSize));
      ctx.items = [...items];
      if (v > 1) ctx.processedItems = [];
    } else {
      ctx.currentRunIndex += 1;
      ret.push(...ctx.items.splice(0, batchSize));
      const withOverwrite = (p) => (typeof p === "number" ? { item: p, sourceOverwrite: ctx.sourceData } : { ...p, sourceOverwrite: ctx.sourceData });
      if (v > 1) ctx.processedItems = [...ctx.processedItems, ...items.map((item, index) => ({ ...item, pairedItem: { sourceOverwrite: sourceData, item: index } }))];
      for (const it of ret) {
        if (it.pairedItem === undefined) it.pairedItem = { item: 0, sourceOverwrite: ctx.sourceData };
        else it.pairedItem = Array.isArray(it.pairedItem) ? it.pairedItem.map(withOverwrite) : withOverwrite(it.pairedItem);
      }
    }
    ctx.noItemsLeft = ctx.items.length === 0;
    if (ret.length === 0) {
      if (v === 1) return null;
      ctx.done = true;
      return v === 2 ? [[], ctx.processedItems] : [ctx.processedItems, []];
    }
    if (v > 1) ctx.done = false;
    return v === 1 ? [ret] : v === 2 ? [ret, []] : [[], ret];
  },
};

// ---------- Wait (time interval / specific time) ----------

const wait = {
  versions: inRange(1, 1.1),
  defaults: (v) => ({ resume: "timeInterval", amount: v < 1.1 ? 1 : 5, unit: v < 1.1 ? "hours" : "seconds", dateTime: "" }),
  async execute(exec) {
    const resume = exec.param("resume", 0);
    let until;
    if (resume === "timeInterval") {
      const unit = exec.param("unit", 0);
      if (!["seconds", "minutes", "hours", "days"].includes(unit)) throw nodeError(exec, "Invalid wait unit. Valid units are 'seconds', 'minutes', 'hours', or 'days'.");
      let amount = exec.param("amount", 0);
      if (typeof amount !== "number" || Number.isNaN(amount) || amount < 0) throw nodeError(exec, "Invalid wait amount. Please enter a number that is 0 or greater.");
      amount *= { seconds: 1, minutes: 60, hours: 3600, days: 86400 }[unit] * 1000;
      until = exec.run.clock.now + amount;
    } else if (resume === "specificTime") {
      const raw = exec.param("dateTime", 0);
      const d = DateTime.isDateTime(raw) ? raw : DateTime.fromISO(String(raw), { zone: exec.run.timezone });
      if (!d.isValid) throw nodeError(exec, "Cannot put execution to wait because `dateTime` parameter is not a valid date. Please pick a specific date and time to wait until.");
      until = d.toMillis();
    } else {
      throw new UnsupportedNode(`Wait: resume on "${resume}" is not supported by the runtime`, { node: exec.name });
    }
    await exec.sleepUntil(until);
    return [exec.getInputData()];
  },
};

// ---------- Code, Function, FunctionItem ----------

const N8N_ITEM_KEYS = new Set(["json", "binary", "pairedItem", "error", "index"]);
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

function normalizeItems(exec, data) {
  if (typeof data === "object" && !Array.isArray(data)) data = data.json ? [data] : [{ json: data }];
  if (data.every((it) => typeof it === "object" && "json" in it)) return data;
  if (data.some((it) => typeof it === "object" && "json" in it)) throw nodeError(exec, "Inconsistent item format");
  if (data.every((it) => typeof it === "object" && "binary" in it)) {
    return data.map((it) => ({ json: Object.fromEntries(Object.entries(it).filter(([k]) => k !== "binary")), binary: it.binary }));
  }
  if (data.some((it) => typeof it === "object" && "binary" in it)) throw nodeError(exec, "Inconsistent item format");
  return data.map((json) => ({ json }));
}
// n8n's Code ValidationError: an error about one item ends in " [item N]".
const atItem = (message, itemIndex) => (itemIndex === undefined ? message : `${message} [item ${itemIndex}]`);
function validateItem(exec, { json, binary }, itemIndex) {
  if (json === undefined || !isObj(json)) throw nodeError(exec, atItem("A 'json' property isn't an object", itemIndex), { itemIndex, description: "In the returned data, every key named 'json' must point to an object." });
  if (binary !== undefined && !isObj(binary)) throw nodeError(exec, atItem("A 'binary' property isn't an object", itemIndex), { itemIndex });
}
function validateTopLevelKeys(exec, item, itemIndex) {
  let reserved = null;
  const unknown = [];
  for (const k of Object.keys(item)) (N8N_ITEM_KEYS.has(k) ? (reserved ??= k) : unknown.push(k));
  if (unknown.length) {
    if (reserved) throw nodeError(exec, atItem("Invalid output format", itemIndex), { itemIndex, description: `An output item contains the reserved key ${reserved}. Wrap each item in an object, under a key called json.` });
    throw nodeError(exec, atItem(`Unknown top-level item key: ${unknown[0]}`, itemIndex), { itemIndex, description: "Access the properties of an item under `.json`, e.g. `item.json`" });
  }
}
// n8n Code node result checks for "Run Once for All Items".
export function validateAllItems(exec, result) {
  if (typeof result !== "object" || result === undefined) throw nodeError(exec, "Code doesn't return items properly", { description: "Please return an array of objects, one for each item you would like to output." });
  if (Array.isArray(result)) {
    for (const it of result) if (!isObj(it)) throw nodeError(exec, "Code doesn't return items properly", { description: "Please return an array of objects, one for each item you would like to output." });
    if (result.some((it) => Object.keys(it).some((k) => N8N_ITEM_KEYS.has(k)))) result.forEach((it, i) => validateTopLevelKeys(exec, it, i));
  }
  const items = normalizeItems(exec, result);
  items.forEach((it, i) => validateItem(exec, it, i));
  return items;
}
function validateEachItem(exec, result, itemIndex) {
  if (typeof result !== "object") throw nodeError(exec, atItem("Code doesn't return an object", itemIndex), { itemIndex, description: `Please return an object representing the output item. ('${result}' was returned instead.)` });
  if (Array.isArray(result)) throw nodeError(exec, atItem("Code doesn't return a single object", itemIndex), { itemIndex, description: `${result.length ? `An array of ${typeof result[0]}s was returned.` : "An empty array was returned."} If you need to output multiple items, please use the 'Run Once for All Items' mode instead.` });
  const [it] = normalizeItems(exec, [result]);
  validateItem(exec, it, itemIndex);
  validateTopLevelKeys(exec, it, itemIndex);
  return it;
}

// Code runs on copies (n8n's task runner gets serialized data), so mutations never reach
// earlier nodes' run data.
//
// The copies follow JSON (as the task runner's transport does): undefined keys drop out,
// undefined in a list becomes null, a Date or DateTime becomes its ISO string.
export const jsonCopy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const jsonItem = (it) => ({ ...it, json: jsonCopy(it.json), ...(it.binary !== undefined ? { binary: deepCopy(it.binary) } : {}) });
function codeView(exec) {
  const view = Object.create(exec);
  view.inputData = { main: (exec.inputData.main || []).map((input) => (input ? input.map((it) => jsonItem(it)) : input)) };
  view.connectionInputData = view.inputData.main.find((d) => d?.length) ?? view.inputData.main[0] ?? [];
  view._globals = undefined;
  const copies = new WeakMap();
  const runData = new Proxy(exec.run.runData, {
    get(t, k) {
      const runs = t[k];
      if (!Array.isArray(runs)) return runs;
      if (!copies.has(runs)) copies.set(runs, runs.map((task) => ({ ...task, data: task.data ? { ...task.data, main: (task.data.main ?? []).map((out) => (out ? out.map((it) => jsonItem(it)) : out)) } : task.data })));
      return copies.get(runs);
    },
  });
  view.run = Object.create(exec.run, { runData: { value: runData } });
  return view;
}

const unsupportedInCode = (what) => () => {
  throw new UnsupportedNode(`Code: ${what} is not supported by the runtime`);
};
function codeLocals(exec, extra) {
  return {
    $getWorkflowStaticData: unsupportedInCode("$getWorkflowStaticData() (workflow static data)"),
    require: (m) => {
      throw new UnsupportedNode(`Code: require("${m}") is not supported by the runtime`);
    },
    helpers: new Proxy({}, { get: (_, k) => unsupportedInCode(`helpers.${String(k)}`) }),
    Promise,
    // n8n's task runner gives Code its Buffer; the runtime has one only where the host does
    // (Node), not in a browser.
    ...(typeof globalThis.Buffer === "function" ? { Buffer: globalThis.Buffer } : {}),
    ...extra,
  };
}

// The message n8n's JS task runner gives a Code error (its ExecutionError): the first
// "Type: details" row of the stack, then " [line N]" with N the line in the user's code of
// the innermost frame there. A thrown value that is not error-like becomes its JSON.
// compileCode puts the user's first line on line 4 of the generated function.
const CODE_LINE_OFFSET = 3;
// Errors from n8n's own code (the $() proxy) are host-realm Errors there and keep their
// message as is; here those are the runtime's RunnerErrors.
export function codeErrorMessage(e) {
  if (e === null || typeof e !== "object" || !("message" in e)) return JSON.stringify(e) ?? String(e);
  if (e instanceof RunnerError) return e.message;
  // Node's own errors (Buffer and friends carry an ERR_* code) are host-realm in n8n too.
  if (typeof e.code === "string" && /^ERR_/.test(e.code)) return e.message;
  const rows = String(e.stack ?? "").split(/\r?\n/);
  let line;
  for (const row of rows) {
    if (!/eval at compileCode/.test(row)) continue;
    const m = /<anonymous>:(\d+):\d+\)?\s*$/.exec(row);
    if (m) {
      line = Number(m[1]) - CODE_LINE_OFFSET;
      break;
    }
  }
  const firstFrame = rows.findIndex((r) => /^\s+at\s/.test(r));
  const header = (firstFrame === -1 ? rows : rows.slice(0, firstFrame)).find((r) => /^\S.*?: .+$/.test(r));
  const details = header ? header.replace(/^\S.*?: /, "").trim() : "";
  const message = details || String(e.message || "") || "Unknown error";
  return line > 0 ? `${message} [line ${line}]` : message;
}

async function runCode(exec, code, locals, itemIndex) {
  const fn = compileCode(code);
  const lookup = createLookup(exec, itemIndex, { locals, lenientMissing: true });
  const thisArg = { helpers: locals.helpers, getNodeParameter: (p, i = itemIndex, fb) => exec.param(p, i, fb), getInputData: () => exec.connectionInputData };
  return fn.call(thisArg, lookup.scope);
}

const code = {
  versions: inRange(1, 2),
  defaults: () => ({ mode: "runOnceForAllItems", language: "javaScript", jsCode: "" }),
  async execute(exec) {
    const language = exec.typeVersion === 2 ? exec.param("language", 0) : "javaScript";
    if (language !== "javaScript") throw new UnsupportedNode(`Code: ${language} is not supported by the runtime (only JavaScript runs natively)`, { node: exec.name });
    const mode = exec.param("mode", 0);
    const src = exec.param("jsCode", 0);
    const view = codeView(exec);
    const items = view.connectionInputData;
    if (mode === "runOnceForAllItems") {
      let result;
      try {
        result = await runCode(view, src, codeLocals(view, { items }), 0);
      } catch (e) {
        if (e instanceof UnsupportedNode) throw Object.assign(e, { node: exec.name });
        const message = codeErrorMessage(e);
        if (exec.continueOnFail()) return [[{ json: { error: message } }]];
        throw nodeError(exec, message);
      }
      if (result === null) return [[]];
      return [validateAllItems(exec, result).map((it) => ({ ...it, json: jsonCopy(it.json) }))];
    }
    const out = [];
    for (let i = 0; i < items.length; i++) {
      let result;
      try {
        result = await runCode(view, src, codeLocals(view, { item: items[i] }), i);
      } catch (e) {
        if (e instanceof UnsupportedNode) throw Object.assign(e, { node: exec.name });
        const message = codeErrorMessage(e);
        if (!exec.continueOnFail()) throw nodeError(exec, message, { itemIndex: i });
        out.push({ json: { error: message }, pairedItem: { item: i } });
        continue;
      }
      if (result === null || !result) continue;
      const json = !isObj(result) ? result : "json" in result ? result.json : "binary" in result ? result.json ?? {} : result;
      const it = { json, pairedItem: { item: i }, ...(isObj(result) && result.binary ? { binary: result.binary } : {}) };
      const v = validateEachItem(exec, it, i);
      out.push({ ...v, json: jsonCopy(v.json) });
    }
    return [out];
  },
};

// Legacy Function node: `items` in, items out.
const functionNode = {
  versions: oneOf(1),
  defaults: () => ({ functionCode: "" }),
  async execute(exec) {
    const view = codeView(exec);
    const items = view.connectionInputData;
    let result;
    try {
      result = await runCode(view, exec.param("functionCode", 0), codeLocals(view, { items }), 0);
    } catch (e) {
      if (e instanceof UnsupportedNode) throw Object.assign(e, { node: exec.name });
      if (exec.continueOnFail()) return [[{ json: { error: e.message } }]];
      throw nodeError(exec, e.message ?? String(e));
    }
    if (result === undefined || result === null) throw nodeError(exec, "No data got returned. Always return an Array of items!");
    if (!Array.isArray(result)) throw nodeError(exec, "Always an Array of items has to be returned!");
    for (const it of result) {
      if (it.json === undefined) throw nodeError(exec, "All returned items have to contain a property named \"json\"!");
      if (!isObj(it.json)) throw nodeError(exec, "The json-property has to be an object!");
    }
    return [result];
  },
};

// Legacy Function Item node: `item` is the item's JSON; the return value is the new JSON.
const functionItemNode = {
  versions: oneOf(1),
  defaults: () => ({ functionCode: "" }),
  async execute(exec) {
    const view = codeView(exec);
    const items = view.connectionInputData;
    const out = [];
    for (let i = 0; i < items.length; i++) {
      let result;
      try {
        result = await runCode(view, exec.param("functionCode", i), codeLocals(view, { item: items[i].json, getBinaryData: () => items[i].binary, setBinaryData: (b) => (items[i].binary = b) }), i);
      } catch (e) {
        if (e instanceof UnsupportedNode) throw Object.assign(e, { node: exec.name });
        if (!exec.continueOnFail()) throw nodeError(exec, e.message ?? String(e), { itemIndex: i });
        out.push({ json: { error: e.message }, pairedItem: { item: i } });
        continue;
      }
      if (result === undefined) throw nodeError(exec, "No data got returned. Always an object has to be returned!");
      out.push({ json: result, pairedItem: { item: i }, ...(items[i].binary ? { binary: items[i].binary } : {}) });
    }
    return [out];
  },
};

// ---------- Execute Workflow (inline / self-reference sub-workflows) ----------

// A sub-workflow started without waiting (waitForSubWorkflow false): its failure stays its own,
// as in n8n, where the child is a separate execution; a containment refusal, bad input or a
// suspension still propagates.
async function runDetached(fn) {
  try {
    await fn();
  } catch (e) {
    if (e?.name === "Suspend" || e?.name === "ContainmentViolation" || e?.name === "BadInput") throw e;
  }
}

const executeWorkflow = {
  versions: inRange(1, 1.3),
  defaults: () => ({ source: "database", mode: "once", options: {} }),
  async execute(exec) {
    const sub = exec.step.subflow;
    if (!sub) throw new UnsupportedNode("Execute Workflow: the sub-workflow is not in the definition (only inline and self-referencing sub-workflows run)", { node: exec.name });
    const { runSubflow } = exec.run.api;
    const input = exec.getInputData().map((it, i) => {
      const values = exec.params.workflowInputs ? exec.param("workflowInputs.value", i, {}) : {};
      return { json: { ...it.json, ...values }, index: i, pairedItem: { item: i }, ...(it.binary ? { binary: it.binary } : {}) };
    });
    const removed = new Set((exec.params.workflowInputs?.schema ?? []).filter((x) => x.removed).map((x) => x.displayName));
    const items = removed.size ? input.map((it) => ({ ...it, json: Object.fromEntries(Object.entries(it.json).filter(([k]) => !removed.has(k))) })) : input;
    const mode = exec.param("mode", 0, false);
    if (mode === "each") {
      const ret = [];
      for (let i = 0; i < items.length; i++) {
        try {
          const wait = exec.param("options.waitForSubWorkflow", i, true);
          if (!wait) {
            // n8n starts the child and hands the item on without waiting: the child's own failure
            // is its execution's, not this step's (a refusal of the runtime still stops the run).
            await runDetached(() => runSubflow(exec, sub, [items[i]], `${exec.name}#${exec.runIndex}#${i}`));
            (ret[0] ??= []).push({ ...exec.getInputData()[i] });
            continue;
          }
          const res = await runSubflow(exec, sub, [items[i]], `${exec.name}#${exec.runIndex}#${i}`);
          res.output.forEach((data, oi) => {
            for (const it of data) it.pairedItem = { item: i };
            (ret[oi] ??= []).push(...data);
          });
        } catch (e) {
          if (e instanceof RunnerError && (e.name === "ContainmentViolation" || e.name === "BadInput")) throw e;
          if (e?.name === "Suspend") throw e;
          if (exec.continueOnFail()) {
            const oi = exec.typeVersion >= 1.3 ? 0 : i;
            (ret[oi] ??= []).push({ json: { error: e.message }, pairedItem: { item: i } });
            continue;
          }
          throw nodeError(exec, `Error executing workflow with item at index ${i}`, { description: e.message, itemIndex: i });
        }
      }
      return ret;
    }
    try {
      const wait = exec.param("options.waitForSubWorkflow", 0, true);
      if (!wait) {
        await runDetached(() => runSubflow(exec, sub, items, `${exec.name}#${exec.runIndex}`));
        return [exec.getInputData()];
      }
      const res = await runSubflow(exec, sub, items, `${exec.name}#${exec.runIndex}`);
      const fallback = generatePaired(items.length);
      for (const output of res.output) {
        const same = output.length === items.length;
        output.forEach((it, idx) => {
          if (it.pairedItem) {
            const back = res.backtrack(it, idx);
            if (back !== undefined) it.pairedItem = back;
            return;
          }
          it.pairedItem = same ? { item: idx } : fallback;
        });
      }
      return res.output;
    } catch (e) {
      if (e?.name === "Suspend" || e?.name === "ContainmentViolation" || e?.name === "BadInput") throw e;
      if (exec.continueOnFail()) return [[{ json: { error: e.message }, pairedItem: generatePaired(items.length) }]];
      throw e;
    }
  },
};

// ---------- registry ----------

export const TRIGGER_TYPES = new Set([BASE + "manualTrigger", BASE + "scheduleTrigger", BASE + "executeWorkflowTrigger", BASE + "cron", BASE + "interval", BASE + "start"]);

const IMPLS = {
  [BASE + "manualTrigger"]: manualTrigger,
  [BASE + "start"]: manualTrigger,
  [BASE + "scheduleTrigger"]: scheduleTrigger,
  [BASE + "executeWorkflowTrigger"]: executeWorkflowTrigger,
  [BASE + "set"]: { versions: (v) => setV1.versions(v) || setV3.versions(v), defaults: (v, p) => (v < 3 ? setV1 : setV3).defaults(v, p), execute: (exec) => (exec.typeVersion < 3 ? setV1 : setV3).execute(exec) },
  [BASE + "if"]: { versions: (v) => ifV1.versions(v) || ifV2.versions(v), outputs: () => 2, defaults: (v) => (v < 2 ? ifV1 : ifV2).defaults(v), execute: (exec) => (exec.typeVersion < 2 ? ifV1 : ifV2).execute(exec) },
  [BASE + "filter"]: { versions: (v) => filterV1.versions(v) || filterV2.versions(v), outputs: () => 2, defaults: (v) => (v < 2 ? filterV1 : filterV2).defaults(v), execute: (exec) => (exec.typeVersion < 2 ? filterV1 : filterV2).execute(exec) },
  [BASE + "switch"]: { versions: (v) => switchV1V2.versions(v) || switchV3.versions(v), outputs: (exec) => (exec.typeVersion < 3 ? switchV1V2 : switchV3).outputs(exec), defaults: (v) => (v < 3 ? switchV1V2 : switchV3).defaults(v), execute: (exec) => (exec.typeVersion < 3 ? switchV1V2 : switchV3).execute(exec) },
  [BASE + "merge"]: merge,
  [BASE + "noOp"]: noOp,
  [BASE + "stopAndError"]: stopAndError,
  [BASE + "limit"]: limit,
  [BASE + "splitOut"]: splitOut,
  [BASE + "aggregate"]: aggregate,
  [BASE + "splitInBatches"]: splitInBatches,
  [BASE + "wait"]: wait,
  [BASE + "code"]: code,
  [BASE + "function"]: functionNode,
  [BASE + "functionItem"]: functionItemNode,
  [BASE + "executeWorkflow"]: executeWorkflow,
  ...GROUP2,
  ...FILES,
};

// The implementation for a definition step, or null when the runtime cannot run it.
export function nodeImplFor(step) {
  if (!step) return null;
  if (step.kind === "blocked") return null;
  const req = requestImplFor(step);
  if (req) return req;
  const type = step.n8n?.type;
  const v = step.n8n?.typeVersion ?? 1;
  const impl = IMPLS[type];
  if (impl && impl.versions(v)) return impl;
  if (step.kind === "trigger" && !impl) return genericTrigger;
  return null;
}

export function isTriggerStep(step) {
  if (!step) return false;
  return step.kind === "trigger" || TRIGGER_TYPES.has(step.n8n?.type) || /Trigger$/.test(step.n8n?.type ?? "");
}

export const SUPPORTED_TYPES = Object.fromEntries(
  Object.entries(IMPLS).map(([t, impl]) => [t, [1, 1.1, 1.2, 1.3, 1.4, 1.5, 2, 2.1, 2.2, 2.3, 2.4, 3, 3.1, 3.2, 3.3, 3.4, 3.5].filter((v) => impl.versions(v))]),
);
export { isObject };
