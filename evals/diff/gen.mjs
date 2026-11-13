#!/usr/bin/env node
// Random but valid n8n workflows built from the logic nodes the runner implements, for the
// differential test. Seeded and reproducible: the same --seed and --count give the same
// workflows, item data and HTTP fixtures.
//
//   node evals/diff/gen.mjs --seed 1 --count 200 [--out dir]   (writes <label>.json files)
//
// Each workflow: a Manual Trigger (pinned with 1-4 random items) and 3-9 nodes chosen from
// Set 3.4, If 2.2, Filter 2.2, Switch 3.2, Merge 3.1 (append, combine by fields / position
// / all, choose branch), Code 2 (both modes, some throwing on some items), Split Out,
// Aggregate, Limit, Sort, Remove Duplicates, Summarize, Split In Batches v3 loops,
// Date & Time 2, Crypto, HTTP Request 4.2 to the mock (json, form and query bodies, error
// replies). Node settings vary: executeOnce, alwaysOutputData, onError (continue regular
// output, continue error output). Item data has edge values: empty strings, null, nested
// arrays, numbers as strings, unicode, missing fields.
//
// Returns [{label, workflow, fixtures}] from generate({seed, count}).

import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
    weighted: (pairs) => {
      const total = pairs.reduce((s, [, w]) => s + w, 0);
      let x = next() * total;
      for (const [v, w] of pairs) if ((x -= w) < 0) return v;
      return pairs[pairs.length - 1][0];
    },
  };
  return r;
}

// ---------- item data ----------

const NAMES = ["Ada", "grace", "Zoë", "", "李雷", "O'Brien", "ada", "Émile", "  padded  ", "Ada"];
const TAGS = [["a", "b"], [], ["x"], [["nested", 1], ["n2"]], ["a", "a", "c"], [1, 2, 3], null];
const CREATED = ["2026-11-10T08:00:00.000Z", "2026-01-31T23:59:59Z", "2025-12-25", "not a date", "", "2026-03-29T01:30:00+01:00", 1794603539334];

function randomItem(r, i) {
  const j = {};
  if (r.chance(0.9)) j.id = r.weighted([[i + 1, 5], [String(i + 1), 2], [null, 1]]);
  if (r.chance(0.85)) j.name = r.pick(NAMES);
  if (r.chance(0.8)) j.price = r.weighted([[r.int(0, 50), 4], [`${r.int(1, 9)}.5`, 2], [null, 1], ["", 1], [-r.int(1, 5), 1], ["abc", 1]]);
  if (r.chance(0.75)) j.active = r.weighted([[true, 3], [false, 3], ["true", 1], [0, 1], [null, 1]]);
  if (r.chance(0.7)) j.tags = structuredClone(r.pick(TAGS));
  if (r.chance(0.6)) j.meta = r.weighted([[{ a: r.int(1, 3), b: { c: r.pick(["deep", "", null]) } }, 4], [{}, 1], [null, 1]]);
  if (r.chance(0.6)) j.created = r.pick(CREATED);
  if (r.chance(0.3)) j.email = r.pick(["a@example.com", "B@Example.COM", "no-at-sign", ""]);
  if (r.chance(0.2)) j["weird key"] = r.pick(["sp ace", "ünï", 7]);
  return j;
}

const FIELDS = ["id", "name", "price", "active", "tags", "meta", "created", "email", "meta.a", "meta.b.c"];
const fieldExpr = (f) => (f.includes(".") ? `$json.${f}` : `$json.${f}`);

// ---------- conditions (If / Filter / Switch, version 2 filter) ----------

