// Run records shared by both drivers: the documents a run writes to the artifact's `db`
// (collections runs, cursors, ledger, lock, meta) and the per-step status both drivers show.
// Browser-safe and pure: no I/O here. The artifact driver writes these through `db`; the task
// driver writes the same shapes to .n2c/records/ and, once Phase 0 shows a scheduled run can
// write the artifact's db, through ArtifactData. Shapes: references/artifact-runtime.md.

import { hashHex } from "./hash.mjs";
import { isObject } from "./util.mjs";

export const RECORD_FORMAT = 1;
export const COLLECTIONS = { runs: "runs", cursors: "cursors", ledger: "ledger", lock: "lock", meta: "meta" };
export const LOCK_PATH = "lock/run";
export const META_CURRENT = "meta/current";
export const META_CUTOVER = "meta/cutover";
export const LOCK_TTL_MS = 30_000;
export const HISTORY_LIMIT = 50;
const DOC_BUDGET = 200_000; // bytes of JSON; a db document holds at most 256 KiB
const STEP_ITEMS = 3;

// db path segments allow letters, digits and _ - . ~ : @ + only, at most 200 bytes.
const safeSegment = (s) => String(s).replace(/[^A-Za-z0-9_.~:@+-]+/g, "-").replace(/^[.-]+|-+$/g, "").slice(0, 40) || "x";
export const cursorId = (step) => `c-${safeSegment(step)}-${hashHex("sha256", String(step)).slice(0, 8)}`;
export const runPath = (runId) => `runs/${safeSegment(runId)}`;
export const statePath = (runId) => `${runPath(runId)}/state/current`;
export const ledgerPath = (effectKey) => `ledger/${safeSegment(effectKey)}`;
export const cursorPath = (step) => `cursors/${cursorId(step)}`;

const byteLength = (s) => new TextEncoder().encode(s).length;
// A JSON value cut to fit `max` bytes: strings are shortened, the rest becomes a preview.
export function clip(value, max = 8_000) {
  if (value === undefined) return null;
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    return { truncated: true, preview: String(value).slice(0, max) };
  }
  if (text === undefined) return null;
  if (byteLength(text) <= max) return value;
  if (typeof value === "string") return value.slice(0, max) + "…";
  return { truncated: true, bytes: byteLength(text), preview: text.slice(0, max) };
}

// ---------- per-step status ----------
//
// Status words, the same in both drivers and in the page:
//   pending    not reached yet (run still going)       running    a request is out now
//   done       ran and emitted items                   error      ran and failed
//   skipped    the run ended without reaching it, or the step is disabled
//   would-send a write the dry run did not send (its exact arguments are recorded)
//   handoff    the step runs only in the scheduled task (http, long waits); the run stopped here
//   unknown    a write was being sent when the run was cut off: check before re-sending
//   blocked    the converter could not migrate the step (static)

function itemsOf(task) {
  return (task?.data?.main ?? []).reduce((n, out) => n + (out?.length ?? 0), 0);
}
function inputsOf(runData, task) {
  let n = 0;
  for (const src of task?.source ?? []) {
    if (!src) continue;
    const prev = runData[src.previousNode]?.[src.previousNodeRun || 0];
    n += prev?.data?.main?.[src.previousNodeOutput || 0]?.length ?? 0;
  }
  return n;
}
// The sub-node (agent tool) a connector call of an agent step belongs to.
function subnodeFor(definition, parent, req) {
  for (const s of definition.subnodes ?? []) {
    if (s.to !== parent) continue;
    const t = definition.steps[s.from]?.tool;
    if (t && t.connector === req.connector && t.name === req.tool) return s.from;
  }
  return null;
}

