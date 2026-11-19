#!/usr/bin/env node
// Bench corpus (docs/DESIGN.md "Bench"): walks n8n's template listing by views, applies the
// exclusion rules (EXCLUSIONS.md), runs the analyzer with default answers on each
// template, and pins the corpus.
//
//   node evals/bench/fetch.mjs [--out evals/bench/corpus.json] [--max 200] [--offline]
//   node evals/bench/fetch.mjs --top-up [--round 3|4|5|6] [--max-entries 400] [--offline]   (fresh held-out, round 3 on)
//   node evals/bench/fetch.mjs --current   (today's analyzer verdicts beside the frozen draw-day ones, PROPOSALS P127)
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
import { analyze, unwrap } from "../../skills/n8n-migrate/scripts/analyze.mjs";
import { checkEligibility } from "./eligible.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const DATA = join(HERE, "data");
const SURVEY_CACHE = join(ROOT, "evals", "survey", "data", "wf");
const REFS = join(ROOT, "skills", "n8n-migrate", "references");
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
  574: "demo of n8n itself: the companion workflow of the Crypto node's docs, a manual trigger and one Crypto node hashing the fixed text 'n8n rocks!' (its description says so); found while labelling round 6's held-out, after the draw",
  695: "demo of n8n itself: a two-node example of reading the instance's GENERIC_TIMEZONE with moment.js inside a Function node, which works only once the instance allows the module (its description says so); found while labelling round 6's held-out, after the draw",
};
// Hand calls made on a walk entry after its draw: the entry keeps its pool (see topUp).
export const HAND_AFTER_DRAW = new Set([574, 695]);

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

