#!/usr/bin/env node
// Prints evals/task-driver/results.jsonl as Markdown rows for MEASUREMENTS.md.
//   node evals/task-driver/summarize.mjs [--prefix m-]
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const a = process.argv.slice(2);
const prefix = a.includes("--prefix") ? a[a.indexOf("--prefix") + 1] : "";
const rows = readFileSync(join(HERE, "results.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.label.startsWith(prefix));

const k = (n) => (n == null ? "" : n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n));
console.log("| Label | Model | N | Hooks | Run | Slack args exact | Field diffs | Transcription diffs / leaves | Hook denies | Turns | Out tokens | Cache read | Cost USD | Wall s |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const r of rows) {
  const f = r.fidelity ?? {};
  const w = f.writes ?? [];
  const fieldDiffs = w.reduce((n, x) => n + (x.missing ? 1 : x.fields.length), 0);
  const lines = w.reduce((n, x) => n + (x.lineDiffs ?? 0), 0);
  const t = (f.transcription ?? []).find((x) => x.id.startsWith("Get unread mail"));
  console.log(
    `| ${r.label} | ${r.model} | ${r.n ?? ""} | ${r.hooks ? "on" : "off"} | ${r.runStatus}${r.killedFor ? ` (${r.killedFor})` : ""} | ${w.length ? (f.exact ? "yes" : "no") : "-"} | ${w.length ? `${fieldDiffs}${lines ? ` (${lines} lines)` : ""}` : "-"} | ${t ? `${t.diffs ?? "-"} / ${t.leaves}` : "-"} | ${r.hookDenies?.length ?? 0} | ${r.turns ?? ""} | ${k(r.usage?.output)} | ${k(r.usage?.cacheRead)} | ${r.costUsd != null ? r.costUsd.toFixed(4) : ""} | ${(r.wallMs / 1000).toFixed(0)} |`,
  );
}
