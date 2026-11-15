#!/usr/bin/env node
// Bench corpus (PLAN Phase 5): walks n8n's template listing by views, applies the
// exclusion rules (EXCLUSIONS.md), runs the analyzer with default answers on each
// template, and pins the corpus.
//
//   node evals/bench/fetch.mjs [--out evals/bench/corpus.json] [--max 200] [--offline]
//   node evals/bench/fetch.mjs --top-up [--round 3|4] [--max-entries 400] [--offline]   (fresh held-out, round 3 on)
//
// Stops when every wake-up quota of the 100 eligible (outcome `subscription`) is full and
// at least REFUSALS non-subscription templates are in the pool, or at --max listing
// entries. At --max, unfilled quota slots are filled with the most-viewed eligible
// templates over quota, and the shortfall is written to corpus.json.
//
// Raw downloads go to evals/bench/data/ (git-ignored). A template already downloaded
// today by evals/fetch-survey.mjs (evals/survey/data/wf/) is read from there, not
// fetched again. Only ids, hashes and analyzer verdicts are committed. Downloaded JSON is
// untrusted data: parsed, hashed and analyzed, never run. Requests are sequential,
// DELAY_MS apart, with a generic user agent and nothing personal in them.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, get } from "../fetch-survey.mjs";
import { analyze, unwrap } from "../../skills/n8n-to-claude/scripts/analyze.mjs";
import { checkEligibility } from "./eligible.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const DATA = join(HERE, "data");
const SURVEY_CACHE = join(ROOT, "evals", "survey", "data", "wf");
const REFS = join(ROOT, "skills", "n8n-to-claude", "references");
const API = "https://api.n8n.io/api/templates";
const DELAY_MS = 1000; // at least 1 s between requests (350 ms for the Phase 5 and round-3 walks)
const ROWS = 50;
const NOW = "2026-11-16T00:00:00Z"; // same cron-simulation start as evals/survey/RECONCILE.md

// Wake-up quotas of the 100 eligible, fixed before the first run. Unattended wake-ups
// (schedule, poll) and forms are raised above their share of the top 100, because the
// unattended path is what the bench grades; chat and manual are held down.
export const QUOTAS = { chat: 25, manual: 25, schedule: 20, form: 12, poll: 10, other: 8 };
export const REFUSALS = 20;
export const stratum = (wakeup) => (wakeup in QUOTAS ? wakeup : "other");

// ---------- exclusion rules (EXCLUSIONS.md) ----------

const STICKY = "n8n-nodes-base.stickyNote";
const TRAINING = new Set(["n8n-nodes-base.n8nTrainingCustomerDatastore", "n8n-nodes-base.n8nTrainingCustomerMessenger"]);
const TUTORIAL_WORDS = /\b(tutorial|course|lesson|beginners?|getting started|101|walkthrough|cheat ?sheet|playground)\b/i;
const N8N_WORD = /\bn8n\b/i;
const N8N_TEACH = /\b(learn|learning|guide|demo|example|examples|basics|intro|introduction|explained|features|how to)\b/i;
const DEMO_FLAG = /\b(demo|example)\b/i;

export function tutorialName(name = "") {
  return TUTORIAL_WORDS.test(name) || (N8N_WORD.test(name) && N8N_TEACH.test(name));
}

// Structural rules that need no analyzer: returns a rule name or null.
export function structuralExclusion(entry, wf) {
  if ((entry.price ?? 0) > 0 || entry.purchaseUrl) return "paid";
  if (!wf || !Array.isArray(wf.nodes) || !wf.connections || typeof wf.connections !== "object") return "unavailable";
  const live = wf.nodes.filter((n) => n && n.type !== STICKY && !n.disabled);
  if (!live.length) return "notes-only";
  const names = new Set(live.map((n) => n.name));
  let edge = false;
  for (const [from, byType] of Object.entries(wf.connections)) {
    if (!names.has(from)) continue;
    for (const outs of byType?.main ?? []) for (const c of outs ?? []) if (c && names.has(c.node)) edge = true;
  }
  if (live.length >= 2 && !edge) return "no-edges";
  return null;
}

