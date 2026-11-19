// Run records shared by both drivers: the documents a run writes to the artifact's `db`
// (collections runs, cursors, ledger, lock, meta) and the per-step status both drivers show.
// Browser-safe and pure: no I/O here. The artifact driver writes these through `db`; the task
// driver writes the same shapes to .n8m/records/ and, once Phase 0 shows a scheduled run can
// write the artifact's db, through ArtifactData. Shapes: references/artifact-runtime.md.

import { hashHex } from "./hash.mjs";
import { isObject } from "./util.mjs";

export const RECORD_FORMAT = 1;
export const COLLECTIONS = { runs: "runs", cursors: "cursors", ledger: "ledger", lock: "lock", meta: "meta", submissions: "submissions" };
export const LOCK_PATH = "lock/run";
export const META_CURRENT = "meta/current";
export const META_CUTOVER = "meta/cutover";
// {lastRunAt, lastRunId, lastStatus, missedAlertFor?}: written by the scheduled task at each
// run start, read for the missed-run check (schedule.mjs missedRuns).
export const META_SCHEDULE = "meta/schedule";
export const LOCK_TTL_MS = 30_000;
export const HISTORY_LIMIT = 50;
const DOC_BUDGET = 200_000; // bytes of JSON; a db document holds at most 256 KiB
const STEP_ITEMS = 3;

// db path segments allow letters, digits and _ - . ~ : @ + only, at most 200 bytes.
const safeSegment = (s) => String(s).replace(/[^A-Za-z0-9_.~:@+-]+/g, "-").replace(/^[.-]+|-+$/g, "").slice(0, 40) || "x";
// Two cursor documents per poll step: "scheduled" (c-...) is what the scheduled task works
// from; "manual" (m-...) is what Run now from the artifact works from and advances. A manual
// run never moves the scheduled cursor unless the person chooses so, and only the cutover step
// ("Seed cursor") or that choice copies one to the other (seedCursorRecord).
export const CURSOR_KINDS = ["scheduled", "manual"];
export const cursorId = (step, kind = "scheduled") => `${kind === "manual" ? "m" : "c"}-${safeSegment(step)}-${hashHex("sha256", String(step)).slice(0, 8)}`;
export const runPath = (runId) => `runs/${safeSegment(runId)}`;
export const statePath = (runId) => `${runPath(runId)}/state/current`;
export const ledgerPath = (effectKey) => `ledger/${safeSegment(effectKey)}`;
export const cursorPath = (step, kind = "scheduled") => `cursors/${cursorId(step, kind)}`;
export const submissionPath = (id) => `submissions/${safeSegment(id)}`;

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
    ...(e.status === "sent" ? { result: clip(e.result, e.resultMax ?? 4_000) } : {}),
    ...(e.error ? { error: { code: e.error.code ?? e.error.name ?? null, message: String(e.error.message ?? e.error).slice(0, 500) } } : {}),
    ...(e.resolvedBy ? { resolvedBy: e.resolvedBy } : {}),
  };
}

// cursors/<cursorId(step, kind)>. A document without `kind` (written before kinds existed)
// is a scheduled cursor.
export function cursorRecord({ step, cursor, runId, at, definitionHash, seeded = false, kind = "scheduled", copiedFrom }) {
  return { format: RECORD_FORMAT, kind, step, cursor: cursor ?? null, runId: runId ?? null, updatedAt: at, definitionHash: definitionHash ?? null, seeded: !!seeded, ...(copiedFrom ? { copiedFrom } : {}) };
}
export function cursorsFromDocs(docs, kind = "scheduled") {
  const out = {};
  for (const d of docs ?? []) if (isObject(d) && typeof d.step === "string" && d.cursor != null && (d.kind ?? "scheduled") === kind) out[d.step] = d.cursor;
  return out;
}
// The cursor a run starts from: a manual run takes its own cursor, else the scheduled one
// (reading it does not move it); a scheduled run takes only the scheduled one.
export function startCursors(docs, trigger) {
  const scheduled = cursorsFromDocs(docs, "scheduled");
  return trigger === "manual" ? { ...scheduled, ...cursorsFromDocs(docs, "manual") } : scheduled;
}
// The cutover step or the person's explicit choice: copy a cursor into the other kind.
export function seedCursorRecord(doc, { to = "scheduled", at, runId } = {}) {
  return cursorRecord({ step: doc.step, cursor: doc.cursor, runId: runId ?? doc.runId, at, definitionHash: doc.definitionHash, seeded: true, kind: to, copiedFrom: doc.kind ?? "scheduled" });
}

