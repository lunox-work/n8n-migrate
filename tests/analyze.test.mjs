// Golden tests for skills/n8n-to-claude/scripts/analyze.mjs, plus unit tests
// for the cron expander, SQL parse and secret redaction.
//
//   node --test                  compare every fixture with its golden report
//   UPDATE_GOLDEN=1 node --test  rewrite the goldens (then review them by hand)
//
// A fixture is tests/fixtures/<name>.json; <name>.answers.json, when present,
// is passed as --answers. The golden is tests/golden/<name>.json, compared
// deep-equal after removing analyzer.version. The cron simulation starts at
// NOW so goldens do not move with the calendar.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { validate, schema } from "./schema-check.mjs";
import { analyze, loadInput, parseCron, simulateCron, legacyCron, redact, findSecrets, scanSecrets, sqlEffect, renderText, httpTarget, observesDst, SHEETS_REST_OPS } from "../skills/n8n-to-claude/scripts/analyze.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SCRIPT = join(ROOT, "skills/n8n-to-claude/scripts/analyze.mjs");
const FIXTURES = join(HERE, "fixtures");
const GOLDEN = join(HERE, "golden");
const NOW_ISO = "2026-11-16T00:00:00Z"; // a Monday
const NOW = Date.parse(NOW_ISO);
const nodes = JSON.parse(readFileSync(join(ROOT, "skills/n8n-to-claude/references/nodes.json"), "utf8"));
const capabilities = JSON.parse(readFileSync(join(ROOT, "skills/n8n-to-claude/references/capabilities.json"), "utf8"));
const hosts = JSON.parse(readFileSync(join(ROOT, "skills/n8n-to-claude/references/http-hosts.json"), "utf8"));

const strip = (r) => {
  const { version, ...analyzer } = r.analyzer;
  return JSON.parse(JSON.stringify({ ...r, analyzer }));
};

function run(name) {
  const input = loadInput(join(FIXTURES, `${name}.json`));
  assert.ok(!input.fatal, input.fatal);
  const af = join(FIXTURES, `${name}.answers.json`);
  const answers = existsSync(af) ? JSON.parse(readFileSync(af, "utf8")) : {};
  return analyze(input.items, { nodes, capabilities, hosts, answers, now: NOW, inputErrors: input.errors });
}

const names = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".json") && !f.endsWith(".answers.json"))
  .map((f) => f.slice(0, -5))
  .sort();

for (const name of names) {
  test(`golden: ${name}`, () => {
    const report = run(name);
    const gp = join(GOLDEN, `${name}.json`);
    if (process.env.UPDATE_GOLDEN) {
      const { version, ...analyzer } = report.analyzer;
      writeFileSync(gp, JSON.stringify({ ...report, analyzer }, null, 2) + "\n");
      return;
    }
    assert.ok(existsSync(gp), `no golden for ${name}; run with UPDATE_GOLDEN=1 and review it`);
    const golden = JSON.parse(readFileSync(gp, "utf8"));
    assert.deepEqual(strip(report), strip(golden));
    assert.ok(renderText(report).length > 0);
  });
}

test("every report conforms to report.schema.json", () => {
  for (const name of names) assert.deepEqual(validate(run(name), schema), [], name);
  assert.ok(validate({ schemaVersion: 2 }, schema).length > 0, "the checker rejects a bad report");
});

test("no secret value reaches any golden report", () => {
  for (const name of names) {
    const text = JSON.stringify(run(name));
    for (const v of ["Q7v9TzR2mLx4Pq8NwE3s", "9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c", "Tq3Vb7Nm1Lk9Hj5Gf2Ds8Ap4Zx6Cv0Bn"]) assert.ok(!text.includes(v), `${name} leaks ${v}`);
  }
});