export function tutorialExclusion(name, wf, report) {
  if (report.blockers.some((b) => b.kind === "not-an-automation")) return true;
  if (wf.nodes.some((n) => !n.disabled && TRAINING.has(n.type))) return true;
  return tutorialName(name);
}

// Hand exclusions (EXCLUSIONS.md rule `hand`): id -> one-line reason, decided from the
// template alone. Empty until a reader adds one.
export const HAND = {
  2358: "meetup demo of n8n's AI nodes: three unrelated example flows on one canvas (its description says so)",
  3078: "demo of n8n techniques: five unrelated ways to send images and PDFs to Gemini on one canvas, answering a support-forum question (its description says so); found while labelling round 3's held-out, after the draw",
};

// ---------- fetch ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequest = 0;
async function politeGet(url) {
  const wait = lastRequest + DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);
  try {
    return await get(url);
  } finally {
    lastRequest = Date.now();
  }
}

const stats = { listingRequests: 0, templateRequests: 0, cacheHits: 0 };

async function listingPage(page, offline) {
  const file = join(DATA, `listing-p${page}.json`);
  if (offline || existsSync(file)) return JSON.parse(await readFile(file, "utf8"));
  const text = await politeGet(`${API}/search?rows=${ROWS}&page=${page}&sort=views:desc`);
  stats.listingRequests++;
  await writeFile(file, text);
  return JSON.parse(text);
}

async function template(id, offline) {
  const file = join(DATA, "wf", `${id}.json`);
  if (existsSync(file)) return readFile(file, "utf8");
  const cached = join(SURVEY_CACHE, `${id}.json`);
  if (existsSync(cached)) {
    stats.cacheHits++;
    const text = await readFile(cached, "utf8");
    await writeFile(file, text);
    return text;
  }
  if (offline) throw new Error(`offline and ${id} not downloaded`);
  const text = await politeGet(`${API}/workflows/${id}`);
  stats.templateRequests++;
  await writeFile(file, text);
  return text;
}

function main_args() {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  return { out: opt("--out", join(HERE, "corpus.json")), max: Number(opt("--max", "200")), offline: a.includes("--offline") };
}

