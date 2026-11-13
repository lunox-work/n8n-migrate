#!/usr/bin/env node
// Prints which node types, versions, resources and operations a set of
// workflows uses, and how each is mapped in references/nodes.json.
//
//   node scripts/node-coverage.mjs <folder|file>... [--nodes file] [--json] [--strict]
//
// Accepts .json files holding a template from api.n8n.io (the workflow sits at
// .workflow.workflow), a plain workflow export ({nodes, connections}), an array
// of workflows (bulk export) or {data: [...]} (n8n public API list). Folders
// are read one level deep.
//
// Per node the operation is resolved the way n8n does: the parameter if set,
// else the default from the package description for that node version. An
// expression (`={{ ... }}`) cannot be resolved statically and is reported.
//
// Statuses, worst first:
//   not-in-catalogue   type missing from nodes.json (community node, typo, removed)
//   unmapped           in the catalogue, no mapping
//   unknown-version    typeVersion not in the package (newer or older than it)
//   unknown-operation  resource or operation value the package does not list
//   expression         resource or operation set by an expression
//   effect-undetermined  mapped, but read/write is not known for this operation
//   mapped
// --strict exits 1 when any node type is not-in-catalogue or unmapped.
//
// Workflow JSON is untrusted data: it is parsed, never run.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const a = { inputs: [], nodes: join(ROOT, "skills", "n8n-to-claude", "references", "nodes.json"), json: false, strict: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--nodes") a.nodes = resolve(argv[++i]);
    else if (argv[i] === "--json") a.json = true;
    else if (argv[i] === "--strict") a.strict = true;
    else a.inputs.push(resolve(argv[i]));
  }
  if (!a.inputs.length) {
    console.error("usage: node-coverage.mjs <folder|file>... [--nodes file] [--json] [--strict]");
    process.exit(2);
  }
  return a;
}

function listFiles(inputs) {
  const out = [];
  for (const p of inputs) {
    if (statSync(p).isDirectory()) {
      for (const e of readdirSync(p).sort()) if (e.endsWith(".json") && statSync(join(p, e)).isFile()) out.push(join(p, e));
    } else out.push(p);
  }
  return out;
}

// Returns [{id, nodes}] for every workflow found in one parsed file.
function workflowsIn(file, data) {
  const label = basename(file, ".json");
  const one = (w, id) => (w && Array.isArray(w.nodes) ? [{ id: String(id ?? w.id ?? label), nodes: w.nodes }] : []);
  if (Array.isArray(data)) return data.flatMap((w, i) => one(w, w?.id ?? `${label}#${i}`));
  if (Array.isArray(data?.data)) return data.data.flatMap((w, i) => one(w, w?.id ?? `${label}#${i}`));
  if (data?.workflow?.workflow) return one(data.workflow.workflow, data.workflow.id);
  return one(data);
}

const isExpr = (v) => typeof v === "string" && v.startsWith("=");

// Package operation lists for one version: the group listing it, else none.
function groupFor(entry, version) {
  return (entry.ops || []).find((g) => g.versions.includes(version));
}

function classify(entry, node) {
  const params = node.parameters || {};
  if (!entry) return { status: "not-in-catalogue" };
  if (entry.mapping === "unmapped") return { status: "unmapped" };
  const r = { status: "mapped", mapping: entry.mapping };
  if (entry.versions && !entry.versions.includes(node.typeVersion)) r.status = "unknown-version";
  if (!entry.ops) {
    if (r.status === "mapped" && entry.mapping.role !== "trigger" && entry.mapping.role !== "annotation" && entry.mapping.role !== "n8n-internal" && entry.mapping.effect === undefined) r.nodeEffect = "undetermined";
    return r;
  }
  const g = groupFor(entry, node.typeVersion) || entry.ops.at(-1);
  const opParam = entry.mapping.operationParam || "operation";
  let key;
  if (g.resources) {
    const res = params.resource ?? g.resourceDefault;
    if (isExpr(res)) return { ...r, op: `${res}`, status: "expression" };
    const rg = g.resources[res];
    const op = params[opParam] ?? rg?.default;
    key = `${res}:${op}`;
    if (isExpr(op)) return { ...r, op: key, status: "expression" };
    if (!rg || !rg.operations.includes(String(op))) return { ...r, op: key, status: r.status === "mapped" ? "unknown-operation" : r.status };
  } else {
    const op = params[opParam] ?? g.default;
    key = String(op);
    if (isExpr(op)) return { ...r, op: key, status: "expression" };
    if (!g.operations.includes(key)) return { ...r, op: key, status: r.status === "mapped" ? "unknown-operation" : r.status };
  }
  const o = entry.operations?.[key];
  r.op = key;
  r.opMapping = o;
  if (r.status === "mapped" && (!o || o.effect === undefined)) r.status = "effect-undetermined";
  return r;
}

const RANK = ["not-in-catalogue", "unmapped", "unknown-version", "unknown-operation", "expression", "effect-undetermined", "mapped"];

