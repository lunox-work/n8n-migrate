#!/usr/bin/env node
// One command from nothing to a report: `npx n8n-to-claude [where]`. Gets the workflows (pull.mjs),
// writes the fit report as HTML and JSON (analyze.mjs, report-html.mjs), opens it, and says what
// to do next. Zero dependencies; nothing is converted, scheduled or switched off here.
//
//   n8n-to-claude                          picks the easiest way in, asking only when it must:
//                                          N8N_BASE_URL + N8N_API_KEY set: every workflow over
//                                          the API; else a menu (sign in, template, file, try it)
//   n8n-to-claude <your n8n address>       sign in in the browser (OAuth) and check every
//                                          workflow shared over MCP
//   n8n-to-claude <n8n.io template link | template:<id> | popular[:N] | trending[:N] | editor link | file | folder>
//   --out <dir>        where exports/, report.html and report.json go (default ./n8n-to-claude)
//   --api              every workflow over the API (N8N_BASE_URL + N8N_API_KEY, or --env-file)
//   --env-file <file>  read N8N_BASE_URL / N8N_API_KEY from a file
//   --no-open          do not open the report in the browser
//   --yes              take the recommended answer to every question (no prompts)
// Exit: 0 report written, 1 nothing to report, 2 bad usage.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseSource, pull, readEnvFile } from "./pull.mjs";
import { analyze, loadInput, renderText } from "./analyze.mjs";
import { renderHtml } from "./report-html.mjs";
import { openBrowser } from "./n8n-oauth.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REFS = join(HERE, "..", "references");
const REPO = "lunox-work/n8n-to-claude";

// What one command-line word asks for: {via: "path"|"pull"|"login"|"api", ...}.
export function routeOf(arg, { exists = existsSync } = {}) {
  const s = String(arg).trim();
  if (exists(s)) return { via: "path", path: resolve(s) };
  const src = parseSource(s);
  if (src.kind === "template" || src.kind === "trending") return { via: "pull", source: s };
  if (src.kind === "instance") return { via: "api" };
  if (src.kind === "editor") return { via: "login", address: src.base, source: s };
  // A bare address (you.app.n8n.cloud, https://n8n.example.com, …/home/workflows): sign in.
  if (/^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/.*)?$/i.test(s) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(s)) return { via: "login", address: s };
  return { via: "bad", error: `not a file, folder, link or n8n address: ${s}` };
}

