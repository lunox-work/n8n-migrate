// Node implementations, group 2 (Sort, Remove Duplicates, Summarize, Date & Time, Crypto,
// Respond to Webhook, Item Lists, Html template/table, Execution Data) and the steps that
// become host requests (HTTP Request, connector tools, model and agent steps).
//
// Not implemented, on purpose: Markdown (n8n converts with showdown / node-html-markdown;
// a partial converter would produce silently different HTML), Html "extract" and HTML
// Extract (need a DOM / cheerio selector engine), Date & Time v1 (moment format strings),
// Crypto "sign" (private keys), HTTP pagination and binary bodies. Preflight reports them.

import { restPrograms } from "./rest.mjs";
import { NodeError, UnsupportedNode, deepCopy, getPath, setPath, unsetPath, isEqual, isObject } from "./util.mjs";
import { hashHex, hmacBytes, digestBytes, bytesToBase64, toHex } from "./hash.mjs";
import { tryToParseDateTime } from "./extensions.mjs";
import { DateTime } from "../vendor/luxon.mjs";
import { adaptResult, coerceArgs, applyCursorArg, advanceCursor, getAt } from "./adapt.mjs";
import { resolveParameter, compileCode } from "./expression.mjs";
import { createLookup } from "./proxy.mjs";

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
// n8n DateTime v2 parseDate: anything Number() accepts is a timestamp (so null, "" and
// false are 0, the epoch; fewer than 12 digits means seconds), a string goes through
// moment (ISO, else Date parsing), undefined is moment(undefined) = now. Observed from
// n8n 2.47.7 (tests/fixtures/n8n-observed/datetime-empty.json).
function parseDate(exec, date, { timezone, fromFormat } = {}) {
  if (DateTime.isDateTime(date)) return date;
  if (!Number.isNaN(Number(date)) && !fromFormat) {
    date = Number(date);
    if (!Number.isInteger(date)) date *= 1000;
  }
  let zone = timezone;
  let d;
  if (Number.isInteger(date)) d = String(date).length < 12 ? DateTime.fromSeconds(date) : DateTime.fromMillis(date);
  else {
    if (!zone && typeof date !== "string") throw err(exec, `Cannot read properties of ${date === undefined ? "undefined" : "an object"} (reading 'includes')`);
    if (!zone && date.includes("+")) zone = `Etc/GMT-${Number(date.split("+")[1].slice(0, 2))}`;
    if (date === undefined) d = DateTime.fromMillis(exec.run.clock.now);
    else if (fromFormat) d = DateTime.fromFormat(String(date), fromFormat);
    else {
      const s = String(date);
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
// The "Received ..." tail of Node's ERR_INVALID_ARG_TYPE message.
function receivedType(v) {
  if (v === undefined || v === null) return `Received ${v}`;
  if (typeof v === "function") return `Received function ${v.name}`;
  if (typeof v === "object") return `Received an instance of ${v.constructor?.name ?? "Object"}`;
  let shown = typeof v === "string" ? JSON.stringify(v).replace(/^"|"$/g, "'") : String(v);
  if (shown.length > 28) shown = `${shown.slice(0, 25)}...`;
  return `Received type ${typeof v} (${shown})`;
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
          // node:crypto's update() takes only text or bytes (n8n passes the value as is).
          if (typeof value !== "string") throw err(exec, `The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. ${receivedType(value)}`, { itemIndex: i });
          const bytes = action === "hash" ? digestBytes(alg, value) : hmacBytes(alg, String(exec.param("secret", i)), value);
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

// n8n validates the Redirect URL parameter (validateType "url", tryToParseUrl): a value
// without "://" gets "https://", and it must parse with an http/https/ftp/file protocol.
function redirectUrl(exec, value) {
  if (value === null || value === undefined) return value;
  let v = value;
  if (typeof v === "string" && !v.includes("://")) v = `https://${v}`;
  let ok = false;
  try {
    ok = ["http:", "https:", "ftp:", "file:"].includes(new URL(String(v)).protocol);
  } catch {}
  if (!ok) throw err(exec, "Invalid input for 'Redirect URL' [item 0]", { description: `'Redirect URL' expects a url but we got '${value}'` });
  return String(v);
}

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
        headers.location = redirectUrl(exec, exec.param("redirectURL", 0));
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

// Item Lists v1 "Split Out Items" (n8n ItemListsV1): one field; a missing field or a value
// that is not a list fails the node; object elements merge into the item when no other
// fields are kept and no destination field is set.
function itemListsSplitV1(exec) {
  const items = exec.getInputData();
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const field = exec.param("fieldToSplitOut", i);
    const noDot = exec.param("options.disableDotNotation", 0, false);
    const dest = exec.param("options.destinationFieldName", i, "");
    const include = exec.param("include", i, "noOtherFields");
    const list = noDot ? items[i].json[field] : getPath(items[i].json, field);
    if (list === undefined) throw err(exec, `Couldn't find the field '${field}' in the input data`, { itemIndex: i });
    if (!Array.isArray(list)) throw err(exec, `The provided field '${field}' is not an array`, { itemIndex: i });
    for (const el of list) {
      let n = {};
      if (include === "selectedOtherFields") {
        const keep = exec.param("fieldsToInclude.fields", i, []).map((f) => f.fieldName);
        if (!keep.length) throw err(exec, "No fields specified", { description: "Please add a field to include" });
        for (const f of keep) if (f !== field) n[f] = noDot ? items[i].json[f] : getPath(items[i].json, f);
      } else if (include === "allOtherFields") {
        for (const k of Object.keys(items[i].json)) n[k] = noDot ? items[i].json[k] : getPath(items[i].json, k);
        unsetPath(n, field);
      }
      if (typeof el === "object" && include === "noOtherFields" && dest === "") n = { ...n, ...el };
      else n = { ...n, [dest || field]: el };
      out.push({ json: n, pairedItem: { item: i } });
    }
  }
  return [out];
}
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
    if (op === "splitOutItems" && exec.typeVersion < 2) return itemListsSplitV1(exec);
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
    if (op === "generateHtmlTemplate") {
      // n8n resolves each {{ ... }} left in the (already resolved) html with
      // evaluateExpression and String.replace, first occurrence each.
      return [
        items.map((_, i) => {
          let h = exec.param("html", i);
          if (typeof h === "string") for (const r of h.match(/{{[\s\S]*?}}/g) ?? []) h = h.replace(r, exec.evaluate(`=${r}`, i));
          return { json: { html: h }, pairedItem: { item: i } };
        }),
      ];
    }
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

// n8n HttpRequestV3 builds key-value parameters with updadeQueryParameterConfig: before
// 4.3 a repeated name keeps the last value, from 4.3 it collects the values in a list.
// A multipart body from n8n's key-value list (HttpRequestV3 parametersToKeyValue): a form
// field keeps its value; a formBinaryData field becomes a file part from the item's binary
// property inputDataFieldName (left out without one), {$file: {fileName, mimeType, data}} with
// data in base64, as the host encodes it (driver.mjs multipartBody). Repeated names follow
// keyPairs (a list from 4.3, with multipart from 4.2).
function multipartPairs(exec, i, list, version) {
  const out = {};
  const binary = exec.getInputData()[i]?.binary ?? {};
  for (const p of list ?? []) {
    if (!p) continue;
    let value = p.value;
    if (p.parameterType === "formBinaryData") {
      if (!p.inputDataFieldName) continue;
      const b = binary[p.inputDataFieldName];
      if (!b) throw err(exec, `This operation expects the node's input data to contain a binary file '${p.inputDataFieldName}', but none was found [item ${i}]`, { itemIndex: i });
      if (typeof b.data !== "string" || b.id) throw unsupported(exec, "HTTP Request file parts from stored binary data");
      value = { $file: { fileName: b.fileName, mimeType: b.mimeType, data: b.data } };
    }
    if (version < 4.3 || out[p.name] === undefined) out[p.name] = value;
    else if (Array.isArray(out[p.name])) out[p.name].push(value);
    else out[p.name] = [out[p.name], value];
  }
  return out;
}

function keyPairs(list, version) {
  const out = {};
  for (const p of list ?? []) {
    if (!p) continue;
    if (version < 4.3 || out[p.name] === undefined) out[p.name] = p.value;
    else if (Array.isArray(out[p.name])) out[p.name].push(p.value);
    else out[p.name] = [out[p.name], p.value];
  }
  return out;
}
// HttpRequestV3's parseJsonParameter: plain JSON.parse with its error message.
const jsonParam = (exec, v, field, i) => {
  try {
    return JSON.parse(v);
  } catch (e) {
    throw err(exec, `The value in the "${field}" field is not valid JSON`, { itemIndex: i, description: e.message });
  }
};
const ACCEPT = {
  json: "application/json,text/*;q=0.99",
  text: "application/json,text/html,application/xhtml+xml,application/xml,text/*;q=0.9, */*;q=0.1",
  other: "application/json,text/html,application/xhtml+xml,application/xml,text/*;q=0.9, image/*;q=0.8, */*;q=0.7",
};
const METHODS_WITHOUT_BODY = ["HEAD", "OPTIONS", "TRACE"];

// HTTP Request v3/v4.x -> an `http` request per item, built as n8n HttpRequestV3 builds
// its request options: URL checks, query/headers/body from key-value lists or JSON, header
// names lowercased (option lowercaseHeaders, default on), the default accept header for
// the response format, raw bodies with their content type.
export function buildHttpRequest(exec, i) {
  const v = exec.typeVersion;
  const p = (k, fb) => exec.param(k, i, fb);
  let url = p("url", "");
  if (typeof url !== "string") throw err(exec, `URL parameter must be a string, got ${url === null ? "null" : typeof url}`, { itemIndex: i });
  url = url.trim();
  if (!url) throw err(exec, "URL parameter cannot be empty", { itemIndex: i });
  if (!url.startsWith("http://") && !url.startsWith("https://")) throw err(exec, `Invalid URL: ${url}. URL must start with "http" or "https".`, { itemIndex: i });
  const method = String(p("method", "GET")).toUpperCase();
  const options = p("options", {});
  if (options.pagination?.pagination || exec.params.options?.pagination) throw unsupported(exec, "HTTP Request pagination");
  const r = options.response?.response ?? {};
  const responseFormat = r.responseFormat || "autodetect";
  if (responseFormat === "file") throw unsupported(exec, "HTTP Request file responses");
  const req = { kind: "http", itemIndex: i, method, url, headers: {}, query: {} };
  const sendBody = p("sendBody", false);
  const ct = p("contentType", "json");
  if (sendBody) {
    const specifyBody = p("specifyBody", "keypair");
    const list = p("bodyParameters.parameters", []);
    let body;
    if (specifyBody === "keypair" || ct === "multipart-form-data") {
      if (ct !== "multipart-form-data" && list.some((x) => x?.parameterType === "formBinaryData")) throw unsupported(exec, "HTTP Request binary form fields outside a multipart body");
      if (ct === "json" && v >= 4) {
        body = {};
        for (const e of list) setPath(body, e.name, e.value);
      } else if (ct === "multipart-form-data") body = multipartPairs(exec, i, list, v >= 4.2 ? 4.3 : v);
      else body = keyPairs(list, v);
    } else if (specifyBody === "json") {
      const jb = p("jsonBody", "");
      body = typeof jb !== "object" && jb !== null ? jsonParam(exec, jb, "JSON Body", i) : jb;
    } else if (specifyBody === "string") body = Object.fromEntries(new URLSearchParams(String(p("body", ""))));
    if (!METHODS_WITHOUT_BODY.includes(method)) {
      if (ct === "binaryData") throw unsupported(exec, "HTTP Request binary bodies");
      if (ct === "raw") body = p("body", "");
    }
    if (body !== undefined) req.body = body;
    req.contentType = ct;
  }
  if (p("sendQuery", false)) {
    if (p("specifyQuery", "keypair") === "keypair") req.query = keyPairs(p("queryParameters.parameters", []), v);
    else req.query = jsonParam(exec, p("jsonQuery", ""), "JSON Query Parameters", i);
  }
  if (p("sendHeaders", false)) {
    const extra = p("specifyHeaders", "keypair") === "keypair" ? keyPairs(p("headerParameters.parameters", []).filter((h) => h?.name), v) : jsonParam(exec, p("jsonHeaders", ""), "JSON Headers", i);
    const lower = options.lowercaseHeaders === undefined || options.lowercaseHeaders;
    req.headers = lower ? Object.fromEntries(Object.entries(extra ?? {}).map(([k, x]) => [k.toLowerCase(), x])) : { ...extra };
  }
  if (sendBody && ct === "raw") req.headers["content-type"] = p("rawContentType", "");
  // Lists in the query and in a form body are encoded with qs, "indices" by default
  // (a[0]=1&a[1]=2); the option queryParameterArrays (brackets / repeat) applies to the query
  // only. Observed from n8n 2.47.7 (tests/fixtures/n8n-observed/http-request-build.json).
  const hasList = (o) => o && typeof o === "object" && Object.values(o).some(Array.isArray);
  if (hasList(req.query)) req.queryArrayFormat = options.queryParameterArrays || "indices";
  if (req.contentType === "form-urlencoded" && hasList(req.body)) req.formArrayFormat = "indices";
  const auth = exec.step.auth;
  const authentication = p("authentication", "none");
  if (authentication !== "none") {
    if (!auth?.secret) throw err(exec, "HTTP Request uses a credential the definition does not name (step.auth)");
    req.auth = { credentialType: auth.credentialType ?? (authentication === "genericCredentialType" ? p("genericAuthType", "") : p("nodeCredentialType", "")), secret: auth.secret };
  }
  if (req.headers.accept === undefined) req.headers.accept = ACCEPT[responseFormat] ?? ACCEPT.other;
  if (options.timeout) req.timeoutMs = options.timeout;
  if (options.redirect?.redirect?.followRedirects === false) req.followRedirects = false;
  req.response = { format: responseFormat, fullResponse: !!r.fullResponse, neverError: !!r.neverError };
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
    if (!res.ok) return [{ json: { error: { message } }, pairedItem: { item: i } }];
    // With continue-on-fail n8n puts the rejected request's error itself in the item: axios's
    // AxiosError as n8n's request helper shapes it, "<status> - <body as JSON>" (the body is
    // the raw text unless the format is json/text, which parse it), minus the server stack.
    let shown = body;
    if (fmt.format !== "autodetect" && typeof shown === "string") {
      try {
        shown = JSON.parse(shown);
      } catch {}
    }
    const text = status === 429 ? "Try spacing your requests out using the batching settings under 'Options'" : `${status} - ${JSON.stringify(shown ?? "")}`;
    return [{ json: { error: { message: text, name: "AxiosError", code: status < 500 ? "ERR_BAD_REQUEST" : "ERR_BAD_RESPONSE", status } }, pairedItem: { item: i } }];
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
  // An explicit json or text format asks for a JSON response (request option json: true):
  // a JSON body arrives parsed, an empty one as undefined (observed from n8n 2.47.7,
  // tests/fixtures/n8n-observed/http-empty-bodies.json).
  if (fmt.format !== "autodetect" && typeof body === "string") {
    if (body === "") body = undefined;
    else {
      try {
        body = JSON.parse(body);
      } catch {}
    }
  }
  if (format === "text") {
    const text = body === undefined || body === null ? body : typeof body === "string" ? body : JSON.stringify(body);
    if (fmt.fullResponse) return [{ json: { data: text, headers, statusCode: status, statusMessage }, pairedItem: pi }];
    return [{ json: { data: text }, pairedItem: pi }];
  }
  if (body === undefined && format === "json" && !fmt.fullResponse) return [{ json: undefined, pairedItem: pi }];
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
    // n8n then checks returnItems[0].json.data for its Split Out hint: a single item without
    // json (an empty body with an explicit json format) fails the node there.
    if (out.length === 1 && out[0].json === undefined) throw err(exec, "Cannot read properties of undefined (reading 'data')");
    return [out];
  },
};

// Connector tool step: step.tool = {connector, name, args, effect, coerce?, result?}. Args are
// evaluated per item (n8n expressions stay expressions in the definition), coerced to the
// tool's input types, and the tool's output becomes n8n-shaped items through the declarative
// result adapter (adapt.mjs). Without an adapter, a list becomes one item per element.
const toolStep = {
  versions: () => true,
  async execute(exec) {
    const t = exec.step.tool;
    if (!t?.connector || !t?.name) throw unsupported(exec, "A tool step without tool.connector and tool.name");
    const items = exec.getInputData();
    const argsList = items.map((_, i) => toolArgs(exec, t, i));
    if (t.recipients) for (let i = 0; i < items.length; i++) argsList[i] = await replyRecipients(exec, t, argsList[i], i);
    const reqs = items.map((_, i) => ({ kind: "tool", itemIndex: i, connector: t.connector, tool: t.name, args: argsList[i], effect: t.effect }));
    const results = await exec.request(reqs);
    if (!t.result) return [toItems(exec, results, items, "tool")];
    const adapted = adaptedItems(exec, results, t.result, "tool");
    if (!t.lookup) return [adapted];
    // Row filters per input item, on that item's rows (n8n reads once per item from 4.2).
    const out = [];
    items.forEach((_, i) => {
      const rows = adapted.filter((it) => it.pairedItem?.item === i && !it.json.error);
      const errs = adapted.filter((it) => it.pairedItem?.item === i && it.json.error);
      out.push(...errs, ...applyLookup(exec, rows.map((it) => it.json), exec.evaluate(t.lookup, i)).map((json) => ({ json, pairedItem: { item: i } })));
    });
    return [out];
  },
};

// n8n's GoogleSheet.lookupValues on rows already keyed by the header: a cell matches when its
// text equals the filter value (missing cells are ""); OR takes, per filter, the matching rows
// in sheet order (only the first unless returnAll; from 4.6 the first match ends the lookup),
// AND keeps rows matching every filter. A filter column the sheet lacks fails the step.
export function applyLookup(exec, rows, lookup) {
  const filters = lookup.filters ?? [];
  const keys = new Set(rows.flatMap((r) => Object.keys(r)));
  for (const f of filters) if (rows.length && !keys.has(String(f.lookupColumn))) throw err(exec, `The column "${f.lookupColumn}" could not be found`);
  const cell = (r, f) => String(r[f.lookupColumn] ?? "");
  const hit = (r, f) => cell(r, f) === String(f.lookupValue ?? "");
  const picked = [];
  if (lookup.combine === "AND") {
    for (const r of rows) {
      if (!filters.every((f) => hit(r, f))) continue;
      picked.push(r);
      if (!lookup.returnAll) break;
    }
    return picked;
  }
  outer: for (const f of filters) {
    for (const r of rows) {
      if (!hit(r, f)) continue;
      if (!picked.includes(r)) picked.push(r);
      if (!lookup.returnAll) {
        if (lookup.stopAtFirst) break outer;
        continue outer;
      }
    }
  }
  return picked;
}

function toolArgs(exec, t, i, locals) {
  const raw = locals ? resolveParameter(t.args ?? {}, () => exec.scope(i, { locals })) : exec.evaluate(t.args ?? {}, i);
  return coerceArgs(t.coerce, raw);
}

// ---------- reply recipients (t.recipients) ----------
// n8n's Gmail reply addresses the reply from the replied-to message's headers (From; Reply-To
// from node 2.2 when present). The connector's reply tool picks its own default recipients, and
// a hostile message's Reply-To may be among them, so the runner reads the message first and
// passes the recipients explicitly. A message field may be a plain address, "Name <a@b>", a
// comma list, a list, or the REST payload's headers.
function messageField(m, name) {
  if (!isObject(m)) return undefined;
  if (m[name] !== undefined && m[name] !== null && m[name] !== "") return m[name];
  const lower = name.toLowerCase();
  const headers = Array.isArray(m.payload?.headers) ? m.payload.headers : Array.isArray(m.headers) ? m.headers : null;
  const h = headers?.find((x) => String(x?.name ?? "").toLowerCase() === lower);
  if (h?.value) return h.value;
  if (isObject(m.headers)) {
    const k = Object.keys(m.headers).find((x) => x.toLowerCase() === lower);
    if (k && m.headers[k]) return m.headers[k];
  }
  return undefined;
}
function addressesOf(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap(addressesOf);
  if (isObject(v)) return v.address ? [String(v.address)] : v.value ? addressesOf(v.value) : v.text ? addressesOf(v.text) : [];
  return String(v)
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((x) => (/<([^>]+)>/.exec(x)?.[1] ?? x).trim())
    .filter((x) => /@/.test(x));
}
async function replyRecipients(exec, t, args, i) {
  const r = t.recipients;
  if (!r || args[r.arg] !== undefined) return args;
  const id = args[r.idArg];
  if (id === undefined || id === null || id === "") return args;
  const [res] = await exec.request([{ kind: "tool", itemIndex: i, connector: t.connector, tool: r.tool, args: { [r.idArg]: id }, effect: "read" }]);
  if (!res.ok) throw err(exec, `could not read the message to reply to: ${res.error?.message ?? "tool call failed"}`, { itemIndex: i });
  const pick = (fields) => {
    for (const f of fields ?? []) {
      const a = addressesOf(messageField(res.value, f));
      if (a.length) return a;
    }
    return [];
  };
  // A message without a sender gets an empty list, as n8n's request has no recipient then
  // (Gmail itself refuses such a message); the connector is never left to choose.
  const to = r.replyTo ? (pick(r.replyTo).length ? pick(r.replyTo) : pick(r.from)) : pick(r.from);
  return { ...args, [r.arg]: to };
}

function adaptedItems(exec, results, spec, what) {
  const out = [];
  results.forEach((r, i) => {
    if (!r.ok) {
      const e = err(exec, r.error?.message ?? `${what} call failed`, { itemIndex: i });
      if (!exec.continueOnFail()) throw e;
      out.push({ json: { error: e.message }, pairedItem: { item: i } });
      return;
    }
    for (const json of adaptResult(spec, r.value)) out.push({ json, pairedItem: { item: i } });
  });
  return out;
}

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

// ---------- request templates (app REST APIs without a connector tool) ----------
// step.http = {method, url, query?, headers?, body?, contentType?, result?}: one request per
// item, values evaluated like n8n parameters. The credential is step.auth = {credentialType,
// secret, placement?}: the host attaches it (placement "header", the default) or replaces the
// literal `{{secret}}` in the URL with it (placement "url", e.g. Telegram's /bot<token>/).
// The URL keeps the placeholder literal, so the runner never sees the value. A 4xx/5xx
// fails the step (continue-on-fail gives an error item); a JSON body is parsed.

function templateRequest(exec, h, i, locals) {
  const ev = (v) => (locals ? resolveParameter(v, () => exec.scope(i, { locals })) : exec.evaluate(v, i));
  const url = ev(h.url);
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw err(exec, `Invalid URL: ${url}`, { itemIndex: i });
  const req = { kind: "http", itemIndex: i, method: String(ev(h.method ?? "GET")).toUpperCase(), url, headers: coerceArgs(null, ev(h.headers ?? {})), query: coerceArgs(null, ev(h.query ?? {})) };
  if (h.body !== undefined) {
    req.body = isObject(h.body) ? coerceArgs(h.coerce, ev(h.body)) : ev(h.body);
    req.contentType = h.contentType ?? "json";
  }
  const auth = exec.step.auth;
  if (auth?.secret) req.auth = { credentialType: auth.credentialType, secret: auth.secret, ...(auth.placement ? { placement: auth.placement } : {}) };
  return req;
}

function templateValue(res) {
  const v = res.value ?? {};
  const status = Number(v.status ?? v.statusCode ?? 200);
  let body = v.body;
  if (typeof body === "string") {
    const t = body.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        body = JSON.parse(t);
      } catch {
        /* keep text */
      }
    }
  }
  return { status, body };
}

