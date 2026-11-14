#!/usr/bin/env node
// Prints the plan's numbers (PLAN Phase 5, "Numbers reported") from evals/results.jsonl,
// corpus.json and the refusal labels.
//
//   node evals/bench/summary.mjs [--tag <bench run>] [--json]
//
// Outcome shares and coverage: the analyzer's outcomes for the top 100 of the listing
// (corpus.json, default answers). One-shot success: templates of the bench run that passed
// every gate, with the count. Refusal accuracy: labels.json against the analyzer
// (compare-labels.mjs). Per template: gate reached, cause, wall time, cost, n8n execution time.

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const args = process.argv.slice(2);
const json = args.includes("--json");
const rows = existsSync(join(ROOT, "evals", "results.jsonl")) ? readFileSync(join(ROOT, "evals", "results.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const tag = args.includes("--tag") ? args[args.indexOf("--tag") + 1] : rows.at(-1)?.tag;
const mine = [...new Map(rows.filter((r) => r.tag === tag).map((r) => [r.template, r])).values()];

const corpus = JSON.parse(readFileSync(join(HERE, "corpus.json"), "utf8"));
const top = corpus.templates.filter((t) => t.rank <= 100);
const shares = {};
for (const t of top) shares[t.outcome] = (shares[t.outcome] ?? 0) + 1;

const labels = spawnSync(process.execPath, [join(HERE, "compare-labels.mjs"), "--json"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
let refusal = null;
try {
  refusal = JSON.parse(labels.stdout).summary;
} catch {}

const passed = mine.filter((r) => r.passedAll);
const byGate = {};
const byBucket = {};
for (const r of mine) {
  if (r.passedAll) continue;
  byGate[r.gate ?? "error"] = (byGate[r.gate ?? "error"] ?? 0) + 1;
  byBucket[r.bucket ?? "?"] = (byBucket[r.bucket ?? "?"] ?? 0) + 1;
}
const out = {
  tag,
  commit: mine[0]?.commit,
  outcomeSharesTop100: shares,
  coverageTop100: corpus.coverageTop100,
  oneShot: { passed: passed.length, of: mine.length, share: mine.length ? Math.round((passed.length / mine.length) * 1000) / 10 : null },
  failuresByGate: byGate,
  failuresByBucket: byBucket,
  refusalAccuracy: refusal,
  perTemplate: mine.map((r) => ({
    template: r.template,
    reached: r.reached,
    bucket: r.bucket,
    cause: r.cause,
    convert: r.drivers?.convert?.startsWith("skill") ? "skill" : "plain",
    plainPreflight: r.plainColumn?.preflightOk,
    benchWallS: Math.round((r.metrics?.benchWallMs ?? 0) / 1000),
    n8nExecMs: r.metrics?.n8n?.executionMs ?? null,
    skillUsd: r.metrics?.skill?.costUsd ?? null,
    claudeDriverS: r.metrics?.claudeDriver ? Math.round(r.metrics.claudeDriver.wallMs / 1000) : null,
    claudeDriverUsd: r.metrics?.claudeDriver?.costUsd ?? null,
    claudeDriverTurns: r.metrics?.claudeDriver?.turns ?? null,
    claudeRuns: r.metrics?.claudeRuns ?? 0,
    claudeUsd: r.metrics?.claudeCostUsd ?? 0,
  })),
};

if (json) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`bench run ${tag} (commit ${out.commit})`);
  console.log(`outcome shares, top 100 (analyzer, default answers): ${Object.entries(shares).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`coverage of the top 100: ${corpus.coverageTop100.raw.subscription} of ${corpus.coverageTop100.raw.of} raw, ${corpus.coverageTop100.afterExclusions.subscription} of ${corpus.coverageTop100.afterExclusions.of} after exclusions`);
  console.log(`one-shot success: ${out.oneShot.passed} of ${out.oneShot.of} (${out.oneShot.share ?? "-"}%)`);
  console.log(`failures by gate: ${JSON.stringify(byGate)}; by bucket: ${JSON.stringify(byBucket)}`);
  if (refusal) console.log(`refusal accuracy (labels.json vs analyzer): outcome+target ${refusal.outcomeAndTarget}/${refusal.templates}, blockers ${refusal.blockers}/${refusal.templates}, questions ${refusal.questions}/${refusal.templates}, everything ${refusal.all}/${refusal.templates}`);
  console.log("\ntemplate  gate  convert  bucket: cause  | bench s, n8n ms, claude-driver s/$/turns, claude -p runs/$");
  for (const p of out.perTemplate) console.log(`${String(p.template).padEnd(9)} ${String(p.reached === 9 ? "all" : p.reached).padEnd(5)} ${p.convert.padEnd(8)} ${p.bucket ?? "-"}: ${(p.cause ?? "").slice(0, 90)} | ${p.benchWallS}, ${p.n8nExecMs ?? "-"}, ${p.claudeDriverS ?? "-"}/${p.claudeDriverUsd ?? "-"}/${p.claudeDriverTurns ?? "-"}, ${p.claudeRuns}/${p.claudeUsd}`);
}
