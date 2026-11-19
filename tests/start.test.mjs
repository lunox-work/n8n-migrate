// The one-command start (scripts/start.mjs), the HTML report (scripts/report-html.mjs) and the
// popular/trending sources of pull.mjs. No network: inputs are local files or a fake fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { routeOf, goOn, setupPlan, setupPrompt } from "../skills/n8n-migrate/scripts/start.mjs";
import { renderHtml, workflowBlocks } from "../skills/n8n-migrate/scripts/report-html.mjs";
import { analyze, loadInput, renderText } from "../skills/n8n-migrate/scripts/analyze.mjs";
import { parseSource, pull } from "../skills/n8n-migrate/scripts/pull.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const START = join(ROOT, "skills/n8n-migrate/scripts/start.mjs");
const REFS = join(ROOT, "skills/n8n-migrate/references");
const ref = (n) => JSON.parse(readFileSync(join(REFS, n), "utf8"));
const report = (file) => analyze(loadInput(join(ROOT, file)).items, { nodes: ref("nodes.json"), capabilities: ref("capabilities.json"), hosts: ref("http-hosts.json"), now: Date.parse("2026-11-16T00:00:00Z") });

test("routeOf: files, template links, popular/trending, editor links and bare addresses each go their way", () => {
  const exists = (p) => p === "here.json";
  assert.equal(routeOf("here.json", { exists }).via, "path");
  assert.deepEqual(routeOf("https://n8n.io/workflows/42-x", { exists }), { via: "pull", source: "https://n8n.io/workflows/42-x" });
  assert.equal(routeOf("popular:3", { exists }).via, "pull");
  assert.equal(routeOf("trending", { exists }).via, "pull");
  assert.deepEqual(routeOf("n8n", { exists }), { via: "api" });
  assert.deepEqual(routeOf("https://me.app.n8n.cloud/workflow/Ab1", { exists }), { via: "login", address: "https://me.app.n8n.cloud", source: "https://me.app.n8n.cloud/workflow/Ab1" });
  assert.deepEqual(routeOf("me.app.n8n.cloud", { exists }), { via: "login", address: "me.app.n8n.cloud" });
  assert.equal(routeOf("http://localhost:5678", { exists }).via, "login");
  assert.equal(routeOf("not a thing", { exists }).via, "bad");
});