const httpTemplateStep = {
  versions: () => true,
  async execute(exec) {
    const h = exec.step.http;
    const items = exec.getInputData();
    const reqs = items.map((_, i) => templateRequest(exec, h, i));
    const results = await exec.request(reqs);
    const out = [];
    results.forEach((r, i) => {
      const { status, body } = r.ok ? templateValue(r) : { status: 0 };
      if (!r.ok || status >= 400) {
        const message = r.ok ? `${status} - ${typeof body === "string" ? body : JSON.stringify(body)}` : r.error?.message ?? "request failed";
        if (!exec.continueOnFail()) throw err(exec, message, { itemIndex: i, httpCode: r.ok ? String(status) : undefined });
        out.push({ json: { error: message }, pairedItem: { item: i } });
        return;
      }
      for (const json of adaptResult(h.result, body ?? {})) out.push({ json, pairedItem: { item: i } });
    });
    return [out];
  },
};

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
    if (step.tool?.connector) Object.assign(tool, { kind: "connector", connector: step.tool.connector, tool: step.tool.name, effect: step.tool.effect ?? "write" });
    else if (step.n8n.type === LC + "toolCode") Object.assign(tool, { kind: "code", effect: "none" });
    else if (step.kind === "http" && isObject(step.rest)) Object.assign(tool, { kind: "rest", effect: step.rest.effect ?? "write" });
    else if (step.n8n.type === LC + "toolHttpRequest" || step.n8n.type === BASE + "httpRequestTool") Object.assign(tool, { kind: "http", method: p.method ?? "GET", url: typeof p.url === "string" && !p.url.startsWith("=") ? p.url : undefined, effect: (p.method ?? "GET") === "GET" ? "read" : "write" });
    else Object.assign(tool, { kind: "n8n", effect: "write" });
    return tool;
  });
}

