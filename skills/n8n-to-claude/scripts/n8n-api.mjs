// n8n's side of a cutover (scripts/cutover.mjs): its public REST API and the static data its
// poll triggers keep, mapped to and from the runner's poll cursor. Zero dependencies.
//
// Public API (v1, header X-N8N-API-KEY), as observed on n8n 2.47.7 (references/cutover.md):
//   GET  /workflows/{id}                  carries staticData (null until a poll saved some)
//   PUT  /workflows/{id}?publishIfActive=false  {name, nodes, connections, settings, staticData}
//                                         replaces staticData; accepted while published too,
//                                         but a running poller keeps its own copy, so it is
//                                         only written while the workflow is unpublished
//   POST /workflows/{id}/unpublish        n8n 2.x; /deactivate is the deprecated alias
//   POST /workflows/{id}/publish {versionId?}  n8n 2.x; /activate is the deprecated alias
//   GET  /executions?workflowId=&status=running
//   GET  /executions?workflowId=&includeData=true  data.resultData.runData as an object
// Unpublishing and publishing keep staticData. With N8N_POLLER_DURABLE_CURSORS_ENABLED=true
// n8n keeps poll cursors in its poller_state table instead, which the API does not reach.
//
// The key comes from the environment only (N8N_API_KEY) and is never written or printed.
//
// Static data, derived from n8n's node code (read, not copied):
//   getWorkflowStaticData('node') is staticData["node:<node name>"].
//   Gmail (n8n-nodes-base.gmailTrigger): {lastTimeChecked: unix seconds, possibleDuplicates:
//     [ids fetched in the last poll that found mail]}; from typeVersion 1.1 nested once more
//     under the node name. The query is `after:<lastTimeChecked>`, inclusive at the second, and
//     the ids filter what it returns again. v1.4 adds pendingMessageIds and failedFetches
//     (found but not delivered yet). The first production poll sets lastTimeChecked to now.
//     Observed on 2.47.7 (evals/cutover/e2e.mjs): n8n marks static data for saving through a
//     proxy made when the workflow is loaded, so the nested object a fresh node creates on its
//     first poll is not watched, and the database keeps the activation-time cursor until the
//     workflow is next loaded (re-activation or restart). The poller's own copy moves on. So
//     the cursor taken at deactivation is also read from n8n's executions: the trigger's
//     emitted items say what n8n delivered, and the later of the two is n8n's cursor.
//   Google Drive (googleDriveTrigger): {lastTimeChecked: ISO time of the last poll}; the query
//     is `createdTime > '<it>'` (or modifiedTime), no ids.
//   Google Sheets (googleSheetsTrigger, rowAdded): {documentId, sheetId, lastIndexChecked: rows
//     read including the header}; new rows are the ones past it. A different documentId or
//     sheetId resets the cursor, so those two are kept from n8n's own copy.
// The runner's cursor ({value, ids}, runtime/src/adapt.mjs) uses the same rules: Gmail with
// resolutionMs 1000 and the ids of every message in the max second; Drive by time; Sheets by
// row_number (data from row 2, so the last row number equals lastIndexChecked).

const BASE = "n8n-nodes-base.";
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

// ---------- client ----------