// opts: {runData, active: [request], effects, dryRun, final: bool, error: {node}, handoff: {step},
//        unknown: [step], sent: {effectKey: true}, held: {effectKey: true}}
// `held` lists the writes a dry run actually held back; without it every write of a dry run
// counts as would-send. A write the run never reached (an http write after a handoff) is
// neither held nor sent.
export function stepStatuses(definition, opts = {}) {
  const runData = opts.runData ?? {};
  const out = {};
  const steps = definition.steps ?? {};
  for (const [name, s] of Object.entries(steps)) {
    const runs = runData[name];
    const rec = { status: "pending", in: 0, out: 0 };
    if (s.kind === "blocked") rec.status = "blocked";
    else if (s.settings?.disabled === true) rec.status = "skipped";
    else if (runs?.length) {
      rec.in = runs.reduce((n, t) => n + inputsOf(runData, t), 0);
      rec.out = runs.reduce((n, t) => n + itemsOf(t), 0);
      const last = runs[runs.length - 1];
      rec.status = last.error ? "error" : "done";
      if (last.error) rec.error = String(last.error.message ?? last.error);
    } else if (opts.final && !s.subnode) rec.status = "skipped";
    out[name] = rec;
  }
  const bump = (name, key) => {
    if (!out[name]) return;
    out[name][key] = (out[name][key] ?? 0) + 1;
  };
  for (const e of opts.effects ?? []) {
    const req = e.request ?? {};
    const owner = req.step;
    const target = e.kind === "tool" && steps[owner]?.kind === "agent" ? subnodeFor(definition, owner, req) ?? owner : owner;
    if (e.effect !== "write") {
      if (target !== owner && out[target]) {
        bump(target, "calls");
        if (out[target].status === "pending" || out[target].status === "skipped") out[target].status = "done";
      }
      continue;
    }
    if (opts.dryRun) {
      if (opts.held && !opts.held[e.effectKey]) continue;
      bump(target, "wouldSend");
      if (out[target] && out[target].status !== "error") out[target].status = "would-send";
    } else if (opts.sent?.[e.effectKey]) {
      bump(target, "sent");
      if (target !== owner && out[target]) out[target].status = "done";
    }
  }
  for (const req of opts.active ?? []) if (out[req.step] && out[req.step].status !== "error") out[req.step].status = "running";
  // A sub-node (chat model, memory, an agent tool not called) follows its parent.
  for (const sn of definition.subnodes ?? []) {
    const own = out[sn.from];
    const parent = out[sn.to];
    if (!own || !parent || own.calls || own.wouldSend || own.sent || !["pending", "skipped"].includes(own.status)) continue;
    if (parent.status === "running") own.status = sn.type === "ai_tool" ? own.status : "running";
    else if (["done", "would-send", "error"].includes(parent.status)) own.status = sn.type === "ai_tool" ? "skipped" : "done";
    else if (opts.final) own.status = "skipped";
  }
  for (const name of opts.unknown ?? []) if (out[name]) out[name].status = "unknown";
  if (opts.handoff?.step && out[opts.handoff.step]) out[opts.handoff.step].status = "handoff";
  if (opts.error?.node && out[opts.error.node]) {
    out[opts.error.node].status = "error";
    out[opts.error.node].error ??= opts.error.message;
  }
  return out;
}

// First items of a step's input and output, for the page's step panel and the run record.
export function stepItems(runData, name, limit = 20) {
  const runs = runData?.[name] ?? [];
  const output = [];
  const input = [];
  for (const t of runs) {
    for (const o of t?.data?.main ?? []) for (const it of o ?? []) output.push(it.json);
    for (const src of t?.source ?? []) {
      if (!src) continue;
      for (const it of runData[src.previousNode]?.[src.previousNodeRun || 0]?.data?.main?.[src.previousNodeOutput || 0] ?? []) input.push(it.json);
    }
  }
  return { input: input.slice(0, limit), output: output.slice(0, limit), inputCount: input.length, outputCount: output.length };
}

// ---------- documents ----------

// runs/<runId>. `trigger`: "manual" | "scheduled"; `driver`: "artifact" | "cloud-task" |
// "local-task". `status`: running | done | failed | handoff | needs-check | preflight-failed |
// interrupted.
export function runRecord(r) {
  const writes = (r.effects ?? []).filter((e) => e.effect === "write");
  const sent = writes.filter((e) => r.sent?.[e.effectKey]).length;
  const held = r.dryRun ? writes.filter((e) => !r.held || r.held[e.effectKey]) : [];
  const rec = {
    format: RECORD_FORMAT,
    runId: r.runId,
    workflow: r.workflow ?? null,
    trigger: r.trigger ?? "manual",
    driver: r.driver ?? "artifact",
    status: r.status,
    dryRun: !!r.dryRun,
    startedAt: r.startedAt ?? null,
    endedAt: r.endedAt ?? null,
    durationMs: r.startedAt && r.endedAt ? Math.max(0, Date.parse(r.endedAt) - Date.parse(r.startedAt)) : null,
    definitionHash: r.definitionHash ?? null,
    commit: r.commit ?? null,
    effects: {
      reads: (r.effects ?? []).filter((e) => e.effect === "read").length,
      writes: writes.length,
      sent,
      wouldSend: held.length,
      unknown: (r.unknown ?? []).length,
    },
    steps: {},
    wouldSend: [],
    handoff: r.handoff ? { step: r.handoff.step, kind: r.handoff.kind, request: clip(r.handoff.request, 4_000) } : null,
    error: r.error ? { message: String(r.error.message ?? r.error), node: r.error.node ?? null } : null,
    cursorsSaved: !!r.cursorsSaved,
    resumable: r.resumable ?? false,
  };
  for (const [name, s] of Object.entries(r.steps ?? {})) {
    const items = r.runData ? stepItems(r.runData, name, STEP_ITEMS).output : undefined;
    rec.steps[name] = { status: s.status, in: s.in ?? 0, out: s.out ?? 0, ...(s.error ? { error: String(s.error).slice(0, 500) } : {}), ...(s.wouldSend ? { wouldSend: s.wouldSend } : {}), ...(s.sent ? { sent: s.sent } : {}), ...(items?.length ? { sample: clip(items, 1_500) } : {}) };
  }
  for (const e of held.slice(0, 50)) rec.wouldSend.push({ step: e.request?.step, connector: e.request?.connector ?? null, tool: e.request?.tool ?? null, effectKey: e.effectKey, args: clip(e.request?.args ?? e.request, 6_000) });
  // Keep the document under the db's size limit: drop samples, then would-send arguments.
  if (byteLength(JSON.stringify(rec)) > DOC_BUDGET) for (const s of Object.values(rec.steps)) delete s.sample;
  if (byteLength(JSON.stringify(rec)) > DOC_BUDGET) rec.wouldSend = rec.wouldSend.map((w) => ({ ...w, args: clip(w.args, 500) }));
  return rec;
}