// Shapes a model result as the n8n node does (explicit blocks):
//   outputTemplate: JSON in which the string "$output" is replaced by the result and
//     "$output.<path>" by a part of it (OpenAI's {index, message: {role, content: "$output"}},
//     Sentiment Analysis's {sentimentAnalysis: {category: "$output.sentiment"}});
//     outputKey: {[key]: result}.
//   trim: strings are trimmed first (chainLlm).
//   passInput: the shaped result is merged into the input item's json (Sentiment Analysis).
//   route: {mode: "flags" | "value", field?, outputs: [names]}: the step has one output per
//     name; "flags" sends the input item to every output whose name is true in the result
//     (Text Classifier), "value" to the output named by result[field] (Sentiment Analysis).
function shapeModelValue(m, v) {
  if (m.trim && typeof v === "string") v = v.trim();
  if (m.outputTemplate !== undefined) return fillTemplate(m.outputTemplate, v);
  return { [m.outputKey ?? (m.outputSchema ? "output" : "text")]: v };
}
function fillTemplate(t, v) {
  if (t === "$output") return deepCopy(v);
  if (typeof t === "string" && t.startsWith("$output.")) return deepCopy(getAt(v, t.slice(8)));
  if (Array.isArray(t)) return t.map((x) => fillTemplate(x, v));
  if (isObject(t)) return Object.fromEntries(Object.entries(t).map(([k, x]) => [k, fillTemplate(x, v)]));
  return t;
}

