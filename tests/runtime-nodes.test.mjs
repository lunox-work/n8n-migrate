// Node implementations. Expectations are hand-derived from n8n-nodes-base 2.47 behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { wf, node, start, run, out } from "./runtime-helpers.mjs";

const assign = (...list) => ({ assignments: list.map(([name, type, value]) => ({ id: name, name, type, value })) });
const cond = (leftValue, operation, rightValue, type = "string", extra = {}) => ({ leftValue, rightValue, operator: { type, operation, ...extra } });
const filter = (conditions, options = {}, combinator = "and") => ({ options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 2, ...options }, conditions, combinator });
const chain = (...names) => names.slice(1).map((n, i) => [names[i], n]);

// ---------- Set ----------

test("Set 3.4: typed assignments, only new fields by default, dot notation", async () => {
  const def = wf([start(), node("Set", "set", { assignments: assign(["name", "string", "={{ $json.first }} {{ $json.last }}"], ["n", "number", "={{ $json.age }}"], ["ok", "boolean", "true"], ["tags", "array", "[\"a\",\"b\"]"], ["meta.source", "string", "web"], ["obj", "object", "={{ {x: 1} }}"]), options: {} }, { v: 3.4 })], chain("Start", "Set"));
  const r = await run(def, { trigger: [{ first: "Ada", last: "L", age: "36" }] });
  assert.deepEqual(out(r, "Set"), [{ name: "Ada L", n: 36, ok: true, tags: ["a", "b"], meta: { source: "web" }, obj: { x: 1 } }]);
  assert.deepEqual(r.runData.Set[0].data.main[0][0].pairedItem, { item: 0 });
});

test("Set 3.4: include other fields (all / selected / except) and dotNotation off", async () => {
  const mk = (extra) => wf([start(), node("Set", "set", { assignments: assign(["c.d", "number", "3"]), includeOtherFields: true, options: {}, ...extra }, { v: 3.4 })], chain("Start", "Set"));
  const input = [{ a: 1, b: { x: 2, y: 3 } }];
  assert.deepEqual(out(await run(mk({}), { trigger: input }), "Set"), [{ a: 1, b: { x: 2, y: 3 }, c: { d: 3 } }]);
  assert.deepEqual(out(await run(mk({ include: "selected", includeFields: "a, b.x" }), { trigger: input }), "Set"), [{ a: 1, x: 2, c: { d: 3 } }]);
  assert.deepEqual(out(await run(mk({ include: "except", excludeFields: "b.y" }), { trigger: input }), "Set"), [{ a: 1, b: { x: 2 }, c: { d: 3 } }]);
  assert.deepEqual(out(await run(mk({ options: { dotNotation: false } }), { trigger: input }), "Set"), [{ a: 1, b: { x: 2, y: 3 }, "c.d": 3 }]);
});

test("Set 3.4: conversion errors fail the node unless ignored; null stays null", async () => {
  const bad = wf([start(), node("Set", "set", { assignments: assign(["n", "number", "abc"]), options: {} }, { v: 3.4 })], chain("Start", "Set"));
  const r = await run(bad);
  assert.equal(r.status, "failed");
  assert.equal(r.error.message, "'n' expects a number but we got 'abc' [item 0]");
  const ok = wf([start(), node("Set", "set", { assignments: assign(["n", "number", "abc"], ["z", "string", "={{ $json.missing }}"]), options: { ignoreConversionErrors: true } }, { v: 3.4 })], chain("Start", "Set"));
  assert.deepEqual(out(await run(ok), "Set"), [{ n: "abc", z: null }]);
  const cof = wf([start(), node("Set", "set", { assignments: assign(["n", "number", "abc"]), options: {} }, { v: 3.4, settings: { onError: "continueRegularOutput" } })], chain("Start", "Set"));
  assert.deepEqual(out(await run(cof), "Set"), [{ error: "'n' expects a number but we got 'abc' [item 0]" }]);
});

test("Set 3.0-3.2: fields.values keep all input fields by default", async () => {
  const def = wf([start(), node("Set", "set", { fields: { values: [{ name: "x", stringValue: "={{ $json.a }}!" }, { name: "n", type: "numberValue", numberValue: "={{ 5 }}" }, { name: "o", type: "objectValue", objectValue: '={"k": {{ $json.a }} }' }] }, options: {} }, { v: 3 })], chain("Start", "Set"));
  assert.deepEqual(out(await run(def, { trigger: [{ a: 1 }] }), "Set"), [{ a: 1, x: "1!", n: 5, o: { k: 1 } }]);
});

test("Set raw JSON mode resolves {{ }} inside the JSON text", async () => {
  const def = wf([start(), node("Set", "set", { mode: "raw", jsonOutput: '={\n  "id": {{ $json.id }},\n  "tags": {{ $json.tags }},\n  "name": "{{ $json.name }}"\n}', options: {} }, { v: 3.4 })], chain("Start", "Set"));
  assert.deepEqual(out(await run(def, { trigger: [{ id: 7, tags: ["a"], name: "x" }] }), "Set"), [{ id: 7, tags: ["a"], name: "x" }]);
});