export function n8nFromEnv(env = process.env) {
  const base = String(env.N8N_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const key = String(env.N8N_API_KEY ?? "").trim();
  if (!base || !key) return null;
  return { base: base.replace(/\/api\/v1$/, ""), key };
}

export class N8nApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function createN8nClient({ base, key, fetch: fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const redact = (s) => String(s).split(key).join("[key]");
  async function call(method, path, body, { allow404 = false } = {}) {
    let r;
    try {
      r = await fetchImpl(`${base}/api/v1${path}`, { method, headers: { "X-N8N-API-KEY": key, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch (e) {
      throw new N8nApiError(`n8n API ${method} ${path}: ${redact(e.cause?.code ?? e.message)}`, 0);
    }
    const text = await r.text();
    let json = text;
    try {
      json = JSON.parse(text);
    } catch {}
    if (r.status === 404 && allow404) return null;
    if (!r.ok) throw new N8nApiError(`n8n API ${method} ${path}: HTTP ${r.status} ${redact(typeof json === "string" ? json : json?.message ?? JSON.stringify(json)).slice(0, 300)}`, r.status, json);
    return json;
  }
  const isPublished = (wf) => !!(wf?.activeVersionId ?? wf?.active);
  return {
    isPublished,
    getWorkflow: (id) => call("GET", `/workflows/${encodeURIComponent(id)}`, undefined, { allow404: true }),
    // Replaces staticData and nothing else (the same nodes, connections and settings).
    async putStaticData(id, wf, staticData) {
      return call("PUT", `/workflows/${encodeURIComponent(id)}?publishIfActive=false`, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings ?? {}, staticData });
    },
    async unpublish(id) {
      const r = await call("POST", `/workflows/${encodeURIComponent(id)}/unpublish`, undefined, { allow404: true });
      return r ?? call("POST", `/workflows/${encodeURIComponent(id)}/deactivate`);
    },
    async publish(id, versionId) {
      const body = versionId ? { versionId } : {};
      const r = await call("POST", `/workflows/${encodeURIComponent(id)}/publish`, body, { allow404: true });
      return r ?? call("POST", `/workflows/${encodeURIComponent(id)}/activate`, body);
    },
    // The latest executions with their data (the trigger's emitted items).
    async recentExecutions(id, limit = 25) {
      const r = await call("GET", `/executions?workflowId=${encodeURIComponent(id)}&includeData=true&limit=${limit}`);
      return (Array.isArray(r?.data) ? r.data : []).map((e) => ({ ...e, data: typeof e.data === "string" ? (() => { try { return JSON.parse(e.data); } catch { return null; } })() : e.data }));
    },
    async runningExecutions(id) {
      const r = await call("GET", `/executions?workflowId=${encodeURIComponent(id)}&status=running&limit=50`);
      return Array.isArray(r?.data) ? r.data : [];
    },
    // After unpublishing: wait until no execution of the workflow runs (a poll that found items
    // saves its static data when it emits), then until two reads of staticData agree.
    async settledStaticData(id, { timeoutMs = 120_000, gapMs = 1500 } = {}) {
      const t0 = Date.now();
      while ((await this.runningExecutions(id)).length) {
        if (Date.now() - t0 > timeoutMs) throw new N8nApiError(`n8n still runs an execution of workflow ${id} after ${timeoutMs / 1000}s; try again when it ends`, 0);
        await sleep(gapMs);
      }
      let prev = JSON.stringify((await this.getWorkflow(id))?.staticData ?? null);
      for (;;) {
        await sleep(gapMs);
        const wf = await this.getWorkflow(id);
        const now = JSON.stringify(wf?.staticData ?? null);
        if (now === prev) return { workflow: wf, staticData: wf?.staticData ?? null };
        if (Date.now() - t0 > timeoutMs) throw new N8nApiError(`n8n's static data for workflow ${id} kept changing for ${timeoutMs / 1000}s`, 0);
        prev = now;
      }
    },
  };
}

// ---------- static data <-> cursor ----------

export const nodeKey = (name) => `node:${name}`;
const parseStatic = (sd) => {
  if (typeof sd === "string") {
    try {
      return JSON.parse(sd) ?? {};
    } catch {
      return {};
    }
  }
  return isObj(sd) ? sd : {};
};

// The poll triggers whose cursor carries over, by n8n node type. `nested`: the node keeps its
// fields one level down, under its own name. `toCursor(ns, step)` -> cursor | null (n8n has no
// cursor yet); `fromCursor(ns, cursor, step)` -> the node's static data with n8n's cursor
// fields set from ours. `unsupported(step)` -> a reason, or null.
export const POLL_STATE = {
  [BASE + "gmailTrigger"]: {
    nested: (v) => Number(v ?? 1) > 1,
    unsupported: (step) => (Number(step.poll?.cursor?.resolutionMs) === 1000 ? null : "the cursor does not compare whole seconds (regenerate the folder so its Gmail cursor has resolutionMs 1000)"),
    toCursor(ns) {
      const t = Number(ns?.lastTimeChecked);
      if (!Number.isFinite(t) || t <= 0) return null;
      return { value: new Date(Math.floor(t) * 1000).toISOString(), ids: [...new Set((ns.possibleDuplicates ?? []).map(String))].sort() };
    },
    // Items n8n emitted (its executions): the newest second, with every id in it.
    fromEmitted(items) {
      const dated = items.map((j) => ({ id: j?.id, s: j?.internalDate !== undefined ? Math.floor(Number(j.internalDate) / 1000) : Math.floor(Date.parse(j?.date ?? "") / 1000) })).filter((x) => x.id !== undefined && Number.isFinite(x.s));
      if (!dated.length) return null;
      const top = Math.max(...dated.map((x) => x.s));
      return { value: new Date(top * 1000).toISOString(), ids: [...new Set(dated.filter((x) => x.s === top).map((x) => String(x.id)))].sort() };
    },
    later(a, b) {
      const sa = Math.floor(Date.parse(a.value) / 1000);
      const sb = Math.floor(Date.parse(b.value) / 1000);
      if (sa !== sb) return sa > sb ? a : b;
      return { value: a.value, ids: [...new Set([...(a.ids ?? []), ...(b.ids ?? [])])].sort() };
    },
    fromCursor(ns, cursor) {
      const ms = Date.parse(cursor.value);
      const out = { ...ns, lastTimeChecked: Math.floor(ms / 1000), possibleDuplicates: [...(cursor.ids ?? [])].map(String) };
      // Found-but-undelivered ids from before the cutover: the task delivered them since.
      delete out.pendingMessageIds;
      delete out.failedFetches;
      delete out.noProgressTicks;
      return out;
    },
  },
  [BASE + "googleDriveTrigger"]: {
    nested: () => false,
    unsupported: (step) => (["specificFile"].includes(step.params?.triggerOn) || (step.params?.triggerOn === "specificFolder" && step.params?.event === "watchFolderUpdated") ? "n8n reads one watched item directly; its time cursor is not the runner's query cursor" : null),
    toCursor(ns) {
      return typeof ns?.lastTimeChecked === "string" && Number.isFinite(Date.parse(ns.lastTimeChecked)) ? { value: ns.lastTimeChecked, ids: [] } : null;
    },
    fromCursor(ns, cursor) {
      return { ...ns, lastTimeChecked: new Date(Date.parse(cursor.value)).toISOString() };
    },
  },
  [BASE + "googleSheetsTrigger"]: {
    nested: () => false,
    unsupported: (step) => ((step.params?.event ?? "anyUpdate") === "rowAdded" ? null : "only rowAdded keeps a row cursor; update events compare revisions"),
    toCursor(ns) {
      const n = Number(ns?.lastIndexChecked);
      return Number.isInteger(n) && n >= 0 ? { value: n } : null;
    },
    fromCursor(ns, cursor) {
      if (!ns?.documentId || ns.sheetId === undefined) throw new Error("n8n's own copy of the sheet's documentId and sheetId is missing, and without them n8n resets its cursor");
      return { ...ns, lastIndexChecked: Number(cursor.value) };
    },
  },
};

export function pollSteps(definition) {
  return Object.entries(definition.steps ?? {})
    .filter(([, s]) => s.kind === "trigger" && s.poll && s.settings?.disabled !== true)
    .map(([name, s]) => ({ name, step: s, spec: POLL_STATE[s.n8n?.type] ?? null }));
}

// The node's own static data (after the version nesting), or {}.
export function readNodeState(staticData, name, step) {
  const sd = parseStatic(staticData);
  const outer = isObj(sd[nodeKey(name)]) ? sd[nodeKey(name)] : {};
  const spec = POLL_STATE[step?.n8n?.type];
  if (spec?.nested(step?.n8n?.typeVersion)) return isObj(outer[name]) ? outer[name] : {};
  return outer;
}
export function writeNodeState(staticData, name, step, ns) {
  const sd = structuredClone(parseStatic(staticData));
  const spec = POLL_STATE[step?.n8n?.type];
  if (spec?.nested(step?.n8n?.typeVersion)) sd[nodeKey(name)] = { ...(isObj(sd[nodeKey(name)]) ? sd[nodeKey(name)] : {}), [name]: ns };
  else sd[nodeKey(name)] = ns;
  return sd;
}

// n8n -> runner: {cursors: {step: cursor}, missing: [step], unsupported: [{step, reason}]}.
export function cursorsFromStaticData(definition, staticData) {
  const out = { cursors: {}, missing: [], unsupported: [] };
  for (const { name, step, spec } of pollSteps(definition)) {
    const why = spec ? spec.unsupported(step) : `no static-data mapping for ${step.n8n?.type}`;
    if (why) {
      out.unsupported.push({ step: name, reason: why });
      continue;
    }
    const c = spec.toCursor(readNodeState(staticData, name, step), step);
    if (c) out.cursors[name] = c;
    else out.missing.push(name);
  }
  return out;
}

// n8n -> runner from its executions: {cursors: {step: cursor}} for the poll steps whose items
// carry their position (Gmail). executions: the public API's list with data.
export function cursorsFromExecutions(definition, executions) {
  const out = { cursors: {}, executions: 0 };
  for (const { name, step, spec } of pollSteps(definition)) {
    if (!spec?.fromEmitted || spec.unsupported(step)) continue;
    const items = [];
    for (const e of executions ?? []) {
      const runs = e?.data?.resultData?.runData?.[name];
      if (!Array.isArray(runs)) continue;
      out.executions++;
      for (const r of runs) for (const it of r?.data?.main?.[0] ?? []) items.push(it?.json ?? it);
    }
    const c = spec.fromEmitted(items);
    if (c) out.cursors[name] = c;
  }
  return out;
}
// The later of two cursor sets, per step (a step only one side knows keeps that one).
export function laterCursors(definition, a = {}, b = {}) {
  const out = {};
  for (const { name, spec } of pollSteps(definition)) {
    const x = a[name];
    const y = b[name];
    if (x && y && spec?.later) out[name] = spec.later(x, y);
    else if (x || y) out[name] = x ?? y;
  }
  return out;
}

// runner -> n8n: the static data to write, starting from n8n's own (base), with each poll
// step's cursor fields set from the runner's cursor. Steps without a cursor keep n8n's.
export function staticDataFromCursors(definition, cursors, base) {
  let sd = structuredClone(parseStatic(base));
  const out = { staticData: sd, carried: [], kept: [], unsupported: [] };
  for (const { name, step, spec } of pollSteps(definition)) {
    const why = spec ? spec.unsupported(step) : `no static-data mapping for ${step.n8n?.type}`;
    if (why) {
      out.unsupported.push({ step: name, reason: why });
      continue;
    }
    const c = cursors?.[name];
    if (!c || c.value === undefined || c.value === null) {
      out.kept.push(name);
      continue;
    }
    try {
      sd = writeNodeState(sd, name, step, spec.fromCursor(readNodeState(sd, name, step), c, step));
      out.carried.push(name);
    } catch (e) {
      out.unsupported.push({ step: name, reason: e.message });
    }
  }
  out.staticData = sd;
  return out;
}
