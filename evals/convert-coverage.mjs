#!/usr/bin/env node
// Runs the converter over the template corpus and writes evals/convert-coverage.md: how many
// convert fully, with review steps, with blocked steps, refused, or crash; the top reasons
// for review and blocked steps (the backlog for the Phase 6 loop); tool-map coverage.
//
//   node evals/convert-coverage.mjs [--corpus evals/survey/data/wf] [--out evals/convert-coverage.md] [--now ISO]
//   node evals/convert-coverage.mjs --split dev [--out evals/convert-coverage-dev.md]   (bench dev ids only)
//   node evals/convert-coverage.mjs --ids 2415,4722 --corpus evals/bench/data/wf
//   node evals/convert-coverage.mjs --split dev --per-template after.json --compare before.json [--results-tag <tag>]
//
// --split dev reads the current round's dev ids from evals/bench/splits.json (rolling held-out:
// the seeded dev plus the held-out templates already scored; evals/bench/rounds.mjs) over the
// bench corpus in evals/bench/data/wf. Held-out is refused: it never steers the Phase 6 loop.
// Without --split or --ids (the survey corpus by default), the current round's held-out ids
// are skipped too (PROPOSALS P51: the survey folder held round 2's held-out templates); the
// report gives their count, never their ids. Explicit --ids are run as given (release points).
//
// The corpus is git-ignored (template contents are not committed). Each template is its
// own export. "Default" honours the analyzer's refusal; "forced" converts every template
// with --force-convert, so the step-level backlog covers the whole corpus. No model.
import { readdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { convertItems, loadReferences, validateSchema } from "../skills/n8n-to-claude/scripts/convert.mjs";
import { loadInput } from "../skills/n8n-to-claude/scripts/analyze.mjs";
import { preflight } from "../skills/n8n-to-claude/runtime/src/api.mjs";
import { readSplits, roundOf, withoutHeldOut } from "./bench/rounds.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const split = flag("--split", null);
if (split && split !== "dev") throw new Error(`--split ${split}: only dev is allowed here (held-out never steers)`);
const corpus = resolve(flag("--corpus", join(ROOT, split ? "evals/bench/data/wf" : "evals/survey/data/wf")));
const outFile = resolve(flag("--out", join(ROOT, split ? `evals/convert-coverage-${split}.md` : "evals/convert-coverage.md")));
const idList = split ? roundOf(readSplits()).dev.map((t) => String(t.id)) : flag("--ids", null)?.split(",").map((x) => x.trim());
const wanted = idList ? new Set(idList) : null;
const now = Date.parse(flag("--now", "2026-11-14T00:00:00Z"));
const refs = loadReferences();

// Reasons are grouped with step and node names, quoted values and numbers taken out.
const norm = (r) =>
  String(r)
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\b\d+(\.\d+)?\b/g, "N")
    .replace(/ v N/g, "")
    .trim();

function classify(def) {
  const steps = Object.values(def.steps);
  if (steps.some((s) => s.kind === "blocked" && !s.settings?.disabled)) return "blocked";
  if (steps.some((s) => s.review)) return "review";
  return "full";
}

function tally(map, key, id) {
  const e = map.get(key) ?? { steps: 0, templates: new Set() };
  e.steps++;
  e.templates.add(id);
  map.set(key, e);
}

