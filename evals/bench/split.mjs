#!/usr/bin/env node
// Splits the 100 eligible templates of corpus.json into dev (60) and held-out (40),
// stratified by wake-up, with a seeded shuffle. Deterministic: same corpus, same seed,
// same file.
//
//   node evals/bench/split.mjs [--corpus evals/bench/corpus.json] [--out evals/bench/splits.json]
//   node evals/bench/split.mjs --fresh [--round 3|4] [--redraw "<why>"]   (a fresh held-out: drawFresh() below)
//
// Method: one Fisher-Yates shuffle of the eligible ids (sorted ascending first) with
// mulberry32(SEED). Each stratum gets round(60% of its size) dev slots, largest remainder
// first so the total is exactly 60; within a stratum the first templates in shuffled order
// take the dev slots. Both lists keep the shuffled order, which is "the seeded order" the
// bench walks (the first 10 of dev get fixtures first).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stratum, FRESH_QUOTAS, FRESH_ROUND, freshPool } from "./fetch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SEED = 20261114;
const DEV = 60;

export function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function split(eligible, seed = SEED, devTotal = DEV) {
  const rnd = mulberry32(seed);
  const order = [...eligible].sort((a, b) => a.id - b.id);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const sizes = {};
  for (const e of order) sizes[stratum(e.wakeup)] = (sizes[stratum(e.wakeup)] ?? 0) + 1;
  const share = devTotal / order.length;
  const slots = Object.fromEntries(Object.entries(sizes).map(([k, n]) => [k, Math.floor(n * share)]));
  let left = devTotal - Object.values(slots).reduce((a, b) => a + b, 0);
  const byRemainder = Object.entries(sizes).sort((a, b) => b[1] * share - Math.floor(b[1] * share) - (a[1] * share - Math.floor(a[1] * share)) || a[0].localeCompare(b[0]));
  for (const [k] of byRemainder) if (left > 0) (slots[k]++, left--);
  const used = {};
  const dev = [];
  const held = [];
  for (const e of order) {
    const s = stratum(e.wakeup);
    used[s] = (used[s] ?? 0) + 1;
    (used[s] <= slots[s] ? dev : held).push(e);
  }
  return { dev, held, sizes, slots };
}

// splits.json's layout: one line per template row and per round, id lists inline.
export function formatSplits(doc) {
  const line = (b) => b.replace(/\n\s+/g, " ").replace(/\[ /g, "[").replace(/ \]/g, "]");
  return (
    JSON.stringify(doc, null, 2)
      .replace(/\{\n\s+("id": \d+,[^{}]*?)\n\s+\}/g, (_, b) => `{ ${line(b)} }`)
      .replace(/\{\n\s+("round": \d+,\s+"promoted"[^{}]*?)\n\s+\}/g, (_, b) => `{ ${line(b)} }`) + "\n"
  );
}

// Fresh held-out from round 3 on (PLAN Phase 6): the pool is corpus.json's templates outside the
// seeded split that are eligible (fetch.mjs freshPool: round 3 = Phase 5 `overflow` and the
// round-3 top-up's `fresh`; round 4 = the round-4 top-up's `fresh`, round-4 eligible). Same method
// as split(): one Fisher-Yates shuffle with mulberry32(seed) over the pool sorted by id ascending;
// each stratum's first quota[stratum] templates in shuffled order are drawn, skipping one excluded
// after the draw (`excluded` or `r4Hand`), and the list keeps the shuffled order.
// Each seed was fixed (EXCLUSIONS.md) before its draw and before any candidate was opened.
export const FRESH_SEED = 20261115;
export const FRESH_SEEDS = { 3: FRESH_SEED, 4: 20261116 };
export const freshKey = (round) => (round === FRESH_ROUND ? "heldOutFresh" : `heldOutFresh${round}`);
export function drawFresh(candidates, quotas = FRESH_QUOTAS, seed = FRESH_SEED) {
  const rnd = mulberry32(seed);
  const order = [...candidates].sort((a, b) => a.id - b.id);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const used = {};
  const drawn = [];
  for (const e of order) {
    if (e.excluded || e.r4Hand) continue;
    const s = stratum(e.wakeup);
    if ((used[s] ?? 0) >= (quotas[s] ?? 0)) continue;
    used[s] = (used[s] ?? 0) + 1;
    drawn.push(e);
  }
  const short = Object.fromEntries(Object.entries(quotas).filter(([k, n]) => (used[k] ?? 0) < n).map(([k, n]) => [k, n - (used[k] ?? 0)]));
  return { drawn, strata: used, short };
}

