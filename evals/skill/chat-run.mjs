#!/usr/bin/env node
// Chat-skill eval: one headless Claude Code run (`claude -p`) of the skill convert.mjs emits for a
// chat workflow, installed in a fresh project's .claude/skills/, against mock connectors. A
// message goes in; the run should make the agent's tool calls on the mocks and print the
// workflow's reply. Never touches a real account.
//
//   node evals/skill/chat-run.mjs [--fixture tests/fixtures/convert/chat-agent.n8n.json]
//        [--message "..."] [--model haiku] [--budget 1.5] [--timeout 600] [--debug]
//
// Isolation as in evals/task-driver/run.mjs: fresh project under the scratch folder,
// --strict-mcp-config with the mock servers only (killed before the first turn if anything
// else appears), --setting-sources project, --no-session-persistence, the permissions passed
// with --settings (the temp folder cannot be trusted). The hooks are NOT in the settings: the
// run shows whether the skill's own frontmatter hooks register (events.jsonl: hook-allow).
// Result: one JSON line appended to evals/skill/results.jsonl.

import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, appendFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { claudeBin, freeMemoryPercent } from "../task-driver/run.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const SERVER = join(ROOT, "evals/mocks/mcp-server.mjs");
const SCRATCH = process.env.N2C_SCRATCH ?? join(tmpdir(), "n2c-skill");
const args = process.argv.slice(2);
const flag = (k, d) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const readJson = (p, d) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : d);

const free = freeMemoryPercent();
if (free !== null && free < 30) {
  process.stderr.write(`memory: ${free}% free (< 30%); not starting claude -p\n`);
  process.exit(3);
}
const fixture = resolve(flag("fixture", join(ROOT, "tests/fixtures/convert/chat-agent.n8n.json")));
const message = flag("message", "What did Ann send me? Post it to Slack.");
const model = flag("model", "haiku");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(SCRATCH, `${stamp}-chat-skill-${model}`);
const project = join(runDir, "project");
mkdirSync(project, { recursive: true });

// Convert, then install the skill folder the way a person would.
const conv = JSON.parse(execFileSync(process.execPath, [join(ROOT, "skills/n8n-to-claude/scripts/convert.mjs"), fixture, "--out", join(runDir, "converted")], { encoding: "utf8" }));
const folder = join(conv.out, conv.workflows[0].folder);
const md = readFileSync(join(folder, "skill/SKILL.md"), "utf8");
const name = /^name: (\S+)$/m.exec(md)[1];
const skillDir = join(project, ".claude/skills", name);
cpSync(join(folder, "skill"), skillDir, { recursive: true });
const task = readJson(join(skillDir, "task.json"));

// Mock connectors and their canned answers.
const fixtures = {
  gmail: { search_threads: { default: { result: { threads: [{ id: "t1", messages: [{ id: "m1", subject: "Invoice 42", sender: "ann@example.com", snippet: "Total $250.00, due 1 Dec", date: "2026-11-14T02:30:00Z", toRecipients: ["me@example.com"] }] }] } } } },
  slack: { slack_send_message: { default: { result: { ok: true, channel: "{{args.channel_id}}", ts: "1763100000.000100" } } } },
};
const fixturesPath = join(runDir, "fixtures.json");
writeFileSync(fixturesPath, JSON.stringify(fixtures, null, 2));
const effectsLog = join(runDir, "effects.jsonl");
writeFileSync(effectsLog, "");
const { serverName, schemaFile } = await import(pathToFileURL(SERVER).href);
const mcpServers = {};
for (const c of Object.keys(task.toolPrefixes)) mcpServers[serverName(readJson(schemaFile(c)))] = { type: "stdio", command: process.execPath, args: ["--max-old-space-size=256", SERVER, "--connector", c, "--fixtures", fixturesPath, "--log", effectsLog] };
writeFileSync(join(runDir, "mcp.json"), JSON.stringify({ mcpServers }, null, 2));

// Permissions only: the Skill tool (dontAsk denies it otherwise: run 1), the runner (relative and
// absolute spellings), the inbox in the project (<cwd>/.n2c/<skill>/inbox: Claude Code refused
// a Write under .claude/skills/ even with an allow rule, runs 2 and 3), the tools.
const tools = Object.entries(task.toolPrefixes).flatMap(([c, p]) => (readJson(schemaFile(c)).tools ?? []).filter((t) => md.includes(p + t.name)).map((t) => p + t.name));
const settings = {
  permissions: {
    defaultMode: "dontAsk",
    allow: [`Skill(${name})`, `Bash(node .claude/skills/${name}/runtime/runner.mjs *)`, `Bash(node ${skillDir}/runtime/runner.mjs *)`, `Edit(.n2c/${name}/inbox/**)`, ...tools],
    deny: ["WebFetch", "WebSearch"],
  },
};
writeFileSync(join(runDir, "settings.json"), JSON.stringify(settings, null, 2));

