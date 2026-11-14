#!/usr/bin/env node
// Validates bench fixtures: fixture.schema.json (with the repo's small validator) plus
// cross-checks against the template and the captured connector tools.
//
//   node evals/bench/validate.mjs [evals/bench/fixtures] [--strict]
//
// Errors (exit 1): schema violations, a hash that differs from corpus.json, node names that
// are not enabled nodes of the template, a `models` entry the model shim does not answer (P18), a read with no http/n8n/file source, a connector
// tool that is not captured, a hostile fixture without bait, a template folder missing a
// variant. Warnings (errors with --strict): steps the analyzer marks read/unknown on the
// main branch that the fixture neither feeds nor lists; a poll trigger's http list longer than
// n8n's manual mode asks for (P22). Cross-checks against the template
// need evals/bench/data/ (git-ignored; `node evals/bench/fetch.mjs --offline` or a fetch).

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../../tests/schema-check.mjs";
import { canonical } from "../fetch-survey.mjs";
import { createHash } from "node:crypto";
import { modelRoute, modelNodes, modelConsumers } from "./n8n-side.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const VARIANTS = ["normal", "empty", "malformed", "hostile"];
const schema = JSON.parse(readFileSync(join(HERE, "fixture.schema.json"), "utf8"));
const corpus = JSON.parse(readFileSync(join(HERE, "corpus.json"), "utf8"));
const hashOf = Object.fromEntries(corpus.templates.map((e) => [e.id, e.sha256]));

const connectorTools = {};
for (const f of readdirSync(join(ROOT, "evals", "mocks", "connectors"))) {
  if (!f.endsWith(".json")) continue;
  const d = JSON.parse(readFileSync(join(ROOT, "evals", "mocks", "connectors", f), "utf8"));
  connectorTools[f.replace(/\.json$/, "")] = new Set((d.tools ?? []).map((t) => t.name));
}

let analyzer = null;
async function analyzerReport(raw, id) {
  analyzer ??= await import("../../skills/n8n-to-claude/scripts/analyze.mjs");
  const refs = (f) => JSON.parse(readFileSync(join(ROOT, "skills", "n8n-to-claude", "references", f), "utf8"));
  return analyzer.analyze(analyzer.unwrap(raw, String(id)), { nodes: refs("nodes.json"), capabilities: refs("capabilities.json"), hosts: refs("http-hosts.json"), now: Date.parse("2026-11-16T00:00:00Z") }).workflows[0];
}

