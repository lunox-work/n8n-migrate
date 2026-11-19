// The Summarization Chain v2 as n8n 2.47.7 runs it (runtime/src/summarize.mjs): LangChain's
// f-string prompts, JSONLoader, text splitters and the three summarization methods.

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatFString, jsonStrings, splitText, documentsOf, summarizeItem, DEFAULT_PROMPT } from "../skills/n8n-migrate/runtime/src/summarize.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { convertItems, loadReferences } from "../skills/n8n-migrate/scripts/convert.mjs";
import { loadInput } from "../skills/n8n-migrate/scripts/analyze.mjs";
import { run } from "../skills/n8n-migrate/runtime/src/api.mjs";

const refuse = (what) => Object.assign(new Error(`unsupported: ${what}`), { name: "UnsupportedNode" });

test("f-string prompts: {text} filled, doubled braces literal, a stray brace or unknown variable refused", () => {
  assert.equal(formatFString(DEFAULT_PROMPT, { text: "abc" }), 'Write a concise summary of the following:\n\n\n"abc"\n\n\nCONCISE SUMMARY:');
  assert.equal(formatFString("JSON {{a}} and {text}", { text: "t" }), "JSON {a} and t");
  assert.equal(formatFString("no variable here", { text: "t" }), "no variable here");
  assert.throws(() => formatFString("x } y", { text: "t" }), /Single '}'/);
  assert.throws(() => formatFString("{city}", { text: "t" }), /Missing value for input city/);
});

test("JSONLoader with n8n's empty pointer reads every string, and again for each nested object (LangChain's own repetition)", () => {
  assert.deepEqual(jsonStrings({ output: { city: "Milano", n: 5 }, name: "X" }, [""]), ["Milano", "X", "Milano"]);
  assert.deepEqual(jsonStrings({ a: "1", b: ["2", { c: "3" }] }, []), ["1", "2", "3"], "no pointer: each string once");
  assert.deepEqual(jsonStrings({ a: "" }, [""]), [], "empty strings are no documents");
});

test("text splitters as LangChain splits", () => {
  const keep = { kind: "recursive", chunkSize: 1000, chunkOverlap: 200, keepSeparator: true };
  assert.deepEqual(splitText("  a\n\n\n\nb  ", keep, refuse), ["a\n\n\n\nb"], "short text: one chunk, trimmed");
  const words = { kind: "recursive", chunkSize: 9, chunkOverlap: 0, keepSeparator: false };
  assert.deepEqual(splitText("aaaa bbbb cccc", words, refuse), ["aaaa bbbb", "cccc"]);
  assert.deepEqual(splitText("aaaa bbbb cccc", { ...words, chunkOverlap: 4 }, refuse), ["aaaa bbbb", "bbbb cccc"]);
  assert.deepEqual(splitText("p1\n\np2\n\np3", { kind: "character", separator: "\n\n", chunkSize: 5, chunkOverlap: 0 }, refuse), ["p1", "p2", "p3"]);
  assert.deepEqual(splitText("short", { kind: "token", chunkSize: 3000, chunkOverlap: 0 }, refuse), ["short"]);
  assert.throws(() => splitText("x".repeat(40), { kind: "token", chunkSize: 10, chunkOverlap: 0 }, refuse), /unsupported: the Token Splitter/);
  assert.throws(() => splitText("x", { kind: "recursive", chunkSize: 10, chunkOverlap: 10 }, refuse), /chunkOverlap >= chunkSize/);
});

test("documents from an expression: text is one document, an object is read like the item's JSON", () => {
  assert.deepEqual(documentsOf({ jsonMode: "expressionData", jsonData: "={{ $json.t }}", splitter: undefined }, { json: {} }, () => "Hello there", refuse), ["Hello there"]);
  assert.deepEqual(documentsOf({ jsonMode: "expressionData", jsonData: "x", splitter: undefined }, { json: {} }, () => ({ a: "1" }), refuse), ["1"]);
});

test("methods: map-reduce within the limit is one call with the combine prompt; refine walks the documents; long map-reduce is refused", async () => {
  const calls = [];
  const call = async (p) => (calls.push(p), `S${calls.length}`);
  const item = { json: { a: "first", b: "second" } };
  const mr = await summarizeItem({ method: "map_reduce", prompts: {}, docs: { splitter: undefined } }, item, { evaluate: (x) => x, call, refuse });
  assert.deepEqual([mr, calls], [{ text: "S1" }, [formatFString(DEFAULT_PROMPT, { text: "first\n\nsecond" })]]);
  calls.length = 0;
  const rf = await summarizeItem({ method: "refine", prompts: { refinePrompt: "Had {existing_answer}; add {text}" }, docs: { splitter: undefined } }, item, { evaluate: (x) => x, call, refuse });
  assert.deepEqual([rf, calls.at(-1)], [{ output_text: "S2" }, "Had S1; add second"]);
  await assert.rejects(summarizeItem({ method: "map_reduce", prompts: {}, docs: {} }, { json: { a: "x".repeat(4000) } }, { evaluate: (x) => x, call, refuse }), /unsupported: map-reduce over text/);
});

test("convert + run: a v2 chain on the item's JSON with an expression prompt sends n8n's prompt and answers {response: {text}}", async () => {
  const LC = "@n8n/n8n-nodes-langchain.";
  const wf = {
    id: "sum01",
    name: "Summarise",
    nodes: [
      { parameters: {}, name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0] },
      { parameters: { options: { summarizationMethodAndPrompts: { values: { prompt: "=Summarise {{ $json.city }}: {text}" } } } }, name: "Sum", type: LC + "chainSummarization", typeVersion: 2, position: [200, 0] },
      { parameters: { model: "gpt-4o-mini", options: {} }, name: "Model", type: LC + "lmChatOpenAi", typeVersion: 1, position: [200, 200] },
    ],
    connections: { Start: { main: [[{ node: "Sum", type: "main", index: 0 }]] }, Model: { ai_languageModel: [[{ node: "Sum", type: "ai_languageModel", index: 0 }]] } },
    settings: { executionOrder: "v1" },
  };
  const dir = mkdtempSync(join(tmpdir(), "n8m-sum-"));
  writeFileSync(join(dir, "wf.json"), JSON.stringify(wf));
  const loaded = loadInput(join(dir, "wf.json"));
  rmSync(dir, { recursive: true, force: true });
  const def = convertItems(loaded.items, { refs: loadReferences(), now: Date.parse("2026-11-16T00:00:00Z"), forceConvert: true })[0].definition;
  assert.equal(def.steps.Sum.model.summarize.outputKey, "response");
  const asked = [];
  const host = { model: async (p) => (asked.push(p), "A short summary.") };
  const r = await run(def, { clock: { startedAt: "2026-11-16T09:00:00Z" }, virtualTime: true, trigger: { node: "Start", items: [{ json: { city: "Milano", note: "nice" } }] }, host });
  assert.equal(r.status, "done", JSON.stringify(r.error));
  assert.deepEqual([asked.length, asked[0].prompt, asked[0].system, asked[0].messages], [1, "Summarise Milano: Milano\n\nnice", undefined, undefined]);
  assert.deepEqual(r.output, [{ response: { text: "A short summary." } }]);
});
