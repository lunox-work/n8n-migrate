// The Claude side of the bench. The skill, converter and runner are black boxes here: they run
// through their CLIs or the folder's own runtime/runner-core.mjs, and only their outputs
// (definition.json, report.json, MIGRATION.md, run results) are read.
//
//   convertPlain(id, out)      scripts/convert.mjs on the raw template (no model)
//   convertSkill(id, out)      one headless skill run (claude -p sonnet, N2C_HEADLESS=1) on the
//                              raw template: no retry, no hand edit; its folder is under test
//   runInProcess(folder, ...)  the definition through the runner, every request answered by the
//                              bench: connector calls by the fixture (schema-checked like the
//                              mock MCP server), http by the fixture's routes, model and agent
//                              turns by n8n's recorded replies (replay) or claude -p (live)

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pickRoute } from "../n8n/mock-server.mjs";
import { checkSchema, schemaFile } from "../mocks/mcp-server.mjs";
import { limitErrors, pageResult } from "../mocks/limits.mjs";
import { answerOf, liveAnswer, normalize, normalizeRunnerRequest, runnerValue } from "./model-shim.mjs";
import { claudeP } from "./claude.mjs";
import { modelConsumers } from "./n8n-side.mjs";
import { maskRunTime, fromTool, fromHttp, keyOf } from "./compare.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const SKILL = join(ROOT, "skills", "n8n-to-claude");
const templatePath = (id) => join(HERE, "data", "wf", `${id}.json`);

// The workflow folder convert wrote (the one with report.json), or null.
export function folderIn(out) {
  if (!existsSync(out)) return null;
  for (const d of readdirSync(out, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith(".")) continue;
    if (existsSync(join(out, d.name, "report.json"))) return join(out, d.name);
  }
  return null;
}

export function convertPlain(id, out, { now = "2026-11-16T00:00:00Z" } = {}) {
  rmSync(out, { recursive: true, force: true });
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [join(SKILL, "scripts", "convert.mjs"), templatePath(id), "--out", out, "--now", now], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stderr: r.stderr.slice(-2000), stdout: r.stdout.slice(-4000), folder: folderIn(out), ms: Date.now() - t0 };
}

// One headless skill run. The project holds the skill (as a project skill) and the raw
// template; the session may run node and edit files inside the project only.
export async function convertSkill(id, out, { model = "sonnet", budgetUsd = 4, log = console.error } = {}) {
  // The session runs in a temp folder with no .claude above it (as evals/task-driver does);
  // the result is copied to <out>/project afterwards.
  const proj = join(mkdtempSync(join(tmpdir(), "n2c-bench-skill-")), "project");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(proj, ".claude", "skills"), { recursive: true });
  cpSync(SKILL, join(proj, ".claude", "skills", "n8n-to-claude"), { recursive: true });
  cpSync(templatePath(id), join(proj, "workflow.json"));
  const settings = {
    permissions: {
      defaultMode: "dontAsk",
      allow: ["Skill(n8n-to-claude)", "Bash(node *)", "Bash(ls *)", "Bash(cat *)", "Bash(mkdir *)", "Read", "Write", "Edit", "Glob", "Grep"],
      deny: ["WebFetch", "WebSearch"],
    },
  };
  mkdirSync(out, { recursive: true });
  const settingsFile = join(out, "settings.json");
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  const prompt = "Use the n8n-to-claude skill to migrate the n8n workflow in workflow.json (in this folder) to Claude. Write the migrated repository to the folder ./repo. Headless mode is on (N2C_HEADLESS=1): ask nothing and take the defaults. Finish with a short summary.\n\nThis sandbox allows Bash only for plain node, ls, cat and mkdir commands: run each script as its own command (node .claude/skills/n8n-to-claude/scripts/<script> ...), with no cd, no variables, no && or ;.";
  const t0 = Date.now();
  let r;
  let error = null;
  try {
    r = await claudeP({ prompt, model, purpose: `skill-convert ${id}`, cwd: proj, budgetUsd, timeoutMs: 1_500_000, env: { N2C_HEADLESS: "1" }, args: ["--settings", settingsFile, "--setting-sources", "project", "--allowedTools", ...settings.permissions.allow], log });
  } catch (e) {
    if (e.constructor?.name === "BudgetExceeded" || e.constructor?.name === "UsageLimit") throw e;
    error = e.message;
  }
  cpSync(proj, join(out, "project"), { recursive: true, filter: (src) => !src.includes("/.claude/skills/") });
  rmSync(dirname(proj), { recursive: true, force: true });
  const folder = folderIn(join(out, "project", "repo"));
  return { folder, ms: Date.now() - t0, costUsd: r?.costUsd ?? null, usage: r?.usage ?? null, turns: r?.json?.num_turns ?? null, summary: (r?.text ?? "").slice(0, 1500), error };
}