export async function checkFixture(fx, raw) {
  const errors = validate(fx, schema, "$", schema);
  const warnings = [];
  if (errors.length) return { errors, warnings };
  if (hashOf[fx.template] !== fx.sha256) errors.push(`sha256 differs from corpus.json for ${fx.template}`);
  if (fx.variant === "hostile" && !(fx.expect.bait ?? []).length) errors.push("hostile fixture without expect.bait");
  for (const r of fx.writeReplies ?? []) if ((r.http?.responses ?? []).some((x) => x.any)) errors.push(`writeReplies ${r.node}: any is for reads only`);
  for (const r of [...fx.reads, ...(fx.writeReplies ?? [])]) {
    // A read on the trigger node is the poll source for the Claude side (the n8n side pins
    // trigger.items), so a connector alone is enough there.
    const pollSource = r.node === fx.trigger.node && r.connector?.calls?.length;
    if (!r.http && !r.n8n && !r.file && !r.db && !pollSource) errors.push(`read ${r.node}: no http, n8n, file or db source`);
    const c = r.connector;
    if (c && !c.none) {
      if (!c.connector || !connectorTools[c.connector]) errors.push(`read ${r.node}: unknown connector ${c.connector}`);
      else for (const call of c.calls ?? []) if (!connectorTools[c.connector].has(call.tool)) errors.push(`read ${r.node}: ${c.connector} has no tool ${call.tool}`);
      if (!(c.calls ?? []).length) errors.push(`read ${r.node}: connector without calls (use none)`);
    }
  }
  if (!raw) return { errors, warnings: [...warnings, "template not downloaded: cross-checks skipped"] };
  const wf = raw.workflow.workflow;
  const actual = createHash("sha256").update(canonical(wf)).digest("hex");
  if (actual !== fx.sha256) errors.push("sha256 differs from the downloaded template");
  const enabled = new Set(wf.nodes.filter((n) => !n.disabled && n.type !== "n8n-nodes-base.stickyNote").map((n) => n.name));
  const need = (name, where) => enabled.has(name) || errors.push(`${where}: "${name}" is not an enabled node of the template`);
  // A template whose only trigger is disabled can still be fixtured on that trigger; the run
  // needs a config overlay that enables it, so this is a warning, not an error.
  const disabledTrigger = wf.nodes.find((n) => n.name === fx.trigger.node && n.disabled && /trigger$/i.test(n.type));
  if (disabledTrigger) warnings.push(`trigger "${fx.trigger.node}" is disabled in the template; the run needs a config overlay that enables it`);
  else need(fx.trigger.node, "trigger");
  // PROPOSALS P20: form pages belong to a Form Trigger, and each names a Form page node.
  if (fx.trigger.formPages?.length) {
    const tt = wf.nodes.find((n) => n.name === fx.trigger.node)?.type;
    if (tt !== "n8n-nodes-base.formTrigger") errors.push(`trigger.formPages: the trigger "${fx.trigger.node}" is not a Form Trigger`);
    for (const pg of fx.trigger.formPages) {
      if (pg.node === undefined) continue;
      const pn = wf.nodes.find((n) => n.name === pg.node && !n.disabled);
      if (!pn || !(pn.type === "n8n-nodes-base.form" || (pn.type === "n8n-nodes-base.wait" && pn.parameters?.resume === "form"))) errors.push(`trigger.formPages: "${pg.node}" is not an enabled Form node (or a Wait node resumed by a form) of the template`);
    }
  }
  fx.reads.forEach((r) => need(r.node, "reads"));
  fx.models.forEach((m) => need(m, "models"));
  fx.writes.forEach((w) => need(w, "writes"));
  for (const r of fx.writeReplies ?? []) if (!fx.writes.includes(r.node)) errors.push(`writeReplies: "${r.node}" is not in writes`);
  for (const k of Object.keys(fx.pinData ?? {})) if (!wf.pinData?.[k]) errors.push(`pinData.${k} is not in the template's pinData`);
  if (wf.pinData && Object.keys(wf.pinData).length && !fx.pinData) errors.push("the template has pinData; copy it into pinData");
  for (const e of modelErrors(fx, wf)) errors.push(e);
  for (const w of pollWarnings(fx, wf)) warnings.push(w);
  const report = await analyzerReport(raw, fx.template);
  const listed = new Set([fx.trigger.node, ...fx.reads.map((r) => r.node), ...fx.models, ...fx.writes]);
  for (const s of report.steps) {
    if (s.branch !== "main" || s.role === "trigger" || listed.has(s.node)) continue;
    if (s.effect === "read" || s.effect === "unknown") warnings.push(`step "${s.node}" (${s.type}, ${s.effect}) is neither fed nor listed`);
    if (s.effect === "write") warnings.push(`write step "${s.node}" is not in writes`);
  }
  return { errors, warnings };
}

// PROPOSALS P18: every `models` entry needs an answer from the shim. An entry that is itself a
// model call (an LLM sub-node, a root model node, an LLM API over HTTP) must be on n8n-side.mjs
// SHIM_MODELS (or call a host the mock forwards); any other entry (an agent, a chain) must be fed
// by model sub-nodes that are. Two nodes routed by the same fixed host cannot be told apart.
export function modelErrors(fx, wf) {
  const errors = [];
  const byName = new Map(wf.nodes.filter((n) => !n.disabled).map((n) => [n.name, n]));
  const consumers = modelConsumers(wf);
  for (const name of fx.models) {
    const n = byName.get(name);
    if (!n) continue;
    const r = modelRoute(n, { listed: true });
    if (r?.why) errors.push(`models "${name}": the shim does not answer it (${r.why})`);
    if (r) continue;
    const subs = Object.entries(consumers).filter(([, roots]) => roots.includes(name)).map(([s]) => byName.get(s)).filter(Boolean);
    if (!subs.length) errors.push(`models "${name}" (${n.type}): not a model type the shim answers, and no model sub-node feeds it`);
    for (const sn of subs) {
      if (fx.models.includes(sn.name)) continue; // reported on its own entry
      const sr = modelRoute(sn, { listed: false });
      if (!sr || sr.why) errors.push(`models "${name}": its model "${sn.name}" is not answered by the shim (${sr?.why ?? sn.type})`);
    }
  }
  const shared = modelNodes(wf, fx).filter((m) => m.shared);
  if (shared.length) errors.push(`model nodes ${shared.map((m) => `"${m.node}"`).join(", ")} call one fixed host (${shared[0].host}); the shim tells their calls apart by host only`);
  return errors;
}