test("Set v1/v2: values by type, keepOnlySet, v2 converts numeric strings", async () => {
  const p = { keepOnlySet: false, values: { string: [{ name: "s", value: "={{ $json.a }}" }], number: [{ name: "n", value: "={{ '42' }}" }], boolean: [{ name: "b", value: true }] }, options: {} };
  assert.deepEqual(out(await run(wf([start(), node("Set", "set", p, { v: 2 })], chain("Start", "Set")), { trigger: [{ a: "x" }] }), "Set"), [{ a: "x", b: true, n: 42, s: "x" }]);
  assert.deepEqual(out(await run(wf([start(), node("Set", "set", { ...p, keepOnlySet: true }, { v: 1 })], chain("Start", "Set")), { trigger: [{ a: "x" }] }), "Set"), [{ b: true, n: "42", s: "x" }]);
});

// ---------- If / Filter / Switch ----------

test("If 2.2 routes items; loose validation converts; strict mismatch fails", async () => {
  const mk = (conditions, options, settings) => wf([start(), node("If", "if", { conditions: filter(conditions, options), options: {} }, { v: 2.2, settings })], chain("Start", "If"));
  const r = await run(mk([cond("={{ $json.n }}", "gt", 2, "number")]), { trigger: [{ n: 1 }, { n: 3 }, { n: 5 }] });
  assert.deepEqual(out(r, "If", 0), [{ n: 3 }, { n: 5 }]);
  assert.deepEqual(out(r, "If", 1), [{ n: 1 }]);
  assert.deepEqual(r.runData.If[0].data.main[0].map((i) => i.pairedItem), [{ item: 1 }, { item: 2 }]);
  const loose = await run(mk([cond("={{ $json.n }}", "equals", "3", "number")], { typeValidation: "loose" }), { trigger: [{ n: "3" }] });
  assert.deepEqual(out(loose, "If", 0), [{ n: "3" }]);
  const strict = await run(mk([cond("={{ $json.n }}", "equals", 3, "number")]), { trigger: [{ n: "3" }] });
  assert.equal(strict.status, "failed");
  assert.match(strict.error.message, /^Wrong type: '3' is a string but was expecting a number \[condition 0, item 0\]/);
  const cof = await run(mk([cond("={{ $json.n }}", "equals", 3, "number")], {}, { onError: "continueRegularOutput" }), { trigger: [{ n: "3" }] });
  assert.deepEqual(out(cof, "If", 1), [{ n: "3" }]);
});

test("If v1 legacy conditions with combineOperation any/all", async () => {
  const p = (combineOperation) => ({ conditions: { string: [{ value1: "={{ $json.s }}", operation: "contains", value2: "ell" }], number: [{ value1: "={{ $json.n }}", operation: "larger", value2: 10 }] }, combineOperation });
  const t = [{ s: "hello", n: 1 }, { s: "x", n: 20 }, { s: "bell", n: 30 }];
  const all = await run(wf([start(), node("If", "if", p("all"))], chain("Start", "If")), { trigger: t });
  assert.deepEqual(out(all, "If", 0), [{ s: "bell", n: 30 }]);
  const any = await run(wf([start(), node("If", "if", p("any"))], chain("Start", "If")), { trigger: t });
  assert.deepEqual(out(any, "If", 0).length, 3);
});

test("Filter 2.2 keeps matching items and drops the rest from output 0", async () => {
  const def = wf([start(), node("Filter", "filter", { conditions: filter([cond("={{ $json.tag }}", "equals", "VIP")], { caseSensitive: false }), options: {} }, { v: 2.2 })], chain("Start", "Filter"));
  const r = await run(def, { trigger: [{ tag: "vip" }, { tag: "std" }] });
  assert.deepEqual(out(r, "Filter"), [{ tag: "vip" }]);
});

test("Switch 3.2 rules: first match, all matching, fallback extra, expression mode", async () => {
  const rules = { values: [{ conditions: filter([cond("={{ $json.p }}", "equals", "high")]) }, { conditions: filter([cond("={{ $json.p }}", "startsWith", "h")]) }] };
  const t = [{ p: "high" }, { p: "hi" }, { p: "low" }];
  const first = await run(wf([start(), node("Sw", "switch", { rules, options: { fallbackOutput: "extra" } }, { v: 3.2 })], chain("Start", "Sw")), { trigger: t });
  assert.deepEqual([0, 1, 2].map((o) => out(first, "Sw", o)), [[{ p: "high" }], [{ p: "hi" }], [{ p: "low" }]]);
  const all = await run(wf([start(), node("Sw", "switch", { rules, options: { allMatchingOutputs: true } }, { v: 3.2 })], chain("Start", "Sw")), { trigger: t });
  assert.deepEqual([0, 1].map((o) => out(all, "Sw", o)), [[{ p: "high" }], [{ p: "high" }, { p: "hi" }]]);
  const expr = await run(wf([start(), node("Sw", "switch", { mode: "expression", numberOutputs: 3, output: "={{ $json.p.length - 2 }}" }, { v: 3.2 })], chain("Start", "Sw")), { trigger: t });
  assert.deepEqual([0, 1, 2].map((o) => out(expr, "Sw", o)), [[{ p: "hi" }], [{ p: "low" }], [{ p: "high" }]]);
});

