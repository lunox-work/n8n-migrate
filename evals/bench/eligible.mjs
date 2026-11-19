#!/usr/bin/env node
// Round 4 eligibility (EXCLUSIONS.md "Round 4 eligibility"): whether a corpus template can be
// worked on end to end. Decided from the template file, the analyzer with default answers and
// the committed lists in eligibility.json; never from a bench result.
//
//   node evals/bench/eligible.mjs [--ids a,b,...] [--json]
//   node evals/bench/eligible.mjs --extract <n8n-nodes-base dir> <@n8n/n8n-nodes-langchain dir>
//        (writes eligibility-params.json: amendment 1's node-description extract, for the node
//        types in the cached templates; the dirs are unpacked packages, read as JSON only)
//   node evals/bench/eligible.mjs --reapply-walk 4
//        (re-applies the rule to the round's walk candidates in corpus.json: `pool: fresh`
//        entries keep their pool; one that an amendment or a later hand call makes ineligible gets
//        `r4: ineligible` and `r4Reasons` (`r4Amended` for an amendment), and the draw skips it
//        like an exclusion after the draw)
//
// Without --ids: the current round's dev templates (the current held-out is never read without
// explicit ids, as for every bench tool; PROPOSALS P51). Reads the git-ignored template cache
// (evals/bench/data/wf) and corpus.json (existing exclusions; `r4Hand` reasons).
//
// checkEligibility() is pure: {wf, report, lists, nodes, corpusEntry, params} -> {eligible,
// baseEligible, stratum, reasons: [{clause, id?, node?, detail, amendment?}], pending: [fix ids
// not built yet], built: [fix ids built]}. Clauses, in rule order: exclusion, outcome,
// out-of-scope, self-fail (with amendment 1's: required-empty from n8n's node descriptions,
// python-refused, chat-input-unfed), bench, feature, comparable, hand.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { analyze, unwrap } from "../../skills/n8n-migrate/scripts/analyze.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const STICKY = "n8n-nodes-base.stickyNote";
const STRATA = new Set(["chat", "manual", "schedule", "form", "poll"]);
export const stratumOf = (wakeup) => (STRATA.has(wakeup) ? wakeup : "other");

const own = (o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const opOf = (s) => [s.resource, s.operation].filter(Boolean).join(":");
const opMatches = (s, op) => opOf(s) === op || s.operation === op;

function paramAt(params, path) {
  let v = params;
  for (const k of path.split(".")) v = v == null ? undefined : v[k];
  if (v && typeof v === "object" && !Array.isArray(v) && "__rl" in v) v = v.value;
  return v;
}
const isEmpty = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);

// The workflow a sub-workflow call names, as the analyzer reads it (analyze.mjs readCallTarget).
export function callTarget(params = {}) {
  const source = params.source ?? "database";
  if (source === "parameter") return "inline";
  if (source !== "database") return source;
  const raw = params.workflowId;
  const v = raw && typeof raw === "object" ? raw.value : raw;
  if (v === undefined || v === null || String(v).trim() === "") return "empty";
  const s = String(v);
  if (s.startsWith("=") || s.includes("{{")) return s.replace(/[={}\s]/g, "") === "$workflow.id" ? "self" : "expression";
  return "id";
}

// Every string value in a node's parameters (for loopback hosts in URLs).
function strings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

export function lookupType(map, type) {
  const hit = own(map, type);
  if (hit !== undefined) return hit;
  if (type.endsWith("Tool")) return own(map, type.slice(0, -4));
  return undefined;
}
// A feature or capability entry: a string, or {ops: {op: value}, default}.
export function resolveEntry(entry, step) {
  if (entry === undefined) return undefined;
  if (entry === null || typeof entry === "string") return entry;
  for (const [op, v] of Object.entries(entry.ops ?? {})) if (opMatches(step, op)) return v;
  return own(entry, "default") ?? null;
}

const isCommunity = (type) => !/^(n8n-nodes-base|@n8n\/n8n-nodes-langchain)\./.test(type);

// ---------- Amendment 1 (EXCLUSIONS.md "Round 4 eligibility, amendment 1") ----------
//
// Three self-fail clauses read from the template and from n8n's own node descriptions
// (eligibility-params.json, extracted by `--extract` from the node packages n8n 2.47.7 ships;
// never their code). A reason they give carries `amendment: 1`.