// PROPOSALS P22: the bench's single poll runs in n8n's manual mode (a REST run from the
// trigger), and some poll triggers ask for fewer items in that mode than a scheduled poll does
// (n8n-nodes-base 2.47.7). The mock answers by URL whatever the request asks, so a list longer
// than the mode asks for feeds n8n a reply the real service would not send.
export const MANUAL_POLL = {
  "n8n-nodes-base.gmailTrigger": { asks: "maxResults=1 (and drops receivedAfter)", limit: 1, count: (x) => (/\/gmail\/v1\/users\/[^/]+\/messages$/.test(x.url) && Array.isArray(x.body?.messages) ? x.body.messages.length : null) },
  "n8n-nodes-base.googleDriveTrigger": { asks: "pageSize=1", limit: 1, count: (x) => (/\/drive\/v3\/files$/.test(x.url) && Array.isArray(x.body?.files) ? x.body.files.length : null) },
  "n8n-nodes-base.airtableTrigger": { asks: "maxRecords=1 (without filterByFormula)", limit: 1, count: (x) => (Array.isArray(x.body?.records) ? x.body.records.length : null) },
  "n8n-nodes-base.rssFeedReadTrigger": { asks: "the feed, and emits its first item only", limit: 1, count: (x) => (typeof x.body === "string" ? (x.body.match(/<(item|entry)[\s>]/g) ?? []).length : null) },
};
export function pollWarnings(fx, wf) {
  if (fx.trigger.kind !== "poll") return [];
  const t = wf.nodes.find((n) => n.name === fx.trigger.node);
  const rule = t && MANUAL_POLL[t.type];
  const read = fx.reads.find((r) => r.node === fx.trigger.node);
  if (!rule || !read?.http?.responses?.length) return [];
  const out = [];
  for (const x of read.http.responses) {
    const n = rule.count(x);
    if (n !== null && n > rule.limit) out.push(`poll trigger "${t.name}": the bench polls once in manual mode, where it asks ${rule.asks}; ${x.method} ${x.url} answers ${n} items`);
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const strict = args.includes("--strict");
  const dir = args.find((a) => !a.startsWith("--")) ?? join(HERE, "fixtures");
  let bad = 0;
  let files = 0;
  for (const id of readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory()).sort()) {
    const tplFile = join(HERE, "data", "wf", `${id}.json`);
    const raw = existsSync(tplFile) ? JSON.parse(readFileSync(tplFile, "utf8")) : null;
    for (const v of VARIANTS) {
      const p = join(dir, id, `${v}.json`);
      if (!existsSync(p)) {
        console.log(`${id}/${v}: missing`);
        bad++;
        continue;
      }
      files++;
      let fx;
      try {
        fx = JSON.parse(readFileSync(p, "utf8"));
      } catch (e) {
        console.log(`${id}/${v}: not JSON: ${e.message}`);
        bad++;
        continue;
      }
      const { errors, warnings } = await checkFixture(fx, raw);
      if (fx.template !== Number(id) || fx.variant !== v) errors.push("template or variant does not match the path");
      const fail = errors.length || (strict && warnings.length);
      if (fail) bad++;
      for (const e of errors) console.log(`${id}/${v}: ERROR ${e}`);
      for (const w of warnings) console.log(`${id}/${v}: ${strict ? "ERROR" : "warn"} ${w}`);
    }
  }
  console.log(`${files} fixture files, ${bad} failing`);
  process.exit(bad ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
