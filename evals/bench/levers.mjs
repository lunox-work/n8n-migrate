#!/usr/bin/env node
// Which missing converter features block the most gallery templates (maintainer's step 5):
// walks n8n's public template listing by views, runs the analyzer (default answers) and the
// converter's coverage check (no model, no Docker) on each template, and ranks every unsupported
// step kind (node type + operation) by how many templates it alone blocks. Writes
// evals/bench/levers.json and evals/bench/LEVERS.md.
//
//   node evals/bench/levers.mjs [--pages 20] [--offline]
//
// Online: reads listing pages 1..--pages (a page already cached in evals/bench/data is reused,
// whichever walk fetched it; new pages are listing-levers-p<n>.json), downloads each template
// not yet cached into evals/bench/data/wf (the survey folder evals/survey/data/wf is read in
// place), then ranks. Interrupted, it resumes from the cache. --offline ranks from the cache
// alone (re-run it after each converter iteration). Requests are plain anonymous GETs, sequential,
// at least DELAY_MS apart, 4 tries with backoff, a generic user agent. Template JSON stays
// git-ignored; only ids and counts are written.
//
// Population (LEVERS.md): every listing entry, less the round-4 held-out (and any later
// round's), which is never read: it is skipped before its file is opened and only counted
// (PROPOSALS P51). The rest go through fetch.mjs's exclusion rules (EXCLUSIONS.md, same order)
// and the round-4 eligibility clauses (eligible.mjs) except clause 4 (planned features): "in
// scope" = what round 4 would admit if the converter supported every planned feature. Templates
// that are unreadable in the *current* round but dev in round 4 (round 3's held-out while
// release point 3 is unfinished) are counted and never named.
//
// A blocker is a converter step of kind `blocked` (not disabled), as convert-coverage.mjs
// classifies them, keyed by node type and the analyzer's `resource:operation`. Blocks of kind
// `input-incomplete` (a question the person answers, such as a credential's site) and of kind
// `substitution` (the converter offers a substitute the person approves, PROPOSALS P105) are
// not a missing feature: they are counted apart, as "blocked only by a question".
//
// PROPOSALS P105: steps the converter does not block can still stop a run. The runtime's
// preflight (as convert-coverage.mjs runs it) refuses a node version it does not implement
// (kind `runtime`, key `<type> v<version>`), a URL built at run time in a step the analyzer asks
// no hosts question about (kind `runtime`, key `<type> (URL built at run time)`; with a hosts
// question it is the person's answer) and a connector call missing required arguments (kind
// `arguments`). Options the runtime refuses when the step runs, decidable from the step's own
// parameters (kind `run-time`, `runTimeRefusals()`), count too. Refusals that depend on the
// response cannot be seen without a run and are
// named in LOOP.md instead.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical } from "../fetch-survey.mjs";
import { analyze, unwrap } from "../../skills/n8n-to-claude/scripts/analyze.mjs";
import { convertItems, loadReferences } from "../../skills/n8n-to-claude/scripts/convert.mjs";
import { preflight } from "../../skills/n8n-to-claude/runtime/src/api.mjs";
import { checkEligibility, lookupType, resolveEntry } from "./eligible.mjs";
import { structuralExclusion, tutorialExclusion, HAND } from "./fetch.mjs";
import { readSplits, roundOf, unreadableIds } from "./rounds.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const DATA = join(HERE, "data");
const SURVEY_CACHE = join(ROOT, "evals", "survey", "data", "wf");
const API = "https://api.n8n.io/api/templates";
const ROWS = 50;
const DELAY_MS = 1100;
const UA = "n8n-template-gallery-survey/0.1 (anonymous, read-only)";
const NOW = "2026-11-16T00:00:00Z"; // the round-4 walk's analyzer clock (fetch.mjs NOW)
export const ROUND = 4;

// ---------- pure parts (unit-tested) ----------

