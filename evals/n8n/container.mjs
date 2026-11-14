#!/usr/bin/env node
// The bench's local n8n: one pinned, memory-capped container on an internal
// Docker network, plus a small sidecar that is the HTTP mock and the only way
// in from the host. Zero dependencies; drives the `docker` CLI.
//
//   node evals/n8n/container.mjs up [--fresh] [--env K=V]...  start (fresh: new database volume)
//   node evals/n8n/container.mjs down [--purge]   remove containers and networks (purge: volume too)
//   node evals/n8n/container.mjs status           state, health, memory
//   node evals/n8n/container.mjs exec -- <cmd...> run a command in the n8n container
//                                                 (`n8n ...` gets its own task-broker port)
//
// Layout (see HEADLESS.md):
//   n8n2claude-bench  n8nio/n8n:2.47.7, 1 GB RAM and swap, network n8n2claude-net
//                     (--internal: no route out), volume n8n2claude-bench-data.
//   n8n2claude-mock   node:22-alpine running mock-server.mjs. On n8n2claude-net as
//                     host `mock` (port 8080) and on n8n2claude-edge, which publishes
//                     127.0.0.1:5690 and relays it to n8n:5678. n8n can reach the mock
//                     and nothing else. The mock reads <work>/fixtures.json and appends
//                     <work>/effects.jsonl; <work> is not mounted into n8n.
//
// Credentials in here are the bench's own dummies: the encryption key and the
// owner password protect nothing and are not the author's.

import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const IMAGE = "n8nio/n8n:2.47.7";
export const SIDECAR_IMAGE = "node:22-alpine";
export const NAME = "n8n2claude-bench";
export const MOCK_NAME = "n8n2claude-mock";
export const NET = "n8n2claude-net"; // internal
export const EDGE = "n8n2claude-edge"; // publishes the host port
export const VOLUME = "n8n2claude-bench-data";
export const HOST_PORT = 5690;
export const BASE = `http://127.0.0.1:${HOST_PORT}`;
export const MOCK_URL = "http://mock:8080"; // as n8n sees it
export const WORK = resolve(process.env.N8N_BENCH_WORK || join(HERE, ".work"));
export const OWNER_EMAIL = "bench@example.com";
export const OWNER_PASSWORD = "Bench-only-pass-1";
const OWNER_HASH = "$2a$10$0d25sQavlnXIlqc9ULyWquYP6.jOU47UnxfMHrI86M8oZ9jVcRCsa"; // bcrypt of OWNER_PASSWORD
// TLS interception (evals/bench/tls.mjs): the mock gets the leaves, n8n trusts only the CA.
export const TLS_DIR = resolve(process.env.N2C_BENCH_TLS || join(HERE, "..", "bench", ".tls"));
// The bench's model shim runs on the host (evals/bench/model-shim.mjs); the mock forwards to
// it over the edge network. n8n itself still reaches nothing but the mock.
export const MODEL_SHIM_PORT = Number(process.env.N2C_MODEL_SHIM_PORT || 5691);
export const ENCRYPTION_KEY = "n8n2claude-bench-key-not-a-secret";
const CLI_BROKER_PORT = "5681"; // `n8n execute` and friends start a second task broker

