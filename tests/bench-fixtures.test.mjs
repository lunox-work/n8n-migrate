// Bench fixtures (evals/bench/fixtures) validate against fixture.schema.json and their
// cross-checks. Template cross-checks run only where evals/bench/data/ was downloaded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkFixture } from "../evals/bench/validate.mjs";

const BENCH = join(dirname(fileURLToPath(import.meta.url)), "..", "evals", "bench");
const VARIANTS = ["normal", "empty", "malformed", "hostile"];

test("every bench fixture validates, four variants per template", async () => {
  const ids = readdirSync(join(BENCH, "fixtures"));
  assert.ok(ids.length >= 50);
  for (const id of ids) {
    const tpl = join(BENCH, "data", "wf", `${id}.json`);
    const raw = existsSync(tpl) ? JSON.parse(readFileSync(tpl, "utf8")) : null;
    for (const v of VARIANTS) {
      const fx = JSON.parse(readFileSync(join(BENCH, "fixtures", id, `${v}.json`), "utf8"));
      assert.equal(fx.template, Number(id));
      assert.equal(fx.variant, v);
      const { errors } = await checkFixture(fx, raw);
      assert.deepEqual(errors, [], `${id}/${v}`);
    }
  }
});

test("the first thirty dev templates of splits.json have fixtures", () => {
  const splits = JSON.parse(readFileSync(join(BENCH, "splits.json"), "utf8"));
  for (const { id } of splits.dev.slice(0, 30)) assert.ok(existsSync(join(BENCH, "fixtures", String(id), "normal.json")), String(id));
});

// Held-out fixtures feed release points only (EXCLUSIONS.md); the first twenty in the seeded
// order exist so the first release point can run. Each pins the hash splits.json recorded.
test("the first twenty held-out templates of splits.json have fixtures pinned to their hash", () => {
  const splits = JSON.parse(readFileSync(join(BENCH, "splits.json"), "utf8"));
  for (const { id, sha256 } of splits.heldOut.slice(0, 20)) {
    for (const v of VARIANTS) {
      const p = join(BENCH, "fixtures", String(id), `${v}.json`);
      assert.ok(existsSync(p), `${id}/${v}`);
      assert.equal(JSON.parse(readFileSync(p, "utf8")).sha256, sha256, `${id}/${v}`);
    }
  }
});

// Round 2's held-out (held-out 21-40) feeds release point 2; same pin to the recorded hash.
test("held-out 21-40 of splits.json (round 2) have fixtures pinned to their hash", () => {
  const splits = JSON.parse(readFileSync(join(BENCH, "splits.json"), "utf8"));
  const round2 = splits.rounds.find((r) => r.round === 2).heldOut;
  assert.deepEqual(round2, splits.heldOut.slice(20, 40).map((r) => r.id));
  for (const { id, sha256 } of splits.heldOut.slice(20, 40)) {
    for (const v of VARIANTS) {
      const p = join(BENCH, "fixtures", String(id), `${v}.json`);
      assert.ok(existsSync(p), `${id}/${v}`);
      assert.equal(JSON.parse(readFileSync(p, "utf8")).sha256, sha256, `${id}/${v}`);
    }
  }
});

// Rolling held-out (PLAN Phase 6, evals/bench/rounds.mjs): the seeded split stays; held-out
// 1-20, scored at release point 1, join dev in round 2, held-out 21-40 score release point 2 and
// join dev in round 3.
test("rolling held-out: round 2 promotes held-out 1-20 and holds out 21-40, round 3 promotes 21-40; the seeded split is unchanged", async () => {
  const { readSplits, roundOf, devWithFixtures, overfittingBound } = await import("../evals/bench/rounds.mjs");
  const splits = readSplits();
  assert.equal(splits.dev.length, 60);
  assert.equal(splits.heldOut.length, 40);
  const ids = (rows) => rows.map((r) => r.id);
  const r1 = roundOf(splits, 1);
  assert.deepEqual([ids(r1.dev), ids(r1.heldOut)], [ids(splits.dev), ids(splits.heldOut.slice(0, 20))]);
  const r2 = roundOf(splits, 2);
  assert.equal(r2.round, 2);
  assert.deepEqual(ids(r2.dev), [...ids(splits.dev), ...ids(splits.heldOut.slice(0, 20))]);
  assert.deepEqual(ids(r2.heldOut), ids(splits.heldOut.slice(20, 40)));
  assert.equal(new Set([...ids(r2.dev), ...ids(r2.heldOut)]).size, 100, "dev and held-out stay disjoint");
  // Round 3 (after release point 2): held-out 21-40 join dev; the seeded held-out is used up,
  // so round 3 has no held-out until fresh templates are fixtured blind (PLAN Phase 6).
  const r3 = roundOf(splits);
  assert.equal(r3.round, 3);
  assert.deepEqual(ids(r3.dev), [...ids(splits.dev), ...ids(splits.heldOut)]);
  assert.deepEqual(ids(r3.heldOut), []);
  assert.equal(devWithFixtures(splits).length, 70);
  assert.equal(devWithFixtures(splits, undefined, 2).length, 50);
  assert.equal(devWithFixtures(splits, undefined, 1).length, 30);
  // The lint forbids every corpus id in skill files, promoted ones included.
  const corpusIds = new Set(JSON.parse(readFileSync(join(BENCH, "corpus.json"), "utf8")).templates.map((t) => t.id));
  for (const r of splits.rounds) for (const id of [...r.promoted, ...r.heldOut]) assert.ok(corpusIds.has(id), String(id));
  // Release point 1 restated: 9/30 against 2/20, bound 23.4.
  assert.deepEqual(overfittingBound({ passDev: 9, nDev: 30, passHeld: 2, nHeld: 20 }), { pooled: 22, gap: 20, bound: 23.4, flipsPoints: 0, inside: true });
  assert.equal(overfittingBound({ passDev: 9, nDev: 30, passHeld: 2, nHeld: 20, flips: 1 }).bound, 33.4);
  // Release point 2 restated: 16/50 against 3/20, bound 23.1.
  assert.deepEqual(overfittingBound({ passDev: 16, nDev: 50, passHeld: 3, nHeld: 20 }), { pooled: 27.1, gap: 17, bound: 23.1, flipsPoints: 0, inside: true });
});
