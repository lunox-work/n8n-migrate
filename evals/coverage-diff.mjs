// The Phase 6 coverage rule as code (PLAN Phase 6, rule e; PROPOSALS P32): compares two
// `convert-coverage.mjs --per-template` files and says which templates regressed.
//
// A regression is a template that gains a blocked step, gains a preflight error, or loses its
// preflight-clean status. One exception: a new step-level preflight error counts as **moved
// earlier**, not as a regression, when the bench had refused that same step at run time
// before (its last row stopped at gate 3 with `step <name>: … is not supported by the runtime`
// or another refusal of the runtime). Such a step failed either way; saying no before the run
// is the better behaviour, so a converter that does it must not read as a loss. A template
// whose only new errors are moved earlier keeps its place in the preflight-clean count.
//
// Pure: the caller passes the per-template maps and the bench rows (evals/results.jsonl).

import { failedStep } from "./bench/gates.mjs";

const REFUSAL = /is not supported by the runtime|not implemented|unsupported/i;

// {templateId: Set(step names the runtime refused when the step ran)} from the last row per
// template (rows in file order; `tag` limits them to one bench run).
export function runTimeRefusals(rows, { tag = null } = {}) {
  const last = new Map();
  for (const r of rows) if (r && r.template != null && (!tag || r.tag === tag)) last.set(String(r.template), r);
  const out = {};
  for (const [id, r] of last) {
    if (r.gate !== 3 || !r.cause || /^preflight/.test(r.cause) || !REFUSAL.test(r.cause)) continue;
    const step = failedStep({ cause: r.cause, detail: r.detail });
    if (step) (out[id] ??= new Set()).add(step);
  }
  return out;
}

const errKey = (e) => `${e.step ?? ""}\u0000${e.message}`;

// before, after: one mode of a --per-template file ({id: {class, preflightErrors, blockedSteps,
// errors: [{step?, message}]}}). refusals: runTimeRefusals(). Returns {regressions,
// movedEarlier, preflightClean: {before, after, afterWithMovedEarlier}}.
export function coverageDiff(before, after, refusals = {}) {
  const regressions = [];
  const movedEarlier = [];
  let cleanBefore = 0;
  let cleanAfter = 0;
  let cleanAfterMoved = 0;
  for (const id of Object.keys(after)) {
    const a = after[id];
    const b = before[id];
    if (a.preflightErrors === 0) cleanAfter++;
    if (!b) {
      if (a.preflightErrors === 0) cleanAfterMoved++;
      continue;
    }
    if (b.preflightErrors === 0) cleanBefore++;
    if (!Array.isArray(a.errors) || !Array.isArray(b.errors)) throw new Error(`template ${id}: the per-template file has no error list; regenerate it with this convert-coverage.mjs`);
    if (a.blockedSteps > b.blockedSteps) regressions.push({ id, kind: "blocked step", detail: `${b.blockedSteps} -> ${a.blockedSteps}` });
    const had = new Set(b.errors.map(errKey));
    const fresh = a.errors.filter((e) => !had.has(errKey(e)));
    const refused = refusals[id] ?? new Set();
    const moved = fresh.filter((e) => e.step && refused.has(e.step));
    const worse = fresh.filter((e) => !moved.includes(e));
    for (const e of moved) movedEarlier.push({ id, step: e.step, message: e.message });
    if (worse.length) regressions.push({ id, kind: "preflight error", detail: worse.map((e) => (e.step ? `${e.step}: ${e.message}` : e.message)) });
    const cleanNow = a.preflightErrors === 0 || (b.preflightErrors === 0 && !worse.length && a.errors.every((e) => moved.includes(e)));
    if (b.preflightErrors === 0 && !cleanNow) regressions.push({ id, kind: "preflight clean lost" });
    if (cleanNow) cleanAfterMoved++;
  }
  return { regressions, movedEarlier, preflightClean: { before: cleanBefore, after: cleanAfter, afterWithMovedEarlier: cleanAfterMoved } };
}