export const ENV = {
  N8N_ENCRYPTION_KEY: ENCRYPTION_KEY,
  GENERIC_TIMEZONE: "UTC",
  TZ: "UTC",
  N8N_DIAGNOSTICS_ENABLED: "false",
  N8N_PERSONALIZATION_ENABLED: "false",
  N8N_VERSION_NOTIFICATIONS_ENABLED: "false",
  N8N_TEMPLATES_ENABLED: "false",
  N8N_HIRING_BANNER_ENABLED: "false",
  // 2.x has no N8N_RUNNERS_ENABLED: runners are always on. Internal mode runs the
  // JS runner as a child process. The image has no Python: Python Code nodes fail,
  // and every start logs "Failed to start Python task runner" (harmless).
  N8N_RUNNERS_MODE: "internal",
  N8N_RUNNERS_MAX_OLD_SPACE_SIZE: "256",
  N8N_PYTHON_ENABLED: "false",
  // 2.47 refuses to import a workflow holding a deprecated node (Function,
  // Function Item, LangChain Code v1) and fails the whole --separate batch.
  N8N_DEPRECATED_NODES_BLOCK: "false",
  NODE_OPTIONS: "--max-old-space-size=640",
  // Headless owner: no setup screen, REST login works from the first start.
  N8N_INSTANCE_OWNER_MANAGED_BY_ENV: "true",
  N8N_INSTANCE_OWNER_EMAIL: OWNER_EMAIL,
  N8N_INSTANCE_OWNER_PASSWORD_HASH: OWNER_HASH,
  N8N_SECURE_COOKIE: "false", // plain http on loopback
  WEBHOOK_URL: `${BASE}/`,
  EXECUTIONS_DATA_SAVE_ON_SUCCESS: "all",
  EXECUTIONS_DATA_SAVE_ON_ERROR: "all",
  EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS: "true",
  N8N_LOG_LEVEL: "warn",
  // Every outbound call goes to the mock, even to a real hostname: plain HTTP is
  // answered from the fixtures (keyed by origin), HTTPS shows up in the log as
  // CONNECT host:443 and is refused. The internal network blocks anything else.
  HTTP_PROXY: `${MOCK_URL}`,
  HTTPS_PROXY: `${MOCK_URL}`,
  NO_PROXY: "localhost,127.0.0.1,::1,mock",
  // Read once at process start by Node (main process and task runners): every TLS client in
  // n8n then accepts the mock's per-host leaves. Mounted from TLS_DIR/ca.pem.
  NODE_EXTRA_CA_CERTS: "/bench-ca/ca.pem",
  // 2.x confines Read/Write Files from Disk to ~/.n8n-files by default; fixtures with a
  // `file` source are copied into /home/node.
  N8N_RESTRICT_FILE_ACCESS_TO: "/home/node",
};

// ---------- docker ----------

