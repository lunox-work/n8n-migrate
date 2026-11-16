// The XML node v1 (runtime/src/xml.mjs on xml2js 0.6.2, sax 1.2.4, xmlbuilder 11.0.1): the values
// n8n 2.47.7's own XML node gives for the same input (expected values taken from that node class
// run in the n8n image, R5b1 iteration 46).
import { test } from "node:test";
import assert from "node:assert/strict";
import { node, wf, run, out, start } from "./runtime-helpers.mjs";

const xmlRun = async (params, items, settings = {}) => {
  const r = await run(wf([start(), node("XML", "xml", params, { settings })], [["Start", "XML"]]), { trigger: items });
  const e = r.error ?? r.runData?.XML?.[0]?.error;
  return e ? { error: e.message } : { out: out(r, "XML") };
};

test("XML v1 xmlToJson: n8n's parser options, sanitized names, explicit root and arrays", async () => {
  const proto = '<__proto__><constructor a="1" prototype="2">t</constructor></__proto__>';
  assert.deepEqual(await xmlRun({ options: {} }, [{ data: proto }]), { out: [{ sanitized___proto__: { sanitized_constructor: { _: "t", a: "1", sanitized_prototype: "2" } } }] });
  assert.deepEqual(await xmlRun({ options: { attrkey: "@", charkey: "#", mergeAttrs: false } }, [{ data: proto }]), { out: [{ sanitized___proto__: { sanitized_constructor: { "#": "t", "@": { a: "1", sanitized_prototype: "2" } } } }] });
  assert.deepEqual(await xmlRun({ options: {} }, [{ data: '<a b="1"><b>2</b></a>' }]), { out: [{ a: { b: ["1", "2"] } }] });
  assert.deepEqual(await xmlRun({ options: { explicitRoot: false } }, [{ data: "<a>  x  y  </a>" }]), { out: ["  x  y  "] });
  assert.deepEqual(await xmlRun({ options: { normalize: true, trim: true } }, [{ data: "<a>  x  y  </a>" }]), { out: [{ a: "x y" }] });
  const ns = '<?xml version="1.0"?><!DOCTYPE a><a xmlns:x="u"><x:b x:c="1">v</x:b></a>';
  assert.deepEqual(await xmlRun({ options: { explicitArray: true } }, [{ data: ns }]), { out: [{ a: { "xmlns:x": ["u"], "x:b": [{ _: "v", "x:c": ["1"] }] } }] });
  assert.deepEqual(await xmlRun({ options: { ignoreAttrs: true } }, [{ data: ns }]), { out: [{ a: { "x:b": "v" } }] });
});

test("XML v1: errors and continue-on-fail as n8n's node has them", async () => {
  assert.deepEqual(await xmlRun({ options: { attrkey: "__proto__" } }, [{ data: "<a/>" }]), { error: 'The "Attribute Key" option value "__proto__" is not allowed' });
  assert.deepEqual(await xmlRun({ options: {} }, [{ other: 1 }]), { error: 'Item has no JSON property called "data"' });
  assert.deepEqual(await xmlRun({ dataPropertyName: "body", options: {} }, [{ body: 5 }, { body: "<x y='1'/>" }]), { error: "Non-whitespace before first tag.\nLine: 0\nColumn: 1\nChar: 5" });
  // n8n replaces the failed input item and returns only the items that worked.
  assert.deepEqual(await xmlRun({ options: {} }, [{ data: "<a>1</a>" }, { data: "<b" }, { data: "<c/>" }], { onError: "continueRegularOutput" }), { out: [{ a: "1" }, { c: "" }] });
});

test("XML v1 jsonToxml: xmlbuilder's output with the node's options", async () => {
  const items = [{ a: 1 }, { root: { b: [1, 2], $: { x: "y" }, _: "t" } }, { a: { b: "<&>" }, c: null, d: true }];
  const decl = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  assert.deepEqual(await xmlRun({ mode: "jsonToxml", options: {} }, items), { out: [{ data: decl + "<a>1</a>" }, { data: decl + '<root x="y">\n  <b>1</b>\n  <b>2</b>\n  t\n</root>' }, { data: decl + "<root>\n  <a>\n    <b>&lt;&amp;&gt;</b>\n  </a>\n  <c/>\n  <d>true</d>\n</root>" }] });
  assert.deepEqual(await xmlRun({ mode: "jsonToxml", options: { headless: true, cdata: true } }, [items[2]]), { out: [{ data: "<root>\n  <a>\n    <b><![CDATA[<&>]]></b>\n  </a>\n  <c/>\n  <d>true</d>\n</root>" }] });
  assert.deepEqual(await xmlRun({ mode: "jsonToxml", dataPropertyName: "xml", options: { rootName: "x" } }, [{ a: 1 }]), { out: [{ xml: decl + "<x>\n  <a>1</a>\n</x>" }] });
  assert.deepEqual(await xmlRun({ mode: "jsonToxml", options: {} }, [{ "bad name": 1 }]), { error: "Invalid character in name" });
});