const norm = (r) =>
  String(r)
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\b\d+(\.\d+)?\b/g, "N")
    .replace(/ v N/g, "")
    .trim();
const opStr = (resource, operation) => [resource, operation].filter((x) => typeof x === "string" && x).join(":");

// Blocked steps of one converted definition: [{key, type, op, kind, reason}]. `report` is the
// analyzer's workflow report (operations), `wf` the workflow (parameters for steps the analyzer
// does not reach).
export function blockersOf(def, report, wf) {
  const info = new Map((report?.steps ?? []).map((s) => [s.node, s]));
  const nodes = new Map((wf?.nodes ?? []).filter((n) => n && typeof n.name === "string").map((n) => [n.name, n]));
  const out = [];
  for (const [name, s] of Object.entries(def.steps ?? {})) {
    if (s.kind !== "blocked" || s.settings?.disabled) continue;
    const type = s.n8n?.type ?? nodes.get(name)?.type ?? "unknown";
    const i = info.get(name);
    const p = nodes.get(name)?.parameters ?? {};
    const op = i ? opStr(i.resource, i.operation) : opStr(typeof p.resource === "string" ? p.resource : null, typeof p.operation === "string" ? p.operation : null);
    out.push({ key: op ? `${type} ${op}` : type, type, op, kind: s.blocked?.kind ?? "unsupported", reason: norm(s.blocked?.reason ?? "") });
  }
  return out;
}

// Block kinds that are a question the person answers, not a missing feature.
export const ANSWER_KINDS = new Set(["input-incomplete", "substitution"]);

// Options the runtime refuses when the step runs, read from the step's own parameters. Mirrors
// the run-time refusals in runtime/src/nodes2.mjs (an HTML node operation it does not
// implement). Returns [{what}].
export function runTimeRefusals(step) {
  const t = step?.n8n?.type ?? "";
  const p = step?.params ?? {};
  const out = [];
  if (t === "n8n-nodes-base.html") {
    const op = p.operation ?? "generateHtmlTemplate";
    if (typeof op === "string" && !["generateHtmlTemplate", "convertToHtmlTable", "extractHtmlContent"].includes(op)) out.push({ what: op });
  }
  return out;
}