const NATURAL = { id: "number", name: "string", price: "number", active: "boolean", tags: "array", created: "dateTime", meta: "object", email: "string" };
function condition(r, k, ref) {
  const field = r.pick(["id", "name", "price", "active", "tags", "created", "meta", "email"]);
  const type = r.chance(0.65) ? NATURAL[field] : r.weighted([["string", 4], ["number", 3], ["boolean", 2], ["array", 2], ["dateTime", 1], ["object", 1]]);
  const ops = {
    string: [["equals", "Ada"], ["notEquals", ""], ["contains", "a"], ["startsWith", "A"], ["endsWith", "a"], ["exists"], ["notExists"], ["empty"], ["notEmpty"], ["regex", "^[A-Z]"]],
    number: [["equals", 1], ["gt", 10], ["gte", 1], ["lt", 25], ["lte", 0], ["exists"], ["empty"]],
    boolean: [["true"], ["false"], ["equals", true], ["exists"]],
    array: [["contains", "a"], ["lengthGt", 1], ["lengthEquals", 0], ["empty"], ["notEmpty"]],
    dateTime: [["after", "2026-01-01T00:00:00.000Z"], ["before", "2026-06-01"]],
    object: [["empty"], ["notEmpty"], ["exists"]],
  }[type];
  const [operation, right] = r.pick(ops);
  const unary = right === undefined;
  return {
    id: `c${k}`,
    leftValue: `={{ ${ref ? ref(field) : fieldExpr(field)} }}`,
    rightValue: unary ? "" : right,
    operator: { type, operation, ...(unary ? { singleValue: true } : {}) },
  };
}

function conditions(r, k, ref) {
  const n = r.weighted([[1, 3], [2, 1]]);
  return {
    options: { caseSensitive: r.chance(0.8), leftValue: "", typeValidation: r.chance(0.6) ? "loose" : "strict", version: 2 },
    conditions: Array.from({ length: n }, (_, i) => condition(r, `${k}${i}`, ref)),
    combinator: r.pick(["and", "or"]),
  };
}

// ---------- nodes ----------

const CODE_ALL = [
  `return $input.all().map((item, i) => ({ json: { ...item.json, idx: i, nameLen: String(item.json.name ?? '').length } }));`,
  `const out = [];\nfor (const item of $input.all()) {\n  if (item.json.price !== null && item.json.price !== undefined) out.push({ json: { id: item.json.id, double: Number(item.json.price) * 2 } });\n}\nreturn out;`,
  `return [{ json: { count: $input.all().length, first: $input.first().json.name ?? null, names: $input.all().map(i => i.json.name) } }];`,
  `return $input.all().sort((a, b) => String(a.json.name).localeCompare(String(b.json.name))).map(i => ({ json: i.json }));`,
  `const trig = $('Trigger').all();\nreturn $input.all().map((item, i) => ({ json: { own: item.json.id ?? null, fromTrigger: trig[i] ? trig[i].json.id ?? null : 'none' } }));`,
  `return [];`,
  `return $input.all().map(i => ({ json: { tags: Array.isArray(i.json.tags) ? i.json.tags.flat().join('|') : typeof i.json.tags } }));`,
  `for (const item of $input.all()) {\n  item.json.touched = true;\n}\nreturn $input.all();`,
  `return { json: { single: true, n: items.length } };`,
  `return $input.all().filter(i => i.json.active).map(i => ({ json: { ...i.json, kept: 'yes' } }));`,
];
const CODE_EACH = [
  `return { json: { ...$json, upper: String($json.name ?? '').toUpperCase() } };`,
  `if ($json.price === null) return null;\nreturn { json: { id: $json.id, priceType: typeof $json.price } };`,
  `return { id: $json.id, viaTrigger: $('Trigger').item.json.id ?? null, index: $itemIndex };`,
  `const m = $json.meta ?? {};\nreturn { json: { a: m.a ?? null, deep: m.b?.c ?? 'missing' } };`,
  `return { json: { keys: Object.keys($json).sort().join(',') } };`,
];
const CODE_THROW = [
  `if (!$json.name) throw new Error('no name for item ' + $itemIndex);\nreturn { json: { ok: $json.name } };`,
  `const p = $json.price;\nif (typeof p !== 'number') {\n  throw new Error('price is ' + JSON.stringify(p));\n}\nreturn { json: { p } };`,
];

// An expression reading field f: from the input item, or through $('Ancestor') (paired
// item, first item) or $input.
function refFor(r, anc) {
  return (f) => {
    const a = anc.length ? r.pick(anc) : null;
    const path = f.includes(".") ? f : f;
    return r.weighted([
      [`$json.${path}`, 6],
      [`$input.item.json.${path}`, 1],
      ...(a ? [[`$('${a}').item.json.${path}`, 3], [`$('${a}').first().json.${path}`, 1], [`$('${a}').all().length`, 0.5]] : []),
    ]);
  };
}