test("Switch v1 and v2 legacy rules with fallback", async () => {
  const v1 = await run(wf([start(), node("Sw", "switch", { dataType: "string", value1: "={{ $json.k }}", rules: { rules: [{ operation: "equal", value2: "a", output: 2 }] }, fallbackOutput: 3 }, { v: 1 })], chain("Start", "Sw")), { trigger: [{ k: "a" }, { k: "b" }] });
  assert.deepEqual([out(v1, "Sw", 2), out(v1, "Sw", 3)], [[{ k: "a" }], [{ k: "b" }]]);
  const v2 = await run(wf([start(), node("Sw", "switch", { dataType: "number", value1: "={{ $json.n }}", rules: { rules: [{ operation: "larger", value2: 5 }, { operation: "smaller", value2: 5 }] } }, { v: 2 })], chain("Start", "Sw")), { trigger: [{ n: 9 }, { n: 1 }, { n: 5 }] });
  assert.deepEqual([out(v2, "Sw", 0), out(v2, "Sw", 1)], [[{ n: 9 }], [{ n: 1 }]]);
});

// ---------- Merge ----------

function mergeFlow(params, v = 3, a = [{ id: 1, a: "x" }, { id: 2, a: "y" }], b = [{ id: 2, b: "q" }, { id: 3, b: "r" }]) {
  return wf(
    [start(), node("A", "code", { jsCode: `return ${JSON.stringify(a)}` }, { v: 2, pos: [200, 0] }), node("B", "code", { jsCode: `return ${JSON.stringify(b)}` }, { v: 2, pos: [200, 200] }), node("Merge", "merge", params, { v, pos: [400, 100] })],
    [["Start", "A"], ["Start", "B"], ["A", "Merge", 0, 0], ["B", "Merge", 0, 1]],
  );
}

test("Merge 3: append, combine by fields (every join mode), by position, all combinations, choose branch", async () => {
  assert.deepEqual(out(await run(mergeFlow({})), "Merge"), [{ id: 1, a: "x" }, { id: 2, a: "y" }, { id: 2, b: "q" }, { id: 3, b: "r" }]);
  const by = (joinMode, extra = {}) => mergeFlow({ mode: "combine", combineBy: "combineByFields", fieldsToMatchString: "id", joinMode, ...extra });
  assert.deepEqual(out(await run(by("keepMatches")), "Merge"), [{ id: 2, a: "y", b: "q" }]);
  assert.deepEqual(out(await run(by("keepMatches", { outputDataFrom: "input1" })), "Merge"), [{ id: 2, a: "y" }]);
  assert.deepEqual(out(await run(by("enrichInput1")), "Merge"), [{ id: 2, a: "y", b: "q" }, { id: 1, a: "x" }]);
  assert.deepEqual(out(await run(by("enrichInput2")), "Merge"), [{ id: 2, b: "q", a: "y" }, { id: 3, b: "r" }]);
  assert.deepEqual(out(await run(by("keepNonMatches")), "Merge"), [{ id: 1, a: "x", _source: "input1" }, { id: 3, b: "r", _source: "input2" }]);
  assert.deepEqual(out(await run(by("keepEverything")), "Merge"), [{ id: 2, a: "y", b: "q" }, { id: 1, a: "x" }, { id: 3, b: "r" }]);
  const pos = await run(mergeFlow({ mode: "combine", combineBy: "combineByPosition" }));
  assert.deepEqual(out(pos, "Merge"), [{ id: 2, a: "x", b: "q" }, { id: 3, a: "y", b: "r" }]);
  // n8n lists the preferred (last) input twice in pairedItem; mirrored.
  assert.deepEqual(pos.runData.Merge[0].data.main[0][0].pairedItem, [{ item: 0 }, { item: 0, input: 1 }, { item: 0, input: 1 }]);
  assert.equal(out(await run(mergeFlow({ mode: "combine", combineBy: "combineAll" })), "Merge").length, 4);
  assert.deepEqual(out(await run(mergeFlow({ mode: "chooseBranch", useDataOfInput: 2 })), "Merge"), [{ id: 2, b: "q" }, { id: 3, b: "r" }]);
  const sql = await run(mergeFlow({ mode: "combineBySql" }));
  assert.equal(sql.status, "failed");
  assert.match(sql.error.message, /SQL query mode is not supported/);
});

test("Merge 3.1 fuzzy compare treats '2' and 2 as equal; clash handling addSuffix", async () => {
  const r = await run(mergeFlow({ mode: "combine", combineBy: "combineByFields", fieldsToMatchString: "id", joinMode: "keepMatches", options: { fuzzyCompare: true, clashHandling: { values: { resolveClash: "addSuffix" } } } }, 3.1, [{ id: "2", v: 1 }], [{ id: 2, v: 2 }]));
  assert.deepEqual(out(r, "Merge"), [{ id_1: "2", v_1: 1, id_2: 2, v_2: 2 }]);
});

test("Merge v2 append, mergeByFields and multiplex", async () => {
  assert.equal(out(await run(mergeFlow({ mode: "append" }, 2)), "Merge").length, 4);
  assert.deepEqual(out(await run(mergeFlow({ mode: "combine", combinationMode: "mergeByFields", mergeByFields: { values: [{ field1: "id", field2: "id" }] }, joinMode: "keepMatches" }, 2.1)), "Merge"), [{ id: 2, a: "y", b: "q" }]);
  assert.equal(out(await run(mergeFlow({ mode: "combine", combinationMode: "multiplex" }, 2)), "Merge").length, 4);
});

// ---------- Code ----------