function modelOutputs(exec) {
  const r = exec.step.model?.route;
  return r ? r.outputs.length : 1;
}

// Model step: step.model = {prompt, system?, messages?, outputSchema?, outputKey?, ...}.
const modelStep = {
  versions: () => true,
  outputs: modelOutputs,
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
        if (m.prompt !== undefined) r.prompt = exec.evaluate(m.prompt, i);
        if (m.system !== undefined) r.system = exec.evaluate(m.system, i);
        if (m.messages) r.messages = exec.evaluate(m.messages, i);
      }
      if (m.outputSchema) r.outputSchema = m.outputSchema;
      if (derived && m.model) r.model = m.model;
      return r;
    });
    const results = await exec.request(reqs);
    if (!derived) {
      if (!m.route) {
        if (m.outputTemplate === undefined && !m.passInput && !m.trim) return [toItems(exec, results, items, "model", m.outputKey ?? (m.outputSchema ? "output" : "text"))];
        return [
          results.map((r, i) => {
            if (!r.ok) return failedItem(exec, r, i, "model");
            const shaped = shapeModelValue(m, r.value);
            return { json: m.passInput ? { ...items[i].json, ...shaped } : shaped, pairedItem: { item: i } };
          }),
        ];
      }
      const outs = m.route.outputs.map(() => []);
      results.forEach((r, i) => {
        if (!r.ok) return void outs[0].push(failedItem(exec, r, i, "model"));
        const v = isObject(r.value) ? r.value : {};
        const json = m.passInput ? { ...items[i].json, ...shapeModelValue(m, r.value) } : { ...items[i].json };
        m.route.outputs.forEach((name, k) => {
          const hit = m.route.mode === "value" ? String(v[m.route.field] ?? "").toLowerCase() === String(name).toLowerCase() : v[name] === true;
          if (hit) outs[k].push({ json: deepCopy(json), pairedItem: { item: i } });
        });
      });
      return outs;
    }
    // chainLlm formatResponse: strings trimmed into {text}; arrays {data}; objects unwrapped.
    const unwrap = exec.typeVersion >= 1.6 || !!m.outputSchema;
    return [
      results.map((r, i) => {
        if (!r.ok) return failedItem(exec, r, i, "model");
        let v = r.value;
        if (m.outputSchema && v !== null && typeof v === "object" && !Array.isArray(v)) v = { output: v };
        const json = typeof v === "string" ? { text: v.trim() } : Array.isArray(v) ? { data: v } : v && typeof v === "object" ? (unwrap ? v : { text: JSON.stringify(v) }) : { response: { text: v } };
        return { json, pairedItem: { item: i } };
      }),
    ];
  },
};

