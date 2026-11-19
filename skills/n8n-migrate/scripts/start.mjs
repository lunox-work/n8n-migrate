#!/usr/bin/env node
// One command from nothing to a report: `npx n8n-migrate [where]`. Gets the workflows (pull.mjs),
// writes the fit report as HTML and JSON (analyze.mjs, report-html.mjs) and opens it. At a
// terminal it then offers, with one go-ahead for a plan listed in full, to go on (goOn below):
// convert the workflows that fit, make the folder a git repository, push it to a new private
// GitHub repository when a workflow runs as a cloud task, write the file the person types
// their keys into, and open Claude Code on the folder to create the scheduled tasks. Without a
// terminal, or with --no-setup, it stops at the report. Zero dependencies; nothing is
// scheduled or switched off here: Claude Code asks before it does either.
//
//   n8n-migrate                          picks the easiest way in, asking only when it must:
//                                          N8N_BASE_URL + N8N_API_KEY set: every workflow over
//                                          the API; else a menu (sign in, template, file, try it)
//   n8n-migrate <your n8n address>       sign in in the browser (OAuth) and check every
//                                          workflow shared over MCP
//   n8n-migrate <n8n.io template link | template:<id> | popular[:N] | trending[:N] | editor link | file | folder>
//   --out <dir>        where exports/, report.html and report.json go (default ./n8n-migrate)
//   --api              every workflow over the API (N8N_BASE_URL + N8N_API_KEY, or --env-file)
//   --env-file <file>  read N8N_BASE_URL / N8N_API_KEY from a file
//   --no-open          do not open the report in the browser
//   --yes              take the recommended answer to every question (no prompts); after the
//                      report it converts and commits locally, and prints the rest to run
//   --no-setup         stop at the report
//   --repo <name>      the private GitHub repository's name (default n8n-workflows)
//   --version          print the version
//   n8n-migrate convert <exports> --out <folder> [...]   convert.mjs
//   n8n-migrate serve <folder> [...]     the converted folders as a connector (serve.mjs)
// Exit: 0 report written, 1 nothing to report, 2 bad usage.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseSource, pull, readEnvFile } from "./pull.mjs";
import { analyze, loadInput, renderText, VERSION } from "./analyze.mjs";
import { renderHtml } from "./report-html.mjs";
import { openBrowser } from "./n8n-oauth.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REFS = join(HERE, "..", "references");
const REPO = "lunox-work/n8n-migrate";

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
  const a = { words: [], out: resolve("n8n-migrate"), api: false, envFile: null, open: true, yes: false, setup: true, repo: "n8n-workflows" };
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
    else if (x === "--no-setup") a.setup = false;
    else if (x === "--repo") a.repo = val();
    else if (x === "-h" || x === "--help") a.help = true;
    else if (x === "-v" || x === "--version") a.version = true;
    else if (x.startsWith("--")) throw new Error(`unknown option ${x}`);
    else a.words.push(x);
  }
  return a;
}

const HELP = `n8n-migrate: which of your n8n workflows can run on your Claude subscription.

  npx n8n-migrate                      asks where your workflows are
  npx n8n-migrate you.app.n8n.cloud    sign in to your n8n in the browser
  npx n8n-migrate https://n8n.io/workflows/<id>   a template
  npx n8n-migrate workflows.json       an export file or folder
  npx n8n-migrate popular              try it on the most-viewed n8n.io templates (or: trending)

  --api  every workflow through N8N_BASE_URL + N8N_API_KEY   --out <dir>   --no-open   --yes
  --no-setup  stop at the report   --repo <name>  the private GitHub repository to create
  --version

  After the report it offers to go on with one go-ahead: convert, a private GitHub repository
  for workflows that run in the cloud, and Claude Code opened there to create the tasks.

  npx n8n-migrate convert <exports> --out <folder>   convert the ones that fit (one folder per workflow)
  npx n8n-migrate serve <folder>                     run them for a claude.ai chat or Cowork (serve --help)`;

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
  return [join(home, ".claude", "skills", "n8n-migrate"), join(home, ".agents", "skills", "n8n-migrate")].some((p) => existsSync(join(p, "SKILL.md")));
}

