#!/usr/bin/env node
// Prints the plan's numbers (PLAN Phase 5, "Numbers reported") from evals/results.jsonl,
// corpus.json and the refusal labels.
//
//   node evals/bench/summary.mjs [--tag <bench run>] [--against <tag>] [--json]
//   node evals/bench/summary.mjs --release <dev tag> <held-out tag> [--flips n] [--round n] [--json]
//
// --release: a release point's gap and overfitting bound (PLAN Phase 6) for the current round
// of the rolling held-out (rounds.mjs): dev = the round's dev templates with fixtures, held-out
// = the round's held-out templates; only those templates' rows of each tag count, and n are
// the fixtured sizes. --flips: templates whose verdict changed between two runs on one commit.
// --round: another round than splits.currentRound (to restate an earlier release point).
// Membership of the run's templates in the current round is printed either way.
//
// Outcome shares and coverage: the analyzer's outcomes for the top 100 of the listing
// (corpus.json, default answers). One-shot success: templates of the bench run that passed
// every gate, with the count, overall and excluding connector-limited templates (a failure that
// traces to a fixture's connectorGaps, PROPOSALS P1; the connector shapes behind those gaps are
// unverified), and excluding templates whose fixture says the bench's n8n image cannot run them
// (expect.n8nCannotRun, PROPOSALS P21). Refusal accuracy: labels.json against the analyzer (compare-labels.mjs). Per
// template: gate reached, cause, connector-limited, overlays that are not placeholder fills,
// wall time, cost, n8n execution time. Claude-driver protocol slips (PROPOSALS P40) as their
// own rate; --against <tag>: verdict flips between this run and another (gate or cause).

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readSplits, roundOf, devWithFixtures, overfittingBound } from "./rounds.mjs";
import { slipStats, flipsBetween } from "./gates.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const args = process.argv.slice(2);
const json = args.includes("--json");
const splits = readSplits();
const roundArg = args.includes("--round") ? Number(args[args.indexOf("--round") + 1]) : undefined;
const round = roundOf(splits, roundArg);
const devIds = new Set(devWithFixtures(splits, undefined, round.round));
const heldIds = new Set(round.heldOut.map((r) => r.id));
const rows = existsSync(join(ROOT, "evals", "results.jsonl")) ? readFileSync(join(ROOT, "evals", "results.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const tag = args.includes("--tag") ? args[args.indexOf("--tag") + 1] : rows.at(-1)?.tag;
const latest = (t) => [...new Map(rows.filter((r) => r.tag === t).map((r) => [r.template, r])).values()];
const mine = latest(tag);

// PROPOSALS P21: templates whose fixture says the bench's n8n image cannot run the main path
// (expect.n8nCannotRun), from the row or, for rows written before it, the normal fixture.
const cannotRunOf = (r) => {
  if (r.n8nCannotRun !== undefined) return r.n8nCannotRun;
  try {
    return JSON.parse(readFileSync(join(HERE, "fixtures", String(r.template), "normal.json"), "utf8")).expect?.n8nCannotRun ?? null;
  } catch {
    return null;
  }
};

if (args.includes("--release")) {
  const i = args.indexOf("--release");
  const [devTag, heldTag] = [args[i + 1], args[i + 2]];
  const flips = args.includes("--flips") ? Number(args[args.indexOf("--flips") + 1]) : 0;
  const dev = latest(devTag).filter((r) => devIds.has(r.template));
  const held = latest(heldTag).filter((r) => heldIds.has(r.template));
  const nDev = devIds.size;
  const nHeld = heldIds.size;
  const passDev = dev.filter((r) => r.passedAll).length;
  const passHeld = held.filter((r) => r.passedAll).length;
  const b = overfittingBound({ passDev, nDev, passHeld, nHeld, flips });
  const missing = { dev: [...devIds].filter((id) => !dev.some((r) => r.template === id)), heldOut: [...heldIds].filter((id) => !held.some((r) => r.template === id)) };
  // PROPOSALS P49: templates the bench's n8n image cannot run (expect.n8nCannotRun) stay in n
  // in the headline (a template without a baseline is not a pass, and n stays the round's
  // fixtured size the bound was planned with); the gap without them, left out of n and of the
  // pass counts on both sides, is reported beside it.
  const nr = { dev: [...devIds].filter((id) => cannotRunOf(dev.find((r) => r.template === id) ?? { template: id })), heldOut: [...heldIds].filter((id) => cannotRunOf(held.find((r) => r.template === id) ?? { template: id })) };
  const runnable = (rows, ids) => rows.filter((r) => !ids.includes(r.template));
  const xDev = runnable(dev, nr.dev).filter((r) => r.passedAll).length;
  const xHeld = runnable(held, nr.heldOut).filter((r) => r.passedAll).length;
  const xb = nDev - nr.dev.length && nHeld - nr.heldOut.length ? overfittingBound({ passDev: xDev, nDev: nDev - nr.dev.length, passHeld: xHeld, nHeld: nHeld - nr.heldOut.length, flips }) : null;
  const excludingN8nCannotRun = { n8nCannotRun: nr, dev: { passed: xDev, of: nDev - nr.dev.length }, heldOut: { passed: xHeld, of: nHeld - nr.heldOut.length }, ...(xb ?? {}) };
  const out = { round: round.round, devTag, heldTag, dev: { passed: passDev, of: nDev }, heldOut: { passed: passHeld, of: nHeld }, flips, ...b, missing, excludingN8nCannotRun };
  if (json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`release point, round ${round.round}: dev ${passDev}/${nDev} (${devTag}), held-out ${passHeld}/${nHeld} (${heldTag})`);
    console.log(`gap ${b.gap} points; bound ${b.bound} (pooled p ${b.pooled}%, 1.96·sqrt(p(1−p)(1/${nDev} + 1/${nHeld})) + 2 × ${flips} flips = ${b.flipsPoints} points): ${b.inside ? "inside" : "OVER"} the bound`);
    const x = excludingN8nCannotRun;
    if (nr.dev.length || nr.heldOut.length) console.log(`without templates n8n cannot run on the bench image (left out of n and passes; dev ${nr.dev.join(", ") || "none"}, held-out ${nr.heldOut.join(", ") || "none"}): dev ${x.dev.passed}/${x.dev.of}, held-out ${x.heldOut.passed}/${x.heldOut.of}${xb ? `, gap ${xb.gap}, bound ${xb.bound}: ${xb.inside ? "inside" : "OVER"}` : ""}`);
    if (missing.dev.length || missing.heldOut.length) console.log(`templates without a row in their tag (counted as not passing): dev ${missing.dev.join(", ") || "none"}; held-out ${missing.heldOut.join(", ") || "none"}`);
  }
  process.exit(0);
}

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
const limited = mine.filter((r) => !r.passedAll && r.connectorLimited);
const rest = mine.filter((r) => !r.connectorLimited || r.passedAll);
const cannotRun = mine.filter((r) => !r.passedAll && cannotRunOf(r));
const runnable = mine.filter((r) => r.passedAll || !cannotRunOf(r));
const share = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const byGate = {};
const byBucket = {};
for (const r of mine) {
  if (r.passedAll) continue;
  byGate[r.gate ?? "error"] = (byGate[r.gate ?? "error"] ?? 0) + 1;
  byBucket[r.bucket ?? "?"] = (byBucket[r.bucket ?? "?"] ?? 0) + 1;
}
const membership = { round: round.round, dev: mine.filter((r) => devIds.has(r.template)).length, heldOut: mine.filter((r) => heldIds.has(r.template)).length, other: mine.filter((r) => !devIds.has(r.template) && !heldIds.has(r.template)).length };
const out = {
  tag,
  membership,
  commit: mine[0]?.commit,
  outcomeSharesTop100: shares,
  coverageTop100: corpus.coverageTop100,
  oneShot: { passed: passed.length, of: mine.length, share: share(passed.length, mine.length) },
  oneShotExcludingConnectorLimited: { passed: passed.length, of: rest.length, share: share(passed.length, rest.length), connectorLimited: limited.map((r) => r.template), note: "connector-limited: the failure traces to a fixture connectorGaps field; the real connector shapes behind those gaps are unverified (shape: assumed)" },
  oneShotExcludingN8nCannotRun: { passed: passed.length, of: runnable.length, share: share(passed.length, runnable.length), n8nCannotRun: cannotRun.map((r) => ({ template: r.template, why: cannotRunOf(r) })), note: "the fixture's expect.n8nCannotRun: the bench's n8n image cannot run the template's main path, so its baseline stops early" },
  gateSum: mine.reduce((n, r) => n + (r.reached ?? 0), 0),
  nonPlaceholderOverlays: mine.filter((r) => r.config?.nonPlaceholder?.length).map((r) => ({ template: r.template, kinds: r.config.nonPlaceholder.map((x) => x.kind) })),
  claudeDriverSlips: slipStats(mine),
  ...(args.includes("--against") ? { flipsAgainst: { tag: args[args.indexOf("--against") + 1], flips: flipsBetween(mine, latest(args[args.indexOf("--against") + 1])) } } : {}),
  failuresByGate: byGate,
  failuresByBucket: byBucket,
  refusalAccuracy: refusal,
  perTemplate: mine.map((r) => ({
    template: r.template,
    reached: r.reached,
    bucket: r.bucket,
    cause: r.cause,
    connectorLimited: !!r.connectorLimited,
    n8nCannotRun: !!cannotRunOf(r),
    nonPlaceholder: (r.config?.nonPlaceholder ?? []).map((x) => x.kind),
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
  console.log(`bench run ${tag} (commit ${out.commit}); round ${round.round}: ${membership.dev} of its templates are dev (${devIds.size} with fixtures), ${membership.heldOut} held-out${membership.other ? `, ${membership.other} neither (an earlier round's held-out or no fixtures)` : ""}`);
  console.log(`outcome shares, top 100 (analyzer, default answers): ${Object.entries(shares).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`coverage of the top 100: ${corpus.coverageTop100.raw.subscription} of ${corpus.coverageTop100.raw.of} raw, ${corpus.coverageTop100.afterExclusions.subscription} of ${corpus.coverageTop100.afterExclusions.of} after exclusions`);
  console.log(`one-shot success: ${out.oneShot.passed} of ${out.oneShot.of} (${out.oneShot.share ?? "-"}%); gate sum ${out.gateSum}`);
  const x = out.oneShotExcludingConnectorLimited;
  console.log(`one-shot success excluding connector-limited: ${x.passed} of ${x.of} (${x.share ?? "-"}%); connector-limited: ${x.connectorLimited.length ? x.connectorLimited.join(", ") : "none"} (${x.note})`);
  const y = out.oneShotExcludingN8nCannotRun;
  console.log(`one-shot success excluding templates n8n cannot run on the bench image: ${y.passed} of ${y.of} (${y.share ?? "-"}%); n8n cannot run: ${y.n8nCannotRun.length ? y.n8nCannotRun.map((x) => `${x.template} (${x.why})`).join("; ") : "none"}`);
  if (out.nonPlaceholderOverlays.length) console.log(`non-placeholder overlays: ${out.nonPlaceholderOverlays.map((o) => `${o.template} (${o.kinds.join(", ")})`).join("; ")}`);
  console.log(`failures by gate: ${JSON.stringify(byGate)}; by bucket: ${JSON.stringify(byBucket)}`);
  const sl = out.claudeDriverSlips;
  console.log(`claude-driver protocol slips (P40, retried once, not a verdict): ${sl.slipped} of ${sl.runs} driver runs (${sl.rate ?? "-"}%), ${sl.retried} retried, ${sl.repeated} repeated${sl.templates.length ? ` (${sl.templates.join(", ")})` : ""}`);
  if (out.flipsAgainst) console.log(`verdict flips against ${out.flipsAgainst.tag}: ${out.flipsAgainst.flips.length}${out.flipsAgainst.flips.length ? " (" + out.flipsAgainst.flips.map((f) => `${f.template}: ${f.from} -> ${f.to}${f.slip ? " [slip]" : ""}`).join("; ") + ")" : ""}`);
  if (refusal) console.log(`refusal accuracy (labels.json vs analyzer): outcome+target ${refusal.outcomeAndTarget}/${refusal.templates}, blockers ${refusal.blockers}/${refusal.templates}, questions ${refusal.questions}/${refusal.templates}, everything ${refusal.all}/${refusal.templates}`);
  console.log("\ntemplate  gate  convert  bucket: cause [CL = connector-limited, NR = n8n cannot run, TC = time compression]  | bench s, n8n ms, claude-driver s/$/turns, claude -p runs/$");
  for (const p of out.perTemplate) console.log(`${String(p.template).padEnd(9)} ${String(p.reached === 9 ? "all" : p.reached).padEnd(5)} ${p.convert.padEnd(8)} ${p.connectorLimited ? "CL " : ""}${p.n8nCannotRun ? "NR " : ""}${p.nonPlaceholder.includes("time-compression") ? "TC " : ""}${p.bucket ?? "-"}: ${(p.cause ?? "").slice(0, 90)} | ${p.benchWallS}, ${p.n8nExecMs ?? "-"}, ${p.claudeDriverS ?? "-"}/${p.claudeDriverUsd ?? "-"}/${p.claudeDriverTurns ?? "-"}, ${p.claudeRuns}/${p.claudeUsd}`);
}