// ---------- the in-process driver ----------

const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
function subset(want, got) {
  if (!isObj(want)) return JSON.stringify(want) === JSON.stringify(got);
  return isObj(got) && Object.entries(want).every(([k, v]) => subset(v, got[k]));
}

// Connector fixtures by connector.tool: [{args?, result|text|error, node}] in fixture order.
export function connectorFixtures(fx) {
  const out = {};
  for (const r of [...fx.reads, ...(fx.writeReplies ?? [])]) {
    const c = r.connector;
    if (!c || c.none) continue;
    for (const call of c.calls ?? []) (out[`${c.connector}.${call.tool}`] ??= []).push({ ...call, node: r.node });
  }
  return out;
}

const docs = {};
const toolSchema = (connector, tool) => {
  docs[connector] ??= JSON.parse(readFileSync(schemaFile(connector), "utf8"));
  return docs[connector].tools.find((t) => t.name === tool);
};

// Picks the fixture answer for a call: the first unused one whose informative args fit the
// call, else (a read, PROPOSALS P11) a used one whose args fit, because a read with the same
// arguments answers the same, else the first unused one fixtured for the same node, else the
// first unused, else the last one again. `used` is the caller's: one set per connector tool
// for writes (single-use, in order) and one per tool and calling step for reads (connectorUse),
// so a poll read and a later get read never consume each other's rows.
export function pickConnector(list, args, used, node, { read = false } = {}) {
  if (!list?.length) return null;
  let i = list.findIndex((c, j) => !used.has(j) && c.args && subset(c.args, args));
  if (i < 0 && read) i = list.findIndex((c) => c.args && subset(c.args, args));
  if (i < 0 && node) i = list.findIndex((c, j) => !used.has(j) && c.node === node);
  if (i < 0) i = list.findIndex((c, j) => !used.has(j));
  if (i < 0) i = list.length - 1;
  used.add(i);
  return { ...list[i], index: i };
}

// The model sub-node that answers a Claude step (ai_languageModel edge), else the step itself.
export function modelKeyFor(wf, step) {
  const consumers = modelConsumers(wf);
  for (const [sub, roots] of Object.entries(consumers)) if (roots.includes(step)) return sub;
  return step;
}

const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// Does the Claude request ask the model the same thing as n8n's recorded request? The Claude
// system text and prompt must appear in n8n's request (n8n adds its own wrappers: tool
// descriptions, format instructions). runTime ({startMs, zone}, PROPOSALS P4): when the texts
// differ, timestamps of the run itself are masked on both sides (compare.mjs maskRunTime) and
// the check is repeated; a match then is reported with runTimeMasked: true.
export function sameModelInput(n8nCall, claudeReq, runTime = null) {
  const n = normalize(n8nCall.format, n8nCall.request);
  const hay = squash([n.system, ...n.messages.map((m) => m.text)].join(" "));
  const c = normalizeRunnerRequest(claudeReq);
  const parts = [c.system, ...c.messages.filter((m) => m.role === "user").map((m) => m.text)].map(squash).filter(Boolean);
  const missing = parts.filter((p) => !hay.includes(p));
  if (!missing.length) return { same: true };
  let still = missing;
  if (runTime) {
    const mh = maskRunTime(hay, runTime);
    still = missing.filter((p) => !mh.includes(maskRunTime(p, runTime)));
    if (!still.length) return { same: true, runTimeMasked: true };
  }
  // The diff shows the first part that still differs (after masking, when it applies).
  const p = still[0];
  let k = 0;
  while (k < p.length && hay.includes(p.slice(0, k + 1))) k++;
  return { same: false, at: p.slice(Math.max(0, k - 60), k + 120), n8nAround: hay.slice(Math.max(0, hay.indexOf(p.slice(0, k)) + k - 60), hay.indexOf(p.slice(0, k)) + k + 120) };
}

