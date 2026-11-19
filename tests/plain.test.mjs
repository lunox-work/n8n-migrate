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
  assert.match(ready.says, /every day at 09:00, with Gmail/);
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
