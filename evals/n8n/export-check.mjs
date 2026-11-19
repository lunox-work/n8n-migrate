#!/usr/bin/env node
// Real bulk export check (PLAN Phase 1 "done when"): import the author's 11
// sibling workflows and a fixed set of corpus templates into the bench's n8n
// through its CLI, export them in every shape n8n offers, run the analyzer on
// each, and diff every workflow's report against the report for the original
// file. Any difference is an analyzer bug. Nothing is executed.
//
//   node evals/n8n/export-check.mjs [--keep] [--no-fresh] [--json out.json]
//
// Needs evals/survey/data/wf/ (git-ignored; `node evals/fetch-survey.mjs`) and
// the three sibling repos next to this one. Output files go to
// <work>/export-check/ (git-ignored). Exit 1 on a crash, an unmapped node, or a diff.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { up, exec, copyIn, copyOut, n8nCli, docker, WORK, IMAGE, NAME, down } from "./container.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const ANALYZE = join(ROOT, "skills/n8n-migrate/scripts/analyze.mjs");
const CORPUS = join(ROOT, "evals/survey/data/wf");
const SIBLINGS = ["n8n-hvac-runtime-reminders", "n8n-job-leases", "n8n-telegram-class-booking"].map((r) => join(ROOT, "..", r, "workflows"));
const NOW = "2026-11-16T00:00:00Z";

// Two to four per wake-up kind, chosen for variety: credentials, pinData,
// disabled nodes, sub-workflow calls, tags/meta/settings/active, 3 to 100 nodes.
export const CORPUS_IDS = [
  // manual
  1073, 2315, 2557, 585,
  // endpoint
  2431, 1435,
  // schedule
  1534, 2324, 5338, 4352,
  // relay
  2035, 2466, 4110,
  // poll
  2178, 2320,
  // chat
  2006, 2777, 3135, 2982,
  // form
  3066, 2878,
  // sub-workflow
  2567, 2786,
  // mcp server
  3514,
];

const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);

function analyze(input, out) {
  const r = spawnSync(process.execPath, [ANALYZE, input, "--json", "--now", NOW, "--out", out], { encoding: "utf8" });
  return { status: r.status, stderr: r.stderr.trim(), report: r.status === 0 ? JSON.parse(readFileSync(out, "utf8")) : null };
}

// A workflow's report with the fields that name the file or the workflow id
// removed. Ids legitimately change on import (a template's id is its listing
// id, n8n assigns a new one), so ids in calls, calledBy, sharedWith and the
// question-id prefix become workflow names.
function normalise(w, idToName) {
  const { id, file, sourceHash, ...rest } = w;
  const name = (x) => (x === id ? "<self>" : idToName.get(x) ?? x);
  return JSON.parse(
    JSON.stringify({
      ...rest,
      calls: w.calls.map((c) => ({ ...c, target: c.target == null ? c.target : name(c.target) })),
      calledBy: w.calledBy.map(name).sort(),
      sharedState: w.sharedState.map((s) => ({ ...s, sharedWith: s.sharedWith.map(name).sort() })),
      questions: w.questions.map((q) => ({ ...q, id: q.id.startsWith(`${id}/`) ? `<self>${q.id.slice(id.length)}` : q.id })),
    }),
  );
}

function diffPaths(a, b, p = "", out = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], p ? `${p}.${k}` : k, out);
    return out;
  }
  out.push({ path: p, source: a, export: b });
  return out;
}

const keysOf = (o) => Object.keys(o ?? {}).sort();