// ---------- replayed agent turns against the tools the Claude side ran (PROPOSALS P15) ----------
//
// sameModelInput() compares system and user text only. For an agent turn that follows a tool
// call, n8n's recorded reply (call i-1) asked for tools and n8n fed their results into call i;
// the Claude side gets n8n's reply replayed, so it must have run the same tools and fed back
// the same results, or an agent whose tool is missing or blocked would still be handed n8n's
// next turn and final answer.
//   - executed: each tool n8n's reply asked for (matched by name, as runnerValue() maps names)
//     has a Claude call whose result is not an error, unless n8n's own result for it was empty
//     or an error too (both sides fed back nothing usable). Else `tool call not executed`.
//   - results: the reads the turn's tool calls made, keyed as compare() keys reads
//     (service.action:target), are the same set on both sides: n8n's reads between the two
//     model requests in the mock log (by seq), the Claude side's between its two agent turns.
//     Else `different tool result`. Unchecked (and said so) when the recording has no model
//     seq, or a tool's n8n side was not served over http (a pin makes no read to key).

const toolNorm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const n8nToolFailed = (r) => !!r && (r.isError || !String(r.result ?? r.text ?? "").trim() || /^\s*"?(error\b|there was an error)/i.test(String(r.result ?? r.text)));

// ---------- fed-back tool values (PROPOSALS P17) ----------
//
// What n8n fed back for a tool call is the provider's tool message: the content text for
// OpenAI, Anthropic and Ollama, functionResponse.response.result for Gemini (model-shim.mjs
// normalize() keeps it as `result`). n8n 2.47.7 builds that text per tool kind: a node used as
// a tool returns JSON.stringify of its output items' json, always a list
// (n8n-core makeHandleToolInvocation/mapResult); the Workflow tool v2 the items' json list
// (pretty-printed) or a string; the Code tool and the legacy HTTP Request tool their own
// string. The Claude side's value is the runtime's transcript result. Both are read as JSON
// when they parse; a list of one item and that item count as the same value (the runtime hands
// a single item where n8n always sends a list: reported as `shape`, not gated); otherwise the
// squashed texts are compared. Run-time timestamps are masked first when the values differ.
const parseMaybe = (v) => {
  if (typeof v !== "string") return { json: true, value: v };
  try {
    return { json: true, value: JSON.parse(v) };
  } catch {
    return { json: false, value: v };
  }
};
const unwrapOne = (v) => (Array.isArray(v) && v.length === 1 ? v[0] : v);
const canon = (v) => (v === undefined ? "null" : JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x)));
export function sameToolValue(n8nMsg, claudeValue, runTime = null) {
  const n = parseMaybe(n8nMsg?.result !== undefined ? n8nMsg.result : n8nMsg?.text);
  const c = parseMaybe(claudeValue);
  let a, b;
  if (n.json && c.json) {
    a = canon(unwrapOne(n.value));
    b = canon(unwrapOne(c.value));
  } else {
    const txt = (x) => squash(typeof x.value === "string" ? x.value : JSON.stringify(x.value));
    a = txt(n);
    b = txt(c);
  }
  const shape = n.json && c.json && Array.isArray(n.value) !== Array.isArray(c.value);
  if (a === b) return { same: true, ...(shape ? { shape: "n8n sends a list of one item, the runtime the item" } : {}) };
  if (runTime && maskRunTime(a, runTime) === maskRunTime(b, runTime)) return { same: true, runTimeMasked: true };
  return { same: false, n8n: a.slice(0, 300), claude: b.slice(0, 300) };
}

