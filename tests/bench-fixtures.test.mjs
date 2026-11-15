// Bench fixtures (evals/bench/fixtures) validate against fixture.schema.json and their
// cross-checks. Template cross-checks run only where evals/bench/data/ was downloaded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkFixture, crossVariantErrors } from "../evals/bench/validate.mjs";

const BENCH = join(dirname(fileURLToPath(import.meta.url)), "..", "evals", "bench");
const VARIANTS = ["normal", "empty", "malformed", "hostile"];

test("every bench fixture validates, four variants per template", async () => {
  const ids = readdirSync(join(BENCH, "fixtures"));
  assert.ok(ids.length >= 50);
  for (const id of ids) {
    const tpl = join(BENCH, "data", "wf", `${id}.json`);
    const raw = existsSync(tpl) ? JSON.parse(readFileSync(tpl, "utf8")) : null;
    const byVariant = {};
    for (const v of VARIANTS) {
      const fx = JSON.parse(readFileSync(join(BENCH, "fixtures", id, `${v}.json`), "utf8"));
      assert.equal(fx.template, Number(id));
      assert.equal(fx.variant, v);
      const { errors } = await checkFixture(fx, raw);
      assert.deepEqual(errors, [], `${id}/${v}`);
      byVariant[v] = fx;
    }
    assert.deepEqual(crossVariantErrors(byVariant), [], id);
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
  // so round 3's held-out is 20 fresh templates from outside the seeded split (PLAN Phase 6).
  const r3 = roundOf(splits);
  assert.equal(r3.round, 3);
  assert.deepEqual(ids(r3.dev), [...ids(splits.dev), ...ids(splits.heldOut)]);
  assert.deepEqual(ids(r3.heldOut), ids(splits.heldOutFresh.templates));
  assert.equal(r3.heldOut.length, 20);
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

// Round 3's fresh held-out (PLAN Phase 6; split.mjs drawFresh, fetch.mjs --top-up): drawn by
// seed per wake-up stratum from corpus.json's eligible templates outside the seeded split, with
// the seeded held-out's strata halved; reproducible from corpus.json; never in the survey folder.
test("round 3's fresh held-out: outside the seeded split, reproducible from the seed, strata as planned", async () => {
  const { drawFresh, FRESH_SEED } = await import("../evals/bench/split.mjs");
  const { FRESH_QUOTAS, freshCandidates, stratum } = await import("../evals/bench/fetch.mjs");
  const splits = JSON.parse(readFileSync(join(BENCH, "splits.json"), "utf8"));
  const corpus = JSON.parse(readFileSync(join(BENCH, "corpus.json"), "utf8"));
  const fresh = splits.heldOutFresh;
  assert.equal(fresh.seed, FRESH_SEED);
  const seeded = new Set([...splits.dev, ...splits.heldOut].map((r) => r.id));
  for (const t of fresh.templates) assert.ok(!seeded.has(t.id), `${t.id} is in the seeded split`);
  // Every fresh id is in corpus.json with the same hash (so the lint and validate.mjs cover it).
  const byId = new Map(corpus.templates.map((e) => [e.id, e]));
  for (const t of fresh.templates) {
    const e = byId.get(t.id);
    assert.ok(e && !e.excluded && ["overflow", "fresh"].includes(e.pool), String(t.id));
    assert.equal(e.sha256, t.sha256, String(t.id));
    assert.equal(e.wakeup, t.wakeup, String(t.id));
  }
  // The seeded held-out (40) halved, per stratum.
  const held40 = {};
  for (const r of splits.heldOut) held40[stratum(r.wakeup)] = (held40[stratum(r.wakeup)] ?? 0) + 1;
  assert.deepEqual(FRESH_QUOTAS, Object.fromEntries(Object.entries(held40).map(([k, n]) => [k, n / 2])));
  const got = {};
  for (const t of fresh.templates) got[stratum(t.wakeup)] = (got[stratum(t.wakeup)] ?? 0) + 1;
  assert.deepEqual(got, Object.fromEntries(Object.entries(FRESH_QUOTAS).filter(([, n]) => n)));
  // Reproducible: the same draw from corpus.json gives the same list, in the same order.
  const { drawn } = drawFresh(freshCandidates(corpus.templates).filter((e) => !seeded.has(e.id)));
  assert.deepEqual(drawn.map((e) => e.id), fresh.templates.map((t) => t.id));
  // Every overflow template of the Phase 5 walk is a candidate; the top-up adds entries only.
  assert.equal(freshCandidates(corpus.templates).filter((e) => e.pool === "overflow").length, corpus.counts.overflow);
  // PROPOSALS P51: a current held-out template is never in the survey folder.
  const survey = join(BENCH, "..", "survey", "data", "wf");
  for (const t of fresh.templates) assert.ok(!existsSync(join(survey, `${t.id}.json`)), `${t.id} is in evals/survey/data/wf`);
});