test("Code all items: $input.all(), items, plain objects wrapped, pairing by count", async () => {
  const def = wf([start(), node("Code", "code", { jsCode: "const out = [];\nfor (const it of $input.all()) out.push({ v: it.json.n * 10, same: items.length });\nreturn out;" }, { v: 2 })], chain("Start", "Code"));
  const r = await run(def, { trigger: [{ n: 1 }, { n: 2 }] });
  assert.deepEqual(out(r, "Code"), [{ v: 10, same: 2 }, { v: 20, same: 2 }]);
  assert.deepEqual(r.runData.Code[0].data.main[0].map((i) => i.pairedItem), [{ item: 0 }, { item: 1 }]);
});

test("Code result normalisation and errors mirror n8n", async () => {
  const code = async (jsCode, mode = "runOnceForAllItems", settings) => run(wf([start(), node("Code", "code", { jsCode, mode }, { v: 2, settings })], chain("Start", "Code")), { trigger: [{ a: 1 }, { a: 2 }] });
  assert.deepEqual(out(await code("return {single: true}"), "Code"), [{ single: true }]);
  assert.deepEqual(out(await code("return null"), "Code"), []);
  assert.equal((await code("return 'x'")).error.message, "Code doesn't return items properly");
  assert.equal((await code("const x = 1")).error.message, "Code doesn't return items properly");
  // An error about one item ends in " [item N]" (n8n's Code ValidationError, observed).
  assert.equal((await code("return [{json: {a: 1}}, {b: 2}]")).error.message, "Unknown top-level item key: b [item 1]");
  assert.equal((await code("return [{json: 1}]")).error.message, "A 'json' property isn't an object [item 0]");
  // n8n's task runner adds the line in the user's code (observed from n8n 2.47.7).
  assert.equal((await code("throw new Error('boom')")).error.message, "boom [line 1]");
  assert.deepEqual(out(await code("const a = 1;\nthrow new Error('boom')", "runOnceForAllItems", { onError: "continueRegularOutput" }), "Code"), [{ error: "boom [line 2]" }]);
});

test("Code each item: $json, item, null/undefined drop the item, arrays are refused", async () => {
  const code = (jsCode) => run(wf([start(), node("Code", "code", { jsCode, mode: "runOnceForEachItem" }, { v: 2 })], chain("Start", "Code")), { trigger: [{ a: 1 }, { a: 2 }, { a: 3 }] });
  const r = await code("if ($json.a === 2) return null;\nreturn { b: $json.a + item.json.a, i: $itemIndex };");
  assert.deepEqual(out(r, "Code"), [{ b: 2, i: 0 }, { b: 6, i: 2 }]);
  assert.deepEqual(r.runData.Code[0].data.main[0].map((i) => i.pairedItem), [{ item: 0 }, { item: 2 }]);
  // n8n's task runner wraps the array as the item's json before validating it.
  assert.equal((await code("return [$json]")).error.message, "A 'json' property isn't an object [item 0]");
});

test("Code works on copies: mutating input does not change upstream run data", async () => {
  const def = wf([start(), node("Set", "set", { assignments: assign(["x", "number", "1"]), options: {} }, { v: 3.4 }), node("Code", "code", { jsCode: "for (const it of items) it.json.x = 99;\n$('Set').first().json.x = 98;\nreturn items;" }, { v: 2 })], chain("Start", "Set", "Code"));
  const r = await run(def);
  assert.deepEqual(out(r, "Set"), [{ x: 1 }]);
  assert.deepEqual(out(r, "Code"), [{ x: 99 }]);
});

test("Code: Python, require and workflow static data are refused, not guessed", async () => {
  const py = await run(wf([start(), node("Code", "code", { language: "python", pythonCode: "return items" }, { v: 2 })], chain("Start", "Code")));
  assert.equal(py.status, "failed");
  assert.match(py.error.message, /Python Code nodes need translation/);
  const req = await run(wf([start(), node("Code", "code", { jsCode: "const x = require('lodash'); return items" }, { v: 2 })], chain("Start", "Code")));
  assert.match(req.error.message, /require\("lodash"\) is not supported/);
});

test("Function and Function Item (legacy Code)", async () => {
  const f = await run(wf([start(), node("F", "function", { functionCode: "return items.map(i => ({json: {d: i.json.a * 2}}));" })], chain("Start", "F")), { trigger: [{ a: 2 }] });
  assert.deepEqual(out(f, "F"), [{ d: 4 }]);
  const fi = await run(wf([start(), node("F", "functionItem", { functionCode: "item.b = item.a + 1;\nreturn item;" })], chain("Start", "F")), { trigger: [{ a: 2 }] });
  assert.deepEqual(out(fi, "F"), [{ a: 2, b: 3 }]);
});

// ---------- item shaping ----------

test("Split Out: no other fields, all other fields, objects in arrays", async () => {
  const mk = (params) => wf([start(), node("S", "splitOut", params)], chain("Start", "S"));
  const t = [{ id: 1, list: [{ k: "a" }, { k: "b" }], tags: ["x", "y"] }];
  assert.deepEqual(out(await run(mk({ fieldToSplitOut: "list" }), { trigger: t }), "S"), [{ k: "a" }, { k: "b" }]);
  assert.deepEqual(out(await run(mk({ fieldToSplitOut: "tags", include: "allOtherFields" }), { trigger: t }), "S"), [{ id: 1, list: [{ k: "a" }, { k: "b" }], tags: "x" }, { id: 1, list: [{ k: "a" }, { k: "b" }], tags: "y" }]);
  assert.deepEqual(out(await run(mk({ fieldToSplitOut: "tags", include: "selectedOtherFields", fieldsToInclude: "id", options: { destinationFieldName: "tag" } }), { trigger: t }), "S"), [{ tag: "x", id: 1 }, { tag: "y", id: 1 }]);
});