const FRESH_TEXT = {
  3: {
    method: "evals/bench/split.mjs drawFresh(): pool = corpus.json templates outside the seeded split that are eligible (Phase 5 overflow, round-3 top-up `fresh`; fetch.mjs freshPool); mulberry32(seed) Fisher-Yates over the pool sorted by id ascending; per wake-up stratum the first quota in shuffled order, skipping a template excluded after the draw (it stays in the shuffle); the list keeps the shuffled order",
    rule: "the same rule as the seeded held-out: never read by a session that changes the skill, converter or runtime until release point 3 has scored it (EXCLUSIONS.md)",
    note: "held-out 21-40 join dev after release point 2, so dev is all 100 seeded templates (70 with fixtures). The seeded held-out list is used up: release point 3 scores 20 fresh held-out templates from outside the seeded split (splits.heldOutFresh: Phase 5 overflow plus a round-3 top-up of the listing, drawn by seed per wake-up stratum), labelled blind and fixtured by a separate blind session before any is run",
  },
  4: {
    method: "evals/bench/split.mjs drawFresh(): pool = the round-4 top-up's entries that are round-4 eligible (fetch.mjs freshPool(templates, 4); no overflow or round-3 candidate); mulberry32(seed) Fisher-Yates over the pool sorted by id ascending; per wake-up stratum the first quota in shuffled order, skipping a template excluded after the draw (`excluded` or `r4Hand`; it stays in the shuffle); the list keeps the shuffled order",
    rule: "the same rule as the seeded held-out: never read by a session that changes the skill, converter or runtime until release point 4 has scored it (EXCLUSIONS.md, Round 4 held-out)",
    note: "round 3's 20 fresh held-out join dev after release point 3, and the 20 of those 120 templates that fail round-4 eligibility leave (dropped; EXCLUSIONS.md Round 4 eligibility, AUDIT-R4.md), so dev is the 100 eligible. Release point 4 scores 20 fresh held-out templates (splits.heldOutFresh4: a round-4 top-up of the listing, each round-4 eligible, drawn by seed 20261116 per wake-up stratum), labelled blind before any is run",
  },
};

// Round n >= 4's entry in `rounds`, made once: the previous round's held-out join dev
// (`promoted`, scored at its release point) and the previous round's dev and held-out templates
// that fail round-n eligibility leave (`dropped`; eligible.mjs over the cached templates, as the
// audit ran it). Kept as written on later runs.
async function roundEntry(splits, round) {
  const { roundOf } = await import("./rounds.mjs");
  const prev = roundOf(splits, round - 1);
  const ids = [...prev.dev, ...prev.heldOut].map((r) => r.id);
  const { eligibilityOf } = await import("./eligible.mjs");
  const dropped = eligibilityOf(ids).filter((r) => !r.eligible).map((r) => r.id);
  return { round, promoted: prev.heldOut.map((r) => r.id), dropped, heldOut: [] };
}