async function main() {
  const { out, max, offline } = main_args();
  await mkdir(join(DATA, "wf"), { recursive: true });
  const refs = (f) => JSON.parse(readFileSync(join(REFS, f), "utf8"));
  const opts = { nodes: refs("nodes.json"), capabilities: refs("capabilities.json"), hosts: refs("http-hosts.json"), now: Date.parse(NOW) };

  const filled = Object.fromEntries(Object.keys(QUOTAS).map((k) => [k, 0]));
  const full = () => Object.entries(QUOTAS).every(([k, n]) => filled[k] >= n);
  const entries = [];
  const seenHash = new Map();
  let refusals = 0;
  let total = null;
  let rank = 0;
  let stopReason = null;

  outer: for (let page = 1; ; page++) {
    if (rank >= max) {
      stopReason = `--max ${max} listing entries`;
      break;
    }
    const listing = await listingPage(page, offline);
    total ??= listing.totalWorkflows;
    if (!listing.workflows?.length) {
      stopReason = "listing exhausted";
      break;
    }
    for (const w of listing.workflows) {
      if (full() && refusals >= REFUSALS) {
        stopReason = "quotas full and refusal pool reached";
        break outer;
      }
      if (rank >= max) {
        stopReason = `--max ${max} listing entries`;
        break outer;
      }
      rank++;
      const e = { rank, id: w.id };
      entries.push(e);
      let wf = null;
      // Paid templates are excluded, but within the top 100 they are still analyzed so
      // that the raw coverage figure counts every one of the 100.
      if (!((w.price ?? 0) > 0 || w.purchaseUrl) || rank <= 100) {
        try {
          wf = JSON.parse(await template(w.id, offline))?.workflow?.workflow ?? null;
        } catch (err) {
          e.error = String(err.message).slice(0, 200);
        }
      }
      if (wf) e.sha256 = createHash("sha256").update(canonical(wf)).digest("hex");
      const structural = structuralExclusion(w, wf);
      if (structural === "paid" && wf) {
        const report = analyze(unwrap({ workflow: { id: String(w.id), name: w.name, workflow: wf } }, String(w.id)), opts).workflows[0];
        Object.assign(e, { outcome: report.outcome.kind, target: report.outcome.target, wakeup: report.wakeup.kind });
      }
      if (structural) {
        e.excluded = structural;
        continue;
      }
      if (seenHash.has(e.sha256)) {
        e.excluded = "duplicate";
        e.duplicateOf = seenHash.get(e.sha256);
        continue;
      }
      seenHash.set(e.sha256, w.id);
      const items = unwrap({ workflow: { id: String(w.id), name: w.name, workflow: wf } }, String(w.id));
      const report = analyze(items, opts).workflows[0];
      e.outcome = report.outcome.kind;
      e.target = report.outcome.target;
      e.wakeup = report.wakeup.kind;
      if (report.setupOnly) e.setupOnly = true;
      if (tutorialExclusion(w.name, wf, report)) {
        e.excluded = "tutorial";
        continue;
      }
      if (HAND[w.id]) {
        e.excluded = "hand";
        e.reason = HAND[w.id];
        continue;
      }
      if (DEMO_FLAG.test(w.name ?? "")) e.flag = "name-demo";
      if (e.outcome === "subscription") {
        const s = stratum(e.wakeup);
        if (filled[s] < QUOTAS[s]) {
          filled[s]++;
          e.pool = "eligible";
        } else e.pool = "overflow";
      } else {
        e.pool = "refusal";
        refusals++;
      }
      if (process.stderr.isTTY) process.stderr.write(`\r${rank} entries, ${Object.values(filled).reduce((a, b) => a + b, 0)} eligible, ${refusals} refusals`);
    }
  }
  if (process.stderr.isTTY) process.stderr.write("\n");

  // Fill unfilled quota slots from the overflow, most-viewed first.
  const shortfall = {};
  for (const [k, n] of Object.entries(QUOTAS)) if (filled[k] < n) shortfall[k] = n - filled[k];
  let missing = Object.values(shortfall).reduce((a, b) => a + b, 0);
  for (const e of entries) {
    if (!missing) break;
    if (e.pool === "overflow") {
      e.pool = "eligible";
      e.filled = true;
      missing--;
    }
  }

  const eligible = entries.filter((e) => e.pool === "eligible");
  const strata = {};
  for (const e of eligible) strata[stratum(e.wakeup)] = (strata[stratum(e.wakeup)] ?? 0) + 1;
  const top = entries.filter((e) => e.rank <= 100);
  const sub = (xs) => xs.filter((e) => e.outcome === "subscription").length;
  const topIncluded = top.filter((e) => !e.excluded);
  const excludedCounts = {};
  for (const e of entries) if (e.excluded) excludedCounts[e.excluded] = (excludedCounts[e.excluded] ?? 0) + 1;

  // An --offline rebuild keeps the request counts of the run that downloaded the data.
  let requests = stats;
  if (offline && existsSync(out)) requests = JSON.parse(readFileSync(out, "utf8")).counts?.requests ?? stats;
  // The round-3 top-up (topUp() below) is its own fetch on a later day: a rebuild of the
  // Phase 5 corpus keeps its section and entries as they are.
  const prev = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
  const kept = (prev?.templates ?? []).filter((e) => e.topUp);
  const topUpSections = Object.fromEntries(Object.entries(prev ?? {}).filter(([k]) => k === "topUp" || /^topUp\d+$/.test(k)));
  const doc = {
    source: `${API}/search?rows=${ROWS}&page=<n>&sort=views:desc, then ${API}/workflows/<id>`,
    fetched: new Date().toLocaleDateString("sv"),
    listingTotal: total,
    hash: "sha256 of .workflow.workflow serialised with sorted keys (evals/fetch-survey.mjs canonical())",
    analyzer: `skills/n8n-to-claude/scripts/analyze.mjs, default answers, one template per run, --now ${NOW}`,
    rules: "evals/bench/EXCLUSIONS.md",
    quotas: QUOTAS,
    refusalsWanted: REFUSALS,
    stopReason: missing === 0 && Object.keys(shortfall).length ? `${stopReason}; quota shortfall filled from overflow` : stopReason,
    counts: {
      listingEntries: entries.length,
      requests,
      excluded: excludedCounts,
      eligible: eligible.length,
      overflow: entries.filter((e) => e.pool === "overflow").length,
      refusalPool: entries.filter((e) => e.pool === "refusal").length,
      strata,
      shortfall,
    },
    coverageTop100: {
      raw: { subscription: sub(top), of: top.length },
      afterExclusions: { subscription: sub(topIncluded), of: topIncluded.length },
      excludedInTop100: top.filter((e) => e.excluded).map((e) => ({ id: e.id, rule: e.excluded })),
    },
    ...topUpSections,
    templates: [...entries, ...kept],
  };
  const text = JSON.stringify(doc, null, 2).replace(/\{\n\s+("rank": \d+,[^{}]*?)\n\s+\}/g, (_, body) => `{ ${body.replace(/\n\s+/g, " ")} }`);
  await writeFile(out, text + "\n");
  console.log(
    `${entries.length} listing entries (${stats.listingRequests} listing + ${stats.templateRequests} template requests, ${stats.cacheHits} from the survey cache); ` +
      `eligible ${eligible.length}, refusal pool ${doc.counts.refusalPool}, overflow ${doc.counts.overflow}; strata ${JSON.stringify(strata)}; shortfall ${JSON.stringify(shortfall)}; ` +
      `top 100: ${sub(top)}/${top.length} subscription raw, ${sub(topIncluded)}/${topIncluded.length} after exclusions; stop: ${doc.stopReason}`,
  );
}

