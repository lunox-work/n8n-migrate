// Expression evaluation: n8n-observed results, the call-site rewriter, globals and errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluateExpression, rewriteExtensions, splitExpression } from "../skills/n8n-migrate/runtime/src/expression.mjs";
import { createScope, enterRun } from "../skills/n8n-migrate/runtime/src/proxy.mjs";
import { executeFilter } from "../skills/n8n-migrate/runtime/src/filter.mjs";
import { seededRandom, UnsupportedExpression, ExpressionError } from "../skills/n8n-migrate/runtime/src/util.mjs";
import { DateTime } from "../skills/n8n-migrate/runtime/vendor/luxon.mjs";
import { wf, node, start, run, out } from "./runtime-helpers.mjs";

const fx = JSON.parse(readFileSync(new URL("./fixtures/runtime/n8n-observed.json", import.meta.url), "utf8"));

function context(item) {
  const items = [{ json: item, pairedItem: { item: 0 } }];
  const runState = {
    definition: { steps: { A: { params: {} }, B: { params: {} } } },
    graph: { connectionIndexes: (a, b) => (b === "A" ? { sourceIndex: 0 } : undefined), ancestors: () => new Set(["A"]) },
    runData: { A: [{ data: { main: [[{ json: item }]] }, source: [] }] },
    clock: { now: Date.parse("2026-11-14T03:00:00Z") },
    timezone: "America/New_York",
    randomFor: () => seededRandom(1),
    console,
    workflow: { id: "1", name: "wf", active: false },
    executionInfo: { id: "e1", mode: "test" },
    vars: {},
    mode: "manual",
  };
  return { run: runState, name: "B", runIndex: 0, step: { n8n: { typeVersion: 1 } }, params: {}, connectionInputData: items, source: { main: [{ previousNode: "A", previousNodeOutput: 0, previousNodeRun: 0 }] } };
}
function encode(v) {
  if (v === undefined) return { type: "undefined" };
  if (DateTime.isDateTime(v)) return { type: "DateTime", value: v.toISO() };
  if (v instanceof Date) return { type: "Date", value: Number.isNaN(v.getTime()) ? null : v.toISOString() };
  if (typeof v === "number" && !Number.isFinite(v)) return { type: "number", value: String(v) };
  return { type: Array.isArray(v) ? "array" : v === null ? "null" : typeof v, value: JSON.parse(JSON.stringify(v)) };
}

