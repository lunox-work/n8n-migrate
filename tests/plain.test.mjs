// The plain view for someone who is not technical (scripts/plain.mjs), its page
// (report-html.mjs renderPlainHtml) and the one command that writes both (scripts/migrate.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { plainWorkflow, plainReport, credentialApp, easiest, renderPlainText } from "../skills/n8n-migrate/scripts/plain.mjs";
import { renderPlainHtml } from "../skills/n8n-migrate/scripts/report-html.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATE = join(ROOT, "skills/n8n-migrate/scripts/migrate.mjs");
const FIX = join(ROOT, "tests/fixtures/convert");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// A minimal analyzer record; each test sets what it needs.
const wf = (o = {}) => ({
  id: "w1",
  name: "Daily digest",
  wakeup: { kind: "schedule" },
  schedule: { shortestIntervalSec: 86400, runsPerDay: 1 },
  outcome: { kind: "subscription", target: "cloud-task", reason: "" },
  requires: [],
  questions: [],
  blockers: [],
  credentials: [],
  ...o,
});
const q = (id, extra = {}) => ({ id, text: "", nodes: [id.split("/").slice(2).join("/")], affects: "outcome", options: {}, assumed: "outsiders", answer: null, ...extra });

test("a daily workflow with only connectors is ready, and a missing connector makes it need one thing", () => {
  const w = wf({
    requires: [
      { kind: "connector", name: "gmail" },
      { kind: "model", name: "claude" },
    ],
  });
  const ready = plainWorkflow(w, { connected: ["gmail"] });
  assert.equal(ready.group, "ready");
  assert.equal(ready.runs, "scheduled-task");
  assert.match(ready.says, /Runs on Claude every day, with Gmail/);
  const needs = plainWorkflow(w, { connected: [] });
  assert.equal(needs.group, "needs");
  assert.deepEqual(
    needs.todo.map((t) => t.kind),
    ["connect"],
  );
  assert.match(needs.todo[0].text, /Connect Gmail/);
  // Unknown connections: listed, never counted as missing.
  assert.equal(plainWorkflow(w).group, "ready");
});

test("a saved key, a Google token or a schedule under an hour stays, as something a developer can move", () => {
  const key = plainWorkflow(wf({ requires: [{ kind: "secret", name: "My key" }], credentials: [{ name: "My key", type: "openAiApi" }] }));
  assert.equal(key.group, "stays");
  assert.equal(key.developer, true);
  assert.match(key.why, /signs in to OpenAI with a saved key/);
  assert.equal(plainWorkflow(wf({ requires: [{ kind: "google-token", name: "Sheets" }] })).developer, true);
  const fast = plainWorkflow(wf({ schedule: { shortestIntervalSec: 300 } }));
  assert.equal(fast.group, "stays");
  assert.match(fast.why, /every 5 minutes/);
});

test("a poll every minute asks to check hourly instead; a schedule Claude cannot keep asks which cadence", () => {
  const poll = plainWorkflow(wf({ wakeup: { kind: "poll" }, schedule: { shortestIntervalSec: 60 } }));
  assert.equal(poll.group, "needs");
  assert.deepEqual([poll.todo[0].id, poll.todo[0].assumed], ["w1/cadence", "hourly"]);
  assert.equal(plainWorkflow(wf({ wakeup: { kind: "poll" }, schedule: { shortestIntervalSec: 60 } }), { answers: { "w1/cadence": "hourly" } }).group, "ready");
  const odd = plainWorkflow(wf({ schedule: { shortestIntervalSec: 7200 } }));
  assert.deepEqual(
    odd.todo[0].options.map((o) => o.value),
    ["hourly", "daily", "weekly"],
  );
  assert.equal(odd.todo[0].assumed, null, "running more often sends more: the person chooses");
});

test("a hosted chat bot is offered the question only when another answer would let it move", () => {
  const bot = wf({ wakeup: { kind: "relay" }, outcome: { kind: "hosted", target: "key", reason: "people wait in a chat app for each reply" }, questions: [q("w1/chat-app-users/Bot")] });
  assert.equal(plainWorkflow(bot, { whatIf: () => false }).group, "stays");
  const rescued = plainWorkflow(bot, { whatIf: (w, a) => a["w1/chat-app-users/Bot"] === "in-claude" });
  assert.equal(rescued.group, "needs");
  assert.match(rescued.todo[0].text, /Who messages the bot "Bot"/);
});