export function docker(args, { input, allowFail = false, inherit = false } = {}) {
  const r = spawnSync("docker", args, { input, encoding: "utf8", stdio: inherit ? "inherit" : "pipe", maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) {
    throw new Error(`docker ${args.slice(0, 3).join(" ")} failed (${r.status}): ${(r.stderr || "").trim().slice(0, 2000)}`);
  }
  return r;
}

const exists = (kind, name) => docker([kind, "inspect", name], { allowFail: true }).status === 0;
const running = (name) => docker(["inspect", "-f", "{{.State.Running}}", name], { allowFail: true }).stdout?.trim() === "true";

// System-wide free memory in percent (macOS `memory_pressure`), or null elsewhere.
export function memoryFree() {
  const r = spawnSync("sh", ["-c", "memory_pressure | tail -1"], { encoding: "utf8" });
  const m = /(\d+)%/.exec(r.stdout || "");
  return m ? Number(m[1]) : null;
}

// Waits (polling each minute, up to 15 minutes) until free memory is at least min%.
export async function waitForMemory(min = 30, { log = console.error } = {}) {
  for (let i = 0; i <= 15; i++) {
    const free = memoryFree();
    if (free === null || free >= min) return free;
    log(`memory free ${free}% < ${min}%, waiting a minute (${i + 1}/15)`);
    await new Promise((r) => setTimeout(r, 60_000));
  }
  throw new Error(`memory stayed under ${min}% free for 15 minutes; not starting anything`);
}

// ---------- lifecycle ----------

// extraEnv: more -e pairs for the n8n container (e.g. HTTP_PROXY for a probe).
export async function up({ fresh = false, extraEnv = {}, log = console.error } = {}) {
  if (running(NAME) && running(MOCK_NAME) && !fresh) {
    await waitHealthy();
    return;
  }
  await waitForMemory(30, { log });
  const { ensureCa } = await import("../bench/tls.mjs");
  ensureCa(TLS_DIR);
  if (fresh) {
    docker(["rm", "-f", NAME, MOCK_NAME], { allowFail: true });
    docker(["volume", "rm", VOLUME], { allowFail: true });
  }
  mkdirSync(WORK, { recursive: true });
  for (const f of ["effects.jsonl", "fixtures.json"]) if (!existsSync(join(WORK, f))) writeFileSync(join(WORK, f), f.endsWith(".json") ? "{}\n" : "");
  if (!exists("network", NET)) docker(["network", "create", "--internal", NET]);
  if (!exists("network", EDGE)) docker(["network", "create", EDGE]);
  if (!exists("volume", VOLUME)) docker(["volume", "create", VOLUME]);

  if (!running(MOCK_NAME)) {
    docker(["rm", "-f", MOCK_NAME], { allowFail: true });
    docker([
      "run", "-d", "--name", MOCK_NAME,
      "--memory=128m", "--memory-swap=128m",
      "--network", EDGE, "-p", `127.0.0.1:${HOST_PORT}:${HOST_PORT}`,
      "-v", `${HERE}:/bench:ro`, "-v", `${WORK}:/work`, "-v", `${TLS_DIR}:/tls:ro`,
      SIDECAR_IMAGE,
      "node", "/bench/mock-server.mjs", "--port", "8080", "--log", "/work/effects.jsonl", "--fixtures", "/work/fixtures.json",
      "--relay", `${HOST_PORT}=${NAME}:5678`, "--tls-dir", "/tls", "--model-shim", `http://host.docker.internal:${MODEL_SHIM_PORT}`,
    ]);
    docker(["network", "connect", "--alias", "mock", NET, MOCK_NAME]);
  }
  if (!running(NAME)) {
    docker(["rm", "-f", NAME], { allowFail: true });
    const env = Object.entries({ ...ENV, ...extraEnv }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    docker([
      "run", "-d", "--name", NAME,
      "--memory=1g", "--memory-swap=1g",
      "--network", NET,
      "-v", `${VOLUME}:/home/node/.n8n`, "-v", `${join(TLS_DIR, "ca.pem")}:/bench-ca/ca.pem:ro`,
      ...env,
      IMAGE,
    ]);
  }
  await waitHealthy();
  log(`n8n up at ${BASE} (${IMAGE}); mock at ${MOCK_URL} inside, work dir ${WORK}`);
}

export async function waitHealthy(timeoutMs = 180_000) {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/healthz/readiness`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return Date.now() - t0;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = e.cause?.code || e.message;
    }
    if (!running(NAME)) throw new Error(`n8n container stopped:\n${docker(["logs", "--tail", "40", NAME], { allowFail: true }).stderr}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`n8n not healthy after ${timeoutMs / 1000}s (${last})`);
}

export function down({ purge = false } = {}) {
  docker(["rm", "-f", NAME, MOCK_NAME], { allowFail: true });
  for (const n of [NET, EDGE]) docker(["network", "rm", n], { allowFail: true });
  if (purge) docker(["volume", "rm", VOLUME], { allowFail: true });
}

// Container memory as Docker reports it, e.g. {used: "371.9MiB", limit: "1GiB", mib: 371.9}.
export function memStats(name = NAME) {
  const r = docker(["stats", "--no-stream", "--format", "{{.MemUsage}}|{{.CPUPerc}}", name], { allowFail: true });
  const [usage = "", cpu = ""] = (r.stdout || "").trim().split("|");
  const [used = "", limit = ""] = usage.split(" / ");
  const m = /([\d.]+)\s*(KiB|MiB|GiB)/.exec(used);
  const mib = m ? Number(m[1]) * { KiB: 1 / 1024, MiB: 1, GiB: 1024 }[m[2]] : null;
  return { used, limit, mib, cpu };
}

export function status() {
  const out = {};
  for (const n of [NAME, MOCK_NAME]) {
    const r = docker(["inspect", "-f", "{{.State.Status}}|{{.Config.Image}}|{{.HostConfig.Memory}}", n], { allowFail: true });
    if (r.status !== 0) {
      out[n] = { state: "absent" };
      continue;
    }
    const [state, image, mem] = r.stdout.trim().split("|");
    out[n] = { state, image, memoryLimitBytes: Number(mem), ...(state === "running" ? memStats(n) : {}) };
  }
  out.volume = exists("volume", VOLUME);
  out.networks = { [NET]: exists("network", NET), [EDGE]: exists("network", EDGE) };
  return out;
}

// ---------- inside the container ----------

// Runs a command in the n8n container. `n8n` subcommands get their own task
// broker port: the running server already holds 5679.
export function exec(cmd, { input, allowFail = true, inherit = false } = {}) {
  const env = cmd[0] === "n8n" ? ["-e", `N8N_RUNNERS_BROKER_PORT=${CLI_BROKER_PORT}`] : [];
  return docker(["exec", ...(input !== undefined ? ["-i"] : []), ...env, NAME, ...cmd], { input, allowFail, inherit });
}

export function copyIn(local, inside) {
  docker(["cp", local, `${NAME}:${inside}`]);
}

export function copyOut(inside, local) {
  docker(["cp", `${NAME}:${inside}`, local]);
}

// `n8n <args>` in the container; returns {status, stdout, stderr, ms}.
export function n8nCli(args, opts) {
  const t0 = Date.now();
  const r = exec(["n8n", ...args], opts);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t0 };
}