// ---------- form submissions (artifact form -> scheduled task hand-off) ----------
//
// submissions/<id>: {format, submissionId, workflow, definitionHash, trigger (step name), item,
// status (new|processing|done|failed), submittedAt, runId?, processedAt?, error?}. The page
// writes "new" when a step cannot run in the artifact (a task-handoff requirement); the task
// driver's poll-submissions source picks "new" ones up in submittedAt order and records the
// outcome.
export const SUBMISSION_STATUS = ["new", "processing", "done", "failed"];
export function submissionRecord({ submissionId, workflow, definitionHash, trigger, item, submittedAt, status = "new", runId, processedAt, error }) {
  return { format: RECORD_FORMAT, submissionId, workflow: workflow ?? null, definitionHash: definitionHash ?? null, trigger: trigger ?? null, item: clip(item, 64_000), status, submittedAt, ...(runId ? { runId } : {}), ...(processedAt ? { processedAt } : {}), ...(error ? { error: String(error).slice(0, 500) } : {}) };
}

// n8n Form Trigger fields (formFields.values): {fieldLabel, fieldType (text by default),
// requiredField, placeholder?, fieldOptions: {values: [{option}]}, multiselect?}. Types the
// page renders: text, number, email, date, dropdown, textarea, checkbox (also password and
// html/hidden, kept as text or skipped).
export const FORM_TYPES = ["text", "number", "email", "date", "dropdown", "textarea", "checkbox", "password"];
const fieldType = (f) => (FORM_TYPES.includes(f?.fieldType) ? f.fieldType : f?.fieldType === "html" || f?.fieldType === "hiddenField" ? null : "text");
export function formFields(form) {
  return (form?.fields ?? []).filter((f) => isObject(f) && typeof f.fieldLabel === "string" && fieldType(f)).map((f) => ({ label: f.fieldLabel, type: fieldType(f), required: f.requiredField === true, placeholder: typeof f.placeholder === "string" ? f.placeholder : "", options: (f.fieldOptions?.values ?? []).map((o) => String(o?.option ?? "")).filter((o) => o !== ""), multiple: f.multiselect === true }));
}
// Problems with the submitted values ([] when fine). values: {label: string | string[] | bool}.
export function formErrors(form, values = {}) {
  const errs = [];
  for (const f of formFields(form)) {
    const v = values[f.label];
    const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length) || v === false;
    if (empty) {
      if (f.required) errs.push({ field: f.label, message: `${f.label} is required` });
      continue;
    }
    if (f.type === "number" && !Number.isFinite(Number(v))) errs.push({ field: f.label, message: `${f.label} must be a number` });
    if (f.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v))) errs.push({ field: f.label, message: `${f.label} must be an email address` });
    if (f.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) errs.push({ field: f.label, message: `${f.label} must be a date` });
    if (f.type === "dropdown" && f.options.length && ![].concat(v).every((x) => f.options.includes(x))) errs.push({ field: f.label, message: `${f.label} must be one of the listed options` });
  }
  return errs;
}
// The item n8n's Form Trigger (v2.2+) emits: each field under its label, numbers as numbers,
// a checkbox list and a multiselect dropdown as arrays, then submittedAt and formMode.
export function formItem(form, values = {}, { now = Date.now(), mode = "production" } = {}) {
  const item = {};
  for (const f of formFields(form)) {
    const v = values[f.label];
    if (f.type === "number") item[f.label] = v === undefined || v === "" ? null : Number(v);
    else if (f.type === "checkbox") item[f.label] = f.options.length ? [].concat(v ?? []).filter((x) => f.options.includes(x)) : v === true || v === "on" || (Array.isArray(v) && v.length > 0);
    else if (f.type === "dropdown" && f.multiple) item[f.label] = [].concat(v ?? []);
    else item[f.label] = v === undefined || v === null ? "" : String(v);
  }
  item.submittedAt = new Date(now).toISOString();
  item.formMode = mode;
  return item;
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

// ---------- cutover (references/cutover.md) ----------
//
// cutover/<at>-<step>: one document per cutover step, written by scripts/cutover.mjs (by: "cli")
// and by the artifact page (by: "artifact": its dry run and Seed), in the same shape:
//   {format, step, at, by, ok, forced, detail}
// Steps, in order: dry-run, parity (optional), deactivate-n8n, seed, enable; rollback starts a
// new round. meta/cutover says who sends: {format, owner: "n8n" | "claude", updatedAt, n8n?}.
// The task driver runs a scheduled run only while owner is "claude" or no cutover was started
// (driver.mjs), so a task created early, or one still enabled after a rollback, sends nothing.
export const CUTOVER_COLLECTION = "cutover";
export const CUTOVER_STEPS = ["dry-run", "parity", "deactivate-n8n", "seed", "enable", "rollback", "shared-moved"];
export const cutoverPath = (at, step) => `${CUTOVER_COLLECTION}/${safeSegment(`${String(at).replace(/[^0-9TZ]/g, "")}-${step}`)}`;
export function cutoverEntry({ step, at, by = "cli", ok = true, forced = false, detail = {} }) {
  return { format: RECORD_FORMAT, step, at, by, ok: !!ok, forced: !!forced, detail: clip(detail, 32_000) };
}
export function cutoverMeta({ owner, at, n8n, previous = {} }) {
  return { ...previous, format: RECORD_FORMAT, owner, updatedAt: at, ...(n8n ? { n8n } : {}) };
}
// Who may send: "claude", "n8n", or null when no cutover was started (the task runs as before).
export const cutoverOwner = (meta) => (isObject(meta) && (meta.owner === "n8n" || meta.owner === "claude") ? meta.owner : null);
// The log in time order, and the part after the last rollback (the current round).
export function cutoverLog(docs) {
  return (docs ?? []).filter((d) => isObject(d) && typeof d.step === "string" && typeof d.at === "string").sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}
export function cutoverRound(docs) {
  const log = cutoverLog(docs);
  const i = log.map((e) => e.step).lastIndexOf("rollback");
  return log.slice(i + 1);
}
const SEED_SOURCES = { n8n: "n8n's own cursor", time: "a time", "dry-run": "the dry run", "manual-cursor": "the page's manual cursor", none: "nothing (no poll trigger)" };
const lastOf = (round, step) => [...round].reverse().find((e) => e.step === step && e.ok) ?? null;

// The checklist, read from records only. Order: a clean dry run (nothing sent while n8n is
// live), parity where the export has pinData (optional), deactivate the n8n workflow, seed the
// scheduled cursor from n8n's own cursor, enable the schedule. n8n goes off before the task goes
// on: the gap between them is covered by the carried cursor, while the other order would let
// both systems send (references/cutover.md).
export function cutoverChecklist({ definition, definitionHash, runs = [], cursors = {}, cutover = {}, log = [] }) {
  const polls = Object.entries(definition.steps ?? {}).filter(([, s]) => s.kind === "trigger" && s.poll && s.settings?.disabled !== true).map(([n]) => n);
  const round = cutoverRound(log);
  const never = !cutoverLog(log).length; // no cutover step logged: the older record-only reading
  const lastRollback = [...cutoverLog(log)].reverse().find((e) => e.step === "rollback");
  const since = (r) => !lastRollback || String(r.startedAt ?? "") > lastRollback.at;
  const dryEntry = [...round].reverse().find((e) => e.step === "dry-run" && e.ok && (!e.detail?.definitionHash || e.detail.definitionHash === definitionHash)) ?? null;
  const cleanRun = runs.find((r) => r.dryRun && r.status === "done" && r.definitionHash === definitionHash && since(r));
  const parity = lastOf(round, "parity");
  const deact = lastOf(round, "deactivate-n8n");
  const seed = lastOf(round, "seed");
  const enable = lastOf(round, "enable");
  const scheduled = runs.find((r) => r.trigger === "scheduled" && !r.dryRun && since(r));
  const seededCount = polls.filter((p) => cursors[p] != null).length; // scheduled cursors only
  const seedFresh = seed && (!deact || seed.at >= deact.at);
  const items = [
    { id: "dry-run", label: "Dry run clean", state: dryEntry || cleanRun ? "done" : "todo", detail: dryEntry ? `run ${dryEntry.detail?.runId ?? "?"}, ${dryEntry.detail?.wouldSend ?? 0} write(s) held, nothing sent` : cleanRun ? `run ${cleanRun.runId}` : "Run with dry run on until it ends done with this definition: writes are held and shown, nothing is sent while n8n is live", at: dryEntry?.at ?? cleanRun?.startedAt ?? null },
    { id: "parity", label: "Parity with n8n", state: parity ? (parity.detail?.compared ? "done" : "n/a") : "optional", detail: parity && !parity.detail?.compared ? parity.detail?.reason ?? "nothing to compare" : parity ? `${parity.detail?.matched ?? 0} of ${parity.detail?.compared ?? 0} pinned node output(s) match${parity.detail?.differ ? `, ${parity.detail.differ} differ` : ""}` : "Optional: replays the export's pinData through this workflow (cutover.mjs parity)", at: parity?.at ?? null },
    { id: "deactivate-n8n", label: "Deactivate the n8n workflow", state: deact || cutover.n8nDeactivatedAt ? "done" : "todo", detail: deact ? `${deact.detail?.via === "api" ? "through n8n's API" : "by hand"}${deact.detail?.cursor ? ", n8n's cursor recorded" : ""}` : cutover.n8nDeactivatedAt ? "deactivated" : "Turn the n8n workflow off before the task goes on (cutover.mjs deactivate-n8n); its cursor is recorded", at: deact?.at ?? cutover.n8nDeactivatedAt ?? null },
    { id: "seed-cursor", label: "Seed cursor", state: !polls.length ? "n/a" : seedFresh || (never && seededCount === polls.length) ? "done" : "todo", detail: !polls.length ? "No poll trigger" : seedFresh ? `from ${SEED_SOURCES[seed.detail?.source] ?? seed.detail?.source ?? "?"}${["dry-run", "manual-cursor"].includes(seed.detail?.source) && !deact ? " (for the task, seed again from n8n's cursor once n8n is off)" : ""}` : seed ? "Seeded before n8n was deactivated: seed again from n8n's cursor" : `${seededCount} of ${polls.length} poll trigger(s) have a scheduled cursor; seed it from n8n's cursor so the first scheduled run neither repeats nor skips an item`, at: seedFresh ? seed.at : null },
    { id: "enable-schedule", label: "Enable schedule", state: enable || (never && (cutover.scheduleEnabledAt || scheduled)) ? "done" : "todo", detail: enable ? "the task may send" : scheduled && never ? "first scheduled run" : "Create the scheduled task from task-prompt.md (cutover.mjs enable prints the setup)", at: enable?.at ?? (never ? cutover.scheduleEnabledAt ?? scheduled?.startedAt ?? null : null) },
  ];
  return items;
}
