// Node implementations, group 2 (Sort, Remove Duplicates, Summarize, Date & Time, Crypto,
// Respond to Webhook, Item Lists, Html template/table, Execution Data) and the steps that
// become host requests (HTTP Request, connector tools, model and agent steps).
//
// Not implemented, on purpose: Markdown (n8n converts with showdown / node-html-markdown;
// a partial converter would produce silently different HTML), Html "extract" and HTML
// Extract (need a DOM / cheerio selector engine), Date & Time v1 (moment format strings),
// Crypto "sign" (private keys), HTTP pagination and binary bodies. Preflight reports them.

import { NodeError, UnsupportedNode, deepCopy, getPath, setPath, isEqual, isObject } from "./util.mjs";
import { hashHex, hmacBytes, digestBytes, bytesToBase64, toHex } from "./hash.mjs";
import { tryToParseDateTime } from "./extensions.mjs";
import { DateTime } from "../vendor/luxon.mjs";

const BASE = "n8n-nodes-base.";
const inRange = (lo, hi) => (v) => v >= lo && v <= hi;
const oneOf = (...vs) => (v) => vs.includes(v);
const err = (exec, message, extra = {}) => new NodeError(message, { node: exec.name, ...extra });
const unsupported = (exec, what) => new UnsupportedNode(`${what} is not supported by the runtime`, { node: exec.name });
const fieldsArray = (exec, v, label) => {
  if (typeof v === "string") return v.split(",").map((x) => x.trim()).filter((x) => x !== "");
  if (Array.isArray(v)) return v;
  throw err(exec, `The '${label}' parameter must be a string of fields separated by commas or an array of strings.`);
};
// lodash lt: strings compare as strings, anything else as numbers.
const lt = (a, b) => (typeof a === "string" && typeof b === "string" ? a < b : Number(a) < Number(b));

// ---------- Sort ----------

