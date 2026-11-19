#!/usr/bin/env node
// The one command Claude runs in a claude.ai chat or Cowork for a person who is not technical:
// analyse every workflow, convert the ones that fit, sort them into three groups in plain
// words (plain.mjs) and write the page the person reads. Nothing is scheduled, published or
// switched off here; it writes files only.
//
//   migrate.mjs <export file|folder>... [--out <dir>] [--answers a.json] [--approve id,...]
//               [--connected gmail,slack] [--timezone Asia/Singapore] [--json]
//
//   --out        where report.json, flows/, plan.json and page.html go (default ./n8n-migrate)
//   --answers    the person's answers: analyzer question ids, plus "<workflow id>/cadence"
//                ("hourly" | "daily" | "weekly") for a schedule Claude's tasks cannot keep
//   --approve    substitutions the person said yes to (ids from plan.json todo, kind approve)
//   --connected  the connectors this session has (Claude checks its own tools); without it,
//                apps are listed but never counted as missing
//   --timezone   the person's timezone, offered as the answer to a schedule's timezone question
//   --json       print plan.json instead of the text summary
//
// Writes <out>/report.json (analyzer), <out>/flows/ (convert.mjs, one folder per workflow),
// <out>/convert.json (its summary), <out>/plan.json (plain.mjs) and <out>/page.html.
// Exit: 0 written, 1 no workflow, 2 bad usage.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { analyze, loadInput } from "./analyze.mjs";
import { CADENCES, convertedSteps, plainReport, renderPlainText } from "./plain.mjs";
import { renderPlainHtml } from "./report-html.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REFS = join(HERE, "..", "references");
const refs = (n) => JSON.parse(readFileSync(join(REFS, n), "utf8"));

const USAGE = "usage: migrate.mjs <export file|folder>... [--out <dir>] [--answers a.json] [--approve id,...] [--connected gmail,slack] [--timezone <IANA zone>] [--json]";

