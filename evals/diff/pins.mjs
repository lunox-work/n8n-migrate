#!/usr/bin/env node
// Pin data for the differential test: the items a pinned node (trigger, connector, model,
// agent, any non-logic node) emits on both sides.
//
//   node evals/diff/pins.mjs <workflow.json> --pinned "A,B" [--items 2] [--out pins.json]
//
// The template's own pinData is used where present. Otherwise each pinned node gets items
// synthesised from the field paths downstream expressions read from it: `$json.x.y`,
// `$input.item.json.x`, `$('Node').item.json.x`, `$node["Node"].json.x`, `item.json.x` in
// Code. `$json` paths are credited to the nearest pinned ancestors (logic nodes in between
// are assumed to pass fields through). Values are deterministic and depend on the field
// name, the item index and how the path is used (`.split(` wants a string, `.map(` an
// array, `[0]` an array). Not realistic, only consistent on both sides.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SEG = String.raw`(?:\??\.[A-Za-z_$][\w$]*|\??\.?\[\s*(?:"[^"\n]*"|'[^'\n]*'|\d+)\s*\])`;
const PATH = `((?:${SEG})+)`;
const TAIL = String.raw`(?:\s*\.\s*([A-Za-z_$][\w$]*)\s*(\()?)?`;
const NAMED_ACCESS = String.raw`(?:item|first\(\s*\)|last\(\s*\)|all\(\s*\)\s*\[\s*\d+\s*\]|itemMatching\([^)]*\)|pairedItem\([^)]*\))`;

const RE = {
  json: new RegExp(String.raw`\$json${PATH}${TAIL}`, "g"),
  input: new RegExp(String.raw`\$input\s*\.\s*${NAMED_ACCESS}\s*\.\s*json${PATH}${TAIL}`, "g"),
  named: new RegExp(String.raw`\$\(\s*(['"\`])((?:(?!\1).)+)\1\s*\)\s*\.\s*${NAMED_ACCESS}\s*\.\s*json${PATH}${TAIL}`, "g"),
  node: new RegExp(String.raw`\$node\s*\[\s*(['"])((?:(?!\1).)+)\1\s*\]\s*\.\s*json${PATH}${TAIL}`, "g"),
  codeJson: new RegExp(String.raw`(?<![$\w])(?:item|items\s*\[\s*\w+\s*\]|x|i|row|entry|it|el|e)\s*\.\s*json${PATH}${TAIL}`, "g"),
};

const STRING_METHODS = new Set(["split", "toLowerCase", "toUpperCase", "trim", "replace", "replaceAll", "startsWith", "endsWith", "slice", "substring", "substr", "charAt", "padStart", "padEnd", "match", "toTitleCase", "toSentenceCase", "toSnakeCase", "extractEmail", "extractUrl", "isEmail", "toDateTime", "toNumber", "toInt", "toFloat", "hash", "urlEncode", "base64Encode", "parseJson", "quote", "removeTags", "toJsonString", "localeCompare", "normalize", "trimStart", "trimEnd", "codePointAt", "charCodeAt"]);
const ARRAY_METHODS = new Set(["map", "filter", "forEach", "join", "find", "findIndex", "some", "every", "reduce", "flat", "flatMap", "pluck", "first", "last", "sum", "average", "unique", "compact", "chunk", "isEmpty", "isNotEmpty", "push", "sort", "reverse", "at", "entries"]);
const NUMBER_METHODS = new Set(["toFixed", "toPrecision", "round", "floor", "ceil", "isEven", "isOdd", "format"]);

