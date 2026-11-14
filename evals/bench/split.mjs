#!/usr/bin/env node
// Splits the 100 eligible templates of corpus.json into dev (60) and held-out (40),
// stratified by wake-up, with a seeded shuffle. Deterministic: same corpus, same seed,
// same file.
//
//   node evals/bench/split.mjs [--corpus evals/bench/corpus.json] [--out evals/bench/splits.json]
//
// Method: one Fisher-Yates shuffle of the eligible ids (sorted ascending first) with
// mulberry32(SEED). Each stratum gets round(60% of its size) dev slots, largest remainder
// first so the total is exactly 60; within a stratum the first templates in shuffled order
// take the dev slots. Both lists keep the shuffled order, which is "the seeded order" the
// bench walks (the first 10 of dev get fixtures first).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stratum } from "./fetch.mjs";

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
    for (const k of ["roundsRule", "currentRound", "rounds"]) if (prev[k] !== undefined) doc[k] = prev[k];
  }
  const text = JSON.stringify(doc, null, 2).replace(/\{\n\s+("id": \d+,[^{}]*?)\n\s+\}/g, (_, b) => `{ ${b.replace(/\n\s+/g, " ")} }`);
  writeFileSync(out, text + "\n");
  console.log(`dev ${dev.length} ${JSON.stringify(strata(dev))}; held-out ${held.length} ${JSON.stringify(strata(held))}; slots ${JSON.stringify(slots)}`);
}
