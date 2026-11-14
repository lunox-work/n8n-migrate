#!/usr/bin/env node
// Picks the 20 refusal templates to hand-label, and prints only their ids (ascending),
// so the labeller does not see the analyzer's verdict per template before labelling.
//
//   node evals/bench/pick-labels.mjs [--corpus evals/bench/corpus.json]
//
// Rule: buckets replaced, setup-only, keep-in-n8n, hosted:key, hosted:no-key, each in
// listing order (most-viewed first); take one from each bucket in turn until 20.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const N = 20;

export function pick(templates, n = N) {
  const pool = templates.filter((e) => e.pool === "refusal").sort((a, b) => a.rank - b.rank);
  const bucket = (e) => (e.setupOnly ? "setup-only" : e.outcome === "hosted" ? `hosted:${e.target}` : e.outcome);
  const order = ["replaced", "setup-only", "keep-in-n8n", "hosted:key", "hosted:no-key"];
  const lists = order.map((b) => pool.filter((e) => bucket(e) === b));
  const out = [];
  for (let round = 0; out.length < n && lists.some((l) => l.length > round); round++)
    for (const l of lists) if (out.length < n && l[round]) out.push(l[round]);
  return out.map((e) => e.id).sort((a, b) => a - b);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const corpus = JSON.parse(readFileSync(a.includes("--corpus") ? a[a.indexOf("--corpus") + 1] : join(HERE, "corpus.json"), "utf8"));
  console.log(pick(corpus.templates).join(" "));
}