function shuffle(arr, random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
async function sortItems(exec, items, params) {
  const out = [...items];
  const type = params.type;
  const noDot = params.disableDotNotation;
  if (type === "random") {
    shuffle(out, exec.run.randomFor(`${exec.name}#${exec.runIndex}#shuffle`));
    return out;
  }
  if (type === "code") throw unsupported(exec, "Sort with custom code");
  const fields = params.sortFields;
  if (!fields?.length) throw err(exec, "No sorting specified. Please add a field to sort by");
  for (const { fieldName } of fields) {
    const found = items.some((it) => (noDot ? Object.prototype.hasOwnProperty.call(it.json, fieldName) : getPath(it.json, fieldName) !== undefined));
    if (!found) throw err(exec, `Couldn't find the field '${fieldName}' in the input data`);
  }
  const dirs = fields.map((f) => ({ name: f.fieldName, dir: (f.order ?? "ascending") === "ascending" ? 1 : -1 }));
  const read = (it, k) => {
    const v = noDot ? it.json[k] : getPath(it.json, k);
    return typeof v === "string" ? v.toLowerCase() : v;
  };
  out.sort((a, b) => {
    for (const f of dirs) {
      const x = read(a, f.name);
      const y = read(b, f.name);
      if (!isEqual(x, y)) return lt(x, y) ? -1 * f.dir : 1 * f.dir;
    }
    return 0;
  });
  return out;
}
const sort = {
  versions: oneOf(1),
  defaults: () => ({ type: "simple", sortFieldsUi: {}, options: {} }),
  async execute(exec) {
    const params = { type: exec.param("type", 0), disableDotNotation: exec.param("options.disableDotNotation", 0, false), sortFields: exec.params.type === "simple" || !exec.params.type ? exec.param("sortFieldsUi", 0)?.sortField : undefined };
    return [await sortItems(exec, exec.getInputData(), params)];
  },
};

// ---------- Remove Duplicates (current input) ----------

function flattenKeys(obj, prefix = []) {
  if (obj === null || typeof obj !== "object") return { [prefix.join(".")]: obj };
  const out = {};
  for (const [k, v] of Object.entries(obj)) Object.assign(out, flattenKeys(v, [...prefix, k]));
  return out;
}
function removeDuplicateInputItems(exec, items, { compare, noDot, removeOtherFields, fieldsToExclude, fieldsToCompare }) {
  if (!items.length) return [[]];
  const keysOf = (it) => Object.keys(noDot ? it.json : flattenKeys(it.json));
  let keys = keysOf(items[0]);
  for (const it of items) for (const k of keysOf(it)) if (!keys.includes(k)) keys.push(k);
  if (compare === "allFieldsExcept") {
    const ex = fieldsArray(exec, fieldsToExclude, "Fields To Exclude");
    if (!ex.length) throw err(exec, "No fields specified. Please add a field to exclude from comparison");
    if (!noDot) keys = Object.keys(flattenKeys(items[0].json));
    keys = keys.filter((k) => !ex.includes(k));
  }
  if (compare === "selectedFields") {
    const sel = fieldsArray(exec, fieldsToCompare, "Fields To Compare");
    if (!sel.length) throw err(exec, "No fields specified. Please add a field to compare on");
    keys = sel.map((k) => k.trim());
  }
  const read = (it, k) => (noDot ? it.json[k] : getPath(it.json, k));
  const rows = items.map((it, index) => ({ json: { ...it.json, __INDEX: index }, pairedItem: { item: index } }));
  rows.sort((a, b) => {
    for (const k of keys) if (!isEqual(read(a, k), read(b, k))) return lt(read(a, k), read(b, k)) ? -1 : 1;
    return 0;
  });
  for (const k of keys) {
    let type;
    for (const [i, it] of rows.entries()) {
      if (k === "") throw err(exec, "Name of field to compare is blank");
      const v = read(it, k);
      if (v === null && exec.typeVersion > 1) continue;
      if (v === undefined) throw err(exec, `'${k}' field is missing from some input items`);
      if (type !== undefined && type !== typeof v) throw err(exec, `'${k}' isn't always the same type`, { description: `The type of this field varies between items${exec.typeVersion > 1 ? `, in item [${i - 1}] it's a ${type} and in item [${i}] it's a ${typeof v} ` : ""}` });
      type = typeof v;
    }
  }
  const removed = [];
  let prev = rows[0];
  for (let i = 1; i < rows.length; i++) {
    if (keys.every((k) => isEqual(read(rows[i], k), read(prev, k)))) removed.push(rows[i].json.__INDEX);
    else prev = rows[i];
  }
  let out = items.filter((_, i) => !removed.includes(i));
  if (removeOtherFields) out = out.map((it, index) => ({ json: Object.fromEntries(keys.filter((k) => getPath(it.json, k) !== undefined).map((k) => [k, getPath(it.json, k)])), pairedItem: { item: index } }));
  return [out];
}
const removeDuplicates = {
  versions: (v) => inRange(1, 1.1)(v) || v === 2,
  defaults: () => ({ operation: "removeDuplicateInputItems", compare: "allFields", fieldsToExclude: "", fieldsToCompare: "", options: {} }),
  execute(exec) {
    if (exec.typeVersion >= 2 && exec.param("operation", 0) !== "removeDuplicateInputItems") throw unsupported(exec, "Remove Duplicates across executions (it needs stored deduplication state)");
    return removeDuplicateInputItems(exec, exec.getInputData(), {
      compare: exec.param("compare", 0),
      noDot: exec.param("options.disableDotNotation", 0, false),
      removeOtherFields: exec.param("options.removeOtherFields", 0, false),
      fieldsToExclude: exec.param("fieldsToExclude", 0, ""),
      fieldsToCompare: exec.param("fieldsToCompare", 0, ""),
    });
  },
};

// ---------- Summarize ----------

const AGG_NAMES = { append: "appended_", average: "average_", concatenate: "concatenated_", count: "count_", countUnique: "unique_count_", max: "max_", min: "min_", sum: "sum_" };
const isEmptyValue = (v) => v === undefined || v === null || v === "";
const normalizeFieldName = (f) => f.replace(/[\]\["]/g, "").replace(/[ .]/g, "_");
function summarizeAggregate(items, entry, get) {
  const { aggregation, field } = entry;
  let data = [...items];
  if (aggregation === "average" || aggregation === "sum") data = data.filter((it) => typeof get(it, field) === "number" && !isEmptyValue(get(it, field)));
  switch (aggregation) {
    case "append":
      if (!entry.includeEmpty) data = data.filter((it) => !isEmptyValue(get(it, field)));
      return data.map((it) => get(it, field));
    case "concatenate": {
      const sep = entry.separateBy === "other" ? entry.customSeparator : entry.separateBy ?? ",";
      if (!entry.includeEmpty) data = data.filter((it) => !isEmptyValue(get(it, field)));
      return data.map((it) => { let v = get(it, field); if (typeof v === "object") v = JSON.stringify(v); if (v === undefined) v = "undefined"; return v; }).join(sep);
    }
    case "average":
      return data.length === 0 ? null : data.reduce((a, it) => a + get(it, field), 0) / data.length;
    case "sum":
      return data.reduce((a, it) => a + get(it, field), 0);
    case "min":
    case "max": {
      let r;
      for (const it of data) {
        const v = get(it, field);
        if (v !== undefined && v !== null && v !== "" && (r === undefined || (aggregation === "min" ? v < r : v > r))) r = v;
      }
      return r ?? null;
    }
    case "countUnique":
      return new Set(data.map((it) => get(it, field)).filter((x) => entry.includeEmpty || !isEmptyValue(x))).size;
    default:
      return entry.includeEmpty ? data.length : data.filter((it) => !isEmptyValue(get(it, field))).length;
  }
}
function summarizeSplit(splitKeys, items, fields, options, get, toStr) {
  if (!splitKeys.length) {
    const returnData = Object.fromEntries(fields.map((a) => [normalizeFieldName(`${AGG_NAMES[a.aggregation ?? "count"]}${a.field}`), summarizeAggregate(items, { aggregation: "count", ...a }, get)]));
    return options.outputFormat === "singleItem" ? { returnData } : { returnData, pairedItems: items.map((it) => it._itemIndex) };
  }
  const [first, ...rest] = splitKeys;
  const groups = new Map();
  for (const it of items) {
    let v = get(it, first);
    if (v && typeof v === "object") v = JSON.stringify(v);
    if (toStr) v = String(v);
    if (options.skipEmptySplitFields && typeof v !== "number" && !v) continue;
    groups.set(v, (groups.get(v) ?? []).concat([it]));
  }
  return { fieldName: first, splits: new Map([...groups].map(([k, g]) => [k, summarizeSplit(rest, g, fields, options, get, toStr)])) };
}
const flatObject = (r) => ("splits" in r ? Object.fromEntries([...r.splits].map(([k, v]) => [k, flatObject(v)])) : r.returnData);
const flatArray = (r) => ("splits" in r ? [...r.splits].flatMap(([value, inner]) => flatArray(inner).map((x) => ((x.returnData[normalizeFieldName(r.fieldName)] = value), x))) : [r]);
const summarize = {
  versions: inRange(1, 1.1),
  defaults: () => ({ fieldsToSummarize: { values: [{ aggregation: "count", field: "" }] }, fieldsToSplitBy: "", options: {} }),
  execute(exec) {
    const items = exec.getInputData().map(({ json }, i) => ({ ...json, _itemIndex: i }));
    const options = exec.param("options", 0, {});
    const split = String(exec.param("fieldsToSplitBy", 0, "")).split(",").map((f) => f.trim()).filter(Boolean);
    const fields = exec.param("fieldsToSummarize.values", 0, []);
    if (!fields.filter((a) => a.field !== "").length) throw err(exec, "You need to add at least one aggregation to 'Fields to Summarize' with non empty 'Field'");
    const get = (it, f) => (options.disableDotNotation ? it[f] : getPath(it, f));
    const result = summarizeSplit(split, items, fields, options, get, exec.typeVersion === 1);
    for (const a of fields) {
      if (a.field === "") continue;
      if (!items.some((it) => get(it, a.field) !== undefined)) {
        if (exec.typeVersion > 1 || options.continueIfFieldNotFound) exec.hints.push({ message: `The field '${a.field}' does not exist in any items`, location: "outputPane" });
        else throw err(exec, `The field '${a.field}' does not exist in any items`);
      }
    }
    if (options.outputFormat === "singleItem") return [[{ json: flatObject(result), pairedItem: items.map((_, item) => ({ item })) }]];
    if (!split.length && "pairedItems" in result) return [[{ json: result.returnData, pairedItem: (result.pairedItems ?? []).map((item) => ({ item })) }]];
    return [flatArray(result).map((r) => ({ json: r.returnData, pairedItem: (r.pairedItems ?? []).map((item) => ({ item })) }))];
  },
};

// ---------- Date & Time v2 ----------

// n8n's DateTime v2 parseDate: numbers are seconds (< 12 digits) or ms; strings go through
// moment (ISO first, then the JS Date parser) in UTC; the result is set to `timezone`.
function parseDate(exec, date, { timezone, fromFormat } = {}) {
  if (DateTime.isDateTime(date)) return date;
  if (!Number.isNaN(Number(date)) && !fromFormat && date !== "" && date !== null && typeof date !== "boolean") {
    date = Number(date);
    if (!Number.isInteger(date)) date *= 1000;
  }
  let zone = timezone;
  let d;
  if (Number.isInteger(date)) d = String(date).length < 12 ? DateTime.fromSeconds(date) : DateTime.fromMillis(date);
  else {
    const s = String(date);
    if (!zone && s.includes("+")) zone = `Etc/GMT-${Number(s.split("+")[1].slice(0, 2))}`;
    if (fromFormat) d = DateTime.fromFormat(s, fromFormat);
    else {
      const iso = DateTime.fromISO(s, { zone: "utc", setZone: false });
      d = iso.isValid ? iso : DateTime.fromJSDate(new Date(s));
    }
  }
  d = d.setZone(zone || "Etc/UTC");
  if (!d.isValid) throw err(exec, "Invalid date format");
  return d;
}
const dateTimeV2 = {
  versions: oneOf(2),
  defaults: (v, p) => {
    const op = p.operation ?? "getCurrentDate";
    const out = { getCurrentDate: "currentDate", addToDate: "newDate", subtractFromDate: "newDate", formatDate: "formattedDate", roundDate: "roundedDate", getTimeBetweenDates: "timeDifference", extractDate: "datePart" }[op];
    return { operation: "getCurrentDate", includeTime: true, outputFieldName: out, magnitude: "", timeUnit: "days", duration: 0, date: "", format: "MM/dd/yyyy", customFormat: "", mode: "roundDown", toNearest: "month", to: "month", startDate: "", endDate: "", units: ["day"], part: "month", options: {} };
  },
  execute(exec) {
    const items = exec.getInputData();
    const op = exec.param("operation", 0);
    const tz = exec.run.timezone;
    const includeInput = exec.param("options.includeInputFields", 0, false);
    const out = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const item = includeInput ? { json: { ...items[i].json }, binary: items[i].binary } : { json: {} };
        item.pairedItem = { item: i };
        const field = exec.param("outputFieldName", i);
        if (op === "getCurrentDate") {
          const zone = exec.param("options", i).timezone || tz;
          const now = DateTime.fromMillis(exec.run.clock.now).setZone(zone);
          if (now.invalidReason === "unsupported zone") throw err(exec, `The timezone ${zone} is not valid. Please check the timezone.`);
          item.json[field] = (exec.param("includeTime", i) ? now : now.startOf("day")).toString();
        } else if (op === "addToDate" || op === "subtractFromDate") {
          const d = parseDate(exec, exec.param("magnitude", i), { timezone: tz });
          const delta = { [exec.param("timeUnit", i)]: exec.param("duration", i) };
          item.json[field] = (op === "addToDate" ? d.plus(delta) : d.minus(delta)).toString();
        } else if (op === "formatDate") {
          const date = exec.param("date", i);
          const { timezone, fromFormat } = exec.param("options", i);
          if (date === null || date === undefined) item.json[field] = date;
          else {
            const d = parseDate(exec, date, { timezone: timezone ? tz : undefined, fromFormat });
            const format = exec.param("format", i);
            item.json[field] = d.toFormat(format === "custom" ? exec.param("customFormat", i) : format);
          }
        } else if (op === "roundDate") {
          const d = parseDate(exec, exec.param("date", i), { timezone: tz });
          if (exec.param("mode", i) === "roundDown") item.json[field] = d.startOf(exec.param("toNearest", i)).toString();
          else {
            const to = exec.param("to", i);
            item.json[field] = d.plus({ [to]: 1 }).startOf(to).toString();
          }
        } else if (op === "getTimeBetweenDates") {
          const a = parseDate(exec, exec.param("startDate", i), { timezone: tz });
          const b = parseDate(exec, exec.param("endDate", i), { timezone: tz });
          const dur = b.diff(a, exec.param("units", i));
          item.json[field] = exec.param("options", i).isoString ? dur.toString() : dur.toObject();
        } else if (op === "extractDate") {
          const d = parseDate(exec, exec.param("date", i), { timezone: tz });
          const part = exec.param("part", i);
          item.json[field] = part === "week" ? d.weekNumber : d.get(part);
        }
        out.push(item);
      } catch (e) {
        if (exec.continueOnFail()) {
          out.push({ json: { error: e.message } });
          continue;
        }
        throw e instanceof NodeError ? e : err(exec, e.message, { itemIndex: i });
      }
    }
    return [out];
  },
};

// ---------- Crypto (hash, hmac, generate) ----------

const CRYPTO_ALG = { md5: "md5", sha1: "sha1", sha256: "sha256", sha384: "sha384", sha512: "sha512", "sha3-512": "sha3-512" };
function seededUuid(random) {
  const b = Array.from({ length: 16 }, () => Math.floor(random() * 256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = toHex(Uint8Array.from(b));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const crypto = {
  versions: oneOf(1, 2),
  defaults: () => ({ action: "hash", type: "MD5", encoding: "hex", dataPropertyName: "data", value: "", binaryData: false, encodingType: "uuid", stringLength: 32, secret: "" }),
  execute(exec) {
    const items = exec.getInputData();
    const action = exec.param("action", 0);
    const random = exec.run.randomFor(`${exec.name}#${exec.runIndex}#crypto`);
    const out = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const prop = exec.param("dataPropertyName", i);
        const value = exec.param("value", i, "");
        let nv;
        if (action === "generate") {
          const enc = exec.param("encodingType", i);
          if (enc === "uuid") nv = seededUuid(random);
          else {
            const len = exec.param("stringLength", i);
            const bytes = Uint8Array.from({ length: len }, () => Math.floor(random() * 256));
            nv = enc === "base64" ? bytesToBase64(bytes).replace(/\W/g, "").slice(0, len) : toHex(bytes).slice(0, len);
          }
        } else if (action === "hash" || action === "hmac") {
          if (exec.param("binaryData", i, false)) throw unsupported(exec, "Crypto on binary data");
          const alg = CRYPTO_ALG[String(exec.param("type", i)).toLowerCase()];
          if (!alg) throw unsupported(exec, `Crypto algorithm ${exec.param("type", i)}`);
          const enc = exec.param("encoding", i);
          const bytes = action === "hash" ? digestBytes(alg, String(value)) : hmacBytes(alg, String(exec.param("secret", i)), String(value));
          nv = enc === "base64" ? bytesToBase64(bytes) : toHex(bytes);
        } else throw unsupported(exec, `Crypto action "${action}"`);
        const n = { json: prop.includes(".") ? deepCopy(items[i].json) : { ...items[i].json }, pairedItem: { item: i } };
        if (items[i].binary !== undefined) n.binary = items[i].binary;
        n.json[prop] = nv;
        out.push(n);
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

// ---------- Respond to Webhook (records the response) ----------

const respondToWebhook = {
  versions: inRange(1, 1.5),
  outputs: (exec) => (exec.typeVersion === 1.3 || (exec.typeVersion >= 1.4 && exec.params.enableResponseOutput) ? 2 : 1),
  defaults: () => ({ respondWith: "firstIncomingItem", responseBody: '{\n  "myField": "value"\n}', redirectURL: "", options: {} }),
  execute(exec) {
    const items = exec.getInputData();
    let response;
    try {
      const options = exec.param("options", 0, {});
      const respondWith = exec.param("respondWith", 0);
      const headers = {};
      for (const h of options.responseHeaders?.entries ?? []) headers[String(h.name ?? "").toLowerCase()] = h.value?.toString();
      let statusCode = options.responseCode || 200;
      let body;
      if (respondWith === "json") {
        const p = exec.param("responseBody", 0);
        if (p) {
          if (typeof p === "object") body = p;
          else {
            try {
              body = JSON.parse(p);
            } catch {
              throw err(exec, "Invalid JSON in 'Response Body' field", { description: "Check that the syntax of the JSON in the 'Response Body' parameter is valid" });
            }
          }
        }
      } else if (respondWith === "allIncomingItems") {
        const rows = items.map((it) => it.json);
        body = options.responseKey ? setPath({}, options.responseKey, rows) : rows;
      } else if (respondWith === "firstIncomingItem") {
        body = options.responseKey ? setPath({}, options.responseKey, items[0].json) : items[0].json;
      } else if (respondWith === "text") body = exec.param("responseBody", 0);
      else if (respondWith === "redirect") {
        headers.location = exec.param("redirectURL", 0);
        statusCode = options.responseCode ?? 307;
      } else if (respondWith === "jwt" || respondWith === "binary") throw unsupported(exec, `Respond to Webhook with ${respondWith}`);
      else if (respondWith !== "noData") throw err(exec, `The Response Data option "${respondWith}" is not supported!`);
      response = { body, headers, statusCode };
      if (exec.run.response === undefined) exec.run.response = deepCopy(response);
    } catch (e) {
      if (e instanceof UnsupportedNode) throw e;
      if (exec.continueOnFail()) return [[{ json: { error: e.message }, pairedItem: items.map((_, item) => ({ item })) }]];
      throw e;
    }
    if (this.outputs(exec) === 2) return [items, [{ json: { response } }]];
    return [items];
  },
};

// ---------- Item Lists (legacy aliases) ----------

const itemLists = {
  versions: inRange(1, 3.1),
  defaults: () => ({ operation: "splitOutItems", fieldToSplitOut: "", include: "noOtherFields", options: {} }),
  async execute(exec) {
    const op = exec.param("operation", 0);
    const { nodeImplFor } = exec.run.api;
    const alias = (type, version, params) => {
      const step = { ...exec.step, n8n: { ...exec.step.n8n, type: BASE + type, typeVersion: version }, params: { ...exec.step.params, ...params } };
      const impl = nodeImplFor(step);
      const view = Object.create(exec);
      view.step = step;
      view.params = { ...(impl.defaults?.(version, step.params) ?? {}), ...step.params };
      return impl.execute.call(impl, view);
    };
    if (op === "splitOutItems") return alias("splitOut", 1, {});
    if (op === "aggregateItems") return alias("aggregate", 1, exec.params.aggregate ? {} : { aggregate: "aggregateIndividualFields" });
    if (op === "limit") return alias("limit", 1, {});
    if (op === "removeDuplicates") return alias("removeDuplicates", 1, {});
    if (op === "summarize") return alias("summarize", 1, {});
    if (op === "sort") return [await sortItems(exec, exec.getInputData(), { type: exec.param("type", 0, "simple"), disableDotNotation: exec.param("options.disableDotNotation", 0, false), sortFields: exec.param("sortFieldsUi", 0, {})?.sortField })];
    if (op === "concatenateItems") return alias("aggregate", 1, {});
    throw unsupported(exec, `Item Lists operation "${op}"`);
  },
};

// ---------- Html (template / table only) ----------

const html = {
  versions: inRange(1, 1.2),
  defaults: () => ({ operation: "generateHtmlTemplate", html: "", options: {} }),
  execute(exec) {
    const op = exec.param("operation", 0);
    const items = exec.getInputData();
    if (op === "generateHtmlTemplate") return [items.map((_, i) => ({ json: { html: String(exec.param("html", i)) }, pairedItem: { item: i } }))];
    if (op === "convertToHtmlTable") {
      const opts = exec.param("options", 0, {});
      const keys = [...new Set(items.flatMap((it) => Object.keys(it.json)))];
      const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      let t = `<table${opts.tableAttributes ? " " + opts.tableAttributes : ""}>`;
      if (!opts.removeHeader) t += `<thead><tr>${keys.map((k) => `<th>${opts.capitalize ? esc(k.charAt(0).toUpperCase() + k.slice(1)) : esc(k)}</th>`).join("")}</tr></thead>`;
      t += `<tbody>${items.map((it) => `<tr>${keys.map((k) => `<td>${typeof it.json[k] === "object" && it.json[k] !== null ? esc(JSON.stringify(it.json[k])) : esc(it.json[k])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      return [[{ json: { table: t }, pairedItem: items.map((_, item) => ({ item })) }]];
    }
    throw unsupported(exec, `Html operation "${op}" (needs an HTML parser)`);
  },
};

const executionData = {
  versions: inRange(1, 1.1),
  defaults: () => ({ dataToSave: {} }),
  execute(exec) {
    const items = exec.getInputData();
    items.forEach((_, i) => {
      for (const v of exec.param("dataToSave.values", i, [])) exec.run.executionInfo.customData.set(v.key, v.value);
    });
    return [items];
  },
};

export const GROUP2 = {
  [BASE + "sort"]: sort,
  [BASE + "removeDuplicates"]: removeDuplicates,
  [BASE + "summarize"]: summarize,
  [BASE + "dateTime"]: dateTimeV2,
  [BASE + "crypto"]: crypto,
  [BASE + "respondToWebhook"]: respondToWebhook,
  [BASE + "itemLists"]: itemLists,
  [BASE + "html"]: html,
  [BASE + "executionData"]: executionData,
};

// ---------- request steps ----------

const STATUS_MESSAGES = {
  400: "Bad request - please check your parameters",
  401: "Authorization failed - please check your credentials",
  403: "Forbidden - perhaps check your credentials?",
  404: "The resource you are requesting could not be found",
  405: "Method not allowed - please check you are using the right HTTP method",
  429: "The service is receiving too many requests from you",
  500: "The service was not able to process your request",
  502: "Bad gateway - the service failed to handle your request",
  503: "Service unavailable - try again later or consider setting this node to retry automatically (in the node settings)",
  504: "Gateway timed out - perhaps try again later?",
};

const REASONS = { 200: "OK", 201: "Created", 202: "Accepted", 204: "No Content", 301: "Moved Permanently", 302: "Found", 304: "Not Modified", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 422: "Unprocessable Entity", 429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout" };

function keyPairs(list) {
  const out = {};
  for (const p of list ?? []) {
    if (!p || p.name === undefined || p.name === "") continue;
    if (out[p.name] !== undefined) out[p.name] = [].concat(out[p.name], p.value);
    else out[p.name] = p.value;
  }
  return out;
}
const jsonParam = (exec, v, what, i) => {
  if (typeof v !== "string") return v;
  if (v.trim() === "") return {};
  try {
    return JSON.parse(v);
  } catch {
    throw err(exec, `JSON parameter needs to be valid JSON`, { itemIndex: i, description: what });
  }
};

// HTTP Request v3/v4.x -> an `http` request per item (n8n HttpRequestV3 parameters).
export function buildHttpRequest(exec, i) {
  const p = (k, fb) => exec.param(k, i, fb);
  const method = String(p("method", "GET")).toUpperCase();
  const url = p("url", "");
  const options = p("options", {});
  if (options.pagination?.pagination || exec.params.options?.pagination) throw unsupported(exec, "HTTP Request pagination");
  const req = { kind: "http", itemIndex: i, method, url: String(url), headers: {}, query: {} };
  if (p("sendQuery", false)) req.query = p("specifyQuery", "keypair") === "json" ? jsonParam(exec, p("jsonQuery", ""), "Query Parameters", i) : keyPairs(p("queryParameters.parameters", []));
  if (p("sendHeaders", false)) req.headers = p("specifyHeaders", "keypair") === "json" ? jsonParam(exec, p("jsonHeaders", ""), "Headers", i) : keyPairs(p("headerParameters.parameters", []));
  if (p("sendBody", false)) {
    const ct = p("contentType", "json");
    if (ct === "json") req.body = p("specifyBody", "keypair") === "json" ? jsonParam(exec, p("jsonBody", ""), "JSON Body", i) : keyPairs(p("bodyParameters.parameters", []));
    else if (ct === "form-urlencoded") req.body = p("specifyBody", "keypair") === "string" ? String(p("body", "")) : keyPairs(p("bodyParameters.parameters", []));
    else if (ct === "multipart-form-data") {
      const list = p("bodyParameters.parameters", []);
      if (list.some((x) => x.parameterType === "formBinaryData")) throw unsupported(exec, "HTTP Request binary form fields");
      req.body = keyPairs(list);
    } else if (ct === "raw") {
      req.body = String(p("body", ""));
      req.headers = { "content-type": p("rawContentType", ""), ...req.headers };
    } else throw unsupported(exec, `HTTP Request body type "${ct}"`);
    req.contentType = ct;
  }
  const auth = exec.step.auth;
  const authentication = p("authentication", "none");
  if (authentication !== "none") {
    if (!auth?.secret) throw err(exec, "HTTP Request uses a credential the definition does not name (step.auth)");
    req.auth = { credentialType: auth.credentialType ?? (authentication === "genericCredentialType" ? p("genericAuthType", "") : p("nodeCredentialType", "")), secret: auth.secret };
  }
  if (options.timeout) req.timeoutMs = options.timeout;
  if (options.redirect?.redirect?.followRedirects === false) req.followRedirects = false;
  const r = options.response?.response ?? {};
  req.response = { format: r.responseFormat || "autodetect", fullResponse: !!r.fullResponse, neverError: !!r.neverError };
  if (req.response.format === "file") throw unsupported(exec, "HTTP Request file responses");
  return req;
}

function httpItems(exec, req, res, i) {
  const fmt = req.response;
  const value = res.value ?? {};
  const status = Number(value.status ?? value.statusCode ?? 200);
  const headers = Object.fromEntries(Object.entries(value.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  let body = value.body;
  const statusMessage = value.statusMessage ?? REASONS[status];
  if (!res.ok || (status >= 400 && !fmt.neverError)) {
    const message = res.ok ? STATUS_MESSAGES[status] ?? `${status} - ${typeof body === "string" ? body : JSON.stringify(body)}` : res.error?.message ?? "request failed";
    const e = err(exec, message, { itemIndex: i, httpCode: res.ok ? String(status) : undefined, description: typeof body === "string" ? body : body !== undefined ? JSON.stringify(body) : undefined });
    if (!exec.continueOnFail()) throw e;
    return [{ json: { error: { message, ...(res.ok ? { httpCode: String(status) } : {}) } }, pairedItem: { item: i } }];
  }
  let format = fmt.format;
  if (format === "autodetect") {
    const ct = String(headers["content-type"] ?? "");
    if (ct.includes("application/json")) {
      format = "json";
      if (typeof body === "string") {
        try {
          body = body.trim() === "" ? {} : JSON.parse(body);
        } catch {
          if (fmt.neverError) body = {};
          else throw err(exec, "Invalid JSON in response body", { itemIndex: i });
        }
      }
    } else if (/^(image|audio|video)\/|application\/(pdf|octet-stream|zip)/.test(ct)) throw unsupported(exec, "HTTP Request binary responses");
    else {
      format = "text";
      if (body !== undefined && typeof body !== "string") body = JSON.stringify(body);
      if (body === "") body = undefined;
    }
  }
  const pi = { item: i };
  if (format === "text") {
    const text = body === undefined || body === null ? "" : typeof body === "string" ? body : JSON.stringify(body);
    if (fmt.fullResponse) return [{ json: { data: text, headers, statusCode: status, statusMessage }, pairedItem: pi }];
    return [{ json: { data: text }, pairedItem: pi }];
  }
  if (typeof body === "string" && format === "json") {
    try {
      body = body.trim() === "" ? {} : JSON.parse(body);
    } catch {
      throw err(exec, 'Response body is not valid JSON. Change "Response Format" to "Text"', { itemIndex: i });
    }
  }
  if (fmt.fullResponse) return [{ json: { body, headers, statusCode: status, statusMessage }, pairedItem: pi }];
  const nonNull = (j) => (j === null || j === undefined ? {} : j);
  if (Array.isArray(body)) return body.map((j) => ({ json: nonNull(j), pairedItem: pi }));
  return [{ json: nonNull(body), pairedItem: pi }];
}

const httpRequest = {
  versions: (v) => v >= 3 && v < 5,
  defaults: () => ({ method: "GET", url: "", authentication: "none", sendQuery: false, sendHeaders: false, sendBody: false, options: {} }),
  async execute(exec) {
    const items = exec.getInputData();
    const reqs = [];
    const errors = [];
    items.forEach((_, i) => {
      try {
        reqs.push(buildHttpRequest(exec, i));
      } catch (e) {
        if (e instanceof UnsupportedNode || !exec.continueOnFail()) throw e;
        errors[i] = e.message;
      }
    });
    const sendable = reqs.map(({ response, ...r }) => r);
    const results = await exec.request(sendable);
    const out = [];
    let k = 0;
    items.forEach((_, i) => {
      if (errors[i] !== undefined) return void out.push({ json: { error: errors[i] }, pairedItem: { item: i } });
      const req = reqs[k];
      const res = results[k++];
      try {
        out.push(...httpItems(exec, req, res, i));
      } catch (e) {
        if (e instanceof UnsupportedNode || !exec.continueOnFail()) throw e;
        out.push({ json: { error: e.message }, pairedItem: { item: i } });
      }
    });
    return [out];
  },
};

// Connector tool step: step.tool = {connector, name, args, effect}. Args are evaluated per item.
const toolStep = {
  versions: () => true,
  async execute(exec) {
    const t = exec.step.tool;
    if (!t?.connector || !t?.name) throw unsupported(exec, "A tool step without tool.connector and tool.name");
    const items = exec.getInputData();
    const reqs = items.map((_, i) => ({ kind: "tool", itemIndex: i, connector: t.connector, tool: t.name, args: exec.evaluate(t.args ?? {}, i), effect: t.effect }));
    const results = await exec.request(reqs);
    return [toItems(exec, results, items, "tool")];
  },
};

function toItems(exec, results, items, what, wrapKey) {
  const out = [];
  results.forEach((r, i) => {
    if (!r.ok) {
      const e = err(exec, r.error?.message ?? `${what} call failed`, { itemIndex: i });
      if (!exec.continueOnFail()) throw e;
      out.push({ json: { error: e.message }, pairedItem: { item: i } });
      return;
    }
    const v = r.value;
    if (wrapKey) out.push({ json: { [wrapKey]: v }, pairedItem: { item: i } });
    else if (Array.isArray(v)) v.forEach((x) => out.push({ json: isObject(x) ? x : { value: x }, pairedItem: { item: i } }));
    else out.push({ json: isObject(v) ? v : { value: v }, pairedItem: { item: i } });
  });
  return out;
}

// ---------- model and agent steps ----------
// A converter may give the step an explicit `model` / `agent` block. Without one, the
// request is derived from the n8n parameters of the Basic LLM Chain and the AI Agent
// (n8n-nodes-langchain 2.47): the prompt from promptType ("auto": $json.chatInput,
// "define": text; chainLlm <= 1.3: the `prompt` parameter), chainLlm's
// messages.messageValues, the agent's options.systemMessage (default "You are a helpful
// assistant"), the model name of the connected ai_languageModel sub-node, the schema of a
// connected Structured Output Parser, the agent's ai_tool sub-nodes and its memory key.
// Output: chainLlm {text} (trimmed) or {output: object} with a parser; agent {output}.

const LC = "@n8n/n8n-nodes-langchain.";
const subnodesOf = (exec, type) => (exec.run.graph.subnodesOf[exec.name] ?? []).filter((s) => s.type === type).map((s) => ({ name: s.from, step: exec.run.definition.steps[s.from] })).filter((s) => s.step && s.step.settings?.disabled !== true);
export function canDeriveRequest(step) {
  const t = step.n8n?.type;
  return (step.kind === "model" && t === LC + "chainLlm") || (step.kind === "agent" && t === LC + "agent");
}
function schemaFromExample(v) {
  if (Array.isArray(v)) return { type: "array", items: v.length ? schemaFromExample(v[0]) : {} };
  if (v === null) return { type: "null" };
  if (typeof v === "object") return { type: "object", properties: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, schemaFromExample(x)])) };
  return { type: typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v };
}
function outputSchemaOf(exec) {
  const [parser] = subnodesOf(exec, "ai_outputParser");
  if (!parser) return undefined;
  if (parser.step.n8n.type !== LC + "outputParserStructured") throw unsupported(exec, `Output parser ${parser.step.n8n.type}`);
  const p = parser.step.params ?? {};
  const type = p.schemaType ?? (parser.step.n8n.typeVersion >= 1.2 ? "fromJson" : "manual");
  try {
    if (type === "manual") return typeof p.inputSchema === "string" ? JSON.parse(p.inputSchema) : p.inputSchema;
    const example = typeof p.jsonSchemaExample === "string" ? parseJsonLoose(p.jsonSchemaExample) : p.jsonSchemaExample ?? { state: "California", cities: ["Los Angeles", "San Francisco", "San Diego"] };
    return schemaFromExample(example);
  } catch {
    throw err(exec, "The Structured Output Parser schema is not valid JSON");
  }
}
const parseJsonLoose = (t) => JSON.parse(String(t).replace(/,\s*([}\]])/g, "$1"));
function modelNameOf(exec) {
  const [m] = subnodesOf(exec, "ai_languageModel");
  if (!m) throw err(exec, "Please connect a model to the Chat Model input");
  const v = m.step.params?.model;
  return { model: typeof v === "object" && v !== null ? v.value : v, provider: m.step.n8n.type.replace(LC, "") };
}
function promptOf(exec, i, inputKey) {
  const v = exec.typeVersion;
  let prompt;
  if (exec.step.n8n.type === LC + "chainLlm" && v <= 1.3) prompt = exec.param("prompt", i, v === 1 ? "={{ $json.input }}" : v === 1.1 ? "={{ $json.chat_input }}" : "={{ $json.chatInput }}");
  else {
    const type = exec.param("promptType", i, exec.step.n8n.type === LC + "agent" && v < 1.5 ? "auto" : "auto");
    if (type === "auto") prompt = exec.evaluate('={{ $json["chatInput"] }}', i);
    else if (type === "define") prompt = exec.param(inputKey, i, "");
    else throw unsupported(exec, `Prompt type "${type}"`);
    if (prompt === undefined) throw err(exec, "No prompt specified", { itemIndex: i, description: type === "auto" ? "Expected to find the prompt in an input field called 'chatInput' (this is what the chat trigger node outputs). To use something else, change the 'Prompt' parameter" : undefined });
  }
  return prompt;
}
const toolName = (name) => name.replace(/[^a-zA-Z0-9_-]/g, "_");
function agentTools(exec) {
  return subnodesOf(exec, "ai_tool").map(({ name, step }) => {
    const p = step.params ?? {};
    const tool = { name: toolName(name), node: name, n8nType: step.n8n.type, description: p.toolDescription ?? p.description ?? "" };
    if (step.tool?.connector) Object.assign(tool, { connector: step.tool.connector, tool: step.tool.name, effect: step.tool.effect ?? "write" });
    else if (step.n8n.type === LC + "toolCode") Object.assign(tool, { kind: "code", language: p.language ?? "javaScript", code: p.jsCode ?? p.code, effect: "none" });
    else if (step.n8n.type === LC + "toolHttpRequest" || step.n8n.type === BASE + "httpRequestTool") Object.assign(tool, { kind: "http", method: p.method ?? "GET", url: typeof p.url === "string" && !p.url.startsWith("=") ? p.url : undefined, effect: (p.method ?? "GET") === "GET" ? "read" : "write" });
    else Object.assign(tool, { kind: "n8n", params: p, effect: "write" });
    return tool;
  });
}

// Model step: step.model = {prompt, system?, messages?, outputSchema?, outputKey?, model?}.
const modelStep = {
  versions: () => true,
  async execute(exec) {
    const items = exec.getInputData();
    let m = exec.step.model;
    let derived = false;
    if (!m) {
      if (!canDeriveRequest(exec.step)) throw unsupported(exec, "A model step without model.prompt");
      derived = true;
      m = { outputSchema: outputSchemaOf(exec), ...modelNameOf(exec) };
    }
    if (!derived && m.prompt === undefined && !m.messages) throw unsupported(exec, "A model step without model.prompt");
    const reqs = items.map((_, i) => {
      const r = { kind: "model", itemIndex: i };
      if (derived) {
        r.prompt = promptOf(exec, i, "text");
        const messages = exec.param("messages.messageValues", i, []).map((x) => ({ role: { AIMessagePromptTemplate: "assistant", HumanMessagePromptTemplate: "user" }[x.type] ?? "system", type: x.messageType ?? "text", content: x.message ?? x.imageUrl }));
        if (messages.some((x) => x.type !== "text")) throw unsupported(exec, "Image messages in the Basic LLM Chain");
        const system = messages.filter((x) => x.role === "system").map((x) => x.content);
        if (system.length) r.system = system.join("\n");
        const rest = messages.filter((x) => x.role !== "system").map(({ role, content }) => ({ role, content }));
        if (rest.length) r.messages = rest;
      } else {
        r.prompt = exec.evaluate(m.prompt ?? "", i);
        if (m.system !== undefined) r.system = exec.evaluate(m.system, i);
        if (m.messages) r.messages = exec.evaluate(m.messages, i);
      }
      if (m.outputSchema) r.outputSchema = m.outputSchema;
      if (m.model) r.model = m.model;
      return r;
    });
    const results = await exec.request(reqs);
    if (m.outputKey || !derived) return [toItems(exec, results, items, "model", m.outputKey ?? (m.outputSchema ? "output" : "text"))];
    // chainLlm formatResponse: strings trimmed into {text}; arrays {data}; objects unwrapped.
    const unwrap = exec.typeVersion >= 1.6 || !!m.outputSchema;
    return [
      results.map((r, i) => {
        if (!r.ok) {
          const e = err(exec, r.error?.message ?? "model call failed", { itemIndex: i });
          if (!exec.continueOnFail()) throw e;
          return { json: { error: e.message }, pairedItem: { item: i } };
        }
        let v = r.value;
        if (m.outputSchema && v !== null && typeof v === "object" && !Array.isArray(v)) v = { output: v };
        const json = typeof v === "string" ? { text: v.trim() } : Array.isArray(v) ? { data: v } : v && typeof v === "object" ? (unwrap ? v : { text: JSON.stringify(v) }) : { response: { text: v } };
        return { json, pairedItem: { item: i } };
      }),
    ];
  },
};

// Agent step: step.agent = {prompt, system?, tools: [...], memoryKey?, outputSchema?}.
const agentStep = {
  versions: () => true,
  async execute(exec) {
    const items = exec.getInputData();
    let a = exec.step.agent;
    const derived = !a;
    if (derived) {
      if (!canDeriveRequest(exec.step)) throw unsupported(exec, "An agent step without agent.prompt");
      const [memory] = subnodesOf(exec, "ai_memory");
      a = { tools: agentTools(exec), outputSchema: exec.params.hasOutputParser ? outputSchemaOf(exec) : undefined, ...modelNameOf(exec), memory };
    } else if (a.prompt === undefined) throw unsupported(exec, "An agent step without agent.prompt");
    const reqs = items.map((_, i) => {
      const r = { kind: "agent", itemIndex: i, tools: a.tools ?? [] };
      if (derived) {
        r.prompt = promptOf(exec, i, "text");
        r.system = exec.param("options.systemMessage", i, "You are a helpful assistant");
        if (a.memory) {
          const mp = a.memory.step.params ?? {};
          r.memoryKey = mp.sessionIdType === "customKey" ? exec.evaluate(mp.sessionKey ?? "", i) : exec.evaluate("={{ $json.sessionId }}", i);
          r.memoryWindow = mp.contextWindowLength ?? 5;
        }
        const maxIterations = exec.param("options.maxIterations", i, 10);
        if (maxIterations) r.maxIterations = maxIterations;
        if (a.model) r.model = a.model;
      } else {
        r.prompt = exec.evaluate(a.prompt, i);
        if (a.system !== undefined) r.system = exec.evaluate(a.system, i);
        if (a.memoryKey !== undefined) r.memoryKey = exec.evaluate(a.memoryKey, i);
        if (a.maxIterations) r.maxIterations = a.maxIterations;
      }
      if (a.outputSchema) r.outputSchema = a.outputSchema;
      return r;
    });
    const results = await exec.request(reqs);
    return [toItems(exec, results, items, "agent", a.outputKey ?? "output")];
  },
};

export function requestImplFor(step) {
  if (step.kind === "tool") return toolStep;
  if (step.kind === "model") return modelStep;
  if (step.kind === "agent") return agentStep;
  if (step.n8n?.type === BASE + "httpRequest" && httpRequest.versions(step.n8n?.typeVersion ?? 1)) return httpRequest;
  return null;
}