function parseSegments(path) {
  const out = [];
  for (const m of path.matchAll(/\??\.([A-Za-z_$][\w$]*)|\[\s*(?:"([^"\n]*)"|'([^'\n]*)'|(\d+))\s*\]/g)) {
    if (m[1] !== undefined) out.push(m[1]);
    else if (m[4] !== undefined) out.push(Number(m[4]));
    else out.push(m[2] ?? m[3]);
  }
  return out;
}

function hintOf(method, called) {
  if (!method) return null;
  if (method === "length") return "string";
  if (STRING_METHODS.has(method) && called) return "string";
  if (ARRAY_METHODS.has(method) && called) return "array";
  if (NUMBER_METHODS.has(method) && called) return "number";
  if (method === "includes" || method === "indexOf") return "string";
  return { key: method }; // property access the path regex did not take (e.g. after a call)
}

// Every string in a node's parameters that n8n evaluates or runs.
export function codeTexts(node) {
  const out = [];
  const walk = (v, key) => {
    if (typeof v === "string") {
      if (["jsCode", "functionCode", "code", "pythonCode"].includes(key)) out.push({ text: v, code: true });
      else if (v.startsWith("=") || v.includes("{{")) out.push({ text: v, code: false });
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(node.parameters ?? {}, "");
  return out;
}

// References read by one node: [{target: "input" | {node}, segs, hint}].
export function readsOf(node) {
  const refs = [];
  const push = (target, path, method, called) => {
    const segs = parseSegments(path);
    if (!segs.length) return;
    let hint = hintOf(method, called);
    if (hint && typeof hint === "object") {
      segs.push(hint.key);
      hint = null;
    }
    refs.push({ target, segs, hint });
  };
  for (const { text, code } of codeTexts(node)) {
    for (const m of text.matchAll(RE.json)) push("input", m[1], m[2], !!m[3]);
    for (const m of text.matchAll(RE.input)) push("input", m[1], m[2], !!m[3]);
    for (const m of text.matchAll(RE.named)) push({ node: m[2] }, m[3], m[4], !!m[5]);
    for (const m of text.matchAll(RE.node)) push({ node: m[2] }, m[3], m[4], !!m[5]);
    if (code) for (const m of text.matchAll(RE.codeJson)) push("input", m[1], m[2], !!m[3]);
  }
  return refs;
}

function parentsMap(wf) {
  const parents = {};
  for (const [from, byType] of Object.entries(wf.connections ?? {})) {
    for (const outs of byType?.main ?? []) for (const c of outs ?? []) if (c?.node) (parents[c.node] ??= new Set()).add(from);
  }
  return parents;
}

// Nearest pinned nodes at or above `start` (walking main inputs through unpinned nodes).
function pinnedAbove(start, parents, pinned, includeSelf) {
  const found = new Set();
  const seen = new Set();
  const queue = includeSelf ? [start] : [...(parents[start] ?? [])];
  while (queue.length) {
    const n = queue.shift();
    if (seen.has(n)) continue;
    seen.add(n);
    if (pinned.has(n)) {
      found.add(n);
      continue;
    }
    for (const p of parents[n] ?? []) queue.push(p);
  }
  return found;
}

const NAMES = ["Ada Lovelace", "Grace Hopper", "Alan Turing"];
function leafValue(key, i, hint) {
  const k = String(key);
  if (hint === "array") return [`${k}-a${i + 1}`, `${k}-b${i + 1}`];
  if (hint === "number") return i + 1;
  if (hint === "string" || typeof key === "number") return `${k} ${i + 1}`;
  if (/email/i.test(k)) return `user${i + 1}@example.com`;
  if (/(url|link|href|website|endpoint)$/i.test(k)) return `http://example.test/${k}/${i + 1}`;
  if (/(date|time|At|_at|timestamp|created|updated|deadline|due)$/i.test(k) || /^(date|time)/i.test(k)) return `2026-11-${String(10 + i).padStart(2, "0")}T08:00:00.000Z`;
  if (/^(is|has|should|can|was)[A-Z_]|^(enabled|active|success|done|approved|valid|ok|completed|paid)$/i.test(k)) return i % 2 === 0;
  if (/(^id$|Id$|_id$|^count$|amount|price|total|qty|quantity|^age$|score|size|limit|^page$|index|rating|^year$|days?$|hours?$|minutes?$|number$|^num|cost|budget|balance|duration|level|priority|stock|weight)/i.test(k)) return /id$/i.test(k) ? 100 + i : (i + 1) * 10;
  if (/phone|mobile/i.test(k)) return `+1555000${String(i).padStart(4, "0")}`;
  if (/name$/i.test(k)) return NAMES[i % NAMES.length];
  if (/^(status|state)$/i.test(k)) return ["open", "closed"][i % 2];
  return `${k} ${i + 1}`;
}

function setDeep(obj, segs, value) {
  let cur = obj;
  for (let s = 0; s < segs.length; s++) {
    const key = segs[s];
    const last = s === segs.length - 1;
    if (last) {
      if (cur[key] === undefined || (typeof cur[key] !== "object" && typeof value === "object")) cur[key] = value;
      return;
    }
    const wantArray = typeof segs[s + 1] === "number";
    if (cur[key] === null || typeof cur[key] !== "object" || (wantArray && !Array.isArray(cur[key]))) cur[key] = wantArray ? [] : {};
    if (wantArray) {
      const arr = cur[key];
      const idx = segs[s + 1];
      while (arr.length <= idx) arr.push(segs.length > s + 2 ? {} : leafValue(key, arr.length, null));
      if (segs.length === s + 2) return;
      if (arr[idx] === null || typeof arr[idx] !== "object") arr[idx] = {};
      cur = arr[idx];
      s++;
      continue;
    }
    cur = cur[key];
  }
}

const TRIGGER_DEFAULTS = {
  "n8n-nodes-base.webhook": () => ({ headers: { "content-type": "application/json" }, params: {}, query: {}, body: {}, webhookUrl: "http://localhost:5678/webhook/bench", executionMode: "production" }),
  "@n8n/n8n-nodes-langchain.chatTrigger": () => ({ sessionId: "session-1", action: "sendMessage", chatInput: "hello from the bench" }),
  "@n8n/n8n-nodes-langchain.manualChatTrigger": () => ({ sessionId: "session-1", action: "sendMessage", chatInput: "hello from the bench" }),
  "n8n-nodes-base.formTrigger": () => ({ submittedAt: "2026-11-14T03:00:00.000Z", formMode: "production" }),
};

// pinData for `pinned` (Set of node names) in workflow `wf`.
// opts: {items: per-node item count (default 2), triggerName, triggerItems: 1, scheduleItem(fn)}
export function makePins(wf, pinned, opts = {}) {
  const count = opts.items ?? 2;
  const parents = parentsMap(wf);
  const byName = Object.fromEntries((wf.nodes ?? []).map((n) => [n.name, n]));
  const paths = {};
  const add = (target, ref) => (paths[target] ??= []).push(ref);
  for (const node of wf.nodes ?? []) {
    for (const ref of readsOf(node)) {
      const targets = ref.target === "input" ? pinnedAbove(node.name, parents, pinned, false) : byName[ref.target.node] ? pinnedAbove(ref.target.node, parents, pinned, true) : new Set();
      for (const t of targets) add(t, ref);
    }
  }
  const out = {};
  const sources = {};
  for (const name of pinned) {
    const own = wf.pinData?.[name];
    if (Array.isArray(own) && own.length) {
      out[name] = own.map((it) => (it && typeof it === "object" && it.json && typeof it.json === "object" ? { json: it.json } : { json: it ?? {} }));
      sources[name] = "template";
      continue;
    }
    const node = byName[name];
    const isTrigger = name === opts.triggerName;
    const n = isTrigger ? opts.triggerItems ?? 1 : count;
    const items = [];
    for (let i = 0; i < n; i++) {
      let base = TRIGGER_DEFAULTS[node?.type]?.() ?? {};
      if (/scheduleTrigger$/.test(node?.type ?? "") && opts.scheduleItem) base = opts.scheduleItem();
      for (const ref of paths[name] ?? []) {
        const leafKey = [...ref.segs].reverse().find((s) => typeof s === "string") ?? "value";
        setDeep(base, ref.segs, leafValue(typeof ref.segs[ref.segs.length - 1] === "number" ? leafKey : ref.segs[ref.segs.length - 1], i, ref.hint));
      }
      if (!Object.keys(base).length && !isTrigger) base = { id: 100 + i, name: NAMES[i % NAMES.length], text: `text ${i + 1}` };
      items.push({ json: base });
    }
    out[name] = items;
    sources[name] = (paths[name] ?? []).length ? "paths" : "default";
  }
  return { pinData: out, sources };
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--pinned" && args[args.indexOf(a) - 1] !== "--items" && args[args.indexOf(a) - 1] !== "--out");
  const flag = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  if (!file || !flag("--pinned")) {
    console.error("usage: pins.mjs <workflow.json> --pinned A,B [--items 2] [--out pins.json]");
    process.exit(2);
  }
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const wf = raw.workflow?.workflow ?? raw.workflow ?? raw;
  const { pinData, sources } = makePins(wf, new Set(flag("--pinned").split(",")), { items: flag("--items") ? Number(flag("--items")) : 2 });
  const text = JSON.stringify({ pinData, sources }, null, 2) + "\n";
  if (flag("--out")) writeFileSync(flag("--out"), text);
  else process.stdout.write(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
