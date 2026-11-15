#!/usr/bin/env node
// Runs one workflow in the bench's n8n with an injected trigger input, HTTP
// answered by the mock, and dummy credentials; prints {executionData, effects}.
// This is the n8n side of the Phase 5 bench. Contract: HEADLESS.md.
//
//   node evals/n8n/run-workflow.mjs <workflow.json> [--trigger input.json] [--mock fixtures.json]
//        [--credentials creds.json] [--via pin|cli|webhook|form] [--trigger-node name]
//        [--keep-pin] [--keep] [--stats] [--timeout s] [--now ISO] [--out result.json]
//
// --via pin      (default) REST: the trigger's output is pinned to the input and the
//                workflow runs from that trigger in manual mode. Any trigger kind.
// --via cli      `n8n execute`: the trigger is replaced by a Code node of the same name
//                that returns the input, fed by a Manual Trigger. Mode "cli".
// --via webhook  the workflow is activated and the input is sent to its production
//                webhook URL. Webhook triggers only; mode "webhook"; gives `response`.
// --via form     the workflow is activated and the first trigger item is submitted to the
//                Form Trigger's production URL as multipart (field-<index> by formFields, files
//                from the item's binary by label). Form triggers only; carries uploads, and
//                Form ending nodes keep their trigger (the run then stops in "waiting" at the
//                ending page, as n8n leaves it until the person's browser loads it); gives
//                `response`. Form node pages after the trigger are answered from `formPages`
//                (runWorkflow option) at n8n's form-waiting URL, as a browser submits them.
// Every mode awaits the executions the run starts (sub-workflows, by parent execution id)
// before the mock log is read (`children`).
//
// Trigger input (--trigger): a list of items ([{...}] or [{json: {...}}]), {items: [...]},
// or for a webhook {request: {method, path, headers, query, body}}. Without one: manual
// gets [{}], a schedule gets the item n8n's Schedule Trigger emits at --now.
// Mock fixtures (--mock): see mock-server.mjs. The workflow must call http://mock:8080.
// Credentials (--credentials): {"<credential name or type>": {<data>}}; each credential
// the workflow references is created with that data. Unmatched ones are listed as missing.
//
// The container must be up (container.mjs up) with the same work dir (N8N_BENCH_WORK).
// Exit 0 when n8n reports success, 1 otherwise, 2 on bad usage.

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { rest, n8nCli, waitHealthy, WORK, BASE, NAME } from "./container.mjs";
import { unwrap } from "../../skills/n8n-to-claude/scripts/analyze.mjs";

// ---------- flatted (n8n's REST encoding of execution data) ----------

// Port of flatted's parse: every string and object is stored once in a flat
// array; values that are strings are indices into it.
export function parseFlatted(text) {
  const input = JSON.parse(text, (_, v) => (typeof v === "string" ? new String(v) : v)).map((v) => (v instanceof String ? String(v) : v));
  const parsed = new Set();
  const revive = (out) => {
    const lazy = [];
    for (const k of Object.keys(out)) {
      const v = out[k];
      if (v instanceof String) {
        const tmp = input[v];
        if (typeof tmp === "object" && tmp !== null && !parsed.has(tmp)) {
          parsed.add(tmp);
          out[k] = undefined;
          lazy.push([k, tmp]);
        } else out[k] = tmp;
      }
    }
    for (const [k, tmp] of lazy) out[k] = revive(tmp);
    return out;
  };
  const root = input[0];
  if (typeof root !== "object" || root === null) return root;
  parsed.add(root);
  return revive(root);
}

// ---------- workflow preparation ----------

const isTrigger = (n) => !n.disabled && (/trigger$/i.test(n.type) || n.type === "n8n-nodes-base.webhook");
const PRIORITY = [/\.webhook$/, /chatTrigger$/, /formTrigger$/, /scheduleTrigger$|\.cron$|\.interval$/, /trigger$/i];
const LAST = [/manualTrigger$/, /executeWorkflowTrigger$/, /errorTrigger$/];