test("Aggregate: individual fields (rename, merge lists) and all item data", async () => {
  const t = [{ n: 1, l: [1, 2] }, { n: 2, l: [3] }, { x: 1 }];
  const ind = await run(wf([start(), node("A", "aggregate", { fieldsToAggregate: { fieldToAggregate: [{ fieldToAggregate: "n" }, { fieldToAggregate: "l", renameField: true, outputFieldName: "all" }] }, options: { mergeLists: true } })], chain("Start", "A")), { trigger: t });
  assert.deepEqual(out(ind, "A"), [{ n: [1, 2], all: [1, 2, 3] }]);
  assert.deepEqual(ind.runData.A[0].data.main[0][0].pairedItem, [{ item: 0 }, { item: 1 }, { item: 2 }]);
  const all = await run(wf([start(), node("A", "aggregate", { aggregate: "aggregateAllItemData", destinationFieldName: "rows", include: "specifiedFields", fieldsToInclude: "n" })], chain("Start", "A")), { trigger: t });
  assert.deepEqual(out(all, "A"), [{ rows: [{ n: 1 }, { n: 2 }] }]);
});

test("Limit keeps first or last items", async () => {
  const t = [{ i: 1 }, { i: 2 }, { i: 3 }];
  assert.deepEqual(out(await run(wf([start(), node("L", "limit", { maxItems: 2 })], chain("Start", "L")), { trigger: t }), "L"), [{ i: 1 }, { i: 2 }]);
  assert.deepEqual(out(await run(wf([start(), node("L", "limit", { maxItems: 2, keep: "lastItems" })], chain("Start", "L")), { trigger: t }), "L"), [{ i: 2 }, { i: 3 }]);
});

test("Loop Over Items (SplitInBatches v3): batches through the loop, then done with everything", async () => {
  const def = wf(
    [start(), node("Loop", "splitInBatches", { batchSize: 2, options: {} }, { v: 3, pos: [200, 0] }), node("Work", "set", { assignments: assign(["seen", "string", "={{ $json.i }}-{{ $runIndex }}"]), includeOtherFields: true, options: {} }, { v: 3.4, pos: [400, 100] }), node("After", "noOp", {}, { pos: [400, -100] })],
    [["Start", "Loop"], ["Loop", "After", 0], ["Loop", "Work", 1], ["Work", "Loop"]],
  );
  const r = await run(def, { trigger: [{ i: 1 }, { i: 2 }, { i: 3 }] });
  assert.equal(r.status, "done");
  assert.equal(r.runData.Loop.length, 3);
  assert.deepEqual(r.runData.Work.map((t) => t.data.main[0].map((x) => x.json.seen)), [["1-0", "2-0"], ["3-1"]]);
  assert.deepEqual(out(r, "After"), [{ i: 1, seen: "1-0" }, { i: 2, seen: "2-0" }, { i: 3, seen: "3-1" }]);
});

test("SplitInBatches v1 with the classic noItemsLeft loop reads the node context", async () => {
  const def = wf(
    [
      start(),
      node("Loop", "splitInBatches", { batchSize: 2 }, { v: 1, pos: [200, 0] }),
      node("Work", "set", { assignments: assign(["b", "number", "={{ $runIndex }}"]), includeOtherFields: true, options: {} }, { v: 3.4, pos: [400, 0] }),
      node("Last?", "if", { conditions: { boolean: [{ value1: '={{ $node["Loop"].context["noItemsLeft"] }}', value2: true }] } }, { pos: [600, 0] }),
      node("Done", "noOp", {}, { pos: [800, -100] }),
    ],
    [["Start", "Loop"], ["Loop", "Work"], ["Work", "Last?"], ["Last?", "Done", 0], ["Last?", "Loop", 1]],
  );
  const r = await run(def, { trigger: [{ i: 1 }, { i: 2 }, { i: 3 }, { i: 4 }, { i: 5 }] });
  assert.equal(r.status, "done");
  assert.equal(r.runData.Work.length, 3);
  assert.deepEqual(out(r, "Done"), [{ i: 5, b: 2 }]);
});

test("Stop and Error fails the run with the message or object", async () => {
  const r = await run(wf([start(), node("Stop", "stopAndError", { errorMessage: "={{ 'bad ' + $json.id }}" })], chain("Start", "Stop")), { trigger: [{ id: 7 }] });
  assert.equal(r.status, "failed");
  assert.equal(r.error.message, "bad 7");
  assert.equal(r.error.node, "Stop");
  const o = await run(wf([start(), node("Stop", "stopAndError", { errorType: "errorObject", errorObject: '{"code": 1, "description": "why"}' })], chain("Start", "Stop")));
  assert.equal(o.error.message, "why");
});

