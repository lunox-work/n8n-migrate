#!/usr/bin/env node
// Generates skills/n8n-to-claude/references/nodes.json: one entry per n8n node
// type, built from the node packages' own descriptions, merged with the
// hand-maintained classification in references/mappings.json.
//
//   node scripts/gen-nodes.mjs <dir>... [--check] [--out file] [--mappings file]
//
// <dir> is an unpacked package (`npm pack` + `tar -xzf`): the folder holding
// package.json, its parent (`package/`), or any folder up to two levels above
// it. Pass n8n-nodes-base and @n8n/n8n-nodes-langchain.
//
// Source of truth inside a package: `dist/types/nodes.json` (or
// `types/nodes.json`), an array with every node description as plain JSON,
// one element per version group of a versioned node. The package's compiled
// .js is never loaded: downloaded packages are untrusted data.
//
// --check: exit 1 when the output would differ from the file on disk. This is
// the drift check run on each n8n release: re-run against the new packages and
// the diff shows added nodes, versions and operations, and stale mappings.
//
// Output is deterministic: keys sorted, lists sorted, no timestamps.
//
// What the generator adds beyond the package data:
// - `<name>Tool` entries for nodes with `usableAsTool`. n8n creates these at
//   load time (they are not in nodes.json) so an agent can call the node as a
//   tool. They copy the base node's properties, so they get the base's
//   operations, and they inherit the base's mapping as a `subnode` with the
//   `agent` lever unless mappings.json maps them itself.
// - Entries for types that appear only in mappings.json (community nodes).
// - Per-operation effects: an explicit override in mappings.json, else the
//   node-level `effect`, else the operation-name table `effectByOperation`.
//   Anything else stays undetermined (no `effect` key).

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REFS = join(ROOT, "skills", "n8n-to-claude", "references");

// Vocabulary from PLAN.md. A mapping value outside these fails the run, so a
// typo in mappings.json cannot pass as a classification.
const ROLES = ["trigger", "step", "subnode", "annotation", "n8n-internal"];
const WAKEUPS = ["manual", "schedule", "poll", "chat", "form", "relay", "endpoint", "mcp-server", "error", "subworkflow"];
const KINDS = ["logic", "code", "model", "agent", "connector", "http", "media", "files", "db", "vector", "subworkflow", "wait", "blocked"];
const LEVERS = ["agent", "subwf", "http", "media", "files", "poll", "chat", "form", "db", "vector", "relay"];
const EFFECTS = ["read", "write", "none"];
const MAPPING_KEYS = ["role", "wakeup", "kind", "levers", "connector", "secrets", "effect", "reason", "notes", "flags", "operationParam", "operations", "displayName"];
const OP_KEYS = ["kind", "levers", "connector", "secrets", "effect", "reason", "notes"];

function parseArgs(argv) {
  const a = { dirs: [], check: false, out: join(REFS, "nodes.json"), mappings: join(REFS, "mappings.json") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--check") a.check = true;
    else if (argv[i] === "--out") a.out = resolve(argv[++i]);
    else if (argv[i] === "--mappings") a.mappings = resolve(argv[++i]);
    else a.dirs.push(resolve(argv[i]));
  }
  if (!a.dirs.length) {
    console.error("usage: gen-nodes.mjs <unpacked-package-dir>... [--check] [--out file] [--mappings file]");
    process.exit(2);
  }
  return a;
}

// ---------- package discovery ----------

function findPackageRoots(dir, depth = 0, out = new Set()) {
  if (existsSync(join(dir, "package.json"))) {
    out.add(dir);
    return out;
  }
  if (depth >= 3) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e !== "node_modules" && statSync(p).isDirectory()) findPackageRoots(p, depth + 1, out);
  }
  return out;
}

function loadPackage(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const candidates = ["dist/types/nodes.json", "types/nodes.json"].map((p) => join(root, p));
  const file = candidates.find(existsSync);
  if (!file) {
    throw new Error(
      `${pkg.name}@${pkg.version}: no dist/types/nodes.json. Older packages need a static parse of the compiled descriptions, which this generator does not do.`,
    );
  }
  return { name: pkg.name, version: pkg.version, descriptions: JSON.parse(readFileSync(file, "utf8")) };
}

// ---------- version-dependent property visibility ----------

