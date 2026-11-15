#!/usr/bin/env node
// Validates bench fixtures: fixture.schema.json (with the repo's small validator) plus
// cross-checks against the template and the captured connector tools.
//
//   node evals/bench/validate.mjs [evals/bench/fixtures] [--strict] [--ids a,b]
//
// Errors (exit 1): schema violations, a hash that differs from corpus.json, node names that
// are not enabled nodes of the template, a `models` entry the model shim does not answer (P18), a read with no http/n8n/file source, a connector
// tool that is not captured, a hostile fixture without bait, a template folder missing a
// variant, a route URL that cannot be parsed (P48), expect.n8nCannotRun not the same in all
// four variants (P49), expect.n8nFails not the same in all four or naming no enabled node (P54).
// Warnings (errors with --strict): steps the analyzer marks read/unknown on the main branch,
// reachable from the fixture's trigger (P64), that the fixture neither feeds, lists nor names
// in `unfed` (P59); a poll trigger's http list longer than n8n's manual mode asks for (P22); a
// route on the n8n instance's own host (P52). Notes (never errors): one method + URL answered for
// several nodes, whose responses form one list in fixture order (P57). Cross-checks against the
// template need evals/bench/data/ (git-ignored; `node evals/bench/fetch.mjs --offline` or a
// fetch). Without ids the current round's held-out templates are skipped (counted only, P51);
// `--ids a,b` checks those templates only, held-out ones included (release points).

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../../tests/schema-check.mjs";
import { canonical } from "../fetch-survey.mjs";
import { createHash } from "node:crypto";
import { modelRoute, modelNodes, modelConsumers } from "./n8n-side.mjs";
import { readSplits, unreadableIds } from "./rounds.mjs";
import { dbPlan, planErrors } from "../n8n/databases.mjs";

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
  const notes = [];
  if (errors.length) return { errors, warnings };
  if (hashOf[fx.template] !== fx.sha256) errors.push(`sha256 differs from corpus.json for ${fx.template}`);
  if (fx.variant === "hostile" && !(fx.expect.bait ?? []).length) errors.push("hostile fixture without expect.bait");
  // PROPOSALS P38: bench-written replies, hostile only, on a model node the fixture lists.
  for (const sr of fx.expect.syntheticReplies ?? []) {
    if (fx.variant !== "hostile") errors.push(`expect.syntheticReplies: only a hostile fixture may insert replies (${fx.variant})`);
    if (!(fx.models ?? []).includes(sr.model)) errors.push(`expect.syntheticReplies: ${sr.model} is not in models`);
  }
  for (const r of fx.writeReplies ?? []) if ((r.http?.responses ?? []).some((x) => x.any)) errors.push(`writeReplies ${r.node}: any is for reads only`);
  // PROPOSALS P48: a route URL no client can send (a space in the host) can never be hit, and
  // the n8n side cannot build a route from it. An odd URL belongs in the data, not in a route.
  for (const r of [...fx.reads, ...(fx.writeReplies ?? [])]) for (const x of r.http?.responses ?? []) if (badRouteUrl(x.url)) errors.push(`${fx.reads.includes(r) ? "read" : "writeReplies"} ${r.node}: route url ${JSON.stringify(x.url)} cannot be parsed (${badRouteUrl(x.url)})`);
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
  for (const w of ownInstanceWarnings(fx)) warnings.push(w);
  // PROPOSALS P66: the databases the run seeds.
  for (const e of dbErrors(fx)) errors.push(e);
  for (const w of dbWarnings(fx)) warnings.push(w);
  for (const n of sharedRouteNotes(fx)) notes.push(n);
  if (!raw) return { errors, warnings: [...warnings, "template not downloaded: cross-checks skipped"], notes };
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
  // PROPOSALS P54, P59: the node a baseline fails at, and steps acknowledged as unfed.
  if (fx.expect?.n8nFails) need(fx.expect.n8nFails.node, "expect.n8nFails");
  for (const u of fx.unfed ?? []) need(u.node, "unfed");
  for (const r of fx.writeReplies ?? []) if (!fx.writes.includes(r.node)) errors.push(`writeReplies: "${r.node}" is not in writes`);
  for (const k of Object.keys(fx.pinData ?? {})) if (!wf.pinData?.[k]) errors.push(`pinData.${k} is not in the template's pinData`);
  if (wf.pinData && Object.keys(wf.pinData).length && !fx.pinData) errors.push("the template has pinData; copy it into pinData");
  for (const e of modelErrors(fx, wf)) errors.push(e);
  for (const w of dbNodeWarnings(fx, wf)) warnings.push(w);
  for (const w of pinnedWarnings(fx, wf)) warnings.push(w);
  for (const w of pollWarnings(fx, wf)) warnings.push(w);
  const report = await analyzerReport(raw, fx.template);
  const listed = new Set([fx.trigger.node, ...fx.reads.map((r) => r.node), ...fx.models, ...fx.writes, ...(fx.unfed ?? []).map((u) => u.node)]);
  // PROPOSALS P64: only steps the fixture's trigger reaches (and their sub-nodes); another
  // trigger's branch is not this fixture's to feed.
  const reach = reachableFrom(wf, fx.trigger.node);
  for (const s of report.steps) {
    if (s.branch !== "main" || s.role === "trigger" || listed.has(s.node) || !reach.has(s.node)) continue;
    if (s.effect === "read" || s.effect === "unknown") warnings.push(`step "${s.node}" (${s.type}, ${s.effect}) is neither fed nor listed`);
    if (s.effect === "write") warnings.push(`write step "${s.node}" is not in writes`);
  }
  return { errors, warnings, notes };
}

