// The Phase 6 coverage rule as code (PLAN Phase 6, rule e; PROPOSALS P32): compares two
// `convert-coverage.mjs --per-template` files and says which templates regressed.
//
// A regression is a template that gains a blocked step, gains a refused step, or loses its
// preflight-clean status. Errors are compared as refused steps, not message text (PROPOSALS
// P39): each error is keyed by its step (the n8n node name; an error without a step by its
// path) and its kind (refusalKind(): the step cannot run, the allowlist, required arguments,
// an agent tool that cannot be carried, a secret without hosts, ...). A step refused before
// and refused now for a reworded reason of the same kind (blocked, then a URL built at run
// time) is the same refusal; a key that appears more often than before is a regression. One exception: a new step-level preflight error counts as **moved
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

// PROPOSALS P39: what kind of refusal a preflight error is, from api.mjs preflight's wording.
export function refusalKind(message) {
  const m = String(message ?? "");
  const tool = /agent tool "(.+?)" cannot be carried/.exec(m);
  if (tool) return `agent tool ${tool[1]}`;
  if (/not in allow\.tools|is not available/.test(m)) return "allowlist";
  if (/lacks required arguments/.test(m)) return "arguments";
  if (/^secret "|names no host/.test(m)) return "secret";
  if (/source hash/.test(m)) return "source";
  if (/^blocked:|not implemented|URL built at run time|not converted yet|need translation|Python|sub-workflow is not in the definition|without a connected chat model|without (agent|model)\.prompt|without tool\.connector/.test(m)) return "step refused";
  return `other: ${m.replace(/"[^"]*"/g, '"…"').replace(/\d+/g, "N").slice(0, 120)}`;
}

// The step an error is about: its `step`, else the step its message names (a per-template file
// written before preflight put `step` on a run-time URL error: `step "X": …`, `agent tool "X": …`).
const stepOf = (e) => e.step ?? /^(?:step|agent tool) "(.+?)": /.exec(String(e.message ?? ""))?.[1] ?? null;
const errKey = (e) => `${stepOf(e) ?? e.path ?? ""}\u0000${refusalKind(e.message)}`;

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
    // A key whose count rises: the first `before` occurrences of it are not new.
    const left = new Map();
    for (const e of b.errors) left.set(errKey(e), (left.get(errKey(e)) ?? 0) + 1);
    const fresh = a.errors.filter((e) => {
      const k = errKey(e);
      const n = left.get(k) ?? 0;
      if (n > 0) return left.set(k, n - 1), false;
      return true;
    });
    const refused = refusals[id] ?? new Set();
    const moved = fresh.filter((e) => stepOf(e) && refused.has(stepOf(e)));
    const worse = fresh.filter((e) => !moved.includes(e));
    for (const e of moved) movedEarlier.push({ id, step: stepOf(e), message: e.message });
    if (worse.length) regressions.push({ id, kind: "preflight error", detail: worse.map((e) => (e.step ? `${e.step}: ${e.message}` : e.message)) });
    const cleanNow = a.preflightErrors === 0 || (b.preflightErrors === 0 && !worse.length && a.errors.every((e) => moved.includes(e)));
    if (b.preflightErrors === 0 && !cleanNow) regressions.push({ id, kind: "preflight clean lost" });
    if (cleanNow) cleanAfterMoved++;
  }
  return { regressions, movedEarlier, preflightClean: { before: cleanBefore, after: cleanAfter, afterWithMovedEarlier: cleanAfterMoved } };
}