test("Wait: short waits in-process, long waits become a sleep request; the clock advances", async () => {
  const def = (amount, unit) => wf([start(), node("Wait", "wait", { amount, unit }, { v: 1.1 }), node("Set", "set", { assignments: assign(["t", "string", "={{ $now.toISO() }}"]), options: {} }, { v: 3.4 })], chain("Start", "Wait", "Set"));
  const short = await run(def(5, "seconds"));
  assert.equal(short.effects.length, 0);
  assert.equal(out(short, "Set")[0].t, "2026-11-13T22:00:05.000-05:00");
  const slept = [];
  const long = await run(def(2, "hours"), { host: { sleep: async (p) => slept.push(p.until) } });
  assert.deepEqual(slept, ["2026-11-14T05:00:00.000Z"]);
  assert.equal(long.effects[0].kind, "sleep");
  assert.equal(out(long, "Set")[0].t, "2026-11-14T00:00:00.000-05:00");
});

test("Execute Workflow runs a self-referencing sub-workflow and maps items back", async () => {
  const def = wf(
    [
      start(),
      node("Call", "executeWorkflow", { workflowId: { __rl: true, value: "={{ $workflow.id }}", mode: "id" }, options: {} }, { v: 1.2, subflow: { self: true }, pos: [200, 0] }),
      node("Sub start", "executeWorkflowTrigger", { inputSource: "passthrough" }, { v: 1.1, kind: "trigger", pos: [0, 400] }),
      node("Double", "set", { assignments: assign(["d", "number", "={{ $json.n * 2 }}"]), options: {} }, { v: 3.4, pos: [200, 400] }),
    ],
    [["Start", "Call"], ["Sub start", "Double"]],
  );
  const r = await run(def, { trigger: [{ n: 1 }, { n: 4 }] });
  assert.equal(r.status, "done");
  assert.deepEqual(out(r, "Call"), [{ d: 2 }, { d: 8 }]);
  assert.deepEqual(r.runData.Call[0].data.main[0].map((i) => i.pairedItem), [{ item: 0 }, { item: 1 }]);
});

test("Execute Workflow without waiting hands each item on even when its child execution fails", async () => {
  const def = (wait, mode) =>
    wf(
      [
        start(),
        node("Call", "executeWorkflow", { workflowId: { __rl: true, value: "={{ $workflow.id }}", mode: "id" }, mode, options: { waitForSubWorkflow: wait } }, { v: 1.2, subflow: { self: true }, pos: [200, 0] }),
        node("Sub start", "executeWorkflowTrigger", { inputSource: "passthrough" }, { v: 1.1, kind: "trigger", pos: [0, 400] }),
        node("Boom", "code", { jsCode: "if ($input.all().some((i) => i.json.n === 4)) throw new Error('bad item'); return $input.all();" }, { v: 2, pos: [200, 400] }),
      ],
      [["Start", "Call"], ["Sub start", "Boom"]],
    );
  for (const mode of ["each", "once"]) {
    const r = await run(def(false, mode), { trigger: [{ n: 1 }, { n: 4 }] });
    assert.equal(r.status, "done", `${mode}: ${JSON.stringify(r.error)}`);
    assert.deepEqual(out(r, "Call"), [{ n: 1 }, { n: 4 }]);
  }
  const waited = await run(def(true, "each"), { trigger: [{ n: 1 }, { n: 4 }] });
  assert.equal(waited.status, "failed");
  assert.match(waited.error.message, /Error executing workflow with item at index 1/);
});

test("Schedule Trigger emits n8n's timestamp item from the run clock", async () => {
  const def = wf([node("Every day", "scheduleTrigger", { rule: { interval: [{}] } }, { v: 1.2, kind: "trigger" })]);
  const r = await run(def, { clock: { startedAt: "2026-11-14T13:05:09Z" } });
  assert.deepEqual(out(r, "Every day")[0], {
    timestamp: "2026-11-14T08:05:09.000-05:00",
    "Readable date": "November 14th 2026, 8:05:09 am",
    "Readable time": "8:05:09 am",
    "Day of week": "Saturday",
    Year: "2026",
    Month: "November",
    "Day of month": "14",
    Hour: "08",
    Minute: "05",
    Second: "09",
    Timezone: "America/New_York (UTC-05:00)",
  });
});

// ---------- group 2 ----------

test("Sort simple (case-insensitive strings, multi-field) and Remove Duplicates", async () => {
  const t = [{ n: "b", v: 2 }, { n: "A", v: 1 }, { n: "a", v: 3 }];
  const s = await run(wf([start(), node("Sort", "sort", { sortFieldsUi: { sortField: [{ fieldName: "n" }, { fieldName: "v", order: "descending" }] } })], chain("Start", "Sort")), { trigger: t });
  assert.deepEqual(out(s, "Sort"), [{ n: "a", v: 3 }, { n: "A", v: 1 }, { n: "b", v: 2 }]);
  const d = await run(wf([start(), node("D", "removeDuplicates", { compare: "selectedFields", fieldsToCompare: "k" }, { v: 1.1 })], chain("Start", "D")), { trigger: [{ k: 1, x: "a" }, { k: 2 }, { k: 1, x: "b" }] });
  assert.deepEqual(out(d, "D"), [{ k: 1, x: "a" }, { k: 2 }]);
});

test("Summarize: split by a field, several aggregations", async () => {
  const def = wf([start(), node("Sum", "summarize", { fieldsToSummarize: { values: [{ aggregation: "sum", field: "amount" }, { aggregation: "count", field: "id" }, { aggregation: "append", field: "id" }] }, fieldsToSplitBy: "team" })], chain("Start", "Sum"));
  const r = await run(def, { trigger: [{ team: "a", id: 1, amount: 5 }, { team: "b", id: 2, amount: 1 }, { team: "a", id: 3, amount: 2 }] });
  assert.deepEqual(out(r, "Sum"), [{ sum_amount: 7, count_id: 2, appended_id: [1, 3], team: "a" }, { sum_amount: 1, count_id: 1, appended_id: [2], team: "b" }]);
  assert.deepEqual(r.runData.Sum[0].data.main[0][0].pairedItem, [{ item: 0 }, { item: 2 }]);
});