// Read keys of Claude-side calls ({tools: [...], http: [...]} as seen by the in-process host).
export function claudeReadKeys(tools = [], http = []) {
  const effects = [...tools.filter((t) => !t.invalid).map((t) => fromTool(t, "claude")), ...http.map((h) => fromHttp(h, "claude"))];
  return [...new Set(effects.filter((e) => e && e.effect === "read").map(keyOf))];
}

// n8nPrev, n8nCall: recorded model calls i-1 and i; n8nEffects: the recording's service
// effects; n8nSources: its read sources by node; claudeTurn: {calls, results, reads} (the
// Claude transcript's last turn and the read keys its tool calls made). Returns null when
// n8n's reply asked for no tool, else {same, cause?, detail?, reads?}.
export function sameToolTurn({ n8nPrev, n8nCall, n8nEffects = [], n8nSources = {}, claudeTurn, runTime = null }) {
  if (!n8nPrev || !n8nCall || !claudeTurn) return null;
  const asked = answerOf(n8nPrev.format, n8nPrev.response).calls ?? [];
  if (!asked.length) return null;
  const n = normalize(n8nCall.format, n8nCall.request);
  let last = -1;
  n.messages.forEach((m, j) => m.role === "assistant" && m.calls?.length && (last = j));
  const n8nCalls = last >= 0 ? n.messages[last].calls : [];
  const n8nResults = n.messages.slice(last + 1).filter((m) => m.role === "tool");
  const n8nResultFor = (j) => {
    const id = n8nCalls[j]?.id;
    return (id && n8nResults.find((r) => r.toolId === id)) || n8nResults.filter((r) => !r.toolName || toolNorm(r.toolName) === toolNorm(asked[j].name))[asked.slice(0, j).filter((a) => toolNorm(a.name) === toolNorm(asked[j].name)).length] || n8nResults[j];
  };
  const calls = claudeTurn.calls ?? [];
  const results = claudeTurn.results ?? [];
  const used = new Set();
  const notRun = [];
  asked.forEach((a, j) => {
    const ci = calls.findIndex((c, x) => !used.has(x) && toolNorm(c?.name) === toolNorm(a.name));
    if (ci < 0) return notRun.push({ tool: a.name, claude: "no call" });
    used.add(ci);
    const r = results[ci];
    if (r?.ok === false && !n8nToolFailed(n8nResultFor(j))) notRun.push({ tool: a.name, claude: String(r.error?.message ?? "error").slice(0, 200) });
  });
  if (notRun.length) return { same: false, cause: "tool call not executed", detail: notRun };
  // P17: each fed-back value against n8n's tool message for the same call (both sides ran it).
  const valueDiffs = [];
  const shapes = [];
  const used2 = new Set();
  asked.forEach((a, j) => {
    const ci = calls.findIndex((c, x) => !used2.has(x) && toolNorm(c?.name) === toolNorm(a.name));
    used2.add(ci);
    const r = results[ci];
    const nm = n8nResultFor(j);
    if (!nm || n8nToolFailed(nm) || r?.ok === false) return;
    const v = sameToolValue(nm, r?.value, runTime);
    if (!v.same) valueDiffs.push({ tool: a.name, n8n: v.n8n, claude: v.claude });
    else if (v.shape) shapes.push(a.name);
  });
  if (valueDiffs.length) return { same: false, cause: "different tool result", detail: { tools: asked.map((a) => a.name), values: valueDiffs } };
  const valuesNote = { values: asked.length, ...(shapes.length ? { shape: `single item vs list: ${shapes.join(", ")}` } : {}) };
  if (n8nPrev.seq == null || n8nCall.seq == null) return { same: true, ...valuesNote, reads: "unchecked: the recording has no model call order" };
  const notHttp = asked.map((a) => Object.keys(n8nSources).find((node) => toolNorm(node) === toolNorm(a.name))).filter((node) => node && !String(n8nSources[node]).startsWith("http"));
  if (notHttp.length) return { same: true, ...valuesNote, reads: `unchecked: n8n's ${notHttp.join(", ")} not served over http` };
  const nKeys = [...new Set(n8nEffects.filter((e) => e.seq > n8nPrev.seq && e.seq < n8nCall.seq && e.method !== "CONNECT").map((e) => fromHttp(e, "n8n")).filter((e) => e && e.effect === "read").map(keyOf))];
  const cKeys = claudeTurn.reads ?? [];
  const onlyN8n = nKeys.filter((k) => !cKeys.includes(k));
  const onlyClaude = cKeys.filter((k) => !nKeys.includes(k));
  if (onlyN8n.length || onlyClaude.length) return { same: false, cause: "different tool result", detail: { tools: asked.map((a) => a.name), onlyN8n, onlyClaude } };
  return { same: true, ...valuesNote, reads: nKeys.length };
}