// PROPOSALS P64: the nodes a trigger reaches over main connections, plus every sub-node that
// feeds one of them over an ai_* connection (a model, a tool, its embeddings), transitively.
export function reachableFrom(wf, trigger) {
  const conn = wf?.connections ?? {};
  const seen = new Set([trigger]);
  const queue = [trigger];
  while (queue.length) {
    const n = queue.shift();
    for (const list of conn[n]?.main ?? []) for (const e of list ?? []) if (e?.node && !seen.has(e.node)) seen.add(e.node), queue.push(e.node);
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const [from, outs] of Object.entries(conn)) {
      if (seen.has(from)) continue;
      const feeds = Object.entries(outs ?? {}).some(([type, lists]) => type.startsWith("ai_") && (lists ?? []).some((l) => (l ?? []).some((e) => seen.has(e?.node))));
      if (feeds) seen.add(from), (grew = true);
    }
  }
  return seen;
}

// PROPOSALS P52: a route on `localhost` reaches the mock (the run drops it from the n8n
// container's NO_PROXY, n8n-side.mjs templateEnv), but 127.0.0.1 and ::1 stay out of the proxy
// (n8n's task broker and runners use them), so a route there feeds the Claude side only; such a
// template is n8nCannotRun.
const OWN_HOSTS = new Set(["127.0.0.1", "[::1]", "::1"]);
export function ownInstanceWarnings(fx) {
  const out = [];
  for (const r of [...fx.reads, ...(fx.writeReplies ?? [])]) {
    for (const x of r.http?.responses ?? []) {
      let u;
      try {
        u = new URL(x.url);
      } catch {
        continue;
      }
      if (OWN_HOSTS.has(u.hostname) && !fx.expect?.n8nCannotRun) out.push(`${r.node}: route ${x.method} ${u.origin} is a loopback address the n8n container never proxies (its task runners use it), so it never reaches the mock on the n8n side (PROPOSALS P52); use localhost in the route if the template does, else mark expect.n8nCannotRun`);
    }
  }
  return out;
}

// PROPOSALS P89: n8n's manual run returns the template's own pins instead of running the node,
// so a model or write the template pins makes no call on the n8n side (the Claude side does not
// pin). Such an entry is listed knowingly, or the step is measured on nothing.
export function pinnedWarnings(fx, wf) {
  const pinned = new Set(Object.keys(wf?.pinData ?? {}).filter((n) => n !== fx.trigger?.node));
  return [...fx.models.filter((m) => pinned.has(m)).map((m) => `models: "${m}" is pinned by the template's pinData, so n8n's manual run never calls it (PROPOSALS P89)`), ...fx.writes.filter((w) => pinned.has(w)).map((w) => `writes: "${w}" is pinned by the template's pinData, so n8n's manual run sends no request for it (PROPOSALS P89)`)];
}

// PROPOSALS P57: responses for one method + URL (+ query, bodyMatch) given under several nodes
// form one list in fixture order across nodes, replied in turn, the last repeating.
export function sharedRouteNotes(fx) {
  const by = new Map();
  for (const r of [...fx.reads, ...(fx.writeReplies ?? [])]) {
    for (const x of r.http?.responses ?? []) {
      const k = `${x.method} ${x.url}${x.query ? " " + JSON.stringify(x.query) : ""}${x.bodyMatch !== undefined ? " " + JSON.stringify(x.bodyMatch) : ""}`;
      if (!by.has(k)) by.set(k, []);
      if (!by.get(k).includes(r.node)) by.get(k).push(r.node);
    }
  }
  return [...by].filter(([, nodes]) => nodes.length > 1).map(([k, nodes]) => `${k} is answered for ${nodes.map((n) => `"${n}"`).join(", ")}: one list in fixture order across these nodes, replied in turn (P57)`);
}

