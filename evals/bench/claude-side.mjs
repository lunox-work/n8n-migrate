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
import { pickRoute, serviceRefusal, modelHost } from "../n8n/mock-server.mjs";
import { checkSchema, schemaFile } from "../mocks/mcp-server.mjs";
import { connectorRefusal, limitErrors, pageResult } from "../mocks/limits.mjs";
import { answerOf, formatOf, liveAnswer, normalize, normalizeRunnerRequest, pairRecorded, providerResponse, runnerValue } from "./model-shim.mjs";
import { claudeP } from "./claude.mjs";
import { redactSecrets } from "../../skills/n8n-to-claude/scripts/analyze.mjs";
import { modelConsumers, containerPath, N8N_HOME } from "./n8n-side.mjs";
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

export function convertPlain(id, out, { now = "2026-11-16T00:00:00Z", source = templatePath(id) } = {}) {
  rmSync(out, { recursive: true, force: true });
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [join(SKILL, "scripts", "convert.mjs"), source, "--out", out, "--now", now], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stderr: r.stderr.slice(-2000), stdout: r.stdout.slice(-4000), folder: folderIn(out), ms: Date.now() - t0 };
}

// PROPOSALS P78: the overlay's placeholder fills reach the export the Claude side converts, as
// a person fixes a placeholder in the template before converting, so whatever the converter
// derives from a filled parameter (a connector's file id, a request's host) sees the filled
// value. The fills are the Claude half's `patch.params`, merged into the node's parameters as
// convert.mjs applyOverrides() merges them into the step (objects key by key, so `{value}`
// fills a resource locator and keeps its mode; null removes; anything else replaces); the
// patch itself still runs after conversion. A fill the converter would redact as an inline
// secret is left to the patch. -> the filled export as text, or null when the overlay fills none.
export function filledSource(id, overlay) {
  const steps = Object.entries(overlay?.claude?.overrides?.steps ?? {}).filter(([, o]) => o?.patch?.params && typeof o.patch.params === "object");
  if (!steps.length) return null;
  const raw = JSON.parse(readFileSync(templatePath(id), "utf8"));
  const wf = raw.workflow?.workflow ?? raw;
  let filled = 0;
  for (const [name, o] of steps) {
    const n = (wf.nodes ?? []).find((x) => x.name === name);
    if (!n) continue;
    n.parameters ??= {};
    // A fill the converter would redact as an inline secret (a dummy API key in a header) stays
    // out of the export: it reaches the step through the patch after conversion, as before.
    for (const [k, v] of Object.entries(o.patch.params)) {
      const before = redactSecrets(n.parameters[k] ?? null).found.length;
      const next = mergeFill({ [k]: structuredClone(n.parameters[k]) }, { [k]: v })[k];
      if (redactSecrets(next ?? null).found.length > before) continue;
      if (next === undefined) delete n.parameters[k];
      else n.parameters[k] = next;
      filled++;
    }
  }
  return filled ? JSON.stringify(raw) : null;
}

const plainObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
function mergeFill(target, patch) {
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === null) delete target[k];
    else if (plainObj(v) && plainObj(target[k])) mergeFill(target[k], v);
    else target[k] = structuredClone(v);
  }
  return target;
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
  return sameNormInput(n8nCall, normalizeRunnerRequest(claudeReq), runTime);
}

