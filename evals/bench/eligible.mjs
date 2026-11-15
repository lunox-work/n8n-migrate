#!/usr/bin/env node
// Round 4 eligibility (EXCLUSIONS.md "Round 4 eligibility"): whether a corpus template can be
// worked on end to end. Decided from the template file, the analyzer with default answers and
// the committed lists in eligibility.json; never from a bench result.
//
//   node evals/bench/eligible.mjs [--ids a,b,...] [--json]
//
// Without --ids: the current round's dev templates (the current held-out is never read without
// explicit ids, as for every bench tool; PROPOSALS P51). Reads the git-ignored template cache
// (evals/bench/data/wf) and corpus.json (existing exclusions; `r4Hand` reasons).
//
// checkEligibility() is pure: {wf, report, lists, nodes, corpusEntry} -> {eligible, stratum,
// reasons: [{clause, id?, node?, detail}], pending: [fix ids]}. Clauses, in rule order:
// exclusion, outcome, out-of-scope, self-fail, bench, feature, comparable, hand.

import { readFileSync } from "node:fs";
import { analyze, unwrap } from "../../skills/n8n-to-claude/scripts/analyze.mjs";
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

function lookupType(map, type) {
  const hit = own(map, type);
  if (hit !== undefined) return hit;
  if (type.endsWith("Tool")) return own(map, type.slice(0, -4));
  return undefined;
}
// A feature or capability entry: a string, or {ops: {op: value}, default}.
function resolveEntry(entry, step) {
  if (entry === undefined) return undefined;
  if (entry === null || typeof entry === "string") return entry;
  for (const [op, v] of Object.entries(entry.ops ?? {})) if (opMatches(step, op)) return v;
  return own(entry, "default") ?? null;
}

const isCommunity = (type) => !/^(n8n-nodes-base|@n8n\/n8n-nodes-langchain)\./.test(type);

export function checkEligibility({ wf, report, lists, nodes = {}, corpusEntry = null }) {
  const reasons = [];
  const pending = new Set();
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
      if (hit) add("self-fail", `${r.param} ${r.when === "empty" ? "is empty" : `= ${v}`} (${r.evidence})`, { id: r.id, node: s.node });
    }
  }

  // 3b. The bench can stand in for every main-branch step today, or a bounded fix covers it.
  const B = lists.bench;
  const need = (s, cap, why) => {
    if (cap === "local" || cap === "mock" || cap === "shim" || cap === "pin") return;
    if (typeof cap === "string" && cap.startsWith("pending:")) {
      const fix = cap.slice(8);
      if (own(B.fixes, fix)?.bounded) {
        pending.add(fix);
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

  return { eligible: reasons.length === 0, stratum: stratumOf(report.wakeup.kind), reasons, pending: [...pending].sort() };
}

// Eligibility of corpus templates by id, from the git-ignored template cache (evals/bench/data/wf),
// corpus.json and eligibility.json, with the analyzer's default answers and the fetch's --now.
export function eligibilityOf(ids) {
  const refs = (f) => JSON.parse(readFileSync(join(ROOT, "skills", "n8n-to-claude", "references", f), "utf8"));
  const nodesRef = refs("nodes.json");
  const opts = { nodes: nodesRef, capabilities: refs("capabilities.json"), hosts: refs("http-hosts.json"), now: Date.parse("2026-11-16T00:00:00Z") };
  const lists = JSON.parse(readFileSync(join(HERE, "eligibility.json"), "utf8"));
  const corpus = JSON.parse(readFileSync(join(HERE, "corpus.json"), "utf8"));
  return ids.map((id) => {
    const raw = JSON.parse(readFileSync(join(HERE, "data", "wf", `${id}.json`), "utf8"));
    const report = analyze(unwrap(raw, String(id)), opts).workflows[0];
    const wf = raw.workflow?.workflow ?? raw;
    const corpusEntry = corpus.templates.find((e) => e.id === id) ?? null;
    return { id, ...checkEligibility({ wf, report, lists, nodes: nodesRef.nodes, corpusEntry }) };
  });
}

// ---------- CLI ----------

async function main() {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
  const { roundOf, readSplits } = await import("./rounds.mjs");
  const ids = opt("--ids") ? opt("--ids").split(",").map(Number) : roundOf(readSplits()).dev.map((r) => r.id);
  const rows = eligibilityOf(ids);
  if (a.includes("--json")) return console.log(JSON.stringify(rows, null, 1));
  for (const r of rows) console.log(`${r.id}\t${r.eligible ? "eligible" : "ineligible"}\t${r.stratum}\t${r.pending.join(",") || "-"}\t${r.reasons.map((x) => `${x.clause}${x.id ? `/${x.id}` : ""}${x.node ? ` [${x.node}]` : ""}: ${x.detail}`).join(" | ")}`);
  const ok = rows.filter((r) => r.eligible);
  console.log(`eligible ${ok.length} of ${rows.length}; with a pending bench fix ${ok.filter((r) => r.pending.length).length}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