function failedItem(exec, r, i, what) {
  const e = err(exec, r.error?.message ?? `${what} call failed`, { itemIndex: i });
  if (!exec.continueOnFail()) throw e;
  return { json: { error: e.message }, pairedItem: { item: i } };
}

// ---------- agent steps and the tool-call protocol ----------
//
// An agent step runs as turns. Each turn is one `agent` request to the host:
//   {kind: "agent", prompt, system, tools: [{name, description, inputSchema}], memory?:
//    {key, window}, maxIterations, outputSchema?, turn, transcript: [{calls, results}]}
// The host (the model, on Claude) answers either with the final output (any value), or with
// an intent to call tools: {intent: "tool-calls", calls: [{name, args}]}. The runner executes
// each call itself (executeAgentTool): it finds the tool in the step's own list, checks the
// arguments against the tool's input schema, and runs it as an ordinary request (connector
// tool, http) or in-process (code, sub-workflow), so containment, the effect ledger and the
// result log apply to every tool call exactly as to a step. The results go into the next
// turn's transcript. The host never executes a tool and never sees connector names, URLs or
// code: it gets names, descriptions and schemas only. More than maxIterations turns with
// tool calls fail the step as n8n's agent does. In step mode every turn and every tool call
// is its own request id (Agent#run#item, .1, .2, ...), so a resume replays to the same point.
// Memory (buffer window) is a key and a window size; the host keeps the conversation.