// ---------- top-ups: fresh held-out from round 3 on (PLAN Phase 6, rolling held-out) ----------
//
// The seeded split's held-out is used up after release point 2, so each later release point draws
// fresh held-out templates from outside it: a top-up walk of today's listing (same sort) from the
// page holding the highest rank an earlier walk read. It skips ids already in corpus.json (any
// pool) and templates in the survey folder (evals/survey/data/wf: a fixing session may have read
// it, PROPOSALS P51), applies the same exclusion rules and analyzer as main(), and stops when every
// stratum has at least its quota of candidates. FRESH_QUOTAS are the seeded held-out's strata
// halved (40 -> 20: chat 12, manual 10, schedule 8, poll 4, form 4, other 2). New entries carry
// `topUp: <round>`; the draw itself is split.mjs drawFresh(). Only ids, hashes and verdicts are
// written. Per round (TOP_UPS):
//   3: the pool also holds the Phase 5 `overflow` entries; a candidate is outcome `subscription`
//      (pool `fresh`, else `fresh-other`); the walk stops at the entry that fills the last quota.
//   4: the pool is the round's own entries only; every entry no rule excludes gets the round-4
//      eligibility verdict (eligible.mjs checkEligibility(), `r4` and `r4Reasons`), a candidate is
//      `r4: "eligible"` (pool `fresh`), and the walk finishes the listing page on which the last
//      quota fills, so the common strata hold more candidates than slots (EXCLUSIONS.md).
export const FRESH_QUOTAS = { chat: 6, manual: 5, schedule: 4, poll: 2, form: 2, other: 1 };
export const FRESH_ROUND = 3;
export const TOP_UPS = {
  3: { quotas: FRESH_QUOTAS, overflow: true, eligibility: false, finishPage: false, why: "fresh held-out for release point 3 (PLAN Phase 6): the seeded split's 40 held-out templates are all scored" },
  4: { quotas: FRESH_QUOTAS, overflow: false, eligibility: true, finishPage: true, why: "fresh held-out for release point 4 (PLAN Phase 6; EXCLUSIONS.md, Round 4 held-out): 20 templates nobody has read, each eligible by the round-4 rule" },
};
export const topUpKey = (round) => (round === FRESH_ROUND ? "topUp" : `topUp${round}`);

