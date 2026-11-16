// Rolling held-out (PLAN Phase 6): the seeded split in splits.json (`dev` 60, `heldOut` 40)
// never changes; `rounds` says which templates are dev and which are held-out now. After a
// release point is scored, the held-out templates it scored join dev, and the next release
// point scores fresh held-out templates. Every bench tool reads the current round from here.
//
//   splits.rounds = [{round, promoted: [ids that join dev at this round], dropped?: [ids that
//   leave dev at this round], devAdded?: [ids that join dev at this round from outside the
//   earlier rounds], heldOut: [ids]}], splits.currentRound = n. A round's dev = splits.dev + every
//   id promoted up to that round + every id added up to it, less every id dropped up to it
//   (round 4: templates that fail round-4 eligibility, and its amendment 1's replacements;
//   EXCLUSIONS.md), in that order.
//   splits.devAdded4, ... = {templates: [{id, sha256, wakeup, source}]}: the rows of `devAdded`.
//   splits.heldOutFresh.templates, splits.heldOutFresh4.templates, ... = [{id, sha256, wakeup,
//   source}]: held-out templates drawn from outside the seeded split (round 3 on, split.mjs
//   drawFresh); a round's ids resolve from the seeded lists and from these alike.
//   A round may be written before it is current (its held-out drawn ahead of its release point);
//   the P51 guards treat its held-out as unreadable too (unreadableIds). A round's `heldOut` may
//   be empty until its fresh held-out is drawn (round 5: round 4's held-out promoted, dev 120).
//
// Round 5 on: a round reports its numbers out of its own dev size (N of 120), and on the earlier
// round's dev as a subset for continuity (roundTally, summary.mjs).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// N2C_BENCH_SPLITS: another splits file (tests only: a round with a held-out to skip while the
// committed current round has none drawn yet).
export function readSplits(file = process.env.N2C_BENCH_SPLITS || join(HERE, "splits.json")) {
  return JSON.parse(readFileSync(file, "utf8"));
}

// {round, dev: [{id, sha256, wakeup}], heldOut: [...], promoted: [...]} for round `n`
// (default: splits.currentRound; a splits file without rounds is round 1 = the seeded split).
export function roundOf(splits, n = splits.currentRound) {
  const fresh = Object.entries(splits).filter(([k]) => /^(heldOutFresh|devAdded)\d*$/.test(k)).flatMap(([, v]) => v?.templates ?? []);
  const rows = new Map([...splits.dev, ...splits.heldOut, ...fresh].map((r) => [r.id, r]));
  const rounds = splits.rounds ?? [{ round: 1, promoted: [], heldOut: splits.heldOut.map((r) => r.id) }];
  const k = n ?? rounds.at(-1).round;
  const upTo = rounds.filter((r) => r.round <= k);
  const cur = rounds.find((r) => r.round === k);
  if (!cur) throw new Error(`splits.json has no round ${k}`);
  const promoted = upTo.flatMap((r) => r.promoted ?? []);
  const added = upTo.flatMap((r) => r.devAdded ?? []);
  const dropped = new Set(upTo.flatMap((r) => r.dropped ?? []));
  const row = (id) => rows.get(id) ?? (() => { throw new Error(`round ${k}: id ${id} is in neither the seeded split, heldOutFresh nor devAdded`); })();
  const dev = [...splits.dev, ...promoted.map(row), ...added.map(row)].filter((r) => !dropped.has(r.id));
  return { round: k, dev, heldOut: cur.heldOut.map(row), promoted: (cur.promoted ?? []).map(row), dropped: (cur.dropped ?? []).map(row), devAdded: (cur.devAdded ?? []).map(row) };
}

// Held-out ids of the current round (what a fixing session must never read; PROPOSALS P51).
export function heldOutIds(splits, n) {
  return roundOf(splits, n).heldOut.map((r) => r.id);
}

// What a fixing session must not read in round n (default current): that round's held-out and
// the held-out of every later round already written (drawn ahead of its release point).
export function unreadableIds(splits, n = splits.currentRound) {
  const k = n ?? (splits.rounds ?? []).at(-1)?.round;
  const later = (splits.rounds ?? []).filter((r) => r.round > k).flatMap((r) => r.heldOut ?? []);
  return [...new Set([...heldOutIds(splits, n), ...later])];
}

// PROPOSALS P51: a corpus-wide tool run without explicit ids (convert-coverage.mjs over
// evals/survey/data/wf) leaves out the current round's held-out ids and any later round's.
// `ids` as strings or numbers; returns {kept, skipped} in the input's form and order.
export function withoutHeldOut(ids, splits, n) {
  const held = new Set(unreadableIds(splits, n).map(String));
  const kept = [];
  const skipped = [];
  for (const id of ids) (held.has(String(id)) ? skipped : kept).push(id);
  return { kept, skipped };
}

// Dev ids of the current round that have fixtures (what `run.mjs --split dev` runs).
export function devWithFixtures(splits, fixturesDir = join(HERE, "fixtures"), n) {
  return roundOf(splits, n).dev.map((r) => r.id).filter((id) => existsSync(join(fixturesDir, String(id))));
}

// A bench run's numbers over a set of dev ids: passes (by `counts`, summary.mjs's P50 rule),
// the gate sum, and ids with no row (counted as not passing, reached 0). `rows` are one tag's
// latest rows per template. -> {passed, of, gateSum, missing}
export function roundTally(rows, ids, counts = (r) => !!r.passedAll) {
  const want = new Set([...ids].map(Number));
  const mine = rows.filter((r) => want.has(Number(r.template)));
  const have = new Set(mine.map((r) => Number(r.template)));
  return { passed: mine.filter(counts).length, of: want.size, gateSum: mine.reduce((n, r) => n + (r.reached ?? 0), 0), missing: [...want].filter((id) => !have.has(id)) };
}

// PLAN Phase 6 overfitting bound: 1.96 · sqrt(p(1 − p)(1/nDev + 1/nHeld)) + 2 × flips
// templates (in points), p the pooled pass rate. n are the fixtured sizes of the round.
export function overfittingBound({ passDev, nDev, passHeld, nHeld, flips = 0 }) {
  const p = (passDev + passHeld) / (nDev + nHeld);
  const se = 1.96 * Math.sqrt(p * (1 - p) * (1 / nDev + 1 / nHeld));
  const gap = (passDev / nDev - passHeld / nHeld) * 100;
  const flipPts = (2 * flips * 100) / nHeld;
  const bound = se * 100 + flipPts;
  const r1 = (x) => Math.round(x * 10) / 10;
  return { pooled: r1(p * 100), gap: r1(gap), bound: r1(bound), flipsPoints: r1(flipPts), inside: gap <= bound };
}