test("the same question about several steps is asked once, with every id", () => {
  const w = wf({
    wakeup: { kind: "endpoint" },
    outcome: { kind: "hosted", target: "no-key", reason: "an outside caller waits for a reply" },
    questions: [q("w1/endpoint-callers/A"), q("w1/endpoint-callers/B")],
  });
  const x = plainWorkflow(w);
  assert.equal(x.todo.length, 1);
  assert.deepEqual(x.todo[0].ids, ["w1/endpoint-callers/A", "w1/endpoint-callers/B"]);
  assert.match(x.todo[0].text, /"A" and "B"/);
});

test("tutorials, missing sub-workflows and blocked steps stay, each with its reason", () => {
  assert.match(plainWorkflow(wf({ blockers: [{ kind: "not-an-automation", reason: "tutorial" }] })).why, /tutorial/);
  const sub = plainWorkflow(wf({ outcome: { kind: "keep-in-n8n" }, blockers: [{ kind: "input-incomplete", reason: 'sub-workflow "Ab12" ("Lookup") is not in the export' }] }));
  assert.deepEqual(sub.fix, [{ kind: "fetch-sub-workflow", id: "Ab12", name: "Lookup" }]);
  const blocked = plainWorkflow(wf(), { conv: { status: "blocked-steps", folder: "f" }, steps: { blocked: [{ step: "Move mail", reason: "no tool" }], substitutions: [] } });
  assert.equal(blocked.group, "stays");
  assert.match(blocked.why, /its step "Move mail" cannot move yet/);
});

test("substitutions become one yes/no each, in plain words", () => {
  const x = plainWorkflow(wf(), {
    conv: { status: "blocked-steps" },
    steps: {
      blocked: [],
      substitutions: [
        { step: "A", id: "llm-api-to-claude" },
        { step: "B", id: "llm-api-to-claude" },
        { step: "Mail", id: "smtp-to-gmail" },
      ],
    },
  });
  assert.deepEqual(
    x.todo.map((t) => t.id),
    ["llm-api-to-claude", "smtp-to-gmail"],
  );
  assert.match(x.todo[0].text, /"A" and "B" call another AI service/);
  assert.match(x.todo[1].text, /Send from your Gmail instead/);
  assert.equal(plainWorkflow(wf(), { steps: { blocked: [], substitutions: [{ step: "Mail", id: "smtp-to-gmail" }] }, answers: { approve: ["smtp-to-gmail"] } }).group, "ready");
});

test("credential names come from the type first; the easiest pick prefers fewer apps", () => {
  assert.equal(credentialApp("OpenAI Templates Account", "openAiApi"), "OpenAI");
  assert.equal(credentialApp("serpApi Credential"), "SerpAPI");
  assert.equal(
    easiest([
      { id: "a", name: "A", group: "ready", runs: "scheduled-task", apps: ["Gmail", "Slack"] },
      { id: "b", name: "B", group: "ready", runs: "scheduled-task", apps: ["Gmail"] },
    ]),
    "b",
  );
});

test("the page shows the three groups, marks the first move and escapes names", () => {
  const report = { workflows: [wf({ id: "r", name: "<b>Ready</b>" }), wf({ id: "s", name: "Keyed", requires: [{ kind: "secret", name: "k" }] })] };
  const plan = plainReport(report);
  const html = renderPlainHtml(plan);
  assert.match(html, /Ready to move/);
  assert.match(html, /Stays in n8n for now/);
  assert.match(html, /Start here/);
  assert.ok(html.includes("&lt;b&gt;Ready&lt;/b&gt;") && !html.includes("<b>Ready</b>"));
  assert.match(renderPlainText(plan), /A developer can move it|a developer can move it/);
});