// PROPOSALS P49: what holds for a template, not a variant, must agree across its four fixtures:
// expect.n8nCannotRun (the bench's n8n image cannot run the main path whatever the data), so
// the row and summary.mjs never depend on which variant was read.
export function crossVariantErrors(byVariant) {
  const errors = [];
  const why = Object.entries(byVariant).map(([v, fx]) => [v, fx?.expect?.n8nCannotRun ?? null]);
  if (new Set(why.map(([, w]) => w)).size > 1) errors.push(`expect.n8nCannotRun differs between variants (${why.map(([v, w]) => `${v}: ${w === null ? "none" : "set"}`).join(", ")}); it describes the image, not the data, so all four carry the same text`);
  // PROPOSALS P54: expect.n8nFails describes the template's own configuration, not the data.
  const fails = Object.entries(byVariant).map(([v, fx]) => [v, fx?.expect?.n8nFails ? JSON.stringify(fx.expect.n8nFails) : null]);
  if (new Set(fails.map(([, w]) => w)).size > 1) errors.push(`expect.n8nFails differs between variants (${fails.map(([v, w]) => `${v}: ${w === null ? "none" : "set"}`).join(", ")}); it describes the template's own configuration, not the data, so all four carry the same value`);
  return errors;
}

// PROPOSALS P48: why a fixture route's URL cannot be parsed, or null when it can.
export function badRouteUrl(url) {
  try {
    new URL(url);
    return null;
  } catch (e) {
    return e.code === "ERR_INVALID_URL" ? "invalid URL" : String(e.message);
  }
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
  const idsArg = args.includes("--ids") ? args[args.indexOf("--ids") + 1].split(",").filter(Boolean) : null;
  const dir = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--ids") ?? join(HERE, "fixtures");
  let bad = 0;
  let files = 0;
  // PROPOSALS P51: without ids, the current round's held-out templates (and any later round's
  // already drawn) are not checked here (a fixing session must not read their warnings); they
  // are counted only.
  let all = readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory()).sort();
  if (idsArg) all = all.filter((d) => idsArg.includes(d));
  else {
    const held = new Set(unreadableIds(readSplits()).map(String));
    const skipped = all.filter((d) => held.has(d)).length;
    all = all.filter((d) => !held.has(d));
    if (skipped) console.log(`${skipped} current held-out templates skipped (pass --ids to check them at a release point)`);
  }
  for (const id of all) {
    const tplFile = join(HERE, "data", "wf", `${id}.json`);
    const raw = existsSync(tplFile) ? JSON.parse(readFileSync(tplFile, "utf8")) : null;
    const byVariant = {};
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
      byVariant[v] = fx;
      const { errors, warnings, notes = [] } = await checkFixture(fx, raw);
      if (fx.template !== Number(id) || fx.variant !== v) errors.push("template or variant does not match the path");
      const fail = errors.length || (strict && warnings.length);
      if (fail) bad++;
      for (const e of errors) console.log(`${id}/${v}: ERROR ${e}`);
      for (const w of warnings) console.log(`${id}/${v}: ${strict ? "ERROR" : "warn"} ${w}`);
      for (const n of notes) console.log(`${id}/${v}: note ${n}`);
    }
    for (const e of crossVariantErrors(byVariant)) {
      console.log(`${id}: ERROR ${e}`);
      bad++;
    }
  }
  console.log(`${files} fixture files, ${bad} failing`);
  process.exit(bad ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

// PROPOSALS P66: a `db` the sidecar would refuse before any run: a row key that is not a column, a
// type that could end the statement, a document that is not an object.
export function dbErrors(fx) {
  return planErrors(dbPlan(fx, { stamp: 0 }));
}
export function dbWarnings(fx) {
  const out = [];
  for (const r of fx.reads ?? []) {
    const e = r.db?.engine;
    if (!e) continue;
    if (e === "mysql") out.push(`read ${r.node}: MySQL has no sidecar (P66); n8n's credential stays unreachable`);
    else if (!fx.db?.[e] && r.db.seed) out.push(`read ${r.node}: legacy db.seed, column types inferred from the values; write the fixture's top-level db.${e} with typed columns`);
    else if (!fx.db?.[e]) out.push(`read ${r.node}: no db.${e} in the fixture, so the run's ${e} database is empty`);
  }
  return out;
}
// An enabled Postgres or MongoDB node the fixture gives no database of its engine: n8n's
// credential then points at an unreachable host.
function dbNodeEngine(type) {
  return { "n8n-nodes-base.postgres": "postgres", "n8n-nodes-base.postgresTool": "postgres", "n8n-nodes-base.mongoDb": "mongodb", "n8n-nodes-base.mongoDbTool": "mongodb" }[type];
}
export function dbNodeWarnings(fx, wf) {
  const plan = dbPlan(fx, { stamp: 0 }) ?? {};
  const reach = reachableFrom(wf, fx.trigger.node);
  const by = {};
  for (const n of wf?.nodes ?? []) {
    const e = !n.disabled && reach.has(n.name) && dbNodeEngine(n.type);
    if (e && !plan[e] && ![...fx.reads, ...(fx.writeReplies ?? [])].some((r) => r.node === n.name && r.n8n)) (by[e] ??= []).push(n.name);
  }
  return Object.entries(by).map(([e, nodes]) => `${nodes.join(", ")} (${e}): the fixture has no db.${e}, so n8n's credential points at an unreachable host`);
}