// The same check on a neutral conversation (normalize()), for a Claude-side request that is
// already in a provider's format: an LLM API called over HTTP (PROPOSALS P43).
export function sameNormInput(n8nCall, c, runTime = null) {
  const n = normalize(n8nCall.format, n8nCall.request);
  const hay = squash([n.system, ...n.messages.map((m) => m.text)].join(" "));
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

// PROPOSALS P76: does a recorded call fit a runner request well enough to pair them by
// content? The same question (sameModelInput) and, for an agent turn, as many tool results fed
// back, since every turn of one agent loop asks the same question.
export function sameReplayInput(n8nCall, req, runTime = null) {
  if (!sameModelInput(n8nCall, req, runTime).same) return false;
  if (req.kind !== "agent") return true;
  const fed = (req.transcript ?? []).reduce((k, t) => k + (t.results?.length ?? 0), 0);
  return normalize(n8nCall.format, n8nCall.request).messages.filter((m) => m.role === "tool").length === fed;
}

// ---------- tool definitions offered to the model (PROPOSALS P28) ----------
//
// The tools a replayed request offers the model, against n8n's for the same model node and
// call. Gated: the set of tool names (as runnerValue() maps names: case and punctuation
// folded, since n8n turns a node name into a tool name by replacing other characters with
// `_`) and each tool's input schema shape (property names, types, required, nested object
// properties and array items). Reported, not gated: descriptions of tools and parameters (n8n
// writes some itself, e.g. "Get many events in Google Calendar" from the node's action label;
// wording is not behaviour the bench can score), and n8n's own output-parser tool
// (format_final_json_response), which the runtime replaces with the request's outputSchema.
const N8N_PARSER_TOOL = "format_final_json_response";
const typeOf = (s) => {
  const t = s?.type ?? (s?.properties ? "object" : s?.items ? "array" : s?.enum ? typeof s.enum[0] : "any");
  return Array.isArray(t) ? [...t].sort().join("|") : String(t);
};
export function schemaShape(s) {
  if (!s || typeof s !== "object") return { type: "any" };
  const t = typeOf(s);
  const out = { type: t };
  if (t === "object" || s.properties) {
    out.properties = Object.fromEntries(Object.keys(s.properties ?? {}).sort().map((k) => [k, schemaShape(s.properties[k])]));
    out.required = [...(s.required ?? [])].sort();
  }
  if (t === "array" || s.items) out.items = schemaShape(s.items);
  return out;
}
const descriptionsOf = (s, at = "", out = {}) => {
  if (!s || typeof s !== "object") return out;
  if (at && s.description) out[at] = String(s.description);
  for (const [k, v] of Object.entries(s.properties ?? {})) descriptionsOf(v, at ? `${at}.${k}` : k, out);
  if (s.items) descriptionsOf(s.items, `${at}[]`, out);
  return out;
};
// A tool's input schema: absent or empty means a tool without parameters, as an object schema
// with no properties does (1953's n8n calendar tool sends the latter, the runtime the former).
const toolShape = (s) => schemaShape(s && typeof s === "object" && (s.type || s.properties) ? s : { type: "object", properties: {} });
// Returns null when neither side offers a tool, else {same, onlyN8n, onlyClaude, schemas,
// descriptions, parser?}: schemas and descriptions list the tools whose shape / wording differ.
export function sameToolDefs(n8nCall, claudeReq) {
  const all = normalize(n8nCall.format, n8nCall.request).tools;
  const n = all.filter((t) => t.name !== N8N_PARSER_TOOL);
  const c = (claudeReq?.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? "", schema: t.inputSchema ?? {} }));
  if (!all.length && !c.length) return null;
  const onlyN8n = n.filter((t) => !c.some((x) => toolNorm(x.name) === toolNorm(t.name))).map((t) => t.name);
  const onlyClaude = c.filter((t) => !n.some((x) => toolNorm(x.name) === toolNorm(t.name))).map((t) => t.name);
  const schemas = [];
  const descriptions = [];
  for (const t of n) {
    const x = c.find((y) => toolNorm(y.name) === toolNorm(t.name));
    if (!x) continue;
    const a = canon(toolShape(t.schema));
    const b = canon(toolShape(x.schema));
    if (a !== b) schemas.push({ tool: t.name, n8n: a.slice(0, 300), claude: b.slice(0, 300) });
    const dn = { "": t.description, ...descriptionsOf(t.schema) };
    const dc = { "": x.description, ...descriptionsOf(x.schema) };
    const diff = [...new Set([...Object.keys(dn), ...Object.keys(dc)])].filter((k) => squash(dn[k]) !== squash(dc[k])).map((k) => ({ at: k || "(tool)", kind: descriptionDiffKind(dn[k], dc[k]), n8n: String(dn[k] ?? "").slice(0, 160), claude: String(dc[k] ?? "").slice(0, 160) }));
    if (diff.length) descriptions.push({ tool: t.name, diff });
  }
  // PROPOSALS P34: an n8n expression left in a description the model reads is a converter
  // artefact (gated); other wording differences stay reported.
  const artefacts = descriptions.flatMap((d) => d.diff.filter((x) => x.kind === "artefact").map((x) => ({ tool: d.tool, ...x })));
  // PROPOSALS P35: n8n's output-parser tool asks for {output: <schema>}; the runtime asks with
  // the request's outputSchema, so the shapes of the two must match.
  const parserTool = all.find((t) => t.name === N8N_PARSER_TOOL);
  let parser = null;
  if (parserTool) {
    const want = canon(schemaShape(parserTool.schema?.properties?.output));
    const got = claudeReq?.outputSchema ? canon(schemaShape(claudeReq.outputSchema)) : null;
    parser = { n8n: N8N_PARSER_TOOL, claudeOutputSchema: !!claudeReq?.outputSchema, same: want === got, ...(want === got ? {} : { n8nShape: want.slice(0, 300), claudeShape: got ? got.slice(0, 300) : null }) };
  }
  return { same: !onlyN8n.length && !onlyClaude.length && !schemas.length, tools: n.length, onlyN8n, onlyClaude, schemas, descriptions, artefacts, ...(parser ? { parser } : {}) };
}