const prompt = `Use the ${name} skill to send this message to the workflow and show me its reply:\n\n${message}`;
const bin = claudeBin();
const version = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
const cli = ["-p", prompt, "--model", model, "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--mcp-config", join(runDir, "mcp.json"), "--setting-sources", "project", "--settings", join(runDir, "settings.json"), "--no-session-persistence", "--max-budget-usd", String(flag("budget", "1.5"))];
if (args.includes("--debug")) cli.push("--debug-file", join(runDir, "debug.log"));
const env = { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", DISABLE_AUTOUPDATER: "1", NODE_OPTIONS: "--max-old-space-size=512" };
for (const k of Object.keys(env)) if (k.startsWith("N2C_SECRET_") || k === "ANTHROPIC_API_KEY") delete env[k];

const transcript = join(runDir, "stream.jsonl");
writeFileSync(transcript, "");
const t0 = Date.now();
const child = spawn(bin, cli, { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
const ours = new Set(Object.keys(mcpServers));
const s = { init: null, result: null, toolUses: [], isolation: "unchecked", stderr: "" };
let buf = "";
let killedFor = null;
const timer = setTimeout(() => ((killedFor = "timeout"), child.kill("SIGTERM")), Number(flag("timeout", "600")) * 1000);
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
      s.init = m;
      const servers = (m.mcp_servers ?? []).map((x) => x.name);
      const foreign = servers.filter((x) => !ours.has(x));
      const foreignTools = (m.tools ?? []).filter((t) => t.startsWith("mcp__") && !servers.some((x) => t.startsWith(`mcp__${x}__`)));
      s.isolation = foreign.length || foreignTools.length ? `FAILED: foreign MCP ${[...foreign, ...foreignTools].join(", ")}` : "ok";
      if (s.isolation !== "ok") ((killedFor = "isolation"), child.kill("SIGKILL"));
    }
    if (m.type === "assistant") for (const b of m.message?.content ?? []) if (b.type === "tool_use") s.toolUses.push(b.name === "Bash" ? `Bash: ${String(b.input?.command).split(project).join("<project>").slice(0, 120)}` : b.name);
    if (m.type === "result") s.result = m;
  }
});
child.stderr.on("data", (c) => (s.stderr += c));
const exitCode = await new Promise((r) => child.on("exit", (code, sig) => r(code ?? sig)));
clearTimeout(timer);

const effects = readFileSync(effectsLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const n2c = join(project, ".n2c", name);
const events = existsSync(join(n2c, "events.jsonl")) ? readFileSync(join(n2c, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const state = readJson(join(n2c, "run.json"), null);
const r = s.result ?? {};
const reply = state?.result?.output?.[0]?.output ?? null;
const record = {
  date: new Date().toISOString(),
  cli: version,
  model,
  modelId: s.init?.model,
  skill: name,
  skillLoaded: (s.init?.skills ?? s.init?.slash_commands ?? []).some((x) => String(x?.name ?? x).includes(name)),
  isolation: s.isolation,
  killedFor,
  exitCode,
  message,
  runStatus: state?.status ?? "no-run",
  runTrigger: state?.trigger,
  hooks: { allow: events.filter((e) => e.event === "hook-allow").length, deny: events.filter((e) => e.event === "hook-deny").map((e) => e.reason.slice(0, 120)), capture: events.filter((e) => e.event === "hook-capture").length },
  connectorCalls: effects.map((e) => ({ tool: `${e.connector}.${e.tool}`, args: e.args, valid: e.valid })),
  workflowReply: reply,
  replyShown: typeof r.result === "string" && !!reply && r.result.includes(String(reply).slice(0, 30)),
  finalText: typeof r.result === "string" ? r.result.slice(0, 500) : undefined,
  turns: r.num_turns,
  costUsd: r.total_cost_usd,
  wallMs: Date.now() - t0,
  permissionDenials: (r.permission_denials ?? []).map((d) => ({ tool: d.tool_name, input: JSON.stringify(d.tool_input).slice(0, 160) })),
  toolUses: s.toolUses,
  runDir,
};
const clean = JSON.stringify(record).split(SCRATCH).join("<scratch>").split(homedir()).join("~");
appendFileSync(join(HERE, "results.jsonl"), clean + "\n");
process.stdout.write(JSON.stringify(record, null, 1) + "\n");
