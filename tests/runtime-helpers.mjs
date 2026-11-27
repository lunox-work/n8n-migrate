// Helpers for the runtime tests: build small definitions and run them. Not a test itself.

import { run as coreRun } from "../skills/n8n-to-claude/runtime/src/api.mjs";

export const CLOCK = { startedAt: "2026-11-14T03:00:00Z" };
const BASE = "n8n-nodes-base.";

// node("Name", "set", params, {v, pos, kind, settings, ...extra})
export function node(name, type, params = {}, o = {}) {
  const fullType = type.includes(".") ? type : BASE + type;
  const kind = o.kind ?? (/[Tt]rigger$/.test(type) ? "trigger" : type === "code" ? "code" : type === "httpRequest" ? "http" : "logic");
  const step = { kind, n8n: { type: fullType, typeVersion: o.v ?? 1, id: name, position: o.pos ?? [0, 0] }, params, settings: o.settings ?? {} };
  for (const k of ["tool", "model", "agent", "auth", "subflow", "subnode", "blocked", "review"]) if (o[k] !== undefined) step[k] = o[k];
  return [name, step];
}

// edges: [["A", "B"], ["If", "C", 1], ["X", "Merge", 0, 1]] -> from, to, fromOutput, toInput
export function wf(nodes, edges = [], extra = {}) {
  return {
    schemaVersion: 1,
    name: extra.name ?? "test",
    settings: { executionOrder: "v1", ...(extra.settings ?? {}) },
    steps: Object.fromEntries(nodes),
    edges: edges.map(([from, to, fromOutput = 0, toInput = 0]) => ({ from, fromOutput, to, toInput })),
    subnodes: [],
    allow: extra.allow ?? { tools: [], http: [], sql: [] },
    secrets: extra.secrets ?? [],
    ...(extra.vars ? { vars: extra.vars } : {}),
  };
}

export const run = (def, opts = {}) => coreRun(def, { clock: CLOCK, virtualTime: true, ...opts });

// Output items (json only) of a node's run.
export function out(res, name, output = 0, runIndex = 0) {
  const task = res.runData[name]?.[runIndex];
  if (!task) return undefined;
  return (task.data?.main?.[output] ?? []).map((it) => it.json);
}
export const items = (...jsons) => jsons.map((json) => ({ json }));
export const trigger = (...jsons) => ["Start", node("Start", "manualTrigger")[1]];
export const start = () => node("Start", "manualTrigger");