const modes = { default: { counts: {}, review: new Map(), blocked: new Map(), crashes: [], invalid: [], preflightErrors: new Map() }, forced: { counts: {}, review: new Map(), blocked: new Map(), crashes: [], invalid: [], preflightErrors: new Map() } };
const listed = readdirSync(corpus).filter((f) => f.endsWith(".json") && (!wanted || wanted.has(f.replace(/\.json$/, "")))).sort((a, b) => parseInt(a) - parseInt(b) || a.localeCompare(b));
const listedIds = listed.map((f) => f.replace(/\.json$/, ""));
const { kept, skipped: skippedHeldOut } = args.includes("--ids") ? { kept: listedIds, skipped: [] } : withoutHeldOut(listedIds, readSplits());
const files = kept.map((id) => `${id}.json`);
const fidelity = { tool: {}, http: {} };
for (const f of files) {
  const loaded = loadInput(join(corpus, f));
  if (loaded.fatal) {
    for (const m of Object.values(modes)) m.crashes.push({ id: f, error: loaded.fatal });
    continue;
  }
  for (const [mode, m] of Object.entries(modes)) {
    let results;
    try {
      results = convertItems(loaded.items, { refs, now, forceConvert: mode === "forced" });
    } catch (e) {
      m.crashes.push({ id: f, error: e.message });
      m.counts.crash = (m.counts.crash ?? 0) + 1;
      (m.classOf ??= {})[f.replace(/\.json$/, "")] = { class: "crash" };
      continue;
    }
    for (const res of results) {
      const id = f.replace(/\.json$/, "");
      if (res.refused) {
        m.counts.refused = (m.counts.refused ?? 0) + 1;
        (m.classOf ??= {})[id] = { class: "refused" };
        continue;
      }
      const def = res.definition;
      const errs = validateSchema(def, refs.schema);
      if (errs.length) m.invalid.push({ id, errors: errs.slice(0, 3) });
      const c = classify(def);
      m.counts[c] = (m.counts[c] ?? 0) + 1;
      for (const s of Object.values(def.steps)) {
        if (s.settings?.disabled) continue;
        if (s.kind === "blocked") tally(m.blocked, `${s.blocked.kind}: ${norm(s.blocked.reason)}`, id);
        for (const r of s.reviewReasons ?? []) tally(m.review, norm(r), id);
        if (mode === "forced") {
          if (s.tool) fidelity.tool[s.tool.fidelity] = (fidelity.tool[s.tool.fidelity] ?? 0) + 1;
          if (s.http?.fidelity) fidelity.http[s.http.fidelity] = (fidelity.http[s.http.fidelity] ?? 0) + 1;
        }
      }
      const pfErrors = preflight(def).issues.filter((x) => x.level === "error");
      for (const i of pfErrors) tally(m.preflightErrors, norm(i.message), id);
      if (!pfErrors.length) m.counts.preflightClean = (m.counts.preflightClean ?? 0) + 1;
      (m.classOf ??= {})[id] = { class: c, invalid: errs.length > 0, preflightClean: !pfErrors.length };
      (m.perTemplate ??= {})[id] = { class: c, preflightErrors: pfErrors.length, blockedSteps: Object.values(def.steps).filter((s) => s.kind === "blocked" && !s.settings?.disabled).length, errors: pfErrors.map((i) => ({ ...(i.step ? { step: i.step } : {}), message: i.message })) };
    }
  }
}

// Tool-map coverage.
const ops = [];
for (const [type, byRange] of Object.entries(refs.toolMaps.maps)) for (const [range, byRes] of Object.entries(byRange)) for (const [res, byOp] of Object.entries(byRes)) for (const [op, e] of Object.entries(byOp)) ops.push({ type, range, op: res === "_" ? op : `${res}:${op}`, kind: e.blocked ? "blocked" : e.http ? "http" : "tool", fidelity: e.blocked ? "-" : e.fidelity, translate: !!e.argsNeedTranslation });
const subs = Object.keys(refs.toolMaps.substitutions ?? {});

const top = (map, n = 15) =>
  [...map.entries()]
    .sort((a, b) => b[1].templates.size - a[1].templates.size || b[1].steps - a[1].steps || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([k, v]) => `| ${k.replace(/\|/g, "\\|")} | ${v.templates.size} | ${v.steps} |`);
const count = (m, k) => m.counts[k] ?? 0;

// Round 5 on (PLAN Phase 6): with --split dev, the previous round's dev that is still dev is
// reported as a subset for continuity (round 5: round 4's 100 of the 120).
const curRound = split ? roundOf(readSplits()) : null;
const prevRound = curRound && curRound.round > 1 ? roundOf(readSplits(), curRound.round - 1) : null;
const subsetIds = prevRound ? prevRound.dev.map((t) => String(t.id)).filter((id) => wanted.has(id)) : [];
const subsetCounts = (m) => {
  const c = { of: subsetIds.length, full: 0, review: 0, blocked: 0, refused: 0, crash: 0, invalid: 0, preflightClean: 0 };
  for (const id of subsetIds) {
    const x = m.classOf?.[id];
    if (!x) continue;
    c[x.class]++;
    if (x.invalid) c.invalid++;
    if (x.preflightClean) c.preflightClean++;
  }
  return c;
};

