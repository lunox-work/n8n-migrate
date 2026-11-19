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
//   n8nmigrate-bench  n8nio/n8n:2.47.7, 1 GB RAM and swap, network n8nmigrate-net
//                     (--internal: no route out), volume n8nmigrate-bench-data.
//   n8nmigrate-postgres, n8nmigrate-mongo  database sidecars (databases.mjs, PROPOSALS P66) on
//                     n8nmigrate-net as hosts `postgres` and `mongo`, only while a template whose
//                     fixture seeds that engine runs (ensureDatabases).
//   n8nmigrate-mock   node:22-alpine running mock-server.mjs (HTTP on 8080, an SMTP sink on 2525). On n8nmigrate-net as
//                     host `mock` (port 8080) and on n8nmigrate-edge, which publishes
//                     127.0.0.1:5690 and relays it to n8n:5678. n8n can reach the mock
//                     and nothing else. The mock reads <work>/fixtures.json and appends
//                     <work>/effects.jsonl; <work> is not mounted into n8n.
//
// Credentials in here are the bench's own dummies: the encryption key and the
// owner password protect nothing and are not the author's.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, existsSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SIDECARS as DB_SIDECARS, ensureDatabases as ensureDbSidecars, removeDatabases } from "./databases.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export const IMAGE = "n8nio/n8n:2.47.7";
export const SIDECAR_IMAGE = "node:22-alpine";
// PROPOSALS P94: the image the bench runs: n8nio/n8n with the pinned community packages of
// community-packages.json built in (`n8nmigrate-n8n:<version>-<hash>`), or n8nio/n8n itself when
// the list is empty. The packages sit at /home/node/.n8n/nodes/node_modules, where n8n 2.x scans
// for community nodes; that path is a second volume, named by the same hash, so Docker fills it
// from the image on first use while the database volume above it stays as it is.
export function communityPackages() {
  return JSON.parse(readFileSync(join(HERE, "community-packages.json"), "utf8")).packages ?? [];
}
export function benchImage(pkgs = communityPackages()) {
  if (!pkgs.length) return IMAGE;
  const h = createHash("sha256").update(JSON.stringify({ IMAGE, pkgs: pkgs.map(({ name, version, integrity }) => ({ name, version, integrity })) })).digest("hex").slice(0, 12);
  return `n8nmigrate-n8n:${IMAGE.split(":")[1]}-${h}`;
}
const nodesVolume = (image) => (image === IMAGE ? null : `n8nmigrate-bench-nodes-${image.split("-").at(-1)}`);
// A file-name-safe name of the n8n image in use (caches keyed by image: node descriptions).
export const imageTag = () => benchImage().replace(/[^\w.-]+/g, "_");