// ---------- REST (internal API, as the owner) ----------

let cookie = null;
const BROWSER_ID = "n8n2claude-bench";

export async function login() {
  const r = await fetch(`${BASE}/rest/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "browser-id": BROWSER_ID },
    body: JSON.stringify({ emailOrLdapLoginId: OWNER_EMAIL, password: OWNER_PASSWORD }),
  });
  if (!r.ok) throw new Error(`login failed: HTTP ${r.status} ${await r.text()}`);
  cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("login returned no cookie");
  return cookie;
}

// Calls the internal REST API; returns the parsed body's `data` when present.
export async function rest(method, path, body) {
  if (!cookie) await login();
  const call = () =>
    fetch(`${BASE}/rest${path}`, {
      method,
      headers: { cookie, "browser-id": BROWSER_ID, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  let r = await call();
  if (r.status === 401) {
    await login();
    r = await call();
  }
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!r.ok) {
    const err = new Error(`${method} /rest${path}: HTTP ${r.status} ${typeof json === "string" ? json : JSON.stringify(json)}`.slice(0, 2000));
    err.status = r.status;
    err.body = json;
    throw err;
  }
  return json && typeof json === "object" && "data" in json ? json.data : json;
}

// ---------- CLI ----------

async function main() {
  const [cmd, ...rest_] = process.argv.slice(2);
  try {
    if (cmd === "up") {
      const extraEnv = Object.fromEntries(rest_.flatMap((a, i) => (a === "--env" && rest_[i + 1]?.includes("=") ? [rest_[i + 1].split(/=(.*)/s).slice(0, 2)] : [])));
      await up({ fresh: rest_.includes("--fresh"), extraEnv });
    }
    else if (cmd === "down") down({ purge: rest_.includes("--purge") });
    else if (cmd === "status") console.log(JSON.stringify(status(), null, 2));
    else if (cmd === "exec") {
      const args = rest_[0] === "--" ? rest_.slice(1) : rest_;
      if (!args.length) throw new Error("exec needs a command");
      const r = exec(args, { inherit: true });
      process.exit(r.status ?? 1);
    } else {
      console.error("usage: container.mjs up [--fresh] [--env K=V]... | down [--purge] | status | exec -- <cmd...>");
      process.exit(2);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
