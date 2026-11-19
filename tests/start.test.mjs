// The one-command start (scripts/start.mjs), the HTML report (scripts/report-html.mjs) and the
// popular/trending sources of pull.mjs. No network: inputs are local files or a fake fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { routeOf } from "../skills/n8n-migrate/scripts/start.mjs";
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