test("n8n 2.x export: report does not depend on file order and carries no owner data", () => {
  // --all writes an array; --separate/--backup write one file per workflow named
  // by id, so a folder reads in id order. Both must give the same report.
  const input = loadInput(join(FIXTURES, "n8n2-export-all.json"));
  const opts = { nodes, capabilities, hosts, answers: {}, now: NOW, inputErrors: [] };
  const byId = (r) => Object.fromEntries(r.workflows.map((w) => [w.id, w]));
  const forward = analyze(input.items, opts);
  const reversed = analyze([...input.items].reverse(), opts);
  assert.deepEqual(byId(reversed), byId(forward));
  const cleanup = forward.workflows.find((w) => w.id === "mmVisitsCleanup1");
  assert.deepEqual(cleanup.sharedState[0].sharedWith, ["aaVisitsIntake01", "zzVisitsReport01"]);
  // `shared[].project.name` holds the owner's name and email in a real export.
  assert.ok(!JSON.stringify(forward).includes("owner@example.com"));
  assert.ok(!renderText(forward).includes("owner@example.com"));
});

// ---------- CLI ----------

test("cli: --json matches the golden; text summary; exit codes", () => {
  const r = spawnSync(process.execPath, [SCRIPT, join(FIXTURES, "schedule-cloud-prompt.json"), "--json", "--now", NOW_ISO], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const golden = JSON.parse(readFileSync(join(GOLDEN, "schedule-cloud-prompt.json"), "utf8"));
  assert.deepEqual(strip(JSON.parse(r.stdout)), strip(golden));

  const t = spawnSync(process.execPath, [SCRIPT, FIXTURES, "--now", NOW_ISO], { encoding: "utf8" });
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /Hourly inbox digest — moves: cloud task · schedule every 1 h, prompt/);
  assert.match(t.stdout, /workflows: subscription \d+/);
  assert.ok(!/\x1b\[/.test(t.stdout), "no colour codes when stdout is not a TTY");

  const stdin = spawnSync(process.execPath, [SCRIPT, "-", "--json", "--now", NOW_ISO], { input: readFileSync(join(FIXTURES, "endpoint-key.json")), encoding: "utf8" });
  assert.equal(stdin.status, 0, stdin.stderr);
  assert.equal(JSON.parse(stdin.stdout).workflows[0].outcome.kind, "hosted");

  const bad = spawnSync(process.execPath, [SCRIPT, "-"], { input: "{not json", encoding: "utf8" });
  assert.equal(bad.status, 2);
  const missing = spawnSync(process.execPath, [SCRIPT, join(FIXTURES, "nope.json")], { encoding: "utf8" });
  assert.equal(missing.status, 2);
  const none = spawnSync(process.execPath, [SCRIPT, "-"], { input: '{"hello": 1}', encoding: "utf8" });
  assert.equal(none.status, 2);
});

test("cli: --out writes the file; template wrapper and folder with a bad file", () => {
  const dir = mkdtempSync(join(tmpdir(), "n8m-"));
  const wf = JSON.parse(readFileSync(join(FIXTURES, "chat-skill.json"), "utf8"));
  writeFileSync(join(dir, "t.json"), JSON.stringify({ workflow: { id: 77, name: "Template name", workflow: { nodes: wf.nodes, connections: wf.connections } } }));
  writeFileSync(join(dir, "broken.json"), "{");
  const out = join(dir, "report.json");
  const r = spawnSync(process.execPath, [SCRIPT, dir, "--json", "--out", out, "--now", NOW_ISO], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const rep = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(rep.workflows.length, 1);
  assert.equal(rep.workflows[0].id, "77");
  assert.equal(rep.workflows[0].name, "Template name");
  assert.equal(rep.workflows[0].outcome.target, "skill");
  assert.equal(rep.summary.inputErrors.length, 1);
  assert.equal(rep.summary.inputErrors[0].file, "broken.json");
});

// ---------- cron ----------

test("cron: parse fields, names, steps, ranges", () => {
  const c = parseCron("0 9 * * 1-5");
  assert.deepEqual(c.seconds, [0]);
  assert.deepEqual(c.minutes, [0]);
  assert.deepEqual(c.hours, [9]);
  assert.deepEqual([...c.dows].sort(), [1, 2, 3, 4, 5]);
  assert.equal(c.domStar, true);
  const s = parseCron("*/15 0 */6 1,15 JAN-MAR sun,7");
  assert.deepEqual(s.seconds, [0, 15, 30, 45]);
  assert.deepEqual(s.hours, [0, 6, 12, 18]);
  assert.deepEqual([...s.months].sort(), [1, 2, 3]);
  assert.deepEqual([...s.dows], [0]);
  assert.deepEqual(parseCron("5/20 * * * *").minutes, [5, 25, 45]);
  assert.throws(() => parseCron("0 0 L * *"));
  assert.throws(() => parseCron("* * *"));
  assert.throws(() => parseCron("61 * * * *"));
});

test("cron: simulate runs per day and shortest gap", () => {
  assert.deepEqual(pick(simulateCron(["0 * * * *"], NOW)), { runsPerDay: 24, shortestSec: 3600 });
  assert.deepEqual(pick(simulateCron(["*/20 * * * * *"], NOW)), { runsPerDay: 4320, shortestSec: 20 });
  // */45 seconds fires at :00 and :45, so the short gap is 15 s
  assert.equal(simulateCron(["*/45 * * * * *"], NOW).shortestSec, 15);
  // weekdays at 9: sparse, so 366 days are simulated from Monday 2026-11-16
  const wd = simulateCron(["0 9 * * 1-5"], NOW);
  assert.equal(wd.days, 366);
  assert.equal(wd.fires, 262);
  assert.equal(wd.shortestSec, 86400);
  // two expressions merge; a fire both share counts once
  assert.equal(simulateCron(["0 */15 * * * *", "0 0 9 * * *"], NOW).runsPerDay, 96);
  // both day fields restricted: either matches
  const either = simulateCron(["0 0 1 * 1"], NOW);
  assert.ok(either.fires > 52 + 12 - 3 && either.fires <= 52 + 12 + 1);
  assert.equal(simulateCron(["0 0 1 1 *"], NOW).shortestSec, null);
});

test("cron: legacy trigger times follow n8n's toCronExpression", () => {
  assert.equal(legacyCron({ mode: "everyMinute" }), "0 * * * * *");
  assert.equal(legacyCron({ mode: "everyX", value: 15, unit: "minutes" }), "0 */15 * * * *");
  assert.equal(legacyCron({ mode: "everyX", value: 3 }), "0 0 */3 * * *");
  assert.equal(legacyCron({}), "0 0 14 * * *");
  assert.equal(legacyCron({ mode: "everyWeek", hour: 8 }), "0 0 8 * * 1");
  assert.equal(legacyCron({ mode: "custom", cronExpression: " 0 5 * * * " }), "0 5 * * *");
});

function pick(r) {
  return { runsPerDay: r.runsPerDay, shortestSec: r.shortestSec };
}

// ---------- SQL ----------

test("sql: verbs decide the effect; hidden verbs are undetermined", () => {
  assert.equal(sqlEffect("SELECT * FROM t"), "read");
  assert.equal(sqlEffect("=SELECT * FROM t WHERE id = {{ $json.id }}"), "read");
  assert.equal(sqlEffect("with x as (select 1) select * from x"), "read");
  assert.equal(sqlEffect("WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x"), "write");
  assert.equal(sqlEffect("select 1; update t set a = 1"), "write");
  assert.equal(sqlEffect("-- note\nINSERT INTO t VALUES (1)"), "write");
  assert.equal(sqlEffect("SELECT * INTO backup FROM t"), "write");
  assert.equal(sqlEffect("={{ $json.sql }}"), undefined);
  assert.equal(sqlEffect("CALL refresh()"), undefined);
  assert.equal(sqlEffect(""), undefined);
});

// ---------- secrets ----------

test("redact keeps 4 characters and the length", () => {
  assert.equal(redact("sk-proj-abcdefghijklmnopqrstuvwxyz"), "sk-p…34");
  assert.equal(redact("abc"), "abc…3");
});

test("secrets: known shapes, generic shapes, placeholders, expressions", () => {
  // Keys are joined at run time so no secret-shaped literal sits in this file.
  const j = (...xs) => xs.join("");
  const cases = [
    [j("sk-", "ant-", "api03-", "A1b2C3d4E5f6G7h8I9j0K1l2"), "anthropic"],
    [j("sk_", "live_", "51Habcdefghij0123456789"), "stripe"],
    [j("sk-", "proj-", "A1b2C3d4E5f6G7h8I9j0"), "openai"],
    [j("xox", "b-", "1234567890-abcdefghij"), "slack"],
    [j("AI", "za", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q"), "google"],
    [j("gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"), "github"],
    [j("AK", "IA", "ABCDEFGHIJKLMNOP"), "aws"],
    [j("https://api.telegram.org/", "bot", "123456789:", "AAH1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"), "telegram"],
    [j("ey", "JhbGciOiJIUzI1NiJ9.", "ey", "JzdWIiOiIxMjMifQ.", "sflKxwRJSMeKKF2QT4fwpM"), "jwt"],
    [j("Bearer ", "a1b2c3d4e5f6a7b8c9d0e1f2"), "bearer"],
    [j("https://x.example/v1?apikey=", "a1b2c3d4e5f6a7b8c9d0"), "query-param"],
    [j('{"api_key": "', "a1b2c3d4e5f6a7b8c9d0", '"}'), "key-value"],
  ];
  for (const [s, kind] of cases) assert.deepEqual(findSecrets(s).map((f) => f.kind), [kind], s.slice(0, 12));
  // Bearer with an OpenAI key is one finding, the specific one
  assert.deepEqual(findSecrets(j("Bearer sk-", "proj-", "A1b2C3d4E5f6G7h8I9j0")).map((f) => f.kind), ["openai"]);
  // placeholders and expressions are not secrets
  assert.deepEqual(findSecrets("Bearer YOUR_TOKEN_GOES_HERE_PLEASE"), []);
  assert.deepEqual(findSecrets(j("sk-", "proj-", "xxxxxxxxxxxxxxxxxxxxxxxx")), []);
  assert.deepEqual(findSecrets("={{ $credentials.apiKey }}"), []);
  assert.deepEqual(findSecrets("=Bearer {{ $json.token_value_from_somewhere }}"), []);
  // a literal secret inside an expression string is still found
  assert.deepEqual(findSecrets(j("=Bearer a1b2c3d4e5f6a7b8c9d0e1f2 {{ $json.x }}")).map((f) => f.kind), ["bearer"]);
});

test("secrets: scan walks parameters, flags named pairs, never returns values", () => {
  const val = ["Basic ", "dXNlcjpwYXNzd29yZDEyMzQ="].join("");
  const found = scanSecrets({ headerParameters: { parameters: [{ name: "Authorization", value: val }, { name: "Accept", value: "application/json-long-value" }] } }, "parameters");
  assert.deepEqual(found, [{ path: "parameters.headerParameters.parameters[0].value", kind: "named-param", redacted: `Basi…${val.length}` }]);
  assert.ok(!JSON.stringify(found).includes("dXNlcjpw"));
});

// ---------- HTTP host rules and the writes question ----------

test("http: host and path read from literal URLs only", () => {
  assert.deepEqual(httpTarget("https://api.openai.com/v1/chat/completions?x=1"), { host: "api.openai.com", path: "/v1/chat/completions" });
  assert.deepEqual(httpTarget("=https://wp.example.com/wp-json/wp/v2/posts/{{ $json.id }}"), { host: "wp.example.com", path: "/wp-json/wp/v2/posts/{x}" });
  assert.deepEqual(httpTarget("https://API.Example.com:8443"), { host: "api.example.com", path: "/" });
  assert.deepEqual(httpTarget("={{ $json.base_url }}/oauth2/token"), { host: null, path: "/oauth2/token" });
  assert.equal(httpTarget("={{ $json.api }}"), null);
  assert.equal(httpTarget("https://{{ $json.host }}/x"), null);
  assert.equal(httpTarget(42), null);
});

test("writes question: one per workflow, answers by node list, bad names rejected", () => {
  const input = loadInput(join(FIXTURES, "writes-answered.json"));
  const rep = (answers) => analyze(input.items, { nodes, capabilities, hosts, answers, now: NOW }).workflows[0];
  const open = rep({});
  assert.equal(open.questions.length, 1);
  assert.deepEqual(open.questions[0].nodes, ["Publish post", "Fetch report"]);
  assert.deepEqual(open.steps.filter((s) => s.effectBy === "assumed").map((s) => s.effect), ["write", "write"]);
  const none = rep({ "writes-answered/writes": "no" });
  assert.deepEqual(none.steps.filter((s) => s.effectBy === "answer").map((s) => s.effect), ["read", "read"]);
  const r = analyze(input.items, { nodes, capabilities, hosts, answers: { "writes-answered/writes": ["Publish post", "Nope"] }, now: NOW });
  assert.equal(r.summary.answers.invalid.length, 1);
  assert.match(r.summary.answers.invalid[0].reason, /Nope/);
  assert.equal(r.workflows[0].questions[0].answer, null);
});

test("catalogue: every connector operation names a tool in capabilities.json", () => {
  // An operation that mappings.json moves to a connector one by one (a node
  // that is http otherwise) must name a tool in that connector's operation
  // table: only operations with a tool are moved. Node-wide connector
  // mappings may leave operations unlisted (they ask for a check). Tool
  // variants use their base type's table.
  const missing = [];
  for (const [type, e] of Object.entries(nodes.nodes)) {
    if (!e.operations || e.mapping === "unmapped") continue;
    const base = e.toolVariantOf ?? type;
    for (const [op, o] of Object.entries(e.operations)) {
      if (o.kind !== "connector" || !o.connector) continue;
      const entry = capabilities.connectors[o.connector]?.operations?.[base]?.ops?.[op];
      if (!entry?.tool) missing.push(`${type} ${op} → ${o.connector}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("dst: zones that move their clocks, zones that do not, unknown names", () => {
  assert.equal(observesDst("Europe/Berlin", NOW), true);
  assert.equal(observesDst("America/New_York", NOW), true);
  assert.equal(observesDst("Australia/Sydney", NOW), true);
  assert.equal(observesDst("Asia/Singapore", NOW), false);
  assert.equal(observesDst("UTC", NOW), false);
  assert.equal(observesDst("Not/AZone", NOW), false);
});

test("operation key: an authentication value that hides the resource leaves the node with none (Discord v2 webhook)", () => {
  // n8n-nodes-base 2.47.5 DiscordV2 versionDescription: `resource` (default channel) is hidden for
  // authentication webhook, where the only operation is sendLegacy (actions/webhook); n8n drops the
  // hidden parameter and the router runs the webhook send. The catalogue keeps that per
  // authentication (nodes.json ops byAuthentication, scripts/gen-nodes.mjs).
  const g = nodes.nodes["n8n-nodes-base.discord"].ops.find((x) => x.versions.includes(2));
  assert.deepEqual(g.byAuthentication, { webhook: { default: "sendLegacy", operations: ["sendLegacy"] } });
  assert.equal(g.authenticationDefault, "botToken");
  assert.ok(!g.resources.message.operations.includes("sendLegacy"), "the webhook operation belongs to no resource");
  const node = (name, parameters) => ({ id: name, name, type: "n8n-nodes-base.discord", typeVersion: 2, position: [0, 0], parameters });
  const wf = {
    id: "discord-auth",
    name: "Discord auth",
    nodes: [
      { id: "t", name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0], parameters: {} },
      node("Webhook send", { authentication: "webhook", content: "hi", options: {} }),
      node("Bot default", { guildId: { __rl: true, value: "1", mode: "id" } }),
      node("Bot message", { resource: "message", operation: "send", content: "hi" }),
    ],
    connections: { Start: { main: [[{ node: "Webhook send", type: "main", index: 0 }, { node: "Bot default", type: "main", index: 0 }, { node: "Bot message", type: "main", index: 0 }]] } },
  };
  const dir = mkdtempSync(join(tmpdir(), "n8m-discord-"));
  writeFileSync(join(dir, "wf.json"), JSON.stringify(wf));
  const steps = Object.fromEntries(analyze(loadInput(join(dir, "wf.json")).items, { nodes, capabilities, hosts, now: NOW }).workflows[0].steps.map((s) => [s.node, s]));
  assert.equal(steps["Webhook send"].resource ?? null, null);
  assert.equal(steps["Webhook send"].operation, "sendLegacy");
  assert.equal(steps["Webhook send"].effect, "write");
  assert.equal(steps["Bot default"].resource, "channel");
  assert.equal(steps["Bot default"].operation, "create");
  assert.equal(steps["Bot message"].resource, "message");
  assert.equal(steps["Bot message"].operation, "send");
});

// The Google token is asked for the steps the converter builds on Google's API, and not for a
// Sheets read it sends through the Drive connector.
test("a Google Sheets read on its own needs no Google token; with a row write under the same credential it does", () => {
  const maps = JSON.parse(readFileSync(join(HERE, "../skills/n8n-to-claude/references/tool-maps.json"), "utf8")).maps["n8n-nodes-base.googleSheets"][">=4"];
  const rest = Object.entries(maps).flatMap(([res, ops]) => Object.entries(ops).filter(([, e]) => e.rest).map(([op, e]) => [`${res}:${op}`, !!e.whenSiblingRest]));
  assert.deepEqual(rest.filter(([, sib]) => !sib).map(([k]) => k).sort(), [...SHEETS_REST_OPS.always].sort(), "the analyzer's list is tool-maps.json's row writes");
  assert.deepEqual(rest.filter(([, sib]) => sib).map(([k]) => k).sort(), [...SHEETS_REST_OPS.withSibling].sort());
  const sheet = (name, operation, cred = "Sheets A", x = 200) => ({ id: name, name, type: "n8n-nodes-base.googleSheets", typeVersion: 4.5, position: [x, 0], parameters: { operation, documentId: { __rl: true, mode: "list", value: "doc1" }, sheetName: { __rl: true, mode: "list", value: "gid=0" }, options: {} }, credentials: { googleSheetsOAuth2Api: { id: "c", name: cred } } });
  const flow = (...steps) => ({ id: "gs1", name: "Sheet flow", nodes: [{ id: "t", name: "Daily", type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.2, position: [0, 0], parameters: { rule: { interval: [{ field: "days" }] } } }, ...steps], connections: Object.fromEntries([["Daily", steps[0].name], ...steps.slice(1).map((st, i) => [steps[i].name, st.name])].map(([a, b]) => [a, { main: [[{ node: b, type: "main", index: 0 }]] }])), settings: { executionOrder: "v1", timezone: "UTC" } });
  const tokens = (wf) => {
    const w = analyze([{ id: wf.id, name: wf.name, wf, file: "x.json" }], { nodes, capabilities, hosts, answers: {}, now: NOW }).workflows[0];
    return [w.outcome.target, w.requires.filter((r) => r.kind === "google-token").flatMap((r) => r.nodes)];
  };
  assert.deepEqual(tokens(flow(sheet("Read rows", "read"))), ["cloud-task", []]);
  assert.deepEqual(tokens(flow(sheet("Read rows", "read"), sheet("Add row", "append", "Sheets A", 400))), ["local-task", ["Read rows", "Add row"]]);
  assert.deepEqual(tokens(flow(sheet("Read rows", "read"), sheet("Add row", "append", "Sheets B", 400))), ["local-task", ["Add row"]], "another credential's token does not serve the read");
  assert.deepEqual(tokens(flow(sheet("Empty it", "clear")))[1], ["Empty it"], "an operation with no connector tool keeps the token");
});