// The node description n8n uses for this node (its version group), or null when the extract
// has no group for that version (then nothing is checked).
export function descriptionFor(params, type, version) {
  const list = own(params?.types, type) ?? (type.endsWith("Tool") ? own(params?.types, type.slice(0, -4)) : undefined);
  return list?.find((d) => d.versions.includes(Number(version ?? 1))) ?? null;
}

// n8n's displayOptions (n8n-workflow displayParameterPath): every `show` key's value is among its
// allowed values (an expression shows the parameter), no `hide` key's is. Allowed values are plain
// values or {_cnd: {op: arg}}. `@version` is the node's typeVersion.
const cond = (c, v) => {
  const [op, a] = Object.entries(c ?? {})[0] ?? [];
  if (op === "eq") return v === a;
  if (op === "not") return v !== a;
  if (op === "gte") return v >= a;
  if (op === "lte") return v <= a;
  if (op === "gt") return v > a;
  if (op === "lt") return v < a;
  if (op === "between") return v >= a?.from && v <= a?.to;
  if (op === "includes") return typeof v === "string" && v.includes(a);
  if (op === "startsWith") return typeof v === "string" && v.startsWith(a);
  if (op === "endsWith") return typeof v === "string" && v.endsWith(a);
  if (op === "regex") return new RegExp(a).test(String(v ?? ""));
  if (op === "exists") return v !== undefined && v !== null && v !== "";
  return false;
};
const allowsAny = (allowed, vals) => [].concat(allowed).some((x) => vals.some((v) => (x && typeof x === "object" && x._cnd ? cond(x._cnd, v) : x === v)));
export function paramDisplayed(p, params, d, version, depth = 0) {
  const get = (k) => {
    if (k === "@version") return [Number(version ?? 1)];
    if (k.startsWith("@")) return [];
    const v = paramValue(k.replace(/^\//, ""), params, d, version, depth + 1);
    return v === undefined ? [] : [].concat(v);
  };
  for (const [k, allowed] of Object.entries(p.show ?? {})) {
    const vals = get(k);
    if (vals.some((x) => typeof x === "string" && x.startsWith("="))) continue;
    if (!vals.length || !allowsAny(allowed, vals)) return false;
  }
  for (const [k, allowed] of Object.entries(p.hide ?? {})) {
    const vals = get(k);
    if (vals.length && allowsAny(allowed, vals)) return false;
  }
  return true;
}
// A parameter's value as n8n's Workflow sees it: the stored value, else the default of the variant
// shown (n8n fills defaults in before it checks a node).
export function paramValue(name, params, d, version, depth = 0) {
  if (params && Object.prototype.hasOwnProperty.call(params, name)) return params[name];
  if (depth > 8) return undefined;
  const p = d.props.find((x) => x.name === name && paramDisplayed(x, params, d, version, depth));
  return p ? p.default : undefined;
}
// n8n-workflow addToIssuesIfMissing: which empty values n8n refuses for a required parameter.
function emptyRequired(p, v) {
  if (["resourceLocator", "workflowSelector"].includes(p.type)) {
    const x = v && typeof v === "object" ? v.value : v;
    return x === undefined || x === null || x === "";
  }
  if (p.type === "multiOptions") return Array.isArray(v) && v.length === 0;
  if (["string", "dateTime", "options"].includes(p.type)) return v === "" || v === undefined;
  return false;
}

// (a) Declared required parameters left empty, except a person's own account resource (P91:
// a placeholder the overlay fills): a resource locator or workflow selector, a value n8n loads
// from the account (`account` in the extract), or a field listed in `placeholders`.
export function requiredEmpty(n, d, rule) {
  const out = [];
  const params = n.parameters ?? {};
  const placeholder = (p) => p.account || (lookupType(rule.placeholders ?? {}, n.type) ?? []).includes(p.name);
  for (const p of d.props) {
    if (!p.required || p.multipleValues || placeholder(p)) continue;
    if (!paramDisplayed(p, params, d, n.typeVersion)) continue;
    if (emptyRequired(p, paramValue(p.name, params, d, n.typeVersion))) out.push(p);
  }
  return out;
}

// (b) Python a Code node runs on n8n 2.x's native runner (n8nio/runners, standard library only)
// that it refuses: Pyodide-era constructs, top-level `await`, third-party imports.
export function pythonCodeOf(n) {
  const p = n.parameters ?? {};
  if (n.type === "n8n-nodes-base.code" && /^python/i.test(p.language ?? "")) return p.pythonCode ?? "";
  if (n.type === "@n8n/n8n-nodes-langchain.toolCode" && /^python/i.test(p.language ?? "")) return p.pythonCode ?? "";
  return null;
}
// Code without comments and string literals (their contents become spaces; line breaks stay).
function pythonTokensOnly(src) {
  return src.replace(/("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|#[^\n]*)/g, (m) => m.replace(/[^\n]/g, " "));
}
const indentOf = (line) => line.match(/^[ \t]*/)[0].replace(/\t/g, "    ").length;
// The block headers enclosing line i (the nearest less-indented non-blank lines above it).
function enclosing(lines, i) {
  const out = [];
  let level = indentOf(lines[i]);
  for (let j = i - 1; j >= 0 && level > 0; j--) {
    if (!lines[j].trim()) continue;
    const k = indentOf(lines[j]);
    if (k < level) {
      out.push(lines[j].trim());
      level = k;
    }
  }
  return out;
}
export function pythonRefusals(src, rule) {
  const hits = [];
  const code = pythonTokensOnly(src);
  for (const c of rule.constructs) if (new RegExp(c.pattern, "m").test(code)) hits.push({ what: c.what, evidence: c.evidence });
  const lines = code.split("\n");
  const stdlib = new Set(rule.stdlib);
  const seen = new Set();
  lines.forEach((line, i) => {
    if (/(^|[^\w.])await\b/.test(line) && !enclosing(lines, i).some((h) => /^async\s+def\b/.test(h)) && !seen.has("await")) {
      seen.add("await");
      hits.push({ what: "`await` outside an async function", evidence: rule.awaitEvidence });
    }
    const m = line.match(/^\s*(?:from\s+([\w.]+)\s+import\b|import\s+([\w.]+(?:\s*,\s*[\w.]+)*))/);
    if (!m) return;
    // An import inside a `try:` (a fallback for when the module is missing) is not a refusal.
    if (enclosing(lines, i).some((h) => /^try\s*:/.test(h))) return;
    for (const mod of (m[1] ?? m[2]).split(",").map((s) => s.trim().split(/\s+/)[0].split(".")[0])) {
      // A Pyodide module a construct already names (micropip, js) is reported once, as that construct.
      if (!mod || mod.startsWith("_") || stdlib.has(mod) || seen.has(`import:${mod}`) || rule.constructs.some((c) => new RegExp(c.pattern, "m").test(`import ${mod}`))) continue;
      seen.add(`import:${mod}`);
      hits.push({ what: `imports ${mod}, which is not in Python's standard library`, evidence: rule.importEvidence });
    }
  });
  return hits;
}

// (c) A model, chain, assistant or agent node whose prompt is its input's `chatInput` field
// (prompt type `auto`, a prompt left at its `={{ $json.chatInput }}` default, or a prompt
// expression naming `$json.chatInput`) with nothing upstream on its main path that can supply it.
const CHAT_INPUT_REF = /\$json(?:\.chatInput\b|\[\s*["']chatInput["']\s*\])/;
export function readsChatInput(n, d) {
  const params = n.parameters ?? {};
  for (const p of d.props) {
    if (!p.promptType && !p.chatInputDefault) continue;
    if (p.promptType) {
      if (paramDisplayed(p, params, d, n.typeVersion) && paramValue(p.name, params, d, n.typeVersion) === "auto") return `${p.name} is auto (take the prompt from the input's chatInput)`;
      continue;
    }
    const v = paramDisplayed(p, params, d, n.typeVersion) ? paramValue(p.name, params, d, n.typeVersion) : params[p.name];
    if (typeof v === "string" && v.startsWith("=") && CHAT_INPUT_REF.test(v)) return `${p.name} is ${v.length > 40 ? `${v.slice(0, 40)}…` : v}`;
  }
  return null;
}
// Whether anything on the node's main-path ancestry can hand it `chatInput`: a chat trigger, a
// sub-workflow trigger (its caller's fields are not in the template), or an ancestor whose
// parameters or pinned data name the field.
export function chatInputSupplied(wf, name, rule) {
  const parents = new Map();
  for (const [from, c] of Object.entries(wf.connections ?? {})) for (const out of c?.main ?? []) for (const x of out ?? []) if (x?.node) (parents.get(x.node) ?? parents.set(x.node, new Set()).get(x.node)).add(from);
  const byName = new Map((wf.nodes ?? []).map((n) => [n.name, n]));
  const seen = new Set();
  const queue = [...(parents.get(name) ?? [])];
  if (!queue.length) return true;
  while (queue.length) {
    const a = queue.shift();
    if (seen.has(a)) continue;
    seen.add(a);
    const n = byName.get(a);
    if (n && (rule.suppliers.includes(n.type) || /chatInput/.test(JSON.stringify(n.parameters ?? {})) || /chatInput/.test(JSON.stringify(wf.pinData?.[a] ?? null)))) return true;
    for (const p of parents.get(a) ?? []) queue.push(p);
  }
  return false;
}

// `params` (amendment 1's node-description extract) defaults to the file eligibility.json names, so
// every caller applies the whole rule; pass null to leave the description-based clauses out.
let paramsMemo = null;
const defaultParams = (lists) => {
  const f = lists.n8nSelfFail?.amendment1?.params;
  if (!f) return null;
  if (paramsMemo?.file !== f) paramsMemo = { file: f, params: readParams(lists) };
  return paramsMemo.params;
};
export function checkEligibility({ wf, report, lists, nodes = {}, corpusEntry = null, params = defaultParams(lists) }) {
  const reasons = [];
  const pending = new Set();
  const built = new Set();
  const add = (clause, detail, extra = {}) => reasons.push({ clause, ...extra, detail });
  const byName = new Map((wf.nodes ?? []).filter((n) => n && n.type !== STICKY).map((n) => [n.name, n]));
  const steps = report.steps.filter((s) => !byName.get(s.node)?.disabled);
  const main = steps.filter((s) => s.branch === "main");
  const scoped = steps.filter((s) => s.branch === "main" || s.branch === "error");

  // 1. Existing exclusion rules, and the analyzer's verdict with default answers.
  if (corpusEntry?.excluded) add("exclusion", `excluded by rule ${corpusEntry.excluded}`);
  if (report.outcome.kind !== "subscription") add("outcome", `analyzer outcome ${report.outcome.kind}`);
  for (const k of report.wakeup.all ?? []) if (!lists.wakeups.allowed.includes(k)) add("outcome", `wake-up ${k} (needs a relay, a host or is an error workflow)`, { id: k === "error" ? "error-workflow" : "relay-or-hosted" });
  for (const a of report.outcome.alsoTargets ?? []) if (a.kind !== "subscription") add("outcome", `other trigger ${a.wakeup} is ${a.kind}`, { id: "relay-or-hosted" });
  if (report.requires.some((r) => r.kind === "relay")) add("outcome", "requires a relay", { id: "relay-or-hosted" });

  // 2. PLAN "Out of scope for v1", pinned to node types and parameters.
  for (const rule of lists.outOfScope) {
    if (rule.rule === "interval") {
      const sec = report.schedule?.shortestIntervalSec;
      if (sec != null && sec < rule.maxSec) add("out-of-scope", `shortest interval ${sec} s`, { id: rule.id });
      continue;
    }
    for (const s of scoped) {
      const n = byName.get(s.node);
      if (!n) continue;
      if (rule.types && !rule.types.includes(s.type)) continue;
      if (rule.rule === "community") {
        if (isCommunity(s.type) && lookupType(lists.features.byType, s.type) === undefined) add("out-of-scope", `community node ${s.type}`, { id: rule.id, node: s.node });
        continue;
      }
      if (rule.rule === "callTarget") {
        const t = callTarget(n.parameters);
        if (t !== "self" && t !== "inline") add("out-of-scope", `calls a workflow by ${t}`, { id: rule.id, node: s.node });
        continue;
      }
      if (rule.operation && !opMatches(s, rule.operation)) continue;
      if (rule.param && !rule.in.includes(paramAt(n.parameters ?? {}, rule.param))) continue;
      if (!rule.types && !rule.operation) continue;
      add("out-of-scope", rule.why, { id: rule.id, node: s.node });
    }
  }

  // 3a. n8n fails on the template itself.
  for (const s of main) {
    const n = byName.get(s.node);
    if (!n) continue;
    if (!nodes[s.type] && !lists.bench.pendingTypes.includes(s.type) && !isCommunity(s.type)) add("self-fail", `node type ${s.type} is not in n8n's node packages`, { id: "node-missing", node: s.node });
    for (const r of lists.n8nSelfFail.rules) {
      if (r.type !== s.type) continue;
      if (r.operation && !opMatches(s, r.operation)) continue;
      if (r.operations && !r.operations.some((op) => opMatches(s, op))) continue;
      if (r.minVersion && Number(n.typeVersion ?? 1) < r.minVersion) continue;
      const v = paramAt(n.parameters ?? {}, r.param);
      const hit = r.when === "empty" ? isEmpty(v) : r.when === "matches" ? typeof v === "string" && !v.startsWith("=") && new RegExp(r.pattern).test(v) : false;
      if (hit) add("self-fail", `${r.param} ${r.when === "empty" ? "is empty" : `= ${v}`} (${r.evidence})`, { id: r.id, node: s.node, ...(r.amendment ? { amendment: r.amendment } : {}) });
    }
  }

  // 3a, amendment 1: declared required parameters left empty, Python the native runner refuses,
  // a prompt taken from a chatInput nothing supplies. n8n checks no node that has pinned data.
  const A = lists.n8nSelfFail.amendment1;
  if (A) {
    const listed = new Set(reasons.filter((r) => r.clause === "self-fail").map((r) => `${r.node}\u0000${r.detail.split(" ")[0]}`));
    for (const s of main) {
      const n = byName.get(s.node);
      if (!n) continue;
      const pinned = Object.prototype.hasOwnProperty.call(wf.pinData ?? {}, s.node);
      const d = params ? descriptionFor(params, s.type, n.typeVersion) : null;
      if (d && !pinned)
        for (const p of requiredEmpty(n, d, A.requiredEmpty))
          if (!listed.has(`${s.node}\u0000${p.name}`)) add("self-fail", `${p.name} is empty (n8n 2.47.7: Parameter "${p.displayName}" is required, from its node description)`, { id: "required-empty", node: s.node, amendment: 1 });
      const py = pinned ? null : pythonCodeOf(n);
      if (py) for (const h of pythonRefusals(py, A.python)) add("self-fail", `Python ${h.what} (${h.evidence})`, { id: "python-refused", node: s.node, amendment: 1 });
      if (d && !pinned) {
        const why = readsChatInput(n, d);
        if (why && !chatInputSupplied(wf, s.node, A.chatInput)) add("self-fail", `${why}, and nothing on its main path supplies chatInput (${A.chatInput.evidence})`, { id: "chat-input-unfed", node: s.node, amendment: 1 });
      }
    }
  }

  // 3b. The bench can stand in for every main-branch step today, or a bounded fix covers it.
  const B = lists.bench;
  const need = (s, cap, why) => {
    if (cap === "local" || cap === "mock" || cap === "shim" || cap === "pin") return;
    if (typeof cap === "string" && cap.startsWith("pending:")) {
      const fix = cap.slice(8);
      if (own(B.fixes, fix)?.bounded) {
        // A fix that has landed (`built`) is the bench's capability now; one not yet built is pending.
        (own(B.fixes, fix).built ? built : pending).add(fix);
        return;
      }
    }
    add("bench", `${why}: no bench counterpart (${cap ?? "unlisted"})`, { node: s.node });
  };
  for (const s of main) {
    const n = byName.get(s.node);
    if (!n || s.role === "trigger") {
      if (n && s.role === "trigger" && lookupType(B.byType, s.type) !== undefined) need(s, resolveEntry(lookupType(B.byType, s.type), s), s.type);
      continue;
    }
    let cap;
    const t = lookupType(B.byType, s.type);
    if (t !== undefined) {
      cap = resolveEntry(t, s);
      if (t && typeof t === "object" && t.minVersionNone && Number(n.typeVersion ?? 1) >= t.minVersionNone) cap = "none";
    } else if (new RegExp(B.modelSubnodePattern).test(s.type)) cap = B.shimModels.includes(s.type) ? "shim" : "none";
    else cap = own(B.byKind, s.kind) ?? (s.kind == null ? "local" : undefined);
    if (s.type === "n8n-nodes-base.code" && /python/i.test(n.parameters?.language ?? "")) cap = B.codePython;
    need(s, cap, `${s.type}${opOf(s) ? ` ${opOf(s)}` : ""}`);
    if (["http", "connector"].includes(s.kind) && strings(n.parameters).some((x) => B.loopbackHosts.some((h) => new RegExp(`//${h.replace(/[.[\]]/g, "\\$&")}(?=[:/]|$)`, "i").test(x)))) need(s, "pending:P52", "a loopback host");
    const meta = nodes[s.type] ?? nodes[s.type.replace(/Tool$/, "")];
    const kinds = ["connector", "http", "db", "vector", "media", "blocked"];
    if (meta?.mapping?.secrets && kinds.includes(s.kind) && !n.credentials && !B.credentialAttached.includes(s.type.replace(/Tool$/, "")) && !(s.type === "n8n-nodes-base.httpRequest")) need(s, "pending:P61", `${s.type} ships no credential`);
  }

  // 4. Every main-branch step falls under a planned feature.
  for (const s of main) {
    const f = resolveEntry(lookupType(lists.features.byType, s.type), s);
    if (f === undefined) add("feature", `${s.type} is not in the planned-feature map`, { node: s.node });
    else if (f === null) add("feature", `${s.type} ${opOf(s)} is not a planned feature`, { node: s.node });
    else if (!own(lists.features.catalog, f)) add("feature", `feature ${f} is not in the catalog`, { node: s.node });
  }

  // 5. Something to compare.
  const C = lists.comparable;
  const mainNames = new Set(main.map((s) => s.node));
  const writes = main.some((s) => C.effectKinds.includes(s.kind) && (s.effect === "write" || s.kind === "media"));
  const chat = report.wakeup.kind === "chat";
  const out = (name) => (wf.connections?.[name]?.main ?? []).flat().filter((c) => c && mainNames.has(c.node));
  const terminal = main.some((s) => s.role === "step" && !C.nonComparedTerminals.includes(s.type) && out(s.node).length === 0);
  if (!writes && !chat && !terminal) add("comparable", "the main branch reaches no write, chat reply or compared terminal step");

  // 6. Hand call (corpus.json `r4Hand`, a one-line reason read from the template alone).
  if (corpusEntry?.r4Hand) add("hand", corpusEntry.r4Hand);

  // `baseEligible`: eligible under the clauses as first committed (76c2fac), amendments left out.
  return { eligible: reasons.length === 0, baseEligible: !reasons.some((r) => !r.amendment), stratum: stratumOf(report.wakeup.kind), reasons, pending: [...pending].sort(), built: [...built].sort() };
}

// Eligibility of corpus templates by id, from the git-ignored template cache (evals/bench/data/wf),
// corpus.json and eligibility.json, with the analyzer's default answers and the fetch's --now.
export function eligibilityOf(ids) {
  const refs = (f) => JSON.parse(readFileSync(join(ROOT, "skills", "n8n-migrate", "references", f), "utf8"));
  const nodesRef = refs("nodes.json");
  const opts = { nodes: nodesRef, capabilities: refs("capabilities.json"), hosts: refs("http-hosts.json"), now: Date.parse("2026-11-16T00:00:00Z") };
  const lists = JSON.parse(readFileSync(join(HERE, "eligibility.json"), "utf8"));
  const params = readParams(lists);
  const corpus = JSON.parse(readFileSync(join(HERE, "corpus.json"), "utf8"));
  return ids.map((id) => {
    const raw = JSON.parse(readFileSync(join(HERE, "data", "wf", `${id}.json`), "utf8"));
    const report = analyze(unwrap(raw, String(id)), opts).workflows[0];
    const wf = raw.workflow?.workflow ?? raw;
    const corpusEntry = corpus.templates.find((e) => e.id === id) ?? null;
    return { id, ...checkEligibility({ wf, report, lists, nodes: nodesRef.nodes, corpusEntry, params }) };
  });
}

// The node-description extract amendment 1 reads (eligibility.json n8nSelfFail.amendment1.params).
export function readParams(lists) {
  const f = lists.n8nSelfFail?.amendment1?.params;
  return f ? JSON.parse(readFileSync(join(ROOT, f), "utf8")) : null;
}

// ---------- the extract: eligibility-params.json ----------
//
// From n8n's node descriptions (an unpacked package's dist/types/nodes.json, plain JSON; the
// package's code is never loaded), for each node type in `types`, per version group, the
// properties amendment 1 reads: required ones, prompt-type options with `auto` and `define`
// choices (`promptType`), string prompts defaulting to the input's chatInput (`chatInputDefault`), and
// every property their displayOptions name (to decide what n8n shows). Deterministic.
export function extractParams(packages, types) {
  const want = new Set(types);
  const out = {};
  for (const { prefix, descriptions } of packages)
    for (const d of descriptions) {
      const type = `${prefix}.${d.name}`;
      if (!want.has(type)) continue;
      const all = (d.properties ?? []).filter((p) => p && p.name && p.type !== "notice");
      const chatDefault = (p) => p.type === "string" && typeof p.default === "string" && CHAT_INPUT_REF.test(p.default);
      // n8n's prompt-type options (promptTypeOptions: auto = the input's chatInput, define = the
      // node's own prompt), whatever the property is called (`promptType`, the assistant's `prompt`).
      const isPromptType = (p) => p.type === "options" && ["auto", "define"].every((v) => (p.options ?? []).some((o) => o.value === v));
      const keep = new Set(all.filter((p) => p.required === true || chatDefault(p) || isPromptType(p)));
      for (let grew = true; grew; ) {
        grew = false;
        const names = new Set([...keep].flatMap((p) => Object.keys({ ...(p.displayOptions?.show ?? {}), ...(p.displayOptions?.hide ?? {}) })).filter((k) => !k.startsWith("@")).map((k) => k.replace(/^\//, "")));
        for (const p of all) if (names.has(p.name) && !keep.has(p)) (keep.add(p), (grew = true));
      }
      const props = all
        .filter((p) => keep.has(p))
        .map((p) => ({
          name: p.name,
          ...(p.displayName ? { displayName: p.displayName } : {}),
          type: p.type,
          ...("default" in p ? { default: p.default } : {}),
          ...(p.required === true ? { required: true } : {}),
          ...(p.typeOptions?.multipleValues ? { multipleValues: true } : {}),
          ...(["resourceLocator", "workflowSelector"].includes(p.type) || p.typeOptions?.loadOptionsMethod || p.typeOptions?.loadOptions ? { account: true } : {}),
          ...(isPromptType(p) ? { promptType: true } : {}),
          ...(chatDefault(p) ? { chatInputDefault: true } : {}),
          ...(p.displayOptions?.show ? { show: p.displayOptions.show } : {}),
          ...(p.displayOptions?.hide ? { hide: p.displayOptions.hide } : {}),
        }));
      if (!props.length) continue;
      (out[type] ??= []).push({ versions: [].concat(d.version ?? 1).map(Number).sort((a, b) => a - b), props });
    }
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.versions[0] - b.versions[0]);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

// ---------- CLI ----------

async function main() {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
  if (a.includes("--extract")) return writeExtract(a[a.indexOf("--extract") + 1], a[a.indexOf("--extract") + 2]);
  if (a.includes("--reapply-walk")) return reapplyWalk(Number(opt("--reapply-walk")));
  const { roundOf, readSplits } = await import("./rounds.mjs");
  const ids = opt("--ids") ? opt("--ids").split(",").map(Number) : roundOf(readSplits()).dev.map((r) => r.id);
  const rows = eligibilityOf(ids);
  if (a.includes("--json")) return console.log(JSON.stringify(rows, null, 1));
  for (const r of rows) console.log(`${r.id}\t${r.eligible ? "eligible" : "ineligible"}\t${r.stratum}\t${r.pending.join(",") || "-"}\t${r.reasons.map((x) => `${x.clause}${x.id ? `/${x.id}` : ""}${x.node ? ` [${x.node}]` : ""}: ${x.detail}`).join(" | ")}`);
  const ok = rows.filter((r) => r.eligible);
  console.log(`eligible ${ok.length} of ${rows.length}; with a pending bench fix ${ok.filter((r) => r.pending.length).length}; relying on a built fix ${ok.filter((r) => r.built.length).length}`);
}

function writeExtract(baseDir, lcDir) {
  if (!baseDir || !lcDir) throw new Error("--extract <n8n-nodes-base dir> <@n8n/n8n-nodes-langchain dir>");
  const pkg = (dir) => {
    for (const p of ["package/dist/types/nodes.json", "dist/types/nodes.json"]) {
      try {
        return { json: JSON.parse(readFileSync(join(dir, p), "utf8")), version: JSON.parse(readFileSync(join(dir, p.replace("dist/types/nodes.json", "package.json")), "utf8")).version };
      } catch {}
    }
    throw new Error(`${dir}: no dist/types/nodes.json`);
  };
  const base = pkg(baseDir);
  const lc = pkg(lcDir);
  const types = new Set();
  for (const f of readdirSync(join(HERE, "data", "wf")).filter((x) => x.endsWith(".json"))) {
    try {
      const raw = JSON.parse(readFileSync(join(HERE, "data", "wf", f), "utf8"));
      for (const n of (raw.workflow?.workflow ?? raw).nodes ?? []) if (n?.type) (types.add(n.type), types.add(n.type.replace(/Tool$/, "")));
    } catch {}
  }
  const doc = {
    $doc: "Round 4 eligibility, amendment 1 (EXCLUSIONS.md): n8n's own node descriptions, per node type and version group, cut to what eligible.mjs reads: required properties (`account`: a resource locator, workflow selector or a value n8n loads from the person's account, which P91 counts as a placeholder), prompt-type options with an auto choice (`promptType`), prompts that default to the input's chatInput (`chatInputDefault`), and the properties their displayOptions name. Generated by `node evals/bench/eligible.mjs --extract` from the packages' dist/types/nodes.json (never their code), for the node types in the cached corpus and gallery templates (evals/bench/data/wf).",
    packages: { "n8n-nodes-base": base.version, "@n8n/n8n-nodes-langchain": lc.version },
    n8n: "2.47.7",
    types: extractParams([{ prefix: "n8n-nodes-base", descriptions: base.json }, { prefix: "@n8n/n8n-nodes-langchain", descriptions: lc.json }], [...types]),
  };
  // One line per node type, so a regeneration diffs by type.
  const { types: byType, ...head } = doc;
  const body = Object.entries(byType).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n");
  writeFileSync(join(HERE, "eligibility-params.json"), `${JSON.stringify(head, null, 2).slice(0, -2)},\n  "types": {\n${body}\n  }\n}\n`);
  console.log(`eligibility-params.json: ${Object.keys(doc.types).length} node types (n8n-nodes-base ${base.version}, langchain ${lc.version})`);
}

async function reapplyWalk(round) {
  const file = join(HERE, "corpus.json");
  const text = readFileSync(file, "utf8");
  const corpus = JSON.parse(text);
  const walk = corpus.templates.filter((e) => e.topUp === round && e.pool === "fresh");
  const rows = new Map(eligibilityOf(walk.map((e) => e.id)).map((r) => [r.id, r]));
  const changed = [];
  for (const e of walk) {
    const r = rows.get(e.id);
    if (r.eligible) continue;
    // A walk candidate passed every clause the walk applied; only an amendment or a hand call made
    // after the draw (`r4Hand`, clause 6) can move it now.
    const walkFails = r.reasons.filter((x) => !x.amendment && x.clause !== "hand");
    if (walkFails.length) throw new Error(`${e.id} fails a clause the walk applied: ${JSON.stringify(walkFails)}`);
    const reasons = [...new Set(r.reasons.map((x) => `${x.clause}${x.id ? `/${x.id}` : ""}: ${x.detail}`.slice(0, 160)))];
    const amended = Math.max(0, ...r.reasons.map((x) => x.amendment ?? 0));
    if (e.r4 === "ineligible" && JSON.stringify(e.r4Reasons) === JSON.stringify(reasons)) continue;
    e.r4 = "ineligible";
    e.r4Reasons = reasons;
    if (amended) e.r4Amended = amended;
    changed.push(e.id);
  }
  const out = JSON.stringify(corpus, null, 2).replace(/\{\n\s+("rank": \d+,[^{}]*?)\n\s+\}/g, (_, body) => `{ ${body.replace(/\n\s+/g, " ")} }`) + "\n";
  writeFileSync(file, out);
  // Counts only on stdout: which ids moved is read from corpus.json by the session applying it.
  console.log(`round ${round} walk candidates re-applied: ${walk.length}, newly ineligible ${changed.length}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
