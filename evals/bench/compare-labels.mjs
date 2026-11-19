#!/usr/bin/env node
// Compares labels.json with the analyzer (default answers, one template per run, the
// corpus's --now). Prints one row per template and the agreement counts as JSON.
//
//   node evals/bench/compare-labels.mjs [--json] [--labels evals/bench/labels-held3.json]
//
// --labels: another labels file (a round's held-out labels: labels-held3.json, labels-held4.json,
// labels-held5.json, labels-held6.json, or the P137 experiment's labels-p137.json; EXCLUSIONS.md: not for
// fixing sessions while that set is held out).
// summary.mjs reads labels.json only.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, unwrap } from "../../skills/n8n-migrate/scripts/analyze.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REFS = join(HERE, "..", "..", "skills", "n8n-migrate", "references");
const refs = (f) => JSON.parse(readFileSync(join(REFS, f), "utf8"));
const opts = { nodes: refs("nodes.json"), capabilities: refs("capabilities.json"), hosts: refs("http-hosts.json"), now: Date.parse("2026-11-16T00:00:00Z") };
const labelsArg = process.argv.includes("--labels") ? process.argv[process.argv.indexOf("--labels") + 1] : join(HERE, "labels.json");
const labels = JSON.parse(readFileSync(labelsArg, "utf8")).labels;

const kindOf = (qid) => qid.split("/")[1];
const rows = [];
for (const l of labels) {
  const raw = JSON.parse(readFileSync(join(HERE, "data", "wf", `${l.id}.json`), "utf8"));
  const w = analyze(unwrap(raw, String(l.id)), opts).workflows[0];
  const blockers = [...new Set(w.blockers.map((b) => b.kind))].sort();
  const asked = [...new Set(w.questions.map((q) => kindOf(q.id)))].sort();
  const missing = l.questions.filter((k) => !asked.includes(k));
  const extra = asked.filter((k) => !l.questions.includes(k) && !l.mayAsk.includes(k));
  rows.push({
    id: l.id,
    label: `${l.outcome}${l.target ? ":" + l.target : ""}`,
    analyzer: `${w.outcome.kind}${w.outcome.target ? ":" + w.outcome.target : ""}${w.setupOnly ? " setupOnly" : ""}`,
    outcome: l.outcome === w.outcome.kind,
    target: l.outcome === w.outcome.kind && l.target === w.outcome.target,
    wakeup: l.wakeup === w.wakeup.kind ? true : `${l.wakeup}≠${w.wakeup.kind}`,
    blockers: JSON.stringify([...l.blockers].sort()) === JSON.stringify(blockers) ? true : `${l.blockers.join(",") || "-"} vs ${blockers.join(",") || "-"}`,
    questions: !missing.length && !extra.length ? true : `missing ${missing.join(",") || "-"}; extra ${extra.join(",") || "-"}`,
    reason: w.outcome.reason,
    blockerReasons: w.blockers.map((b) => `${b.kind}: ${b.reason}`),
    setupOnlyReason: w.setupOnlyReason,
  });
}
const n = (f) => rows.filter(f).length;
const summary = { templates: rows.length, outcome: n((r) => r.outcome), outcomeAndTarget: n((r) => r.target), wakeup: n((r) => r.wakeup === true), blockers: n((r) => r.blockers === true), questions: n((r) => r.questions === true), all: n((r) => r.target && r.wakeup === true && r.blockers === true && r.questions === true) };
if (process.argv.includes("--json")) console.log(JSON.stringify({ summary, rows }, null, 2));
else {
  for (const r of rows) console.log(`${r.id}\t${r.label}\t${r.analyzer}\t${r.target ? "=" : "≠"}\twakeup ${r.wakeup}\tblockers ${r.blockers}\tquestions ${r.questions}`);
  console.log(JSON.stringify(summary));
}