// `redraw`: why a committed draw is drawn again (a candidate excluded by a rule after the draw,
// e.g. `hand` while labelling); the same seed and method, so only the excluded template's
// stratum moves to its next candidate in shuffled order. Kept in the fresh list's `redraws`.
async function writeFresh(corpusPath, out, redraw = null, round = FRESH_ROUND) {
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
  const splits = JSON.parse(readFileSync(out, "utf8"));
  const seed = FRESH_SEEDS[round];
  if (!seed || !FRESH_TEXT[round]) throw new Error(`no fresh held-out seed for round ${round}`);
  const key = freshKey(round);
  const taken = new Set([...splits.dev, ...splits.heldOut, ...Object.entries(splits).filter(([k]) => /^heldOutFresh\d*$/.test(k) && k !== key).flatMap(([, v]) => v.templates ?? [])].map((r) => r.id));
  const pool = freshPool(corpus.templates, round).filter((e) => !taken.has(e.id));
  const candidates = pool.filter((e) => !e.excluded && !e.r4Hand);
  const { drawn, strata, short } = drawFresh(pool, FRESH_QUOTAS, seed);
  if (Object.keys(short).length) throw new Error(`fresh draw short of ${JSON.stringify(short)}: top up with fetch.mjs --top-up --round ${round} first`);
  let r = splits.rounds.find((x) => x.round === round);
  if (!r && round > FRESH_ROUND) {
    r = await roundEntry(splits, round);
    splits.rounds.push(r);
  }
  if (!r) throw new Error(`splits.json has no round ${round}`);
  const changed = r.heldOut.length && JSON.stringify(r.heldOut) !== JSON.stringify(drawn.map((e) => e.id));
  if (changed && !redraw) throw new Error(`round ${round} already has a different held-out list (pass --redraw "<why>" when a candidate was excluded after the draw)`);
  const redraws = [...(splits[key]?.redraws ?? []), ...(changed ? [{ why: redraw, out: r.heldOut.filter((id) => !drawn.some((e) => e.id === id)), in: drawn.map((e) => e.id).filter((id) => !r.heldOut.includes(id)) }] : [])];
  const T = FRESH_TEXT[round];
  splits[key] = {
    round,
    seed,
    method: T.method,
    quotas: FRESH_QUOTAS,
    candidates: candidates.length,
    strata,
    rule: T.rule,
    ...(redraws.length ? { redraws } : {}),
    templates: drawn.map((e) => ({ id: e.id, sha256: e.sha256, wakeup: e.wakeup, source: e.pool === "overflow" ? "overflow" : "top-up" })),
  };
  r.heldOut = drawn.map((e) => e.id);
  r.note = T.note;
  writeFileSync(out, formatSplits(splits));
  console.log(`fresh held-out (round ${round}): ${drawn.length} of ${candidates.length} candidates, strata ${JSON.stringify(strata)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("--fresh")) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  writeFresh(opt("--corpus", join(HERE, "corpus.json")), opt("--out", join(HERE, "splits.json")), opt("--redraw", null), Number(opt("--round", String(FRESH_ROUND)))).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  const corpusPath = opt("--corpus", join(HERE, "corpus.json"));
  const out = opt("--out", join(HERE, "splits.json"));
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
  const eligible = corpus.templates.filter((e) => e.pool === "eligible");
  const { dev, held, sizes, slots } = split(eligible);
  const strata = (xs) => {
    const o = {};
    for (const e of xs) o[stratum(e.wakeup)] = (o[stratum(e.wakeup)] ?? 0) + 1;
    return o;
  };
  const row = (e) => ({ id: e.id, sha256: e.sha256, wakeup: e.wakeup });
  const doc = {
    corpus: "evals/bench/corpus.json",
    seed: SEED,
    method: "evals/bench/split.mjs: mulberry32(seed) Fisher-Yates over eligible ids sorted ascending; per wake-up stratum round(60%) to dev, largest remainder; lists keep the shuffled order",
    rule: "held-out is never read by a session that changes the skill, converter or runtime; it runs only at release points (PLAN Phase 6)",
    strata: { all: sizes, dev: strata(dev), heldOut: strata(held) },
    dev: dev.map(row),
    heldOut: held.map(row),
  };
  // Rolling held-out (rounds.mjs): rounds are decided at release points, not by the seed; a
  // re-run of the split keeps them.
  if (existsSync(out)) {
    const prev = JSON.parse(readFileSync(out, "utf8"));
    for (const k of Object.keys(prev)) if (["roundsRule", "currentRound", "rounds"].includes(k) || /^heldOutFresh\d*$/.test(k)) doc[k] = prev[k];
  }
  writeFileSync(out, formatSplits(doc));
  console.log(`dev ${dev.length} ${JSON.stringify(strata(dev))}; held-out ${held.length} ${JSON.stringify(strata(held))}; slots ${JSON.stringify(slots)}`);
}
