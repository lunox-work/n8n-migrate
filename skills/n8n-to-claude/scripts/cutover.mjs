#!/usr/bin/env node
// Cutover and rollback for one converted workflow folder (the contract is
// references/cutover.md). Zero dependencies.
//
//   cutover.mjs <folder> <step> [--json] [--force] [step flags]
//
//   status                      where the cutover stands, who may send, the next step
//   dry-run                     record the latest clean dry run (`runner.mjs start --dry-run`,
//                               run in a Claude session because reads go through connectors),
//                               or run it here when the workflow has no connector or model step
//   parity                      replay the export's pinData through the definition (writes
//                               stubbed) and show n8n's pinned output next to ours
//   deactivate-n8n [--n8n-id id] [--done] [--n8n-export file] [--off-at ISO]
//                               unpublish the n8n workflow, record its poll cursor and when
//                               n8n stopped (--off-at: when the person switched it off by hand)
//   seed [--from n8n|<ISO time>|<row>]  set the scheduled cursor (default: n8n's cursor)
//   enable                      let the task send; prints the exact task setup and the
//                               schedule times that fell while neither side ran
//   run-now [--skip]            after enable: how to run the task once now for those times
//                               (it is never run by itself), or record that they stay unrun
//   rollback [--done]           stop the task sending, carry its cursor into n8n, re-publish n8n
//   checklist                   the checklist, as the artifact shows it
//   shared-moved <kind:name> [--to where]  the person moved shared n8n state out of n8n
//
// n8n is reached through its REST API when N8N_BASE_URL and N8N_API_KEY are set in the
// environment (the key is never stored or printed), else through its MCP server after a browser
// sign-in when the step gets --login <your n8n address> (n8n-oauth.mjs; asks for workflow:write
// and execution:read; one Approve click on n8n's consent page per step). MCP cannot read or write a
// workflow's static data, so over a sign-in deactivate-n8n refuses a workflow whose poll trigger
// keeps its position only there (all but Gmail, whose position its executions carry), and
// rollback refuses one with a poll trigger; both before changing anything. Without either, the
// steps print what to do in n8n by hand.
//
// Every step that changes something is written to the folder's record store (the store the
// task itself uses: task.json store) as cutover/<at>-<step>, and meta/cutover says who may
// send. Steps refuse to run out of order; --force overrides only an order that cannot make
// both systems send. Exit codes: 0 done, 1 refused or failed, 2 bad usage, 3 waiting for the
// person (a step outside this CLI).