const L = [];
L.push("# Converter coverage on the template corpus", "");
L.push(`Generated by \`node evals/convert-coverage.mjs\` (${new Date(now).toISOString().slice(0, 10)} clock) over ${files.length} templates in \`${corpus.replace(ROOT + "/", "")}\`${split ? ` (split \`${split}\`, round ${roundOf(readSplits()).round})` : wanted ? " (ids given)" : ""} (git-ignored)${skippedHeldOut.length ? `; ${skippedHeldOut.length} template(s) of the current round's held-out skipped (PROPOSALS P51)` : ""}. Converter ${refs.toolMaps.version ? `with tool maps v${refs.toolMaps.version}` : ""}; no model.`, "");
L.push("Classes: **full** (no review flag, no blocked step), **review** (some step is flagged, none blocked), **blocked** (some step greyed out), **refused** (analyzer outcome is not `subscription`; report only), **crash**.", "");
L.push("| Mode | full | review | blocked | refused | crash | schema-invalid | preflight clean |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const [mode, m] of Object.entries(modes)) L.push(`| ${mode} | ${count(m, "full")} | ${count(m, "review")} | ${count(m, "blocked")} | ${count(m, "refused")} | ${m.crashes.length} | ${m.invalid.length} | ${count(m, "preflightClean")} |`);
if (prevRound) for (const [mode, m] of Object.entries(modes)) {
  const c = subsetCounts(m);
  L.push(`| ${mode}, round ${prevRound.round}'s ${c.of} (subset) | ${c.full} | ${c.review} | ${c.blocked} | ${c.refused} | ${c.crash} | ${c.invalid} | ${c.preflightClean} |`);
}
L.push("");
for (const [mode, m] of Object.entries(modes)) {
  L.push(`## ${mode === "default" ? "Default (refusals honoured)" : "Forced (every template converted)"}`, "");
  L.push("Top reasons for blocked steps:", "", "| Reason | Templates | Steps |", "| --- | --- | --- |", ...top(m.blocked), "");
  L.push("Top reasons for review flags:", "", "| Reason | Templates | Steps |", "| --- | --- | --- |", ...top(m.review), "");
  L.push("Top preflight errors (what stops a run before any effect):", "", "| Error | Templates | Steps |", "| --- | --- | --- |", ...top(m.preflightErrors, 10), "");
  if (m.crashes.length) L.push("Crashes:", "", ...m.crashes.map((c) => `- ${c.id}: ${c.error}`), "");
  if (m.invalid.length) L.push("Schema-invalid definitions:", "", ...m.invalid.map((c) => `- ${c.id}: ${c.errors.join("; ")}`), "");
}
L.push("## Tool maps", "");
const byKind = ops.reduce((a, o) => ((a[o.kind] = (a[o.kind] ?? 0) + 1), a), {});
const byFid = ops.filter((o) => o.kind !== "blocked").reduce((a, o) => ((a[o.fidelity] = (a[o.fidelity] ?? 0) + 1), a), {});
L.push(`${ops.length} operation entries in \`references/tool-maps.json\`: ${byKind.tool ?? 0} connector tools, ${byKind.http ?? 0} REST request templates, ${byKind.blocked ?? 0} explained no-tool blocks; ${subs.length} substitutions (${subs.join(", ")}). Fidelity of the mapped ones: ${Object.entries(byFid).map(([k, v]) => `${k} ${v}`).join(", ")}. ${ops.filter((o) => o.translate).length} connector entries need their arguments translated by the skill (Notion property formats).`, "");
L.push(`Steps in the forced run by fidelity: tools ${Object.entries(fidelity.tool).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}; REST templates ${Object.entries(fidelity.http).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}.`, "");
L.push("No connector output shape was captured (the schemas are input schemas), so every adapter that reads a tool's output is `unverified` until the bench's emulation check runs it against real output. REST templates are `exact` where n8n returns the API's own response body.", "");
writeFileSync(outFile, L.join("\n") + "\n");
// --per-template <file>: class, preflight errors and blocked steps per template, for the loop's regression check.
const perFile = flag("--per-template", null);
if (perFile) writeFileSync(resolve(perFile), JSON.stringify(Object.fromEntries(Object.entries(modes).map(([k, m]) => [k, m.perTemplate ?? {}])), null, 1) + "\n");
console.log(JSON.stringify(Object.fromEntries(Object.entries(modes).map(([k, m]) => [k, { ...m.counts, crashes: m.crashes.length, invalid: m.invalid.length, of: files.length, ...(prevRound ? { subset: { round: prevRound.round, ...subsetCounts(m) } } : {}) }]))));
// --compare <before per-template file> [--results-tag <tag>]: the loop's coverage rule
// (evals/coverage-diff.mjs, PROPOSALS P32) on the default mode, against the bench's last rows
// in evals/results.jsonl (or one tag's): a new preflight error on a step the runtime refused
// when it ran is "moved earlier", not a regression. Exits 1 on a regression.
const compareFile = flag("--compare", null);
if (compareFile) {
  const { coverageDiff, runTimeRefusals } = await import("./coverage-diff.mjs");
  const rowsFile = join(ROOT, "evals", "results.jsonl");
  const after = modes.default.perTemplate ?? {};
  // Only the rows of the templates compared (dev, with --split dev).
  const rows = readFileSync(rowsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => String(r.template) in after);
  const before = JSON.parse(readFileSync(resolve(compareFile), "utf8")).default;
  const d = coverageDiff(before, after, runTimeRefusals(rows, { tag: flag("--results-tag", null) }));
  console.log(JSON.stringify({ regressions: d.regressions, movedEarlier: d.movedEarlier, preflightClean: d.preflightClean }, null, 1));
  if (d.regressions.length) process.exitCode = 1;
}