// displayOptions.show/hide["@version"] holds numbers or {_cnd: {...}} conditions.
function versionCond(c, v) {
  if (typeof c === "number") return c === v;
  const k = c && c._cnd;
  if (!k) return false;
  if ("eq" in k) return v === k.eq;
  if ("gte" in k) return v >= k.gte;
  if ("lte" in k) return v <= k.lte;
  if ("gt" in k) return v > k.gt;
  if ("lt" in k) return v < k.lt;
  if ("between" in k) return v >= k.between.from && v <= k.between.to;
  return false;
}

function visibleAt(prop, v) {
  const show = prop.displayOptions?.show?.["@version"];
  const hide = prop.displayOptions?.hide?.["@version"];
  if (show && !show.some((c) => versionCond(c, v))) return false;
  if (hide && hide.some((c) => versionCond(c, v))) return false;
  return true;
}

const asArray = (x) => (Array.isArray(x) ? x : [x]);
const uniqSorted = (xs) => [...new Set(xs)].sort();
const numSort = (xs) => [...new Set(xs)].sort((a, b) => a - b);

// Authentication values under which the node shows no `resource` parameter
// (displayOptions.show/hide.authentication on every resource property), with
// the operation parameters shown there. n8n drops a hidden parameter from the
// node's parameters, so under such a value the node has no resource and its
// operation key is the operation alone, from the operation parameter that is
// shown only for it (Discord v2 with webhook authentication: no resource,
// operation `sendLegacy`). -> {auth value: {operations, default}} or null.
const authShown = (p, a) => {
  const show = p.displayOptions?.show?.authentication;
  const hide = p.displayOptions?.hide?.authentication;
  return (!show || show.map(String).includes(a)) && !(hide && hide.map(String).includes(a));
};
function resourceHiddenByAuth(props, resProps, opProps, optionValues) {
  const auth = props.find((p) => p.name === "authentication");
  if (!auth || !resProps.length) return null;
  const out = {};
  for (const a of optionValues(auth)) {
    if (resProps.some((p) => authShown(p, a))) continue;
    const ops = opProps.filter((p) => p.displayOptions?.show?.authentication && authShown(p, a) && !p.displayOptions?.show?.resource && !p.displayOptions?.hide?.resource);
    if (!ops.length) continue;
    out[a] = { operations: uniqSorted(ops.flatMap(optionValues)) };
    if (ops[0].default !== undefined) out[a].default = String(ops[0].default);
  }
  return Object.keys(out).length ? out : null;
}

// Resource → operation lists visible at one version. `resource` and the
// operation parameter's own displayOptions.show/hide.resource are followed;
// other conditions (mode) are ignored, so the lists are the union over those,
// which is what an analyzer validating a value needs. Authentication is
// followed only where it hides the resource parameter (resourceHiddenByAuth):
// those operations go under `byAuthentication`, not under any resource.
function opsAt(descs, v, opParam) {
  const props = descs.flatMap((d) => d.properties || []).filter((p) => p.type === "options" && visibleAt(p, v));
  const optionValues = (p) => (p.options || []).map((o) => String(o.value));
  const resProps = props.filter((p) => p.name === "resource");
  const allOpProps = props.filter((p) => p.name === opParam);
  if (!resProps.length && !allOpProps.length) return null;
  const byAuth = resourceHiddenByAuth(props, resProps, allOpProps, optionValues);
  // An operation parameter shown only under authentication values that hide the resource belongs to none of the resources.
  const opProps = byAuth ? allOpProps.filter((p) => !(p.displayOptions?.show?.authentication ?? []).length || p.displayOptions.show.authentication.map(String).some((a) => !byAuth[a])) : allOpProps;
  if (!resProps.length) {
    const g = { operations: uniqSorted(opProps.flatMap(optionValues)) };
    if (opProps[0].default !== undefined) g.default = String(opProps[0].default);
    return g;
  }
  const resources = uniqSorted(resProps.flatMap(optionValues));
  const out = {};
  for (const r of resources) out[r] = { operations: [] };
  for (const p of opProps) {
    const show = p.displayOptions?.show?.resource;
    const hide = p.displayOptions?.hide?.resource;
    for (const r of resources) {
      if (show && !show.map(String).includes(r)) continue;
      if (hide && hide.map(String).includes(r)) continue;
      out[r].operations.push(...optionValues(p));
      if (out[r].default === undefined && p.default !== undefined) out[r].default = String(p.default);
    }
  }
  for (const r of resources) out[r].operations = uniqSorted(out[r].operations);
  const g = { resources: out };
  if (resProps[0].default !== undefined) g.resourceDefault = String(resProps[0].default);
  if (byAuth) {
    g.byAuthentication = byAuth;
    const auth = props.find((p) => p.name === "authentication");
    if (auth.default !== undefined) g.authenticationDefault = String(auth.default);
  }
  return g;
}