test(`expressions match n8n's observed results (${fx.expressions.length} cases)`, () => {
  const exec = context(fx.item);
  const failures = [];
  for (const c of fx.expressions) {
    enterRun(exec.run);
    let got;
    try {
      got = { result: encode(evaluateExpression(c.expr, createScope(exec, 0))) };
    } catch (e) {
      got = { error: e.message };
    }
    const want = c.error !== undefined ? { error: c.error } : { result: c.result.type === "undefined" ? { type: "undefined" } : { type: c.result.type, value: JSON.parse(JSON.stringify(c.result.value ?? null)) } };
    if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${c.expr}\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}`);
  }
  assert.deepEqual(failures, []);
});

test(`filter conditions match n8n's observed results (${fx.filters.length} cases)`, () => {
  enterRun(context({}).run);
  const failures = [];
  for (const c of fx.filters) {
    let got;
    try {
      got = { result: executeFilter(c.value) };
    } catch (e) {
      got = { error: e.message };
    }
    const want = c.error !== undefined ? { error: c.error } : { result: c.result };
    if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${JSON.stringify(c.value)}\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}`);
  }
  assert.deepEqual(failures, []);
});

test("splitExpression follows tournament: escapes, unclosed segments, backslash pairs", () => {
  assert.deepEqual(splitExpression("a {{ b }} c"), [{ type: "text", text: "a " }, { type: "code", text: " b ", hasClosingBrackets: true }, { type: "text", text: " c" }]);
  assert.deepEqual(splitExpression("\\{{ x }}"), [{ type: "text", text: "\\{{ x }}" }]);
  assert.deepEqual(splitExpression("{{ open"), [{ type: "text", text: "" }, { type: "code", text: " open", hasClosingBrackets: false }]);
  assert.deepEqual(splitExpression("a\\\\{{ 1 }}")[0], { type: "text", text: "a\\" });
});

test("rewriter turns extension calls into __ext and leaves native calls alone", () => {
  assert.equal(rewriteExtensions("$json.s.toTitleCase()"), '__ext($json.s, "toTitleCase", [])');
  assert.equal(rewriteExtensions("$json.s.split(',').first()"), "__ext($json.s.split(','), \"first\", [])");
  assert.equal(rewriteExtensions("a.isEmpty() || b?.isEmpty()"), '__ext(a, "isEmpty", []) || __extOpt(b, "isEmpty", [])');
  assert.equal(rewriteExtensions("$('X').item.json.d.toDateTime().plus(1, 'day')"), "__ext(__ext($('X').item.json.d, \"toDateTime\", []), \"plus\", [1, 'day'])");
  assert.equal(rewriteExtensions("new Date().format('yyyy')"), "__ext(new Date(), \"format\", ['yyyy'])");
  assert.equal(rewriteExtensions("x.map(v => v.round(2))"), 'x.map(v => __ext(v, "round", [2]))');
  assert.equal(rewriteExtensions("`${a.toInt()}!`"), '`${__ext(a, "toInt", [])}!`');
  assert.equal(rewriteExtensions("$if(a, b.c, 'd')"), "((a) ? (b.c) : ('d'))");
  assert.equal(rewriteExtensions("s.replace('.first(', 'x')"), "s.replace('.first(', 'x')");
  assert.equal(rewriteExtensions("s.match(/a.first(b)/)"), "s.match(/a.first(b)/)");
  assert.equal(rewriteExtensions("({a: 1}).keys()"), '__ext(({a: 1}), "keys", [])');
});

test("an n8n extension the runtime lacks never passes through silently", () => {
  const exec = context({ s: "x" });
  enterRun(exec.run);
  // isEmpty on a type n8n has no extension for falls back to the generic one, as in n8n.
  assert.equal(evaluateExpression("={{ $json.s.isEmpty() }}", createScope(exec, 0)), false);
  assert.throws(() => evaluateExpression("={{ 'Ωμέγα'.replaceSpecialChars() }}", createScope(exec, 0)), UnsupportedExpression);
  assert.throws(() => evaluateExpression("={{ $fromAI('x') }}", createScope(exec, 0)), UnsupportedExpression);
});

test("$env is blocked like n8n's default; unknown identifiers never reach host globals", () => {
  const exec = context({});
  enterRun(exec.run);
  assert.throws(() => evaluateExpression("={{ $env.HOME }}", createScope(exec, 0)), (e) => e instanceof ExpressionError && /access to env vars denied/.test(e.message));
  assert.equal(evaluateExpression("={{ typeof globalThis.process }}", createScope(exec, 0)), "undefined");
  assert.equal(evaluateExpression("={{ typeof window }}", createScope(exec, 0)), "object");
  assert.equal(evaluateExpression("={{ typeof someHostGlobal }}", createScope(exec, 0)), "undefined");
});

test("$now, Date and Math.random are deterministic per run", async () => {
  const def = wf(
    [start(), node("Set", "set", { assignments: { assignments: [{ name: "now", type: "string", value: "={{ $now.toISO() }}" }, { name: "ms", type: "number", value: "={{ Date.now() }}" }, { name: "r", type: "number", value: "={{ Math.random() }}" }] }, options: {} }, { v: 3.4 })],
    [["Start", "Set"]],
  );
  const a = await run(def, { runId: "r1" });
  const b = await run(def, { runId: "r1" });
  const c = await run(def, { runId: "r2" });
  assert.deepEqual(out(a, "Set"), out(b, "Set"));
  assert.equal(out(a, "Set")[0].now, "2026-11-13T22:00:00.000-05:00");
  assert.equal(out(a, "Set")[0].ms, Date.parse("2026-11-14T03:00:00Z"));
  assert.notEqual(out(a, "Set")[0].r, out(c, "Set")[0].r);
});

test("workflow timezone drives $now and DateTime parsing", async () => {
  const def = wf([start(), node("Set", "set", { assignments: { assignments: [{ name: "local", type: "string", value: "={{ $now.toFormat('yyyy-MM-dd HH:mm ZZ') }}" }, { name: "parsed", type: "string", value: "={{ '2026-01-02 10:00'.toDateTime().toISO() }}" }] }, options: {} }, { v: 3.4 })], [["Start", "Set"]], { settings: { timezone: "Asia/Singapore" } });
  const r = await run(def);
  assert.deepEqual(out(r, "Set")[0], { local: "2026-11-14 11:00 +08:00", parsed: "2026-01-02T10:00:00.000+08:00" });
});

test("$vars, $workflow, $execution and $jmespath", async () => {
  const def = wf(
    [start(), node("Set", "set", { assignments: { assignments: [{ name: "v", type: "string", value: "={{ $vars.region }}" }, { name: "w", type: "string", value: "={{ $workflow.name }}" }, { name: "mode", type: "string", value: "={{ $execution.mode }}" }, { name: "ids", type: "array", value: "={{ $jmespath($input.all(), '[].json.id') }}" }, { name: "f", type: "array", value: "={{ $jmespath({a: [{n: 1, k: 'x'}, {n: 2, k: 'y'}]}, 'a[?n > `1`].k') }}" }] }, options: {} }, { v: 3.4 })],
    [["Start", "Set"]],
    { vars: { region: "eu" }, name: "My flow" },
  );
  const r = await run(def, { trigger: [{ id: 1 }, { id: 2 }], mode: "manual" });
  assert.deepEqual(out(r, "Set")[0], { v: "eu", w: "My flow", mode: "test", ids: [1, 2], f: ["y"] });
});