import { readFileSync, existsSync, openSync, closeSync, statSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../runtime/src/index.mjs";
import { paths, loadTask, openStore, command, META_DRY_RUN } from "../runtime/src/driver.mjs";
import { n8nFromEnv, createN8nClient, cursorsFromStaticData, cursorsFromExecutions, laterCursors, staticDataFromCursors, pollSteps } from "./n8n-api.mjs";
import { signIn, mcpN8nClient, CUTOVER_SCOPES } from "./n8n-oauth.mjs";

const OPEN = "meta/open";
const SHARED_KINDS = new Set(["data-table", "vector-memory"]);
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const clipText = (v, n = 400) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

class Refused extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

// ---------- the folder ----------

export function openFolder(folder, { now = () => new Date().toISOString() } = {}) {
  const dir = resolve(folder);
  if (!existsSync(join(dir, "definition.json"))) throw new Refused(`${folder} is not a converted workflow folder (no definition.json)`, 2);
  const definition = readJson(join(dir, "definition.json"));
  let source = existsSync(join(dir, "source.n8n.json")) ? readJson(join(dir, "source.n8n.json")) : null;
  if (Array.isArray(source)) source = source[0] ?? null;
  const report = existsSync(join(dir, "report.json")) ? readJson(join(dir, "report.json")).workflows?.[0] ?? null : null;
  const P = paths(dir, dir);
  const task = loadTask(P);
  const store = openStore(P, task);
  store.refresh?.();
  let last = "";
  // Strictly increasing times, so two entries of one second keep their order and path.
  const stamp = () => {
    let t = now();
    if (t <= last) t = new Date(Date.parse(last) + 1).toISOString();
    return (last = t);
  };
  return { dir, definition, hash: core.definitionHash(definition), source, report, P, task, store, now: stamp };
}

const logOf = (C) => C.store.list(core.CUTOVER_COLLECTION).map((x) => x.data);
const roundOf = (C) => core.cutoverRound(logOf(C));
const lastOf = (round, step) => [...round].reverse().find((e) => e.step === step && e.ok) ?? null;
function record(C, step, detail, { forced = false } = {}) {
  const at = C.now();
  C.store.set(core.cutoverPath(at, step), core.cutoverEntry({ step, at, by: "cli", forced, detail }));
  return at;
}
function setOwner(C, owner, n8n) {
  const prev = C.store.get(core.META_CUTOVER) ?? {};
  C.store.set(core.META_CUTOVER, core.cutoverMeta({ owner, at: C.now(), n8n: n8n ? { ...(prev.n8n ?? {}), ...n8n } : prev.n8n, previous: prev }));
}
// A cutover has started once anything is logged: from then on the task's gate holds it until
// `enable` (meta/cutover owner "n8n").
function startCutover(C) {
  if (!core.cutoverOwner(C.store.get(core.META_CUTOVER))) setOwner(C, "n8n", { workflowId: C.source?.id ?? null });
}
const flush = (C, msg) => C.store.flush(`cutover: ${msg}`);

function sharedPending(C) {
  const moved = new Set(logOf(C).filter((e) => e.step === "shared-moved" && e.ok).map((e) => e.detail?.key));
  return (C.report?.sharedState ?? []).filter((s) => SHARED_KINDS.has(s.kind) && (s.sharedWith ?? []).length).map((s) => ({ key: `${s.kind}:${s.name}`, ...s })).filter((s) => !moved.has(s.key));
}
function refuseShared(C) {
  const pending = sharedPending(C);
  if (!pending.length) return;
  throw new Refused(
    [
      `This workflow shares n8n state with other workflows in the export, so it cannot move alone:`,
      ...pending.map((s) => `  - ${s.kind} "${s.name}" (nodes ${s.nodes.join(", ")}), also used by ${s.sharedWith.join(", ")}`),
      `Move that state out of n8n first: put the table in a database or sheet both sides can reach, repoint n8n's workflows to it and check they still run, then record it with:`,
      ...pending.map((s) => `  cutover.mjs ${C.dir} shared-moved ${JSON.stringify(s.key)} --to "<where it lives now>"`),
      `(references/cutover.md, Shared state). --force does not skip this.`,
    ].join("\n"),
  );
}

function withFolderLock(C, fn) {
  mkdirSync(C.P.n8m, { recursive: true });
  for (let i = 0; ; i++) {
    try {
      closeSync(openSync(C.P.lock, "wx"));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() - statSync(C.P.lock).mtimeMs > 10 * 60_000) rmSync(C.P.lock, { force: true });
      else if (i > 100) throw new Refused("a runner command is running in this folder (.n8m/lock); try again when it ends");
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  const release = () => rmSync(C.P.lock, { force: true });
  try {
    const r = fn();
    if (r && typeof r.then === "function") return r.finally(release);
    release();
    return r;
  } catch (e) {
    release();
    throw e;
  }
}

function n8nClient(C, ctx) {
  if (ctx.n8n) return ctx.n8n;
  const env = ctx.env ?? process.env;
  const cfg = n8nFromEnv(env);
  if (cfg) return createN8nClient({ ...cfg, fetch: ctx.fetch ?? globalThis.fetch, sleep: ctx.sleep });
  const login = ctx.flags?.login;
  if (login) {
    const address = typeof login === "string" ? login : String(env.N8N_BASE_URL ?? "").trim();
    if (!address) throw new Refused("--login needs your n8n address: --login https://<your n8n>.", 2);
    const sign = ctx.signIn ?? signIn;
    const client = mcpN8nClient(() => sign(address, { fetch: ctx.fetch ?? globalThis.fetch, env, scopes: CUTOVER_SCOPES }), { fetch: ctx.fetch ?? globalThis.fetch, sleep: ctx.sleep });
    (ctx.closers ??= []).push(() => client.close());
    return client;
  }
  return null;
}

// Over a sign-in (MCP) n8n's static data is out of reach: the poll steps whose position only it
// holds. Gmail's comes from its executions (fromEmitted).
function staticOnlyPolls(C) {
  return pollSteps(C.definition)
    .filter(({ step, spec }) => !(spec?.fromEmitted && !spec.unsupported(step)))
    .map(({ name }) => name);
}
const NEEDS_KEY = "set N8N_BASE_URL and N8N_API_KEY (n8n: Settings > n8n API) in your own terminal and run the step again without --login, or leave both out for the steps by hand";
const n8nIdOf = (C, flags) => (typeof flags["n8n-id"] === "string" ? flags["n8n-id"] : C.store.get(core.META_CUTOVER)?.n8n?.workflowId ?? C.source?.id ?? null);
// The runner command as the folder's task prompt has it (run from the repository root).
const runnerCmd = (C) => {
  try {
    return /(node \S*runtime\/runner\.mjs) start/.exec(readFileSync(join(C.dir, "task-prompt.md"), "utf8"))?.[1] ?? `node ${basename(C.dir)}/runtime/runner.mjs`;
  } catch {
    return `node ${basename(C.dir)}/runtime/runner.mjs`;
  }
};
const target = (C) => C.report?.outcome?.target ?? (C.task.store?.kind === "git" ? "cloud-task" : "local-task");

function checklist(C) {
  const runs = C.store.list(core.COLLECTIONS.runs).map((x) => x.data).filter((r) => r && r.runId).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  const dry = C.store.get(META_DRY_RUN);
  if (dry && !runs.some((r) => r.runId === dry.runId)) runs.unshift({ runId: dry.runId, dryRun: true, status: dry.status, definitionHash: dry.definitionHash, startedAt: dry.startedAt });
  const cursors = core.cursorsFromDocs(C.store.list(core.COLLECTIONS.cursors).map((x) => x.data));
  const list = core.cutoverChecklist({ definition: C.definition, definitionHash: C.hash, runs, cursors, cutover: C.store.get(core.META_CUTOVER) ?? {}, log: logOf(C) });
  const gap = gapItem(C, roundOf(C), runs);
  return gap ? [...list, gap] : list;
}

// ---------- schedule times while neither side runs ----------
//
// Between deactivate-n8n and enable neither n8n nor the task runs the workflow. A poll trigger
// loses nothing (its items wait behind n8n's cursor, which the task starts from), but a
// schedule trigger's fires in that window run nowhere. They are counted from the schedule of
// the definition's schedule trigger, from the moment n8n stopped (deactivate-n8n's offAt) to
// enable (or now, before enable), reported by enable, status and checklist, and caught up only
// when the person runs the task once (run-now says how) or decides not to (run-now --skip).
const GAP_SHOWN = 12;
const DAY_MS = 86400_000;
function scheduleTrigger(def) {
  for (const s of Object.values(def.steps ?? {})) if (s.kind === "trigger" && s.schedule && !s.poll && s.settings?.disabled !== true) return s.schedule;
  return null;
}
const isoOf = (t) => new Date(t).toISOString();
// {schedule, from, to, exact, enabled, count, capped, times, last} or null (no schedule trigger,
// or n8n not deactivated in this round). `until`: the end before enable (default now).
function gapOf(C, round = roundOf(C), until = null) {
  const schedule = scheduleTrigger(C.definition);
  const deact = lastOf(round, "deactivate-n8n");
  if (!schedule || !deact) return null;
  const enabled = lastOf(round, "enable");
  const from = deact.detail?.offAt ?? deact.at;
  const to = enabled ? enabled.detail?.missedWhileOff?.to ?? enabled.at : until ?? C.now();
  const { times, capped } = core.expectedRuns(schedule, Date.parse(from), Date.parse(to), { limit: 1000 });
  return { schedule, from, to, exact: deact.detail?.offAtExact !== false, enabled: !!enabled, count: times.length, capped, times: times.slice(0, GAP_SHOWN).map(isoOf), last: times.length ? isoOf(times.at(-1)) : null };
}
const gapWhen = (g) => `${g.count}${g.capped ? "+" : ""} schedule time(s) (${g.schedule.cron?.length ? `cron ${g.schedule.cron.join(", ")}` : `every ${g.schedule.everySeconds} s`} in ${g.schedule.timezone ?? "UTC"}): ${g.times.join(", ")}${g.count > g.times.length ? `, … ${g.last}` : ""}`;
const gapSpan = (g) => `between n8n going off (${g.from}${g.exact ? "" : ", when deactivate-n8n was recorded: it may have been off earlier"}) and ${g.enabled ? `enable (${g.to})` : "now"}`;
// After enable: the person's answer to the gap: a task run after enable and before the next
// schedule time (a run made for it), or run-now --skip. Null while none.
function catchUpOf(C, round, gap, runs) {
  const enabled = lastOf(round, "enable");
  const skip = [...round].reverse().find((e) => e.step === "run-now" && e.ok && e.at >= enabled.at);
  if (skip) return { skipped: true, at: skip.at };
  const next = core.expectedRuns(gap.schedule, Date.parse(enabled.at), Date.parse(enabled.at) + 40 * DAY_MS, { limit: 1 }).times[0];
  const run = (runs ?? []).filter((r) => !r.dryRun && r.trigger === "scheduled" && String(r.startedAt) > enabled.at && (next === undefined || Date.parse(r.startedAt) < next)).sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))[0];
  return run ? { runId: run.runId, at: run.startedAt, status: run.status } : null;
}
function taskRuns(C) {
  return C.store.list(core.COLLECTIONS.runs).map((x) => x.data).filter((r) => r && r.runId);
}
function gapItem(C, round, runs) {
  const g = gapOf(C, round);
  if (!g) return null;
  const base = { id: "missed-in-gap", label: "Schedule times while neither side ran", at: null };
  if (!g.enabled) return { ...base, state: g.count ? "todo" : "optional", detail: g.count ? `${gapWhen(g)}, ${gapSpan(g)}; neither n8n nor the task runs them. Enable soon; run-now then says how to run the task once` : `none so far since n8n went off (${g.from})` };
  if (!g.count) return { ...base, state: "done", detail: `none: no schedule time fell ${gapSpan(g)}` };
  const c = catchUpOf(C, round, g, runs);
  if (c?.skipped) return { ...base, state: "done", at: c.at, detail: `${gapWhen(g)}, ${gapSpan(g)}; left unrun by the person (run-now --skip)` };
  if (c) return { ...base, state: "done", at: c.at, detail: `${gapWhen(g)}, ${gapSpan(g)}; the task ran once after enable: run ${c.runId} (${c.status})` };
  return { ...base, state: "todo", detail: `${gapWhen(g)}, ${gapSpan(g)}, ran on neither side and nothing runs them by itself. Run the task once now (cutover.mjs ${C.dir} run-now says how) or leave them (run-now --skip)` };
}
const markOf = (s) => ({ done: "[x]", todo: "[ ]", "n/a": "[-]", optional: "[~]" })[s] ?? "[?]";
const checklistText = (list) => list.map((c) => `${markOf(c.state)} ${c.label}: ${c.state === "n/a" ? `not needed (${c.detail})` : c.detail}${c.at ? ` (${c.at})` : ""}`).join("\n");
function nextStep(list) {
  const todo = list.find((c) => c.state === "todo");
  return todo ? { "dry-run": "dry-run", "deactivate-n8n": "deactivate-n8n", "seed-cursor": "seed", "enable-schedule": "enable", "missed-in-gap": "run-now" }[todo.id] : null;
}