function setNode(r, ref = fieldExpr) {
  const n = r.int(1, 3);
  const assignments = [];
  for (let i = 0; i < n; i++) {
    const type = r.weighted([["string", 4], ["number", 3], ["boolean", 2], ["array", 1], ["object", 1]]);
    const src = r.pick(FIELDS);
    const value = r.weighted([
      [`={{ ${ref(src)} }}`, 5],
      [type === "number" ? "42" : type === "boolean" ? "true" : type === "array" ? '["x", 1]' : type === "object" ? '{"k": "v"}' : "literal", 2],
      [`={{ ${ref(src)} }} and text`, 1],
      [`={{ ${ref(src)} ?? 'fallback' }}`, 1],
    ]);
    const name = r.weighted([[`out${i}`, 4], [`nested.out${i}`, 1], [r.pick(["name", "price", "id"]), 1]]);
    assignments.push({ id: `a${i}`, name, value, type });
  }
  const include = r.weighted([["none", 3], ["all", 3], ["selected", 1], ["except", 1]]);
  return {
    type: "n8n-nodes-base.set",
    typeVersion: 3.4,
    parameters: {
      mode: "manual",
      assignments: { assignments },
      ...(include === "none" ? {} : { includeOtherFields: true, include, ...(include === "selected" ? { includeFields: "id,name" } : include === "except" ? { excludeFields: "tags,meta" } : {}) }),
      options: { ...(r.chance(0.6) ? { ignoreConversionErrors: true } : {}), ...(r.chance(0.15) ? { dotNotation: false } : {}) },
    },
  };
}

function httpNode(r, k, fixtures, label) {
  const path = `/gen/${label}/${k}`;
  const method = r.pick(["GET", "POST", "POST", "PUT"]);
  const body = r.weighted([["none", 2], ["jsonKeypair", 2], ["jsonText", 2], ["form", 2], ["query", 2]]);
  const p = { method, url: `=http://mock:8080${path}${r.chance(0.3) ? "/{{ $json.id }}" : ""}`, options: {} };
  if (body === "query" || r.chance(0.3)) {
    p.sendQuery = true;
    p.queryParameters = { parameters: [{ name: "q", value: "={{ $json.name }}" }, { name: "page", value: String(r.int(1, 3)) }, ...(r.chance(0.3) ? [{ name: "q", value: "dup" }] : [])] };
  }
  if (body === "jsonKeypair") Object.assign(p, { sendBody: true, contentType: "json", specifyBody: "keypair", bodyParameters: { parameters: [{ name: "id", value: "={{ $json.id }}" }, { name: r.pick(["price", "a.b"]), value: "={{ $json.price }}" }] } });
  if (body === "jsonText") Object.assign(p, { sendBody: true, specifyBody: "json", jsonBody: r.pick(['={{ JSON.stringify($json) }}', '={ "name": "{{ $json.name }}", "n": 1 }', '={{ { id: $json.id, tags: $json.tags } }}']) });
  if (body === "form") Object.assign(p, { sendBody: true, contentType: "form-urlencoded", bodyParameters: { parameters: [{ name: "name", value: "={{ $json.name }}" }, { name: "active", value: "={{ $json.active }}" }] } });
  if (r.chance(0.3)) Object.assign(p, { sendHeaders: true, headerParameters: { parameters: [{ name: "X-Item", value: "={{ $json.id }}" }] } });
  const reply = r.weighted([
    [{ status: 200, body: { ok: true, echo: "x", list: [1, 2] } }, 4],
    [{ status: 200, body: [{ id: 1, v: "a" }, { id: 2, v: null }] }, 2],
    [{ status: 200, headers: { "content-type": "text/plain" }, body: "plain text reply" }, 1],
    [{ status: 200, headers: { "content-type": "application/json" }, body: "" }, 1],
    [{ status: 404, body: { error: "not found" } }, 1],
    [{ status: 500, headers: { "content-type": "text/plain" }, body: "boom" }, 1],
  ]);
  fixtures[`* ${path}`] = reply;
  if (r.chance(0.3)) p.options = { response: { response: { ...(r.chance(0.5) ? { fullResponse: true } : {}), ...(r.chance(0.5) ? { neverError: true } : {}), ...(r.chance(0.3) ? { responseFormat: r.pick(["json", "text"]) } : {}) } } };
  return { type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, parameters: p };
}