// ---------- the claude driver's replayed requests (PROPOSALS P16) ----------
//
// The claude driver's replay hook keeps each replayed request with the time its answer was
// written (replayLog: [{id, key, index, mode, t, req}]). Each replayed one is checked as the
// in-process driver checks it: sameModelInput against n8n's recorded request for the same model
// node and call index, and, for an agent turn after a tool call, sameToolTurn with the turn's
// reads taken from the driver's effects (MCP mock log and host http log, both timed) between
// the previous agent turn's answer and this one's. Returns modelInputs in gate4's shape.
export function claudeDriverModelInputs({ replayLog = [], effects = [], recordings = [], n8nEffects = [], n8nSources = {}, runTime = null }) {
  const byKey = {};
  for (const c of recordings) (byKey[c.node] ??= [])[c.index] = c;
  const lastTurn = new Map();
  const out = [];
  const seen = new Set();
  for (const e of replayLog) {
    if (!e.req || seen.has(e.id)) continue;
    seen.add(e.id);
    const step = String(e.id).split("#")[0];
    let claudeTurn = null;
    if (e.req.kind === "agent") {
      const mk = `${step}\u0000${e.req.itemIndex ?? 0}`;
      const prev = lastTurn.get(mk);
      if (e.req.transcript?.length && prev) {
        const between = (x) => x.t && x.t > prev && x.t <= e.t;
        claudeTurn = { ...e.req.transcript.at(-1), reads: claudeReadKeys(effects.filter((x) => x.connector && between(x)), effects.filter((x) => x.url && between(x))) };
      }
      lastTurn.set(mk, e.t);
    }
    if (e.mode !== "replay") continue;
    const rec = byKey[e.key]?.[e.index];
    if (!rec) continue;
    const m = { step, key: e.key, index: e.index, kind: e.req.kind, mode: "replay", input: sameModelInput(rec, e.req, runTime) };
    const tools = claudeTurn && sameToolTurn({ n8nPrev: byKey[e.key]?.[e.index - 1], n8nCall: rec, n8nEffects, n8nSources, claudeTurn, runTime });
    if (tools) m.tools = tools;
    out.push(m);
  }
  return out;
}

// Runs a definition with every request answered by the bench. Returns the run result and what
// the bench saw: tool calls, http requests and model answers, each with where its answer came
// from. recordings: n8n's model calls [{node, index, format, request, response}].
// The fixture's http routes (FIXTURES.md `http` sources), as the in-process host and the
// claude driver's mock answer them.
export function httpRoutes(fx) {
  return [...fx.reads, ...(fx.writeReplies ?? [])].flatMap((r) => (r.http?.responses ?? []).map((x) => ({ ...x, node: r.node })));
}

