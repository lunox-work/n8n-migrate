#!/usr/bin/env node
// Dry run of one step of a migrated workflow on sample items, for checking a translation
// (references/translation.md) before it is trusted.
//
//   try-step.mjs <folder> <step> [--items items.json | --pin] [--json]
//
// The step runs alone, fed the items as its input: from --items (a JSON array of items, each
// an object or {json}), or with --pin from the export's pinData for the step's parent node
// (source.n8n.json), else one empty item. Nothing leaves the machine: a connector, model,
// agent or http request is recorded with its evaluated arguments and answered with a stand-in
// ({dryRun: true}), so the output shows what the step would send. It reads definition.json:
// after editing overrides.json, run convert.mjs --regenerate first so the patch is in it.
//
// Prints {status, output: [json...], requests: [{kind, connector?, tool?, args?|prompt?|url?}],
// error?}. tryDefinition() runs a step of an in-memory definition (draft.mjs's checks). Exit 0 when the step ran, 1 when it failed, 2 on bad input. Zero dependencies.

import { readFileSync, existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../runtime/src/api.mjs";

function parse(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      if (["pin", "json"].includes(k) || argv[i + 1] === undefined || argv[i + 1].startsWith("--")) flags[k] = true;
      else flags[k] = argv[++i];
    } else pos.push(argv[i]);
  }
  return { pos, flags };
}

export async function tryStep(folder, stepName, { items, pin = false } = {}) {
  const def = JSON.parse(readFileSync(join(folder, "definition.json"), "utf8"));
  if (!def.steps[stepName]) throw new Error(`no step "${stepName}" in ${folder}/definition.json`);
  let input = items;
  if (!input && pin && existsSync(join(folder, "source.n8n.json"))) {
    input = pinnedInput(def, JSON.parse(readFileSync(join(folder, "source.n8n.json"), "utf8")), stepName);
    if (!input) throw new Error(`the export has no pinData for "${(def.edges ?? []).find((e) => e.to === stepName)?.from ?? "(no parent)"}"`);
  }
  const { status, output, requests, error } = await tryDefinition(def, stepName, { items: input });
  return { status, output, requests, ...(error ? { error } : {}) };
}

// The export's pinData for the step's parent node, or null.
export function pinnedInput(def, source, stepName) {
  const wf = Array.isArray(source) ? source[0] : source;
  const parent = (def.edges ?? []).find((e) => e.to === stepName)?.from;
  return (parent && wf?.pinData?.[parent]) || null;
}

// The step alone behind a manual trigger that emits the sample items. upstream: names of nodes
// the step's expressions read ($('Name')), put between the two as pass-through steps, so
// $('Name').item.json reads the same sample item as $json.
export function miniDefinition(def, stepName, { upstream = [] } = {}) {
  const step = def.steps[stepName];
  const chain = ["Sample items", ...upstream.filter((n) => n !== stepName && n !== "Sample items"), stepName];
  const pass = Object.fromEntries(chain.slice(1, -1).map((n) => [n, { kind: "logic", n8n: { type: "n8n-nodes-base.noOp", typeVersion: 1, position: [0, 0] }, params: {} }]));
  const mini = {
    ...def,
    steps: { "Sample items": { kind: "trigger", n8n: { type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0] }, params: {} }, ...pass, [stepName]: { ...step, review: undefined } },
    edges: chain.slice(1).map((to, i) => ({ from: chain[i], fromOutput: 0, to, toInput: 0 })),
    subnodes: (def.subnodes ?? []).filter((s) => s.to === stepName),
  };
  for (const s of mini.subnodes) mini.steps[s.from] = def.steps[s.from];
  return mini;
}

// One step of an in-memory definition on sample items, through the runner's own containment
// (allow, secret hosts). holdWrites: a dry run as the cutover's, writes held: a request the
// runner counts as a write (it carries an effect key) is recorded in `held` and answered with a
// stand-in, a read gets a stand-in too (nothing leaves the machine either way).
// -> {status, output, requests, held, effects, error?}
export async function tryDefinition(def, stepName, { items, holdWrites = false, upstream = [] } = {}) {
  if (!def.steps[stepName]) throw new Error(`no step "${stepName}" in the definition`);
  const input = (items ?? [{}]).map((it) => (it && typeof it === "object" && it.json && typeof it.json === "object" ? it.json : it));
  const mini = miniDefinition(def, stepName, { upstream });
  const requests = [];
  const held = [];
  const record = (kind) => async (p, ctx = {}) => {
    const { id, effectKey, ...rest } = p;
    requests.push({ kind, ...rest });
    if (holdWrites && ctx.effectKey) held.push({ kind, ...rest });
    return kind === "model" ? "(dry run: no model answer)" : kind === "agent" ? "(dry run: no agent answer)" : { dryRun: true };
  };
  const http = async (p, ctx = {}) => {
    requests.push({ kind: "http", method: p.method, url: p.url, body: p.body });
    if (holdWrites && ctx.effectKey) held.push({ kind: "http", method: p.method, url: p.url, body: p.body });
    return { status: 200, headers: {}, body: { dryRun: true } };
  };
  const res = await run(mini, { trigger: { node: "Sample items", items: input.map((json) => ({ json })) }, mode: "manual", virtualTime: true, host: { tool: record("tool"), model: record("model"), agent: record("agent"), http, sleep: async () => ({}) } });
  const output = res.runData?.[stepName]?.at(-1)?.data?.main?.flat().map((it) => it?.json) ?? [];
  return { status: res.status, output, requests, held, effects: res.effects ?? [], ...(res.error ? { error: res.error } : {}) };
}

if (process.argv[1] && realpathSync(new URL(import.meta.url)) === realpathSync(resolve(process.argv[1]))) {
  const { pos, flags } = parse(process.argv.slice(2));
  if (pos.length < 2) {
    process.stderr.write("usage: try-step.mjs <folder> <step> [--items items.json | --pin]\n");
    process.exit(2);
  }
  try {
    const items = typeof flags.items === "string" ? JSON.parse(readFileSync(flags.items, "utf8")) : undefined;
    const r = await tryStep(resolve(pos[0]), pos[1], { items, pin: !!flags.pin });
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    process.exit(r.status === "done" ? 0 : 1);
  } catch (e) {
    process.stderr.write(`try-step: ${e.message}\n`);
    process.exit(2);
  }
}
