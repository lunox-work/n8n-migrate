#!/usr/bin/env node
// Reruns the differential test over every corpus and rewrites the numbers in REPORT.md.
//
//   node evals/diff/run-all.mjs [--corpus templates,siblings,generated] [--seed 1,2,3] [--count 200]
//        [--tag before]   (summary-<corpus>.<tag>.json; with DIFF_RUNTIME_SRC for another runner)
//        [--only <label substring>] [--no-report] [--order v0|v1] [--order-check]
//
// --order-check: n8n against itself, v0 against v1, for the corpus workflows that have no
// executionOrder (summary in .work/order-<corpus>.json).
//
// Corpora: templates = evals/survey/data/wf/*.json (git-ignored download, unwrapped);
// siblings = ../n8n-*/workflows/*.json (the author's repos, this one excluded);
// generated = gen.mjs --seed --count. One workflow at a time against the bench container
// (started if needed; free memory is checked every 10 workflows and the run pauses below
// 30%). Per-run logs and reports: evals/diff/.work/<corpus>/<label>/. Summary:
// evals/diff/.work/summary-<corpus>.json. REPORT.md: the block between the
// `numbers:start` / `numbers:end` markers is regenerated from the summaries.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { differential, DIFF_WORK, prepare, compare, decycle } from "./differential.mjs";
import { runWorkflow } from "../n8n/run-workflow.mjs";
import { generate } from "./gen.mjs";
import { up, waitForMemory, memStats, memoryFree, waitHealthy } from "../n8n/container.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const PUBLIC = resolve(ROOT, "..");

export function loadCorpus(name, { seed = 1, count = 200 } = {}) {
  if (name === "templates") {
    const dir = join(ROOT, "evals/survey/data/wf");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".json")).sort((a, b) => parseInt(a) - parseInt(b)).map((f) => ({ label: `t${basename(f, ".json")}`, raw: JSON.parse(readFileSync(join(dir, f), "utf8")) }));
  }
  if (name === "siblings") {
    const out = [];
    for (const repo of readdirSync(PUBLIC).filter((d) => d.startsWith("n8n-") && d !== "n8n-migrate").sort()) {
      const dir = join(PUBLIC, repo, "workflows");
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) out.push({ label: `${repo.slice(4)}__${basename(f, ".json")}`, raw: JSON.parse(readFileSync(join(dir, f), "utf8")) });
    }
    return out;
  }
  if (name === "generated") return String(seed).split(",").flatMap((sd) => generate({ seed: Number(sd), count })).map((g) => ({ label: g.label, raw: g.workflow, fixtures: g.fixtures }));
  throw new Error(`unknown corpus ${name}`);
}

function tally(results) {
  const t = { total: results.length, qualified: 0, same: 0, diff: 0, skip: {}, classes: {}, unsupported: {} };
  for (const r of results) {
    if (!r.qualified) {
      const k = r.verdict === "skip:preflight" ? `preflight: ${shortReason(r.reason)}` : r.verdict.slice(5);
      t.skip[k] = (t.skip[k] ?? 0) + 1;
      continue;
    }
    t.qualified++;
    if (r.verdict === "same") t.same++;
    else if (r.verdict === "unsupported") t.unsupported = { ...(t.unsupported ?? {}), [shortReason(r.reason)]: (t.unsupported?.[shortReason(r.reason)] ?? 0) + 1 };
    else {
      t.diff++;
      for (const c of r.classes ?? []) t.classes[c] = (t.classes[c] ?? 0) + 1;
    }
  }
  return t;
}

function shortReason(reason = "") {
  const first = reason.split("; ")[0];
  return first.replace(/^not implemented: /, "not implemented: ").replace(/"[^"]*"/g, '"…"').slice(0, 90);
}

