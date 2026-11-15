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

test("every seeded dev template of splits.json has fixtures pinned to its hash", () => {
  const splits = JSON.parse(readFileSync(join(BENCH, "splits.json"), "utf8"));
  for (const { id, sha256 } of splits.dev) {
    const p = join(BENCH, "fixtures", String(id), "normal.json");
    assert.ok(existsSync(p), String(id));
    assert.equal(JSON.parse(readFileSync(p, "utf8")).sha256, sha256, String(id));
  }
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

// Round 3's fresh held-out (splits.json heldOutFresh) feeds release point 3; its fixtures were
// written blind, and each pins the hash heldOutFresh recorded.
test("round 3's fresh held-out of splits.json have fixtures pinned to their hash", () => {
  const splits = JSON.parse(readFileSync(join(BENCH, "splits.json"), "utf8"));
  const round3 = splits.rounds.find((r) => r.round === 3).heldOut;
  assert.deepEqual(round3, splits.heldOutFresh.templates.map((r) => r.id));
  for (const { id, sha256 } of splits.heldOutFresh.templates) {
    for (const v of VARIANTS) {
      const p = join(BENCH, "fixtures", String(id), `${v}.json`);
      assert.ok(existsSync(p), `${id}/${v}`);
      assert.equal(JSON.parse(readFileSync(p, "utf8")).sha256, sha256, `${id}/${v}`);
    }
  }
});

// Round 4's fresh held-out (splits.json heldOutFresh4) feeds release point 4; its fixtures were
// written blind (2026-11-16), and each pins the hash heldOutFresh4 recorded. The template redrawn
// after that (heldOutFresh4.redraws, amendment 1) got its fixtures from a later blind session, so
// all 20 have four each.
test("round 4's fresh held-out of splits.json have fixtures pinned to their hash", () => {
  const splits = JSON.parse(readFileSync(join(BENCH, "splits.json"), "utf8"));
  const round4 = splits.rounds.find((r) => r.round === 4).heldOut;
  assert.deepEqual(round4, splits.heldOutFresh4.templates.map((r) => r.id));
  assert.equal(round4.length, 20);
  for (const { id, sha256 } of splits.heldOutFresh4.templates) {
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
  const r3 = roundOf(splits, 3);
  assert.equal(r3.round, 3);
  assert.deepEqual(ids(r3.dev), [...ids(splits.dev), ...ids(splits.heldOut)]);
  assert.deepEqual(ids(r3.heldOut), ids(splits.heldOutFresh.templates));
  assert.equal(r3.heldOut.length, 20);
  assert.equal(devWithFixtures(splits, undefined, 3).length, 100);
  assert.equal(devWithFixtures(splits, undefined, 2).length, 80);
  assert.equal(devWithFixtures(splits, undefined, 1).length, 60);
  // The lint forbids every corpus id in skill files, promoted ones included.
  const corpusIds = new Set(JSON.parse(readFileSync(join(BENCH, "corpus.json"), "utf8")).templates.map((t) => t.id));
  for (const r of splits.rounds) for (const id of [...r.promoted, ...r.heldOut]) assert.ok(corpusIds.has(id), String(id));
  // Release point 1 restated: 9/30 against 2/20, bound 23.4.
  assert.deepEqual(overfittingBound({ passDev: 9, nDev: 30, passHeld: 2, nHeld: 20 }), { pooled: 22, gap: 20, bound: 23.4, flipsPoints: 0, inside: true });
  assert.equal(overfittingBound({ passDev: 9, nDev: 30, passHeld: 2, nHeld: 20, flips: 1 }).bound, 33.4);
  // Release point 2 restated: 16/50 against 3/20, bound 23.1.
  assert.deepEqual(overfittingBound({ passDev: 16, nDev: 50, passHeld: 3, nHeld: 20 }), { pooled: 27.1, gap: 17, bound: 23.1, flipsPoints: 0, inside: true });
  // Release point 3 (RELEASE-3.md): 29/100 against 1/20, over the bound of 20.8 for the first time.
  assert.deepEqual(overfittingBound({ passDev: 29, nDev: 100, passHeld: 1, nHeld: 20 }), { pooled: 25, gap: 24, bound: 20.8, flipsPoints: 0, inside: false });
});

// Round 3's fresh held-out (PLAN Phase 6; split.mjs drawFresh, fetch.mjs --top-up): drawn by
// seed per wake-up stratum from corpus.json's eligible templates outside the seeded split, with
// the seeded held-out's strata halved; reproducible from corpus.json; never in the survey folder.
test("round 3's fresh held-out: outside the seeded split, reproducible from the seed, strata as planned", async () => {
  const { drawFresh, FRESH_SEED } = await import("../evals/bench/split.mjs");
  const { FRESH_QUOTAS, freshCandidates, freshPool, stratum } = await import("../evals/bench/fetch.mjs");
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
  const { drawn } = drawFresh(freshPool(corpus.templates).filter((e) => !seeded.has(e.id)));
  assert.deepEqual(drawn.map((e) => e.id), fresh.templates.map((t) => t.id));
  // Every overflow template of the Phase 5 walk is a candidate; the top-up adds entries only.
  assert.equal(freshCandidates(corpus.templates).filter((e) => e.pool === "overflow").length, corpus.counts.overflow);
  // PROPOSALS P51: a current held-out template is never in the survey folder.
  const survey = join(BENCH, "..", "survey", "data", "wf");
  for (const t of fresh.templates) assert.ok(!existsSync(join(survey, `${t.id}.json`)), `${t.id} is in evals/survey/data/wf`);
});

// PROPOSALS P51: a coverage run over a corpus folder without explicit ids (the survey folder by
// default) never converts a current held-out template, and names none of them.
test("P51: convert-coverage without --ids skips the current round's held-out", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const { readSplits, heldOutIds, withoutHeldOut } = await import("../evals/bench/rounds.mjs");
  const splits = readSplits();
  const held = heldOutIds(splits);
  assert.ok(held.length > 0);
  assert.deepEqual(withoutHeldOut([String(held[0]), "99999991", held[1]], splits), { kept: ["99999991"], skipped: [String(held[0]), held[1]] });
  const dir = mkdtempSync(join(tmpdir(), "n2c-p51-"));
  try {
    const wf = { name: "t", nodes: [{ id: "a", name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0], parameters: {} }, { id: "b", name: "Set", type: "n8n-nodes-base.set", typeVersion: 3.4, position: [200, 0], parameters: {} }], connections: { Start: { main: [[{ node: "Set", type: "main", index: 0 }]] } } };
    for (const id of [held[0], 99999991]) writeFileSync(join(dir, `${id}.json`), JSON.stringify(wf));
    const run = (extra) => {
      const out = join(dir, `out${extra.length}.md`);
      const r = spawnSync(process.execPath, [join(BENCH, "..", "convert-coverage.mjs"), "--corpus", dir, "--out", out, ...extra], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return readFileSync(out, "utf8");
    };
    const md = run([]);
    assert.match(md, /over 1 templates/);
    assert.match(md, /1 template\(s\) of the current round's held-out skipped/);
    assert.ok(!md.includes(String(held[0])), "the report names no held-out id");
    // Explicit ids (a release point) run as given.
    assert.match(run(["--ids", `${held[0]},99999991`]), /over 2 templates/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Top-ups by round (fetch.mjs TOP_UPS): round 3's pool is the Phase 5 overflow plus its own
// `fresh` entries; round 4's is its own `fresh` entries only (each round-4 eligible), and a hand
// call after the draw (`r4Hand`) leaves the candidates but not the shuffle. A later walk starts on
// the page holding the highest rank an earlier walk read.
test("top-ups: each round's pool, candidates and start page", async () => {
  const { freshPool, freshCandidates, freshShortfall, startPageOf, r4Verdict, TOP_UPS } = await import("../evals/bench/fetch.mjs");
  const { drawFresh } = await import("../evals/bench/split.mjs");
  const t = [
    { id: 1, rank: 150, pool: "overflow", wakeup: "chat" },
    { id: 2, rank: 210, topUp: 3, pool: "fresh", wakeup: "manual" },
    { id: 3, rank: 224, topUp: 3, pool: "fresh-other", wakeup: "chat" },
    { id: 4, rank: 260, topUp: 4, pool: "fresh", r4: "eligible", wakeup: "chat" },
    { id: 5, rank: 261, topUp: 4, pool: "fresh-other", r4: "ineligible", wakeup: "chat" },
    { id: 6, rank: 262, topUp: 4, pool: "fresh", r4: "eligible", wakeup: "chat", r4Hand: "wiring" },
  ];
  assert.deepEqual(freshPool(t).map((e) => e.id), [1, 2]);
  assert.deepEqual(freshPool(t, 4).map((e) => e.id), [4, 6]);
  assert.deepEqual(freshCandidates(t, 4).map((e) => e.id), [4]);
  assert.deepEqual(freshShortfall(t, { chat: 2 }, 4), { chat: 1 });
  assert.deepEqual(drawFresh(freshPool(t, 4), { chat: 2 }, 1).drawn.map((e) => e.id), [4]);
  assert.throws(() => freshPool(t, 9));
  assert.equal(startPageOf({ counts: { listingEntries: 200 }, templates: t }, 3), 5);
  assert.equal(startPageOf({ counts: { listingEntries: 200 }, templates: t }, 4), 5);
  assert.equal(startPageOf({ counts: { listingEntries: 200 }, templates: [{ rank: 250, topUp: 3 }] }, 4), 6);
  assert.equal(TOP_UPS[3].finishPage, false);
  assert.equal(TOP_UPS[4].eligibility && TOP_UPS[4].finishPage, true);
  // r4Verdict: the round-4 rule on a workflow the analyzer has read.
  const { analyze, unwrap } = await import("../skills/n8n-to-claude/scripts/analyze.mjs");
  const ROOT = join(BENCH, "..", "..");
  const refs = (f) => JSON.parse(readFileSync(join(ROOT, "skills/n8n-to-claude/references", f), "utf8"));
  const opts = { nodes: refs("nodes.json"), capabilities: refs("capabilities.json"), hosts: refs("http-hosts.json"), now: Date.parse("2026-11-16T00:00:00Z") };
  const elig = { lists: JSON.parse(readFileSync(join(BENCH, "eligibility.json"), "utf8")), nodes: opts.nodes.nodes };
  const verdict = (wf) => r4Verdict(wf, analyze(unwrap({ workflow: { id: "t", name: "t", workflow: wf } }, "t"), opts).workflows[0], {}, elig);
  const sheet = { name: "Sheet", type: "n8n-nodes-base.googleSheets", typeVersion: 4.5, position: [0, 0], credentials: { googleSheetsOAuth2Api: { id: "1", name: "g" } }, parameters: { resource: "sheet", operation: "append", documentId: { __rl: true, mode: "id", value: "doc" }, sheetName: { __rl: true, mode: "name", value: "S" }, columns: { mappingMode: "autoMapInputData", value: {} } } };
  const start = { name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0], parameters: {} };
  assert.deepEqual(verdict({ nodes: [start, sheet], connections: { Start: { main: [[{ node: "Sheet", type: "main", index: 0 }]] } } }), { r4: "eligible" });
  const hook = { name: "Hook", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0], parameters: { httpMethod: "POST", path: "x" } };
  const relay = verdict({ nodes: [hook, sheet], connections: { Hook: { main: [[{ node: "Sheet", type: "main", index: 0 }]] } } });
  assert.equal(relay.r4, "ineligible");
  assert.ok(relay.r4Reasons.some((r) => r.startsWith("outcome/relay-or-hosted")), JSON.stringify(relay));
});

// Rounds written ahead of their release point: `dropped` leaves dev, and the P51 guards treat a
// later round's held-out as unreadable while an earlier round is current.
test("rounds: dropped ids leave dev; a later round's held-out is unreadable before it is current", async () => {
  const { roundOf, heldOutIds, unreadableIds, withoutHeldOut } = await import("../evals/bench/rounds.mjs");
  const row = (id) => ({ id, sha256: "x", wakeup: "manual" });
  const s = {
    dev: [row(1), row(2)],
    heldOut: [row(3), row(4)],
    currentRound: 2,
    rounds: [
      { round: 1, promoted: [], heldOut: [3, 4] },
      { round: 2, promoted: [3, 4], heldOut: [5] },
      { round: 3, promoted: [5], dropped: [2, 4], heldOut: [6] },
    ],
    heldOutFresh: { templates: [row(5)] },
    heldOutFresh3: { templates: [row(6)] },
  };
  const ids = (rows) => rows.map((r) => r.id);
  assert.deepEqual(ids(roundOf(s).dev), [1, 2, 3, 4]);
  assert.deepEqual(ids(roundOf(s, 3).dev), [1, 3, 5]);
  assert.deepEqual(ids(roundOf(s, 3).dropped), [2, 4]);
  assert.deepEqual(heldOutIds(s), [5]);
  assert.deepEqual(unreadableIds(s), [5, 6]);
  assert.deepEqual(unreadableIds(s, 3), [6]);
  assert.deepEqual(withoutHeldOut(["6", 1, 5], s), { kept: [1], skipped: ["6", 5] });
});

// Round 4 (EXCLUSIONS.md, Round 4 eligibility, its amendment 1 and Round 4 held-out): round 3's
// held-out joins dev, the 20 of those 120 templates that fail round-4 eligibility leave, and 20
// fresh templates from a round-4 top-up are held out, drawn by seed 20261116 per stratum. After
// amendment 1, the dev templates that fail it leave too and as many join (devAdded: the walk's
// next candidates in the same shuffled order, else the views walk's next eligible entries), and a
// held-out template that fails it is redrawn; the new ones got fixtures from a blind session.
test("round 4: dev is 100 round-4-eligible templates, held-out 20 fresh, amendment 1 replaced like for like", async () => {
  const { readSplits, roundOf, devWithFixtures, unreadableIds } = await import("../evals/bench/rounds.mjs");
  const { drawFresh, FRESH_SEEDS, mulberry32 } = await import("../evals/bench/split.mjs");
  const { FRESH_QUOTAS, freshPool, stratum, isCandidate } = await import("../evals/bench/fetch.mjs");
  const splits = readSplits();
  const corpus = JSON.parse(readFileSync(join(BENCH, "corpus.json"), "utf8"));
  const ids = (rows) => rows.map((r) => r.id);
  const r3 = roundOf(splits, 3);
  const r4 = roundOf(splits, 4);
  const fresh = splits.heldOutFresh4;
  const added = splits.devAdded4;
  assert.equal(r4.round, 4);
  assert.equal(r4.dev.length, 100);
  assert.equal(new Set(ids(r4.dev)).size, 100);
  assert.equal(r4.dropped.length, 20 + added.amendments.reduce((n, a) => n + a.dropped.length, 0));
  assert.deepEqual(ids(r4.devAdded), ids(added.templates));
  assert.equal(r4.devAdded.length, r4.dropped.length - 20, "like for like: as many join as amendment 1 dropped");
  assert.deepEqual(ids(r4.promoted), ids(r3.heldOut));
  assert.deepEqual(ids(r4.dev), [...ids(r3.dev), ...ids(r3.heldOut), ...ids(r4.devAdded)].filter((id) => !ids(r4.dropped).includes(id)));
  // Each replacement is in the stratum of a template it replaces.
  const strataOf = (xs) => xs.map((x) => stratum(x.wakeup)).sort();
  const droppedRows = [...r3.dev, ...r3.heldOut].filter((x) => added.amendments.flatMap((a) => a.dropped).includes(x.id));
  assert.deepEqual(strataOf(added.templates), strataOf(droppedRows));
  // Every dev template has fixtures; the ones amendment 1 added got theirs from a blind session,
  // four variants each, pinned to the hash devAdded4 recorded.
  const withFixtures = new Set(devWithFixtures(splits, undefined, 4));
  for (const id of ids(r4.dev)) assert.ok(withFixtures.has(id), `${id} has no fixtures`);
  assert.equal(withFixtures.size, 100);
  for (const { id, sha256 } of added.templates) {
    for (const v of VARIANTS) {
      const p = join(BENCH, "fixtures", String(id), `${v}.json`);
      assert.ok(existsSync(p), `${id}/${v}`);
      assert.equal(JSON.parse(readFileSync(p, "utf8")).sha256, sha256, `${id}/${v}`);
    }
  }
  assert.deepEqual(ids(r4.heldOut), ids(fresh.templates));
  assert.equal(r4.heldOut.length, 20);
  // Disjoint from every template any earlier round used.
  const used = new Set([...ids(r3.dev), ...ids(r3.heldOut)]);
  for (const id of ids(r4.heldOut)) assert.ok(!used.has(id), String(id));
  // Each held-out template is a round-4 top-up entry, round-4 eligible, with the recorded hash.
  const byId = new Map(corpus.templates.map((e) => [e.id, e]));
  for (const t of fresh.templates) {
    const e = byId.get(t.id);
    assert.ok(e && e.topUp === 4 && e.pool === "fresh" && e.r4 === "eligible" && !e.excluded, String(t.id));
    assert.equal(e.sha256, t.sha256, String(t.id));
    assert.equal(e.wakeup, t.wakeup, String(t.id));
  }
  const got = {};
  for (const t of fresh.templates) got[stratum(t.wakeup)] = (got[stratum(t.wakeup)] ?? 0) + 1;
  assert.deepEqual(got, FRESH_QUOTAS);
  // Reproducible from corpus.json and the committed seed (a candidate a later amendment or hand
  // call moved out keeps its place in the shuffle and is passed over).
  assert.equal(fresh.seed, FRESH_SEEDS[4]);
  const devAddedIds = new Set(ids(added.templates));
  assert.deepEqual(drawFresh(freshPool(corpus.templates, 4), FRESH_QUOTAS, FRESH_SEEDS[4], devAddedIds).drawn.map((e) => e.id), ids(fresh.templates));
  for (const { out } of fresh.redraws ?? []) for (const id of out) assert.ok(!isCandidate(byId.get(id)), `${id} was redrawn but is still a candidate`);
  // devAdded from the walk: the same shuffle continued past the held-out's draws, per stratum.
  const rnd = mulberry32(FRESH_SEEDS[4]);
  const order = [...freshPool(corpus.templates, 4)].sort((a, b) => a.id - b.id);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const fromWalk = added.templates.filter((t) => t.source === "walk");
  for (const st of new Set(fromWalk.map((t) => stratum(t.wakeup)))) {
    const want = fromWalk.filter((t) => stratum(t.wakeup) === st).map((t) => t.id);
    const next = order.filter((e) => stratum(e.wakeup) === st && isCandidate(e) && !ids(r4.heldOut).includes(e.id) && !ids(r3.dev).includes(e.id) && !ids(r3.heldOut).includes(e.id)).slice(0, want.length).map((e) => e.id);
    assert.deepEqual(want, next, `stratum ${st}`);
  }
  // devAdded from the views walk: the first round-eligible entries of their stratum past the walk.
  for (const t of added.templates.filter((x) => x.source !== "walk")) {
    const e = byId.get(t.id);
    assert.ok(e && e.devRefill === 4 && e.pool === "dev-refill" && e.r4 === "eligible" && e.sha256 === t.sha256, String(t.id));
    const first = corpus.templates.filter((x) => x.devRefill === 4 && x.pool === "dev-refill" && stratum(x.wakeup) === stratum(t.wakeup)).sort((a, b) => a.rank - b.rank)[0];
    assert.equal(first.id, t.id);
  }
  for (const t of fromWalk) assert.ok(byId.get(t.id)?.topUp === 4 && byId.get(t.id).r4 === "eligible", String(t.id));
  // While round 3 is current the P51 guards already skip round 4's held-out; once round 4 is
  // current (after release point 3), round 3's held-out is dev and only round 4's is skipped.
  assert.ok([3, 4].includes(roundOf(splits).round));
  const expected = roundOf(splits).round === 3 ? [...ids(r3.heldOut), ...ids(r4.heldOut)] : ids(r4.heldOut);
  assert.deepEqual(new Set(unreadableIds(splits)), new Set(expected));
  // PROPOSALS P51: never in the survey folder.
  const survey = join(BENCH, "..", "survey", "data", "wf");
  for (const t of fresh.templates) assert.ok(!existsSync(join(survey, `${t.id}.json`)), `${t.id} is in evals/survey/data/wf`);
});