// ---------- steps ----------

async function status(C, flags, ctx) {
  const list = checklist(C);
  const meta = C.store.get(core.META_CUTOVER);
  const owner = core.cutoverOwner(meta);
  const polls = pollSteps(C.definition);
  const cursors = { scheduled: core.cursorsFromDocs(C.store.list(core.COLLECTIONS.cursors).map((x) => x.data), "scheduled"), manual: core.cursorsFromDocs(C.store.list(core.COLLECTIONS.cursors).map((x) => x.data), "manual") };
  const data = { workflow: C.definition.name, folder: C.dir, target: target(C), store: C.store.kind, owner, openRun: C.store.get(OPEN)?.runId ?? null, checklist: list, next: nextStep(list), cursors, sharedPending: sharedPending(C).map((s) => s.key), log: logOf(C).map((e) => ({ step: e.step, at: e.at, by: e.by, ok: e.ok, forced: e.forced })) };
  const gap = gapOf(C);
  if (gap) data.gap = { from: gap.from, to: gap.to, enabled: gap.enabled, count: gap.count, capped: gap.capped, times: gap.times, exact: gap.exact };
  const client = n8nClient(C, ctx);
  if (client) {
    try {
      const id = n8nIdOf(C, flags);
      const wf = id ? await client.getWorkflow(id) : null;
      data.n8n = wf ? { workflowId: id, name: wf.name, published: client.isPublished(wf), cursor: cursorsFromStaticData(C.definition, wf.staticData).cursors } : { workflowId: id, found: false };
    } catch (e) {
      data.n8n = { error: e.message };
    }
  }
  const who = owner === "claude" ? "the scheduled task (n8n is off)" : owner === "n8n" ? "n8n; the task's runs are held until `enable`" : "not started: the task is not gated yet";
  const lines = [`Workflow "${C.definition.name}" (${C.dir})`, `Target: ${data.target}; record store: ${data.store}`, `Who sends: ${who}`];
  if (data.openRun) lines.push(`A run is open: ${data.openRun}`);
  if (polls.length) for (const { name } of polls) lines.push(`Cursor of "${name}": scheduled ${clipText(cursors.scheduled[name] ?? null, 200)}; manual ${clipText(cursors.manual[name] ?? null, 200)}`);
  if (data.n8n) lines.push(data.n8n.error ? `n8n: ${data.n8n.error}` : data.n8n.found === false ? `n8n: no workflow ${data.n8n.workflowId} (pass --n8n-id)` : `n8n: workflow ${data.n8n.workflowId} is ${data.n8n.published ? "published (on)" : "unpublished (off)"}; its cursor ${clipText(data.n8n.cursor, 300)}`);
  if (data.sharedPending.length) lines.push(`Shared state still in n8n: ${data.sharedPending.join(", ")}`);
  lines.push("", checklistText(list), "", data.next ? `Next: cutover.mjs ${C.dir} ${data.next}` : owner === "claude" ? "Cutover done. Rollback: cutover.mjs <folder> rollback" : "");
  return { code: 0, text: lines.join("\n").trimEnd(), data };
}

