// The claude driver: the migrated folder run as a task would run it, by `claude -p --model
// haiku` with the folder's own task prompt, allowlist and hooks, against the mock connectors.
// Isolation and flags follow evals/task-driver/run.mjs (fresh repo under .work, strict MCP
// config with our mocks under the real server names, project settings passed with --settings,
// no session file, killed before the first turn if a foreign MCP server shows up).
//
// Differences from evals/task-driver/run.mjs, all on the bench side:
//   - the run is started by the bench (`runner.mjs start --trigger <json> --clock`), so the
//     fixture's trigger items and n8n's clock go in; the session's `start` continues that run.
//     Poll triggers therefore get the fixture's items here instead of polling (the in-process
//     driver exercises the poll).
//   - replay hook: a PreToolUse hook on Write replaces the model's answer for a model or agent
//     request (.n2c/inbox/<q>.txt) with n8n's recorded reply for the same model node and call
//     index (the session still writes and submits it). A miss leaves the model's own answer and
//     is marked live. The hook keeps each replayed request and its time (replayLog), so the
//     bench checks the question and each agent turn's tools as in process (PROPOSALS P16).
//   - http steps (PROPOSALS P5): the task driver executes them itself with fetch. The bench
//     starts a host mock-server.mjs with the fixture's http routes (the routes the in-process
//     driver answers from) and preloads http-preload.mjs into the session's node processes,
//     which sends the runner's fetch to that mock; the mock's log is the http half of the
//     effects. Each secret the definition names gets a dummy N2C_SECRET_<NAME> (the person
//     stores the real one at setup).

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { claudeBin, LEDGER, ledger, MAX_RUNS, memoryGate, spawnWithPrompt, BudgetExceeded, UsageLimit } from "./claude.mjs";
import { connectorFixtures, driverFiles, httpRoutes, modelKeyFor } from "./claude-side.mjs";
import { fromTool } from "./compare.mjs";
import { startMock } from "../n8n/mock-server.mjs";
import { startShim } from "./model-shim.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const SERVER = join(ROOT, "evals", "mocks", "mcp-server.mjs");
const readJson = (p, d = null) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : d);

