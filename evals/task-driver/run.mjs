#!/usr/bin/env node
// Task-driver eval: one headless Claude Code run (`claude -p`) of a migrated workflow folder
// against mock connectors, isolated from the author's own setup. Never touches a real account.
//
//   node evals/task-driver/run.mjs <workflow-folder> --fixtures <file> [--model haiku|sonnet]
//        [--hooks on|off] [--hide on|off] [--label <text>] [--n <items>] [--budget <usd>]
//        [--timeout <s>] [--settings <variant>] [--prompt-file <f>] [--keep]
//
// Isolation, checked on every run:
//   - a fresh working directory under the scratch folder (N8M_SCRATCH, default <tmpdir>/n8m-task-driver),
//     laid out as convert.mjs writes a repo: the folder copied into it, the root
//     .claude/settings.json and n8m-hook.mjs beside it; the session starts at that root;
//     nothing above it has a .claude folder or CLAUDE.md;
//   - --strict-mcp-config with our mock config only, plus ENABLE_CLAUDEAI_MCP_SERVERS=false;
//     the run is killed before its first model turn if the init message lists any MCP server
//     that is not ours;
//   - --setting-sources project: only the copied folder's .claude/settings.json applies (no
//     user or local settings, so none of the author's hooks or permissions);
//   - --no-session-persistence.
// The mock servers carry the real connectors' server names (claude_ai_Gmail, ...), so the
// model sees the same tool names as in a real session.
//
// --hooks off removes the hooks from the copied settings and sets task.json hooks: false
// (the model saves tool responses itself). --settings picks a permissions variant to measure
// stalls: default (as generated) | no-bash | no-mcp | no-allow | mode-default | mode-auto.
//
// Results: one JSON line appended to evals/task-driver/results.jsonl, the stream transcript and
// the mock effects log kept in the run directory.

import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, appendFileSync, readdirSync, rmSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const SERVER = join(ROOT, "evals/mocks/mcp-server.mjs");
const RESULTS = join(HERE, "results.jsonl");
const SCRATCH = process.env.N8M_SCRATCH ?? join(tmpdir(), "n8m-task-driver");

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const n = argv[i + 1];
      if (n === undefined || n.startsWith("--") || ["keep", "probe", "debug"].includes(k)) flags[k] = true;
      else (flags[k] = n), i++;
    } else pos.push(a);
  }
  return { pos, flags };
}

export function claudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const ext = join(homedir(), ".vscode/extensions");
  const dirs = readdirSync(ext).filter((d) => d.startsWith("anthropic.claude-code-")).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const d of dirs.reverse()) {
    const p = join(ext, d, "resources/native-binary/claude");
    if (existsSync(p)) return p;
  }
  throw new Error("claude CLI not found; set CLAUDE_BIN");
}