test("start.mjs on an export file writes report.html and report.json and prints the next step; no prompt without a terminal", () => {
  const out = mkdtempSync(join(tmpdir(), "n8m-start-"));
  try {
    const r = spawnSync(process.execPath, [START, join(ROOT, "tests/fixtures/convert/slice.n8n.json"), "--out", out, "--no-open"], { encoding: "utf8", input: "", env: { ...process.env, HOME: out } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(out, "report.html")) && existsSync(join(out, "report.json")));
    assert.match(r.stdout, /1 workflows: subscription 1/);
    assert.match(r.stdout, /npx skills add lunox-work\/n8n-migrate -g/);
    const html = readFileSync(join(out, "report.html"), "utf8");
    assert.match(html, /Add the skill to Claude Code/);
    assert.ok(!/<script/i.test(html), "no script in the page");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("start.mjs refuses what it cannot do, with the way to do it", () => {
  const run = (args, env = {}) => spawnSync(process.execPath, [START, ...args, "--no-open"], { encoding: "utf8", input: "", env: { PATH: process.env.PATH, HOME: tmpdir(), ...env } });
  const none = run([]);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /Say where your n8n workflows are/);
  const api = run(["--api"]);
  assert.equal(api.status, 2);
  assert.match(api.stderr, /Settings > n8n API.*Never paste the key into a chat/s);
  assert.equal(run(["what is this"]).status, 2);
});

test("the HTML report groups by outcome, keeps the text report's wording, and escapes workflow content", () => {
  const r = report("tests/fixtures/convert/slice.n8n.json");
  r.workflows[0].name = 'Evil <img src=x onerror="alert(1)">';
  const blocks = workflowBlocks(r);
  const text = renderText(r, false);
  for (const l of blocks[0].lines) assert.ok(text.includes(l.text), `"${l.text}" is in the text report`);
  assert.equal(blocks[0].lines[0].label, "why");
  const html = renderHtml(r, { next: [{ text: "Do <this>", code: "run <that>" }] });
  assert.ok(!html.includes("<img"), "names are escaped");
  assert.match(html, /Evil &lt;img/);
  assert.match(html, /Moves to your Claude subscription <span class="count">1<\/span>/);
  assert.match(html, /Do &lt;this&gt;<pre><code>run &lt;that&gt;/);
  assert.match(html, /prefers-color-scheme:dark/);
});

test("popular and trending pull the listed templates", async () => {
  assert.deepEqual(parseSource("popular"), { kind: "trending", sort: "views:desc", count: 5 });
  assert.deepEqual(parseSource("trending:50"), { kind: "trending", sort: "trendingScore:desc", count: 20 });
  const out = mkdtempSync(join(tmpdir(), "n8m-pop-"));
  try {
    const seen = [];
    const fetch = async (url) => {
      seen.push(url);
      if (url.includes("/search?")) return new Response(JSON.stringify({ workflows: [{ id: 7 }, { id: 9 }] }));
      const id = url.split("/").pop();
      return new Response(JSON.stringify({ workflow: { id: Number(id), name: `T${id}`, workflow: { nodes: [], connections: {} } } }));
    };
    const r = await pull(["popular:2"], { out, fetch, env: {} });
    assert.match(seen[0], /rows=2&sort=views:desc/);
    assert.deepEqual(r.written.map((w) => w.file), ["t7-7.json", "t9-9.json"]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// PLAN Phase 3: after the report, one go-ahead converts, makes the private repository and opens
// Claude Code for the tasks. git, gh, npx and claude are stand-ins here; convert.mjs is real.
test("going on from the report: convert, a private repository for cloud tasks, the keys file, then Claude Code", () => {
  const out = mkdtempSync(join(tmpdir(), "n8m-goon-"));
  try {
    // A daily cloud task (Gmail to Slack) and a local task that needs a key (a poll every minute with an HTTP call).
    const fast = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/convert/poll-code-http.n8n.json"), "utf8"));
    fast.nodes.find((n) => n.type === "n8n-nodes-base.gmailTrigger").parameters.pollTimes = { item: [{ mode: "everyMinute" }] };
    writeFileSync(join(out, "poll-code-http.json"), JSON.stringify(fast));
    const files = [join(ROOT, "tests/fixtures/convert/slice.n8n.json"), join(out, "poll-code-http.json")];
    const items = files.flatMap((f) => loadInput(f).items);
    const rep = analyze(items, { nodes: ref("nodes.json"), capabilities: ref("capabilities.json"), hosts: ref("http-hosts.json"), now: Date.parse("2026-11-16T00:00:00Z") });
    assert.deepEqual(rep.workflows.map((w) => w.outcome.target).sort(), ["cloud-task", "local-task"]);
    const all = { git: true, gh: true, ghUser: "ana", claude: true, skill: false };
    const plan = setupPlan(rep, { out, repo: "n8n-workflows", tools: all });
    assert.equal(plan.steps.length, 4);
    assert.match(plan.steps[0], /^Convert them into .*flows \(files only: nothing is sent, scheduled or switched off\)$/);
    assert.match(plan.steps[1], /push it to a new private GitHub repository ana\/n8n-workflows \(1 of them runs as a cloud task, which clones it\)/);
    assert.match(plan.steps[3], /asks before it creates one or switches n8n off/);
    assert.deepEqual(plan.secrets, ["Accounts API key"]);
    // Without gh nothing is pushed and the plan does not say it will be; without Claude Code no step opens it.
    const bare = setupPlan(rep, { out, repo: "x", tools: { git: true, gh: false, ghUser: null, claude: false, skill: true } });
    assert.deepEqual([bare.push, bare.steps.length, /GitHub/.test(bare.steps[1])], [false, 2, false]);

    const ran = [];
    const run = (cmd, args, opts = {}) => {
      if (cmd === process.execPath) return (({ status, stdout, stderr }) => ({ status, stdout, stderr }))(spawnSync(cmd, args, { encoding: "utf8", ...opts }));
      ran.push([cmd, ...args.filter((x) => x !== join(out, "flows"))]);
      return { status: 0, stdout: "", stderr: "" };
    };
    const said = [];
    const done = goOn({ report: rep, inputs: files, items, out, tools: all, run, say: (t) => said.push(t) });
    assert.equal(done.converted, 2);
    for (const folder of done.folders) for (const f of ["definition.json", "MIGRATION.md", "task-prompt.md"]) assert.ok(existsSync(join(out, "flows", folder, f)), f);
    assert.deepEqual(ran.map((r) => r.slice(0, 3).join(" ")), ["git -C init", "git -C add", "git -C config", "git -C -c", "gh repo create", "npx -y skills", `claude ${done.prompt}`]);
    assert.deepEqual(ran[4], ["gh", "repo", "create", "ana/n8n-workflows", "--private", "--source", "--remote", "origin", "--push"]);
    assert.match(done.prompt, /took the assumed answer to every open question.*Ask me those first/);
    assert.equal(done.repoUrl, "ana/n8n-workflows");
    assert.equal(done.claude, true);
    assert.match(done.prompt, /Use the n8n-migrate skill\..*already pushed to the private GitHub repository ana\/n8n-workflows.*wait for my go-ahead before you create a task, publish a page or switch anything off in n8n\. Never ask me for a key in the chat\./);
    // The keys file names the key and holds no value; the person types it.
    assert.deepEqual(JSON.parse(readFileSync(done.keysFile, "utf8")), { env: { N8M_SECRET_ACCOUNTS_API_KEY: "" } });
    assert.match(readFileSync(join(out, "flows", ".gitignore"), "utf8"), /\.claude\/settings\.local\.json/);
    assert.equal(done.left.length, 1);
    assert.match(done.left[0], /Type the key into .*settings\.local\.json \(N8M_SECRET_ACCOUNTS_API_KEY for "Accounts API key"\)\. The file is not committed\./);
    // A second run keeps a key the person already typed.
    writeFileSync(done.keysFile, JSON.stringify({ env: { N8M_SECRET_ACCOUNTS_API_KEY: "typed" } }));
    goOn({ report: rep, inputs: files, items, out, tools: { ...all, gh: false, ghUser: null, claude: false, skill: true }, run, say: () => {} });
    assert.equal(JSON.parse(readFileSync(done.keysFile, "utf8")).env.N8M_SECRET_ACCOUNTS_API_KEY, "typed");
    // gh refuses (the name is taken): said once with the command, and Claude Code is told the folder is not pushed.
    const refused = goOn({ report: rep, inputs: files, items, out, tools: all, run: (cmd, args, opts) => (cmd === "gh" ? { status: 1, stdout: "", stderr: "GraphQL: Name already exists on this account" } : run(cmd, args, opts)), say: (t) => said.push(t) });
    assert.equal(refused.repoUrl, null);
    assert.match(said.at(-2), /The private repository was not created \(GraphQL: Name already exists on this account\)\. Create it yourself: gh repo create/);
    assert.match(refused.prompt, /still needs it pushed to a private GitHub repository/);
    assert.equal(setupPrompt({}).includes("settings.local.json"), false);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("start.mjs --yes goes on with what stays on this computer and prints the rest; --no-setup stops at the report", () => {
  const out = mkdtempSync(join(tmpdir(), "n8m-start-yes-"));
  try {
    const run = (...extra) => spawnSync(process.execPath, [START, join(ROOT, "tests/fixtures/convert/slice.n8n.json"), "--out", out, "--no-open", ...extra], { encoding: "utf8", input: "", env: { ...process.env, HOME: out } });
    const stop = run("--yes", "--no-setup");
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(existsSync(join(out, "flows")), false);
    const r = run("--yes");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1 of 1 workflow can run on Claude\. Going on \(--yes\):\n  1\. Convert it into /);
    assert.ok(!/GitHub repository [a-z]/.test(r.stdout.split("Left for you")[0]), "--yes never creates a repository");
    assert.ok(existsSync(join(out, "flows", "slice", "definition.json")) || readFileSync(join(out, "report.json"), "utf8").length > 0);
    assert.match(r.stdout, /Left for you:\n(  - .*\n)*  - Open Claude Code in .*flows and paste: Use the n8n-migrate skill\./);
    assert.match(r.stdout, /Push .*flows to a private GitHub repository \(the cloud tasks clone it\): gh repo create n8n-workflows --private/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