export async function runClaudeDriver(folder, fx, { wf, recordings = [], startedAt, label, model = "haiku", timeoutS = 900, log = console.error }) {
  const def = readJson(join(folder, "definition.json"));
  if (ledger().length >= MAX_RUNS) throw new BudgetExceeded(`claude -p budget of ${MAX_RUNS} runs used`);
  await memoryGate({ log });
  const runDir = join(HERE, ".work", "claude-driver", label.replace(/[^\w.-]+/g, "_"));
  rmSync(runDir, { recursive: true, force: true });
  const repo = join(runDir, "work");
  const name = basename(folder);
  const work = join(repo, name);
  mkdirSync(repo, { recursive: true });
  cpSync(folder, work, { recursive: true, filter: (src) => !src.includes(`${folder}/.n2c`) && !src.includes(`${folder}/skill`) });
  const { writeRootSettings } = await import(pathToFileURL(join(ROOT, "skills", "n8n-to-claude", "scripts", "convert.mjs")).href);
  writeRootSettings(repo);

  // Mock connectors, fixtures in the mock server's format (replies in fixture order per tool;
  // PROPOSALS P11: a row's args are matched first, and a read reuses a row whose args fit).
  const conn = connectorFixtures(fx);
  const mcpFixtures = {};
  for (const [key, list] of Object.entries(conn)) {
    const [c, tool] = [key.slice(0, key.indexOf(".")), key.slice(key.indexOf(".") + 1)];
    const reuse = fromTool({ connector: c, tool, args: {} }).effect === "read";
    ((mcpFixtures[c] ??= {})[tool] = { ...(reuse ? { reuse: true } : {}), responses: list.map((x) => ({ ...("error" in x ? { error: x.error } : "text" in x ? { text: x.text } : { result: x.result ?? { ok: true } }), ...(x.args ? { args: x.args } : {}) })) });
  }
  const fixturesPath = join(runDir, "connector-fixtures.json");
  writeFileSync(fixturesPath, JSON.stringify(mcpFixtures));
  const effectsLog = join(runDir, "effects.jsonl");
  writeFileSync(effectsLog, "");
  const task = readJson(join(work, "task.json"), {});
  const { serverName, schemaFile } = await import(pathToFileURL(SERVER).href);
  const mcpServers = {};
  for (const c of new Set([...Object.keys(task.toolPrefixes ?? {}), ...Object.keys(mcpFixtures)])) mcpServers[serverName(readJson(schemaFile(c)))] = { type: "stdio", command: process.execPath, args: ["--max-old-space-size=256", SERVER, "--connector", c, "--fixtures", fixturesPath, "--log", effectsLog] };
  const mcpConfig = join(runDir, "mcp.json");
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers }));

  // Replay hook beside the folder's own hooks.
  const recFile = join(runDir, "recordings.json");
  writeFileSync(recFile, JSON.stringify({ recordings, workflow: wf, folder: work }));
  const settingsPath = join(repo, ".claude", "settings.json");
  const settings = readJson(settingsPath, {});
  settings.hooks ??= {};
  (settings.hooks.PreToolUse ??= []).push({ matcher: "^Write$", hooks: [{ type: "command", command: `${process.execPath} ${join(HERE, "replay-hook.mjs")} ${recFile}` }] });
  const flagSettings = join(runDir, "task-settings.json");
  writeFileSync(flagSettings, JSON.stringify(settings, null, 2));
  rmSync(settingsPath);

  // The bench starts the run: trigger items and n8n's clock.
  // The driver's `start` takes the trigger as inline JSON (no @file); no shell is involved.
  // Asynchronous: the http mock answers from this process, so it must not be blocked.
  const preStart = (env) =>
    new Promise((ok) => {
      const c = spawn(process.execPath, [join(work, "runtime", "runner.mjs"), "start", "--trigger", JSON.stringify(fx.trigger.items), "--clock", startedAt ?? fx.now], { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      c.stdout.on("data", (x) => (stdout += x));
      c.stderr.on("data", (x) => (stderr += x));
      c.on("exit", () => ok({ stdout, stderr }));
    });

  // http steps go to a mock on the host (see the header).
  const httpLog = join(runDir, "http.jsonl");
  let httpMock = null;
  let httpShim = null;
  if ((def.allow?.http ?? []).length) {
    const httpFixtures = join(runDir, "http-fixtures.json");
    writeFileSync(httpFixtures, JSON.stringify({ __routes: httpRoutes(fx), __writeDefault: { status: 200, body: {} } }));
    writeFileSync(httpLog, "");
    // PROPOSALS P43: an LLM API over HTTP goes, as on the n8n side, from the mock to a model
    // shim, here one that replays n8n's recorded replies by tag (host:<host>) and call index; a
    // miss gets the canned reply (no claude -p inside the session's run).
    const hostCalls = {};
    for (const c of recordings) if (String(c.tag ?? "").startsWith("host:")) (hostCalls[c.tag] ??= [])[c.index] = c;
    if (Object.keys(hostCalls).length) {
      httpShim = await startShim({ port: 0, host: "127.0.0.1", log });
      httpShim.setSession({ mode: "replay", recorded: hostCalls, fallback: "canned", label: label });
    }
    httpMock = await startMock({ port: 0, host: "127.0.0.1", log: httpLog, fixtures: httpFixtures, ...(httpShim ? { modelShim: `http://127.0.0.1:${httpShim.server.address().port}` } : {}) });
  }

  // Disk steps (PROPOSALS P44): fixture `file` sources go where the runner reads them, never
  // on the real disk; absolute paths under a scratch root that disk-preload.mjs redirects to.
  const diskRoot = join(runDir, "disk");
  const absDirs = (def.allow?.files ?? []).map((a) => a?.dir).filter((d) => typeof d === "string" && d.startsWith("/") && d !== "/");
  if ((def.allow?.files ?? []).length) {
    for (const r of fx.reads ?? []) {
      if (!r.file?.path) continue;
      const p = String(r.file.path);
      const to = p.startsWith("/") ? join(diskRoot, p) : join(work, p.replace(/^~\//, ""));
      if (!resolve(to).startsWith(`${runDir}/`)) continue;
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, r.file.base64 !== undefined ? Buffer.from(r.file.base64, "base64") : String(r.file.text ?? ""));
    }
  }

  const prompt = readFileSync(join(work, "task-prompt.md"), "utf8");
  // The task prompt goes on stdin (PROPOSALS P14), as every bench `claude -p` does.
  const args = ["-p", "--model", model, "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--mcp-config", mcpConfig, "--setting-sources", "project", "--settings", flagSettings, "--no-session-persistence", "--max-budget-usd", "1.5"];
  const env = sessionEnv({ httpMockUrl: httpMock ? `http://127.0.0.1:${httpMock.address().port}` : null, secrets: def.secrets ?? [], diskRoot, absDirs });
  // The bench's start runs in the session's environment (it may reach the first http step).
  const pre = await preStart(env);
  const preText = (pre.stdout || pre.stderr).slice(0, 600);
  const transcript = join(runDir, "stream.jsonl");
  const ours = new Set(Object.keys(mcpServers));
  const t0 = Date.now();
  const summary = { init: null, result: null, isolation: "unchecked", killedFor: null, toolUses: {} };
  await new Promise((done) => {
    const child = spawnWithPrompt(claudeBin(), args, prompt, { cwd: repo, env });
    const timer = setTimeout(() => ((summary.killedFor = "timeout"), child.kill("SIGTERM")), timeoutS * 1000);
    let buf = "";
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
          const servers = (m.mcp_servers ?? []).map((s) => s.name);
          const foreign = [...servers.filter((s) => !ours.has(s)), ...(m.tools ?? []).filter((t) => t.startsWith("mcp__") && !servers.some((s) => t.startsWith(`mcp__${s}__`)))];
          summary.isolation = foreign.length ? `FAILED: ${foreign.join(", ")}` : "ok";
          if (foreign.length) (summary.killedFor = "isolation"), child.kill("SIGKILL");
        }
        if (m.type === "assistant") for (const b of m.message?.content ?? []) if (b.type === "tool_use") summary.toolUses[b.name] = (summary.toolUses[b.name] ?? 0) + 1;
        if (m.type === "result") summary.result = m;
      }
    });
    child.on("exit", () => (clearTimeout(timer), done()));
  });
  const wallMs = Date.now() - t0;
  const r = summary.result ?? {};
  const entry = { t: new Date().toISOString(), purpose: `claude-driver ${label}`, model, ok: !!summary.result && !r.is_error, costUsd: r.total_cost_usd ?? null, ms: wallMs, turns: r.num_turns ?? null };
  appendFileSync(LEDGER, JSON.stringify(entry) + "\n");
  if (!entry.ok && /usage limit|rate limit/i.test(JSON.stringify(r.result ?? ""))) throw new UsageLimit(String(r.result).slice(0, 200));

  const n2c = join(work, ".n2c");
  let state = readJson(join(n2c, "run.json"));
  if (state && state.status !== "needs") state = readJson(join(n2c, "runs", `${state.runId}.json`), state);
  const effects = existsSync(effectsLog) ? readFileSync(effectsLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const events = existsSync(join(n2c, "events.jsonl")) ? readFileSync(join(n2c, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const replayState = readJson(join(runDir, "replay-state.json"), { ids: {}, counts: {}, log: [] });
  const replays = replayState.log;
  // PROPOSALS P40: a session that stopped while the run waited on a model answer it could have
  // handed back (n8n's reply was there to replay) broke the runner protocol; not a verdict.
  const slip = protocolSlip({ state, killedFor: summary.killedFor, resultOk: !!summary.result && !r.is_error, hookDenies: events.filter((e) => e.event === "hook-deny").length, permissionDenials: (r.permission_denials ?? []).length, replayState, recordings, workflow: wf });
  // PROPOSALS P16: what each replayed request asked, for the model-input and tool-turn checks.
  const replayLog = replays.filter((x) => !x.repeat).map(({ id, key, index, mode, t, req }) => ({ id, key, index, mode, t, req }));
  // The runner's http requests as the mock logged them, in the runner's request shape.
  if (httpMock) await new Promise((ok) => httpMock.close(ok));
  const httpModelCalls = httpShim ? httpShim.session.calls.map(({ tag, index, format, request, mode }) => ({ tag, index, format, request, mode })) : [];
  if (httpShim) await new Promise((ok) => httpShim.server.close(ok));
  // Model calls over HTTP are not effects (P43); the shim's log has them.
  const httpCalls = httpMock && existsSync(httpLog) ? readFileSync(httpLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => !e.model) : [];
  const httpEffects = httpCalls.map((e) => ({ t: e.t, method: e.method, url: e.method === "CONNECT" ? `https://${e.path}/` : `${e.proxied ?? "http://127.0.0.1"}${e.path}${e.rawQuery ? "?" + e.rawQuery : ""}`, query: {}, body: e.body, bodyEncoding: e.bodyEncoding, contentType: e.headers?.["content-type"] ?? null, fixture: e.fixture }));
  // P44: the files the run wrote (final bytes per path), from the run state's file requests.
  const files = state ? driverFiles((state.effects ?? []).filter((e) => state.resultLog?.[e.id]?.ok !== false), fx) : [];
  return {
    run: state ? { status: state.status, output: state.result?.output ?? [], error: state.result?.error ?? null } : null,
    effects: [...effects.filter((e) => e.valid).map((e) => ({ t: e.t, connector: e.connector, tool: e.tool, args: e.args })), ...httpEffects, ...files.map((f) => ({ file: true, ...f }))],
    replayLog,
    httpModelCalls,
    invalidCalls: effects.filter((e) => !e.valid).map((e) => `${e.connector}.${e.tool}: ${e.error}`),
    allow: def.allow,
    metrics: { wallMs, turns: r.num_turns ?? null, costUsd: r.total_cost_usd ?? null, usage: r.usage ? { in: r.usage.input_tokens, out: r.usage.output_tokens, cacheRead: r.usage.cache_read_input_tokens } : null },
    summary: {
      isolation: summary.isolation,
      killedFor: summary.killedFor,
      runStatus: state?.status ?? "no-run",
      runError: state?.result?.error?.message ?? null,
      prestart: preText,
      finalText: typeof r.result === "string" ? r.result.slice(0, 300) : null,
      permissionDenials: (r.permission_denials ?? []).map((d) => `${d.tool_name}: ${JSON.stringify(d.tool_input).slice(0, 120)}`),
      hookDenies: events.filter((e) => e.event === "hook-deny").map((e) => String(e.reason).slice(0, 140)),
      replays: replays.map((x) => `${x.key}#${x.index} ${x.mode}`),
      ...(httpModelCalls.length ? { httpModels: httpModelCalls.map((c) => `${c.tag}#${c.index} ${c.mode}`) } : {}),
      ...(httpMock ? { http: httpEffects.map((h) => `${h.method} ${h.url.replace(/\?.*$/, "")} <- ${h.fixture ?? "none"}`) } : {}),
      toolUses: summary.toolUses,
      problem: !state ? "no run state" : state.status !== "done" ? `run ${state.status}` : null,
      ...(slip ? { slip } : {}),
    },
  };
}

// The session's environment: no foreign keys or session ids, the runner processes' heap cap,
// the http preload (P5) when the folder has http steps (with a dummy N2C_SECRET_<NAME> per
// declared secret), and the disk preload (P44) when allow.files names absolute directories.
// Exported for the self-test that runs a runner process with it (PROPOSALS P47).
export function sessionEnv({ base = process.env, httpMockUrl = null, secrets = [], diskRoot = null, absDirs = [] } = {}) {
  const env = { ...base, ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", DISABLE_AUTOUPDATER: "1", NODE_OPTIONS: "--max-old-space-size=512" };
  for (const k of Object.keys(env)) if (k === "ANTHROPIC_API_KEY" || k.startsWith("N2C_SECRET_") || k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_MESSAGING") || k === "CLAUDE_CODE_SESSION_ID" || k === "CLAUDE_CODE_CHILD_SESSION") delete env[k];
  if (httpMockUrl) {
    env.N2C_BENCH_HTTP_MOCK = httpMockUrl;
    env.NODE_OPTIONS = `${env.NODE_OPTIONS} --import=${pathToFileURL(join(HERE, "http-preload.mjs")).href}`;
    for (const sec of secrets) env[`N2C_SECRET_${String(sec.name).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`] = `bench-secret-${String(sec.credentialType ?? sec.name).replace(/[^\w-]+/g, "-")}`;
  }
  if (absDirs.length) {
    env.N2C_BENCH_DISK_ROOT = diskRoot;
    env.N2C_BENCH_DISK_DIRS = JSON.stringify(absDirs);
    env.NODE_OPTIONS = `${env.NODE_OPTIONS} --import=${pathToFileURL(join(HERE, "disk-preload.mjs")).href}`;
  }
  return env;
}

// PROPOSALS P40: a claude-driver protocol slip. The run waits (`needs`) on a model or agent
// request for which n8n's recorded reply was there to replay, and the session ended on its own
// (a final result, not killed, not an error) with no hook or permission denial: the session
// wrote its own final text instead of handing the answer back. Such a run says nothing about
// the migrated folder; the bench retries it once (run.mjs). Returns {why, outstanding} or null.
export function protocolSlip({ state, killedFor = null, resultOk = false, hookDenies = 0, permissionDenials = 0, replayState = {}, recordings = [], workflow = null }) {
  if (state?.status !== "needs" || killedFor || !resultOk || hookDenies || permissionDenials) return null;
  const counts = { ...(replayState.counts ?? {}) };
  const outstanding = [];
  for (const q of state.requests ?? []) {
    if (!["model", "agent"].includes(q.kind)) continue;
    const step = String(q.id).split("#")[0];
    const key = workflow ? modelKeyFor(workflow, step) : step;
    const index = replayState.ids?.[q.id] ?? counts[key] ?? 0;
    if (replayState.ids?.[q.id] === undefined) counts[key] = index + 1;
    if (recordings.some((x) => x.node === key && x.index === index)) outstanding.push(`${q.id} (${key}#${index})`);
  }
  return outstanding.length ? { why: "the session ended while the run waited on a model answer n8n's recorded reply could give", outstanding } : null;
}
