// Robustness: the analyzer reads untrusted exports. Every fixture is mutated
// into broken shapes (missing fields, nulls, wrong types, unknown versions and
// types, huge strings, cyclic and dangling connections, duplicate names, empty
// workflows, prototype-named keys). For each mutant: no throw, a report that
// validates against the schema, and every unknown node type reported as
// unmapped. Mutants are generated here, deterministically, from the fixtures.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, loadInput, renderText, findSecrets, sqlEffect, parseCron, txt } from "../skills/n8n-to-claude/scripts/analyze.mjs";
import { validate, schema } from "./schema-check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REFS = join(HERE, "..", "skills/n8n-to-claude/references");
const FIXTURES = join(HERE, "fixtures");
const nodes = JSON.parse(readFileSync(join(REFS, "nodes.json"), "utf8"));
const capabilities = JSON.parse(readFileSync(join(REFS, "capabilities.json"), "utf8"));
const hosts = JSON.parse(readFileSync(join(REFS, "http-hosts.json"), "utf8"));
const NOW = Date.parse("2026-11-16T00:00:00Z");
const UNKNOWN = ["n8n-nodes-base.doesNotExist", "community-pkg.someNode", "constructor", "__proto__", "toString", ""];

const fixtureItems = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".json") && !f.endsWith(".answers.json"))
  .sort()
  .flatMap((f) => loadInput(join(FIXTURES, f)).items);

const clone = (x) => JSON.parse(JSON.stringify(x));

// Deterministic pseudo-random numbers (mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WEIRD = [null, undefined, "", "x", 0, -1, 1e309, NaN, true, [], {}, [null], { __proto__: null }, "={{", "={{ $json.x }}", "constructor", "__proto__"];

// Each mutation takes a workflow object and changes it in place.
const node = (wf, r) => {
  const list = Array.isArray(wf.nodes) ? wf.nodes.filter((n) => n && typeof n === "object" && !Array.isArray(n)) : [];
  return list.length ? list[Math.floor(r() * list.length)] : null;
};
const pick = (xs, r) => xs[Math.floor(r() * xs.length)];
const MUTATIONS = {
  "missing node field": (wf, r) => {
    const n = node(wf, r);
    if (n) delete n[pick(["name", "type", "typeVersion", "parameters", "credentials", "id", "position"], r)];
  },
  "null parameters": (wf, r) => {
    const n = node(wf, r);
    if (n) n.parameters = null;
  },
  "null parameter values": (wf, r) => {
    const n = node(wf, r);
    if (n && n.parameters && typeof n.parameters === "object") for (const k of Object.keys(n.parameters)) n.parameters[k] = null;
  },
  "wrong-typed parameter values": (wf, r) => {
    const n = node(wf, r);
    if (n && n.parameters && typeof n.parameters === "object") for (const k of Object.keys(n.parameters)) n.parameters[k] = pick(WEIRD, r);
  },
  "wrong-typed node fields": (wf, r) => {
    const n = node(wf, r);
    if (n) n[pick(["name", "type", "typeVersion", "parameters", "credentials", "disabled", "onError"], r)] = pick(WEIRD, r);
  },
  "wrong-typed workflow fields": (wf, r) => {
    wf[pick(["connections", "settings", "pinData", "nodes"], r)] = pick(WEIRD, r);
  },
  "null and junk nodes": (wf) => {
    if (Array.isArray(wf.nodes)) wf.nodes.push(null, 5, "node", [], {});
  },
  "unknown typeVersion": (wf, r) => {
    const n = node(wf, r);
    if (n) n.typeVersion = pick([99, -3, 1.123456, "2", "abc", null], r);
  },
  "unknown node type": (wf, r) => {
    const n = node(wf, r);
    if (n) n.type = pick(UNKNOWN, r);
  },
  "unknown operation and resource": (wf, r) => {
    const n = node(wf, r);
    if (n && n.parameters && typeof n.parameters === "object") Object.assign(n.parameters, { resource: pick(["nope", "constructor", "={{ $json.r }}"], r), operation: pick(["nope", "toString", "={{ $json.o }}"], r), method: pick(["constructor", "BREW", "={{ 1 }}"], r) });
  },
  "huge string": (wf, r) => {
    const n = node(wf, r);
    if (!n) return;
    n.parameters = n.parameters && typeof n.parameters === "object" ? n.parameters : {};
    const big = pick(["a".repeat(2e6), "={{ ".repeat(2e5), "Bearer " + "A".repeat(1e6), "api_key=".repeat(1e5), "{{".repeat(5e5) + "}}", "SELECT ".repeat(2e5)], r);
    n.parameters[pick(["url", "jsCode", "query", "text", "workflowJson", "command"], r)] = big;
  },
  "cyclic connections": (wf) => {
    if (!Array.isArray(wf.nodes) || !wf.nodes.length) return;
    const names = wf.nodes.filter((n) => n && typeof n === "object").map((n) => n.name);
    wf.connections = wf.connections && typeof wf.connections === "object" && !Array.isArray(wf.connections) ? wf.connections : {};
    names.forEach((a, i) => {
      const b = names[(i + 1) % names.length];
      wf.connections[a] = { main: [[{ node: b, type: "main", index: 0 }, { node: a, type: "main", index: 0 }]], ai_tool: [[{ node: b, type: "ai_tool", index: 0 }]] };
    });
  },
  "connections to missing nodes": (wf) => {
    wf.connections = { Ghost: { main: [[{ node: "Nobody", type: "main", index: 0 }]] }, ...(wf.connections && typeof wf.connections === "object" ? wf.connections : {}) };
    for (const v of Object.values(wf.connections)) if (v && typeof v === "object" && Array.isArray(v.main)) v.main.push([{ node: "Missing", type: "main", index: 3 }], null, "x", [null, { node: null }, { node: 7 }]);
  },
  "duplicate node names": (wf) => {
    if (Array.isArray(wf.nodes) && wf.nodes.length) wf.nodes = [...wf.nodes, ...clone(wf.nodes)];
  },
  "empty workflow": (wf) => {
    wf.nodes = [];
    wf.connections = {};
  },
  "prototype-named nodes": (wf) => {
    if (!Array.isArray(wf.nodes)) return;
    const names = ["__proto__", "constructor", "toString", "hasOwnProperty"];
    wf.nodes.forEach((n, i) => n && typeof n === "object" && (n.name = names[i % names.length]));
  },
  "deep nesting": (wf, r) => {
    const n = node(wf, r);
    if (!n) return;
    let deep = "leaf";
    for (let i = 0; i < 3000; i++) deep = [deep];
    n.parameters = { ...(n.parameters && typeof n.parameters === "object" ? n.parameters : {}), deep };
  },
};