export function pickTrigger(wf, name) {
  if (name) {
    const n = wf.nodes.find((x) => x.name === name);
    if (!n) throw new Error(`no node named "${name}"`);
    return n;
  }
  const ts = wf.nodes.filter(isTrigger);
  if (!ts.length) throw new Error("the workflow has no enabled trigger");
  const rank = (n) => {
    const last = LAST.findIndex((r) => r.test(n.type));
    if (last >= 0) return 100 + last;
    const p = PRIORITY.findIndex((r) => r.test(n.type));
    return p >= 0 ? p : 50;
  };
  return [...ts].sort((a, b) => rank(a) - rank(b))[0];
}

const pad = (n) => String(n).padStart(2, "0");
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ordinal = (d) => `${d}${d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd" : d % 10 === 3 && d !== 13 ? "rd" : "th"}`;

// The item n8n 2.47's Schedule Trigger emits, in the workflow's timezone (the bench's
// GENERIC_TIMEZONE, n8n's default America/New_York, unless the template sets one).
export function scheduleItem(iso, timeZone = "America/New_York") {
  const d = new Date(iso);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "long" }).formatToParts(d).map((p) => [p.type, p.value]));
  const [Y, M, D, h, mi, se] = ["year", "month", "day", "hour", "minute", "second"].map((k) => Number(parts[k]));
  const offMin = Math.round((Date.UTC(Y, M - 1, D, h, mi, se) - Math.floor(d.getTime() / 1000) * 1000) / 60000);
  const off = `${offMin < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(offMin) / 60))}:${pad(Math.abs(offMin) % 60)}`;
  const time = `${h % 12 || 12}:${pad(mi)}:${pad(se)} ${h < 12 ? "am" : "pm"}`;
  return {
    timestamp: `${Y}-${pad(M)}-${pad(D)}T${pad(h)}:${pad(mi)}:${pad(se)}.000${off}`,
    "Readable date": `${MONTHS[M - 1]} ${ordinal(D)} ${Y}, ${time}`,
    "Readable time": time,
    "Day of week": parts.weekday,
    Year: String(Y),
    Month: MONTHS[M - 1],
    "Day of month": pad(D),
    Hour: pad(h),
    Minute: pad(mi),
    Second: pad(se),
    Timezone: `${timeZone} (UTC${off})`,
  };
}

const asItem = (x) => (x && typeof x === "object" && !Array.isArray(x) && "json" in x ? x : { json: x ?? {} });

// The trigger's output items for pin and cli modes.
export function triggerItems(node, input, now, timeZone) {
  if (Array.isArray(input)) return input.map(asItem);
  if (input && Array.isArray(input.items)) return input.items.map(asItem);
  if (input && input.request) {
    const q = input.request;
    const path = q.path ?? node.parameters?.path ?? "";
    return [{ json: { headers: lowerKeys(q.headers ?? {}), params: q.params ?? {}, query: q.query ?? {}, body: q.body ?? {}, webhookUrl: `${BASE}/webhook/${path}`, executionMode: "production" } }];
  }
  if (input !== undefined) return [asItem(input)];
  if (/scheduleTrigger$/.test(node.type)) return [{ json: scheduleItem(now, timeZone || undefined) }];
  return [{ json: {} }];
}

const lowerKeys = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));

// Replaces the trigger with a Code node of the same name that returns `items`,
// fed by a Manual Trigger; other triggers are disabled so `n8n execute` starts there.
export function swapTrigger(wf, trigger, items) {
  const start = "__bench_start";
  const nodes = wf.nodes.map((n) => {
    if (n.name === trigger.name) {
      return { id: n.id, name: n.name, type: "n8n-nodes-base.code", typeVersion: 2, position: n.position, parameters: { jsCode: `return ${JSON.stringify(items)};` } };
    }
    return isTrigger(n) ? { ...n, disabled: true } : n;
  });
  const [x = 0, y = 0] = trigger.position ?? [];
  nodes.push({ id: "00000000-0000-4000-8000-00000000be0c", name: start, type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [x - 240, y], parameters: {} });
  return { ...wf, nodes, connections: { ...wf.connections, [start]: { main: [[{ node: trigger.name, type: "main", index: 0 }]] } } };
}