// Groups versions with identical operation lists: [{versions, ...lists}].
function opsGroups(descs, versions, opParam) {
  const groups = new Map();
  for (const v of versions) {
    const descsAtV = descs.filter((d) => asArray(d.version).includes(v));
    const g = opsAt(descsAtV, v, opParam);
    if (!g) continue;
    const key = JSON.stringify(sortKeys(g));
    if (!groups.has(key)) groups.set(key, { versions: [], ...g });
    groups.get(key).versions.push(v);
  }
  return [...groups.values()];
}

// "resource:operation", or "operation" when the node has no resource parameter
// (or none under an authentication value, byAuthentication).
function opKeys(groups) {
  const keys = new Set();
  for (const g of groups || []) {
    if (g.resources) for (const [r, x] of Object.entries(g.resources)) for (const o of x.operations) keys.add(`${r}:${o}`);
    else for (const o of g.operations) keys.add(o);
    for (const x of Object.values(g.byAuthentication ?? {})) for (const o of x.operations) keys.add(o);
  }
  return [...keys].sort();
}

// ---------- mappings ----------

function isRule(x) {
  return x && typeof x === "object" && !Array.isArray(x) && "param" in x;
}

// A rule object decides a value from one node parameter:
//   {"param": "responseMode" | ["method", "requestMethod"],
//    "values": {"<literal as string>": result}, "other": result, "default": result}
// `default` applies when the parameter is absent (n8n's default holds);
// `other` to a literal not listed. An expression, or a literal with no
// `other`, leaves the value undetermined.
function checkValue(where, v, allowed) {
  const results = isRule(v) ? [...Object.values(v.values || {}), ...("other" in v ? [v.other] : []), ...("default" in v ? [v.default] : [])] : [v];
  for (const r of results) if (!allowed.includes(r)) throw new Error(`${where}: ${JSON.stringify(r)} is not one of ${allowed.join(", ")}`);
}

function validateMapping(type, m) {
  for (const k of Object.keys(m)) if (!MAPPING_KEYS.includes(k)) throw new Error(`${type}: unknown mapping key ${k}`);
  if (!m.role) throw new Error(`${type}: mapping needs a role`);
  checkValue(`${type}.role`, m.role, ROLES);
  if (m.wakeup !== undefined) checkValue(`${type}.wakeup`, m.wakeup, WAKEUPS);
  if (m.kind !== undefined) checkValue(`${type}.kind`, m.kind, KINDS);
  if (m.kind === "blocked" && !m.reason) throw new Error(`${type}: kind blocked needs a reason`);
  if (m.kind === "connector" && !m.connector) throw new Error(`${type}: kind connector needs a connector`);
  for (const l of m.levers || []) checkValue(`${type}.levers`, l, LEVERS);
  if (m.effect !== undefined) checkValue(`${type}.effect`, m.effect, EFFECTS);
  if (m.secrets !== undefined) checkValue(`${type}.secrets`, m.secrets, [true, false]);
  for (const [k, o] of Object.entries(m.operations || {})) {
    for (const f of Object.keys(o)) if (!OP_KEYS.includes(f)) throw new Error(`${type}.operations.${k}: unknown key ${f}`);
    if (o.kind !== undefined) checkValue(`${type}.operations.${k}.kind`, o.kind, KINDS);
    if (o.kind === "blocked" && !o.reason) throw new Error(`${type}.operations.${k}: kind blocked needs a reason`);
    for (const l of o.levers || []) checkValue(`${type}.operations.${k}.levers`, l, LEVERS);
    if (o.effect !== undefined) checkValue(`${type}.operations.${k}.effect`, o.effect, EFFECTS);
  }
}