const TOOL_INTENT = "tool-calls";
// What a tool call hands back to the model: the adapted items, as a list when the adapter
// selects a list (items path or csv), else the single item.
function toolValue(spec, output) {
  const items = adaptResult(spec, output);
  return spec && (spec.items || spec.parse) ? items : items.length === 1 ? items[0] : items;
}
const isToolIntent = (v) => isObject(v) && v.intent === TOOL_INTENT && Array.isArray(v.calls);

function checkToolArgs(schema, args) {
  if (!isObject(schema)) return null;
  if (!isObject(args)) return "arguments must be an object";
  const missing = (schema.required ?? []).filter((k) => args[k] === undefined);
  if (missing.length) return `missing required argument${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`;
  if (schema.additionalProperties === false && isObject(schema.properties)) {
    const unknown = Object.keys(args).filter((k) => !(k in schema.properties));
    if (unknown.length) return `unknown argument${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`;
  }
  return null;
}

const fromAiLocals = (args) => {
  const f = (key, _description, _type, fallback) => (args[key] === undefined ? fallback : args[key]);
  return { $fromAI: f, $fromAi: f, $fromai: f };
};

// Runs one tool call of an agent step. Returns {ok, value} | {ok: false, error} for the
// transcript; throws only for what must stop the run (containment, suspend in step mode).
export async function executeAgentTool(exec, tools, call, itemIndex) {
  const spec = tools.find((t) => t.name === call?.name);
  if (!spec) return { ok: false, error: { message: `unknown tool "${call?.name}"` } };
  const args = isObject(call.args) ? call.args : {};
  const bad = checkToolArgs(spec.inputSchema, args);
  if (bad) return { ok: false, error: { message: bad } };
  const sub = spec.node ? exec.run.definition.steps[spec.node] : undefined;
  const locals = { ...fromAiLocals(args), query: args.query ?? args.input ?? JSON.stringify(args) };
  const kind = spec.kind ?? (spec.connector ? "connector" : undefined);
  try {
    if (kind === "connector") {
      const t = sub?.tool ?? { connector: spec.connector, name: spec.tool, effect: spec.effect };
      const toolArgsValue = sub?.tool ? await replyRecipients(exec, t, toolArgs(exec, t, itemIndex, locals), itemIndex) : args;
      const [r] = await exec.request([{ kind: "tool", itemIndex, connector: t.connector, tool: t.name, args: toolArgsValue, effect: t.effect }]);
      if (!r.ok) return { ok: false, error: { message: r.error?.message ?? "tool call failed" } };
      return { ok: true, value: t.result ? toolValue(t.result, r.value) : r.value };
    }
    if (kind === "http") {
      const h = sub?.http;
      if (!h) return { ok: false, error: { message: `tool "${spec.name}" has no request template` } };
      const subExec = Object.assign(Object.create(exec), { step: sub });
      const req = templateRequest(subExec, { ...h, url: fillPlaceholders(h.url, args), body: fillPlaceholders(h.body, args), query: fillPlaceholders(h.query, args) }, itemIndex, locals);
      const [r] = await exec.request([req]);
      if (!r.ok) return { ok: false, error: { message: r.error?.message ?? "request failed" } };
      const { status, body } = templateValue(r);
      if (status >= 400) return { ok: false, error: { message: `${status} - ${typeof body === "string" ? body : JSON.stringify(body)}` } };
      return { ok: true, value: h.result ? toolValue(h.result, body) : body };
    }
    if (kind === "rest") {
      // A node tool whose operation is a REST program (rest.mjs): the program runs as the tool
      // node on the agent's current item, its $fromAI() values from the model's arguments,
      // and hands back the items' JSON as n8n's node tools do.
      const prog = sub?.rest ? restPrograms[sub.rest.program] : undefined;
      if (!prog || !prog.versions(sub.n8n?.typeVersion ?? 1)) return { ok: false, error: { message: `tool "${spec.name}" has no REST program` } };
      const item = exec.getInputData()[itemIndex] ?? { json: {} };
      const subExec = Object.assign(Object.create(exec), {
        step: sub,
        params: { ...(sub.params ?? {}) },
        getInputData: () => [item],
        scope: (_i, extras) => exec.scope(itemIndex, { ...(extras ?? {}), locals: { ...(extras?.locals ?? {}), ...locals } }),
        request: (reqs) => exec.request(reqs.map((r) => ({ ...r, itemIndex }))),
      });
      const [outItems] = await prog.execute(subExec);
      const values = (outItems ?? []).map((it) => it.json);
      return { ok: true, value: values.length === 1 ? values[0] : values };
    }
    if (kind === "code") {
      const p = sub?.params ?? {};
      if ((p.language ?? "javaScript") !== "javaScript") return { ok: false, error: { message: "only JavaScript code tools run" } };
      const code = p.jsCode ?? p.code ?? "";
      const fn = compileCode(code);
      const lookup = createLookup(exec, itemIndex, { locals: { ...locals, ...args }, lenientMissing: true });
      const value = await fn.call({}, lookup.scope);
      return { ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) };
    }
    if (kind === "subflow") {
      if (!sub?.subflow) return { ok: false, error: { message: `tool "${spec.name}" has no sub-workflow in the definition` } };
      const input = isObject(sub.subflow.inputs) ? resolveParameter(sub.subflow.inputs, () => exec.scope(itemIndex, { locals })) : args;
      const { runSubflow } = exec.run.api;
      const res = await runSubflow(exec, sub.subflow, [{ json: isObject(input) ? input : { query: input } }], `${exec.name}#${exec.runIndex}#${itemIndex}/tool${(exec._toolCalls = (exec._toolCalls ?? 0) + 1)}`);
      const outItems = (res.output[0] ?? []).map((it) => it.json);
      return { ok: true, value: outItems.length === 1 ? outItems[0] : outItems };
    }
    return { ok: false, error: { message: `tool "${spec.name}" (${spec.n8nType ?? kind ?? "unknown kind"}) cannot run in the runtime` } };
  } catch (e) {
    if (e?.name === "Suspend" || e?.name === "ContainmentViolation" || e?.name === "BadInput") throw e;
    return { ok: false, error: { message: e?.message ?? String(e) } };
  }
}

