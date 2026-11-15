// Rolling held-out (PLAN Phase 6): the seeded split in splits.json (`dev` 60, `heldOut` 40)
// never changes; `rounds` says which templates are dev and which are held-out now. After a
// release point is scored, the held-out templates it scored join dev, and the next release
// point scores fresh held-out templates. Every bench tool reads the current round from here.
//
//   splits.rounds = [{round, promoted: [ids that join dev at this round], heldOut: [ids]}],
//   splits.currentRound = n. A round's dev = splits.dev + every id promoted up to that round.
//   splits.heldOutFresh.templates = [{id, sha256, wakeup, source}]: held-out templates drawn
//   from outside the seeded split (round 3 on, split.mjs drawFresh); a round's ids resolve
//   from the seeded lists and from these alike.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export function readSplits(file = join(HERE, "splits.json")) {
  return JSON.parse(readFileSync(file, "utf8"));
}

// {round, dev: [{id, sha256, wakeup}], heldOut: [...], promoted: [...]} for round `n`
// (default: splits.currentRound; a splits file without rounds is round 1 = the seeded split).
export function roundOf(splits, n = splits.currentRound) {
  const rows = new Map([...splits.dev, ...splits.heldOut, ...(splits.heldOutFresh?.templates ?? [])].map((r) => [r.id, r]));
  const rounds = splits.rounds ?? [{ round: 1, promoted: [], heldOut: splits.heldOut.map((r) => r.id) }];
  const k = n ?? rounds.at(-1).round;
  const upTo = rounds.filter((r) => r.round <= k);
  const cur = rounds.find((r) => r.round === k);
  if (!cur) throw new Error(`splits.json has no round ${k}`);
  const promoted = upTo.flatMap((r) => r.promoted ?? []);
  const row = (id) => rows.get(id) ?? (() => { throw new Error(`round ${k}: id ${id} is in neither the seeded split nor heldOutFresh`); })();
  return { round: k, dev: [...splits.dev, ...promoted.map(row)], heldOut: cur.heldOut.map(row), promoted: (cur.promoted ?? []).map(row) };
}

// Held-out ids of the current round (what a fixing session must never read; PROPOSALS P51).
export function heldOutIds(splits, n) {
  return roundOf(splits, n).heldOut.map((r) => r.id);
}

// Dev ids of the current round that have fixtures (what `run.mjs --split dev` runs).
export function devWithFixtures(splits, fixturesDir = join(HERE, "fixtures"), n) {
  return roundOf(splits, n).dev.map((r) => r.id).filter((id) => existsSync(join(fixturesDir, String(id))));
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