export function freeMemoryPercent() {
  try {
    const out = execFileSync("memory_pressure", { encoding: "utf8" });
    const m = /free percentage:\s*(\d+)%/.exec(out);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

const readJson = (p, d) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : d);
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
function leaves(v) {
  if (Array.isArray(v)) return v.reduce((n, x) => n + leaves(x), 0);
  if (isObj(v)) return Object.values(v).reduce((n, x) => n + leaves(x), 0);
  return 1;
}

function applySettingsVariant(settingsPath, variant) {
  const s = readJson(settingsPath, {});
  s.permissions ??= {};
  const allow = s.permissions.allow ?? [];
  if (variant === "no-bash") s.permissions.allow = allow.filter((a) => !a.startsWith("Bash("));
  else if (variant === "no-mcp") s.permissions.allow = allow.filter((a) => !a.startsWith("mcp__"));
  else if (variant === "no-allow") s.permissions.allow = [];
  else if (variant === "mode-default") s.permissions.defaultMode = "default";
  else if (variant === "mode-auto") s.permissions.defaultMode = "auto";
  else if (variant && variant !== "default") throw new Error(`unknown --settings variant ${variant}`);
  writeFileSync(settingsPath, JSON.stringify(s, null, 2) + "\n");
  return s;
}

// What the runner would have sent with the true connector payloads and the model's own answers.
async function expectedRun(work, state, fixtures) {
  const core = await import(pathToFileURL(join(work, "runtime/runner-core.mjs")).href);
  const { mcpValue } = await import(pathToFileURL(join(work, "runtime/driver.mjs")).href);
  const counts = {};
  const trueTool = (req) => {
    const key = `${req.connector}.${req.tool}`;
    const f = fixtures[req.connector]?.[req.tool] ?? {};
    const n = (counts[key] = (counts[key] ?? 0) + 1) - 1;
    let r = Array.isArray(f.responses) && n < f.responses.length ? f.responses[n] : f.default;
    if (r === undefined) r = { result: { ok: true } };
    if (!isObj(r) || !("result" in r || "text" in r || "error" in r)) r = { result: r };
    if ("error" in r) return { ok: false, error: { name: "ToolError", message: String(r.error) } };
    const fill = (v) => (typeof v === "string" ? (/^\{\{args\.([\w.-]+)\}\}$/.test(v) ? req.args?.[/^\{\{args\.([\w.-]+)\}\}$/.exec(v)[1]] : v) : Array.isArray(v) ? v.map(fill) : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : v);
    return { ok: true, value: "text" in r ? mcpValue(String(fill(r.text))) : mcpValue([{ type: "text", text: JSON.stringify(fill(r.result)) }]) };
  };
  const actualLog = state.resultLog ?? {};
  let res = await core.start(state.definition, { clock: { startedAt: state.startedAt }, runId: state.runId, trigger: state.trigger ?? undefined, mode: state.mode, batchSize: state.batchSize });
  const trueResults = {};
  for (let guard = 0; res.status === "needs" && guard < 1000; guard++) {
    const results = {};
    for (const q of res.requests) {
      if (q.kind === "tool") results[q.id] = trueTool(q);
      else if (q.kind === "sleep") results[q.id] = { ok: true, value: { resumedAt: q.until } };
      else results[q.id] = actualLog[q.id] ?? { ok: true, value: "<no answer in the actual run>" };
      if (q.kind === "tool") trueResults[q.id] = results[q.id];
    }
    res = await core.resume(res.state, results);
  }
  return { status: res.status, effects: res.state?.effects ?? res.effects ?? [], trueResults, error: res.state?.result?.error };
}

function compareArgs(want, got) {
  const fields = [];
  let lineDiffs = 0;
  for (const k of new Set([...Object.keys(want ?? {}), ...Object.keys(got ?? {})])) {
    const a = want?.[k];
    const b = got?.[k];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    fields.push(k);
    if (typeof a === "string" && typeof b === "string") {
      const la = a.split("\n");
      const lb = b.split("\n");
      for (let i = 0; i < Math.max(la.length, lb.length); i++) if (la[i] !== lb[i]) lineDiffs++;
    }
  }
  return { fields, lineDiffs };
}

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  if (!pos[0] || !flags.fixtures) {
    process.stderr.write("usage: run.mjs <workflow-folder> --fixtures <file> [--model haiku] [--hooks on|off] [--label x]\n");
    return 2;
  }
  const free = freeMemoryPercent();
  if (free !== null && free < 30) {
    process.stderr.write(`memory: ${free}% free (< 30%); not starting claude -p\n`);
    return 3;
  }
  const folder = resolve(pos[0]);
  const fixturesPath = resolve(flags.fixtures);
  const fixtures = readJson(fixturesPath);
  const model = flags.model ?? "haiku";
  const hooks = (flags.hooks ?? "on") !== "off";
  const hide = flags.hide === "on";
  const label = flags.label ?? `${basename(folder)}-${model}-hooks-${hooks ? "on" : "off"}`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(SCRATCH, `${stamp}-${label.replace(/[^\w.-]+/g, "_")}`);
  // The repository layout convert.mjs writes: the workflow folder inside a repo whose root
  // holds the union settings and the hook dispatcher; the session starts at the root.
  const repo = join(runDir, "work");
  const work = join(repo, basename(folder));
  mkdirSync(runDir, { recursive: true });
  cpSync(folder, work, { recursive: true, filter: (src) => !src.includes(`${folder}/.n8m`) && !src.includes(`${folder}/skill`) });
  const { writeRootSettings } = await import(pathToFileURL(join(ROOT, "skills/n8n-migrate/scripts/convert.mjs")).href);
  writeRootSettings(repo);

  // Hooks on/off and the settings variant.
  const settingsPath = join(repo, ".claude/settings.json");
  const settings = applySettingsVariant(settingsPath, flags.settings);
  const task = readJson(join(work, "task.json"), {});
  task.hooks = hooks;
  task.hideToolOutput = hide;
  if (flags.compact === "whole") task.compactWhole = true;
  else if (flags.compact !== undefined) task.compactOver = Number(flags.compact);
  writeFileSync(join(work, "task.json"), JSON.stringify(task, null, 2) + "\n");
  if (!hooks) {
    delete settings.hooks;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }

  // Mock connectors under the real server names.
  const effectsLog = join(runDir, "effects.jsonl");
  writeFileSync(effectsLog, "");
  const mcpServers = {};
  const connectors = Object.keys({ ...task.toolPrefixes, ...fixtures });
  for (const c of connectors) {
    const { serverName, schemaFile } = await import(pathToFileURL(SERVER).href);
    const name = serverName(readJson(schemaFile(c)));
    mcpServers[name] = { type: "stdio", command: process.execPath, args: ["--max-old-space-size=256", SERVER, "--connector", c, "--fixtures", fixturesPath, "--log", effectsLog] };
  }
  const mcpConfig = join(runDir, "mcp.json");
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers }, null, 2) + "\n");

  const prompt = readFileSync(flags["prompt-file"] ? resolve(flags["prompt-file"]) : join(work, "task-prompt.md"), "utf8");
  const bin = claudeBin();
  const version = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
  const args = ["-p", prompt, "--model", model, "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--mcp-config", mcpConfig, "--setting-sources", "project", "--no-session-persistence", "--max-budget-usd", String(flags.budget ?? (model === "haiku" ? 1.5 : 4))];
  // A -p run in a workspace nobody trusted drops the project's permissions.allow (observed:
  // "Dropped 3 project-scoped permissions.allow entries — workspace not yet trusted"). The
  // temp dir cannot be trusted without editing the author's ~/.claude.json, so by default the
  // folder's settings go in through --settings (same content, flag scope) and the project
  // copy is moved aside. --trust project keeps the untrusted project file as it is.
  const trust = flags.trust ?? "flag";
  if (trust === "flag") {
    const flagSettings = join(runDir, "task-settings.json");
    writeFileSync(flagSettings, readFileSync(settingsPath));
    rmSync(settingsPath);
    args.push("--settings", flagSettings);
  }
  const env = { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", DISABLE_AUTOUPDATER: "1", NODE_OPTIONS: "--max-old-space-size=512" };
  for (const k of Object.keys(env)) if (k.startsWith("N8M_SECRET_") || k === "ANTHROPIC_API_KEY") delete env[k];
  if (flags.debug) args.push("--debug-file", join(runDir, "debug.log"));

  const transcript = join(runDir, "stream.jsonl");
  writeFileSync(transcript, "");
  const t0 = Date.now();
  const child = spawn(bin, args, { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  const ours = new Set(Object.keys(mcpServers));
  const summary = { init: null, result: null, toolUses: {}, isolation: "unchecked", stderr: "" };
  let buf = "";
  let killedFor = null;
  const timeoutS = Number(flags.timeout ?? 900);
  const timer = setTimeout(() => {
    killedFor = "timeout";
    child.kill("SIGTERM");
  }, timeoutS * 1000);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    appendFileSync(transcript, chunk);
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.type === "system" && m.subtype === "init") {
        summary.init = m;
        const servers = (m.mcp_servers ?? []).map((s) => s.name);
        const foreign = servers.filter((s) => !ours.has(s));
        const foreignTools = (m.tools ?? []).filter((t) => t.startsWith("mcp__") && !servers.some((s) => t.startsWith(`mcp__${s}__`)));
        summary.isolation = foreign.length || foreignTools.length ? `FAILED: foreign MCP ${[...foreign, ...foreignTools].join(", ")}` : "ok";
        if (summary.isolation !== "ok") {
          killedFor = "isolation";
          child.kill("SIGKILL");
        } else if (flags.probe) {
          killedFor = "probe";
          child.kill("SIGKILL");
        }
      }
      if (m.type === "assistant") for (const b of m.message?.content ?? []) if (b.type === "tool_use") summary.toolUses[b.name] = (summary.toolUses[b.name] ?? 0) + 1;
      if (m.type === "result") summary.result = m;
    }
  });
  child.stderr.on("data", (c) => (summary.stderr += c));
  const exitCode = await new Promise((res) => child.on("exit", (code, sig) => res(code ?? sig)));
  clearTimeout(timer);
  const wallMs = Date.now() - t0;

  if (flags.probe) {
    const i = summary.init ?? {};
    process.stdout.write(JSON.stringify({ isolation: summary.isolation, killedFor, cwd: i.cwd, model: i.model, permissionMode: i.permissionMode, mcp_servers: i.mcp_servers, tools: i.tools, slash_commands: i.slash_commands, skills: i.skills, plugins: i.plugins, agents: i.agents, memory: i.memory_paths, keys: Object.keys(i), stderr: summary.stderr.slice(0, 500) }, null, 1) + "\n");
    return 0;
  }
  // Collect.
  const n8m = join(work, ".n8m");
  let state = readJson(join(n8m, "run.json"), null);
  if (state && state.status !== "needs") state = readJson(join(n8m, "runs", `${state.runId}.json`), state);
  const effects = existsSync(effectsLog) ? readFileSync(effectsLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const events = existsSync(join(n8m, "events.jsonl")) ? readFileSync(join(n8m, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const allowedTools = new Set((state?.definition?.allow?.tools ?? []).map((t) => `${t.connector}.${t.tool}`));
  const validCalls = effects.filter((e) => e.valid);
  const outside = effects.filter((e) => !allowedTools.has(`${e.connector}.${e.tool}`));

  let fidelity = null;
  if (state) {
    const exp = await expectedRun(work, state, fixtures);
    const expWrites = exp.effects.filter((e) => e.kind === "tool" && e.effect === "write").map((e) => ({ tool: `${e.request.connector}.${e.request.tool}`, args: e.request.args }));
    const actWrites = validCalls.filter((e) => allowedTools.has(`${e.connector}.${e.tool}`) && exp.effects.some((x) => x.kind === "tool" && x.effect === "write" && `${x.request.connector}.${x.request.tool}` === `${e.connector}.${e.tool}`)).map((e) => ({ tool: `${e.connector}.${e.tool}`, args: e.args }));
    const writes = expWrites.map((w, i) => ({ tool: w.tool, ...(actWrites[i] ? compareArgs(w.args, actWrites[i].args) : { missing: true }), bytes: Buffer.byteLength(JSON.stringify(w.args)) }));
    // Transcription: the tool results the runner got vs the true payloads.
    const { diffPaths } = await import(pathToFileURL(join(work, "runtime/driver.mjs")).href);
    const transcription = Object.entries(exp.trueResults).map(([id, tr]) => {
      const got = state.resultLog?.[id];
      return { id, leaves: leaves(tr.value), diffs: got ? diffPaths(tr.value, got.value).length : null, bytes: Buffer.byteLength(JSON.stringify(tr.value)) };
    });
    fidelity = {
      expectedStatus: exp.status,
      writes,
      extraWrites: Math.max(0, actWrites.length - expWrites.length),
      exact: writes.every((w) => !w.missing && w.fields.length === 0) && actWrites.length === expWrites.length,
      transcription,
    };
  }
  const r = summary.result ?? {};
  const record = {
    date: new Date().toISOString(),
    cli: version,
    model,
    modelId: summary.init?.model,
    label,
    workflow: basename(folder),
    n: flags.n ? Number(flags.n) : undefined,
    fixtures: basename(fixturesPath),
    hooks,
    hideToolOutput: hide,
    compact: task.compactWhole ? "whole" : task.compactOver,
    settings: flags.settings ?? "default",
    trust: flags.trust ?? "flag",
    permissionMode: summary.init?.permissionMode,
    isolation: summary.isolation,
    killedFor,
    exitCode,
    runStatus: state?.status ?? "no-run",
    runError: state?.result?.error?.message,
    turns: r.num_turns,
    costUsd: r.total_cost_usd,
    usage: r.usage ? { input: r.usage.input_tokens, output: r.usage.output_tokens, cacheRead: r.usage.cache_read_input_tokens, cacheWrite: r.usage.cache_creation_input_tokens } : undefined,
    wallMs,
    apiMs: r.duration_api_ms,
    resultSubtype: r.subtype,
    permissionDenials: (r.permission_denials ?? []).map((d) => ({ tool: d.tool_name, input: JSON.stringify(d.tool_input).slice(0, 160) })),
    toolUses: summary.toolUses,
    hookDenies: events.filter((e) => e.event === "hook-deny").map((e) => e.reason.slice(0, 140)),
    hookCaptures: events.filter((e) => e.event === "hook-capture").length,
    hookExpanded: events.filter((e) => e.event === "hook-allow" && e.expanded).length,
    connectorCalls: effects.map((e) => `${e.connector}.${e.tool}${e.valid ? "" : " (invalid)"}`),
    outsideDefinition: outside.map((e) => ({ tool: `${e.connector}.${e.tool}`, args: JSON.stringify(e.args).slice(0, 200) })),
    fidelity,
    finalText: typeof r.result === "string" ? r.result.slice(0, 300) : undefined,
    runDir,
  };
  // Local paths stay out of the committed log.
  const clean = JSON.stringify(record).split(SCRATCH).join("<scratch>").split(homedir()).join("~");
  appendFileSync(RESULTS, clean + "\n");
  process.stdout.write(JSON.stringify({ ...record, fidelity: fidelity && { ...fidelity, transcription: fidelity.transcription } }, null, 1) + "\n");
  if (!flags.keep) for (const d of ["runtime"]) rmSync(join(work, d), { recursive: true, force: true });
  return 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().then((c) => process.exit(c), (e) => (process.stderr.write(`run.mjs: ${e.stack}\n`), process.exit(1)));