// ---------- draw-day verdicts and today's analyzer (PROPOSALS P127) ----------
//
// A walk entry's `outcome`, `target`, `wakeup` (and everything the walk decided from them:
// `r4`, `r4Reasons`, `pool`, `excluded`, ...) are frozen on the day the entry was walked:
// eligibility and the draws read them, so a later analyzer change never moves a draw. Today's
// analyzer verdict is kept apart as `currentOutcome`, `currentTarget`, `currentWakeup`, written
// only where it differs from the frozen one (absent = the same); reports read it
// (currentVerdict()). A rebuild (an --offline main walk or --top-up) re-runs today's analyzer
// on its own entries: an entry the previous corpus.json already holds keeps every field it had,
// and only its current* fields are refreshed (keepDrawDay()). `--current` refreshes the current*
// fields of every analyzed entry without re-walking (refreshCurrent()), skipping the current
// round's held-out ids, and prints counts only.
export const CURRENT_FIELDS = ["currentOutcome", "currentTarget", "currentWakeup"];
export const currentVerdict = (e) => ({ outcome: e.currentOutcome ?? e.outcome, target: e.currentTarget ?? e.target, wakeup: e.currentWakeup ?? e.wakeup });
// Today's verdict on `e` (from an analyzer report), dropped again when it equals the frozen one.
export function setCurrent(e, report) {
  e.currentOutcome = report.outcome.kind;
  e.currentTarget = report.outcome.target;
  e.currentWakeup = report.wakeup.kind;
  return dropSameCurrent(e);
}
export function dropSameCurrent(e) {
  if (e.currentOutcome === e.outcome && e.currentTarget === e.target && e.currentWakeup === e.wakeup) for (const k of CURRENT_FIELDS) delete e[k];
  return e;
}
// A rebuilt entry `e` (today's walk) against the entry the previous corpus.json holds for the
// same id in the same walk (`prev`): `prev` wins on every field, today's analyzer only fills the
// current* fields (today's verdict, read from e's own outcome/target/wakeup or current*). No
// `prev`: a new entry, whose draw day is today. Mutates and returns `e`.
export function keepDrawDay(e, prev) {
  if (!prev) return dropSameCurrent(e);
  const today = { currentOutcome: e.currentOutcome ?? e.outcome, currentTarget: e.currentTarget ?? e.target, currentWakeup: e.currentWakeup ?? e.wakeup };
  const analyzed = e.outcome !== undefined || e.currentOutcome !== undefined;
  for (const k of Object.keys(e)) delete e[k];
  Object.assign(e, prev);
  if (analyzed) Object.assign(e, today);
  return dropSameCurrent(e);
}
// Today's verdict for every analyzed entry (one with a frozen `outcome`) whose id is not in
// `skip`: analyzeEntry(e) -> report | null (null: no template to read, the entry is left as it
// is). Mutates the entries; -> {analyzed, differ, skipped, missing}.
export function refreshCurrent(templates, analyzeEntry, skip = new Set()) {
  const n = { analyzed: 0, differ: 0, skipped: 0, missing: 0 };
  for (const e of templates) {
    if (e.outcome === undefined) continue;
    if (skip.has(e.id)) {
      n.skipped++;
      continue;
    }
    const report = analyzeEntry(e);
    if (!report) {
      n.missing++;
      continue;
    }
    n.analyzed++;
    setCurrent(e, report);
    if (e.currentOutcome !== undefined) n.differ++;
  }
  return n;
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

  // PROPOSALS P127: the Phase 5 walk's entries as the previous corpus.json holds them.
  const prevOf = existsSync(out) ? new Map(JSON.parse(readFileSync(out, "utf8")).templates.filter((e) => !e.topUp && !e.devRefill && !e.heldRefill).map((e) => [e.id, e])) : new Map();
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
      // PROPOSALS P127: classified with today's analyzer, then the previous corpus.json's entry
      // for the same id, if any, wins (only the current* fields are today's); quotas count the
      // pools as they stand after that, so a rebuild stops where the walk stopped.
      await (async () => {
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
          return;
        }
        if (seenHash.has(e.sha256)) {
          e.excluded = "duplicate";
          e.duplicateOf = seenHash.get(e.sha256);
          return;
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
          return;
        }
        if (HAND[w.id]) {
          e.excluded = "hand";
          e.reason = HAND[w.id];
          return;
        }
        if (DEMO_FLAG.test(w.name ?? "")) e.flag = "name-demo";
      })();
      const prev = prevOf.get(e.id);
      keepDrawDay(e, prev);
      if (prev) {
        if (e.pool === "eligible" && !e.filled) filled[stratum(e.wakeup)]++;
        else if (e.pool === "refusal") refusals++;
      } else if (!e.excluded && e.outcome !== undefined) {
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
      }
      if (process.stderr.isTTY) process.stderr.write(`\r${rank} entries, ${Object.values(filled).reduce((a, b) => a + b, 0)} eligible, ${refusals} refusals`);
    }
  }
  if (process.stderr.isTTY) process.stderr.write("\n");

  // Fill unfilled quota slots from the overflow, most-viewed first.
  const shortfall = {};
  for (const [k, n] of Object.entries(QUOTAS)) if (filled[k] < n) shortfall[k] = n - filled[k];
  let missing = Object.values(shortfall).reduce((a, b) => a + b, 0);
  // PROPOSALS P127: slots a kept entry already filled from the overflow on its draw day.
  for (const e of entries) if (missing && e.filled && e.pool === "eligible" && prevOf.has(e.id)) missing--;
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
  // PROPOSALS P127: later walks (top-ups, dev and held-out refills) and the current* note are kept.
  const kept = (prev?.templates ?? []).filter((e) => e.topUp || e.devRefill || e.heldRefill);
  const topUpSections = Object.fromEntries(Object.entries(prev ?? {}).filter(([k]) => /^(topUp\d*|devRefill\d+|heldRefill\d+|current)$/.test(k)));
  const doc = {
    source: `${API}/search?rows=${ROWS}&page=<n>&sort=views:desc, then ${API}/workflows/<id>`,
    fetched: new Date().toLocaleDateString("sv"),
    listingTotal: total,
    hash: "sha256 of .workflow.workflow serialised with sorted keys (evals/fetch-survey.mjs canonical())",
    analyzer: `skills/n8n-migrate/scripts/analyze.mjs, default answers, one template per run, --now ${NOW}`,
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

// ---------- top-ups: fresh held-out from round 3 on (docs/DESIGN.md "Bench", rolling held-out) ----------
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
//   5: as round 4, with amendment 1 part of the rule from the start (an entry failing only its
//      clauses is `fresh-other`, no `r4Amended`), and fresh after the gallery ranking (EXCLUSIONS.md
//      "Later rounds' held-out", "Round 5 held-out"): the walk starts on the page after the last one
//      levers.json `listingPages` records, skips every id on those pages (`inLevers`), and excludes a
//      template whose hash equals one of theirs as `duplicate`.
//   6: as round 5 (EXCLUSIONS.md "Round 6 held-out"); the walk starts after the last page any walk
//      read (round 5's held-out refill, startPageOf). Its candidates that round 6 does not draw are
//      the pool of the P137 experiment's held-out (experiments.mjs).
export const FRESH_QUOTAS = { chat: 6, manual: 5, schedule: 4, poll: 2, form: 2, other: 1 };
export const FRESH_ROUND = 3;
export const TOP_UPS = {
  3: { quotas: FRESH_QUOTAS, overflow: true, eligibility: false, finishPage: false, why: "fresh held-out for release point 3 (PLAN Phase 6): the seeded split's 40 held-out templates are all scored" },
  4: { quotas: FRESH_QUOTAS, overflow: false, eligibility: true, finishPage: true, why: "fresh held-out for release point 4 (PLAN Phase 6; EXCLUSIONS.md, Round 4 held-out): 20 templates nobody has read, each eligible by the round-4 rule" },
  5: { quotas: FRESH_QUOTAS, overflow: false, eligibility: true, amendedRule: true, afterLevers: true, finishPage: true, why: "fresh held-out for release point 5 (PLAN Phase 6; EXCLUSIONS.md, Round 5 held-out): 20 templates nobody has read, each eligible by the round-4 rule with amendment 1, none on the gallery ranking's listing pages" },
  6: { quotas: FRESH_QUOTAS, overflow: false, eligibility: true, amendedRule: true, afterLevers: true, finishPage: true, why: "fresh held-out for release point 6 (PLAN Phase 6; EXCLUSIONS.md, Round 6 held-out): 20 templates nobody has read, each eligible by the round-4 rule with amendment 1, none on the gallery ranking's listing pages or read by an earlier walk; the undrawn candidates are the P137 experiment's pool (EXCLUSIONS.md, P137 experiment held-out)" },
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
// A refill that continued this round's walk (or a later one's) does not move its start.
export function startPageOf(corpus, round) {
  const ranks = corpus.templates.filter((e) => (!e.topUp || e.topUp < round) && !(e.heldRefill >= round) && !(e.devRefill >= round)).map((e) => e.rank ?? 0);
  return Math.floor(Math.max(corpus.counts.listingEntries, ...ranks) / ROWS) + 1;
}

// The gallery ranking's listing pages (levers.json `listingPages`; EXCLUSIONS.md "Later rounds'
// held-out"): {lastPage, ids, hashes}. Every id on them has been read by a fixing-side tool, so a
// later round's walk starts after `lastPage` and skips `ids`; `hashes` (sha256 -> id, from the
// cached templates of those ids) catch a re-upload of one of them as a `duplicate`.
export function leversWalk(file = join(HERE, "levers.json")) {
  if (!existsSync(file)) throw new Error(`${file} missing: a round-5-on walk starts after the gallery ranking's pages`);
  const pages = JSON.parse(readFileSync(file, "utf8")).listingPages ?? [];
  if (!pages.length) throw new Error("levers.json records no listingPages");
  const ids = new Set();
  const hashes = new Map();
  for (const { file: f } of pages) {
    const listing = JSON.parse(readFileSync(join(ROOT, f), "utf8"));
    for (const w of listing.workflows ?? []) ids.add(w.id);
  }
  for (const id of ids) {
    const f = [join(DATA, "wf", `${id}.json`), join(SURVEY_CACHE, `${id}.json`)].find((x) => existsSync(x));
    if (!f) continue;
    try {
      const wf = JSON.parse(readFileSync(f, "utf8"))?.workflow?.workflow;
      if (wf) hashes.set(createHash("sha256").update(canonical(wf)).digest("hex"), id);
    } catch {}
  }
  return { lastPage: Math.max(...pages.map((p) => p.page)), ids, hashes };
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

// A walked entry's pool from its verdict under the rule the walk applied: `fresh` when eligible.
// Round 4's walk predates amendment 1, so an entry only the amendment fails stays `fresh` (and the
// draw skips it); from round 5 the amendment is part of the walk's rule.
export const walkPool = (v, cfg) => (v.r4 === "eligible" || (!cfg.amendedRule && v.r4Amended) ? "fresh" : "fresh-other");

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
  // PROPOSALS P127: the round's entries as the previous corpus.json holds them (their draw day).
  const prevOf = new Map(corpus.templates.filter((e) => e.topUp === round).map((e) => [e.id, e]));
  const known = new Set(others.map((e) => e.id));
  const seenHash = new Map(others.filter((e) => e.sha256).map((e) => [e.sha256, e.id]));
  const levers = cfg.afterLevers ? leversWalk() : null;
  if (levers) for (const [h, id] of levers.hashes) if (!seenHash.has(h)) seenHash.set(h, id);
  if (cfg.overflow) {
    const overflowInSurvey = corpus.templates.filter((e) => e.pool === "overflow" && existsSync(join(SURVEY_CACHE, `${e.id}.json`))).map((e) => e.id);
    if (overflowInSurvey.length) throw new Error(`overflow templates in the survey folder (P51): ${overflowInSurvey.join(", ")}`);
  }
  const startPage = Math.max(startPageOf(corpus, round), levers ? levers.lastPage + 1 : 0);
  const fetchedOn = new Date().toLocaleDateString("sv");
  // An --offline rebuild re-reads the round's cached pages and templates from scratch.
  const entries = [];
  const shortfall = () => freshShortfall([...others, ...entries], cfg.quotas, round);
  const skipped = { inCorpus: 0, inSurvey: 0, ...(levers ? { inLevers: 0 } : {}) };
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
      if (levers?.ids.has(w.id)) {
        skipped.inLevers++;
        continue;
      }
      if (entries.length >= maxEntries) {
        stopReason = `--max-entries ${maxEntries}`;
        break outer;
      }
      // The rank is the entry's place in the fetch day's listing (page and row), not a count.
      const e = { rank: (page - 1) * ROWS + i + 1, id: w.id, topUp: round };
      entries.push(e);
      // PROPOSALS P127: classified with today's analyzer, then the previous corpus.json's entry
      // for the same id in this walk, if any, wins (only the current* fields are today's).
      await (async () => {
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
          return;
        }
        if (seenHash.has(e.sha256)) {
          e.excluded = "duplicate";
          e.duplicateOf = seenHash.get(e.sha256);
          return;
        }
        seenHash.set(e.sha256, w.id);
        const report = analyze(unwrap({ workflow: { id: String(w.id), name: w.name, workflow: wf } }, String(w.id)), opts).workflows[0];
        e.outcome = report.outcome.kind;
        e.target = report.outcome.target;
        e.wakeup = report.wakeup.kind;
        if (report.setupOnly) e.setupOnly = true;
        if (tutorialExclusion(w.name, wf, report)) {
          e.excluded = "tutorial";
          return;
        }
        // A hand call on a walk entry is made after the draw (round 6 on: HAND_AFTER_DRAW); the
        // entry keeps the pool its verdict gives, so it stays in the seeded shuffle and only its
        // stratum moves (EXCLUSIONS.md "Round 3 top-up", 3078).
        if (HAND[w.id] && !HAND_AFTER_DRAW.has(w.id)) {
          e.excluded = "hand";
          e.reason = HAND[w.id];
          return;
        }
        if (DEMO_FLAG.test(w.name ?? "")) e.flag = "name-demo";
        if (elig) {
          if (handOf.has(w.id)) e.r4Hand = handOf.get(w.id);
          Object.assign(e, r4Verdict(wf, report, e, elig));
          if (cfg.amendedRule) delete e.r4Amended;
          // Pool `fresh`: eligible by the rule the walk applied. A later hand call (`r4Hand`) or
          // amendment moves a template out of the candidates, not out of the pool, so it keeps its
          // place in the seeded shuffle.
          const walked = e.r4Hand ? r4Verdict(wf, report, { ...e, r4Hand: undefined }, elig) : e;
          e.pool = walkPool(walked, cfg);
        } else e.pool = e.outcome === "subscription" ? "fresh" : "fresh-other";
      })();
      keepDrawDay(e, prevOf.get(e.id));
      if (HAND_AFTER_DRAW.has(w.id)) Object.assign(e, { excluded: "hand", reason: HAND[w.id] });
      if (process.stderr.isTTY) process.stderr.write(`\r${entries.length} new entries, shortfall ${JSON.stringify(shortfall())}   `);
    }
  }
  if (process.stderr.isTTY) process.stderr.write("\n");
  // Walk order: the order walks were made in. A rebuild keeps the round's entries where they were;
  // a first walk of the round goes after every earlier walk and refill (round 6 on; earlier rounds'
  // rebuilds keep their place too).
  const at = corpus.templates.findIndex((e) => e.topUp === round);
  const cut = at >= 0 ? corpus.templates.slice(0, at).filter((e) => e.topUp !== round).length : others.length;
  const all = [...others.slice(0, cut), ...entries, ...others.slice(cut)];
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
  const priorWalk = round === FRESH_ROUND ? `the Phase 5 walk's ${corpus.counts.listingEntries}` : levers ? `the gallery ranking's listing pages 1-${levers.lastPage}` : `the earlier walks' highest rank`;
  const section = {
    round,
    why: cfg.why,
    fetched: prevSection?.fetched ?? fetchedOn,
    source: `${API}/search?rows=${ROWS}&page=<n>&sort=views:desc from page ${startPage} (the listing on the fetch day; ranks continue after ${priorWalk}), then ${API}/workflows/<id>`,
    rules: `evals/bench/EXCLUSIONS.md (same rules and analyzer as the Phase 5 fetch); ids already in corpus.json and templates in evals/survey/data/wf${levers ? `, and every id on the gallery ranking's listing pages 1-${levers.lastPage} (levers.json listingPages)` : ""} are skipped, not entered`,
    eligibility: cfg.amendedRule
      ? "round-4 eligibility with amendment 1 (EXCLUSIONS.md, eligible.mjs checkEligibility(), eligibility.json, eligibility-params.json) on every entry no rule excludes, with the fetch day's analyzer and default answers; pool `fresh` = r4 eligible"
      : cfg.eligibility
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
  // Sections keep their order; a new walk's section comes after the last one (a rebuild keeps its place).
  const text = JSON.stringify({ ...rest, [key]: section, templates: all }, null, 2).replace(/\{\n\s+("rank": \d+,[^{}]*?)\n\s+\}/g, (_, body) => `{ ${body.replace(/\n\s+/g, " ")} }`);
  await writeFile(out, text + "\n");
  // Counts only: the labeller reads no verdict per template from this output.
  console.log(
    `top-up round ${round}: ${entries.length} new entries (${stats.listingRequests} listing + ${stats.templateRequests} template requests); fresh ${section.counts.fresh}, other ${section.counts.freshOther}, excluded ${JSON.stringify(excluded)}` +
      `${cfg.eligibility ? `, ineligible by clause ${JSON.stringify(ineligible)}` : ""}; skipped ${JSON.stringify(skipped)}; candidates by stratum ${JSON.stringify(section.counts.candidates)}; shortfall ${JSON.stringify(section.counts.shortfall)}; stop: ${stopReason}`,
  );
}