// Per-operation view of a mapped node. Override precedence: "*", then
// "<resource>:*", then the exact key. Keys in mappings.json that match no
// operation in the package are returned as stale (drift).
function mergeOperations(m, keys, effectByOperation) {
  const overrides = m.operations || {};
  const out = {};
  for (const key of keys) {
    const [r, o] = key.includes(":") ? key.split(":") : [null, key];
    const ov = { ...overrides["*"], ...(r ? overrides[`${r}:*`] : {}), ...overrides[key] };
    const e = { ...ov };
    delete e.effect;
    if (ov.effect !== undefined) Object.assign(e, { effect: ov.effect, effectBy: "hand" });
    else if (m.effect !== undefined) Object.assign(e, { effect: m.effect, effectBy: "hand" });
    else if (effectByOperation[o]) Object.assign(e, { effect: effectByOperation[o], effectBy: "name" });
    out[key] = e;
  }
  const stale = Object.keys(overrides).filter((k) => {
    if (k === "*") return false;
    if (k.endsWith(":*")) return !keys.some((x) => x.startsWith(k.slice(0, -1)));
    return !keys.includes(k);
  });
  return { operations: out, stale };
}

// ---------- output ----------

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) o[k] = sortKeys(v[k]);
    return o;
  }
  return v;
}

// JSON with sorted keys, arrays of scalars on one line, everything else
// expanded: small, stable diffs between releases.
function format(v, ind = "") {
  const next = ind + "  ";
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    if (v.every((x) => x === null || typeof x !== "object")) return `[${v.map((x) => JSON.stringify(x)).join(", ")}]`;
    return `[\n${v.map((x) => next + format(x, next)).join(",\n")}\n${ind}]`;
  }
  if (v && typeof v === "object") {
    const ks = Object.keys(v).sort().filter((k) => v[k] !== undefined);
    if (!ks.length) return "{}";
    return `{\n${ks.map((k) => `${next}${JSON.stringify(k)}: ${format(v[k], next)}`).join(",\n")}\n${ind}}`;
  }
  return JSON.stringify(v);
}

// ---------- build ----------