function dateNode(r) {
  const op = r.weighted([["addToDate", 3], ["subtractFromDate", 2], ["formatDate", 3], ["extractDate", 2], ["roundDate", 1], ["getTimeBetweenDates", 1], ["getCurrentDate", 1]]);
  const date = "={{ $json.created }}";
  const base = { operation: op, options: {} };
  if (op === "addToDate" || op === "subtractFromDate") Object.assign(base, { magnitude: date, timeUnit: r.pick(["days", "hours", "months", "minutes"]), duration: r.int(1, 40), outputFieldName: "newDate" });
  if (op === "formatDate") Object.assign(base, { date, format: r.pick(["yyyy-MM-dd", "MM/dd/yyyy", "custom"]), customFormat: "dd LLL yyyy HH:mm", outputFieldName: "formattedDate", ...(r.chance(0.3) ? { options: { timezone: "Asia/Singapore" } } : {}) });
  if (op === "extractDate") Object.assign(base, { date, part: r.pick(["year", "month", "week", "day", "hour", "minute"]), outputFieldName: "datePart" });
  if (op === "roundDate") Object.assign(base, { date, mode: r.pick(["roundDown", "roundUp"]), toNearest: r.pick(["day", "hour", "month"]), outputFieldName: "roundedDate" });
  if (op === "getTimeBetweenDates") Object.assign(base, { startDate: date, endDate: "2026-12-01T00:00:00.000Z", units: [r.pick(["day", "hour", "month"])], outputFieldName: "timeDifference" });
  if (op === "getCurrentDate") Object.assign(base, { includeTime: r.chance(0.5), outputFieldName: "currentDate" });
  return { type: "n8n-nodes-base.dateTime", typeVersion: 2, parameters: base };
}

const SIMPLE = {
  filter: (r, k, ref) => ({ type: "n8n-nodes-base.filter", typeVersion: 2.2, parameters: { conditions: conditions(r, k, ref), ...(r.chance(0.3) ? { looseTypeValidation: true } : {}), options: {} } }),
  code: (r) => {
    const each = r.chance(0.35);
    return { type: "n8n-nodes-base.code", typeVersion: 2, parameters: { ...(each ? { mode: "runOnceForEachItem" } : {}), jsCode: r.pick(each ? CODE_EACH : CODE_ALL) } };
  },
  codeThrow: (r) => ({ type: "n8n-nodes-base.code", typeVersion: 2, parameters: { mode: "runOnceForEachItem", jsCode: r.pick(CODE_THROW) }, settings: { onError: r.pick(["continueErrorOutput", "continueRegularOutput", "continueErrorOutput"]) } }),
  splitOut: (r) => ({ type: "n8n-nodes-base.splitOut", typeVersion: 1, parameters: { fieldToSplitOut: r.pick(["tags", "tags", "meta", "name"]), include: r.pick(["noOtherFields", "allOtherFields", "selectedOtherFields"]), fieldsToInclude: "id", options: {} } }),
  aggregate: (r) =>
    r.chance(0.6)
      ? { type: "n8n-nodes-base.aggregate", typeVersion: 1, parameters: { fieldsToAggregate: { fieldToAggregate: [{ fieldToAggregate: r.pick(["name", "price", "tags", "meta.a"]) }] }, options: { ...(r.chance(0.4) ? { mergeLists: true } : {}), ...(r.chance(0.4) ? { keepMissing: true } : {}) } } }
      : { type: "n8n-nodes-base.aggregate", typeVersion: 1, parameters: { aggregate: "aggregateAllItemData", destinationFieldName: "all", options: {} } },
  limit: (r) => ({ type: "n8n-nodes-base.limit", typeVersion: 1, parameters: { maxItems: r.int(1, 3), ...(r.chance(0.4) ? { keep: "lastItems" } : {}) } }),
  sort: (r) => ({ type: "n8n-nodes-base.sort", typeVersion: 1, parameters: { sortFieldsUi: { sortField: [{ fieldName: r.pick(["price", "name", "id", "created"]), ...(r.chance(0.5) ? { order: "descending" } : {}) }] }, options: {} } }),
  removeDuplicates: (r) => ({ type: "n8n-nodes-base.removeDuplicates", typeVersion: 2, parameters: r.chance(0.5) ? { compare: "selectedFields", fieldsToCompare: r.pick(["name", "active", "name,active"]), options: {} } : { options: {} } }),
  summarize: (r) => ({ type: "n8n-nodes-base.summarize", typeVersion: 1.1, parameters: { fieldsToSummarize: { values: [{ aggregation: r.pick(["count", "sum", "min", "max", "append", "countUnique", "concatenate", "average"]), field: r.pick(["price", "name", "id"]) }] }, ...(r.chance(0.5) ? { fieldsToSplitBy: r.pick(["active", "name"]) } : {}), options: {} } }),
  dateTime: (r) => dateNode(r),
  crypto: (r, k, ref) => ({ type: "n8n-nodes-base.crypto", typeVersion: 1, parameters: { action: "hash", type: r.pick(["MD5", "SHA256", "SHA512"]), value: r.chance(0.7) ? `={{ String(${ref(r.pick(["name", "id", "price"]))}) }}` : `={{ ${ref(r.pick(["name", "id", "price"]))} }}`, dataPropertyName: "digest", ...(r.chance(0.3) ? { encoding: "base64" } : {}) } }),
  set: (r, k, ref) => setNode(r, ref),
};