// ---------- dev refill past the round's walk (EXCLUSIONS.md "Round 4 eligibility, amendment 1") ----------
//
// When a dev template leaves after an amendment and the round's walk has no candidate left in its
// stratum, the views walk continues after the round's last walked page with the same rules, skips
// (ids in corpus.json, the survey folder), analyzer and round eligibility, and finishes each
// listing page it opens; it stops once `need` ({stratum: n}) has eligible entries. Entries carry
// `devRefill: <round>` (not `topUp`, so neither the round's held-out pool nor a rebuild of its walk
// changes) and pool `dev-refill` when round-eligible, else `dev-refill-other`. A listing page is
// read from the round's cache, else from the levers ranking's cache of the same listing
// (levers.json listingPages), else fetched. Returns {entries, pages, requests}; the caller writes
// corpus.json. `as: "held"` (PROPOSALS P126) continues the same walk for a held-out redraw whose
// stratum has no candidate left: entries carry `heldRefill: <round>` and pool `held-refill` /
// `held-refill-other`, so the round's shuffled pool, and every draw already made from it, stay as
// they are. `accept` (the P137 experiment's held-out, experiments.mjs): `need` is {any: n}, and an
// eligible entry counts only when accept(entry) holds (the entry's template is cached by then).
export const REFILL = { dev: { key: "devRefill", pool: "dev-refill" }, held: { key: "heldRefill", pool: "held-refill" } };
export async function extendWalk(corpus, round, need, { offline = false, as = "dev", accept = null } = {}) {
  const tag = REFILL[as];
  const refs = (f) => JSON.parse(readFileSync(join(REFS, f), "utf8"));
  const opts = { nodes: refs("nodes.json"), capabilities: refs("capabilities.json"), hosts: refs("http-hosts.json"), now: Date.parse(NOW) };
  const elig = { lists: JSON.parse(readFileSync(join(HERE, "eligibility.json"), "utf8")), nodes: opts.nodes.nodes };
  const walked = corpus.templates.filter((e) => e.topUp === round || e.devRefill === round || e.heldRefill === round).map((e) => e.rank ?? 0);
  const known = new Set(corpus.templates.map((e) => e.id));
  const seenHash = new Map(corpus.templates.filter((e) => e.sha256).map((e) => [e.sha256, e.id]));
  const left = { ...need };
  const entries = [];
  const pages = [];
  const before = { ...stats };
  for (let page = Math.floor(Math.max(...walked) / ROWS) + 1; Object.values(left).some((n) => n > 0); page++) {
    const own = join(DATA, `listing-r${round}-p${page}.json`);
    const levers = join(DATA, `listing-levers-p${page}.json`);
    let file = existsSync(own) ? own : existsSync(levers) ? levers : null;
    if (!file) {
      if (offline) throw new Error(`offline and listing page ${page} not cached`);
      await writeFile(own, await politeGet(`${API}/search?rows=${ROWS}&page=${page}&sort=views:desc`));
      stats.listingRequests++;
      file = own;
    }
    const listing = JSON.parse(await readFile(file, "utf8"));
    if (!listing.workflows?.length) throw new Error(`listing exhausted at page ${page}`);
    pages.push({ page, file: file.replace(ROOT + "/", "") });
    for (const [i, w] of listing.workflows.entries()) {
      if (known.has(w.id) || entries.some((e) => e.id === w.id) || existsSync(join(SURVEY_CACHE, `${w.id}.json`))) continue;
      const e = { rank: (page - 1) * ROWS + i + 1, id: w.id, [tag.key]: round };
      entries.push(e);
      let wf = null;
      if (!((w.price ?? 0) > 0 || w.purchaseUrl)) {
        try {
          wf = JSON.parse(await template(w.id, offline))?.workflow?.workflow ?? null;
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
      Object.assign(e, r4Verdict(wf, report, e, elig));
      delete e.r4Amended;
      e.pool = e.r4 === "eligible" ? tag.pool : `${tag.pool}-other`;
      const slot = accept ? "any" : stratum(e.wakeup);
      if (e.r4 === "eligible" && left[slot] > 0 && (!accept || accept(e))) left[slot]--;
    }
  }
  return { entries, pages, requests: { listingRequests: stats.listingRequests - before.listingRequests, templateRequests: stats.templateRequests - before.templateRequests } };
}

// PROPOSALS P127: `--current [--out corpus.json]` refreshes today's analyzer verdict (current*)
// of every analyzed entry from the cached templates, offline, leaving every draw-day field as it
// is; the current round's held-out ids are skipped (never analyzed or written here).
async function current() {
  const a = process.argv.slice(2);
  const out = a.includes("--out") ? a[a.indexOf("--out") + 1] : join(HERE, "corpus.json");
  const corpus = JSON.parse(readFileSync(out, "utf8"));
  const refs = (f) => JSON.parse(readFileSync(join(REFS, f), "utf8"));
  const opts = { nodes: refs("nodes.json"), capabilities: refs("capabilities.json"), hosts: refs("http-hosts.json"), now: Date.parse(NOW) };
  const { readSplits, unreadableIds } = await import("./rounds.mjs");
  // Every held-out set the current round keeps unread (its own, a later round's, an experiment's).
  const skip = new Set(unreadableIds(readSplits()));
  const analyzeEntry = (e) => {
    const f = [join(DATA, "wf", `${e.id}.json`), join(SURVEY_CACHE, `${e.id}.json`)].find((x) => existsSync(x));
    if (!f) return null;
    const doc = JSON.parse(readFileSync(f, "utf8"))?.workflow;
    if (!doc?.workflow) return null;
    return analyze(unwrap({ workflow: { id: String(e.id), name: doc.name, workflow: doc.workflow } }, String(e.id)), opts).workflows[0];
  };
  const counts = refreshCurrent(corpus.templates, analyzeEntry, skip);
  const { templates, current: _prev, ...rest } = corpus;
  const doc = { ...rest, current: { analyzer: `skills/n8n-migrate/scripts/analyze.mjs of the checkout, default answers, one template per run, --now ${NOW}`, refreshed: new Date().toLocaleDateString("sv"), rule: "PROPOSALS P127: current* fields are today's analyzer verdict where it differs from the frozen draw-day outcome/target/wakeup; reports read them, eligibility and draws never do", counts }, templates };
  const text = JSON.stringify(doc, null, 2).replace(/\{\n\s+("rank": \d+,[^{}]*?)\n\s+\}/g, (_, body) => `{ ${body.replace(/\n\s+/g, " ")} }`);
  await writeFile(out, text + "\n");
  console.log(`current analyzer verdicts: ${counts.analyzed} analyzed, ${counts.differ} differ from their draw day, ${counts.skipped} skipped (current held-out), ${counts.missing} without a cached template`);
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("--current")) {
  current().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("--top-up")) {
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
