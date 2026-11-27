#!/usr/bin/env node
// Phase 0 probe (PLAN.md): what a session that runs this can do, printed as one JSON line.
// Run it from a Cowork scheduled task twice (references/probe-task.md): the second run shows
// whether anything written by the first survived. No secret is read or printed; environment
// variables are listed by name only, and only names that say where the session runs.
//
//   probe.mjs [--no-network]
//
// Checks: Node version and platform; where this skill's files are; the working directory and
// HOME; which candidate folders can be written; a marker from an earlier run in each (kept
// between runs or not); outbound HTTPS to a few hosts (status only); git on the PATH.

import { existsSync, mkdirSync, readFileSync, writeFileSync, accessSync, constants } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir, hostname } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SKILL = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MARK = ".n8m-probe.json";

function writable(dir) {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// Folders a later run might see again: the working directory, HOME, the skill's own folder,
// the temp folder, and the output folders chat and Cowork sandboxes have been seen to use.
function candidates() {
  const c = [process.cwd(), homedir(), SKILL, tmpdir(), "/mnt/user-data/outputs", "/mnt/user-data", "/mnt/outputs", "/workspace", "/home/user"];
  return [...new Set(c.filter((d) => d && existsSync(d)))];
}

function marks(now) {
  return candidates().map((dir) => {
    const p = join(dir, MARK);
    let earlier = null;
    try {
      earlier = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
    } catch {
      earlier = "unreadable";
    }
    let wrote = false;
    if (writable(dir)) {
      try {
        writeFileSync(p, JSON.stringify({ at: now, host: hostname() }) + "\n");
        wrote = true;
      } catch {}
    }
    return { dir, writable: wrote, earlierRun: earlier && typeof earlier === "object" ? earlier.at : earlier };
  });
}

async function reach(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(url, { method: "HEAD", signal: ac.signal, redirect: "manual" });
    return r.status;
  } catch (e) {
    return `error: ${e.cause?.code ?? e.name}`;
  } finally {
    clearTimeout(t);
  }
}

function has(cmd, args = ["--version"]) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 })
      .trim()
      .split("\n")[0];
  } catch {
    return null;
  }
}

export async function probe({ network = true, now = new Date().toISOString() } = {}) {
  const envNames = Object.keys(process.env)
    .filter((k) => /^(CLAUDE|ANTHROPIC|COWORK|CODESPACES|CI|HTTPS?_PROXY|NODE_USE_ENV_PROXY)/i.test(k) && !/KEY|TOKEN|SECRET|PASSWORD/i.test(k))
    .sort();
  return {
    probe: 1,
    at: now,
    node: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    skillDir: SKILL,
    runtimeShipped: existsSync(join(SKILL, "runtime", "dist", "runner-core.mjs")),
    cwd: process.cwd(),
    home: homedir(),
    folders: marks(now),
    git: has("git"),
    env: envNames,
    https: network ? { "api.github.com": await reach("https://api.github.com"), "example.com": await reach("https://example.com"), "n8n.io": await reach("https://n8n.io") } : "skipped",
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = await probe({ network: !process.argv.includes("--no-network") });
  process.stdout.write(JSON.stringify(out) + "\n");
}
