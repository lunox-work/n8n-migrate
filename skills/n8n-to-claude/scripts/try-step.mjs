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
// error?}. Exit 0 when the step ran, 1 when it failed, 2 on bad input. Zero dependencies.

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
  const step = def.steps[stepName];
  if (!step) throw new Error(`no step "${stepName}" in ${folder}/definition.json`);
  let input = items;
  if (!input && pin && existsSync(join(folder, "source.n8n.json"))) {
    const src = JSON.parse(readFileSync(join(folder, "source.n8n.json"), "utf8"));
    const wf = Array.isArray(src) ? src[0] : src;
    const parent = (def.edges ?? []).find((e) => e.to === stepName)?.from;
    input = (parent && wf.pinData?.[parent]) || null;
    if (!input) throw new Error(`the export has no pinData for "${parent ?? "(no parent)"}"`);
  }
  input = (input ?? [{}]).map((it) => (it && typeof it === "object" && it.json && typeof it.json === "object" ? it.json : it));
  // The step alone behind a manual trigger that emits the sample items.
  const mini = {
    ...def,
    steps: { "Sample items": { kind: "trigger", n8n: { type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0] }, params: {} }, [stepName]: { ...step, review: undefined } },
    edges: [{ from: "Sample items", fromOutput: 0, to: stepName, toInput: 0 }],
    subnodes: (def.subnodes ?? []).filter((s) => s.to === stepName),
  };
  for (const s of mini.subnodes) mini.steps[s.from] = def.steps[s.from];
  const requests = [];
  const record = (kind) => async (p) => {
    const { id, effectKey, ...rest } = p;
    requests.push({ kind, ...rest });
    return kind === "model" ? "(dry run: no model answer)" : kind === "agent" ? "(dry run: no agent answer)" : { dryRun: true };
  };
  const res = await run(mini, { trigger: { node: "Sample items", items: input.map((json) => ({ json })) }, mode: "manual", virtualTime: true, host: { tool: record("tool"), model: record("model"), agent: record("agent"), http: async (p) => (requests.push({ kind: "http", method: p.method, url: p.url, body: p.body }), { status: 200, headers: {}, body: { dryRun: true } }), sleep: async () => ({}) } });
  const out = res.runData?.[stepName]?.at(-1)?.data?.main?.flat().map((it) => it?.json) ?? [];
  return { status: res.status, output: out, requests, ...(res.error ? { error: res.error } : {}) };
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