function needsSession(def) {
  return Object.values(def.steps ?? {}).some((s) => ["tool", "model", "agent"].includes(s.kind) || (s.kind === "trigger" && s.poll));
}
function dryRunReport(C, meta) {
  const rec = C.store.get(core.runPath(meta.runId));
  const lines = [`Dry run ${meta.runId} (${meta.startedAt}): ${rec?.effects?.reads ?? "?"} read(s), ${meta.wouldSend} write(s) held, nothing sent.`];
  const trig = Object.keys(C.definition.steps).find((n) => C.definition.steps[n].kind === "trigger" && rec?.steps?.[n]);
  if (trig) lines.push(`Input: "${trig}" emitted ${rec.steps[trig].out} item(s)${rec.steps[trig].sample ? `, first: ${clipText(rec.steps[trig].sample, 300)}` : ""}`);
  for (const w of rec?.wouldSend ?? []) lines.push(`  would send: ${w.step}: ${w.connector ? `${w.connector}.${w.tool} ${clipText(w.args, 400)}` : `${w.args?.method ?? "http"} ${w.args?.url ?? ""} ${clipText(w.args?.body ?? null, 400)}`}`);
  return { lines, rec };
}
// The latest dry run, when it ran this definition after the last rollback.
function freshDryRun(C) {
  const rollback = [...core.cutoverLog(logOf(C))].reverse().find((e) => e.step === "rollback");
  const m = C.store.get(META_DRY_RUN);
  return m && m.definitionHash === C.hash && (!rollback || String(m.startedAt) > rollback.at) ? m : null;
}
// Logs a clean dry run once; returns its entry (or null when there is none).
function recordDryRun(C, meta = freshDryRun(C)) {
  if (!meta || meta.status !== "done") return null;
  const have = roundOf(C).find((e) => e.step === "dry-run" && e.ok && e.detail?.runId === meta.runId);
  if (have) return have;
  const rec = C.store.get(core.runPath(meta.runId));
  startCutover(C);
  const detail = { runId: meta.runId, definitionHash: meta.definitionHash, startedAt: meta.startedAt, wouldSend: meta.wouldSend, reads: rec?.effects?.reads ?? null, sent: rec?.effects?.sent ?? 0 };
  const at = record(C, "dry-run", detail);
  flush(C, "dry run");
  return { step: "dry-run", at, ok: true, detail };
}
async function dryRun(C, flags, ctx) {
  let meta = freshDryRun(C);
  if (!meta && !needsSession(C.definition)) {
    // Nothing goes through a connector or a model: run it here (http reads use N8M_SECRET_*).
    const r = await command("start", [], { "dry-run": true }, { core, dir: C.dir, cwd: C.dir, stdin: () => "", fetch: ctx.fetch });
    if (!/^(DONE|FAILED)/.test(r.text)) throw new Refused(`the dry run did not finish here: ${r.text.split("\n")[0]}`);
    C.store.refresh?.();
    meta = freshDryRun(C);
  }
  if (meta?.status === "done") {
    const { lines, rec } = dryRunReport(C, meta);
    recordDryRun(C, meta);
    lines.push("", `Recorded. Next: cutover.mjs ${C.dir} deactivate-n8n`);
    return { code: 0, text: lines.join("\n"), data: { runId: meta.runId, wouldSend: rec?.wouldSend ?? [] } };
  }
  const failed = meta ? `The last dry run (${meta.runId}) ended ${meta.status}; fix that first, then run it again.\n\n` : "";
  return {
    code: 3,
    text:
      failed +
      [
        "The dry run reads through your connectors, so it runs in a Claude session on the repository, not here:",
        `  1. Open the repository in Claude Code (the folder holding .claude/settings.json).`,
        `  2. Prompt: the folder's task-prompt.md, with \`start\` replaced by \`start --dry-run\`. It runs \`${runnerCmd(C)} start --dry-run\`; every write is held and shown, nothing is sent.`,
        `  3. It ends with "DONE: dry run ... nothing sent". Then run: cutover.mjs ${C.dir} dry-run`,
        "The artifact page's Run now (dry run on) is the same check for the page; its checklist records it there.",
      ].join("\n"),
  };
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function firstDiff(a, b, path = "$") {
  if (sameJson(a, b)) return null;
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDiff(a[k], b[k], Array.isArray(a) ? `${path}[${k}]` : `${path}.${k}`);
      if (d) return d;
    }
  }
  return { path, n8n: a, ours: b };
}
async function parity(C) {
  const pin = C.source?.pinData && typeof C.source.pinData === "object" ? C.source.pinData : {};
  const steps = C.definition.steps;
  const pinnedSteps = Object.keys(pin).filter((n) => steps[n] && Array.isArray(pin[n]));
  if (!pinnedSteps.length) {
    startCutover(C);
    record(C, "parity", { compared: 0, reason: "the export has no pinData" });
    flush(C, "parity");
    return { code: 0, text: "The export has no pinData, so there is no n8n output to compare with (recorded as not applicable). The dry run is the check.", data: { compared: 0 } };
  }
  // n8n's pinned output stands in for the outside world where a step reads (trigger, read tool,
  // GET) or writes (its pinned output is the service's answer); a step that computes is run by
  // us and compared with what n8n pinned for it.
  const isIo = (s) => s.kind === "trigger" || s.kind === "tool" || s.kind === "http" || s.kind === "model" || s.kind === "agent";
  const feed = Object.fromEntries(pinnedSteps.filter((n) => isIo(steps[n])).map((n) => [n, pin[n]]));
  const compare = pinnedSteps.filter((n) => !isIo(steps[n]));
  const trigger = Object.keys(steps).find((n) => steps[n].kind === "trigger" && feed[n]) ?? Object.keys(steps).find((n) => steps[n].kind === "trigger");
  const held = [];
  const missing = [];
  const host = {
    tool: async (p) => {
      if (p.effect === "write") return held.push({ step: p.step, tool: `${p.connector}.${p.tool}`, args: p.args }), { dryRun: true, ok: true };
      missing.push(p.step);
      throw new Error(`no recorded read for "${p.step}": pin its output in n8n and export again`);
    },
    http: async (p) => {
      if (!["GET", "HEAD"].includes(String(p.method ?? "GET").toUpperCase())) return held.push({ step: p.step, method: p.method, url: p.url, body: p.body }), { status: 200, headers: {}, body: { dryRun: true, ok: true } };
      missing.push(p.step);
      throw new Error(`no recorded read for "${p.step}": pin its output in n8n and export again`);
    },
    model: async (p) => (missing.push(p.step), Promise.reject(new Error(`no recorded answer for "${p.step}": pin it in n8n`))),
    agent: async (p) => (missing.push(p.step), Promise.reject(new Error(`no recorded answer for "${p.step}": pin it in n8n`))),
    sleep: async (p) => ({ resumedAt: p.until }),
  };
  const res = await core.run(C.definition, { pinData: feed, mode: "manual", trigger: trigger ? { node: trigger } : undefined, virtualTime: true, host });
  const rows = compare.map((n) => {
    const n8n = pin[n].map((it) => (it && typeof it === "object" && it.json ? it.json : it));
    const ran = res.runData?.[n];
    if (!ran?.length) return { node: n, state: "not reached", n8n: n8n.length };
    const ours = ran.at(-1).data?.main?.flat().map((it) => it?.json) ?? [];
    const d = firstDiff(n8n, ours);
    return { node: n, state: d ? "differs" : "matches", n8n: n8n.length, ours: ours.length, ...(d ? { diff: { path: d.path, n8n: clipText(d.n8n, 200), ours: clipText(d.ours, 200) } } : {}) };
  });
  const detail = { compared: rows.length, matched: rows.filter((r) => r.state === "matches").length, differ: rows.filter((r) => r.state === "differs").length, notReached: rows.filter((r) => r.state === "not reached").length, rows, wouldSend: held.length, status: res.status, ...(res.error ? { error: res.error.message } : {}) };
  startCutover(C);
  record(C, "parity", detail);
  flush(C, "parity");
  const lines = [`Parity on the export's pinData: ${detail.matched} of ${detail.compared} pinned node output(s) match${detail.differ ? `, ${detail.differ} differ` : ""}${detail.notReached ? `, ${detail.notReached} not reached` : ""}. Fed from pinData: ${Object.keys(feed).join(", ") || "nothing"}.`];
  for (const r of rows) lines.push(`  ${r.state.padEnd(11)} ${r.node}: n8n ${r.n8n} item(s)${r.ours !== undefined ? `, ours ${r.ours}` : ""}${r.diff ? `; first difference at ${r.diff.path}: n8n ${r.diff.n8n} | ours ${r.diff.ours}` : ""}`);
  for (const w of held) lines.push(`  would send: ${w.step}: ${w.tool ?? `${w.method} ${w.url}`} ${clipText(w.args ?? w.body, 300)}`);
  if (res.error) lines.push(`The replay stopped: ${res.error.message}`);
  return { code: 0, text: lines.join("\n"), data: detail };
}