// ---------- workflow assembly ----------

export function generateOne(seed, index) {
  const r = rng(seed * 100003 + index * 7919 + 17);
  const label = `g${seed}-${String(index).padStart(4, "0")}`;
  const nodes = [];
  const connections = {};
  const fixtures = { default: { status: 200, body: { ok: true, default: true } } };
  let k = 0;
  const pos = (depth, lane) => [depth * 240, lane * 180];
  const add = (spec, depth, lane, name) => {
    const node = { id: `n${k}`, name: name ?? `${spec.type.split(".").pop()} ${k}`, type: spec.type, typeVersion: spec.typeVersion, position: pos(depth, lane), parameters: spec.parameters, ...(spec.settings ?? {}) };
    k++;
    nodes.push(node);
    return node;
  };
  const connect = (from, out, to, input = 0) => {
    const c = (connections[from.name] ??= { main: [] });
    while (c.main.length <= out) c.main.push([]);
    c.main[out].push({ node: to.name, type: "main", index: input });
  };
  const trigger = add({ type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {} }, 0, 0, "Trigger");
  // frontier: open outputs {node, out, depth, lane}
  let frontier = [{ node: trigger, out: 0, depth: 0, lane: 0, anc: ["Trigger"] }];
  const target = r.int(3, 9);
  let lanes = 1;
  while (k <= target && frontier.length) {
    const kind = r.weighted([
      ["set", 5], ["if", 3], ["filter", 2], ["switch", 2], ["merge", frontier.length > 1 ? 8 : 0], ["code", 4], ["codeThrow", 1.5], ["splitOut", 1.5], ["aggregate", 1.5], ["limit", 1], ["sort", 1.5],
      ["removeDuplicates", 1], ["summarize", 1], ["loop", 1.5], ["dateTime", 2], ["crypto", 1], ["http", 2.5],
    ]);
    const si = r.int(0, frontier.length - 1);
    const src = frontier[si];
    const depth = src.depth + 1;
    if (kind === "merge") {
      let sj = r.int(0, frontier.length - 1);
      if (sj === si) sj = (si + 1) % frontier.length;
      const other = frontier[sj];
      const mode = r.weighted([["append", 3], ["byFields", 3], ["byPosition", 2], ["all", 1], ["choose", 2]]);
      const params =
        mode === "append" ? { mode: "append" }
        : mode === "byFields" ? { mode: "combine", combineBy: "combineByFields", fieldsToMatchString: r.pick(["id", "name"]), joinMode: r.pick(["keepMatches", "keepNonMatches", "keepEverything", "enrichInput1", "enrichInput2"]), options: {} }
        : mode === "byPosition" ? { mode: "combine", combineBy: "combineByPosition", options: r.chance(0.5) ? { includeUnpaired: true } : {} }
        : mode === "all" ? { mode: "combine", combineBy: "combineAll", options: {} }
        : { mode: "chooseBranch", useDataOfInput: r.pick([1, 2]) };
      const m = add({ type: "n8n-nodes-base.merge", typeVersion: 3.1, parameters: params }, Math.max(depth, other.depth + 1), src.lane);
      connect(src.node, src.out, m, 0);
      connect(other.node, other.out, m, 1);
      frontier = frontier.filter((_, i) => i !== si && i !== sj);
      frontier.push({ node: m, out: 0, depth: Math.max(depth, other.depth + 1), lane: src.lane, anc: [...new Set([...src.anc, ...other.anc, m.name])] });
      continue;
    }
    if (kind === "loop") {
      const sib = add({ type: "n8n-nodes-base.splitInBatches", typeVersion: 3, parameters: { batchSize: r.int(1, 2), options: {} } }, depth, src.lane);
      const body = add(r.chance(0.5) ? SIMPLE.set(r, k, refFor(r, [...src.anc, sib.name])) : SIMPLE.code(r), depth + 1, src.lane + 0.5);
      connect(src.node, src.out, sib);
      connect(sib, 1, body);
      connect(body, 0, sib);
      frontier.splice(si, 1, { node: sib, out: 0, depth: depth + 1, lane: src.lane, anc: [...src.anc, sib.name, body.name] });
      continue;
    }
    let spec;
    let outs = 1;
    const ref = refFor(r, src.anc);
    if (kind === "if") {
      spec = { type: "n8n-nodes-base.if", typeVersion: 2.2, parameters: { conditions: conditions(r, k, ref), ...(r.chance(0.3) ? { looseTypeValidation: true } : {}), options: {} } };
      outs = 2;
    } else if (kind === "switch") {
      const nr = r.int(2, 3);
      const fallback = r.pick(["none", "extra", 0]);
      spec = { type: "n8n-nodes-base.switch", typeVersion: 3.2, parameters: { mode: "rules", rules: { values: Array.from({ length: nr }, (_, i) => ({ conditions: conditions(r, `${k}r${i}`, ref) })) }, options: { ...(fallback !== "none" ? { fallbackOutput: fallback } : {}), ...(r.chance(0.3) ? { allMatchingOutputs: true } : {}) } } };
      outs = nr + (fallback === "extra" ? 1 : 0);
    } else if (kind === "http") spec = httpNode(r, k, fixtures, label);
    else spec = SIMPLE[kind](r, k, ref);
    if (kind === "codeThrow" && spec.settings?.onError === "continueErrorOutput") outs = 2;
    const settings = {};
    if (r.chance(0.08)) settings.executeOnce = true;
    if (r.chance(0.12)) settings.alwaysOutputData = true;
    if (kind === "http" && r.chance(0.35)) settings.onError = r.pick(["continueRegularOutput", "continueErrorOutput"]);
    if (settings.onError === "continueErrorOutput") outs = 2;
    spec.settings = { ...(spec.settings ?? {}), ...settings };
    const node = add(spec, depth, src.lane);
    connect(src.node, src.out, node);
    const next = [];
    for (let o = 0; o < outs; o++) {
      const lane = o === 0 ? src.lane : lanes++;
      next.push({ node, out: o, depth, lane, anc: [...src.anc, node.name] });
    }
    frontier.splice(si, 1, ...next);
  }
  const count = r.int(1, 4);
  const items = Array.from({ length: count }, (_, i) => ({ json: randomItem(r, i) }));
  const workflow = { name: label, nodes, connections, settings: { executionOrder: "v1" }, pinData: { Trigger: items } };
  return { label, workflow, fixtures };
}

export function generate({ seed = 1, count = 200 } = {}) {
  return Array.from({ length: count }, (_, i) => generateOne(seed, i));
}

function main() {
  const args = process.argv.slice(2);
  const flag = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const list = generate({ seed: Number(flag("--seed", 1)), count: Number(flag("--count", 10)) });
  const out = flag("--out");
  if (out) {
    mkdirSync(out, { recursive: true });
    for (const g of list) writeFileSync(join(out, `${g.label}.json`), JSON.stringify({ ...g.workflow, meta: { fixtures: g.fixtures } }, null, 1) + "\n");
    console.error(`${list.length} workflows -> ${out}`);
  } else process.stdout.write(JSON.stringify(list, null, 1) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