// ---------- going on from the report ----------

const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return { status: r.error ? 127 : (r.status ?? 1), stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const secretEnvName = (name) => `N8M_SECRET_${String(name).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
const TARGET_WORDS = { "cloud-task": "a cloud task", "local-task": "a task on this computer", skill: "a skill", artifact: "a page", "artifact-form": "a form page" };

// What Claude Code is asked once the folder is ready. It lists its plan and asks before it
// creates a task, publishes a page or switches anything off in n8n (the skill's safety rules).
export function setupPrompt({ repoUrl = null, local = false } = {}) {
  return [
    "Use the n8n-migrate skill. The n8n workflows in this folder are already converted: one folder each, with MIGRATION.md saying what moved and what is flagged.",
    "The conversion took the assumed answer to every open question; each folder's report.json lists them. Ask me those first and regenerate the folder with my answers.",
    "Then set each one up as its scheduled task (the skill's step 6: references/setup-cloud-task.md or setup-local-task.md by its target), then take it through the cutover (step 8).",
    repoUrl ? `The folder is already pushed to the private GitHub repository ${repoUrl} for the cloud tasks to clone.` : "The folder is a git repository on this computer; a workflow that runs as a cloud task still needs it pushed to a private GitHub repository.",
    local ? "The keys the local tasks need go in .claude/settings.local.json here: the names are already in it, the values are mine to type." : "",
    "List the whole plan once and wait for my go-ahead before you create a task, publish a page or switch anything off in n8n. Never ask me for a key in the chat.",
  ]
    .filter(Boolean)
    .join(" ");
}

// The plan, in the words shown before the go-ahead, and what it needs.
//   tools: {git, gh, ghUser, claude, skill} (what is installed and signed in here)
// A path as printed: relative to here, in full when it lies outside this folder (a chain of
// ../ is hard to read and wrong once the person changes folder).
const short = (p) => {
  const r = relative(process.cwd(), p);
  return !r ? "." : r.startsWith("..") ? p : r;
};
export function setupPlan(report, { out, repo, tools }) {
  const moves = report.workflows.filter((w) => w.outcome?.kind === "subscription");
  const cloud = moves.filter((w) => w.outcome.target === "cloud-task");
  const secrets = [...new Set(moves.flatMap((w) => (w.requires ?? []).filter((r) => r.kind === "secret" && !String(r.name).startsWith("inline:")).map((r) => r.name)))];
  const flows = join(out, "flows");
  const push = cloud.length > 0 && tools.gh && tools.ghUser;
  const steps = [`Convert ${moves.length === 1 ? "it" : "them"} into ${short(flows)} (files only: nothing is sent, scheduled or switched off)`];
  if (tools.git) steps.push(`Make that folder a git repository and commit it${push ? `, and push it to a new private GitHub repository ${tools.ghUser}/${repo} (${cloud.length} of them run${cloud.length === 1 ? "s" : ""} as a cloud task, which clones it)` : ""}`);
  if (!tools.skill) steps.push("Add the n8n-migrate skill to Claude Code");
  if (tools.claude) steps.push("Open Claude Code in that folder to create the scheduled tasks; it lists them and asks before it creates one or switches n8n off");
  return { moves, cloud, secrets, flows, push: !!push, steps };
}

// Runs the plan. `run` is sh (injected in tests); `say` prints. Returns what was done and what
// is left, never a secret value: the keys file gets the names with empty values.
export function goOn({ report, inputs, items, out, repo = "n8n-workflows", tools, run = sh, say = console.log, openClaude = true, install = true }) {
  const plan = setupPlan(report, { out, repo, tools });
  const done = { converted: 0, folders: [], committed: false, repoUrl: null, keysFile: null, left: [], prompt: null, claude: false };
  // 1. Convert every input together (sub-workflow calls resolve across them).
  let input = inputs[0];
  if (inputs.length > 1) {
    input = join(out, "input.json");
    writeFileSync(input, JSON.stringify(items.map((it) => it.wf)) + "\n");
  }
  const conv = run(process.execPath, [join(HERE, "convert.mjs"), input, "--out", plan.flows], { maxBuffer: 64 * 1024 * 1024 });
  if (conv.status !== 0) {
    say(`! The conversion did not finish: ${conv.stderr.trim().split("\n").at(-1) ?? "no reason given"}`);
    return done;
  }
  const summary = JSON.parse(conv.stdout).workflows;
  const moved = summary.filter((w) => w.status !== "refused");
  done.converted = moved.length;
  done.folders = moved.map((w) => w.folder);
  for (const w of moved) say(`  converted ${w.name}${w.blocked ? `: ${w.blocked} step${w.blocked === 1 ? "" : "s"} cannot move yet (its MIGRATION.md says which)` : w.review ? `: ${w.review} step${w.review === 1 ? "" : "s"} to check` : ""}`);
  if (!moved.length) return done;
  // The keys: names only, for the person to fill. A local task reads them from this file; a
  // cloud task from network secrets the person adds to its environment.
  const defs = moved.map((w) => ({ w, def: JSON.parse(readFileSync(join(plan.flows, w.folder, "definition.json"), "utf8")), target: report.workflows.find((x) => String(x.id) === String(w.id))?.outcome?.target }));
  const localSecrets = [...new Set(defs.filter((d) => d.target !== "cloud-task").flatMap((d) => d.def.secrets.map((x) => x.name)))];
  const cloudSecrets = defs.filter((d) => d.target === "cloud-task").flatMap((d) => d.def.secrets.map((x) => ({ name: x.name, hosts: x.hosts })));
  if (localSecrets.length) {
    const file = join(plan.flows, ".claude", "settings.local.json");
    const have = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    have.env = { ...Object.fromEntries(localSecrets.map((n) => [secretEnvName(n), ""])), ...(have.env ?? {}) };
    mkdirSync(join(plan.flows, ".claude"), { recursive: true });
    writeFileSync(file, JSON.stringify(have, null, 2) + "\n", { mode: 0o600 });
    done.keysFile = file;
    done.left.push(`Type ${localSecrets.length === 1 ? "the key" : `${localSecrets.length} keys`} into ${short(file)} (${localSecrets.map((n) => `${secretEnvName(n)} for "${n}"`).join(", ")}). The file is not committed.`);
  }
  for (const x of cloudSecrets) done.left.push(`Add "${x.name}" as a network secret for ${x.hosts.join(", ") || "its host"} in the cloud environment the tasks run in (Claude Code says where).`);
  // 2. A git repository, and a private GitHub repository when a cloud task will clone it.
  if (tools.git) {
    const git = (...args) => run("git", ["-C", plan.flows, ...args]);
    if (!existsSync(join(plan.flows, ".git"))) git("init", "-q", "-b", "main");
    git("add", "-A");
    // The person's own git identity when they have one; a stand-in only so the commit exists.
    const me = git("config", "user.email").stdout.trim() ? [] : ["-c", "user.name=n8n-migrate", "-c", "user.email=n8n-migrate@localhost"];
    const c = git(...me, "commit", "-q", "-m", "n8n workflows migrated");
    done.committed = c.status === 0 || /nothing to commit/.test(c.stdout + c.stderr);
    if (plan.push && done.committed) {
      const r = run("gh", ["repo", "create", `${tools.ghUser}/${repo}`, "--private", "--source", plan.flows, "--remote", "origin", "--push"]);
      if (r.status === 0) done.repoUrl = `${tools.ghUser}/${repo}`;
      else say(`! The private repository was not created (${(r.stderr.trim().split("\n").at(-1) ?? "gh failed").slice(0, 200)}). Create it yourself: gh repo create ${repo} --private --source ${short(plan.flows)} --push`);
    } else if (plan.cloud.length && !plan.push) done.left.push(`Push ${short(plan.flows)} to a private GitHub repository (the cloud tasks clone it): gh repo create ${repo} --private --source ${short(plan.flows)} --push`);
  }
  // 3. The skill, then Claude Code on the folder.
  if (!tools.skill) {
    const r = install ? run("npx", ["-y", "skills", "add", REPO, "-g"], { stdio: "inherit" }) : { status: 1 };
    if (r.status !== 0) done.left.push(`Add the skill to Claude Code: npx skills add ${REPO} -g`);
  }
  done.prompt = setupPrompt({ repoUrl: done.repoUrl, local: localSecrets.length > 0 });
  if (tools.claude && openClaude) {
    say(`\nOpening Claude Code in ${short(plan.flows)} to create the scheduled tasks. It asks before it creates one or switches n8n off.`);
    done.claude = run("claude", [done.prompt], { cwd: plan.flows, stdio: "inherit" }).status === 0;
  } else done.left.push(`Open Claude Code in ${short(plan.flows)} and paste: ${done.prompt}`);
  return done;
}

// What is installed and signed in on this computer, for the plan.
function findTools(run = sh) {
  const ok = (cmd, args) => run(cmd, args).status === 0;
  const gh = ok("gh", ["auth", "status"]);
  return { git: ok("git", ["--version"]), gh, ghUser: gh ? run("gh", ["api", "user", "-q", ".login"]).stdout.trim() || null : null, claude: ok("claude", ["--version"]), skill: skillInstalled() };
}

export async function main(argv = process.argv.slice(2), { stdin = process.stdin, stdout = process.stdout } = {}) {
  // `n8n-migrate serve <folder>`: the converted folders as a connector (serve.mjs); it keeps
  // running, so it returns null instead of an exit code.
  if (argv[0] === "serve") return (await import("./serve.mjs")).main(argv.slice(1));
  // `n8n-migrate convert <exports> --out <folder> [...]`: convert.mjs as it is, for a person
  // with a terminal but no Claude Code (the server runs what it writes).
  if (argv[0] === "convert") return spawnSync(process.execPath, [join(HERE, "convert.mjs"), ...argv.slice(1)], { stdio: "inherit" }).status ?? 1;
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
  if (a.version) {
    console.log(VERSION);
    return 0;
  }
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 20) {
    console.error(`n8n-migrate needs Node 20 or later; this is ${process.versions.node}.`);
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
      if (logins.length) console.log(`Opening ${logins[0]} in your browser: approve "n8n-migrate" there (it only reads workflows).`);
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
    const rel = short;
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
    // Go on from the report: one go-ahead for the whole plan at a terminal; with --yes the
    // steps that stay on this computer (convert, commit) and the rest printed to run.
    const fits = report.workflows.filter((w) => w.outcome?.kind === "subscription").length;
    if (a.setup && fits && (rl || a.yes)) {
      // --yes does only what stays on this computer: no repository, no install, no Claude Code.
      const found = findTools();
      const tools = a.yes ? { ...found, gh: false, ghUser: null, claude: false } : found;
      const plan = setupPlan(report, { out: a.out, repo: a.repo, tools: a.yes ? { ...tools, skill: true } : tools });
      console.log(`\n${fits} of ${report.workflows.length} workflow${report.workflows.length === 1 ? "" : "s"} can run on Claude. ${a.yes ? "Going on (--yes):" : "With one go-ahead I will:"}`);
      plan.steps.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
      if (plan.secrets.length) console.log(`Left for you afterwards: typing ${plan.secrets.length === 1 ? "one key" : `${plan.secrets.length} keys`} (${plan.secrets.join(", ")}).`);
      const go = a.yes || /^(y|yes|)$/i.test(await ask(rl, "Go ahead? [Y/n] ", "y"));
      if (go) {
        rl?.close();
        const done = goOn({ report, inputs, items, out: a.out, repo: a.repo, tools, install: !a.yes });
        if (done.repoUrl) console.log(`Private GitHub repository: ${done.repoUrl}`);
        if (done.left.length) console.log(`\nLeft for you:\n${done.left.map((t) => `  - ${t}`).join("\n")}`);
        return 0;
      }
      console.log(`\nNothing was changed. To convert them later: npx n8n-migrate convert ${where} --out ${rel(join(a.out, "flows"))}`);
      return 0;
    }
    if (!installed) {
      const yes = rl ? /^(y|yes|)$/i.test(await ask(rl, "\nAdd the n8n-migrate skill to Claude Code now, so it can convert these? [Y/n] ", "y")) : false;
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
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) {
  const code = await main();
  if (code !== null) process.exit(code);
}
