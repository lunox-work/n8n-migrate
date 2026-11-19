#!/usr/bin/env node
// Splits the 100 eligible templates of corpus.json into dev (60) and held-out (40),
// stratified by wake-up, with a seeded shuffle. Deterministic: same corpus, same seed,
// same file.
//
//   node evals/bench/split.mjs [--corpus evals/bench/corpus.json] [--out evals/bench/splits.json]
//   node evals/bench/split.mjs --fresh [--round 3|4|5|6] [--redraw "<why>"] [--offline]   (a fresh held-out: drawFresh() below)
//   node evals/bench/split.mjs --experiment p137 [--skill <dir>] [--redraw "<why>"] [--offline]   (an experiment's own held-out: writeExperiment() below)
//   node evals/bench/split.mjs --amend 1 --round 4 [--offline]   (dev refill after an eligibility amendment: amendDev() below)
//
// Method: one Fisher-Yates shuffle of the eligible ids (sorted ascending first) with
// mulberry32(SEED). Each stratum gets round(60% of its size) dev slots, largest remainder
// first so the total is exactly 60; within a stratum the first templates in shuffled order
// take the dev slots. Both lists keep the shuffled order, which is "the seeded order" the
// bench walks (the first 10 of dev get fixtures first).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stratum, FRESH_QUOTAS, FRESH_ROUND, freshPool, isCandidate } from "./fetch.mjs";

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
      .replace(/\{\n\s+("round": \d+,\s+"promoted"[^{}]*?)\n\s+\}/g, (_, b) => `{ ${line(b)} }`)
      // An experiment's pool lists (ids only) on one line each.
      .replace(/("(?:selected|notSelected)": )\[\n\s+([\d,\s]*?)\n\s+\]/g, (_, k, b) => `${k}[${b.replace(/,\n\s+/g, ", ")}]`) + "\n"
  );
}