function main() {
  if (!existsSync(CORPUS)) throw new Error(`no corpus at ${CORPUS}; run node evals/fetch-survey.mjs first`);
  const dir = join(WORK, "export-check");
  rmSync(dir, { recursive: true, force: true });
  const src = join(dir, "source"); // originals, as published
  const imp = join(dir, "import"); // what n8n import:workflow gets
  mkdirSync(src, { recursive: true });
  mkdirSync(imp, { recursive: true });

  // Inputs. Templates are unwrapped from the API's {workflow:{workflow}} shape
  // and named after the template, as a person pasting one into n8n would get.
  const inputs = [];
  for (const id of CORPUS_IDS) {
    const raw = JSON.parse(readFileSync(join(CORPUS, `${id}.json`), "utf8"));
    cpSync(join(CORPUS, `${id}.json`), join(src, `tpl-${id}.json`));
    const wf = { ...raw.workflow.workflow, name: raw.workflow.name };
    writeFileSync(join(imp, `tpl-${id}.json`), JSON.stringify(wf));
    inputs.push({ source: `tpl-${id}`, name: wf.name });
  }
  for (const d of SIBLINGS) {
    for (const f of readdirSync(d).filter((x) => x.endsWith(".json")).sort()) {
      const tag = `sib-${basename(dirname(d)).replace(/^n8n-/, "")}-${f.slice(0, -5)}`;
      cpSync(join(d, f), join(src, `${tag}.json`));
      cpSync(join(d, f), join(imp, `${tag}.json`));
      inputs.push({ source: tag, name: JSON.parse(readFileSync(join(d, f), "utf8")).name });
    }
  }
  const names = inputs.map((i) => i.name);
  if (new Set(names).size !== names.length) throw new Error("duplicate workflow names in the inputs; the diff matches by name");

  // Import and export inside the container.
  docker(["exec", "-u", "root", NAME, "rm", "-rf", "/tmp/xc"]); // docker cp leaves root-owned files
  exec(["mkdir", "-p", "/tmp/xc"]);
  copyIn(imp, "/tmp/xc/import");
  const steps = {};
  const cli = (label, a) => {
    const r = n8nCli(a);
    steps[label] = { args: a.join(" "), status: r.status, ms: r.ms, out: (r.stdout + r.stderr).split("\n").filter((l) => /import|export|success|error|warn/i.test(l)).slice(-6) };
    if (r.status !== 0) throw new Error(`n8n ${a.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  };
  cli("import", ["import:workflow", "--separate", "--input=/tmp/xc/import"]);
  cli("exportAll", ["export:workflow", "--all", "--output=/tmp/xc/all.json"]);
  cli("exportBackup", ["export:workflow", "--backup", "--output=/tmp/xc/backup/"]);
  cli("exportSeparate", ["export:workflow", "--all", "--separate", "--output=/tmp/xc/separate/"]);
  const version = exec(["n8n", "--version"]).stdout.trim();
  copyOut("/tmp/xc/all.json", join(dir, "all.json"));
  copyOut("/tmp/xc/backup", join(dir, "backup"));
  copyOut("/tmp/xc/separate", join(dir, "separate"));

  // Shapes.
  const all = JSON.parse(readFileSync(join(dir, "all.json"), "utf8"));
  const sepFiles = readdirSync(join(dir, "separate"));
  const backupFiles = readdirSync(join(dir, "backup"));
  const sample = all.find((w) => names.includes(w.name)) ?? all[0];
  const shapes = {
    all: { type: Array.isArray(all) ? "array" : typeof all, count: all.length, workflowKeys: keysOf(sample) },
    separate: { files: sepFiles.length, fileName: sepFiles[0], workflowKeys: keysOf(JSON.parse(readFileSync(join(dir, "separate", sepFiles[0]), "utf8"))) },
    backup: { files: backupFiles.length, fileName: backupFiles[0], pretty: readFileSync(join(dir, "backup", backupFiles[0]), "utf8").includes("\n  ") },
    nodeKeys: keysOf(sample?.nodes?.[0]),
  };

  // What changed between each input and its export, field by field.
  const byName = new Map(all.map((w) => [w.name, w]));
  const changes = {};
  const note = (k, src) => ((changes[k] ??= new Set()).add(src));
  for (const i of inputs) {
    const orig = JSON.parse(readFileSync(join(imp, `${i.source}.json`), "utf8"));
    const exp = byName.get(i.name);
    if (!exp) {
      note("missing from export", i.source);
      continue;
    }
    for (const k of new Set([...keysOf(orig), ...keysOf(exp)])) {
      if (k === "nodes") continue;
      if (!(k in orig)) note(`added: ${k}`, i.source);
      else if (!(k in exp)) note(`dropped: ${k}`, i.source);
      else if (JSON.stringify(orig[k]) !== JSON.stringify(exp[k])) note(`changed: ${k}`, i.source);
    }
    const en = new Map((exp.nodes ?? []).map((n) => [n.name, n]));
    for (const n of orig.nodes ?? []) {
      const e = en.get(n.name);
      if (!e) {
        note("node dropped", i.source);
        continue;
      }
      for (const k of new Set([...keysOf(n), ...keysOf(e)])) {
        if (!(k in n)) note(`node added: ${k}`, i.source);
        else if (!(k in e)) note(`node dropped: ${k}`, i.source);
        else if (JSON.stringify(n[k]) !== JSON.stringify(e[k])) note(`node changed: ${k}`, i.source);
      }
    }
  }

  // Analyzer on the originals and on each export shape.
  const runs = {
    source: analyze(src, join(dir, "report-source.json")),
    all: analyze(join(dir, "all.json"), join(dir, "report-all.json")),
    backup: analyze(join(dir, "backup"), join(dir, "report-backup.json")),
    separate: analyze(join(dir, "separate"), join(dir, "report-separate.json")),
  };
  const result = { n8n: version, image: IMAGE, imported: inputs.length, corpus: CORPUS_IDS.length, siblings: inputs.length - CORPUS_IDS.length, steps, shapes, changes: {}, analyzer: {}, diffs: {} };
  for (const [k, v] of Object.entries(changes)) result.changes[k] = [...v].sort();
  let failed = false;
  const srcReport = runs.source.report;
  const ref = new Map();
  if (srcReport) {
    const idToName = new Map(srcReport.workflows.map((w) => [w.id, w.name]));
    for (const w of srcReport.workflows) ref.set(w.name, normalise(w, idToName));
  }
  for (const [label, r] of Object.entries(runs)) {
    if (r.status !== 0) {
      failed = true;
      result.analyzer[label] = { crash: true, status: r.status, stderr: r.stderr };
      continue;
    }
    const ws = r.report.workflows.filter((w) => names.includes(w.name));
    const unmapped = ws.flatMap((w) => w.unmapped.map((u) => `${w.name}: ${u.node} (${u.type})`));
    result.analyzer[label] = { workflows: ws.length, outcomes: r.report.summary.outcomes, unmapped: unmapped.length, unmappedNodes: unmapped, questions: ws.reduce((s, w) => s + w.questions.length, 0), inputErrors: r.report.summary.inputErrors ?? undefined };
    if (unmapped.length || ws.length !== inputs.length) failed = true;
    if (label === "source") continue;
    const idToName = new Map(r.report.workflows.map((w) => [w.id, w.name]));
    const d = [];
    for (const w of ws) {
      const paths = diffPaths(ref.get(w.name), normalise(w, idToName));
      if (paths.length) d.push({ workflow: w.name, paths });
    }
    result.diffs[label] = d;
    if (d.length) failed = true;
  }
  const out = opt("--json") ?? join(dir, "result.json");
  writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  const brief = {
    n8n: result.n8n,
    imported: result.imported,
    shapes: result.shapes,
    changes: Object.fromEntries(Object.entries(result.changes).map(([k, v]) => [k, v.length])),
    analyzer: result.analyzer,
    diffs: Object.fromEntries(Object.entries(result.diffs).map(([k, v]) => [k, v.map((x) => `${x.workflow}: ${x.paths.map((p) => p.path).join(", ")}`)])),
  };
  console.log(JSON.stringify(brief, null, 2));
  console.error(`full result: ${out}`);
  return failed ? 1 : 0;
}

let code = 1;
try {
  await up({ fresh: !flag("--no-fresh") });
  code = main();
} catch (e) {
  console.error(e.stack || e.message);
}
if (!flag("--keep")) down();
process.exit(code);