// ledger/<effectKey>: written "sending" before a write goes out and "sent" (or "failed" when
// the connector answered that it did not run) after. "sending" with no later state means the
// outcome is unknown and the write is never resent on its own.
export function ledgerEntry(e) {
  return {
    format: RECORD_FORMAT,
    effectKey: e.effectKey,
    runId: e.runId,
    requestId: e.requestId,
    step: e.step,
    connector: e.connector ?? null,
    tool: e.tool ?? null,
    argsHash: e.args !== undefined ? hashHex("sha256", JSON.stringify(e.args)).slice(0, 16) : null,
    status: e.status,
    at: e.at,
    ...(e.status === "sent" ? { result: clip(e.result, 4_000) } : {}),
    ...(e.error ? { error: { code: e.error.code ?? e.error.name ?? null, message: String(e.error.message ?? e.error).slice(0, 500) } } : {}),
    ...(e.resolvedBy ? { resolvedBy: e.resolvedBy } : {}),
  };
}

// cursors/<cursorId(step)>
export function cursorRecord({ step, cursor, runId, at, definitionHash, seeded = false }) {
  return { format: RECORD_FORMAT, step, cursor: cursor ?? null, runId: runId ?? null, updatedAt: at, definitionHash: definitionHash ?? null, seeded: !!seeded };
}
export function cursorsFromDocs(docs) {
  const out = {};
  for (const d of docs ?? []) if (isObject(d) && typeof d.step === "string" && d.cursor != null) out[d.step] = d.cursor;
  return out;
}

// lock/run. The page holds it through db `acquire` (a lease); a writer without `acquire` (a
// scheduled task through ArtifactData) sets the body with via: "task" and an expiry, and
// honours a body whose expiry has not passed.
export function lockBody({ holder, kind, runId, now, ttlMs = LOCK_TTL_MS, via = "artifact", released = false }) {
  const t = typeof now === "number" ? now : Date.parse(now);
  return { format: RECORD_FORMAT, holder, kind, runId: runId ?? null, via, acquiredAt: new Date(t).toISOString(), expiresAt: new Date(t + ttlMs).toISOString(), released: !!released };
}
// Is the lock held by someone else? Bodies written by the page are governed by the lease, so
// only a task-written body (via !== "artifact") that has not expired blocks here.
export function lockBlocks(body, { now, holder }) {
  if (!isObject(body) || body.released || body.holder === holder) return false;
  if (body.via === "artifact") return false;
  const exp = Date.parse(body.expiresAt);
  return Number.isFinite(exp) && exp > now;
}

// ---------- cutover checklist (PLAN Phase 7), read from records only ----------
export function cutoverChecklist({ definition, definitionHash, runs = [], cursors = {}, cutover = {} }) {
  const polls = Object.entries(definition.steps ?? {}).filter(([, s]) => s.kind === "trigger" && s.poll && s.settings?.disabled !== true).map(([n]) => n);
  const clean = runs.find((r) => r.dryRun && r.status === "done" && r.definitionHash === definitionHash);
  const scheduled = runs.find((r) => r.trigger === "scheduled");
  const seeded = polls.filter((p) => cursors[p] != null);
  return [
    { id: "dry-run", label: "Dry run clean", state: clean ? "done" : "todo", detail: clean ? `run ${clean.runId}` : "Run now with dry run on, until it ends done with this definition", at: clean?.startedAt ?? null },
    { id: "seed-cursor", label: "Seed cursor", state: !polls.length ? "n/a" : seeded.length === polls.length ? "done" : "todo", detail: !polls.length ? "No poll trigger" : `${seeded.length} of ${polls.length} poll trigger(s) have a cursor`, at: null },
    { id: "enable-schedule", label: "Enable schedule", state: cutover.scheduleEnabledAt || scheduled ? "done" : "todo", detail: cutover.scheduleEnabledAt ? "enabled" : scheduled ? "first scheduled run" : "Create the scheduled task from task-prompt.md", at: cutover.scheduleEnabledAt ?? scheduled?.startedAt ?? null },
    { id: "deactivate-n8n", label: "Deactivate the n8n workflow", state: cutover.n8nDeactivatedAt ? "done" : "todo", detail: cutover.n8nDeactivatedAt ? "deactivated" : "Turn the workflow off in n8n once a scheduled run is clean", at: cutover.n8nDeactivatedAt ?? null },
  ];
}
