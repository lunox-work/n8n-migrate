// An experiment's own held-out set (PROPOSALS P137; EXCLUSIONS.md "P137 experiment held-out"),
// kept in splits.json `experiments` beside a round's release-point held-out, never in its
// `heldOut` (rounds.mjs heldOutSets / unreadableIds keep it unread).
//
// P137 measures convert-time model drafts, so its templates are the round-6 walk's candidates
// where drafting can apply, chosen by a rule fixed before any template was opened:
//   blocked steps = the converter definition's steps of kind `blocked`, not disabled (as
//     evals/convert-coverage.mjs counts them), less those blocked `dropped` (left out by design);
//   (a) at least one blocked step;
//   (b) each one is a drafting target: `no-tool` with "no tool map for …" (a connector operation
//     or poll with no tool map) or "no request template for …" (an app with no REST request
//     template); a `no-tool` the connector's captured tools confirm, and every other kind, is not;
//   (c) no blocked step and no analyzer blocker sits on a step whose analyzer kind is vector, db
//     or media.
// The verdict comes from the template file, the analyzer (default answers, the fetch's --now) and
// the converter as convert-coverage.mjs runs it by default (no answers, its --now), both at one
// commit (`convertCommit`); a later judgement (redraw, refill) runs that commit's skill too.
//
// The draw: mulberry32(seed) Fisher-Yates over the round's fresh pool sorted by id (the pool the
// round draws from), then the round's held-out refill entries in listing order; each entry that is
// a candidate, not in the round's held-out and selected is taken until `size`. No quotas.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isCandidate } from "./fetch.mjs";
import { mulberry32 } from "./split.mjs";

export const EXPERIMENTS = {
  p137: {
    name: "p137",
    seed: 20261119,
    round: 6,
    size: 20,
    rule: "P137 experiment held-out (EXCLUSIONS.md, PROPOSALS P137 amendment 1): never read by a session that changes the skill, converter or runtime, nor by the drafting-arm build session, until a round promotes it; scored only by the P137 two-arm measurement, never as a release point's held-out",
    method:
      "evals/bench/split.mjs --experiment p137 (experiments.mjs drawExperiment): pool = the round-6 walk's fresh entries (fetch.mjs freshPool(templates, 6), round 6's own pool), mulberry32(seed) Fisher-Yates over it sorted by id ascending, then the round's held-out refill entries (heldRefill 6, pool held-refill) in listing order; in that order each entry that is a candidate (fetch.mjs isCandidate), not in round 6's held-out and selected by the rule (experiments.mjs p137Select at convertCommit) is taken until 20; no wake-up quotas; the list keeps that order",
  },
};

export const CONVERT_NOW = "2026-11-14T00:00:00Z"; // convert-coverage.mjs's default --now
export const ANALYZE_NOW = "2026-11-16T00:00:00Z"; // the walk's analyzer --now (fetch.mjs NOW)
const TARGET = /^(no tool map for |no request template for )/;
const LEVERS_OUT = new Set(["vector", "db", "media"]);

// The rule on one converted definition and its analyzer report. -> {selected, blocked: [{step,
// kind, reason, target}], why}
export function p137Select(def, report) {
  const kindOf = new Map((report?.steps ?? []).map((s) => [s.node, s.kind]));
  const blocked = Object.entries(def?.steps ?? {})
    .filter(([, s]) => s.kind === "blocked" && !s.settings?.disabled && s.blocked?.kind !== "dropped")
    .map(([step, s]) => ({ step, kind: s.blocked.kind, reason: s.blocked.reason, target: s.blocked.kind === "no-tool" && TARGET.test(s.blocked.reason ?? "") }));
  const leverStep = (name) => LEVERS_OUT.has(kindOf.get(name));
  let why = null;
  if (!blocked.length) why = "no blocked step";
  else if (blocked.some((b) => !b.target)) why = "a blocked step is not a drafting target";
  if (blocked.some((b) => leverStep(b.step)) || (report?.blockers ?? []).some((b) => (b.nodes ?? []).some(leverStep))) why = "a vector, database or media step is blocked";
  return { selected: !why, blocked, why };
}

// A judge for cached templates, with a skill folder's analyzer and converter (experiment draws
// pass the convertCommit's): (id) -> p137Select's result, or {selected: false, why} when the
// template cannot be converted. Synchronous once made, so a walk can call it per entry.
export async function p137Judge({ skill, dataDir }) {
  const { analyze, unwrap, loadInput } = await import(join(skill, "scripts", "analyze.mjs"));
  const { convertItems, loadReferences } = await import(join(skill, "scripts", "convert.mjs"));
  const refs = loadReferences(join(skill, "references"));
  const ref = (f) => JSON.parse(readFileSync(join(skill, "references", f), "utf8"));
  const opts = { nodes: ref("nodes.json"), capabilities: ref("capabilities.json"), hosts: ref("http-hosts.json"), now: Date.parse(ANALYZE_NOW) };
  return (id) => {
    const file = join(dataDir, `${id}.json`);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const report = analyze(unwrap(raw, String(id)), opts).workflows[0];
    const loaded = loadInput(file);
    if (loaded.fatal) return { selected: false, blocked: [], why: `not loadable: ${loaded.fatal}` };
    let res;
    try {
      res = convertItems(loaded.items, { refs, now: Date.parse(CONVERT_NOW), forceConvert: false })[0];
    } catch (e) {
      return { selected: false, blocked: [], why: `converter crash: ${e.message}` };
    }
    if (!res || res.refused) return { selected: false, blocked: [], why: "refused" };
    return p137Select(res.definition, report);
  };
}

// The draw. `pool`: the round's fresh entries; `after`: its held-out refill entries; `exclude`:
// ids of the round's held-out; `selected`: ids the rule selects. -> {drawn, short}
export function drawExperiment(pool, { seed, size, exclude = new Set(), selected = new Set(), after = [] }) {
  const rnd = mulberry32(seed);
  const order = [...pool].sort((a, b) => a.id - b.id);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  order.push(...[...after].sort((a, b) => a.rank - b.rank));
  const drawn = [];
  for (const e of order) {
    if (drawn.length >= size) break;
    if (!isCandidate(e) || exclude.has(e.id) || !selected.has(e.id)) continue;
    drawn.push(e);
  }
  return { drawn, short: size - drawn.length };
}