// PROPOSALS P34: how a description differs. "artefact": the Claude side's text carries n8n
// expression syntax that n8n's text (what n8n evaluated and sent) does not: a leading `=`
// expression marker, `{{ … }}`, or a $fromAI() call. "missing": the Claude side sends no text
// where n8n sends some. "reworded": any other difference (n8n writes some descriptions itself).
export function descriptionDiffKind(n8nText, claudeText) {
  const n = String(n8nText ?? "");
  const c = String(claudeText ?? "");
  const marks = [/^\s*=/, /\{\{[\s\S]*?\}\}/, /\$fromAI\s*\(/i];
  if (marks.some((re) => re.test(c) && !re.test(n))) return "artefact";
  if (!c.trim() && n.trim()) return "missing";
  return "reworded";
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

// PROPOSALS P75: tools whose result is not a function of their input. A Code tool (or a Code
// node used as a tool) whose code draws randomness or reads the clock returns a different value
// on each run, on n8n's side as on the Claude side, so its fed-back value is compared by shape
// (JSON or text, the JSON type, an object's keys, a list's length), and the value difference is
// reported, never gated. Names as n8n offers them: the node's name and a typed `name`, folded.
const NONDETERMINISTIC_CODE = /\bMath\.random\s*\(|\bcrypto\.(?:randomUUID|randomInt|randomBytes|getRandomValues)\s*\(|\bDate\.now\s*\(|\bnew\s+Date\s*\(\s*\)|\$now\b|\brandom\.(?:random|choice|randint|shuffle|sample)\s*\(/;
export function nondeterministicTools(wf) {
  const out = new Set();
  for (const n of wf?.nodes ?? []) {
    if (!/(?:toolCode|\.code)$/.test(String(n.type ?? ""))) continue;
    const p = n.parameters ?? {};
    const code = [p.jsCode, p.code, p.pythonCode].filter((x) => typeof x === "string").join("\n");
    if (!NONDETERMINISTIC_CODE.test(code)) continue;
    out.add(toolNorm(n.name));
    if (typeof p.name === "string" && p.name && !p.name.startsWith("=")) out.add(toolNorm(p.name));
  }
  return out;
}
const shapeOf = (v) => (Array.isArray(v) ? `list(${v.length})` : v && typeof v === "object" ? `object{${Object.keys(v).sort().join(",")}}` : v === null ? "null" : typeof v);
export function sameToolShape(n8nMsg, claudeValue) {
  const n = parseMaybe(n8nMsg?.result !== undefined ? n8nMsg.result : n8nMsg?.text);
  const c = parseMaybe(claudeValue);
  const a = n.json ? shapeOf(unwrapOne(n.value)) : "text";
  const b = c.json ? shapeOf(unwrapOne(c.value)) : "text";
  return a === b ? { same: true } : { same: false, n8n: a, claude: b };
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
export function sameToolTurn({ n8nPrev, n8nCall, n8nEffects = [], n8nSources = {}, claudeTurn, runTime = null, nondeterministic = new Set() }) {
  if (!n8nPrev || !n8nCall || !claudeTurn) return null;
  const asked = answerOf(n8nPrev.format, n8nPrev.response).calls ?? [];
  if (!asked.length) return null;
  const n = normalize(n8nCall.format, n8nCall.request);
  // PROPOSALS P79: LangChain may send one reply's parallel calls as separate assistant
  // messages, each followed by its tool message, so the turn's calls are the last
  // asked.length calls across the assistant messages, and its results every tool message after
  // the first of them; they are then paired by call id.
  const flat = [];
  n.messages.forEach((m, j) => m.role === "assistant" && (m.calls ?? []).forEach((c) => flat.push({ c, j })));
  const turn = flat.slice(-asked.length);
  const first = turn.length ? turn[0].j : -1;
  const n8nCalls = turn.map((x) => x.c);
  const n8nResults = first >= 0 ? n.messages.slice(first + 1).filter((m) => m.role === "tool") : [];
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
  const byShape = [];
  const used2 = new Set();
  asked.forEach((a, j) => {
    const ci = calls.findIndex((c, x) => !used2.has(x) && toolNorm(c?.name) === toolNorm(a.name));
    used2.add(ci);
    const r = results[ci];
    const nm = n8nResultFor(j);
    if (!nm || n8nToolFailed(nm) || r?.ok === false) return;
    if (nondeterministic.has(toolNorm(a.name))) {
      const sh = sameToolShape(nm, r?.value);
      if (!sh.same) valueDiffs.push({ tool: a.name, n8n: sh.n8n, claude: sh.claude, comparedBy: "shape" });
      else byShape.push({ tool: a.name, valueSame: sameToolValue(nm, r?.value, runTime).same });
      return;
    }
    const v = sameToolValue(nm, r?.value, runTime);
    if (!v.same) valueDiffs.push({ tool: a.name, n8n: v.n8n, claude: v.claude });
    else if (v.shape) shapes.push(a.name);
  });
  if (valueDiffs.length) return { same: false, cause: "different tool result", detail: { tools: asked.map((a) => a.name), values: valueDiffs } };
  const valuesNote = { values: asked.length, ...(shapes.length ? { shape: `single item vs list: ${shapes.join(", ")}` } : {}), ...(byShape.length ? { nondeterministic: byShape } : {}) };
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
export function claudeDriverModelInputs({ replayLog = [], effects = [], recordings = [], n8nEffects = [], n8nSources = {}, runTime = null, nondeterministic = new Set() }) {
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
    const defs = sameToolDefs(rec, e.req);
    if (defs) m.toolDefs = defs;
    const tools = claudeTurn && sameToolTurn({ n8nPrev: byKey[e.key]?.[e.index - 1], n8nCall: rec, n8nEffects, n8nSources, claudeTurn, runTime, nondeterministic });
    if (tools) m.tools = tools;
    out.push(m);
  }
  return out;
}

// ---------- LLM APIs called over HTTP on the Claude side (PROPOSALS P43) ----------
//
// n8n's HTTP Request to a model API on a fixed host (mock-server.mjs MODEL_HOSTS: OpenAI,
// Anthropic, OpenRouter, Groq, Mistral, Hugging Face, Vertex) reaches the model shim and is
// recorded as a model call (tag host:<host>, node = the HTTP Request node). The Claude side's
// `http` step to the same host and model path is answered the same way: n8n's recorded reply
// for that node and call index, in the API's own response format, and its request is checked
// like a replayed model input (sameNormInput on the normalized body). It is a model call, not
// an effect: neither side counts it among reads or writes. Only a request no fixture route
// answers is one (as the mock forwards only those).
export function isModelHttp(routes, method, url, body) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!modelHost(u.hostname, u.pathname) || !formatOf(u.pathname)) return null;
  if (pickRoute(routes, String(method).toUpperCase(), u.origin, u.pathname, u.searchParams, new Map(), body)) return null;
  return { format: formatOf(u.pathname), host: u.hostname };
}
export const jsonBody = (b) => {
  if (typeof b !== "string") return b ?? {};
  try {
    return JSON.parse(b);
  } catch {
    return {};
  }
};

// The claude driver's model calls over HTTP, as its replay shim logged them
// ([{tag, index, format, request, mode}]), in gate4's modelInputs shape.
export function httpModelInputs(calls = [], recordings = [], runTime = null) {
  return calls.map((c) => {
    const rec = recordings.find((r) => r.tag === c.tag && r.index === c.index);
    return { step: rec?.node ?? c.tag, key: rec?.node ?? c.tag, index: c.index, kind: "http", mode: c.mode, ...(rec && c.mode === "replay" ? { input: sameNormInput(rec, normalize(c.format, c.request), runTime) } : {}) };
  });
}

// ---------- bench-written replies on the hostile fixture (PROPOSALS P38) ----------
//
// n8n's replayed replies never pick a tool input off the author's list, so a refusal of the
// runtime (a model-picked URL limited to the URLs written in the tool) is never exercised by a
// replay. A hostile fixture may insert replies written by the bench (expect.syntheticReplies,
// marked synthetic, never sent to n8n): each takes call index `before` of its model node, in
// that call's provider format and with that call's request (so the tool-list check compares
// the same offer), and n8n's replies from there on move one later. Only the Claude side's
// replay uses them (in process and in the claude driver's replay hook).
export function withSynthetic(modelCalls = [], fx) {
  const syn = fx?.expect?.syntheticReplies ?? [];
  if (!syn.length) return modelCalls;
  const out = modelCalls.map((c) => ({ ...c }));
  for (const s of syn) {
    const own = out.filter((c) => c.node === s.model);
    const at = own.find((c) => c.index === s.before) ?? own.at(-1);
    if (!at) continue;
    for (const c of own) if (c.index >= s.before) c.index++;
    out.push({ tag: at.tag, node: s.model, index: s.before, format: at.format, request: at.request, response: providerResponse(at.format, s.answer, at.request ?? {}), mode: "synthetic", synthetic: true, seq: null });
  }
  return out.sort((a, b) => (a.node === b.node ? a.index - b.index : 0));
}

// Whether each inserted reply was reached by the Claude side (models: [{key, index}], the
// in-process driver's seen.models or the claude driver's replayLog) and whether any request
// went to a host its answer names (http: [{method, url}]): a reached reply that made such a
// request was not refused.
export function syntheticOutcome(fx, { models = [], http = [] } = {}) {
  const syn = fx?.expect?.syntheticReplies ?? [];
  if (!syn.length) return null;
  return syn.map((s) => {
    const hosts = (JSON.stringify(s.answer).match(/https?:\/\/[^"\s\\]+/g) ?? []).map((u) => {
      try {
        return new URL(u).hostname.toLowerCase();
      } catch {
        return null;
      }
    }).filter(Boolean);
    const offList = http.filter((h) => {
      try {
        return hosts.includes(new URL(h.url).hostname.toLowerCase());
      } catch {
        return false;
      }
    });
    return { model: s.model, before: s.before, reached: models.some((m) => m.key === s.model && m.index === s.before), hosts, offListRequests: offList.map((h) => `${h.method} ${h.url}`) };
  });
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

// ---------- local disk on the Claude side (PROPOSALS P44) ----------
//
// The runtime's disk steps (Read/Write Files from Disk, Read/Write Binary File) send `file`
// requests ({op: read|write, path, glob?, data?, append?}) that the task driver answers from
// the real disk. The bench never lets them reach it: a scratch disk in memory answers them,
// holding the fixture's `file` sources at the paths n8n reads them from (containerPath: a
// relative path under /home/node, n8n's working directory; the runtime's relative paths are
// relative to the workflow folder, put at the same place) and every file the run writes.
// Answers mirror driver.mjs executeFile (glob: `*` and `?` within a segment, `**` any depth,
// sorted; a missing file without a glob is an error; a glob from `/` is refused). After the
// run, files() gives each written path with its final bytes (appends applied in order),
// compared with n8n's file read back from the container (effects.json `file`).
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
export function globRe(pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      const slash = pattern[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
export function scratchDisk(fx) {
  const disk = new Map();
  for (const r of fx?.reads ?? []) if (r.file?.path) disk.set(containerPath(r.file.path), r.file.base64 !== undefined ? Buffer.from(r.file.base64, "base64") : Buffer.from(String(r.file.text ?? ""), "utf8"));
  const written = [];
  const shown = (abs, sel) => (!String(sel).startsWith("/") && abs.startsWith(`${N8N_HOME}/`) ? abs.slice(N8N_HOME.length + 1) : abs);
  return {
    disk,
    request(req) {
      if (req.op === "write") {
        const target = containerPath(String(req.path));
        const bytes = Buffer.from(String(req.data ?? ""), "base64");
        disk.set(target, req.append && disk.has(target) ? Buffer.concat([disk.get(target), bytes]) : bytes);
        if (!written.includes(target)) written.push(target);
        return { path: req.path, bytes: bytes.length };
      }
      const sel = String(req.path ?? "");
      let found;
      if (req.glob && /[*?]/.test(sel)) {
        const abs = containerPath(sel);
        if (/^\/[*?]/.test(abs)) throw Object.assign(new Error(`the file selector "${sel}" would search the whole disk`), { name: "FileError" });
        const re = globRe(abs);
        found = [...disk.keys()].filter((k) => re.test(k)).sort();
      } else {
        const abs = containerPath(sel);
        if (!disk.has(abs) && !req.glob) throw Object.assign(new Error(`The file "${sel}" could not be accessed.`), { name: "FileError", code: "ENOENT" });
        found = disk.has(abs) ? [abs] : [];
      }
      return { files: found.map((k) => ({ path: shown(k, sel), data: disk.get(k).toString("base64") })) };
    },
    files: () => written.map((path) => ({ path, sha256: sha256(disk.get(path)), size: disk.get(path).length })),
  };
}

// The claude driver's disk writes, from the run state's effects (kind `file`, op `write`):
// replayed on a scratch disk with the fixture's files, so the final bytes per path compare
// as in process.
export function driverFiles(stateEffects = [], fx) {
  const d = scratchDisk(fx);
  for (const e of stateEffects) if (e.kind === "file" && e.request?.op === "write") d.request(e.request);
  return d.files();
}

export async function runInProcess(folder, fx, { wf, recordings = [], n8nEffects = [], n8nSources = {}, mode = "replay", liveFallback = true, startedAt, runTime = null, log = console.error } = {}) {
  const def = JSON.parse(readFileSync(join(folder, "definition.json"), "utf8"));
  const core = await import(pathToFileURL(join(folder, "runtime", "runner-core.mjs")).href);
  const nondeterministic = nondeterministicTools(wf);
  const conn = connectorFixtures(fx);
  const usedConn = new Map();
  const routes = httpRoutes(fx);
  const routeCounters = new Map();
  const byKey = {};
  for (const c of recordings) (byKey[c.node] ??= []).push(c);
  const modelCount = new Map();
  const modelUsed = new Map();
  // PROPOSALS P76: the recorded call that answers a request, by index or else by content.
  const pairFor = (key, i, matches) => {
    if (!modelUsed.has(key)) modelUsed.set(key, new Set());
    return pairRecorded(byKey[key] ?? [], i, modelUsed.get(key), matches);
  };
  const seen = { tools: [], http: [], models: [], files: [] };
  const disk = scratchDisk(fx);
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
      // PROPOSALS P33: what the real service refuses, as the MCP mock (no effect).
      const refused = connectorRefusal(p.connector, p.tool, p.args ?? {});
      if (refused) {
        entry.invalid = refused;
        entry.fixture = "service refusal";
        throw Object.assign(new Error(refused), { name: "ToolError" });
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
      // PROPOSALS P43: an LLM API over HTTP is a model call answered from n8n's recording.
      const mh = isModelHttp(routes, p.method, p.url, body);
      if (mh) return answerModelHttp(p, mh, jsonBody(body));
      const entry = { method: p.method, url: `${u.origin}${u.pathname}`, query: Object.fromEntries(sp), body, ...(p.contentType ? { contentType: p.contentType } : {}), auth: p.auth?.secret ?? null, ...(p.ownStep ?? p.step ? { step: p.ownStep ?? p.step } : {}) };
      seen.http.push(entry);
      // PROPOSALS P29: what the real service refuses whatever the fixture says, as the mock.
      const refused = serviceRefusal(p.method, u.origin, u.pathname, body);
      if (refused) {
        entry.fixture = refused.key;
        return { status: refused.f.status, headers: { "content-type": "application/json" }, body: JSON.stringify(refused.f.body) };
      }
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
    // PROPOSALS P44: disk steps on the scratch disk, never the real one.
    file: async (p) => {
      const entry = { op: p.op, path: containerPath(String(p.path ?? "")), ...(p.glob ? { glob: true } : {}), ...(p.append ? { append: true } : {}) };
      seen.files.push(entry);
      try {
        const v = disk.request(p);
        if (v.files) entry.found = v.files.length;
        return v;
      } catch (e) {
        entry.error = e.message;
        throw e;
      }
    },
    model: (p) => answerModel({ ...p, kind: "model" }),
    agent: (p) => answerModel({ ...p, kind: "agent" }),
  };

  async function answerModelHttp(p, { format, host }, body) {
    const key = p.step ?? `host:${host}`;
    const at = modelCount.get(key) ?? 0;
    modelCount.set(key, at + 1);
    const conv = normalize(format, body);
    const pick = pairFor(key, at, (r) => sameNormInput(r, conv, runTime).same);
    const { rec, index: i } = pick;
    const entry = { step: p.step, key, index: i, kind: "http", url: p.url, ...(pick.pairedBy ? { pairedBy: pick.pairedBy, askedAt: at } : {}) };
    seen.models.push(entry);
    const json = (v) => ({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(v) });
    if (mode === "replay" && rec) {
      entry.mode = "replay";
      entry.input = sameNormInput(rec, normalize(format, body), runTime);
      return json(rec.response);
    }
    if (mode === "replay" && !liveFallback) {
      entry.mode = "missing";
      throw new Error(`no recorded model reply for ${key}#${i}`);
    }
    const r = await liveAnswer(normalize(format, body), { purpose: `claude-side model ${key}#${i}`, log });
    entry.mode = r.mode === "cached" ? "live-cached" : "live";
    return json(providerResponse(format, r.answer, body));
  }

  async function answerModel(req) {
    const step = req.step ?? "?";
    const key = wf ? modelKeyFor(wf, step) : step;
    const at = modelCount.get(key) ?? 0;
    modelCount.set(key, at + 1);
    const pick = pairFor(key, at, (r) => sameReplayInput(r, req, runTime));
    const { rec, index: i } = pick;
    const entry = { step, key, index: i, kind: req.kind, ...(pick.pairedBy ? { pairedBy: pick.pairedBy, askedAt: at } : {}) };
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
      if (rec.synthetic) entry.synthetic = true;
      entry.input = sameModelInput(rec, req, runTime);
      const defs = sameToolDefs(rec, req);
      if (defs) entry.toolDefs = defs;
      const tools = claudeTurn && sameToolTurn({ n8nPrev: byKey[key]?.[i - 1], n8nCall: rec, n8nEffects, n8nSources, claudeTurn, runTime, nondeterministic });
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
  // P80: the request's own step (inside a sub-workflow the id starts with the calling step).
  const wrap = (fn) => async (payload, meta) => fn({ ...payload, ownStep: payload?.step ?? null, step: String(meta?.id ?? "").split("#")[0] || null }, meta);
  for (const k of Object.keys(host)) host[k] = wrap(host[k]);

  // Poll triggers poll through their connector (the trigger read is the poll source); other
  // triggers get the fixture's items. Manual mode, as on the n8n side: a poll emits what it
  // read instead of only seeding the cursor.
  // PROPOSALS P73: where the n8n side pins trigger.items (the rows a scheduled poll would emit),
  // the Claude side's poll runs with its cursor seeded so it emits as many rows, the newest by
  // the cursor's field, as a scheduled poll does; where n8n polls once in manual mode (http
  // responses), both sides poll in manual mode with no cursor.
  const trig = def.steps[fx.trigger.node];
  const polls = !!trig?.poll && fx.trigger.kind === "poll";
  const seed = polls && n8nPinsTrigger(fx) ? pollCursorSeed(core, trig.poll, fx, conn) : null;
  const t0 = Date.now();
  const res = await core.run(def, { trigger: polls ? undefined : { node: fx.trigger.node, items: fx.trigger.items }, clock: { startedAt: startedAt ?? fx.now }, host, virtualTime: true, mode: "manual", runId: `bench-${fx.template}-${fx.variant}`, ...(seed?.cursor ? { cursors: { [fx.trigger.node]: seed.cursor } } : {}) });
  return { res, seen, files: disk.files(), wallMs: Date.now() - t0, definition: def, polled: polls, ...(seed ? { pollSeed: seed.note } : {}) };
}

// The n8n side pins a poll trigger's items unless the trigger's read has http responses, which
// it polls once in manual mode instead (n8n-side.mjs, the same test).
export function n8nPinsTrigger(fx) {
  return !(fx.trigger?.kind === "poll" && (fx.reads ?? []).some((r) => r.node === fx.trigger.node && r.http?.responses?.length));
}

// PROPOSALS P73: the cursor a scheduled poll would hold before the pinned rows. The poll read's
// first fixture answer, adapted as the runtime adapts it, gives every row the manual poll would
// emit; the cursor is the one the older rows (all but the newest n by the cursor's field, n =
// the pinned count) leave behind, checked to let exactly n rows through. With no more rows than
// pinned, no cursor field, or a check that fails, no cursor: the manual poll as before, said.
// -> {cursor|null, note}
export function pollCursorSeed(core, poll, fx, conn = connectorFixtures(fx)) {
  const n = (fx.trigger?.items ?? []).length;
  const t = poll?.tool;
  const rows = conn[`${t?.connector}.${t?.name}`] ?? [];
  const first = rows.find((r) => r.node === fx.trigger.node) ?? rows[0];
  if (!first || "error" in first) return { cursor: null, note: { pinned: n, rows: null, why: "no poll answer in the fixture" } };
  let all;
  try {
    all = core.adaptResult(poll.result, "text" in first ? first.text : first.result ?? {});
  } catch (e) {
    return { cursor: null, note: { pinned: n, rows: null, why: `poll answer not adapted: ${e.message}` } };
  }
  if (all.length <= n) return { cursor: null, note: { pinned: n, rows: all.length, emitted: all.length } };
  const spec = poll.cursor ?? {};
  if (!spec.field) return { cursor: null, note: { pinned: n, rows: all.length, why: "the poll has no cursor field" } };
  const key = (j) => {
    const v = j?.[spec.field];
    if (typeof v === "number") return v;
    const ms = typeof v === "string" && /\d{4}-\d{2}-\d{2}/.test(v) ? Date.parse(v) : NaN;
    return Number.isNaN(ms) ? (v === undefined || v === null ? -Infinity : Number.isNaN(Number(v)) ? String(v) : Number(v)) : ms;
  };
  const sorted = all.map((j, i) => ({ j, i, k: key(j) })).sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i));
  const older = sorted.slice(0, all.length - n).map((x) => x.j);
  const { cursor } = core.advanceCursor(spec, older, null);
  const emitted = core.advanceCursor(spec, all, cursor).items.length;
  if (!cursor || emitted !== n) return { cursor: null, note: { pinned: n, rows: all.length, why: `a seeded cursor lets ${emitted} rows through` } };
  return { cursor, note: { pinned: n, rows: all.length, emitted, cursor: cursor.value } };
}
