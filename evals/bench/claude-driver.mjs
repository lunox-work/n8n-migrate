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
//     is marked live.
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
import { claudeBin, LEDGER, ledger, MAX_RUNS, memoryGate, BudgetExceeded, UsageLimit } from "./claude.mjs";
import { connectorFixtures, httpRoutes } from "./claude-side.mjs";
import { startMock } from "../n8n/mock-server.mjs";

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

  // Mock connectors, fixtures in the mock server's format (replies in fixture order per tool).
  const conn = connectorFixtures(fx);
  const mcpFixtures = {};
  for (const [key, list] of Object.entries(conn)) {
    const [c, tool] = [key.slice(0, key.indexOf(".")), key.slice(key.indexOf(".") + 1)];
    ((mcpFixtures[c] ??= {})[tool] = { responses: list.map((x) => ("error" in x ? { error: x.error } : "text" in x ? { text: x.text } : { result: x.result ?? { ok: true } })) });
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
  if ((def.allow?.http ?? []).length) {
    const httpFixtures = join(runDir, "http-fixtures.json");
    writeFileSync(httpFixtures, JSON.stringify({ __routes: httpRoutes(fx), __writeDefault: { status: 200, body: {} } }));
    writeFileSync(httpLog, "");
    httpMock = await startMock({ port: 0, host: "127.0.0.1", log: httpLog, fixtures: httpFixtures });
  }

  const prompt = readFileSync(join(work, "task-prompt.md"), "utf8");
  const args = ["-p", prompt, "--model", model, "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--mcp-config", mcpConfig, "--setting-sources", "project", "--settings", flagSettings, "--no-session-persistence", "--max-budget-usd", "1.5"];
  const env = { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", DISABLE_AUTOUPDATER: "1", NODE_OPTIONS: "--max-old-space-size=512" };
  for (const k of Object.keys(env)) if (k === "ANTHROPIC_API_KEY" || k.startsWith("N2C_SECRET_") || k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_MESSAGING") || k === "CLAUDE_CODE_SESSION_ID" || k === "CLAUDE_CODE_CHILD_SESSION") delete env[k];
  if (httpMock) {
    env.N2C_BENCH_HTTP_MOCK = `http://127.0.0.1:${httpMock.address().port}`;
    env.NODE_OPTIONS = `${env.NODE_OPTIONS} --import=${pathToFileURL(join(HERE, "http-preload.mjs")).href}`;
    for (const sec of def.secrets ?? []) env[`N2C_SECRET_${String(sec.name).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`] = `bench-secret-${String(sec.credentialType ?? sec.name).replace(/[^\w-]+/g, "-")}`;
  }
  // The bench's start runs in the session's environment (it may reach the first http step).
  const pre = await preStart(env);
  const preText = (pre.stdout || pre.stderr).slice(0, 600);
  const transcript = join(runDir, "stream.jsonl");
  const ours = new Set(Object.keys(mcpServers));
  const t0 = Date.now();
  const summary = { init: null, result: null, isolation: "unchecked", killedFor: null, toolUses: {} };
  await new Promise((done) => {
    const child = spawn(claudeBin(), args, { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
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
  const replays = readJson(join(runDir, "replay-state.json"), { log: [] }).log;
  // The runner's http requests as the mock logged them, in the runner's request shape.
  if (httpMock) await new Promise((ok) => httpMock.close(ok));
  const httpCalls = httpMock && existsSync(httpLog) ? readFileSync(httpLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const httpEffects = httpCalls.map((e) => ({ method: e.method, url: e.method === "CONNECT" ? `https://${e.path}/` : `${e.proxied ?? "http://127.0.0.1"}${e.path}${e.rawQuery ? "?" + e.rawQuery : ""}`, query: {}, body: e.body, bodyEncoding: e.bodyEncoding, contentType: e.headers?.["content-type"] ?? null, fixture: e.fixture }));
  return {
    run: state ? { status: state.status, output: state.result?.output ?? [], error: state.result?.error ?? null } : null,
    effects: [...effects.filter((e) => e.valid).map((e) => ({ connector: e.connector, tool: e.tool, args: e.args })), ...httpEffects],
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
      ...(httpMock ? { http: httpEffects.map((h) => `${h.method} ${h.url.replace(/\?.*$/, "")} <- ${h.fixture ?? "none"}`) } : {}),
      toolUses: summary.toolUses,
      problem: !state ? "no run state" : state.status !== "done" ? `run ${state.status}` : null,
    },
  };
}