function check(label, wf, id = "mutant") {
  let report;
  assert.doesNotThrow(() => {
    report = analyze([{ id, name: "mutant", wf }], { nodes, capabilities, hosts, now: NOW });
  }, label);
  assert.deepEqual(validate(report, schema), [], label);
  assert.doesNotThrow(() => renderText(report), label);
  // Every enabled node whose type is not a catalogue entry is reported unmapped.
  // A repeated node name is an input-incomplete blocker instead.
  const own = (t) => Object.prototype.hasOwnProperty.call(nodes.nodes, t);
  const w = report.workflows[0];
  const list = (Array.isArray(wf.nodes) ? wf.nodes : []).filter((n) => n && typeof n === "object" && !Array.isArray(n));
  const seen = new Map();
  for (const n of list) seen.set(txt(n.name), (seen.get(txt(n.name)) || 0) + 1);
  for (const [name, k] of seen) if (k > 1) assert.ok(w.blockers.some((b) => b.kind === "input-incomplete" && b.nodes.includes(name)) && w.outcome.kind === "keep-in-n8n", `${label}: repeated name "${name}" not blocked`);
  for (const n of list) {
    if (n.disabled === true || seen.get(txt(n.name)) > 1) continue;
    const type = txt(n.type);
    if (own(type)) continue;
    const name = txt(n.name);
    assert.ok(w.unmapped.some((u) => u.node === name && u.type === type), `${label}: ${JSON.stringify(type)} in "${name}" is not reported unmapped`);
    assert.notEqual(w.outcome.kind === "subscription" && w.unmapped.some((u) => u.node === name && u.branch === "main"), true, `${label}: unmapped on the main branch but outcome subscription`);
  }
  return report;
}

test("robustness: every mutation of every fixture analyses without a crash", () => {
  let runs = 0;
  for (const [mi, [mname, mutate]] of Object.entries(MUTATIONS).entries()) {
    fixtureItems.forEach((item, fi) => {
      // Huge strings and deep nesting are slow to build; three fixtures each.
      if (["huge string", "deep nesting"].includes(mname) && fi % Math.ceil(fixtureItems.length / 3)) return;
      const r = rng(1000 * mi + fi);
      const wf = clone(item.wf);
      mutate(wf, r);
      check(`${mname} / ${item.id}`, wf, item.id);
      runs++;
    });
  }
  assert.ok(runs > 300, `only ${runs} mutants`);
});

test("robustness: random stacks of three mutations", () => {
  const names = Object.keys(MUTATIONS).filter((m) => !["huge string", "deep nesting"].includes(m));
  for (let seed = 0; seed < 300; seed++) {
    const r = rng(seed);
    const item = fixtureItems[Math.floor(r() * fixtureItems.length)];
    const wf = clone(item.wf);
    const applied = [pick(names, r), pick(names, r), pick(names, r)];
    for (const m of applied) MUTATIONS[m](wf, r);
    check(`seed ${seed}: ${applied.join(" + ")} / ${item.id}`, wf, item.id);
  }
});

test("robustness: a bulk export mixing broken and valid workflows", () => {
  const items = fixtureItems.map((it, i) => ({ ...it, wf: i % 2 ? clone(it.wf) : { nodes: "nope" } }));
  const report = analyze(items, { nodes, capabilities, hosts, now: NOW });
  assert.equal(report.workflows.length, items.length);
  assert.deepEqual(validate(report, schema), []);
});

test("robustness: unknown node types alone are unmapped and keep the workflow in n8n", () => {
  for (const type of UNKNOWN) {
    const wf = { nodes: [{ name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {} }, { name: "Thing", type, typeVersion: 1, parameters: {} }], connections: { Start: { main: [[{ node: "Thing", type: "main", index: 0 }]] } } };
    const w = check(`unknown ${JSON.stringify(type)}`, wf).workflows[0];
    assert.equal(w.outcome.kind, "keep-in-n8n", type);
    assert.deepEqual(w.unmapped.map((u) => [u.node, u.reason]), [["Thing", "not-in-catalogue"]], type);
  }
});

test("robustness: pathological strings stay fast in the parsers", () => {
  const t0 = Date.now();
  for (const s of ["={{ ".repeat(2e5), "{{".repeat(5e5), "Bearer " + "a".repeat(1e6), "api_key=".repeat(1e5), "=" + "{{ x }} ".repeat(1e5)]) {
    findSecrets(s);
    sqlEffect(s);
  }
  assert.throws(() => parseCron("* ".repeat(1e5)));
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});