// Builds benchImage() when it is missing: each tarball is fetched from the registry on the host,
// checked against its pinned sha512 integrity, unpacked, and copied into a layer over n8nio/n8n.
export async function ensureBenchImage({ log = console.error } = {}) {
  const image = benchImage();
  if (image === IMAGE || exists("image", image)) return image;
  const dir = join(WORK, "image-build", image.split(":")[1]);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "nodes"), { recursive: true });
  for (const p of communityPackages()) {
    const url = `https://registry.npmjs.org/${p.name}/-/${p.name.split("/").at(-1)}-${p.version}.tgz`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`community package ${p.name}@${p.version}: HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const got = `sha512-${createHash("sha512").update(buf).digest("base64")}`;
    if (got !== p.integrity) throw new Error(`community package ${p.name}@${p.version}: integrity ${got} is not the pinned ${p.integrity}`);
    const tgz = join(dir, `${p.name.replace(/[^\w.-]+/g, "_")}.tgz`);
    writeFileSync(tgz, buf);
    const to = join(dir, "nodes", "node_modules", ...p.name.split("/"));
    mkdirSync(to, { recursive: true });
    const t = spawnSync("tar", ["-xzf", tgz, "-C", to, "--strip-components=1"], { encoding: "utf8" });
    if (t.status !== 0) throw new Error(`unpacking ${p.name}: ${t.stderr}`);
    rmSync(tgz);
  }
  writeFileSync(join(dir, "Dockerfile"), `FROM ${IMAGE}\nCOPY --chown=node:node nodes/ /home/node/.n8n/nodes/\n`);
  log(`building ${image} (${communityPackages().map((p) => `${p.name}@${p.version}`).join(", ")})`);
  docker(["build", "-q", "-t", image, "--label", "n8nmigrate.community=1", dir]);
  rmSync(dir, { recursive: true, force: true });
  return image;
}
export const NAME = "n8nmigrate-bench";
export const MOCK_NAME = "n8nmigrate-mock";
export const RUNNERS_NAME = "n8nmigrate-runners"; // PROPOSALS P92, only while a template needs it
export const RUNNERS_IMAGE = "n8nio/runners:2.47.7";
export const NET = "n8nmigrate-net"; // internal
export const EDGE = "n8nmigrate-edge"; // publishes the host port
export const VOLUME = "n8nmigrate-bench-data";
export const HOST_PORT = 5690;
export const BASE = `http://127.0.0.1:${HOST_PORT}`;
export const MOCK_URL = "http://mock:8080"; // as n8n sees it
export const SMTP_PORT = 2525; // the mock's SMTP sink (PROPOSALS P53), on the internal network only
export const WORK = resolve(process.env.N8N_BENCH_WORK || join(HERE, ".work"));
export const OWNER_EMAIL = "bench@example.com";
export const OWNER_PASSWORD = "Bench-only-pass-1";
const OWNER_HASH = "$2a$10$0d25sQavlnXIlqc9ULyWquYP6.jOU47UnxfMHrI86M8oZ9jVcRCsa"; // bcrypt of OWNER_PASSWORD
// TLS interception (evals/bench/tls.mjs): the mock gets the leaves, n8n trusts only the CA.
export const TLS_DIR = resolve(process.env.N8M_BENCH_TLS || join(HERE, "..", "bench", ".tls"));
// The bench's model shim runs on the host (evals/bench/model-shim.mjs); the mock forwards to
// it over the edge network. n8n itself still reaches nothing but the mock.
export const MODEL_SHIM_PORT = Number(process.env.N8M_MODEL_SHIM_PORT || 5691);
export const ENCRYPTION_KEY = "n8nmigrate-bench-key-not-a-secret";
const CLI_BROKER_PORT = "5681"; // `n8n execute` and friends start a second task broker

export const ENV = {
  N8N_ENCRYPTION_KEY: ENCRYPTION_KEY,
  // n8n's default timezone (PROPOSALS P4): the runtime takes it too for a template without
  // settings.timezone, so both sides render $now, $today and schedules in the same zone.
  // GENERIC_TIMEZONE drives n8n (Luxon's default zone, the Schedule Trigger); TZ the
  // process's own Date (Code nodes' new Date().toString(), task runners).
  GENERIC_TIMEZONE: "America/New_York",
  TZ: "America/New_York",
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
  // Node's own fetch (undici) ignores the proxy variables unless told; SDK clients built on it
  // (Pinecone's data plane, Qdrant, supabase-js, Google GenAI) then never reached the mock.
  NODE_USE_ENV_PROXY: "1",
  // Read once at process start by Node (main process and task runners): every TLS client in
  // n8n then accepts the mock's per-host leaves. Mounted from TLS_DIR/ca.pem.
  NODE_EXTRA_CA_CERTS: "/bench-ca/ca.pem",
  // 2.x confines Read/Write Files from Disk to ~/.n8n-files by default. Fixtures' `file`
  // sources land in /home/node (relative paths) or at their absolute path; the bench widens
  // this to every such directory (evals/bench/n8n-side.mjs benchEnv, PROPOSALS P21).
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
// The n8n container carries a label with the hash of its whole configuration (image, ENV with
// extraEnv over it, the runners sidecar); a running container with another hash is recreated
// (same volume), so the bench's env overlays, a template's own env (evals/bench/n8n-side.mjs
// templateEnv: a value dropped is dropped too) and a changed ENV always reach n8n.
export function configHash({ extraEnv = {}, image = benchImage(), runners = false } = {}) {
  const env = { ...ENV, ...extraEnv };
  const sorted = Object.keys(env).sort().map((k) => `${k}=${env[k]}`);
  return createHash("sha256").update(JSON.stringify({ image, env: sorted, runners: runners || false })).digest("hex").slice(0, 16);
}
export const configLabel = () => label(NAME, "n8nmigrate.config");
const label = (name, key) => docker(["inspect", "-f", `{{index .Config.Labels "${key}"}}`, name], { allowFail: true }).stdout?.trim() ?? "";

export async function up({ fresh = false, extraEnv = {}, runners = false, image = null, log = console.error } = {}) {
  image ??= await ensureBenchImage({ log });
  const want = configHash({ extraEnv, image, runners });
  if (running(NAME) && !fresh && label(NAME, "n8nmigrate.config") !== want) {
    log(`n8n container runs another configuration (env, image or runners): recreating it`);
    docker(["rm", "-f", NAME], { allowFail: true });
  }
  // PROPOSALS P92: the Python task runner sidecar exists only while a template needs it.
  if (!runners && exists("container", RUNNERS_NAME)) docker(["rm", "-f", RUNNERS_NAME], { allowFail: true });
  if (runners && running(NAME) && !running(RUNNERS_NAME)) docker(["rm", "-f", NAME], { allowFail: true });
  // The mock runs the checkout's mock-server.mjs as it was when the sidecar started: a sidecar
  // started from other code (label n8nmigrate.code) is recreated, so a mock change reaches it.
  if (running(MOCK_NAME) && docker(["inspect", "-f", '{{index .Config.Labels "n8nmigrate.code"}}', MOCK_NAME], { allowFail: true }).stdout?.trim() !== mockCodeHash()) {
    log("mock sidecar runs other mock code: recreating it");
    docker(["rm", "-f", MOCK_NAME], { allowFail: true });
  }
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
      "run", "-d", "--name", MOCK_NAME, "--label", `n8nmigrate.code=${mockCodeHash()}`,
      "--memory=128m", "--memory-swap=128m",
      "--network", EDGE, "-p", `127.0.0.1:${HOST_PORT}:${HOST_PORT}`,
      "-v", `${HERE}:/bench:ro`, "-v", `${WORK}:/work`, "-v", `${TLS_DIR}:/tls:ro`,
      SIDECAR_IMAGE,
      "node", "/bench/mock-server.mjs", "--port", "8080", "--log", "/work/effects.jsonl", "--fixtures", "/work/fixtures.json",
      "--relay", `${HOST_PORT}=${NAME}:5678`, "--tls-dir", "/tls", "--model-shim", `http://host.docker.internal:${MODEL_SHIM_PORT}`,
      // PROPOSALS P53: the SMTP sink, reached by n8n as mock:2525 (the bench's smtp credential).
      "--smtp-port", String(SMTP_PORT),
    ]);
    docker(["network", "connect", "--alias", "mock", NET, MOCK_NAME]);
  }
  const created = !running(NAME);
  if (created) {
    docker(["rm", "-f", NAME], { allowFail: true });
    const env = Object.entries({ ...ENV, ...extraEnv, ...(runners ? RUNNERS_ENV : {}) }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    docker([
      "run", "-d", "--name", NAME, "--label", `n8nmigrate.config=${want}`,
      "--memory=1g", "--memory-swap=1g",
      "--network", NET,
      "-v", `${VOLUME}:/home/node/.n8n`, ...(nodesVolume(image) ? ["-v", `${nodesVolume(image)}:/home/node/.n8n/nodes`] : []), "-v", `${join(TLS_DIR, "ca.pem")}:/bench-ca/ca.pem:ro`,
      ...env,
      image,
    ]);
  }
  if (runners && (created || !running(RUNNERS_NAME))) startRunners(extraEnv, runners === true ? {} : runners);
  await waitHealthy();
  log(`n8n up at ${BASE} (${image}${runners ? `, Python runners ${RUNNERS_IMAGE}` : ""}); mock at ${MOCK_URL} inside, work dir ${WORK}`);
}