// A runner multipart body as the mock decodes a real one (PROPOSALS P9, README "Form bodies"):
// a file part ({$file: {fileName, mimeType, data (base64)}}) becomes {filename, contentType,
// size, sha256} of its decoded bytes; text fields stay as they are (formStrings() compares
// them as strings). Only what the runner's request states is recorded, no defaults: a part
// without a file name or type records null, as the mock does for a part without them.
export function decodeFileParts(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const one = (v) => {
    const f = v && typeof v === "object" && !Array.isArray(v) ? v.$file : null;
    if (!f) return v;
    const raw = Buffer.from(String(f.data ?? ""), "base64");
    return { filename: f.fileName == null ? null : basename(String(f.fileName)), contentType: f.mimeType ? String(f.mimeType).split(";")[0].trim() : null, size: raw.length, sha256: createHash("sha256").update(raw).digest("hex") };
  };
  return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, Array.isArray(v) ? v.map(one) : one(v)]));
}

export async function runInProcess(folder, fx, { wf, recordings = [], n8nEffects = [], n8nSources = {}, mode = "replay", liveFallback = true, startedAt, runTime = null, log = console.error } = {}) {
  const def = JSON.parse(readFileSync(join(folder, "definition.json"), "utf8"));
  const core = await import(pathToFileURL(join(folder, "runtime", "runner-core.mjs")).href);
  const conn = connectorFixtures(fx);
  const usedConn = new Map();
  const routes = httpRoutes(fx);
  const routeCounters = new Map();
  const byKey = {};
  for (const c of recordings) (byKey[c.node] ??= []).push(c);
  const modelCount = new Map();
  const seen = { tools: [], http: [], models: [] };
  // Where each agent loop (step and item) stood in `seen` at its last turn (P15).
  const turnMarks = new Map();

  const host = {
    tool: async (p) => {
      const key = `${p.connector}.${p.tool}`;
      const schema = toolSchema(p.connector, p.tool);
      const entry = { connector: p.connector, tool: p.tool, args: p.args ?? {}, effect: p.effect };
      seen.tools.push(entry);
      if (!schema) throw Object.assign(new Error(`Unknown tool: ${p.tool}`), { name: "ToolError" });
      const errs = [...checkSchema(p.args ?? {}, { ...schema.inputSchema, type: "object" }), ...limitErrors(p.connector, p.tool, p.args ?? {})];
      if (errs.length) {
        entry.invalid = errs.join("; ");
        throw Object.assign(new Error(`Invalid arguments for ${p.tool}: ${entry.invalid}`), { name: "ToolError" });
      }
      // Read or write by the comparer's own table (effects.json), not the runner's claim.
      const read = fromTool({ connector: p.connector, tool: p.tool, args: p.args ?? {}, effect: p.effect }).effect === "read";
      const useKey = read ? `${key}\u0000${p.step ?? ""}` : key;
      if (!usedConn.has(useKey)) usedConn.set(useKey, new Set());
      const f = pickConnector(conn[key], p.args ?? {}, usedConn.get(useKey), p.step, { read });
      entry.fixture = f ? `${f.node}#${f.index}` : "default";
      if (f?.error) throw Object.assign(new Error(String(f.error)), { name: "ToolError" });
      if (f && "text" in f) return f.text;
      return pageResult(p.connector, p.tool, p.args, f ? f.result : { ok: true });
    },
    http: async (p) => {
      const u = new URL(p.url);
      const sp = new URLSearchParams(u.search);
      for (const [k, v] of Object.entries(p.query ?? {})) for (const x of [].concat(v)) sp.append(k, typeof x === "string" ? x : JSON.stringify(x));
      const body = p.contentType === "multipart-form-data" ? decodeFileParts(p.body) : p.body;
      const entry = { method: p.method, url: `${u.origin}${u.pathname}`, query: Object.fromEntries(sp), body, ...(p.contentType ? { contentType: p.contentType } : {}), auth: p.auth?.secret ?? null };
      seen.http.push(entry);
      const r = pickRoute(routes, String(p.method).toUpperCase(), u.origin, u.pathname, sp, routeCounters, body);
      entry.fixture = r?.key ?? null;
      if (!r && ["POST", "PUT", "PATCH", "DELETE"].includes(String(p.method).toUpperCase())) {
        entry.fixture = "write-default";
        return { status: 200, headers: { "content-type": "application/json" }, body: "{}" };
      }
      if (!r) {
        entry.fixture = "read-default"; // PROPOSALS P19, as the mock logs it
        return { status: 404, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "no fixture" }) };
      }
      const f = r.f;
      if (f.bodyBase64 !== undefined) return { status: f.status ?? 200, headers: { "content-type": "application/octet-stream", ...(f.headers ?? {}) }, body: Buffer.from(f.bodyBase64, "base64").toString("latin1") };
      const isText = typeof f.body === "string";
      return { status: f.status ?? 200, headers: { "content-type": isText ? "text/plain" : "application/json", ...(f.headers ?? {}) }, body: f.body === undefined ? "" : isText ? f.body : JSON.stringify(f.body) };
    },
    model: (p) => answerModel({ ...p, kind: "model" }),
    agent: (p) => answerModel({ ...p, kind: "agent" }),
  };

  async function answerModel(req) {
    const step = req.step ?? "?";
    const key = wf ? modelKeyFor(wf, step) : step;
    const i = modelCount.get(key) ?? 0;
    modelCount.set(key, i + 1);
    const rec = byKey[key]?.[i];
    const entry = { step, key, index: i, kind: req.kind };
    seen.models.push(entry);
    let claudeTurn = null;
    if (req.kind === "agent") {
      const mk = `${step}\u0000${req.itemIndex ?? 0}`;
      const mark = turnMarks.get(mk);
      if (req.transcript?.length && mark) claudeTurn = { ...req.transcript.at(-1), reads: claudeReadKeys(seen.tools.slice(mark.tools), seen.http.slice(mark.http)) };
      turnMarks.set(mk, { tools: seen.tools.length, http: seen.http.length });
    }
    if (mode === "replay" && rec) {
      entry.mode = "replay";
      entry.input = sameModelInput(rec, req, runTime);
      const tools = claudeTurn && sameToolTurn({ n8nPrev: byKey[key]?.[i - 1], n8nCall: rec, n8nEffects, n8nSources, claudeTurn, runTime });
      if (tools) entry.tools = tools;
      return runnerValue(req, answerOf(rec.format, rec.response));
    }
    if (mode === "replay" && !liveFallback) {
      entry.mode = "missing";
      throw new Error(`no recorded model reply for ${key}#${i}`);
    }
    const r = await liveAnswer(normalizeRunnerRequest(req), { purpose: `claude-side model ${key}#${i}`, log });
    entry.mode = r.mode === "cached" ? "live-cached" : "live";
    return runnerValue(req, r.answer);
  }

  // The runner's request payload carries no step name; its id does ("<step>#<run>#<item>...").
  const wrap = (fn) => async (payload, meta) => fn({ ...payload, step: String(meta?.id ?? "").split("#")[0] || null }, meta);
  for (const k of Object.keys(host)) host[k] = wrap(host[k]);

  // Poll triggers poll through their connector (the trigger read is the poll source); other
  // triggers get the fixture's items. Manual mode, as on the n8n side: a poll emits what it
  // read instead of only seeding the cursor.
  const trig = def.steps[fx.trigger.node];
  const polls = !!trig?.poll && fx.trigger.kind === "poll";
  const t0 = Date.now();
  const res = await core.run(def, { trigger: polls ? undefined : { node: fx.trigger.node, items: fx.trigger.items }, clock: { startedAt: startedAt ?? fx.now }, host, virtualTime: true, mode: "manual", runId: `bench-${fx.template}-${fx.variant}` });
  return { res, seen, wallMs: Date.now() - t0, definition: def, polled: polls };
}