test("Date & Time v2: add, format, difference, extract", async () => {
  const p = (operation, extra) => wf([start(), node("D", "dateTime", { operation, ...extra }, { v: 2 })], chain("Start", "D"));
  assert.deepEqual(out(await run(p("addToDate", { magnitude: "2026-01-31T10:00:00Z", timeUnit: "months", duration: 1 })), "D"), [{ newDate: "2026-02-28T05:00:00.000-05:00" }]);
  assert.deepEqual(out(await run(p("formatDate", { date: "2026-03-04T05:06:07Z", format: "custom", customFormat: "yyyy/MM/dd HH:mm" })), "D"), [{ formattedDate: "2026/03/04 05:06" }]);
  assert.deepEqual(out(await run(p("getTimeBetweenDates", { startDate: "2026-01-01", endDate: "2026-01-03T12:00:00Z", units: ["day", "hour"] })), "D"), [{ timeDifference: { days: 2, hours: 12 } }]);
  assert.deepEqual(out(await run(p("extractDate", { date: "2026-03-04T05:06:07Z", part: "month" })), "D"), [{ datePart: 3 }]);
});

test("Crypto hash and hmac; Respond to Webhook records the response", async () => {
  const c = await run(wf([start(), node("C", "crypto", { action: "hmac", type: "SHA256", value: "={{ $json.m }}", secret: "k", dataPropertyName: "sig" })], chain("Start", "C")), { trigger: [{ m: "hello" }] });
  assert.deepEqual(out(c, "C"), [{ m: "hello", sig: "406e4b43f87095aa86ca6299d25e875921fefa180f02043bb29bec5681c0c2d0" }]);
  const w = await run(wf([node("Hook", "webhook", {}, { v: 2, kind: "trigger" }), node("Reply", "respondToWebhook", { respondWith: "json", responseBody: '={"ok": true, "id": {{ $json.body.id }} }', options: { responseCode: 201 } }, { v: 1.1 })], chain("Hook", "Reply")), { trigger: [{ body: { id: 5 } }] });
  assert.deepEqual(w.response, { body: { ok: true, id: 5 }, headers: {}, statusCode: 201 });
  assert.deepEqual(out(w, "Reply"), [{ body: { id: 5 } }]);
});

test("Item Lists aliases to Split Out", async () => {
  const r = await run(wf([start(), node("IL", "itemLists", { operation: "splitOutItems", fieldToSplitOut: "l" }, { v: 3.1 })], chain("Start", "IL")), { trigger: [{ l: [1, 2] }] });
  assert.deepEqual(out(r, "IL"), [{ l: 1 }, { l: 2 }]);
});

// ---------- request steps ----------

