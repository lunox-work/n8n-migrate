#!/usr/bin/env node
// Bench corpus (PLAN Phase 5): walks n8n's template listing by views, applies the
// exclusion rules (EXCLUSIONS.md), runs the analyzer with default answers on each
// template, and pins the corpus.
//
//   node evals/bench/fetch.mjs [--out evals/bench/corpus.json] [--max 200] [--offline]
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

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const DATA = join(HERE, "data");
const SURVEY_CACHE = join(ROOT, "evals", "survey", "data", "wf");
const REFS = join(ROOT, "skills", "n8n-to-claude", "references");
const API = "https://api.n8n.io/api/templates";
const DELAY_MS = 350;
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
    templates: entries,
  };
  const text = JSON.stringify(doc, null, 2).replace(/\{\n\s+("rank": \d+,[^{}]*?)\n\s+\}/g, (_, body) => `{ ${body.replace(/\n\s+/g, " ")} }`);
  await writeFile(out, text + "\n");
  console.log(
    `${entries.length} listing entries (${stats.listingRequests} listing + ${stats.templateRequests} template requests, ${stats.cacheHits} from the survey cache); ` +
      `eligible ${eligible.length}, refusal pool ${doc.counts.refusalPool}, overflow ${doc.counts.overflow}; strata ${JSON.stringify(strata)}; shortfall ${JSON.stringify(shortfall)}; ` +
      `top 100: ${sub(top)}/${top.length} subscription raw, ${sub(topIncluded)}/${topIncluded.length} after exclusions; stop: ${doc.stopReason}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
