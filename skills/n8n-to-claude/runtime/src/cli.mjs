#!/usr/bin/env node
// Node CLI for the runner core (the task driver's entry point).
//
//   runner.mjs run <definition.json> --state <run.json> [--trigger <json|@file>]
//              [--clock <ISO>] [--run-id <id>] [--batch-size <n>] [--mode manual|trigger]
//              [--available-tools <json|@file>] [--source <export.json>] [--cursors <json|@file>]
//   runner.mjs resume --state <run.json> --results <json|@file>
//   runner.mjs preflight <definition.json> [--available-tools <json|@file>] [--source <export.json>]
//   runner.mjs convert <n8n-export.json> [--nodes <nodes.json>] [--out <definition.json>]
//
// Task driver (driver.mjs), run from the workflow folder; prints plain text for the model:
//   runner.mjs start [--trigger <json>] [--clock <ISO>] [--force]  start or continue a run
//   runner.mjs next                                   the next thing to do, or DONE / FAILED
//   runner.mjs show <q> <part>                        part of a long instruction
//   runner.mjs answer <q> [--file f | --text t]       a model/agent answer (default: the file
//                                                     .n2c/inbox/<q>.txt, else stdin)
//   runner.mjs result <q> [--error] [--file f]        a tool response, when hooks are off
//   runner.mjs status                                 JSON summary of the current run
//
// The commands above print one JSON line. Exit codes: 0 done, 10 needs host results, 1 failed, 2 bad input.
// The state file holds the whole run (definition, clock, result log); the host executes
// the printed requests and passes their results back with `resume`.

import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { start, resume, preflight, fromN8n, BadInput, runRecord, stepStatuses, cursorRecord, runPath, cursorPath } from "./index.mjs";
import { command as driverCommand } from "./driver.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXIT = { done: 0, needs: 10, failed: 1 };

const BOOLEAN_FLAGS = new Set(["error", "force"]);
function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--") || BOOLEAN_FLAGS.has(key)) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else pos.push(a);
  }
  return { pos, flags };
}

const readJsonFile = (p) => JSON.parse(readFileSync(p, "utf8"));
function jsonArg(v, what) {
  if (v === undefined || v === true) return undefined;
  const s = String(v);
  try {
    if (s.startsWith("@")) return readJsonFile(s.slice(1));
    if (existsSync(s)) return readJsonFile(s);
    return JSON.parse(s);
  } catch (e) {
    throw new BadInput(`${what}: ${e.message}`);
  }
}
function writeAtomic(path, data) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, path);
}
const print = (o) => process.stdout.write(JSON.stringify(o) + "\n");

function summary(res) {
  const out = { status: res.status, runId: res.runId };
  if (res.status === "needs") out.requests = res.requests;
  if (res.status === "done") {
    out.output = res.output;
    if (res.response !== undefined) out.response = res.response;
  }
  if (res.error) out.error = res.error;
  if (res.effects) out.effects = res.effects.length;
  if (res.cursors) out.cursors = res.cursors;
  return out;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  if (cmd === "run") {
    if (!pos[0]) throw new BadInput("usage: run <definition.json> --state <run.json>");
    if (!flags.state || flags.state === true) throw new BadInput("--state <run.json> is required");
    const definition = jsonArg(pos[0], "definition");
    const res = await start(definition, {
      trigger: jsonArg(flags.trigger, "--trigger"),
      clock: flags.clock ? { startedAt: flags.clock } : undefined,
      runId: flags["run-id"],
      batchSize: flags["batch-size"] ? Number(flags["batch-size"]) : undefined,
      mode: flags.mode,
      availableTools: jsonArg(flags["available-tools"], "--available-tools"),
      sourceText: flags.source ? readFileSync(flags.source, "utf8") : undefined,
      cursors: jsonArg(flags.cursors, "--cursors"),
    });
    if (res.state) writeAtomic(flags.state, res.state);
    print(summary(res));
    return EXIT[res.status] ?? 1;
  }
  if (cmd === "resume") {
    if (!flags.state || flags.state === true) throw new BadInput("--state <run.json> is required");
    const state = jsonArg(flags.state, "--state");
    const results = jsonArg(flags.results, "--results");
    if (results === undefined) throw new BadInput("--results is required");
    const res = await resume(state, results);
    writeAtomic(flags.state, res.state);
    print(summary(res));
    return EXIT[res.status] ?? 1;
  }
  if (cmd === "preflight") {
    const definition = jsonArg(pos[0], "definition");
    const r = preflight(definition, { availableTools: jsonArg(flags["available-tools"], "--available-tools"), sourceText: flags.source ? readFileSync(flags.source, "utf8") : undefined });
    print(r);
    return r.ok ? 0 : 1;
  }
  if (cmd === "convert") {
    if (!pos[0]) throw new BadInput("usage: convert <n8n-export.json>");
    const text = readFileSync(pos[0], "utf8");
    const nodesPath = flags.nodes && flags.nodes !== true ? flags.nodes : join(HERE, "..", "..", "references", "nodes.json");
    if (!existsSync(nodesPath)) throw new BadInput(`node catalogue not found at ${nodesPath}; pass --nodes`);
    const def = fromN8n(JSON.parse(text), { nodes: readJsonFile(nodesPath), sourceText: text, file: basename(pos[0]) });
    if (flags.out && flags.out !== true) {
      writeAtomic(resolve(flags.out), def);
      print({ status: "converted", out: flags.out, steps: Object.keys(def.steps).length });
    } else print(def);
    return 0;
  }
  if (["start", "next", "show", "answer", "result", "status"].includes(cmd)) {
    const r = await driverCommand(cmd, pos, flags, { core: { start, resume, runRecord, stepStatuses, cursorRecord, runPath, cursorPath }, stdin: () => readFileSync(0, "utf8") });
    process.stdout.write(r.text + "\n");
    return r.code;
  }
  throw new BadInput("commands: run, resume, preflight, convert, start, next, answer, result, status");
}

main().then(
  (code) => process.exit(code),
  (e) => {
    print({ status: e instanceof BadInput || e instanceof SyntaxError || e?.code === "ENOENT" ? "bad-input" : "failed", error: { name: e?.name, message: e?.message } });
    process.exit(e instanceof BadInput || e instanceof SyntaxError || e?.code === "ENOENT" ? 2 : 1);
  },
);