// toolHttpRequest placeholders: {name} in the URL, query and body are the model's arguments.
function fillPlaceholders(v, args) {
  if (typeof v === "string") return v.replace(/\{([A-Za-z_][\w-]*)\}/g, (m, k) => (args[k] === undefined ? m : encodeURIComponent(String(args[k]))));
  if (Array.isArray(v)) return v.map((x) => fillPlaceholders(x, args));
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === "string" ? x.replace(/^\{([A-Za-z_][\w-]*)\}$/, (m, key) => (args[key] === undefined ? m : args[key])) : fillPlaceholders(x, args)]));
  return v;
}

const hostToolSpec = (t) => ({ name: t.name, description: t.description ?? "", ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}) });

// Agent step: step.agent = {prompt, system?, tools: [...], memory?, maxIterations?, outputSchema?}.
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
    const tools = a.tools ?? [];
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const base = { kind: "agent", itemIndex: i, tools: tools.map(hostToolSpec) };
      if (derived) {
        base.prompt = promptOf(exec, i, "text");
        base.system = exec.param("options.systemMessage", i, "You are a helpful assistant");
        if (a.memory) {
          const mp = a.memory.step.params ?? {};
          base.memory = { key: mp.sessionIdType === "customKey" ? exec.evaluate(mp.sessionKey ?? "", i) : exec.evaluate("={{ $json.sessionId }}", i), window: mp.contextWindowLength ?? 5 };
        }
        base.maxIterations = exec.param("options.maxIterations", i, 10);
        if (a.model) base.model = a.model;
      } else {
        base.prompt = exec.evaluate(a.prompt, i);
        // Text n8n adds after the evaluated prompt (an output parser's format instructions).
        if (a.promptAppend) base.prompt = `${base.prompt ?? ""}${a.promptAppend}`;
        if (a.system !== undefined) base.system = exec.evaluate(a.system, i);
        if (a.memory) base.memory = { key: exec.evaluate(a.memory.key ?? "={{ $json.sessionId }}", i), window: a.memory.window ?? 5 };
        else if (a.memoryKey !== undefined) base.memory = { key: exec.evaluate(a.memoryKey, i), window: 5 };
        base.maxIterations = a.maxIterations ?? 10;
      }
      if (a.outputSchema) base.outputSchema = a.outputSchema;
      const transcript = [];
      let final;
      let failure;
      for (let turn = 0; ; turn++) {
        const [r] = await exec.request([{ ...base, turn, transcript: deepCopy(transcript) }]);
        if (!r.ok) {
          failure = r;
          break;
        }
        if (!isToolIntent(r.value)) {
          final = r.value;
          break;
        }
        if (turn >= base.maxIterations) {
          failure = { ok: false, error: { message: "Agent stopped due to max iterations." } };
          break;
        }
        const results = [];
        for (const call of r.value.calls) results.push({ name: call?.name, ...(await executeAgentTool(exec, tools, call, i)) });
        transcript.push({ calls: deepCopy(r.value.calls), results });
      }
      if (failure) {
        out.push(failedItem(exec, failure, i, "agent"));
        continue;
      }
      if (a.wrapOutput && isObject(final)) final = { output: final };
      out.push({ json: { [a.outputKey ?? "output"]: final }, pairedItem: { item: i } });
    }
    return [out];
  },
};

