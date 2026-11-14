// Every `claude -p` the bench starts goes through here, so the budget, the memory rule and
// the usage-limit stop live in one place.
//
// Ledger: evals/bench/.work/claude-runs.jsonl (git-ignored), one line per run:
// {t, purpose, model, ok, costUsd, ms, error?}. The budget (N2C_BENCH_CLAUDE_MAX, default 60)
// counts every line, failed runs included, across bench invocations, so a resumed bench
// keeps counting. Over budget -> BudgetExceeded; a usage-limit message -> UsageLimit. Both
// stop the bench with the ledger intact, so the next invocation resumes.
//
// Memory (CLAUDE.md of the workspace): before each run, under 25% free we wait (poll every
// 3 minutes, up to 30 minutes); with the n8n container up we also wait under 40% free, so the
// container and a claude -p never share a tight machine.

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const WORK = join(HERE, ".work");
export const LEDGER = join(WORK, "claude-runs.jsonl");
export const MAX_RUNS = Number(process.env.N2C_BENCH_CLAUDE_MAX || 60);

export class BudgetExceeded extends Error {}
export class UsageLimit extends Error {}

export function claudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const pinned = join(homedir(), ".vscode/extensions/anthropic.claude-code-2.1.323-darwin-arm64/resources/native-binary/claude");
  if (existsSync(pinned)) return pinned;
  const ext = join(homedir(), ".vscode/extensions");
  const dirs = readdirSync(ext).filter((d) => d.startsWith("anthropic.claude-code-")).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const d of dirs) {
    const p = join(ext, d, "resources/native-binary/claude");
    if (existsSync(p)) return p;
  }
  throw new Error("claude CLI not found; set CLAUDE_BIN");
}

export function ledger() {
  if (!existsSync(LEDGER)) return [];
  return readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export function memoryFree() {
  try {
    const m = /free percentage:\s*(\d+)%/.exec(execFileSync("memory_pressure", { encoding: "utf8" }));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export function containerUp() {
  const r = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", "n8n2claude-bench"], { encoding: "utf8" });
  return r.stdout?.trim() === "true";
}

export async function memoryGate({ log = console.error, waitMs = 180_000, maxWaits = 10 } = {}) {
  for (let i = 0; ; i++) {
    const free = memoryFree();
    const need = containerUp() ? 40 : 25;
    if (free === null || free >= need) return free;
    if (i >= maxWaits) throw new Error(`memory stayed under ${need}% free (now ${free}%) for ${Math.round((maxWaits * waitMs) / 60000)} minutes; stopping`);
    log(`memory ${free}% free < ${need}%: waiting ${waitMs / 60000} min before claude -p (${i + 1}/${maxWaits})`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

const USAGE_RE = /usage limit|rate limit|limit reached|out of extra usage|5-hour limit|weekly limit/i;

// Runs `claude -p <prompt> ...args` and returns {json, text, costUsd, ms}. `args` are extra
// CLI flags. The session is isolated: an empty working directory, project settings only (none
// there), no MCP servers, no session file. `purpose` names the run in the ledger.
export async function claudeP({ prompt, model = "haiku", args = [], purpose, cwd, timeoutMs = 600_000, budgetUsd = 1, env: extraEnv = {}, log = console.error }) {
  mkdirSync(WORK, { recursive: true });
  const used = ledger().length;
  if (used >= MAX_RUNS) throw new BudgetExceeded(`claude -p budget of ${MAX_RUNS} runs used (${used}); see ${LEDGER}`);
  await memoryGate({ log });
  const dir = cwd ?? mkdtempSync(join(tmpdir(), "n2c-bench-claude-"));
  const env = { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", DISABLE_AUTOUPDATER: "1", NODE_OPTIONS: "--max-old-space-size=512", ...extraEnv };
  for (const k of Object.keys(env)) if (k === "ANTHROPIC_API_KEY" || k.startsWith("N2C_SECRET_") || k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_MESSAGING") || k === "CLAUDE_CODE_SESSION_ID" || k === "CLAUDE_CODE_CHILD_SESSION") delete env[k];
  const full = ["-p", prompt, "--model", model, "--output-format", "json", "--no-session-persistence", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--max-budget-usd", String(budgetUsd), ...args];
  const t0 = Date.now();
  const out = await new Promise((resolveP) => {
    const child = spawn(claudeBin(), full, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolveP({ code, stdout, stderr });
    });
  });
  const ms = Date.now() - t0;
  if (!cwd) rmSync(dir, { recursive: true, force: true });
  let json = null;
  try {
    json = JSON.parse(out.stdout.trim().split("\n").filter(Boolean).at(-1));
  } catch {}
  const text = typeof json?.result === "string" ? json.result : "";
  const entry = { t: new Date().toISOString(), purpose, model, ok: out.code === 0 && json && !json.is_error, costUsd: json?.total_cost_usd ?? null, ms, turns: json?.num_turns ?? null, usage: json?.usage ? { in: json.usage.input_tokens, out: json.usage.output_tokens, cacheRead: json.usage.cache_read_input_tokens, cacheWrite: json.usage.cache_creation_input_tokens } : null };
  if (!entry.ok) entry.error = (text || out.stderr || out.stdout).slice(0, 300);
  if (json?.permission_denials?.length) entry.denied = json.permission_denials.map((d) => `${d.tool_name}: ${JSON.stringify(d.tool_input).slice(0, 160)}`);
  appendFileSync(LEDGER, JSON.stringify(entry) + "\n");
  if (!entry.ok && USAGE_RE.test(entry.error ?? "")) throw new UsageLimit(`usage limit: ${entry.error}`);
  if (!entry.ok) {
    const e = new Error(`claude -p (${purpose}) failed: ${entry.error}`);
    e.entry = entry;
    throw e;
  }
  return { json, text, costUsd: entry.costUsd, ms, usage: entry.usage };
}