test("HTTP Request 4.2 builds the request from parameters and splits JSON arrays", async () => {
  const seen = [];
  const def = wf(
    [start(), node("Get", "httpRequest", { method: "POST", url: "=https://api.example.com/v1/items/{{ $json.id }}", sendQuery: true, queryParameters: { parameters: [{ name: "q", value: "={{ $json.q }}" }] }, sendHeaders: true, headerParameters: { parameters: [{ name: "X-Trace", value: "t" }] }, sendBody: true, specifyBody: "json", jsonBody: '={"n": {{ $json.id }} }', authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth", options: {} }, { v: 4.2, auth: { credentialType: "httpHeaderAuth", secret: "API key" } })],
    chain("Start", "Get"),
    { allow: { tools: [], http: [{ method: "POST", host: "api.example.com", pathPrefix: "/v1/" }] }, secrets: [{ name: "API key", credentialType: "httpHeaderAuth", hosts: ["api.example.com"] }] },
  );
  const r = await run(def, { trigger: [{ id: 3, q: "x" }], host: { http: async (req, meta) => (seen.push({ req, meta }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" }, body: '[{"a":1},{"a":2}]' }) } });
  assert.equal(r.status, "done");
  assert.deepEqual(seen[0].req, { method: "POST", url: "https://api.example.com/v1/items/3", headers: { "x-trace": "t", accept: "application/json,text/html,application/xhtml+xml,application/xml,text/*;q=0.9, image/*;q=0.8, */*;q=0.7" }, query: { q: "x" }, body: { n: 3 }, contentType: "json", auth: { credentialType: "httpHeaderAuth", secret: "API key" }, step: "Get" });
  assert.equal(seen[0].meta.id, "Get#0#0");
  assert.match(seen[0].meta.effectKey, /^[0-9a-f]{32}$/);
  assert.deepEqual(out(r, "Get"), [{ a: 1 }, { a: 2 }]);
});

test("HTTP Request multipart: text fields as given, file parts from the item's binary, duplicates as a list from 4.2", async () => {
  const seen = [];
  const params = (v) => ({ method: "POST", url: "https://up.example.com/v1/files", sendBody: true, contentType: "multipart-form-data", bodyParameters: { parameters: [{ name: "purpose", value: "ocr" }, { name: "line", value: "={{ $json.n }}" }, { parameterType: "formBinaryData", name: "file", inputDataFieldName: "data" }, { parameterType: "formBinaryData", name: "skipped", inputDataFieldName: "" }, { name: "tag", value: "a" }, { name: "tag", value: "b" }] }, options: {} });
  const mk = (v) => wf([start(), node("Up", "httpRequest", params(v), { v })], chain("Start", "Up"), { allow: { tools: [], http: [{ method: "POST", host: "up.example.com", pathPrefix: "/v1/" }] } });
  const host = { http: async (req) => (seen.push(req), { status: 200, headers: { "content-type": "application/json" }, body: "{}" }) };
  const binary = { data: { data: Buffer.from("%PDF-1.4 x").toString("base64"), mimeType: "application/pdf", fileName: "doc.pdf" } };
  const r = await run(mk(4.2), { trigger: { node: "Start", items: [{ json: { n: 48 }, binary }] }, host });
  assert.equal(r.status, "done", JSON.stringify(r.error));
  assert.equal(seen[0].contentType, "multipart-form-data");
  assert.deepEqual(seen[0].body, { purpose: "ocr", line: 48, file: { $file: { fileName: "doc.pdf", mimeType: "application/pdf", data: binary.data.data } }, tag: ["a", "b"] });
  await run(mk(4.1), { trigger: { node: "Start", items: [{ json: { n: 1 }, binary }] }, host });
  assert.equal(seen[1].body.tag, "b", "before 4.2 a repeated name keeps the last value");
  const missing = await run(mk(4.2), { trigger: [{ n: 1 }], host });
  assert.equal(missing.status, "failed");
  assert.match(missing.error.message, /binary file 'data', but none was found \[item 0\]/);
});

test("HTTP Request: text, full response, 4xx errors and neverError", async () => {
  const mk = (options, settings) => wf([start(), node("Get", "httpRequest", { url: "https://x.test/a", options }, { v: 4.2, settings })], chain("Start", "Get"), { allow: { http: [{ method: "GET", host: "x.test", pathPrefix: "/" }] } });
  const host = (status, body, ct = "text/plain") => ({ http: async () => ({ status, headers: { "Content-Type": ct }, body }) });
  assert.deepEqual(out(await run(mk({}), { host: host(200, "hi") }), "Get"), [{ data: "hi" }]);
  assert.deepEqual(out(await run(mk({ response: { response: { fullResponse: true } } }), { host: host(200, '{"a":1}', "application/json") }), "Get"), [{ body: { a: 1 }, headers: { "content-type": "application/json" }, statusCode: 200, statusMessage: "OK" }]);
  const nf = await run(mk({}), { host: host(404, "nope") });
  assert.equal(nf.status, "failed");
  assert.equal(nf.error.message, "The resource you are requesting could not be found");
  assert.deepEqual(out(await run(mk({ response: { response: { neverError: true } } }), { host: host(404, "nope") }), "Get"), [{ data: "nope" }]);
  // n8n 2.47.7 puts the AxiosError in the item (observed; its stack is left out here).
  assert.deepEqual(out(await run(mk({}, { onError: "continueRegularOutput" }), { host: host(500, "x") }), "Get"), [{ error: { message: '500 - "x"', name: "AxiosError", code: "ERR_BAD_RESPONSE", status: 500 } }]);
});

test("tool, model and agent steps hand out requests with evaluated arguments", async () => {
  const calls = [];
  const def = wf(
    [
      start(),
      node("Search", "n8n-nodes-base.gmail", {}, { kind: "tool", tool: { connector: "gmail", name: "search_threads", args: { query: "=from:{{ $json.who }}", limit: 5 }, effect: "read" }, pos: [200, 0] }),
      node("Summarise", "@n8n/n8n-nodes-langchain.chainLlm", {}, { kind: "model", model: { prompt: "=Summarise: {{ $json.subject }}", system: "Be brief" }, pos: [400, 0] }),
      node("Agent", "@n8n/n8n-nodes-langchain.agent", {}, { kind: "agent", agent: { prompt: "={{ $json.text }}", tools: [{ name: "send", connector: "gmail", tool: "send_message", effect: "write" }] }, pos: [600, 0] }),
    ],
    chain("Start", "Search", "Summarise", "Agent"),
    { allow: { tools: [{ connector: "gmail", tool: "search_threads" }, { connector: "gmail", tool: "send_message" }], http: [] } },
  );
  const host = {
    tool: async (p) => (calls.push(["tool", p]), [{ subject: "S1" }, { subject: "S2" }]),
    model: async (p) => (calls.push(["model", p]), `sum of ${p.prompt.slice(11)}`),
    agent: async (p) => (calls.push(["agent", p]), "done"),
  };
  const r = await run(def, { trigger: [{ who: "ann@x.test" }], host });
  assert.equal(r.status, "done");
  assert.deepEqual(calls[0], ["tool", { connector: "gmail", tool: "search_threads", args: { query: "from:ann@x.test", limit: 5 }, effect: "read", step: "Search" }]);
  assert.deepEqual(out(r, "Summarise"), [{ text: "sum of S1" }, { text: "sum of S2" }]);
  assert.deepEqual(out(r, "Agent"), [{ output: "done" }, { output: "done" }]);
  assert.deepEqual(r.effects.map((e) => [e.kind, e.effect, !!e.effectKey]), [["tool", "read", false], ["model", "none", false], ["model", "none", false], ["agent", "none", false], ["agent", "none", false]]);
});