function readExport(file, id, name) {
  let j = readJson(file);
  if (!Array.isArray(j)) j = j?.workflows ?? (j?.data && Array.isArray(j.data) ? j.data : [j]);
  const wf = j.find((w) => w?.id === id) ?? j.find((w) => w?.name === name) ?? (j.length === 1 ? j[0] : null);
  if (!wf) throw new Refused(`${file} holds no workflow with id ${id} or name "${name}"`);
  return wf;
}
async function deactivate(C, flags, ctx) {
  refuseShared(C);
  const round = roundOf(C);
  const done = lastOf(round, "deactivate-n8n");
  if (done) return { code: 0, text: `Already recorded: the n8n workflow was deactivated at ${done.at} (${done.detail?.via}). Next: cutover.mjs ${C.dir} seed`, data: done.detail };
  let forced = false;
  if (!lastOf(round, "dry-run") && !recordDryRun(C)) {
    if (!flags.force) throw new Refused(`Do a clean dry run first (cutover.mjs ${C.dir} dry-run). --force skips it: turning n8n off early cannot make both systems send, it only pauses the workflow until enable.`);
    forced = true;
  }
  const id = n8nIdOf(C, flags);
  const client = n8nClient(C, ctx);
  if (client) {
    if (!id) throw new Refused("No n8n workflow id: pass --n8n-id <id>.");
    if (client.kind === "mcp") {
      const only = staticOnlyPolls(C);
      if (only.length) throw new Refused(`Over a sign-in n8n does not share its saved poll position, which ${only.map((s) => `"${s}"`).join(", ")} keeps only there; without it the task could send again what n8n sent. Nothing changed in n8n. To do this step: ${NEEDS_KEY}.`);
    }
    const wf = await client.getWorkflow(id);
    if (!wf) throw new Refused(`n8n has no workflow ${id}; pass --n8n-id <id> (the id in the workflow's URL).`);
    const wasPublished = client.isPublished(wf);
    const activeVersionId = wf.activeVersionId ?? null;
    // When n8n stopped running it: schedule times after this run on neither side until enable.
    const offAt = C.now();
    if (wasPublished) await client.unpublish(id);
    const settled = await client.settledStaticData(id);
    if (client.isPublished(settled.workflow)) throw new Refused(`n8n still shows workflow ${id} as published; nothing recorded.`);
    const mapped = cursorsFromStaticData(C.definition, settled.staticData);
    // n8n's saved static data can lag what its poller delivered (n8n-api.mjs): its executions
    // say what went out, and the later cursor wins.
    let fromRuns = { cursors: {}, executions: 0 };
    let runsNote = null;
    try {
      fromRuns = cursorsFromExecutions(C.definition, await client.recentExecutions(id, client.kind === "mcp" ? 10 : undefined, pollSteps(C.definition).map((p) => p.name)));
    } catch (e) {
      runsNote = `could not read n8n's executions (${e.message}); the cursor is its saved static data only`;
    }
    const cursor = laterCursors(C.definition, mapped.cursors, fromRuns.cursors);
    const ahead = Object.keys(fromRuns.cursors).filter((s) => JSON.stringify(cursor[s]) !== JSON.stringify(mapped.cursors[s]));
    mapped.missing = mapped.missing.filter((s) => !cursor[s]);
    startCutover(C);
    setOwner(C, "n8n", { workflowId: id, published: false });
    record(C, "deactivate-n8n", { via: client.kind === "mcp" ? "mcp" : "api", workflowId: id, wasPublished, activeVersionId, offAt, offAtExact: wasPublished, staticData: settled.staticData, cursorFromStaticData: mapped.cursors, cursorFromExecutions: fromRuns.cursors, cursor: Object.keys(cursor).length ? cursor : null, missing: mapped.missing, unsupported: mapped.unsupported, ...(ahead.length ? { executionsAhead: ahead } : {}), ...(runsNote ? { note: runsNote } : {}), ...(wf.name !== C.definition.name ? { nameDiffers: wf.name } : {}) }, { forced });
    flush(C, "deactivate n8n");
    const lines = [`n8n workflow ${id} ${wasPublished ? "unpublished" : "was already unpublished"}; no execution of it is running. From now on neither side sends until enable; new items wait behind n8n's cursor.`];
    if (wf.name !== C.definition.name) lines.push(`Note: n8n names it "${wf.name}", the folder "${C.definition.name}". Check it is the same workflow.`);
    for (const [step, c] of Object.entries(cursor)) lines.push(`n8n's cursor for "${step}": ${clipText(c, 300)}${ahead.includes(step) ? " (from its executions: its saved static data lagged behind what it delivered)" : ""}`);
    if (runsNote) lines.push(`Note: ${runsNote}.`);
    for (const step of mapped.missing) lines.push(`n8n has no cursor yet for "${step}" (it found nothing since its static data was last saved).`);
    for (const u of mapped.unsupported) lines.push(`"${u.step}": cannot carry n8n's cursor: ${u.reason}.`);
    lines.push(`Next: cutover.mjs ${C.dir} seed`);
    return { code: 0, text: lines.join("\n"), data: { workflowId: id, cursor, cursorFromStaticData: mapped.cursors, cursorFromExecutions: fromRuns.cursors } };
  }
  if (!flags.done) {
    return {
      code: 3,
      text: [
        "No n8n access (set N8N_BASE_URL and N8N_API_KEY, or pass --login <your n8n address> to sign in, to do this step from here). By hand:",
        `  1. In n8n, open the workflow "${C.definition.name}"${id ? ` (id ${id})` : ""} and switch it off (unpublish).`,
        "  2. Wait until its executions list shows none running.",
        `  3. Export it after it is off, with its static data: on the n8n host, n8n export:workflow --id=${id ?? "<id>"} --output=workflow.json`,
        `  4. Record it: cutover.mjs ${C.dir} deactivate-n8n --done --n8n-export workflow.json --off-at <when you switched it off, ISO time>`,
        "Without the export, seed needs --from <the time n8n last polled>, which can repeat or skip items around that time.",
      ].join("\n"),
    };
  }
  const exported = typeof flags["n8n-export"] === "string" ? readExport(flags["n8n-export"], id, C.definition.name) : null;
  let offAt = null;
  if (flags["off-at"] !== undefined) {
    const t = Date.parse(String(flags["off-at"]));
    if (typeof flags["off-at"] !== "string" || !Number.isFinite(t)) throw new Refused(`--off-at takes the ISO time the workflow was switched off in n8n; got ${JSON.stringify(flags["off-at"])}.`, 2);
    if (t > Date.parse(C.now())) throw new Refused("--off-at is in the future: give the time the workflow was switched off.", 2);
    offAt = isoOf(t);
  }
  if (exported && (exported.active === true || exported.activeVersionId)) throw new Refused("The export shows the workflow still on: export it again after switching it off.");
  const mapped = exported ? cursorsFromStaticData(C.definition, exported.staticData ?? null) : null;
  startCutover(C);
  setOwner(C, "n8n", { workflowId: id, published: false });
  const recAt = C.now();
  record(C, "deactivate-n8n", { via: "manual", workflowId: id, offAt: offAt ?? recAt, offAtExact: !!offAt, staticData: exported ? exported.staticData ?? null : undefined, cursor: mapped && Object.keys(mapped.cursors).length ? mapped.cursors : null, missing: mapped?.missing ?? null, unsupported: mapped?.unsupported ?? [] }, { forced });
  flush(C, "deactivate n8n");
  return { code: 0, text: `Recorded: the n8n workflow is off${mapped ? `; n8n's cursor ${clipText(mapped.cursors, 300)}` : " (no export: seed needs --from)"}. Next: cutover.mjs ${C.dir} seed`, data: { cursor: mapped?.cursors ?? null } };
}

async function seed(C, flags) {
  refuseShared(C);
  const round = roundOf(C);
  const deact = lastOf(round, "deactivate-n8n");
  if (!deact) throw new Refused(`Deactivate the n8n workflow first (cutover.mjs ${C.dir} deactivate-n8n). A cursor taken while n8n still runs is behind what n8n sends next, so the task would send those items again. --force is refused for this step.`);
  const polls = pollSteps(C.definition);
  if (!polls.length) {
    record(C, "seed", { source: "none", reason: "no poll trigger" });
    flush(C, "seed");
    return { code: 0, text: `No poll trigger: nothing to seed. Next: cutover.mjs ${C.dir} enable`, data: {} };
  }
  const from = typeof flags.from === "string" ? flags.from : "n8n";
  let cursors = {};
  let source = from;
  if (from === "n8n") {
    const got = deact.detail?.cursor ?? {};
    const lacking = polls.filter((p) => !got[p.name]).map((p) => p.name);
    if (lacking.length) {
      const why = (deact.detail?.unsupported ?? []).map((u) => `${u.step}: ${u.reason}`);
      throw new Refused(
        [
          `n8n's cursor is not known for ${lacking.map((s) => `"${s}"`).join(", ")}${why.length ? ` (${why.join("; ")})` : deact.detail?.via === "manual" && !deact.detail?.staticData ? " (deactivated by hand without --n8n-export)" : " (n8n had found nothing since its static data was last saved)"}.`,
          `Seed from a time instead: cutover.mjs ${C.dir} seed --from <ISO time>. Use the time n8n was last switched on when it never found an item since; otherwise the time of its last poll. Items at or before that time are not sent.`,
        ].join("\n"),
      );
    }
    cursors = got;
  } else if (from === "dry-run") {
    throw new Refused("The dry run's cursor is not n8n's: items n8n sent after the dry run would be sent again, and items it read but n8n never polled would be skipped. Seed from n8n (the default) or from a time.");
  } else {
    for (const p of polls) {
      if (p.step.poll?.cursor?.field === "row_number") {
        if (!/^\d+$/.test(from)) throw new Refused(`"${p.name}" counts rows: --from takes the last row number already handled.`);
        cursors[p.name] = { value: Number(from) };
      } else {
        const t = Date.parse(from);
        if (!Number.isFinite(t)) throw new Refused(`--from takes n8n, an ISO time or a row number; got ${JSON.stringify(from)}.`, 2);
        cursors[p.name] = { value: new Date(t).toISOString(), ids: [] };
      }
    }
    source = "time";
  }
  const at = C.now();
  for (const [step, cursor] of Object.entries(cursors)) C.store.set(core.cursorPath(step, "scheduled"), core.cursorRecord({ step, cursor, runId: null, at, definitionHash: C.hash, seeded: true, kind: "scheduled", copiedFrom: source }));
  record(C, "seed", { source, cursors });
  flush(C, "seed");
  return { code: 0, text: `Scheduled cursor seeded from ${source === "n8n" ? "n8n's own cursor" : `the time ${from}`}: ${clipText(cursors, 400)}. The first scheduled run sends what arrived after it, nothing before. Next: cutover.mjs ${C.dir} enable`, data: { source, cursors } };
}

function setupText(C) {
  const t = target(C);
  const sched = core.definitionSchedule(C.definition);
  const rel = basename(C.dir);
  const secrets = (C.definition.secrets ?? []).map((s) => `${s.name} (hosts ${(s.hosts ?? []).join(", ") || "-"})`);
  const when = sched ? `cron "${sched.cron}" in ${sched.timezone ?? "the workflow's timezone"}` : "the trigger's schedule";
  if (t === "cloud-task")
    return [
      "Create the cloud task now (references/setup-cloud-task.md):",
      `  - repository: the private repo whose root holds ${rel}/ (push main; this CLI wrote the n8m-state branch)`,
      `  - prompt: ${rel}/task-prompt.md, as is`,
      `  - schedule: ${when} (cloud tasks run at most hourly)`,
      ...(secrets.length ? [`  - network secrets, typed by you: ${secrets.join("; ")}`] : []),
      "  - Run it once from the task page; it should end with DONE.",
    ].join("\n");
  return [
    "Create the local task now (references/setup-local-task.md):",
    `  - Claude desktop app, scheduled task on the repository folder that holds ${rel}/ (open it once in Claude Code and accept the trust prompt)`,
    `  - prompt: ${rel}/task-prompt.md`,
    `  - schedule: ${when}`,
    ...(secrets.length ? [`  - secrets in .claude/settings.local.json env as N8M_SECRET_<NAME>, typed by you: ${secrets.join("; ")}`] : []),
    "  - Run it once; it should end with DONE.",
  ].join("\n");
}
async function enable(C, flags) {
  refuseShared(C);
  const round = roundOf(C);
  const deact = lastOf(round, "deactivate-n8n");
  if (!deact) throw new Refused(`Deactivate the n8n workflow first (cutover.mjs ${C.dir} deactivate-n8n): while it runs, the task and n8n would both send. --force is refused for this step.`);
  const enabled = lastOf(round, "enable");
  if (enabled) return { code: 0, text: `Already enabled at ${enabled.at}.\n\n${setupText(C)}`, data: {} };
  const seeded = lastOf(round, "seed");
  let forced = false;
  if (pollSteps(C.definition).length && !(seeded && seeded.at >= deact.at)) {
    if (!flags.force) throw new Refused(`Seed the cursor first (cutover.mjs ${C.dir} seed). --force enables without it: the first run then only reads, sends nothing and starts from there, so items between n8n's last poll and that run are never sent.`);
    forced = true;
  }
  const gap = gapOf(C, round, C.now());
  setOwner(C, "claude");
  const missedWhileOff = gap ? { from: gap.from, to: gap.to, exact: gap.exact, count: gap.count, capped: gap.capped, times: gap.times } : null;
  record(C, "enable", { target: target(C), schedule: core.definitionSchedule(C.definition), seeded: !!seeded, ...(missedWhileOff ? { missedWhileOff } : {}) }, { forced });
  flush(C, "enable");
  const lines = [`The task may send from now on (its gate is open).`, "", setupText(C)];
  if (gap?.count) lines.push("", `Missed while neither side ran: ${gapWhen({ ...gap, enabled: true })}, ${gapSpan({ ...gap, enabled: true })}. Neither n8n nor the task ran them, and nothing runs them by itself. To run the workflow once now: cutover.mjs ${C.dir} run-now (it says how for this task); to leave them unrun: cutover.mjs ${C.dir} run-now --skip.`);
  return { code: 0, text: lines.join("\n"), data: { target: target(C), missedWhileOff } };
}

// The person's answer to schedule times that fell while neither side ran: how to run the task
// once now (never run from here: the task's session has the connectors and secrets), found in
// the task's records once it ran, or --skip to leave them unrun. Nothing to do without them.
async function runNow(C, flags) {
  const round = roundOf(C);
  const enabled = lastOf(round, "enable");
  if (!enabled) throw new Refused(`Enable first (cutover.mjs ${C.dir} enable): until then the task's runs are held and send nothing.`);
  const g = gapOf(C, round);
  if (!g) return { code: 0, text: "No schedule trigger (or n8n was not deactivated in this cutover): nothing to catch up.", data: { count: 0 } };
  if (!g.count) return { code: 0, text: `No schedule time fell ${gapSpan(g)}: nothing to catch up.`, data: { count: 0 } };
  const c = catchUpOf(C, round, g, taskRuns(C));
  if (c?.skipped) return { code: 0, text: `Recorded at ${c.at}: the ${g.count} missed schedule time(s) stay unrun.`, data: { count: g.count, skipped: true } };
  if (c) return { code: 0, text: `The task ran once after enable: run ${c.runId} at ${c.at} (${c.status}). Nothing more to do.`, data: { count: g.count, runId: c.runId } };
  if (flags.skip) {
    record(C, "run-now", { skipped: true, missed: g.count, from: g.from, to: g.to });
    flush(C, "missed schedule times left unrun");
    return { code: 0, text: `Recorded: the ${g.count} schedule time(s) ${gapSpan(g)} stay unrun.`, data: { count: g.count, skipped: true } };
  }
  const how = target(C) === "cloud-task" ? "Open the cloud task's page in Claude and run it once now" : "In the Claude desktop app, open the scheduled task and run it once now";
  return {
    code: 3,
    text: [
      `${gapWhen(g)} fell ${gapSpan(g)}; neither side ran them.`,
      `To run the workflow once now: ${how}; it should end with DONE. It is one run at the current time, as the next scheduled one would be: it does not replay each missed time.`,
      `Then run cutover.mjs ${C.dir} run-now again: it finds the run in the task's records. To leave them unrun instead: cutover.mjs ${C.dir} run-now --skip.`,
    ].join("\n"),
    data: { count: g.count, times: g.times },
  };
}

async function rollback(C, flags, ctx) {
  const round = roundOf(C);
  const deact = lastOf(round, "deactivate-n8n");
  const owner = core.cutoverOwner(C.store.get(core.META_CUTOVER));
  if (!deact && owner !== "claude") throw new Refused("Nothing to roll back: the n8n workflow was not deactivated in this cutover.");
  const id = deact?.detail?.workflowId ?? n8nIdOf(C, flags);
  const client = n8nClient(C, ctx);
  // 1. The gate closes first, under the folder's lock, so no new run of the task starts.
  const open = withFolderLock(C, () => {
    setOwner(C, "n8n");
    flush(C, "rollback: hold the task");
    return C.store.get(OPEN);
  });
  if (open?.runId) return { code: 3, text: `The task is held now, but its run ${open.runId} is not finished. Its writes would race n8n, so n8n stays off. Run rollback again once that run has ended (the next scheduled start continues it only after enable).` };
  // 2. Carry the task's scheduled cursor into n8n's static data.
  const cursors = core.cursorsFromDocs(C.store.list(core.COLLECTIONS.cursors).map((x) => x.data), "scheduled");
  const disable = `Then disable the scheduled task in Claude (its runs are held and send nothing until you do).`;
  if (client) {
    const wf = await client.getWorkflow(id);
    if (!wf) throw new Refused(`n8n has no workflow ${id}.`);
    if (client.isPublished(wf)) throw new Refused(`n8n's workflow ${id} is already published (someone switched it on): both sides may have sent. Nothing changed in n8n; the task is held.`);
    const mapped = staticDataFromCursors(C.definition, cursors, wf.staticData ?? deact?.detail?.staticData ?? null);
    if (client.kind === "mcp" && (mapped.carried.length || mapped.unsupported.length)) throw new Refused(`Over a sign-in n8n's saved poll position cannot be written, and ${[...mapped.carried, ...mapped.unsupported.map((u) => u.step)].map((s) => `"${s}"`).join(", ")} would then send again what the task sent. n8n stays off and the task is held. To roll back: ${NEEDS_KEY}.`);
    if (mapped.unsupported.length) throw new Refused(`Cannot carry the cursor for ${mapped.unsupported.map((u) => `"${u.step}" (${u.reason})`).join(", ")}: n8n would send again what the task sent. n8n stays off and the task is held; set n8n's cursor by hand before switching it on. --force is refused for this step.`);
    if (client.kind !== "mcp") {
      await client.putStaticData(id, wf, mapped.staticData);
      const check = await client.getWorkflow(id);
      const back = cursorsFromStaticData(C.definition, check?.staticData ?? null).cursors;
      const want = cursorsFromStaticData(C.definition, mapped.staticData).cursors;
      for (const step of mapped.carried) if (!sameJson(back[step], want[step])) throw new Refused(`n8n did not keep the static data written for "${step}"; n8n stays off.`);
    }
    await client.publish(id, deact?.detail?.activeVersionId ?? undefined);
    record(C, "rollback", { via: client.kind === "mcp" ? "mcp" : "api", workflowId: id, carried: mapped.carried, kept: mapped.kept, cursors, staticData: mapped.staticData });
    flush(C, "rollback");
    return { code: 0, text: [`Rolled back: n8n workflow ${id} published again from the task's cursor (${mapped.carried.join(", ") || "no poll trigger"}${mapped.kept.length ? `; n8n's own cursor kept for ${mapped.kept.join(", ")}` : ""}). n8n sends from here; the task is held.`, disable].join("\n"), data: { carried: mapped.carried, staticData: mapped.staticData } };
  }
  const mapped = staticDataFromCursors(C.definition, cursors, deact?.detail?.staticData ?? null);
  if (mapped.unsupported.length) throw new Refused(`Cannot carry the cursor for ${mapped.unsupported.map((u) => `"${u.step}" (${u.reason})`).join(", ")}; n8n stays off and the task is held.`);
  if (!flags.done) {
    return {
      code: 3,
      text: [
        "The task is held (it sends nothing now). No n8n API key (a sign-in cannot write the poll position), so in n8n by hand:",
        `  1. Keep the workflow off. On the n8n host: n8n export:workflow --id=${id ?? "<id>"} --output=workflow.json`,
        `  2. In workflow.json set "staticData" to exactly: ${JSON.stringify(mapped.staticData)}`,
        "  3. n8n import:workflow --input=workflow.json, then switch the workflow on in the editor.",
        `  4. Record it: cutover.mjs ${C.dir} rollback --done`,
        "The editor cannot change static data; the import (or N8N_BASE_URL + N8N_API_KEY) can.",
        disable,
      ].join("\n"),
      data: { staticData: mapped.staticData },
    };
  }
  record(C, "rollback", { via: "manual", workflowId: id, carried: mapped.carried, kept: mapped.kept, cursors, staticData: mapped.staticData });
  flush(C, "rollback");
  return { code: 0, text: `Recorded: rolled back by hand. n8n sends; the task is held.\n${disable}`, data: { staticData: mapped.staticData } };
}

async function sharedMoved(C, flags, ctx, pos) {
  const key = pos[0];
  const all = (C.report?.sharedState ?? []).filter((s) => SHARED_KINDS.has(s.kind) && (s.sharedWith ?? []).length).map((s) => `${s.kind}:${s.name}`);
  if (!key || !all.includes(key)) throw new Refused(all.length ? `usage: shared-moved <${all.join(" | ")}> --to "<where it lives now>"` : "This workflow shares no n8n state with other workflows.", 2);
  if (typeof flags.to !== "string" || !flags.to.trim()) throw new Refused(`Say where it lives now: shared-moved ${JSON.stringify(key)} --to "<database or sheet>"`, 2);
  startCutover(C);
  record(C, "shared-moved", { key, to: flags.to.trim().slice(0, 200) });
  flush(C, "shared state moved");
  const left = sharedPending(C).map((s) => s.key);
  return { code: 0, text: `Recorded: ${key} now lives in ${flags.to.trim()}, outside n8n.${left.length ? ` Still shared: ${left.join(", ")}.` : ""}`, data: { left } };
}

export const STEPS = {
  status,
  "dry-run": dryRun,
  parity,
  "deactivate-n8n": deactivate,
  seed,
  enable,
  "run-now": runNow,
  rollback,
  checklist: async (C) => {
    const list = checklist(C);
    return { code: 0, text: checklistText(list), data: { checklist: list, next: nextStep(list) } };
  },
  "shared-moved": sharedMoved,
};

// runStep(folder, step, {flags, pos, env, fetch, n8n, now, sleep}) -> {code, text, data?}
export async function runStep(folder, step, ctx = {}) {
  const fn = STEPS[step];
  if (!fn) return { code: 2, text: `unknown step "${step}"; steps: ${Object.keys(STEPS).join(", ")}` };
  ctx = { ...ctx, flags: ctx.flags ?? {}, closers: [] };
  try {
    const C = openFolder(folder, { now: ctx.now });
    return await fn(C, ctx.flags, ctx, ctx.pos ?? []);
  } catch (e) {
    if (e instanceof Refused) return { code: e.code, text: e.message };
    return { code: 1, text: `${step} failed: ${e.message}` };
  } finally {
    for (const close of ctx.closers) await close().catch(() => {});
  }
}

function parse(argv) {
  const pos = [];
  const flags = {};
  const BOOL = new Set(["json", "force", "done", "skip"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      if (BOOL.has(k) || argv[i + 1] === undefined || argv[i + 1].startsWith("--")) flags[k] = true;
      else flags[k] = argv[++i];
    } else pos.push(a);
  }
  return { pos, flags };
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const { pos, flags } = parse(process.argv.slice(2));
  if (pos.length < 2) {
    process.stderr.write(`usage: ${basename(process.argv[1])} <folder> <${Object.keys(STEPS).join("|")}> [--json] [--force] [--login <your n8n address>]\n`);
    process.exit(2);
  }
  const r = await runStep(pos[0], pos[1], { flags, pos: pos.slice(2) });
  process.stdout.write((flags.json ? JSON.stringify({ code: r.code, text: r.text, data: r.data ?? null }, null, 2) : r.text) + "\n");
  process.exit(r.code);
}