function build(packages, mappingsFile) {
  const hand = JSON.parse(readFileSync(mappingsFile, "utf8"));
  const handNodes = hand.nodes || {};
  const effectByOperation = hand.effectByOperation || {};
  for (const [t, m] of Object.entries(handNodes)) validateMapping(t, m);
  for (const [o, e] of Object.entries(effectByOperation)) checkValue(`effectByOperation.${o}`, e, EFFECTS);

  // type -> { pkg, descs[] }
  const byType = new Map();
  for (const p of packages) {
    for (const d of p.descriptions) {
      const type = `${p.name}.${d.name}`;
      if (!byType.has(type)) byType.set(type, { pkg: p.name, descs: [] });
      byType.get(type).descs.push(d);
    }
  }
  // Tool variants n8n synthesises from usableAsTool descriptions.
  for (const [type, { pkg, descs }] of [...byType]) {
    const toolDescs = descs.filter((d) => d.usableAsTool);
    if (toolDescs.length && !byType.has(`${type}Tool`)) byType.set(`${type}Tool`, { pkg, descs: toolDescs, toolVariantOf: type });
  }

  const nodes = {};
  const warnings = [];
  for (const [type, { pkg, descs, toolVariantOf }] of byType) {
    const versions = numSort(descs.flatMap((d) => asArray(d.version)));
    const latest = descs.find((d) => asArray(d.version).includes(versions.at(-1)));
    const dv = descs.map((d) => d.defaultVersion).filter((x) => x !== undefined);
    const groupSet = uniqSorted(descs.flatMap((d) => d.group || []));

    let mapping = handNodes[type] ? { ...handNodes[type], source: "hand" } : null;
    if (!mapping && toolVariantOf && handNodes[toolVariantOf]) {
      const b = handNodes[toolVariantOf];
      // A tool variant of an n8n-internal node (the n8n API node) stays internal.
      const role = b.role === "n8n-internal" ? b.role : "subnode";
      mapping = { ...b, role, levers: uniqSorted([...(b.levers || []), "agent"]), source: "derived", derivedFrom: toolVariantOf };
      delete mapping.displayName;
      // An operation that sets its own levers (a connector operation of an
      // otherwise http node) keeps the agent lever too.
      if (b.operations)
        mapping.operations = Object.fromEntries(Object.entries(b.operations).map(([k, o]) => [k, o.levers ? { ...o, levers: uniqSorted([...o.levers, "agent"]) } : o]));
    }
    const opParam = mapping?.operationParam || "operation";
    const ops = opsGroups(descs, versions, opParam);

    const e = {
      package: pkg,
      displayName: toolVariantOf ? `${latest.displayName} Tool` : latest.displayName,
      versions,
      defaultVersion: dv.length ? Math.max(...dv) : undefined,
      trigger: !toolVariantOf && groupSet.includes("trigger"),
      group: toolVariantOf ? undefined : groupSet,
      polling: !toolVariantOf && descs.some((d) => d.polling) ? true : undefined,
      webhook: !toolVariantOf && descs.some((d) => d.webhooks?.length) ? true : undefined,
      usableAsTool: !toolVariantOf && descs.some((d) => d.usableAsTool) ? true : undefined,
      hidden: descs.every((d) => d.hidden) ? true : undefined,
      toolVariantOf,
      credentials: uniqSorted(descs.flatMap((d) => (d.credentials || []).map((c) => c.name))),
      ops: ops.length ? ops : undefined,
    };
    if (mapping) {
      const { operations: handOps, ...rest } = mapping;
      e.mapping = rest;
      if (ops.length) {
        const merged = mergeOperations(mapping, opKeys(ops), effectByOperation);
        const operations = merged.operations;
        // A tool variant can carry fewer versions than its base (HubSpot v1 is
        // not usable as a tool); the base entry reports its own stale keys.
        const stale = mapping.source === "derived" ? [] : merged.stale;
        e.operations = operations;
        if (stale.length) {
          e.staleOperationMappings = stale;
          warnings.push(`${type}: mappings for operations not in the package: ${stale.join(", ")}`);
        }
      } else if (handOps && Object.keys(handOps).length) {
        e.staleOperationMappings = Object.keys(handOps).sort();
        warnings.push(`${type}: operation mappings but the package lists no operations`);
      }
    } else {
      e.mapping = "unmapped";
    }
    nodes[type] = e;
  }

  // Types only in mappings.json: community nodes and anything the packages dropped.
  for (const [type, m] of Object.entries(handNodes)) {
    if (nodes[type]) continue;
    const { displayName, operations: handOps, ...rest } = m;
    nodes[type] = { package: type.slice(0, type.lastIndexOf(".")), displayName, inPackages: false, mapping: { ...rest, source: "hand" } };
    if (handOps) nodes[type].operations = Object.fromEntries(Object.entries(handOps).map(([k, o]) => [k, o.effect ? { ...o, effectBy: "hand" } : o]));
    if (packages.some((p) => type.startsWith(p.name + "."))) warnings.push(`${type}: mapped but not in ${type.slice(0, type.lastIndexOf("."))}`);
  }

  const all = Object.values(nodes);
  const meta = {
    generatedBy: "scripts/gen-nodes.mjs",
    mappings: "references/mappings.json",
    packages: Object.fromEntries(packages.map((p) => [p.name, p.version])),
    counts: {
      types: all.length,
      toolVariants: all.filter((n) => n.toolVariantOf).length,
      mapped: all.filter((n) => n.mapping !== "unmapped").length,
      mappedByHand: all.filter((n) => n.mapping?.source === "hand").length,
      mappedDerived: all.filter((n) => n.mapping?.source === "derived").length,
      notInPackages: all.filter((n) => n.inPackages === false).length,
    },
  };
  return { text: format(sortKeys({ meta, nodes })) + "\n", warnings, meta };
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const roots = new Set();
  for (const d of a.dirs) findPackageRoots(d, 0, roots);
  const packages = [...roots]
    .map(loadPackageIfNodes)
    .filter(Boolean)
    .sort((x, y) => x.name.localeCompare(y.name));
  if (!packages.length) throw new Error("no n8n node package found under the given paths");
  const { text, warnings, meta } = build(packages, a.mappings);
  for (const w of warnings) console.error(`warning: ${w}`);
  const summary = `${Object.entries(meta.packages).map(([n, v]) => `${n}@${v}`).join(", ")}: ${meta.counts.types} types, ${meta.counts.mapped} mapped`;
  if (a.check) {
    const current = existsSync(a.out) ? readFileSync(a.out, "utf8") : "";
    if (current !== text) {
      console.error(`${a.out} is out of date (${summary}). Re-run without --check and review the diff.`);
      process.exit(1);
    }
    console.log(`up to date (${summary})`);
    return;
  }
  writeFileSync(a.out, text);
  console.log(`wrote ${a.out} (${summary}, ${(text.length / 1024).toFixed(0)} KB)`);
}

// Only packages that declare n8n nodes; other package.json files are skipped.
function loadPackageIfNodes(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (!pkg.n8n?.nodes) return null;
  return loadPackage(root);
}

try {
  main();
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