// Credential references: [{node, type, id, name}].
export function credentialRefs(wf) {
  const out = [];
  for (const n of wf.nodes) {
    for (const [type, ref] of Object.entries(n.credentials ?? {})) {
      const r = typeof ref === "string" ? { id: null, name: ref } : ref ?? {};
      out.push({ node: n.name, type, id: r.id ?? null, name: r.name ?? type });
    }
  }
  return out;
}

// ---------- run ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DONE = new Set(["success", "error", "crashed", "canceled", "waiting"]);

async function waitExecution(id, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const ex = await rest("GET", `/executions/${id}`);
    if (DONE.has(ex.status) || ex.finished) return ex;
    if (Date.now() - t0 > timeoutMs) {
      await rest("POST", `/executions/${id}/stop`, {}).catch(() => {});
      throw new Error(`execution ${id} still ${ex.status} after ${timeoutMs / 1000}s (stopped)`);
    }
    await sleep(100);
  }
}

async function latestExecution(workflowId, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const list = await rest("GET", `/executions?filter=${encodeURIComponent(JSON.stringify({ workflowId }))}&limit=1`);
    const first = (list.results ?? list)[0];
    if (first) return waitExecution(first.id, Math.max(1000, timeoutMs - (Date.now() - t0)));
    if (Date.now() - t0 > timeoutMs) throw new Error(`no execution of ${workflowId} after ${timeoutMs / 1000}s`);
    await sleep(100);
  }
}

// An execution can outlive its workflow (deleting a workflow does not cancel a
// run, and a model node keeps retrying), and its late requests would land in the
// next run's effects. Stop anything still running before a run starts.
async function stopRunning() {
  const list = await rest("GET", `/executions?filter=${encodeURIComponent(JSON.stringify({ status: ["running", "new", "waiting"] }))}&limit=50`);
  for (const e of list.results ?? []) await rest("POST", `/executions/${e.id}/stop`, {}).catch(() => {});
}

// PROPOSALS P69: a killed bench process never reaches runWorkflow's `finally`, so its workflow
// stays in n8n (active, for a form, webhook or self-calling run) and can fire during later runs,
// its requests landing in their mock logs. At start the bench removes every workflow named
// `bench: …` (deactivated, archived, deleted) and stops running executions. Returns how many.
export async function cleanupBenchWorkflows() {
  const seen = new Map();
  for (const archived of [false, true]) {
    const q = `filter=${encodeURIComponent(JSON.stringify({ name: "bench: " }))}&take=500${archived ? "&showArchived=true" : ""}`;
    const list = await rest("GET", `/workflows?${q}`).catch(() => []);
    for (const w of Array.isArray(list) ? list : list?.data ?? []) if (String(w.name ?? "").startsWith("bench: ")) seen.set(w.id, w);
  }
  for (const w of seen.values()) {
    if (w.active) await rest("POST", `/workflows/${w.id}/deactivate`, {}).catch(() => {});
    if (!w.isArchived) await rest("POST", `/workflows/${w.id}/archive`, {}).catch(() => {});
    await rest("DELETE", `/workflows/${w.id}`).catch(() => {});
  }
  await stopRunning().catch(() => {});
  return seen.size;
}