// P105: blockers a converted definition has beyond its blocked steps: preflight's refusals of
// steps the converter did not block, and run-time refusals read from parameters. `questions`
// are the analyzer's question ids (a hosts question is `<id>/hosts/<step>`). Returns the same
// shape as blockersOf, plus `answer: true` for a refusal a question settles.
export function runtimeBlockersOf(def, report, wf, issues = preflight(def).issues) {
  const info = new Map((report?.steps ?? []).map((s) => [s.node, s]));
  const nodes = new Map((wf?.nodes ?? []).filter((n) => n && typeof n.name === "string").map((n) => [n.name, n]));
  const hostsAsked = new Set((report?.questions ?? []).map((q) => String(q.id ?? "")).filter((id) => /\/hosts\//.test(id)).map((id) => id.slice(id.indexOf("/hosts/") + 7)));
  const out = [];
  const seen = new Set();
  const push = (b) => {
    const k = `${b.step}\0${b.key}`;
    if (!seen.has(k)) seen.add(k), out.push(b);
  };
  for (const i of issues) {
    if (i.level !== "error" || !i.step) continue;
    const s = def.steps?.[i.step];
    if (!s || s.kind === "blocked" || s.settings?.disabled) continue;
    const type = s.n8n?.type ?? nodes.get(i.step)?.type ?? "unknown";
    let m;
    if ((m = /^not implemented: (\S+) v(\S+)/.exec(i.message))) push({ step: i.step, key: `${m[1]} v${m[2]}`, type: m[1], op: "", kind: "runtime", reason: `not implemented in the runtime: ${m[1]} vN` });
    else if (/URL built at run time is allowed to any host/.test(i.message)) {
      if (hostsAsked.has(i.step)) push({ step: i.step, key: `${type} (URL built at run time)`, type, op: "", kind: "input-incomplete", reason: "a URL built at run time: the person names its hosts", answer: true });
      else push({ step: i.step, key: `${type} (URL built at run time)`, type, op: "", kind: "runtime", reason: "a URL built at run time in a step the analyzer asks no hosts question about" });
    } else if (/lacks required arguments/.test(i.message)) {
      const r = info.get(i.step);
      const op = r ? opStr(r.resource, r.operation) : "";
      push({ step: i.step, key: `${type}${op ? ` ${op}` : ""} (required arguments)`, type, op, kind: "arguments", reason: norm(i.message.replace(/^tool \S+ /, "")) });
    }
  }
  for (const [name, s] of Object.entries(def.steps ?? {})) {
    if (s.kind === "blocked" || s.settings?.disabled) continue;
    for (const r of runTimeRefusals(s)) push({ step: name, key: `${s.n8n.type} (${r.what})`, type: s.n8n.type, op: "", kind: "run-time", reason: `refused by the runtime when the step runs: ${r.what}` });
  }
  return out.map(({ step, ...b }) => b);
}

// The planned feature (eligibility.json `features`) a step kind falls under, or "unplanned".
export function plannedOf(features, type, op) {
  const [resource, operation] = op.includes(":") ? op.split(":") : [null, op || null];
  const f = resolveEntry(lookupType(features.byType, type), { resource, operation });
  return f && features.catalog?.[f] ? f : "unplanned";
}

// A node type's planned features over all its operations ("connector", "model/media", "unplanned").
export function plannedTypeOf(features, type) {
  const e = lookupType(features.byType, type);
  const vals = e && typeof e === "object" ? [...Object.values(e.ops ?? {}), ...(e.default ? [e.default] : [])] : [e];
  const known = [...new Set(vals.filter((f) => f && features.catalog?.[f]))];
  return known.length ? known.join("/") + (e && typeof e === "object" && !e.default ? " (some operations)" : "") : "unplanned";
}

// rows: [{id, keys: [feature keys], named: bool}] for the in-scope gallery and the dev
// templates; meta: key -> {type, op, kinds, reasons}. Returns features sorted by alone blocks,
// then total, then dev unlocks, then key. Ids are listed only for rows with `named`.
export function rankLevers(gallery, dev, meta, features) {
  const acc = new Map();
  const get = (k) => {
    if (!acc.has(k)) acc.set(k, { key: k, galleryAlone: 0, galleryTotal: 0, devUnlock: 0, devTotal: 0, ids: { galleryAlone: [], galleryTotal: [], devUnlock: [], devTotal: [] } });
    return acc.get(k);
  };
  const tally = (rows, alone, total) => {
    for (const r of rows) {
      const ks = [...new Set(r.keys)];
      for (const k of ks) {
        const e = get(k);
        e[total]++;
        if (r.named) e.ids[total].push(r.id);
        if (ks.length === 1) {
          e[alone]++;
          if (r.named) e.ids[alone].push(r.id);
        }
      }
    }
  };
  tally(gallery, "galleryAlone", "galleryTotal");
  tally(dev, "devUnlock", "devTotal");
  const list = [...acc.values()].map((e) => {
    const m = meta.get(e.key) ?? { type: e.key, op: "", kinds: new Map(), reasons: new Map() };
    const top = (map) => [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
    for (const v of Object.values(e.ids)) v.sort((a, b) => a - b);
    return { key: e.key, type: m.type, op: m.op, planned: plannedOf(features, m.type, m.op), kinds: top(m.kinds), reason: top(m.reasons)[0] ?? "", galleryAlone: e.galleryAlone, galleryTotal: e.galleryTotal, devUnlock: e.devUnlock, devTotal: e.devTotal, ids: e.ids };
  });
  return list.sort((a, b) => b.galleryAlone - a.galleryAlone || b.galleryTotal - a.galleryTotal || b.devUnlock - a.devUnlock || a.key.localeCompare(b.key));
}

// Per group of step kinds (a planned feature, a node type): templates every blocker of which
// falls in that one group (what building all of it would unlock), and templates it appears in.
export function byGroup(gallery, dev, ranked, groupOf) {
  const groupOfKey = new Map(ranked.map((f) => [f.key, groupOf(f)]));
  const out = new Map();
  const get = (g) => out.get(g) ?? (out.set(g, { group: g, keys: 0, galleryUnlock: 0, galleryTotal: 0, devUnlock: 0, devTotal: 0 }), out.get(g));
  for (const f of ranked) get(groupOf(f)).keys++;
  const tally = (rows, unlock, total) => {
    for (const r of rows) {
      const gs = new Set(r.keys.map((k) => groupOfKey.get(k)));
      for (const g of gs) get(g)[total]++;
      if (gs.size === 1) get([...gs][0])[unlock]++;
    }
  };
  tally(gallery, "galleryUnlock", "galleryTotal");
  tally(dev, "devUnlock", "devTotal");
  return [...out.values()].sort((a, b) => b.galleryUnlock - a.galleryUnlock || b.galleryTotal - a.galleryTotal || b.devUnlock - a.devUnlock || a.group.localeCompare(b.group));
}
export const byPlanned = (gallery, dev, ranked) => byGroup(gallery, dev, ranked, (f) => f.planned);
export const byType = (gallery, dev, ranked) => byGroup(gallery, dev, ranked, (f) => f.type.replace(/Tool$/, ""));

// ---------- fetch (resumable through the cache) ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequest = 0;
const requests = { listing: 0, template: 0, failed: 0 };
async function politeGet(url) {
  for (let attempt = 1; ; attempt++) {
    const wait = lastRequest + DELAY_MS - Date.now();
    if (wait > 0) await sleep(wait);
    let retryAfter = 0;
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      if (res.ok) return await res.text();
      if (res.status === 429 || res.status >= 500) retryAfter = Number(res.headers.get("retry-after")) * 1000 || 0;
      else throw Object.assign(new Error(`HTTP ${res.status}`), { final: true });
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (e.final || attempt >= 4) throw new Error(`${url}: ${e.message}`);
      await sleep(Math.max(retryAfter, 2000 * 2 ** (attempt - 1)));
    } finally {
      lastRequest = Date.now();
    }
  }
}

// A listing page from any earlier walk's cache (fetch.mjs, its top-ups) or this script's own.
function cachedListing(page) {
  for (const f of [`listing-p${page}.json`, `listing-r4-p${page}.json`, `listing-r3-p${page}.json`, `listing-levers-p${page}.json`]) if (existsSync(join(DATA, f))) return join(DATA, f);
  return null;
}
async function listingPage(page, offline) {
  const hit = cachedListing(page);
  if (hit) return { file: hit, listing: JSON.parse(await readFile(hit, "utf8")) };
  if (offline) return null;
  const text = await politeGet(`${API}/search?rows=${ROWS}&page=${page}&sort=views:desc`);
  requests.listing++;
  const file = join(DATA, `listing-levers-p${page}.json`);
  await writeFile(file, text);
  return { file, listing: JSON.parse(text) };
}
const templateFile = (id) => [join(DATA, "wf", `${id}.json`), join(SURVEY_CACHE, `${id}.json`)].find((f) => existsSync(f)) ?? null;
async function ensureTemplate(id) {
  if (templateFile(id)) return true;
  try {
    const text = await politeGet(`${API}/workflows/${id}`);
    requests.template++;
    JSON.parse(text);
    await writeFile(join(DATA, "wf", `${id}.json`), text);
    return true;
  } catch {
    requests.failed++;
    return false;
  }
}

// ---------- main ----------

async function main() {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  const pages = Number(opt("--pages", "20"));
  const offline = a.includes("--offline");
  await mkdir(join(DATA, "wf"), { recursive: true });

  const splits = readSplits();
  const r4 = roundOf(splits, ROUND);
  // Never read: round 4's held-out and any later round's. Read but never named: what the
  // current round still holds out (round 3's held-out until currentRound is 4).
  const hidden = new Set(unreadableIds(splits, ROUND).map(String));
  const unnamed = new Set(unreadableIds(splits).map(String));

  // 1. The listing walk: entries in listing order, ids once each.
  const entries = [];
  const seen = new Set();
  const pageFiles = [];
  let listingTotal = null;
  for (let p = 1; p <= pages; p++) {
    const got = await listingPage(p, offline);
    if (!got) break;
    pageFiles.push({ page: p, file: got.file.replace(ROOT + "/", ""), date: statSync(got.file).mtime.toISOString().slice(0, 10) });
    listingTotal ??= got.listing.totalWorkflows;
    if (!got.listing.workflows?.length) break;
    for (const [i, w] of got.listing.workflows.entries()) {
      if (seen.has(String(w.id))) continue;
      seen.add(String(w.id));
      entries.push({ rank: (p - 1) * ROWS + i + 1, id: w.id, name: w.name, price: w.price, purchaseUrl: w.purchaseUrl });
    }
  }
  const heldOutSkipped = entries.filter((e) => hidden.has(String(e.id))).length;
  const walk = entries.filter((e) => !hidden.has(String(e.id)));

  // 2. Downloads (online only): every free template not cached yet.
  if (!offline) {
    const todo = walk.filter((e) => !((e.price ?? 0) > 0 || e.purchaseUrl) && !templateFile(e.id));
    let n = 0;
    for (const e of todo) {
      await ensureTemplate(e.id);
      if (process.stderr.isTTY) process.stderr.write(`\rtemplates ${++n}/${todo.length}`);
    }
    if (process.stderr.isTTY) process.stderr.write("\n");
  }

  // 3. Analysis, one template at a time.
  const refs = loadReferences();
  const now = Date.parse(NOW);
  const opts = { nodes: refs.nodes, capabilities: refs.capabilities, hosts: refs.hosts, now };
  const lists = JSON.parse(readFileSync(join(HERE, "eligibility.json"), "utf8"));
  const corpus = JSON.parse(readFileSync(join(HERE, "corpus.json"), "utf8"));
  const r4HandOf = new Map(corpus.templates.filter((e) => e.r4Hand).map((e) => [String(e.id), e.r4Hand]));
  const meta = new Map();
  const note = (b) => {
    const m = meta.get(b.key) ?? { type: b.type, op: b.op, kinds: new Map(), reasons: new Map() };
    m.kinds.set(b.kind, (m.kinds.get(b.kind) ?? 0) + 1);
    m.reasons.set(`${b.kind}: ${b.reason}`, (m.reasons.get(`${b.kind}: ${b.reason}`) ?? 0) + 1);
    meta.set(b.key, m);
  };
  // {keys, answersOnly, full, crash} for one template: the converter's default mode.
  const convertOne = (items, report, wf) => {
    let res;
    try {
      [res] = convertItems(items, { refs, now });
    } catch (e) {
      return { crash: String(e.message).slice(0, 120) };
    }
    if (res.refused) return { refused: true };
    const rep = res.report.workflows[0] ?? report;
    const bs = [...blockersOf(res.definition, rep, wf), ...runtimeBlockersOf(res.definition, rep, wf)];
    const feat = bs.filter((b) => !ANSWER_KINDS.has(b.kind));
    feat.forEach(note);
    const steps = Object.values(res.definition.steps).filter((s) => !s.settings?.disabled);
    return { keys: feat.map((b) => b.key), answers: bs.length - feat.length, full: !bs.length && !steps.some((s) => s.review) };
  };

  const pop = { listingEntries: entries.length, heldOutSkipped, read: 0, excluded: {}, outOfScope: 0, outOfScopeByClause: {}, inScope: 0, supportedToday: 0, fullClass: 0, answersOnly: 0, blocked: 0, crashes: 0 };
  const gallery = [];
  const seenHash = new Map();
  const bump = (o, k) => (o[k] = (o[k] ?? 0) + 1);
  for (const e of walk) {
    pop.read++;
    const paid = (e.price ?? 0) > 0 || e.purchaseUrl;
    const f = paid ? null : templateFile(e.id);
    let wf = null;
    if (f) {
      try {
        wf = JSON.parse(readFileSync(f, "utf8"))?.workflow?.workflow ?? null;
      } catch {}
    }
    const structural = structuralExclusion(e, wf);
    if (structural) {
      bump(pop.excluded, structural);
      continue;
    }
    const sha = createHash("sha256").update(canonical(wf)).digest("hex");
    if (seenHash.has(sha)) {
      bump(pop.excluded, "duplicate");
      continue;
    }
    seenHash.set(sha, e.id);
    const items = unwrap({ workflow: { id: String(e.id), name: e.name, workflow: wf } }, String(e.id));
    const report = analyze(items, opts).workflows[0];
    if (tutorialExclusion(e.name, wf, report)) {
      bump(pop.excluded, "tutorial");
      continue;
    }
    if (HAND[e.id]) {
      bump(pop.excluded, "hand");
      continue;
    }
    const v = checkEligibility({ wf, report, lists, nodes: refs.nodes.nodes, corpusEntry: r4HandOf.has(String(e.id)) ? { r4Hand: r4HandOf.get(String(e.id)) } : null });
    const blocking = v.reasons.filter((r) => r.clause !== "feature");
    if (blocking.length) {
      pop.outOfScope++;
      for (const c of new Set(blocking.map((r) => (r.id ? `${r.clause}/${r.id}` : r.clause)))) bump(pop.outOfScopeByClause, c);
      continue;
    }
    pop.inScope++;
    const c = convertOne(items, report, wf);
    if (c.crash || c.refused) {
      pop.crashes++;
      gallery.push({ id: e.id, keys: [`(converter ${c.crash ? "crash" : "refusal"})`], named: !unnamed.has(String(e.id)) });
      continue;
    }
    if (!c.keys.length) {
      if (c.answers) pop.answersOnly++;
      else pop.supportedToday++;
      if (c.full) pop.fullClass++;
    } else pop.blocked++;
    gallery.push({ id: e.id, keys: c.keys, named: !unnamed.has(String(e.id)) });
  }

  // 4. Round-4 dev, from the bench cache (every dev template, in the walk or not).
  const dev = [];
  const devPop = { templates: r4.dev.length, unnamed: 0, supportedToday: 0, answersOnly: 0, blocked: 0, missing: 0 };
  for (const t of r4.dev) {
    if (hidden.has(String(t.id))) throw new Error(`round ${ROUND} dev id ${t.id} is also held out`);
    const f = templateFile(t.id);
    if (!f) {
      devPop.missing++;
      continue;
    }
    const raw = JSON.parse(readFileSync(f, "utf8"));
    const items = unwrap(raw, String(t.id));
    const report = analyze(items, opts).workflows[0];
    const c = convertOne(items, report, raw.workflow?.workflow ?? raw);
    const named = !unnamed.has(String(t.id));
    if (!named) devPop.unnamed++;
    const keys = c.keys ?? [`(converter ${c.crash ? "crash" : "refusal"})`];
    if (!keys.length) c.answers ? devPop.answersOnly++ : devPop.supportedToday++;
    else devPop.blocked++;
    dev.push({ id: t.id, keys, named });
  }

  const ranked = rankLevers(gallery, dev, meta, lists.features);
  const groups = byPlanned(gallery, dev, ranked);
  const types = byType(gallery, dev, ranked).map((g) => ({ ...g, planned: plannedTypeOf(lists.features, g.group) }));
  const prev = existsSync(join(HERE, "levers.json")) ? JSON.parse(readFileSync(join(HERE, "levers.json"), "utf8")) : null;
  const doc = {
    $doc: "Missing converter features ranked over n8n's template gallery (evals/bench/levers.mjs; LEVERS.md explains every field). Ids only, no template content.",
    generated: new Date().toLocaleDateString("sv"),
    source: `${API}/search?rows=${ROWS}&page=<n>&sort=views:desc (pages 1-${pageFiles.length}), then ${API}/workflows/<id>`,
    listingTotal,
    listingPages: pageFiles,
    analyzer: `analyze.mjs and convert.mjs of the checkout, default answers, --now ${NOW}, no model`,
    rules: "EXCLUSIONS.md exclusion rules (fetch.mjs, same order) and round-4 eligibility clauses 1-3, 5, 6 (eligible.mjs); clause 4 (planned features) is not applied",
    round: ROUND,
    requests: offline ? prev?.requests ?? null : requests,
    population: pop,
    dev: devPop,
    byPlanned: groups,
    byType: types,
    features: ranked,
  };
  await writeFile(join(HERE, "levers.json"), JSON.stringify(doc, null, 1).replace(/\[\n\s+([\d,\s]+?)\n\s+\]/g, (_, b) => `[${b.replace(/\s+/g, " ").trim()}]`) + "\n");
  await writeFile(join(HERE, "LEVERS.md"), markdown(doc));
  console.log(`listing ${pop.listingEntries} entries (${heldOutSkipped} held-out skipped); read ${pop.read}, excluded ${Object.values(pop.excluded).reduce((x, y) => x + y, 0)}, out of scope ${pop.outOfScope}, in scope ${pop.inScope} (supported today ${pop.supportedToday}, answers only ${pop.answersOnly}, blocked ${pop.blocked}); ${ranked.length} feature keys; requests ${JSON.stringify(doc.requests)}`);
}

// ---------- LEVERS.md ----------

const esc = (s) => String(s).replace(/\|/g, "\\|");
export function markdown(doc) {
  const p = doc.population;
  const d = doc.dev;
  const excluded = Object.values(p.excluded).reduce((x, y) => x + y, 0);
  const L = [];
  L.push("# Levers: missing converter features ranked over the gallery", "");
  L.push(`Generated by \`node evals/bench/levers.mjs\` on ${doc.generated} (\`--offline\` rebuilds from the git-ignored cache after a converter change). Source: n8n's public template listing by views, ${doc.listingPages.length} pages of ${ROWS} (listing total ${doc.listingTotal}); pages reused from earlier walks keep their fetch day (${[...new Set(doc.listingPages.map((x) => x.date))].join(", ")}), so an id seen twice across days counts once. ${doc.analyzer}. Rules: ${doc.rules}.`, "");
  L.push("## Population", "");
  L.push("| | Templates |", "| --- | --- |");
  L.push(`| Listing entries | ${p.listingEntries} |`);
  L.push(`| Current held-out templates excluded (never read) | ${p.heldOutSkipped} |`);
  L.push(`| Read | ${p.read} |`);
  L.push(`| Excluded by a rule | ${excluded} (${Object.entries(p.excluded).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}) |`);
  L.push(`| Out of scope (round-4 clauses 1-3, 5, 6) | ${p.outOfScope} |`);
  L.push(`| **In scope** if every planned feature were built | **${p.inScope}** |`);
  L.push(`| Fully supported today (no blocked step, no runtime refusal) | ${p.supportedToday} (of them ${p.fullClass} with no review flag either) |`);
  L.push(`| Blocked only by a question the person answers (\`input-incomplete\`, an offered substitution, a hosts question) | ${p.answersOnly} |`);
  L.push(`| Blocked by at least one missing feature | ${p.blocked}${p.crashes ? ` (${p.crashes} converter crash or refusal)` : ""} |`);
  L.push("");
  L.push(`Out of scope, by clause (a template counts once per clause it breaks): ${Object.entries(p.outOfScopeByClause).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, v]) => `${k} ${v}`).join(", ")}.`, "");
  L.push(`Round-${doc.round} dev: ${d.templates} templates; ${d.supportedToday} supported today, ${d.answersOnly} blocked only by a question, ${d.blocked} blocked by a missing feature${d.missing ? `, ${d.missing} not in the cache` : ""}. ${d.unnamed ? `${d.unnamed} of them are still held out in the current round (release point 3 unfinished): they are counted, never named; re-run with \`--offline\` once \`currentRound\` is 4.` : ""}`.trim(), "");
  if (doc.requests) L.push(`Requests made by the walk that filled the cache: ${doc.requests.listing} listing, ${doc.requests.template} template, ${doc.requests.failed} failed.`, "");
  L.push(`Every template this walk read (listing ranks 1-${doc.listingPages.length * ROWS}) has now been seen by a fixing-side tool, so it is no longer fresh: a later round's held-out walk should start after page ${doc.listingPages.length} of the day's listing, or skip every id in the listing pages this walk used, as round 4's walk skipped \`corpus.json\` and the survey folder.`, "");
  L.push("## Picking the next feature", "");
  L.push("The Phase 6 loop picks its next converter feature from this ranking: the top row by **alone** (templates it is the only missing feature of), then **total**, preferring a row with a dev unlock, so the change can be measured on dev. A planned feature (column *planned*) can be built in the loop; an `unplanned` row is a candidate for the plan first. Re-run `node evals/bench/levers.mjs --offline` after each converter iteration and pick again.", "");
  L.push("## By planned feature", "");
  L.push("Templates every blocker of which falls under one planned feature (what building all of it would unlock), and templates it appears in.", "");
  L.push("| Planned feature | Step kinds | Gallery unlock | Gallery total | Dev unlock | Dev total |", "| --- | --- | --- | --- | --- | --- |");
  for (const g of doc.byPlanned) L.push(`| ${g.group} | ${g.keys} | ${g.galleryUnlock} | ${g.galleryTotal} | ${g.devUnlock} | ${g.devTotal} |`);
  L.push("");
  L.push("## By node type", "");
  L.push("The same, with every operation of one node type (and its Tool variant) together; the 25 types that unlock the most. *Planned* lists the features the type's operations map to in `features` (\"some operations\": the others are unplanned). All types are in `levers.json`.", "");
  L.push("| Node type | Planned | Step kinds | Gallery unlock | Gallery total | Dev unlock | Dev total |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const g of doc.byType.slice(0, 25)) L.push(`| \`${esc(g.group)}\` | ${g.planned} | ${g.keys} | ${g.galleryUnlock} | ${g.galleryTotal} | ${g.devUnlock} | ${g.devTotal} |`);
  L.push("");
  L.push("## Missing features", "");
  L.push("Gallery counts are over the in-scope templates; *alone* = the only missing feature of that template; dev counts are over round-" + doc.round + " dev (*unlock* = the only missing feature left). Sorted by alone, then total. Ids per row are in `levers.json`. Block kinds: the converter's (\`no-tool\`, \`unsupported\`, \`dropped\`), and since PROPOSALS P105 the runtime's on steps the converter does not block: \`runtime\` (preflight: a node version the runtime does not implement, a URL built at run time with no hosts question), \`arguments\` (a connector call missing required arguments), \`run-time\` (an option the runtime refuses when the step runs, read from its parameters). A refusal that depends on what a run receives is not visible without a run; LOOP.md names those.", "");
  L.push("| # | Node type + operation | Planned | Block kind | Alone | Total | Dev unlock | Dev total | Converter reason (most frequent) |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  doc.features.forEach((f, i) => L.push(`| ${i + 1} | \`${esc(f.key)}\` | ${f.planned} | ${f.kinds.join(", ")} | ${f.galleryAlone} | ${f.galleryTotal} | ${f.devUnlock} | ${f.devTotal} | ${esc(f.reason.replace(/^[\w-]+: /, ""))} |`));
  return L.join("\n") + "\n";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