export async function runCorpus(name, opts = {}) {
  const list = loadCorpus(name, opts).filter((w) => !opts.only || w.label.includes(opts.only));
  const results = [];
  let peak = 0;
  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    if (i % 10 === 0) {
      await waitForMemory(30);
      const m = memStats();
      if (m.mib) peak = Math.max(peak, m.mib);
    }
    let rep;
    try {
      await waitHealthy(60_000).catch(async () => up());
      rep = await differential(w.raw, { label: w.label, fixtures: w.fixtures, order: opts.order, outDir: join(DIFF_WORK, name, w.label) });
    } catch (e) {
      rep = { label: w.label, verdict: "skip:harness-error", qualified: false, reason: String(e.message).slice(0, 300) };
    }
    results.push({ label: w.label, verdict: rep.verdict, qualified: rep.qualified, classes: rep.classes, reason: rep.reason, timeNormalised: rep.timeNormalised });
    console.error(`[${name} ${i + 1}/${list.length}] ${w.label}: ${rep.verdict}${rep.reason ? ` (${String(rep.reason).slice(0, 120)})` : ""}`);
  }
  const m = memStats();
  if (m.mib) peak = Math.max(peak, m.mib);
  const summary = { corpus: name, at: new Date().toISOString(), ...(name === "generated" ? { seed: opts.seed, count: opts.count } : {}), tally: tally(results), peakMiB: Math.round(peak), results };
  if (!opts.only) writeFileSync(join(DIFF_WORK, `summary-${name}${opts.tag ? `.${opts.tag}` : ""}.json`), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

// ---------- execution order: n8n v0 against n8n v1 ----------

// For every corpus workflow whose export has no executionOrder (n8n's engine then runs the
// legacy v0 order; the editor saves v1), run it in n8n twice, v0 and v1, same pins, and
// compare the two n8n runs with the differential's comparison.
export async function orderCheck(name, opts = {}) {
  const list = loadCorpus(name, opts).filter((w) => !opts.only || w.label.includes(opts.only));
  const results = [];
  for (const [i, w] of list.entries()) {
    const wf0 = w.raw.workflow?.workflow ?? w.raw.workflow ?? w.raw;
    if (wf0.settings?.executionOrder) continue;
    if (i % 10 === 0) await waitForMemory(30);
    const runs = {};
    let skip;
    for (const order of ["v0", "v1"]) {
      const prep = prepare(w.raw, { order });
      if (prep.skip) {
        skip = prep.skip;
        break;
      }
      const pins = Object.fromEntries(Object.entries(prep.pinData).filter(([k]) => k !== prep.triggerName));
      try {
        const r = await runWorkflow({ ...prep.wf, pinData: pins }, { trigger: { items: prep.pinData[prep.triggerName] }, mock: w.fixtures ?? { default: { status: 200, body: { ok: true, id: "mock-1", data: [{ id: 1, name: "one" }, { id: 2, name: "two" }] } } }, keepPin: true, timeoutS: 60, triggerNode: prep.triggerName });
        r.executionData = decycle(r.executionData);
        runs[order] = r;
      } catch (e) {
        skip = `n8n: ${String(e.message).slice(0, 120)}`;
        break;
      }
    }
    let verdict;
    if (skip) verdict = `skip:${skip}`;
    else {
      const b = runs.v1;
      const asOurs = { status: b.status === "success" ? "done" : "failed", error: b.error ?? null, lastNodeExecuted: b.lastNode, runData: b.executionData?.runData ?? {} };
      const c = compare(runs.v0, asOurs, runs.v0.effects, b.effects);
      verdict = c.verdict;
      if (c.diffs.length) results.push({ label: w.label, verdict, diffs: c.diffs.slice(0, 4) });
    }
    if (!results.some((r) => r.label === w.label)) results.push({ label: w.label, verdict });
    console.error(`[order ${name}] ${w.label}: ${verdict}`);
  }
  const t = { total: results.length, same: results.filter((r) => r.verdict === "same").length, diff: results.filter((r) => r.verdict.startsWith("diff")).length, skip: results.filter((r) => r.verdict.startsWith("skip")).length };
  const summary = { corpus: name, at: new Date().toISOString(), tally: t, results };
  writeFileSync(join(DIFF_WORK, `order-${name}.json`), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

// ---------- REPORT.md numbers ----------

function fmtTally(name, s) {
  const t = s.tally;
  const unsup = Object.values(t.unsupported ?? {}).reduce((a, b) => a + b, 0);
  const lines = [`**${name}**${s.seed !== undefined ? ` (seed ${s.seed}, count ${s.count})` : ""}: ${t.total} workflows, ${t.qualified} qualified, ${t.same} same, ${t.diff} diff${unsup ? `, ${unsup} stop at a runner-unsupported operation (${Object.entries(t.unsupported).map(([k, v]) => `${k}: ${v}`).join("; ")})` : ""}.`];
  const cls = Object.entries(t.classes).sort((a, b) => b[1] - a[1]);
  if (cls.length) lines.push(`Diff classes: ${cls.map(([k, v]) => `${k} ${v}`).join(", ")}.`);
  const sk = Object.entries(t.skip).sort((a, b) => b[1] - a[1]);
  if (sk.length) lines.push(`Not qualified: ${sk.map(([k, v]) => `${k} (${v})`).join("; ")}.`);
  return lines.join(" ");
}

export function rewriteReport(summaries) {
  const path = join(HERE, "REPORT.md");
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  const start = "<!-- numbers:start -->";
  const end = "<!-- numbers:end -->";
  if (!text.includes(start) || !text.includes(end)) return;
  const peak = Math.max(0, ...summaries.map((s) => s.peakMiB ?? 0));
  const before = (c) => {
    const p = join(DIFF_WORK, `summary-${c}.before.json`);
    if (!existsSync(p)) return "";
    const t = JSON.parse(readFileSync(p, "utf8")).tally;
    const cls = Object.entries(t.classes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ");
    return ` Before the fixes (runner at the harness commit, same corpus): ${t.qualified} qualified, ${t.same} same, ${t.diff} diff${cls ? ` (${cls})` : ""}.`;
  };
  const body = [`Last run ${summaries.map((s) => s.at).sort().pop()?.slice(0, 10)} UTC (\`node evals/diff/run-all.mjs\`), container peak ${peak} MiB.`, "", ...summaries.map((s) => `- ${fmtTally(s.corpus, s)}${before(s.corpus)}`)].join("\n");
  writeFileSync(path, text.replace(new RegExp(`${start}[\\s\\S]*?${end}`), `${start}\n${body}\n${end}`));
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const corpora = flag("--corpus", "templates,siblings,generated").split(",");
  const opts = { seed: flag("--seed", "1,2,3"), count: Number(flag("--count", 200)), only: flag("--only"), order: flag("--order"), tag: flag("--tag") };
  mkdirSync(DIFF_WORK, { recursive: true });
  console.error(`memory free ${memoryFree()}%`);
  await up();
  if (args.includes("--order-check")) {
    for (const c of corpora.filter((c) => c !== "generated")) console.error(`${c}: ${JSON.stringify((await orderCheck(c, opts)).tally)}`);
    return;
  }
  const done = [];
  for (const c of corpora) {
    const s = await runCorpus(c, opts);
    done.push(s);
    console.error(`${c}: ${JSON.stringify(s.tally)}`);
  }
  if (!args.includes("--no-report") && !opts.only) {
    const all = ["templates", "siblings", "generated"].map((c) => join(DIFF_WORK, `summary-${c}.json`)).filter(existsSync).map((p) => JSON.parse(readFileSync(p, "utf8")));
    rewriteReport(all);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