function describe(m) {
  if (!m || typeof m !== "object") return "";
  const show = (v) => (v && typeof v === "object" ? `rule:${[].concat(v.param).join("|")}` : v);
  return [show(m.role), m.wakeup && `wakeup=${show(m.wakeup)}`, m.kind && `kind=${show(m.kind)}`, m.connector && `connector=${m.connector}`, m.levers?.length && `levers=${m.levers.join("+")}`, m.source !== "hand" && m.source]
    .filter(Boolean)
    .join(" ");
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const catalogue = JSON.parse(readFileSync(a.nodes, "utf8")).nodes;
  const types = new Map(); // type -> {versions: Map(v -> Set(wf)), wfs: Set, worst, mapping}
  const ops = new Map(); // "type resource:op" -> {status, effect, wfs:Set}
  const nodeEffects = new Map(); // type -> Set(wf) for steps with no ops and no effect
  let workflows = 0;
  let nodeCount = 0;
  for (const f of listFiles(a.inputs)) {
    let data;
    try {
      data = JSON.parse(readFileSync(f, "utf8"));
    } catch (e) {
      console.error(`skip ${f}: ${e.message}`);
      continue;
    }
    for (const wf of workflowsIn(f, data)) {
      workflows++;
      for (const node of wf.nodes) {
        nodeCount++;
        const type = String(node.type);
        const entry = catalogue[type];
        const c = classify(entry, node);
        const t = types.get(type) ?? { versions: new Map(), wfs: new Set(), worst: "mapped", mapping: entry?.mapping };
        types.set(type, t);
        t.wfs.add(wf.id);
        const vKey = String(node.typeVersion);
        const vs = t.versions.get(vKey) ?? { wfs: new Set(), known: !entry?.versions || entry.versions.includes(node.typeVersion) };
        vs.wfs.add(wf.id);
        t.versions.set(vKey, vs);
        const typeStatus = ["not-in-catalogue", "unmapped"].includes(c.status) ? c.status : "mapped";
        if (RANK.indexOf(typeStatus) < RANK.indexOf(t.worst)) t.worst = typeStatus;
        if (c.op !== undefined) {
          const k = `${type} ${c.op}`;
          const o = ops.get(k) ?? { type, op: c.op, status: c.status, opMapping: c.opMapping, wfs: new Set() };
          if (RANK.indexOf(c.status) < RANK.indexOf(o.status)) o.status = c.status;
          o.wfs.add(wf.id);
          ops.set(k, o);
        }
        if (c.nodeEffect) (nodeEffects.get(type) ?? nodeEffects.set(type, new Set()).get(type)).add(wf.id);
      }
    }
  }

  const typeRows = [...types].map(([type, t]) => ({
    type,
    status: t.worst,
    workflows: t.wfs.size,
    versions: Object.fromEntries([...t.versions].sort((x, y) => Number(x[0]) - Number(y[0])).map(([v, x]) => [v, { workflows: x.wfs.size, known: x.known }])),
    mapping: describe(t.mapping),
  }));
  typeRows.sort((x, y) => RANK.indexOf(x.status) - RANK.indexOf(y.status) || y.workflows - x.workflows || x.type.localeCompare(y.type));
  const opRows = [...ops.values()].map((o) => ({ type: o.type, op: o.op, status: o.status, effect: o.opMapping?.effect, kind: o.opMapping?.kind, workflows: o.wfs.size }));
  opRows.sort((x, y) => RANK.indexOf(x.status) - RANK.indexOf(y.status) || y.workflows - x.workflows || `${x.type} ${x.op}`.localeCompare(`${y.type} ${y.op}`));
  const effectRows = [...nodeEffects].map(([type, s]) => ({ type, workflows: s.size })).sort((x, y) => y.workflows - x.workflows || x.type.localeCompare(y.type));
  const count = (rows, s) => rows.filter((r) => r.status === s).length;
  const summary = {
    workflows,
    nodes: nodeCount,
    types: typeRows.length,
    typesNotInCatalogue: count(typeRows, "not-in-catalogue"),
    typesUnmapped: count(typeRows, "unmapped"),
    versionsUnknown: typeRows.reduce((n, r) => n + Object.values(r.versions).filter((v) => !v.known).length, 0),
    operations: opRows.length,
    operationsByStatus: Object.fromEntries(RANK.map((s) => [s, count(opRows, s)]).filter(([, n]) => n)),
  };

  if (a.json) {
    console.log(JSON.stringify({ summary, types: typeRows, operations: opRows, stepsWithoutEffect: effectRows }, null, 2));
  } else {
    const fx = (e) => (e === undefined ? "" : typeof e === "object" ? `rule:${[].concat(e.param).join("|")}` : e);
    console.log(`${workflows} workflows, ${nodeCount} nodes, ${typeRows.length} node types`);
    console.log(`\nNode types (status, workflows using it, type, versions seen [? = not in package], mapping)`);
    for (const r of typeRows) {
      const vs = Object.entries(r.versions).map(([v, x]) => `${v}${x.known ? "" : "?"}`).join(",");
      console.log(`  ${r.status.padEnd(16)} ${String(r.workflows).padStart(3)}  ${r.type}  v${vs}  ${r.mapping}`);
    }
    console.log(`\nOperations (status, workflows, type, resource:operation, effect, kind override)`);
    for (const r of opRows) console.log(`  ${r.status.padEnd(19)} ${String(r.workflows).padStart(3)}  ${r.type}  ${r.op}  ${fx(r.effect)}  ${r.kind ?? ""}`);
    if (effectRows.length) {
      console.log(`\nSteps with no operation list and no node-level effect (workflows, type)`);
      for (const r of effectRows) console.log(`  ${String(r.workflows).padStart(3)}  ${r.type}`);
    }
    console.log(`\nSummary ${JSON.stringify(summary)}`);
  }
  if (a.strict && (summary.typesNotInCatalogue || summary.typesUnmapped)) process.exit(1);
}

main();