// ---------- poll triggers ----------
// A trigger step with `poll: {tool: {connector, name, args, coerce?}, result, cursor}`. When
// the driver hands trigger items in, they are emitted as they are (the driver polled).
// Otherwise the runner polls: it calls the tool with the cursor in its arguments, adapts the
// output to n8n's item shape, keeps the items after the cursor and records the next cursor
// (run result `cursors`). With no cursor yet, a production run emits nothing and seeds the
// cursor (the first run never replays history); a manual run emits what it read. With
// `poll.detail`, each item to emit is read again (see below).

const pollTrigger = {
  versions: () => true,
  trigger: true,
  async execute(exec, ed) {
    const p = exec.step.poll;
    if (ed.triggerProvided) return [(ed.data.main[0] ?? []).map((it) => ({ json: it.json, ...(it.binary ? { binary: it.binary } : {}) }))];
    const run = exec.run;
    const cursor = run.cursorsIn?.[exec.name] ?? null;
    const t = p.tool;
    const args = applyCursorArg(p.cursor, coerceArgs(t.coerce, exec.evaluate(t.args ?? {}, 0)), cursor);
    const [r] = await exec.request([{ kind: "tool", itemIndex: 0, connector: t.connector, tool: t.name, args, effect: "read" }]);
    if (!r.ok) throw err(exec, r.error?.message ?? "poll failed");
    const all = adaptResult(p.result, r.value);
    const { items, cursor: next } = advanceCursor(p.cursor ?? {}, all, cursor);
    run.cursorsOut[exec.name] = next;
    let emit = cursor || run.mode === "manual" ? items : [];
    // poll.detail: n8n's trigger reads each new item again (Gmail: GET per message), so the
    // item carries what the list does not (display names, bodies). One call per emitted item,
    // after the cursor; the item is the detail result adapted by its own spec, with `keep`
    // fields taken from the list item when the detail result lacks them.
    const d = p.detail;
    if (isObject(d) && emit.length) {
      const base = coerceArgs(d.tool.coerce, exec.evaluate(d.tool.args ?? {}, 0));
      const rs = await exec.request(emit.map((j, k) => ({ kind: "tool", itemIndex: k, connector: d.tool.connector, tool: d.tool.name, args: { ...base, [d.idArg]: String(getAt(j, d.idField) ?? "") }, effect: "read" })));
      emit = rs.map((r, k) => {
        if (!r.ok) throw err(exec, r.error?.message ?? "poll detail failed", { itemIndex: k });
        const got = adaptResult(d.result ?? {}, r.value)[0] ?? {};
        const keep = (d.keep ?? []).filter((f) => got[f] === undefined && emit[k][f] !== undefined);
        if (!keep.length) return got;
        // Keep the adapter's field order: a kept field goes where the result spec lists it.
        const order = Object.keys(d.result?.fields ?? {});
        const out = {};
        for (const f of order) {
          if (got[f] !== undefined) out[f] = got[f];
          else if (keep.includes(f)) out[f] = deepCopy(emit[k][f]);
        }
        for (const [f, v] of Object.entries(got)) if (!(f in out)) out[f] = v;
        for (const f of keep) if (!(f in out)) out[f] = deepCopy(emit[k][f]);
        return out;
      });
    }
    return [emit.map((json) => ({ json }))];
  },
};

export function requestImplFor(step) {
  if (step.kind === "tool") return toolStep;
  if (step.kind === "model") return modelStep;
  if (step.kind === "agent") return agentStep;
  if (step.kind === "http" && isObject(step.http)) return httpTemplateStep;
  if (step.kind === "http" && isObject(step.rest)) {
    const prog = restPrograms[step.rest.program];
    return prog && prog.versions(step.n8n?.typeVersion ?? 1) ? prog : null;
  }
  if (step.kind === "trigger" && isObject(step.poll)) return pollTrigger;
  if (step.n8n?.type === BASE + "httpRequest" && httpRequest.versions(step.n8n?.typeVersion ?? 1)) return httpRequest;
  return null;
}