function parseArgs(argv) {
  const a = { inputs: [], out: resolve("n8n-migrate"), answers: {}, approve: [], connected: null, timezone: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${x} needs a value`);
      return argv[++i];
    };
    if (x === "--out") a.out = resolve(val());
    else if (x === "--answers") a.answersFile = resolve(val());
    else if (x === "--approve")
      a.approve = val()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (x === "--connected")
      a.connected = val()
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    else if (x === "--timezone") a.timezone = val();
    else if (x === "--json") a.json = true;
    else if (x === "-h" || x === "--help") a.help = true;
    else if (x.startsWith("--")) throw new Error(`unknown option ${x}`);
    else a.inputs.push(resolve(x));
  }
  if (a.answersFile) a.answers = JSON.parse(readFileSync(a.answersFile, "utf8"));
  return a;
}

// A cadence the person chose replaces the trigger's schedule through overrides.json, so a
// regenerate keeps it and the missed-run check counts against the new cadence.
function applyCadence(folder, cadence) {
  const defPath = join(folder, "definition.json");
  if (!existsSync(defPath) || !CADENCES[cadence]) return false;
  const def = JSON.parse(readFileSync(defPath, "utf8"));
  const trig = Object.entries(def.steps).find(([, s]) => s.kind === "trigger" && s.schedule);
  if (!trig) return false;
  const ovPath = join(folder, "overrides.json");
  const ov = existsSync(ovPath) ? JSON.parse(readFileSync(ovPath, "utf8")) : {};
  ov.steps ??= {};
  const prev = ov.steps[trig[0]] ?? {};
  const c = CADENCES[cadence];
  const note = `runs ${c.words} in Claude, as you chose (n8n ran it ${trig[1].schedule.shortestIntervalSec ? `every ${trig[1].schedule.shortestIntervalSec} s` : "on its own schedule"})`;
  ov.steps[trig[0]] = {
    ...prev,
    patch: { ...(prev.patch ?? {}), schedule: { cron: [c.cron], everySeconds: null, runsPerDay: c.runsPerDay, shortestIntervalSec: c.seconds, fits: "cloud-task", note } },
  };
  writeFileSync(ovPath, JSON.stringify(ov, null, 2) + "\n");
  const r = spawnSync(process.execPath, [join(HERE, "convert.mjs"), "--regenerate", folder], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`regenerate ${folder}: ${r.stderr.trim()}`);
  return true;
}

export function main(argv = process.argv.slice(2)) {
  let a;
  try {
    a = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${e.message}\n${USAGE}\n`);
    return 2;
  }
  if (a.help || !a.inputs.length) {
    process.stderr.write(`${USAGE}\n`);
    return a.help ? 0 : 2;
  }
  const items = [];
  const inputErrors = [];
  for (const p of a.inputs) {
    const l = loadInput(p);
    if (l.fatal) {
      process.stderr.write(`${l.fatal}\n`);
      continue;
    }
    items.push(...l.items);
    inputErrors.push(...l.errors);
  }
  if (!items.length) {
    process.stderr.write("no n8n workflow in the input\n");
    return 1;
  }
  const opts = { nodes: refs("nodes.json"), capabilities: refs("capabilities.json"), hosts: refs("http-hosts.json"), now: Date.now() };
  let report = analyze(items, { ...opts, answers: a.answers, inputErrors });
  // A known timezone answers every schedule's timezone question; asking it offered a single
  // option, the zone we passed (seen on a real n8n cloud export, 2026-11-20).
  const zoneQs = a.timezone ? report.workflows.flatMap((w) => w.questions).filter((q) => /\/timezone$/.test(q.id) && q.answer == null && a.answers[q.id] === undefined) : [];
  if (zoneQs.length) {
    for (const q of zoneQs) a.answers[q.id] = a.timezone;
    report = analyze(items, { ...opts, answers: a.answers, inputErrors });
  }
  mkdirSync(a.out, { recursive: true });
  writeFileSync(join(a.out, "report.json"), JSON.stringify(report, null, 2) + "\n");

  // Convert all inputs together (sub-workflow calls resolve across them).
  const flows = join(a.out, "flows");
  const answersPath = join(a.out, "answers.json");
  writeFileSync(answersPath, JSON.stringify(a.answers, null, 2) + "\n");
  // One input goes to convert as it is; several are joined into one bulk export first.
  let input = a.inputs[0];
  if (a.inputs.length > 1) {
    input = join(a.out, "input.json");
    // A bulk export: the workflow objects themselves (an {id, name, wf} item holds no nodes).
    writeFileSync(input, JSON.stringify(items.map((it) => ({ ...it.wf, id: it.wf.id ?? it.id, name: it.wf.name ?? it.name }))) + "\n");
  }
  const conv = spawnSync(process.execPath, [join(HERE, "convert.mjs"), input, "--out", flows, "--answers", answersPath, ...(a.approve.length ? ["--approve", a.approve.join(",")] : [])], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (conv.status !== 0) {
    process.stderr.write(`convert: ${conv.stderr.trim()}\n`);
    return 1;
  }
  const convert = JSON.parse(conv.stdout);
  writeFileSync(join(a.out, "convert.json"), JSON.stringify(convert, null, 2) + "\n");
  for (const c of convert.workflows) {
    const cad = a.answers[`${c.id}/cadence`];
    if (cad && c.status !== "refused") applyCadence(join(flows, c.folder), cad);
  }

  // A question is asked only when another answer would let the workflow move: re-analyse that
  // one workflow with the other answer (it is cheap: no model, no network).
  const byId = new Map(report.workflows.map((w, i) => [String(w.id), items[i]]));
  const reanalyze = (w, answers) => {
    const item = byId.get(String(w.id));
    return item ? analyze([item], { ...opts, answers }).workflows[0] : null;
  };
  const plan = plainReport(report, {
    convert,
    stepsOf: (c) => convertedSteps(join(flows, c.folder)),
    answers: { ...a.answers, approve: a.approve },
    connected: a.connected,
    timezone: a.timezone,
    reanalyze,
  });
  plan.out = a.out;
  writeFileSync(join(a.out, "plan.json"), JSON.stringify(plan, null, 2) + "\n");
  writeFileSync(join(a.out, "page.html"), renderPlainHtml(plan, { generated: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC" }));
  process.stdout.write(a.json ? JSON.stringify(plan, null, 2) + "\n" : `${renderPlainText(plan)}\nPage: ${join(a.out, "page.html")}\n`);
  return 0;
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) {
  try {
    process.exitCode = main();
  } catch (e) {
    process.stderr.write(`migrate: ${e.message}\n`);
    process.exitCode = 1;
  }
}