// A round's fresh pool. Round 3: Phase 5 overflow and round-3 top-up `fresh` entries; later
// rounds: that round's top-up `fresh` entries. An entry excluded by a rule after the draw
// (`hand` while labelling) keeps its pool and gets `excluded`: it stays in the pool's shuffle, so
// the draw of every other template is unchanged, and is skipped when drawn.
export function freshPool(templates, round = FRESH_ROUND) {
  const cfg = TOP_UPS[round];
  if (!cfg) throw new Error(`no top-up for round ${round}`);
  return templates.filter((e) => (cfg.overflow && e.pool === "overflow") || (e.pool === "fresh" && (e.topUp ?? FRESH_ROUND) === round));
}
// A candidate: not excluded after the draw, no hand call, and not made ineligible by a later
// amendment of the round's rule (`r4: ineligible` with `r4Amended`; it keeps its pool and its place
// in the shuffle, eligible.mjs --reapply-walk).
export const isCandidate = (e) => !e.excluded && !e.r4Hand && e.r4 !== "ineligible";
export function freshCandidates(templates, round = FRESH_ROUND) {
  return freshPool(templates, round).filter(isCandidate);
}

export function freshShortfall(templates, quotas = FRESH_QUOTAS, round = FRESH_ROUND) {
  const have = {};
  for (const e of freshCandidates(templates, round)) have[stratum(e.wakeup)] = (have[stratum(e.wakeup)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(quotas).filter(([k, n]) => (have[k] ?? 0) < n).map(([k, n]) => [k, n - (have[k] ?? 0)]));
}

// The listing page a round's walk starts on: the page holding the highest rank read by the Phase 5
// walk or an earlier round's top-up (its already-read entries are skipped as `inCorpus`).
export function startPageOf(corpus, round) {
  const ranks = corpus.templates.filter((e) => !e.topUp || e.topUp < round).map((e) => e.rank ?? 0);
  return Math.floor(Math.max(corpus.counts.listingEntries, ...ranks) / ROWS) + 1;
}

// Round-4 eligibility of a new entry: {r4, r4Reasons?}, from the template file and the analyzer
// report already made (EXCLUSIONS.md "Round 4 eligibility").
// `r4Amended`: ineligible only through an amendment made after the walk (EXCLUSIONS.md "Round 4
// eligibility, amendment 1"); such an entry stays in pool `fresh`, so the draw's shuffle is the
// walk's, and the draw skips it.
export function r4Verdict(wf, report, entry, { lists, nodes, params }) {
  const v = checkEligibility({ wf, report, lists, nodes, corpusEntry: entry, params });
  if (v.eligible) return { r4: "eligible" };
  const reasons = [...new Set(v.reasons.map((x) => `${x.clause}${x.id ? `/${x.id}` : ""}: ${x.detail}`.slice(0, 160)))];
  return { r4: "ineligible", r4Reasons: reasons, ...(v.baseEligible ? { r4Amended: Math.max(...v.reasons.map((x) => x.amendment ?? 0)) } : {}) };
}

async function topUp() {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  const out = opt("--out", join(HERE, "corpus.json"));
  const round = Number(opt("--round", String(FRESH_ROUND)));
  const cfg = TOP_UPS[round];
  if (!cfg) throw new Error(`--round ${round}: no top-up defined (TOP_UPS)`);
  const maxEntries = Number(opt("--max-entries", "400"));
  const offline = a.includes("--offline");
  await mkdir(join(DATA, "wf"), { recursive: true });
  const corpus = JSON.parse(readFileSync(out, "utf8"));
  const refs = (f) => JSON.parse(readFileSync(join(REFS, f), "utf8"));
  const opts = { nodes: refs("nodes.json"), capabilities: refs("capabilities.json"), hosts: refs("http-hosts.json"), now: Date.parse(NOW) };
  const elig = cfg.eligibility ? { lists: JSON.parse(readFileSync(join(HERE, "eligibility.json"), "utf8")), nodes: opts.nodes.nodes } : null;
  const others = corpus.templates.filter((e) => e.topUp !== round);
  // A hand call made after the walk (`r4Hand`, read from the template alone) survives a rebuild.
  const handOf = new Map(corpus.templates.filter((e) => e.topUp === round && e.r4Hand).map((e) => [e.id, e.r4Hand]));
  const known = new Set(others.map((e) => e.id));
  const seenHash = new Map(others.filter((e) => e.sha256).map((e) => [e.sha256, e.id]));
  if (cfg.overflow) {
    const overflowInSurvey = corpus.templates.filter((e) => e.pool === "overflow" && existsSync(join(SURVEY_CACHE, `${e.id}.json`))).map((e) => e.id);
    if (overflowInSurvey.length) throw new Error(`overflow templates in the survey folder (P51): ${overflowInSurvey.join(", ")}`);
  }
  const startPage = startPageOf(corpus, round);
  const fetchedOn = new Date().toLocaleDateString("sv");
  // An --offline rebuild re-reads the round's cached pages and templates from scratch.
  const entries = [];
  const shortfall = () => freshShortfall([...others, ...entries], cfg.quotas, round);
  const skipped = { inCorpus: 0, inSurvey: 0 };
  let stopReason = null;
  outer: for (let page = startPage; ; page++) {
    if (!Object.keys(shortfall()).length) {
      stopReason = cfg.finishPage ? "every stratum has its quota of candidates; the listing page it filled on was finished" : "every stratum has its quota of candidates";
      break;
    }
    const file = join(DATA, `listing-r${round}-p${page}.json`);
    let listing;
    if (offline || existsSync(file)) listing = JSON.parse(await readFile(file, "utf8"));
    else {
      const text = await politeGet(`${API}/search?rows=${ROWS}&page=${page}&sort=views:desc`);
      stats.listingRequests++;
      await writeFile(file, text);
      listing = JSON.parse(text);
    }
    if (!listing.workflows?.length) {
      stopReason = "listing exhausted";
      break;
    }
    for (const [i, w] of listing.workflows.entries()) {
      if (!cfg.finishPage && !Object.keys(shortfall()).length) {
        stopReason = "every stratum has its quota of candidates";
        break outer;
      }
      if (known.has(w.id) || entries.some((e) => e.id === w.id)) {
        skipped.inCorpus++;
        continue;
      }
      if (existsSync(join(SURVEY_CACHE, `${w.id}.json`))) {
        skipped.inSurvey++;
        continue;
      }
      if (entries.length >= maxEntries) {
        stopReason = `--max-entries ${maxEntries}`;
        break outer;
      }
      // The rank is the entry's place in the fetch day's listing (page and row), not a count.
      const e = { rank: (page - 1) * ROWS + i + 1, id: w.id, topUp: round };
      entries.push(e);
      let wf = null;
      if (!((w.price ?? 0) > 0 || w.purchaseUrl)) {
        try {
          const f = join(DATA, "wf", `${w.id}.json`);
          let text;
          if (existsSync(f)) text = await readFile(f, "utf8");
          else if (offline) throw new Error(`offline and ${w.id} not downloaded`);
          else {
            text = await politeGet(`${API}/workflows/${w.id}`);
            stats.templateRequests++;
            await writeFile(f, text);
          }
          wf = JSON.parse(text)?.workflow?.workflow ?? null;
        } catch (err) {
          e.error = String(err.message).slice(0, 200);
        }
      }
      if (wf) e.sha256 = createHash("sha256").update(canonical(wf)).digest("hex");
      const structural = structuralExclusion(w, wf);
      if (structural) {
        e.excluded = structural;
        continue;
      }
      if (seenHash.has(e.sha256)) {
        e.excluded = "duplicate";
        e.duplicateOf = seenHash.get(e.sha256);
        continue;
      }
      seenHash.set(e.sha256, w.id);
      const report = analyze(unwrap({ workflow: { id: String(w.id), name: w.name, workflow: wf } }, String(w.id)), opts).workflows[0];
      e.outcome = report.outcome.kind;
      e.target = report.outcome.target;
      e.wakeup = report.wakeup.kind;
      if (report.setupOnly) e.setupOnly = true;
      if (tutorialExclusion(w.name, wf, report)) {
        e.excluded = "tutorial";
        continue;
      }
      if (HAND[w.id]) {
        e.excluded = "hand";
        e.reason = HAND[w.id];
        continue;
      }
      if (DEMO_FLAG.test(w.name ?? "")) e.flag = "name-demo";
      if (elig) {
        if (handOf.has(w.id)) e.r4Hand = handOf.get(w.id);
        Object.assign(e, r4Verdict(wf, report, e, elig));
        e.pool = e.r4 === "eligible" || e.r4Amended ? "fresh" : "fresh-other";
      } else e.pool = e.outcome === "subscription" ? "fresh" : "fresh-other";
      if (process.stderr.isTTY) process.stderr.write(`\r${entries.length} new entries, shortfall ${JSON.stringify(shortfall())}   `);
    }
  }
  if (process.stderr.isTTY) process.stderr.write("\n");
  // Walk order: Phase 5 entries, then each round's top-up in round order.
  const all = [...others.filter((e) => !e.topUp || e.topUp < round), ...entries, ...others.filter((e) => e.topUp > round)];
  const excluded = {};
  for (const e of entries) if (e.excluded) excluded[e.excluded] = (excluded[e.excluded] ?? 0) + 1;
  const strata = (xs) => {
    const o = {};
    for (const e of xs) o[stratum(e.wakeup)] = (o[stratum(e.wakeup)] ?? 0) + 1;
    return o;
  };
  const key = topUpKey(round);
  const prevSection = corpus[key];
  const prevRequests = prevSection?.counts?.requests;
  const ineligible = {};
  for (const e of entries) if (e.r4 === "ineligible") for (const c of new Set(e.r4Reasons.map((r) => r.split(":")[0]))) ineligible[c] = (ineligible[c] ?? 0) + 1;
  const priorWalk = round === FRESH_ROUND ? `the Phase 5 walk's ${corpus.counts.listingEntries}` : `the earlier walks' highest rank`;
  const section = {
    round,
    why: cfg.why,
    fetched: prevSection?.fetched ?? fetchedOn,
    source: `${API}/search?rows=${ROWS}&page=<n>&sort=views:desc from page ${startPage} (the listing on the fetch day; ranks continue after ${priorWalk}), then ${API}/workflows/<id>`,
    rules: "evals/bench/EXCLUSIONS.md (same rules and analyzer as the Phase 5 fetch); ids already in corpus.json and templates in evals/survey/data/wf are skipped, not entered",
    eligibility: cfg.eligibility
      ? "round-4 eligibility (EXCLUSIONS.md, eligible.mjs checkEligibility(), eligibility.json) on every entry no rule excludes, with the fetch day's analyzer and default answers; pool `fresh` = r4 eligible"
      : "overflow entries keep their Phase 5 verdict (analyzer of 2026-11-14); top-up entries are analyzed on the fetch day with the analyzer of that day's checkout",
    quotas: cfg.quotas,
    stopReason,
    counts: {
      newEntries: entries.length,
      requests: offline && prevRequests ? prevRequests : { listingRequests: stats.listingRequests, templateRequests: stats.templateRequests },
      skipped,
      excluded,
      ...(cfg.eligibility ? { ineligibleByClause: ineligible } : {}),
      fresh: entries.filter((e) => e.pool === "fresh").length,
      freshOther: entries.filter((e) => e.pool === "fresh-other").length,
      candidates: strata(freshCandidates(all, round)),
      shortfall: freshShortfall(all, cfg.quotas, round),
    },
  };
  const { templates: _old, ...rest } = corpus;
  const head = Object.fromEntries(Object.entries(rest).filter(([k]) => k !== "topUp" && !/^topUp\d+$/.test(k)));
  const sections = Object.fromEntries(Object.entries({ ...rest, [key]: section }).filter(([k]) => k === "topUp" || /^topUp\d+$/.test(k)).sort(([x], [y]) => x.length - y.length || x.localeCompare(y)));
  const text = JSON.stringify({ ...head, ...sections, templates: all }, null, 2).replace(/\{\n\s+("rank": \d+,[^{}]*?)\n\s+\}/g, (_, body) => `{ ${body.replace(/\n\s+/g, " ")} }`);
  await writeFile(out, text + "\n");
  // Counts only: the labeller reads no verdict per template from this output.
  console.log(
    `top-up round ${round}: ${entries.length} new entries (${stats.listingRequests} listing + ${stats.templateRequests} template requests); fresh ${section.counts.fresh}, other ${section.counts.freshOther}, excluded ${JSON.stringify(excluded)}` +
      `${cfg.eligibility ? `, ineligible by clause ${JSON.stringify(ineligible)}` : ""}; skipped ${JSON.stringify(skipped)}; candidates by stratum ${JSON.stringify(section.counts.candidates)}; shortfall ${JSON.stringify(section.counts.shortfall)}; stop: ${stopReason}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("--top-up")) {
  topUp().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