test("migrate.mjs: one command writes report, folders, plan and page; answers move a workflow between groups", () => {
  const dir = mkdtempSync(join(tmpdir(), "n8m-migrate-"));
  try {
    const run = (...extra) => spawnSync(process.execPath, ["--max-old-space-size=512", MIGRATE, join(FIX, "slice.n8n.json"), "--out", dir, "--json", ...extra], { encoding: "utf8" });
    let r = run("--connected", "gmail");
    assert.equal(r.status, 0, r.stderr);
    let plan = JSON.parse(r.stdout);
    assert.deepEqual(plan.counts, { ready: 0, needs: 1, stays: 0 });
    assert.equal(plan.groups.needs[0].todo[0].connector, "slack");
    for (const f of ["report.json", "convert.json", "plan.json", "page.html"]) readFileSync(join(dir, f));
    r = run("--connected", "gmail,slack");
    plan = JSON.parse(r.stdout);
    assert.equal(plan.groups.ready[0].runs, "scheduled-task");
    assert.equal(plan.easiest, plan.groups.ready[0].id);

    // A Gmail poll every minute: the cadence answer rewrites the trigger's schedule.
    const src = readJson(join(FIX, "poll-code-http.n8n.json"));
    src.id = "pollfast";
    src.nodes = src.nodes.filter((n) => n.type !== "n8n-nodes-base.httpRequest");
    src.nodes[0].parameters.pollTimes = { item: [{ mode: "everyMinute" }] };
    const input = join(dir, "poll.json");
    writeFileSync(input, JSON.stringify(src));
    const answers = join(dir, "a.json");
    writeFileSync(answers, JSON.stringify({ "pollfast/cadence": "hourly" }));
    const before = JSON.parse(spawnSync(process.execPath, [MIGRATE, input, "--out", join(dir, "p0"), "--json", "--connected", "gmail"], { encoding: "utf8" }).stdout);
    assert.equal(before.groups.needs[0].todo[0].id, "pollfast/cadence");
    const r2 = spawnSync(process.execPath, [MIGRATE, input, "--out", join(dir, "p1"), "--json", "--connected", "gmail", "--answers", answers], { encoding: "utf8" });
    assert.equal(r2.status, 0, r2.stderr);
    const after = JSON.parse(r2.stdout);
    assert.equal(after.counts.ready, 1);
    const folder = readJson(join(dir, "p1", "convert.json")).workflows[0].folder;
    const trig = Object.values(readJson(join(dir, "p1", "flows", folder, "definition.json")).steps).find((s) => s.kind === "trigger");
    assert.deepEqual([trig.schedule.cron, trig.schedule.shortestIntervalSec], [["0 0 * * * *"], 3600]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("whether n8n still runs it comes from the export's active flag", () => {
  assert.equal(plainWorkflow(wf({ activeInN8n: true })).n8n, "on");
  assert.equal(plainWorkflow(wf({ activeInN8n: false })).n8n, "off");
  assert.equal(plainWorkflow(wf({ activeInN8n: null })).n8n, "unknown");
  assert.equal(plainWorkflow(wf()).n8n, "unknown");
});

test("migrate.mjs: a known timezone answers the schedule's timezone question instead of asking it", () => {
  const dir = mkdtempSync(join(tmpdir(), "n8m-tz-"));
  try {
    const wfJson = {
      id: "tz1",
      name: "Morning mail",
      active: false,
      settings: { executionOrder: "v1" },
      nodes: [
        { id: "a", name: "Every morning", type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.2, position: [0, 0], parameters: { rule: { interval: [{ triggerAtHour: 7 }] } } },
        { id: "b", name: "Recent mail", type: "n8n-nodes-base.gmail", typeVersion: 2.1, position: [200, 0], parameters: { operation: "getAll", limit: 5, filters: { q: "newer_than:1d" } }, credentials: { gmailOAuth2: { id: "1", name: "Gmail account" } } },
      ],
      connections: { "Every morning": { main: [[{ node: "Recent mail", type: "main", index: 0 }]] } },
    };
    writeFileSync(join(dir, "wf.json"), JSON.stringify(wfJson));
    const run = (extra) => spawnSync(process.execPath, [MIGRATE, join(dir, "wf.json"), "--out", join(dir, "m"), "--connected", "gmail", "--json", ...extra], { encoding: "utf8" });
    const asked = run([]);
    assert.equal(asked.status, 0, asked.stderr);
    assert.ok(readJson(join(dir, "m", "plan.json")).groups.needs.some((w) => w.todo.some((t) => /\/timezone$/.test(t.id))), "without a timezone it is asked");
    const known = run(["--timezone", "Asia/Singapore"]);
    assert.equal(known.status, 0, known.stderr);
    const plan = readJson(join(dir, "m", "plan.json"));
    assert.deepEqual(plan.groups.ready.map((w) => [w.id, w.n8n]), [["tz1", "off"]]);
    assert.equal(readJson(join(dir, "m", "answers.json"))["tz1/timezone"], "Asia/Singapore");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A search service with a key is the only thing Claude Code would be needed for: the person is
// asked whether Claude may search itself, and the answer moves the workflow (plain.mjs SWAP).
test("migrate.mjs: a SerpAPI search tool asks to use Claude's search; yes makes the workflow ready", () => {
  const LC = "@n8n/n8n-nodes-langchain.";
  const flow = {
    id: "srch1",
    name: "Research chat",
    active: false,
    nodes: [
      { parameters: {}, name: "Chat", type: LC + "chatTrigger", typeVersion: 1.1, position: [0, 0] },
      { parameters: { options: {} }, name: "Agent", type: LC + "agent", typeVersion: 1.7, position: [200, 0] },
      { parameters: { model: "gpt-4o", options: {} }, name: "Model", type: LC + "lmChatOpenAi", typeVersion: 1, position: [100, 200] },
      { parameters: { options: {} }, name: "Search", type: LC + "toolSerpApi", typeVersion: 1, position: [300, 200], credentials: { serpApi: { id: "1", name: "SerpAPI account" } } },
    ],
    connections: {
      Chat: { main: [[{ node: "Agent", type: "main", index: 0 }]] },
      Model: { ai_languageModel: [[{ node: "Agent", type: "ai_languageModel", index: 0 }]] },
      Search: { ai_tool: [[{ node: "Agent", type: "ai_tool", index: 0 }]] },
    },
    settings: { executionOrder: "v1" },
  };
  const dir = mkdtempSync(join(tmpdir(), "n8m-plain-search-"));
  try {
    writeFileSync(join(dir, "flow.json"), JSON.stringify(flow));
    const go = (...extra) => spawnSync(process.execPath, [MIGRATE, join(dir, "flow.json"), "--out", join(dir, "out"), "--json", ...extra], { encoding: "utf8" });
    const first = go();
    assert.equal(first.status, 0, first.stderr);
    const plan = JSON.parse(first.stdout);
    assert.deepEqual(plan.counts, { ready: 0, needs: 1, stays: 0 });
    const [todo] = plan.groups.needs[0].todo;
    assert.deepEqual([todo.kind, todo.id, todo.ids, todo.assumed], ["question", "srch1/search-with/Search", ["srch1/search-with/Search"], "keep"]);
    assert.match(todo.text, /searches the web with SerpAPI and your own key\. Let Claude search the web itself instead\?/);
    assert.deepEqual(todo.options.map((o) => o.value), ["claude", "keep"]);
    assert.equal(plan.groups.needs[0].developer, false);
    // No: it stays, as something a developer can move. Yes: ready, with no key and no request of ours.
    writeFileSync(join(dir, "a.json"), JSON.stringify({ "srch1/search-with/Search": "keep" }));
    const kept = JSON.parse(go("--answers", join(dir, "a.json")).stdout);
    assert.deepEqual([kept.counts, kept.groups.stays[0].developer], [{ ready: 0, needs: 0, stays: 1 }, true]);
    writeFileSync(join(dir, "a.json"), JSON.stringify({ "srch1/search-with/Search": "claude" }));
    const yes = JSON.parse(go("--answers", join(dir, "a.json")).stdout);
    assert.deepEqual(yes.counts, { ready: 1, needs: 0, stays: 0 });
    const def = readJson(join(dir, "out", "flows", yes.groups.ready[0].folder, "definition.json"));
    assert.deepEqual([def.secrets, def.allow.http, def.allow.tools], [[], [], [{ connector: "claude", tool: "WebSearch" }]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migrate.mjs: several export files are converted together, each to its own folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "n8m-multi-"));
  try {
    const one = (id, name) => ({
      id,
      name,
      active: false,
      settings: { executionOrder: "v1", timezone: "Asia/Singapore" },
      nodes: [
        { id: "a", name: "Every morning", type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.2, position: [0, 0], parameters: { rule: { interval: [{ triggerAtHour: 7 }] } } },
        { id: "b", name: "Recent mail", type: "n8n-nodes-base.gmail", typeVersion: 2.1, position: [200, 0], parameters: { operation: "getAll", limit: 5, filters: { q: "newer_than:1d" } }, credentials: { gmailOAuth2: { id: "1", name: "Gmail account" } } },
      ],
      connections: { "Every morning": { main: [[{ node: "Recent mail", type: "main", index: 0 }]] } },
    });
    writeFileSync(join(dir, "a.json"), JSON.stringify(one("m1", "Morning one")));
    writeFileSync(join(dir, "b.json"), JSON.stringify(one("m2", "Morning two")));
    const r = spawnSync(process.execPath, [MIGRATE, join(dir, "a.json"), join(dir, "b.json"), "--out", join(dir, "m"), "--connected", "gmail", "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const plan = readJson(join(dir, "m", "plan.json"));
    assert.deepEqual(plan.groups.ready.map((w) => [w.id, !!w.folder]).sort(), [["m1", true], ["m2", true]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