function parseArgs(argv) {
  const a = { words: [], out: resolve("n8n-to-claude"), api: false, envFile: null, open: true, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${x} needs a value`);
      return argv[++i];
    };
    if (x === "--out") a.out = resolve(val());
    else if (x === "--api") a.api = true;
    else if (x === "--env-file") a.envFile = resolve(val());
    else if (x === "--no-open") a.open = false;
    else if (x === "--yes" || x === "-y") a.yes = true;
    else if (x === "-h" || x === "--help") a.help = true;
    else if (x.startsWith("--")) throw new Error(`unknown option ${x}`);
    else a.words.push(x);
  }
  return a;
}

const HELP = `n8n-to-claude: which of your n8n workflows can run on your Claude subscription.

  npx n8n-to-claude                      asks where your workflows are
  npx n8n-to-claude you.app.n8n.cloud    sign in to your n8n in the browser
  npx n8n-to-claude https://n8n.io/workflows/<id>   a template
  npx n8n-to-claude workflows.json       an export file or folder
  npx n8n-to-claude popular              try it on the most-viewed n8n.io templates (or: trending)

  --api  every workflow through N8N_BASE_URL + N8N_API_KEY   --out <dir>   --no-open   --yes`;

async function ask(rl, question, fallback) {
  if (!rl) return fallback;
  const a = (await rl.question(question)).trim();
  return a || fallback;
}

// The menu when nothing says where the workflows are. Recommended first.
async function chooseRoute(rl) {
  console.log(`Where are your n8n workflows?
  1  Sign in to my n8n in the browser (recommended: no key to create)
  2  Use an n8n API key (sees every workflow, also ones not shared over MCP)
  3  An n8n.io template link, or an export file or folder
  4  Just try it on the 10 most-viewed n8n.io templates`);
  const pick = await ask(rl, "Choose 1-4 [1]: ", "1");
  if (pick === "2") return { via: "api" };
  if (pick === "3") {
    const w = await ask(rl, "Link, file or folder: ", "");
    return w ? routeOf(w) : { via: "bad", error: "nothing given" };
  }
  if (pick === "4") return { via: "pull", source: "popular:10" };
  const address = await ask(rl, "Your n8n address (for example you.app.n8n.cloud): ", "");
  return address ? { via: "login", address } : { via: "bad", error: "no address given" };
}

function skillInstalled() {
  const home = process.env.HOME ?? "";
  return [join(home, ".claude", "skills", "n8n-to-claude"), join(home, ".agents", "skills", "n8n-to-claude")].some((p) => existsSync(join(p, "SKILL.md")));
}

export async function main(argv = process.argv.slice(2), { stdin = process.stdin, stdout = process.stdout } = {}) {
  let a;
  try {
    a = parseArgs(argv);
  } catch (e) {
    console.error(`${e.message}\n\n${HELP}`);
    return 2;
  }
  if (a.help) {
    console.log(HELP);
    return 0;
  }
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 20) {
    console.error(`n8n-to-claude needs Node 20 or later; this is ${process.versions.node}.`);
    return 2;
  }
  let env = process.env;
  if (a.envFile) {
    try {
      env = { ...process.env, ...readEnvFile(readFileSync(a.envFile, "utf8")) };
    } catch (e) {
      console.error(`cannot read --env-file ${a.envFile}: ${e.message}`);
      return 2;
    }
  }
  const hasKey = !!(String(env.N8N_BASE_URL ?? "").trim() && String(env.N8N_API_KEY ?? "").trim());
  const rl = stdin.isTTY && stdout.isTTY && !a.yes ? createInterface({ input: stdin, output: stdout }) : null;
  try {
    let routes;
    if (a.api) routes = [{ via: "api" }];
    else if (a.words.length) routes = a.words.map((w) => routeOf(w));
    else if (hasKey) routes = [{ via: "api" }];
    else if (rl) routes = [await chooseRoute(rl)];
    else {
      console.error(`Say where your n8n workflows are.\n\n${HELP}`);
      return 2;
    }
    const bad = routes.find((r) => r.via === "bad");
    if (bad) {
      console.error(`${bad.error}\n\n${HELP}`);
      return 2;
    }
    if (routes.some((r) => r.via === "api") && !hasKey) {
      console.error("An API key route needs N8N_BASE_URL and N8N_API_KEY. Create a key in n8n (Settings > n8n API), then in this terminal:\n  export N8N_BASE_URL=https://<your n8n>  N8N_API_KEY=<the key>\nand run this again (or put both in a file and pass --env-file <file>). Never paste the key into a chat.");
      return 2;
    }
    const logins = [...new Set(routes.filter((r) => r.via === "login").map((r) => r.address))];
    if (logins.length > 1) {
      console.error("Sign in to one n8n at a time.");
      return 2;
    }
    // Get everything into <out>/exports (files and folders are read where they are).
    const exportsDir = join(a.out, "exports");
    const inputs = routes.filter((r) => r.via === "path").map((r) => r.path);
    const sources = routes.filter((r) => r.via === "pull" || r.via === "api" || (r.via === "login" && r.source)).map((r) => (r.via === "api" ? "n8n" : r.source));
    const failed = [];
    if (sources.length || logins.length) {
      if (logins.length) console.log(`Opening ${logins[0]} in your browser: approve "n8n-to-claude" there (it only reads workflows).`);
      const r = await pull(sources, { out: exportsDir, env, login: logins[0] ?? null, log: (s) => console.log(s.split("\n").slice(1).join("\n")) });
      for (const w of r.written) console.log(`  got ${w.name}`);
      for (const e of r.errors) failed.push(e.error);
      for (const n of r.notes) console.log(`note: ${n}`);
      if (r.written.length) inputs.unshift(exportsDir);
    }
    for (const f of failed) console.error(`! ${f}`);
    if (!inputs.length) {
      console.error("Nothing to check: no workflow came through.");
      return 1;
    }
    // Analyse every input together (sub-workflow calls resolve across them).
    const items = [];
    const inputErrors = [];
    for (const p of inputs) {
      const l = loadInput(p);
      if (l.fatal) {
        console.error(`! ${l.fatal}`);
        continue;
      }
      items.push(...l.items);
      inputErrors.push(...l.errors);
    }
    if (!items.length) return 1;
    const refs = (n) => JSON.parse(readFileSync(join(REFS, n), "utf8"));
    const report = analyze(items, { nodes: refs("nodes.json"), capabilities: refs("capabilities.json"), hosts: refs("http-hosts.json"), answers: {}, now: Date.now(), inputErrors });
    const rel = (p) => relative(process.cwd(), p) || ".";
    const where = inputs.map(rel).join(" ");
    const installed = skillInstalled();
    const next = [
      ...(installed ? [] : [{ text: "Add the skill to Claude Code (once):", code: `npx skills add ${REPO} -g` }]),
      { text: "In Claude Code, ask it to answer the open questions and convert the workflows that move:", code: `claude "convert my n8n workflows in ${where}"` },
      { text: "Or by hand: node <skill>/scripts/convert.mjs " + where + " --out ../my-flows" },
    ];
    mkdirSync(a.out, { recursive: true });
    writeFileSync(join(a.out, "report.json"), JSON.stringify(report, null, 2) + "\n");
    const html = join(a.out, "report.html");
    writeFileSync(html, renderHtml(report, { next, generated: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC" }));
    console.log(`\n${renderText(report, stdout.isTTY)}`);
    console.log(`Report: ${rel(html)}${a.open ? " (opening it)" : ""}`);
    if (a.open) openBrowser(`file://${html}`);
    if (!installed) {
      const yes = rl ? /^(y|yes|)$/i.test(await ask(rl, "\nAdd the n8n-to-claude skill to Claude Code now, so it can convert these? [Y/n] ", "y")) : false;
      if (yes) {
        const r = spawnSync("npx", ["-y", "skills", "add", REPO, "-g"], { stdio: "inherit" });
        if (r.status !== 0) console.error(`The install did not finish; run it yourself: npx skills add ${REPO} -g`);
      } else console.log(`\nTo convert them: npx skills add ${REPO} -g, then in Claude Code: "convert my n8n workflows in ${where}"`);
    } else console.log(`\nNext, in Claude Code: "convert my n8n workflows in ${where}"`);
    return 0;
  } finally {
    rl?.close();
  }
}

// realpath on both sides: npx runs the bin through a link.
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) process.exit(await main());