// The code the mock sidecar runs (every module mock-server.mjs loads from this folder).
export function mockCodeHash() {
  const h = createHash("sha256");
  for (const f of ["mock-server.mjs", "mint-leaf.mjs"]) h.update(readFileSync(join(HERE, f)));
  return h.digest("hex").slice(0, 16);
}

// PROPOSALS P92: n8n 2.x runs Python Code nodes only in an external task runner. For a template
// with one, n8n runs its broker in external mode and n8n's own runners image (pinned to the same
// version) connects to it from a sidecar on the internal network: no route out, the bench CA
// trusted, 512 MiB cap, started only for such a template and removed for the next one. The JS
// runner moves there too for that run (the launcher starts both). The image's launcher config
// allows no Python import at all (N8N_RUNNERS_STDLIB_ALLOW and _EXTERNAL_ALLOW are "" in its
// env-overrides), so the bench mounts the same config with the modules the template imports
// allowed, as a person would configure their runners (`runners: {stdlib, external}`), never `*`;
// the JS runner's allow lists are emptied to match internal mode's defaults. No package is
// installed: the image has only the standard library.
const RUNNERS_TOKEN = "n8nmigrate-bench-runners-not-a-secret";
const RUNNERS_ENV = {
  N8N_RUNNERS_MODE: "external",
  N8N_RUNNERS_AUTH_TOKEN: RUNNERS_TOKEN,
  N8N_RUNNERS_BROKER_LISTEN_ADDRESS: "0.0.0.0",
  N8N_PYTHON_ENABLED: "true",
};
export function runnersConfig(imageConfig, { stdlib = [], external = [] } = {}) {
  const cfg = structuredClone(imageConfig);
  for (const r of cfg["task-runners"] ?? []) {
    if (r["runner-type"] === "python") r["env-overrides"] = { ...r["env-overrides"], N8N_RUNNERS_STDLIB_ALLOW: stdlib.join(","), N8N_RUNNERS_EXTERNAL_ALLOW: external.join(",") };
    if (r["runner-type"] === "javascript") r["env-overrides"] = { ...r["env-overrides"], NODE_FUNCTION_ALLOW_BUILTIN: "", NODE_FUNCTION_ALLOW_EXTERNAL: "" };
  }
  return cfg;
}
function startRunners(extraEnv = {}, runners = {}) {
  docker(["rm", "-f", RUNNERS_NAME], { allowFail: true });
  const base = JSON.parse(docker(["run", "--rm", "--entrypoint", "cat", RUNNERS_IMAGE, "/etc/n8n-task-runners.json"]).stdout);
  const cfgFile = join(WORK, "runners-config.json");
  writeFileSync(cfgFile, JSON.stringify(runnersConfig(base, runners), null, 2));
  const pass = ["GENERIC_TIMEZONE", "TZ"];
  const env = { ...Object.fromEntries(pass.map((k) => [k, { ...ENV, ...extraEnv }[k]]).filter(([, v]) => v !== undefined)), N8N_RUNNERS_TASK_BROKER_URI: `http://${NAME}:5679`, N8N_RUNNERS_AUTH_TOKEN: RUNNERS_TOKEN, N8N_RUNNERS_MAX_CONCURRENCY: "2" };
  docker([
    "run", "-d", "--name", RUNNERS_NAME,
    "--memory=512m", "--memory-swap=512m",
    "--network", NET,
    "-v", `${cfgFile}:/etc/n8n-task-runners.json:ro`,
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    RUNNERS_IMAGE,
  ]);
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

// Restarts the n8n container only (the mock keeps running), so its process memory starts empty
// (PROPOSALS P55, P63); the volume, owner and session secret stay, and rest() signs in again if
// the cookie is refused. Returns the milliseconds until n8n was healthy again.
export async function restart({ log = console.error } = {}) {
  const t0 = Date.now();
  docker(["restart", NAME]);
  await waitHealthy();
  const ms = Date.now() - t0;
  log(`n8n container restarted (${Math.round(ms / 1000)} s): empty process memory for the next run`);
  return ms;
}

// PROPOSALS P83: the n8n container's state after a run. A container the kernel killed at its
// memory cap is stopped with State.OOMKilled true (exit 137) until it is started again.
export function state(name = NAME) {
  const r = docker(["inspect", "-f", "{{.State.Running}}|{{.State.OOMKilled}}|{{.State.ExitCode}}", name], { allowFail: true });
  if (r.status !== 0) return { exists: false, running: false, oomKilled: false, exitCode: null };
  const [run, oom, code] = r.stdout.trim().split("|");
  return { exists: true, running: run === "true", oomKilled: oom === "true", exitCode: Number(code) };
}

// PROPOSALS P66: starts the database sidecars `engines` names (postgres, mongodb) on the bench
// network and removes the others; the network exists once up() ran.
export async function ensureDatabases(engines = [], { log = console.error } = {}) {
  if (engines.length && !exists("network", NET)) docker(["network", "create", "--internal", NET]);
  return ensureDbSidecars(engines, { log });
}

export function down({ purge = false } = {}) {
  docker(["rm", "-f", NAME, MOCK_NAME, RUNNERS_NAME], { allowFail: true });
  removeDatabases();
  for (const n of [NET, EDGE]) docker(["network", "rm", n], { allowFail: true });
  if (purge) {
    docker(["volume", "rm", VOLUME], { allowFail: true });
    const vols = docker(["volume", "ls", "-q", "--filter", "name=n8nmigrate-bench-nodes-"], { allowFail: true }).stdout?.trim().split("\n").filter(Boolean) ?? [];
    for (const v of vols) docker(["volume", "rm", v], { allowFail: true });
  }
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
  for (const n of [NAME, MOCK_NAME, RUNNERS_NAME, ...Object.values(DB_SIDECARS).map((s) => s.name)]) {
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

// The parent directory is made first (as root, owned by node), since `docker cp` needs it.
// `docker cp` creates the file as root. PROPOSALS P49: a fixture file the workflow also
// writes (2894's Write Binary File writes the downloaded video to the relative path the
// fixture's `file` read places it at, then reads it back) must be writable by n8n's user, so
// the copied file is handed to node:node like its directory.
export function copyInCommands(local, inside) {
  const dir = inside.replace(/\/[^/]*$/, "") || "/";
  return [
    ["exec", "-u", "root", NAME, "sh", "-c", `mkdir -p "$1" && chown node:node "$1"`, "sh", dir],
    ["cp", local, `${NAME}:${inside}`],
    ["exec", "-u", "root", NAME, "chown", "node:node", inside],
  ];
}

export function copyIn(local, inside) {
  for (const args of copyInCommands(local, inside)) docker(args);
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
const BROWSER_ID = "n8nmigrate-bench";

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

// n8n's node descriptions as the editor loads them (GET /types/nodes.json, signed in): the bench
// reads each node type's declared credentials from them (PROPOSALS P61).
export async function nodeTypes() {
  if (!cookie) await login();
  const call = () => fetch(`${BASE}/types/nodes.json`, { headers: { cookie, "browser-id": BROWSER_ID } });
  let r = await call();
  if (r.status === 401) {
    await login();
    r = await call();
  }
  if (!r.ok) throw new Error(`GET /types/nodes.json: HTTP ${r.status}`);
  return r.json();
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