// Streams `docker stats` while a run is in flight; returns the peak MiB.
export function statsSampler() {
  let peak = 0;
  const p = spawn("docker", ["stats", "--format", "{{.MemUsage}}", NAME], { stdio: ["ignore", "pipe", "ignore"] });
  p.stdout.on("data", (b) => {
    for (const m of b.toString().matchAll(/([\d.]+)\s*(KiB|MiB|GiB)\s*\//g)) peak = Math.max(peak, Number(m[1]) * { KiB: 1 / 1024, MiB: 1, GiB: 1024 }[m[2]]);
  });
  return { stop: () => (p.kill(), Math.round(peak * 10) / 10) };
}

function readEffects() {
  const text = readFileSync(join(WORK, "effects.jsonl"), "utf8");
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function setMock(fixtures) {
  const tmp = join(WORK, "fixtures.json.tmp");
  writeFileSync(tmp, JSON.stringify(fixtures ?? {}, null, 2) + "\n");
  renameSync(tmp, join(WORK, "fixtures.json"));
  writeFileSync(join(WORK, "effects.jsonl"), "");
}

// Every node's runs as {status, executionTime, error, items: {main: [[json, ...], ...]}}.
export function summariseRunData(runData = {}) {
  const out = {};
  for (const [name, runs] of Object.entries(runData)) {
    out[name] = runs.map((r) => ({
      status: r.executionStatus,
      executionTime: r.executionTime,
      ...(r.error ? { error: r.error.message ?? String(r.error) } : {}),
      items: Object.fromEntries(Object.entries(r.data ?? {}).map(([k, outputs]) => [k, (outputs ?? []).map((items) => (items ?? []).map((i) => i.json))])),
    }));
  }
  return out;
}

// pinTrigger false (pin mode): the trigger is not pinned, so a poll trigger polls once in manual
// mode through the mock (binary data, such as Gmail attachments, cannot be pinned).
// formPages (PROPOSALS P20, --via form): the Form node pages n8n serves after the trigger's
// submission, answered in order. children: executions the run starts (sub-workflow calls,
// waitForSubWorkflow false included) are awaited by parent execution id before the mock log is
// read, so their requests are in `effects`; their statuses are in `children`.
export async function runWorkflow(workflow, { trigger, mock, credentials = {}, via = "pin", triggerNode, keepPin = false, keep = false, stats = false, timeoutS = 120, now = "2026-11-16T09:00:00Z", pinTrigger = true, activate = false, formPages = [] } = {}) {
  await waitHealthy(30_000);
  const wf = structuredClone(workflow);
  const t = pickTrigger(wf, triggerNode);
  const items = triggerItems(t, trigger, now, workflow.settings?.timezone);

  // Credentials first, so node references point at real ids.
  const created = [];
  const missing = [];
  const madeByKey = new Map();
  for (const ref of credentialRefs(wf)) {
    const data = credentials[ref.name] ?? credentials[ref.type];
    if (!data) {
      missing.push(ref);
      continue;
    }
    const key = `${ref.type}\u0000${ref.name}`;
    if (!madeByKey.has(key)) {
      const c = await rest("POST", "/credentials", { name: ref.name, type: ref.type, data });
      madeByKey.set(key, c.id);
      created.push({ id: c.id, name: ref.name, type: ref.type });
    }
    const node = wf.nodes.find((n) => n.name === ref.node);
    node.credentials[ref.type] = { id: madeByKey.get(key), name: ref.name };
  }

  // Save settings only decide whether n8n keeps the execution; the bench reads every run back,
  // so they are forced on (a template with saveManualExecutions: false is never readable).
  const settings = { ...(wf.settings ?? { executionOrder: "v1" }), saveManualExecutions: true, saveDataSuccessExecution: "all", saveDataErrorExecution: "all" };
  let body = { name: `bench: ${wf.name ?? "workflow"}`, nodes: wf.nodes, connections: wf.connections ?? {}, settings, staticData: wf.staticData ?? undefined, meta: wf.meta ?? undefined };
  const pin = keepPin ? { ...(wf.pinData ?? {}) } : {};
  if (via === "pin") {
    if (pinTrigger) pin[t.name] = items;
    else delete pin[t.name];
  }
  else if (via === "cli") body = { ...body, ...swapTrigger({ nodes: body.nodes, connections: body.connections }, t, items) };
  else if (via === "webhook") {
    if (t.type !== "n8n-nodes-base.webhook") throw new Error(`--via webhook needs a Webhook trigger, not ${t.type}`);
  } else if (via === "form") {
    if (t.type !== "n8n-nodes-base.formTrigger") throw new Error(`--via form needs a Form Trigger, not ${t.type}`);
  } else throw new Error(`unknown --via ${via}`);
  body.pinData = pin;

  await stopRunning();
  setMock(mock);
  const res = await rest("POST", "/workflows", body);
  const wid = res.id;
  let ex, response, cli, wallMs, peakMiB, children = [];
  const sampler = stats ? statsSampler() : null;
  const t0 = Date.now();
  try {
    try {
      if (via === "pin") {
        // A workflow that calls itself (Execute Workflow / workflow tool on $workflow.id) needs
        // to be active: n8n 2.x refuses to run an inactive workflow as a sub-workflow.
        if (activate) await rest("POST", `/workflows/${wid}/activate`, { versionId: res.versionId });
        const r = await rest("POST", `/workflows/${wid}/run`, { triggerToStartFrom: { name: t.name } });
        if (!r.executionId) throw new Error(`n8n did not start a run: ${JSON.stringify(r)}`);
        ex = await waitExecution(r.executionId, timeoutS * 1000);
      } else if (via === "cli") {
        cli = n8nCli(["execute", `--id=${wid}`, "--rawOutput"]);
        ex = await latestExecution(wid, timeoutS * 1000);
      } else if (via === "form") {
        await rest("POST", `/workflows/${wid}/activate`, { versionId: res.versionId });
        response = await submitForm(t, items[0] ?? { json: {} }, timeoutS, { pages: formPages, wf });
        // The execution the submission started (the form-waiting URL names it), never a child.
        ex = response.executionId ? await waitExecution(response.executionId, timeoutS * 1000) : await latestExecution(wid, timeoutS * 1000);
      } else {
        await rest("POST", `/workflows/${wid}/activate`, { versionId: res.versionId });
        response = await callWebhook(t, trigger?.request ?? {}, timeoutS);
        ex = await latestExecution(wid, timeoutS * 1000);
      }
    } finally {
      wallMs = Date.now() - t0;
      peakMiB = sampler?.stop();
    }
    // wallMs is the run's own; the children's wait comes after it.
    children = await awaitChildren(wid, ex.id, Math.max(5000, timeoutS * 1000 - wallMs));
    const data = typeof ex.data === "string" ? parseFlatted(ex.data) : ex.data;
    const resultData = data?.resultData ?? {};
    return {
      workflow: { id: wid, name: wf.name ?? null },
      via,
      trigger: { node: t.name, type: t.type, items: items.map((i) => i.json) },
      executionId: ex.id,
      status: ex.status,
      mode: ex.mode,
      startedAt: ex.startedAt,
      stoppedAt: ex.stoppedAt,
      executionMs: ex.startedAt && ex.stoppedAt ? Date.parse(ex.stoppedAt) - Date.parse(ex.startedAt) : null,
      wallMs,
      ...(peakMiB !== undefined ? { peakMiB } : {}),
      // A task runner's error (a Code node in JS or Python) names no node; the last node that ran
      // failing is the one.
      ...(resultData.error ? { error: { message: resultData.error.message, node: resultData.error.node?.name ?? (resultData.runData?.[resultData.lastNodeExecuted]?.at(-1)?.error ? resultData.lastNodeExecuted : null) } } : {}),
      lastNode: resultData.lastNodeExecuted ?? null,
      nodes: summariseRunData(resultData.runData),
      effects: readEffects(),
      ...(children.length ? { children: children.map(({ id, status, mode, error, nodes }) => ({ id, status, mode, ...(error ? { error } : {}), nodes })) } : {}),
      ...(response ? { response } : {}),
      ...(cli ? { cli: { status: cli.status, ms: cli.ms } } : {}),
      credentials: { created: created.map(({ name, type }) => ({ name, type })), missing },
      executionData: resultData,
    };
  } finally {
    if (!keep) {
      if (via === "webhook" || via === "form" || activate) await rest("POST", `/workflows/${wid}/deactivate`, {}).catch(() => {});
      if (ex) await rest("POST", "/executions/delete", { ids: [ex.id, ...children.map((c) => c.id)] }).catch(() => {});
      await rest("POST", `/workflows/${wid}/archive`, {}).catch(() => {});
      await rest("DELETE", `/workflows/${wid}`).catch(() => {});
      for (const c of created) await rest("DELETE", `/credentials/${c.id}`).catch(() => {});
    }
  }
}

// The multipart body a person's submission of this Form Trigger sends for `item`: each form
// field as field-<index>, its value from item.json[label]; a file field from item.binary.
export function formBody(t, item) {
  const fd = new FormData();
  const fields = t.parameters?.formFields?.values ?? [];
  fields.forEach((f, i) => {
    const label = f.fieldLabel ?? f.fieldName ?? `field-${i}`;
    if (f.fieldType === "file") {
      const b = item.binary?.[label.replace(/\W/g, "_")] ?? item.binary?.[label];
      if (b?.data) fd.append(`field-${i}`, new Blob([Buffer.from(b.data, "base64")], { type: b.mimeType ?? "application/octet-stream" }), b.fileName ?? "upload");
      return;
    }
    const v = item.json?.[label];
    if (v === undefined || v === null) return;
    for (const x of [].concat(v)) fd.append(`field-${i}`, typeof x === "string" ? x : JSON.stringify(x));
  });
  return fd;
}

// The multipart body for one Form node page (PROPOSALS P20): `fields` by label (the page node's
// formFields, as for the trigger) or a list by position (a page whose fields are defined at run
// time, e.g. from a model's output), each as field-<index>.
export function formPageBody(node, fields) {
  if (Array.isArray(fields)) {
    const fd = new FormData();
    fields.forEach((v, i) => {
      if (v === undefined || v === null) return;
      for (const x of [].concat(v)) fd.append(`field-${i}`, typeof x === "string" ? x : JSON.stringify(x));
    });
    return fd;
  }
  return formBody(node ?? { parameters: {} }, { json: fields ?? {} });
}

// The execution id in n8n's form-waiting URL (<base>/form-waiting/<id>?signature=...).
export const waitingExecutionId = (url) => /\/form-waiting\/([^/?#]+)/.exec(String(url ?? ""))?.[1] ?? null;

// PROPOSALS P67: a form is submitted as a browser submits it. n8n's Form Trigger with
// `ignoreBots` answers 401 to a user agent `isbot` matches (Node's fetch sends one), and the run
// never starts. Each form page is awaited at most FORM_PAGE_WAIT_S; a form or a page n8n never
// serves fails the run with a named reason ("form not served", "form page not served") instead
// of waiting out the bench's timeout.
export const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
export const FORM_PAGE_WAIT_S = Number(process.env.N2C_BENCH_FORM_PAGE_WAIT_S || 60);
const browserHeaders = { "user-agent": BROWSER_UA, accept: "text/html,application/json;q=0.9,*/*;q=0.8" };

async function submitForm(t, item, timeoutS, { pages = [], wf = null } = {}) {
  // Form Trigger v2.2 keeps a custom path in options.path (earlier versions in path).
  const path = t.parameters?.path || t.parameters?.options?.path || t.webhookId;
  const t0 = Date.now();
  let first;
  for (;;) {
    const r = await fetch(`${BASE}/form/${path}`, { method: "POST", headers: browserHeaders, body: formBody(t, item), signal: AbortSignal.timeout(timeoutS * 1000) });
    const text = await r.text();
    // Activation registers the form asynchronously; until then n8n answers 404.
    if (r.status === 404) {
      if (Date.now() - t0 > 10_000) throw new Error(`form ${path} still 404 after 10 s: ${text.slice(0, 300)}`);
      await sleep(250);
      continue;
    }
    first = { status: r.status, headers: Object.fromEntries(r.headers), body: text.slice(0, 4000) };
    break;
  }
  if (first.status >= 400) throw new Error(`form not served: POST /form/${path} answered HTTP ${first.status} ${first.body.slice(0, 200)}`.trim());
  // A trigger followed by Form nodes answers {formWaitingUrl} (n8n's formPage response mode);
  // the browser then waits until the execution waits for a form and submits each page there.
  let waitingUrl = null;
  try {
    waitingUrl = JSON.parse(first.body).formWaitingUrl ?? null;
  } catch {}
  const executionId = waitingExecutionId(waitingUrl);
  const submitted = [];
  for (const [k, page] of pages.entries()) {
    if (!waitingUrl) {
      submitted.push({ page: k, node: page.node ?? null, skipped: "n8n served no form page" });
      continue;
    }
    const u = new URL(waitingUrl);
    const statusUrl = `${u.origin}${u.pathname.replace(/\/$/, "")}/n8n-execution-status${u.search}`;
    let status = "";
    const waitS = Math.min(timeoutS, FORM_PAGE_WAIT_S);
    for (const t1 = Date.now(); Date.now() - t1 < waitS * 1000; await sleep(250)) {
      status = await fetch(statusUrl, { headers: browserHeaders }).then((x) => x.text()).catch((e) => `error: ${e.message}`);
      if (status === "form-waiting" || ["success", "error", "canceled", "crashed"].includes(status)) break;
    }
    // The execution still runs (or waits on something else) and never asks for this page.
    if (status !== "form-waiting" && !["success", "error", "canceled", "crashed"].includes(status)) {
      if (executionId) await rest("POST", `/executions/${executionId}/stop`, {}).catch(() => {});
      throw new Error(`form page not served: page ${k + 1}${page.node ? ` (${page.node})` : ""} after ${waitS} s, execution ${status || "not waiting"}`);
    }
    if (status !== "form-waiting") {
      submitted.push({ page: k, node: page.node ?? null, skipped: `execution ${status || "not waiting"}` });
      waitingUrl = null;
      continue;
    }
    const node = page.node ? wf?.nodes?.find((n) => n.name === page.node) : null;
    const r = await fetch(waitingUrl, { method: "POST", headers: browserHeaders, body: formPageBody(node, page.fields), signal: AbortSignal.timeout(timeoutS * 1000) });
    const text = await r.text();
    submitted.push({ page: k, node: page.node ?? null, status: r.status });
    try {
      waitingUrl = JSON.parse(text).formWaitingUrl ?? waitingUrl;
    } catch {}
  }
  return { ...first, ...(executionId ? { executionId } : {}), ...(pages.length ? { pages: submitted } : {}) };
}

// Executions started by `parentId` (n8n keeps the parent in the child's run data,
// parentExecution.executionId), and theirs in turn, each awaited until it ends. A sub-workflow
// started without waiting may begin after its parent ended, so the list is read again until it
// stays the same for two seconds.
async function awaitChildren(workflowId, parentId, timeoutMs) {
  const t0 = Date.now();
  const parents = new Set([String(parentId)]);
  const known = new Map();
  let stableSince = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const list = await rest("GET", `/executions?filter=${encodeURIComponent(JSON.stringify({ workflowId }))}&limit=50`).catch(() => ({ results: [] }));
    let grew = false;
    for (const e of list.results ?? list ?? []) {
      const id = String(e.id);
      if (parents.has(id) || known.has(id)) continue;
      const full = await rest("GET", `/executions/${id}`).catch(() => null);
      const data = full && (typeof full.data === "string" ? parseFlatted(full.data) : full.data);
      const parent = data?.parentExecution?.executionId;
      if (parent === undefined || !parents.has(String(parent))) continue;
      known.set(id, null);
      parents.add(id);
      grew = true;
    }
    if (grew) stableSince = Date.now();
    const open = [...known.keys()].filter((id) => !known.get(id));
    for (const id of open) {
      const done = await waitExecution(id, Math.max(1000, timeoutMs - (Date.now() - t0))).catch((err) => ({ id, status: "timeout", error: err.message }));
      known.set(id, done);
    }
    if (!grew && Date.now() - stableSince >= 2000) break;
    await sleep(500);
  }
  return [...known.entries()].map(([id, ex]) => {
    const data = ex && (typeof ex.data === "string" ? parseFlatted(ex.data) : ex.data);
    const rd = data?.resultData ?? {};
    return { id, status: ex?.status ?? "unknown", mode: ex?.mode, ...(rd.error ? { error: { message: rd.error.message, node: rd.error.node?.name ?? null } } : ex?.error ? { error: { message: ex.error } } : {}), nodes: summariseRunData(rd.runData) };
  });
}

// Sends the trigger request to the production webhook URL. Retries while n8n
// still answers "not registered" (activation registers webhooks asynchronously).
async function callWebhook(t, q, timeoutS) {
  const path = q.path ?? t.parameters?.path;
  const method = q.method ?? t.parameters?.httpMethod ?? "GET";
  const qs = q.query ? `?${new URLSearchParams(q.query)}` : "";
  const isJson = q.body !== undefined && typeof q.body !== "string";
  const t0 = Date.now();
  for (;;) {
    const r = await fetch(`${BASE}/webhook/${path}${qs}`, {
      method,
      headers: { ...(isJson ? { "content-type": "application/json" } : {}), ...(q.headers ?? {}) },
      body: ["GET", "HEAD"].includes(method) ? undefined : isJson ? JSON.stringify(q.body) : q.body,
      signal: AbortSignal.timeout(timeoutS * 1000),
    });
    const text = await r.text();
    if (r.status === 404 && /not registered/.test(text)) {
      if (Date.now() - t0 > 10_000) throw new Error(`webhook ${method} ${path} still not registered after 10 s: ${text.slice(0, 300)}`);
      await sleep(250);
      continue;
    }
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: r.status, headers: Object.fromEntries(r.headers), body };
  }
}

// ---------- CLI ----------

function parseArgs(argv) {
  const a = { file: null };
  const vals = { "--trigger": "trigger", "--mock": "mock", "--credentials": "credentials", "--via": "via", "--trigger-node": "triggerNode", "--timeout": "timeoutS", "--now": "now", "--out": "out" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k in vals) {
      if (i + 1 >= argv.length) throw new Error(`${k} needs a value`);
      a[vals[k]] = argv[++i];
    } else if (k === "--keep-pin") a.keepPin = true;
    else if (k === "--keep") a.keep = true;
    else if (k === "--stats") a.stats = true;
    else if (k.startsWith("--")) throw new Error(`unknown flag ${k}`);
    else if (!a.file) a.file = k;
    else throw new Error(`unexpected argument ${k}`);
  }
  if (!a.file) throw new Error("usage: run-workflow.mjs <workflow.json> [--trigger f] [--mock f] [--credentials f] [--via pin|cli|webhook] ...");
  return a;
}

async function main() {
  let a;
  try {
    a = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const read = (p) => JSON.parse(readFileSync(p, "utf8"));
  const ws = unwrap(read(a.file), a.file);
  if (!ws || ws.length !== 1) {
    console.error(`${a.file}: expected exactly one workflow, found ${ws?.length ?? 0}`);
    process.exit(2);
  }
  const wf = { ...ws[0].wf, name: ws[0].name || ws[0].wf.name };
  try {
    const r = await runWorkflow(wf, {
      trigger: a.trigger ? read(a.trigger) : undefined,
      mock: a.mock ? read(a.mock) : {},
      credentials: a.credentials ? read(a.credentials) : {},
      via: a.via ?? "pin",
      triggerNode: a.triggerNode,
      keepPin: a.keepPin,
      keep: a.keep,
      stats: a.stats,
      timeoutS: a.timeoutS ? Number(a.timeoutS) : 120,
      now: a.now ?? "2026-11-16T09:00:00Z",
    });
    const text = JSON.stringify(r, null, 2) + "\n";
    if (a.out) {
      writeFileSync(a.out, text);
      console.error(`${r.status} in ${r.wallMs} ms, ${r.effects.length} effects -> ${a.out}`);
    } else process.stdout.write(text);
    process.exit(r.status === "success" ? 0 : 1);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