// Fresh held-out from round 3 on (docs/DESIGN.md "Bench"): the pool is corpus.json's templates outside the
// seeded split that are eligible (fetch.mjs freshPool: round 3 = Phase 5 `overflow` and the
// round-3 top-up's `fresh`; round 4 = the round-4 top-up's `fresh`, round-4 eligible). Same method
// as split(): one Fisher-Yates shuffle with mulberry32(seed) over the pool sorted by id ascending;
// each stratum's first quota[stratum] templates in shuffled order are drawn, skipping one excluded
// after the draw (`excluded`, `r4Hand`, or `r4: ineligible` from a later amendment of the round's
// rule; fetch.mjs isCandidate), and the list keeps the shuffled order.
// Each seed was fixed (EXCLUSIONS.md) before its draw and before any candidate was opened.
export const FRESH_SEED = 20261115;
export const FRESH_SEEDS = { 3: FRESH_SEED, 4: 20261116, 5: 20261117, 6: 20261118 };
export const freshKey = (round) => (round === FRESH_ROUND ? "heldOutFresh" : `heldOutFresh${round}`);
// `skip`: ids already dev (a later round's dev refill took them from the same pool); passed over
// without leaving the shuffle. `after` (PROPOSALS P126): entries the views walk read after the
// draw for a stratum with no candidate left (fetch.mjs extendWalk, pool `held-refill`); they come
// after the shuffled pool in listing order, so no draw from the pool moves.
export function drawFresh(candidates, quotas = FRESH_QUOTAS, seed = FRESH_SEED, skip = new Set(), after = []) {
  const rnd = mulberry32(seed);
  const order = [...candidates].sort((a, b) => a.id - b.id);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  order.push(...[...after].sort((a, b) => a.rank - b.rank));
  const used = {};
  const drawn = [];
  for (const e of order) {
    if (!isCandidate(e) || skip.has(e.id)) continue;
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
  5: {
    method: "evals/bench/split.mjs drawFresh(): pool = the round-5 top-up's entries that are eligible by the round-4 rule with amendment 1 (fetch.mjs freshPool(templates, 5); the walk started after the gallery ranking's listing pages and skipped every id on them); mulberry32(seed) Fisher-Yates over the pool sorted by id ascending; per wake-up stratum the first quota in shuffled order, skipping a template excluded after the draw (`excluded` or `r4Hand`; it stays in the shuffle); a redraw whose stratum has no candidate left takes the first eligible entries of the views walk after the round's walk (fetch.mjs extendWalk, pool held-refill) in listing order, after the shuffled pool (PROPOSALS P126); the list keeps the shuffled order; no drawn id may be named in levers.json or LEVERS.md",
    rule: "the same rule as the seeded held-out: never read by a session that changes the skill, converter or runtime until release point 5 has scored it (EXCLUSIONS.md, Round 5 held-out)",
    note: "Release point 5 scores 20 fresh held-out templates (splits.heldOutFresh5: a round-5 top-up of the listing past the gallery ranking's pages, each eligible by the round-4 rule with amendment 1, drawn by seed 20261117 per wake-up stratum), labelled blind before any is run",
  },
  6: {
    method: "evals/bench/split.mjs drawFresh(): pool = the round-6 top-up's entries that are eligible by the round-4 rule with amendment 1 (fetch.mjs freshPool(templates, 6); the walk started after the last page any walk read and skipped every earlier corpus, walk, survey and levers id); mulberry32(seed) Fisher-Yates over the pool sorted by id ascending; per wake-up stratum the first quota in shuffled order, skipping a template excluded after the draw (`excluded` or `r4Hand`; it stays in the shuffle) and an id the P137 experiment's set holds; a redraw whose stratum has no candidate left takes the first eligible entries of the views walk after the round's walk (fetch.mjs extendWalk, pool held-refill) in listing order, after the shuffled pool (PROPOSALS P126); the list keeps the shuffled order; no drawn id may be named in levers.json or LEVERS.md",
    rule: "the same rule as the seeded held-out: never read by a session that changes the skill, converter or runtime until release point 6 has scored it (EXCLUSIONS.md, Round 6 held-out)",
    note: "Release point 6 scores 20 fresh held-out templates (splits.heldOutFresh6: a round-6 top-up of the listing past every earlier walk's pages, each eligible by the round-4 rule with amendment 1, drawn by seed 20261118 per wake-up stratum), labelled blind before any is run; the walk's undrawn candidates are the P137 experiment's pool (splits.experiments p137)",
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

// A round's held-out refill entries (P126), in listing order.
export const heldRefillOf = (templates, round) => templates.filter((e) => e.heldRefill === round && e.pool === "held-refill").sort((a, b) => a.rank - b.rank);

// corpus.json's layout: one line per template entry.
function writeCorpus(corpusPath, corpus) {
  const { templates, ...rest } = corpus;
  const text = JSON.stringify({ ...rest, templates }, null, 2).replace(/\{\n\s+("rank": \d+,[^{}]*?)\n\s+\}/g, (_, body) => `{ ${body.replace(/\n\s+/g, " ")} }`);
  writeFileSync(corpusPath, text + "\n");
}

// `redraw`: why a committed draw is drawn again (a candidate excluded by a rule after the draw,
// e.g. `hand` while labelling); the same seed and method, so only the excluded template's
// stratum moves to its next candidate in shuffled order. Kept in the fresh list's `redraws`.
// A redraw whose stratum has no candidate left in the round's walk continues the views walk
// after it (PROPOSALS P126, fetch.mjs extendWalk as "held") and takes that stratum's first
// eligible entries in listing order, after the shuffled pool; corpus.json records the pages
// (`heldRefill<round>`).
async function writeFresh(corpusPath, out, redraw = null, round = FRESH_ROUND, offline = false) {
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
  const splits = JSON.parse(readFileSync(out, "utf8"));
  const seed = FRESH_SEEDS[round];
  if (!seed || !FRESH_TEXT[round]) throw new Error(`no fresh held-out seed for round ${round}`);
  const key = freshKey(round);
  const taken = new Set([...splits.dev, ...splits.heldOut, ...Object.entries(splits).filter(([k]) => /^heldOutFresh\d*$/.test(k) && k !== key).flatMap(([, v]) => v.templates ?? [])].map((r) => r.id));
  const pool = freshPool(corpus.templates, round).filter((e) => !taken.has(e.id));
  // Passed over without leaving the shuffle: dev refills, and (round 6 on) an experiment's set
  // drawn from the same walk (EXCLUSIONS.md "Round 6 held-out" step 5).
  const devAdded = new Set([...Object.entries(splits).filter(([k]) => /^devAdded\d*$/.test(k)).flatMap(([, v]) => v.templates ?? []), ...(round >= 6 ? (splits.experiments ?? []).flatMap((e) => e.templates ?? []) : [])].map((t) => t.id));
  let refill = heldRefillOf(corpus.templates, round).filter((e) => !taken.has(e.id));
  let { drawn, strata, short } = drawFresh(pool, FRESH_QUOTAS, seed, devAdded, refill);
  if (Object.keys(short).length && redraw && round >= 5) {
    const { extendWalk } = await import("./fetch.mjs");
    const extension = await extendWalk(corpus, round, short, { offline, as: "held" });
    corpus.templates.push(...extension.entries);
    const key = `heldRefill${round}`;
    const counts = (pred) => extension.entries.filter(pred).length;
    const prev = corpus[key];
    corpus[key] = {
      round,
      why: `held-out redraws of round ${round} whose stratum had no candidate left in the round's walk (EXCLUSIONS.md; PROPOSALS P126): the views walk continues after the round's walk, and the stratum takes its first eligible entries in listing order, after the shuffled pool`,
      need: Object.entries(short).reduce((o, [k, n]) => ({ ...o, [k]: (o[k] ?? 0) + n }), prev?.need ?? {}),
      pages: [...(prev?.pages ?? []), ...extension.pages],
      rules: "evals/bench/EXCLUSIONS.md (same rules, skips and analyzer as the round's walk) and the round's eligibility; each listing page opened is finished",
      counts: {
        newEntries: (prev?.counts.newEntries ?? 0) + extension.entries.length,
        requests: { listingRequests: (prev?.counts.requests.listingRequests ?? 0) + extension.requests.listingRequests, templateRequests: (prev?.counts.requests.templateRequests ?? 0) + extension.requests.templateRequests },
        excluded: (prev?.counts.excluded ?? 0) + counts((e) => e.excluded),
        eligible: (prev?.counts.eligible ?? 0) + counts((e) => e.pool === "held-refill"),
        ineligible: (prev?.counts.ineligible ?? 0) + counts((e) => e.pool === "held-refill-other"),
      },
    };
    writeCorpus(corpusPath, corpus);
    refill = heldRefillOf(corpus.templates, round).filter((e) => !taken.has(e.id));
    ({ drawn, strata, short } = drawFresh(pool, FRESH_QUOTAS, seed, devAdded, refill));
  }
  if (Object.keys(short).length) throw new Error(`fresh draw short of ${JSON.stringify(short)}: top up with fetch.mjs --top-up --round ${round} first${round >= 5 ? ", or redraw (--redraw) to continue the views walk" : ""}`);
  const candidates = [...pool, ...refill].filter((e) => isCandidate(e) && !devAdded.has(e.id));
  let r = splits.rounds.find((x) => x.round === round);
  if (!r && round > FRESH_ROUND) {
    r = await roundEntry(splits, round);
    splits.rounds.push(r);
  }
  if (!r) throw new Error(`splits.json has no round ${round}`);
  const changed = r.heldOut.length && JSON.stringify(r.heldOut) !== JSON.stringify(drawn.map((e) => e.id));
  if (changed && !redraw) throw new Error(`round ${round} already has a different held-out list (pass --redraw "<why>" when a candidate was excluded after the draw)`);
  const redraws = [...(splits[key]?.redraws ?? []), ...(changed ? [{ why: redraw, out: r.heldOut.filter((id) => !drawn.some((e) => e.id === id)), in: drawn.map((e) => e.id).filter((id) => !r.heldOut.includes(id)) }] : [])];
  // A redrawn template must still be fresh: none named in a file fixing sessions read (EXCLUSIONS.md
  // "Later rounds' held-out"). The draw has no way to pass one over yet, so it stops here.
  // From round 5 the whole draw must be fresh (EXCLUSIONS.md "Round 5 held-out"), not only a redraw.
  const stale = namedInLevers();
  const staleIn = (round >= 5 ? drawn.map((e) => e.id) : changed ? redraws.at(-1).in : []).filter((id) => stale.has(id));
  if (staleIn.length) throw new Error(`${changed ? "redraw" : "draw"} would hold out ${staleIn.join(", ")}, named in levers.json or LEVERS.md (not fresh)`);
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
    templates: drawn.map((e) => ({ id: e.id, sha256: e.sha256, wakeup: e.wakeup, source: e.pool === "overflow" ? "overflow" : e.pool === "held-refill" ? `views walk page ${Math.floor((e.rank - 1) / 50) + 1}` : "top-up" })),
  };
  r.heldOut = drawn.map((e) => e.id);
  // A round written before its held-out was drawn (round 5) keeps its note; the draw's is appended.
  r.note = round >= 5 && r.note ? (r.note.includes(T.note) ? r.note : `${r.note.replace(/\.?$/, ".")} ${T.note}`) : T.note;
  writeFileSync(out, formatSplits(splits));
  console.log(`fresh held-out (round ${round}): ${drawn.length} of ${candidates.length} candidates, strata ${JSON.stringify(strata)}`);
}

// An experiment's own held-out (EXCLUSIONS.md "P137 experiment held-out"; experiments.mjs): the
// round's walk candidates that the round's held-out does not hold and the experiment's rule
// selects, in the experiment seed's shuffled order, then the round's held-out refill entries in
// listing order. Verdicts are judged once, at `convertCommit`: the checkout's skill when it is
// clean at HEAD (recorded), else `--skill <dir>` holding that commit's skills/n8n-migrate (git
// archive). Stored verdicts are kept; only entries without one are judged. A short pool continues
// the views walk (fetch.mjs extendWalk as "held", PROPOSALS P126). Writes splits.json
// `experiments` (one entry per experiment, by name) and, after a continuation, corpus.json.
// Prints counts and ids only: no verdict detail per template.
async function writeExperiment(corpusPath, out, name, { redraw = null, offline = false, skillDir = null } = {}) {
  const { EXPERIMENTS, p137Judge, drawExperiment } = await import("./experiments.mjs");
  const { execFileSync } = await import("node:child_process");
  const X = EXPERIMENTS[name];
  if (!X) throw new Error(`no experiment ${name} (experiments.mjs EXPERIMENTS)`);
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
  const splits = JSON.parse(readFileSync(out, "utf8"));
  const { roundOf } = await import("./rounds.mjs");
  const held = new Set(roundOf(splits, X.round).heldOut.map((r) => r.id));
  if (!held.size) throw new Error(`round ${X.round} has no held-out yet: draw it first (--fresh --round ${X.round})`);
  const prev = (splits.experiments ?? []).find((e) => e.name === name);
  const repo = join(HERE, "..", "..");
  const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
  const head = git("rev-parse", "HEAD");
  const commit = prev?.convertCommit ?? head;
  let skill = skillDir;
  if (!skill) {
    const dirty = git("status", "--porcelain", "--", "skills/n8n-migrate");
    if (commit !== head || dirty) throw new Error(`verdicts must be judged at ${commit}: the checkout's skill is ${dirty ? "edited" : `at ${head}`}; pass --skill <dir> with \`git archive ${commit} skills/n8n-migrate | tar -x -C <dir>\` (then <dir>/skills/n8n-migrate)`);
    skill = join(repo, "skills", "n8n-migrate");
  }
  const dataDir = join(HERE, "data", "wf");
  const selected = new Set(prev?.pool?.selected ?? []);
  const notSelected = new Set(prev?.pool?.notSelected ?? []);
  const verdictOf = await p137Judge({ skill, dataDir });
  const judge = (e) => {
    if (!selected.has(e.id) && !notSelected.has(e.id)) (verdictOf(e.id).selected ? selected : notSelected).add(e.id);
    return selected.has(e.id);
  };
  const pool = freshPool(corpus.templates, X.round);
  for (const e of [...pool, ...heldRefillOf(corpus.templates, X.round)]) if (isCandidate(e) && !held.has(e.id)) judge(e);
  let refill = heldRefillOf(corpus.templates, X.round);
  let { drawn, short } = drawExperiment(pool, { seed: X.seed, size: X.size, exclude: held, selected, after: refill });
  let extension = null;
  const need = short;
  if (short > 0) {
    const { extendWalk } = await import("./fetch.mjs");
    // The continuation judges each eligible entry as it walks (its template is cached by then).
    extension = await extendWalk(corpus, X.round, { any: short }, { offline, as: "held", accept: (e) => !held.has(e.id) && judge(e) });
    corpus.templates.push(...extension.entries);
    for (const e of extension.entries) if (e.pool === "held-refill" && isCandidate(e)) judge(e);
    refill = heldRefillOf(corpus.templates, X.round);
    ({ drawn, short } = drawExperiment(pool, { seed: X.seed, size: X.size, exclude: held, selected, after: refill }));
  }
  if (short > 0) throw new Error(`experiment ${name} short of ${short} after the continuation`);
  const ids = drawn.map((e) => e.id);
  const before = prev?.templates?.map((t) => t.id) ?? [];
  const changed = before.length && JSON.stringify(before) !== JSON.stringify(ids);
  if (changed && !redraw) throw new Error(`experiment ${name} already has a different list (pass --redraw "<why>" when a template was excluded after the draw)`);
  const redraws = [...(prev?.redraws ?? []), ...(changed ? [{ why: redraw, out: before.filter((id) => !ids.includes(id)), in: ids.filter((id) => !before.includes(id)) }] : [])];
  const stale = namedInLevers();
  const staleIn = ids.filter((id) => stale.has(id));
  if (staleIn.length) throw new Error(`experiment ${name} would hold out ${staleIn.join(", ")}, named in levers.json or LEVERS.md (not fresh)`);
  const both = ids.filter((id) => held.has(id));
  if (both.length) throw new Error(`experiment ${name} overlaps round ${X.round}'s held-out: ${both.join(", ")}`);
  const candidates = [...pool, ...refill].filter((e) => isCandidate(e) && !held.has(e.id));
  const entry = {
    name,
    seed: X.seed,
    round: X.round,
    method: X.method,
    rule: X.rule,
    selection: "EXCLUSIONS.md \"P137 experiment held-out\" step 2 (experiments.mjs p137Select): every blocked step (convert-coverage's default mode, `dropped` aside) is no-tool with no tool map or no request template, at least one, and none on a vector, db or media step; judged at convertCommit",
    convertCommit: commit,
    pool: { candidates: candidates.length, selected: [...selected].sort((a, b) => a - b), notSelected: [...notSelected].sort((a, b) => a - b) },
    ...(redraws.length ? { redraws } : {}),
    templates: drawn.map((e) => ({ id: e.id, sha256: e.sha256, wakeup: e.wakeup, source: e.pool === "held-refill" ? `views walk page ${Math.floor((e.rank - 1) / 50) + 1}` : "top-up" })),
  };
  splits.experiments = [...(splits.experiments ?? []).filter((e) => e.name !== name), entry];
  if (extension) {
    const key = `heldRefill${X.round}`;
    const p = corpus[key];
    const counts = (pred) => extension.entries.filter(pred).length;
    corpus[key] = {
      round: X.round,
      why: p?.why ?? `held-out continuations of round ${X.round}'s walk (EXCLUSIONS.md; PROPOSALS P126): the views walk continues after the round's walk, and the set takes its entries in listing order, after the shuffled pool`,
      ...(p?.need ? { need: p.need } : {}),
      experimentNeed: { ...(p?.experimentNeed ?? {}), [name]: (p?.experimentNeed?.[name] ?? 0) + need },
      pages: [...(p?.pages ?? []), ...extension.pages],
      rules: "evals/bench/EXCLUSIONS.md (same rules, skips and analyzer as the round's walk) and the round's eligibility; each listing page opened is finished",
      counts: {
        newEntries: (p?.counts.newEntries ?? 0) + extension.entries.length,
        requests: { listingRequests: (p?.counts.requests.listingRequests ?? 0) + extension.requests.listingRequests, templateRequests: (p?.counts.requests.templateRequests ?? 0) + extension.requests.templateRequests },
        excluded: (p?.counts.excluded ?? 0) + counts((e) => e.excluded),
        eligible: (p?.counts.eligible ?? 0) + counts((e) => e.pool === "held-refill"),
        ineligible: (p?.counts.ineligible ?? 0) + counts((e) => e.pool === "held-refill-other"),
      },
    };
    writeCorpus(corpusPath, corpus);
  }
  writeFileSync(out, formatSplits(splits));
  console.log(`experiment ${name}: ${drawn.length} of ${selected.size} selected among ${candidates.length} candidates (convertCommit ${commit.slice(0, 7)})${extension ? `; continuation read listing pages ${extension.pages.map((x) => x.page).join(", ")} (${extension.requests.listingRequests} listing + ${extension.requests.templateRequests} template requests)` : ""}`);
}

// Ids named in the levers ranking's files (fixing sessions read them).
export function namedInLevers() {
  const ids = new Set();
  for (const f of ["levers.json", "LEVERS.md"]) {
    const p = join(HERE, f);
    if (existsSync(p)) for (const m of readFileSync(p, "utf8").matchAll(/(?<![\w.\-])\d{3,6}(?![\w.\-])/g)) ids.add(Number(m[0]));
  }
  return ids;
}

// Dev refill after an amendment of round n's eligibility rule (EXCLUSIONS.md "Round 4 eligibility,
// amendment 1"): run after the held-out redraw. Every round-n dev template that fails the amended
// rule leaves (`dropped`); each stratum's places go to the round's walk candidates in the fresh
// draw's shuffled order (same seed), past the held-out's draws and skipping dev templates; a
// stratum with none left continues the views walk (fetch.mjs extendWalk) and takes its first
// eligible entries in listing order. Writes `devAdded` in the round, `devAdded<n>` rows in
// splits.json and the walk's entries in corpus.json.
async function amendDev(corpusPath, out, amendment, round, offline) {
  const { roundOf } = await import("./rounds.mjs");
  const { eligibilityOf } = await import("./eligible.mjs");
  const { extendWalk } = await import("./fetch.mjs");
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
  const splits = JSON.parse(readFileSync(out, "utf8"));
  const r = splits.rounds.find((x) => x.round === round);
  if (!r) throw new Error(`splits.json has no round ${round}`);
  const cur = roundOf(splits, round);
  const heldFails = eligibilityOf(cur.heldOut.map((x) => x.id)).filter((x) => !x.eligible);
  if (heldFails.length) throw new Error(`${heldFails.length} held-out template(s) fail the rule: redraw first (--fresh --round ${round} --redraw "<why>")`);
  const fails = eligibilityOf(cur.dev.map((x) => x.id)).filter((x) => !x.eligible);
  if (!fails.length) return console.log(`round ${round}: every dev template passes; nothing to refill`);
  const need = {};
  for (const f of fails) need[f.stratum] = (need[f.stratum] ?? 0) + 1;
  const rnd = mulberry32(FRESH_SEEDS[round]);
  const order = [...freshPool(corpus.templates, round)].sort((a, b) => a.id - b.id);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const taken = new Set([...cur.dev, ...cur.heldOut].map((x) => x.id));
  const picks = [];
  const left = { ...need };
  for (const e of order) {
    const st = stratum(e.wakeup);
    if (!(left[st] > 0) || !isCandidate(e) || taken.has(e.id)) continue;
    left[st]--;
    picks.push({ e, source: "walk" });
  }
  let extension = null;
  if (Object.values(left).some((n) => n > 0)) {
    extension = await extendWalk(corpus, round, left, { offline });
    corpus.templates.push(...extension.entries);
    for (const e of extension.entries) {
      const st = stratum(e.wakeup);
      if (e.pool !== "dev-refill" || !(left[st] > 0)) continue;
      left[st]--;
      picks.push({ e, source: `views walk page ${Math.floor((e.rank - 1) / 50) + 1}` });
    }
    if (Object.values(left).some((n) => n > 0)) throw new Error(`dev refill short of ${JSON.stringify(left)}`);
    const counts = (pred) => extension.entries.filter(pred).length;
    corpus[`devRefill${round}`] = {
      round,
      why: `dev refill after round ${round} eligibility amendment ${amendment} (EXCLUSIONS.md): strata with no walk candidate left continue the views walk after the round's walk`,
      need: Object.fromEntries(Object.entries(need).filter(([k]) => picks.some((p) => p.source !== "walk" && stratum(p.e.wakeup) === k))),
      pages: extension.pages,
      rules: "evals/bench/EXCLUSIONS.md (same rules, skips and analyzer as the round's walk) and round eligibility as amended; each listing page opened is finished",
      counts: { newEntries: extension.entries.length, requests: extension.requests, excluded: counts((e) => e.excluded), eligible: counts((e) => e.pool === "dev-refill"), ineligible: counts((e) => e.pool === "dev-refill-other") },
    };
    const { templates, ...rest } = corpus;
    const text = JSON.stringify({ ...rest, templates }, null, 2).replace(/\{\n\s+("rank": \d+,[^{}]*?)\n\s+\}/g, (_, body) => `{ ${body.replace(/\n\s+/g, " ")} }`);
    writeFileSync(corpusPath, text + "\n");
  }
  r.dropped = [...(r.dropped ?? []), ...fails.map((f) => f.id)];
  r.devAdded = [...(r.devAdded ?? []), ...picks.map((p) => p.e.id)];
  const key = `devAdded${round}`;
  splits[key] = {
    round,
    seed: FRESH_SEEDS[round],
    method: `evals/bench/split.mjs amendDev(): after round ${round}'s eligibility amendment, each dev template that fails it leaves (round \`dropped\`) and its stratum takes the next candidate of the round's walk in the fresh draw's shuffled order (mulberry32(seed) Fisher-Yates over the pool sorted by id), past the held-out's draws; a stratum with none left takes the first eligible entries of the views walk after the round's walk (fetch.mjs extendWalk), in listing order`,
    amendments: [...(splits[key]?.amendments ?? []), { amendment, dropped: fails.map((f) => f.id), added: picks.map((p) => p.e.id) }],
    note: "new dev templates have no fixtures until the blind session writes them",
    templates: [...(splits[key]?.templates ?? []), ...picks.map(({ e, source }) => ({ id: e.id, sha256: e.sha256, wakeup: e.wakeup, source }))],
  };
  writeFileSync(out, formatSplits(splits));
  console.log(`round ${round} amendment ${amendment}: ${fails.length} dev template(s) leave, ${picks.length} join (${picks.filter((p) => p.source === "walk").length} from the walk, ${picks.length - picks.filter((p) => p.source === "walk").length} from the views walk)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("--experiment")) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  writeExperiment(opt("--corpus", join(HERE, "corpus.json")), opt("--out", join(HERE, "splits.json")), opt("--experiment"), { redraw: opt("--redraw", null), offline: a.includes("--offline"), skillDir: opt("--skill", null) }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("--amend")) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  amendDev(opt("--corpus", join(HERE, "corpus.json")), opt("--out", join(HERE, "splits.json")), Number(opt("--amend")), Number(opt("--round", "4")), a.includes("--offline")).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("--fresh")) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  writeFresh(opt("--corpus", join(HERE, "corpus.json")), opt("--out", join(HERE, "splits.json")), opt("--redraw", null), Number(opt("--round", String(FRESH_ROUND))), a.includes("--offline")).catch((e) => {
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
    for (const k of Object.keys(prev)) if (["roundsRule", "currentRound", "rounds", "experiments"].includes(k) || /^(heldOutFresh|devAdded)\d*$/.test(k)) doc[k] = prev[k];
  }
  writeFileSync(out, formatSplits(doc));
  console.log(`dev ${dev.length} ${JSON.stringify(strata(dev))}; held-out ${held.length} ${JSON.stringify(strata(held))}; slots ${JSON.stringify(slots)}`);
}
