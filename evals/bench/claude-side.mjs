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
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pickRoute } from "../n8n/mock-server.mjs";
import { checkSchema, schemaFile } from "../mocks/mcp-server.mjs";
import { limitErrors, pageResult } from "../mocks/limits.mjs";
import { answerOf, liveAnswer, normalize, normalizeRunnerRequest, runnerValue } from "./model-shim.mjs";
import { claudeP } from "./claude.mjs";
import { modelConsumers } from "./n8n-side.mjs";

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
// call, else the first unused one fixtured for the same node, else the first unused, else the
// last one again.
export function pickConnector(list, args, used, node) {
  if (!list?.length) return null;
  let i = list.findIndex((c, j) => !used.has(j) && c.args && subset(c.args, args));
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
// descriptions, format instructions).
export function sameModelInput(n8nCall, claudeReq) {
  const n = normalize(n8nCall.format, n8nCall.request);
  const hay = squash([n.system, ...n.messages.map((m) => m.text)].join(" "));
  const c = normalizeRunnerRequest(claudeReq);
  const parts = [c.system, ...c.messages.filter((m) => m.role === "user").map((m) => m.text)].map(squash).filter(Boolean);
  const missing = parts.filter((p) => !hay.includes(p));
  if (!missing.length) return { same: true };
  const p = missing[0];
  let k = 0;
  while (k < p.length && hay.includes(p.slice(0, k + 1))) k++;
  return { same: false, at: p.slice(Math.max(0, k - 60), k + 120), n8nAround: hay.slice(Math.max(0, hay.indexOf(p.slice(0, k)) + k - 60), hay.indexOf(p.slice(0, k)) + k + 120) };
}

// Runs a definition with every request answered by the bench. Returns the run result and what
// the bench saw: tool calls, http requests and model answers, each with where its answer came
// from. recordings: n8n's model calls [{node, index, format, request, response}].
export async function runInProcess(folder, fx, { wf, recordings = [], mode = "replay", liveFallback = true, startedAt, log = console.error } = {}) {
  const def = JSON.parse(readFileSync(join(folder, "definition.json"), "utf8"));
  const core = await import(pathToFileURL(join(folder, "runtime", "runner-core.mjs")).href);
  const conn = connectorFixtures(fx);
  const usedConn = new Map();
  const routes = [...fx.reads, ...(fx.writeReplies ?? [])].flatMap((r) => (r.http?.responses ?? []).map((x) => ({ ...x, node: r.node })));
  const routeCounters = new Map();
  const byKey = {};
  for (const c of recordings) (byKey[c.node] ??= []).push(c);
  const modelCount = new Map();
  const seen = { tools: [], http: [], models: [] };

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
      if (!usedConn.has(key)) usedConn.set(key, new Set());
      const f = pickConnector(conn[key], p.args ?? {}, usedConn.get(key), p.step);
      entry.fixture = f ? `${f.node}#${f.index}` : "default";
      if (f?.error) throw Object.assign(new Error(String(f.error)), { name: "ToolError" });
      if (f && "text" in f) return f.text;
      return pageResult(p.connector, p.tool, p.args, f ? f.result : { ok: true });
    },
    http: async (p) => {
      const u = new URL(p.url);
      const sp = new URLSearchParams(u.search);
      for (const [k, v] of Object.entries(p.query ?? {})) for (const x of [].concat(v)) sp.append(k, typeof x === "string" ? x : JSON.stringify(x));
      const entry = { method: p.method, url: `${u.origin}${u.pathname}`, query: Object.fromEntries(sp), body: p.body, auth: p.auth?.secret ?? null };
      seen.http.push(entry);
      const r = pickRoute(routes, String(p.method).toUpperCase(), u.origin, u.pathname, sp, routeCounters);
      entry.fixture = r?.key ?? null;
      if (!r) return { status: 404, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "no fixture" }) };
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
    if (mode === "replay" && rec) {
      entry.mode = "replay";
      entry.input = sameModelInput(rec, req);
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
