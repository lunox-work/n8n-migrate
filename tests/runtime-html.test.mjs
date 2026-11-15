// HTML extraction (Html extractHtmlContent v1-1.2, HTML Extract v1): the values n8n 2.47.7's
// cheerio 1.1 and html-to-text 9.0.5 give for the same HTML and selectors (expected values taken
// from those libraries in the n8n image), and the parse trees htmldom.mjs builds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { node, wf, run, out, start } from "./runtime-helpers.mjs";
import { parseHtml, parseHtmlLoose, outerHtml, selectAll, parseSelector } from "../skills/n8n-to-claude/runtime/src/htmldom.mjs";
import { htmlToText } from "../skills/n8n-to-claude/runtime/src/htmltext.mjs";

const chain = (...names) => names.slice(1).map((n, i) => [names[i], n]);
const PAGE =
  '<html><head><title>T &mdash; x</title></head><body><nav><a href="/">Home</a></nav><h1>Big <a href="/h">Head</a></h1><p>Para&nbsp;one and a long enough sentence to wrap past the eighty column limit of html-to-text.</p><ul><li>One<li>Two</ul><table><tr><td>c1<td><a href="/x" class="k">c2</a></table><select><option value=1>A<option selected>B</select><input type=checkbox checked></body></html>';
const extract = (values, v = 1.2, extra = {}) => node("Extract", "html", { operation: "extractHtmlContent", extractionValues: { values }, options: {}, ...extra }, { v });

test("Html 1.2 extraction: html-to-text text with skip selectors, inner HTML, attributes, form values", async () => {
  const def = wf(
    [
      start(),
      extract([
        { key: "title", cssSelector: "title" },
        { key: "body", cssSelector: "body", skipSelectors: "nav" },
        { key: "cell", cssSelector: "table td", returnValue: "html" },
        { key: "href", cssSelector: "td:nth-child(2) > a.k", returnValue: "attribute", attribute: "href" },
        { key: "checked", cssSelector: "input", returnValue: "attribute", attribute: "checked" },
        { key: "choice", cssSelector: "select", returnValue: "value" },
        { key: "attrs", cssSelector: "a", returnValue: "attribute", attribute: "", returnArray: true },
        { key: "none", cssSelector: "aside", returnValue: "html" },
      ]),
    ],
    chain("Start", "Extract"),
  );
  const r = await run(def, { trigger: [{ data: PAGE }] });
  assert.deepEqual(out(r, "Extract"), [
    {
      title: "T — x",
      body: "BIG HEAD [/h]\n\nPara\u00a0one and a long enough sentence to wrap past the eighty column limit of\nhtml-to-text.\n\n * One\n * Two\n\nc1c2 [/x]\n\nAB",
      cell: "c1",
      href: "/x",
      checked: "checked",
      choice: "B",
      attrs: [{ href: "/" }, { href: "/h" }, { href: "/x", class: "k" }],
    },
  ]);
});

test("Html 1.1 and HTML Extract 1: cheerio text over every match, options, binary source", async () => {
  const v11 = wf([start(), extract([{ key: "items", cssSelector: "li", returnArray: true }, { key: "p", cssSelector: "p" }, { key: "gone", cssSelector: "aside" }], 1.1, { options: { cleanUpText: true } })], chain("Start", "Extract"));
  const r = await run(v11, { trigger: [{ data: PAGE }] });
  assert.deepEqual(out(r, "Extract"), [{ items: ["One", "Two"], p: "Para one and a long enough sentence to wrap past the eighty column limit of html-to-text." }]);

  const bin = wf(
    [start(), node("Code", "code", { jsCode: "return [{json: {}, binary: {page: {data: Buffer.from(`<h1 id=firstHeading>Ada</h1><aside></aside>`).toString('base64'), mimeType: 'text/html'}}}]" }, { v: 2 }), node("HX", "htmlExtract", { sourceData: "binary", dataPropertyName: "page", extractionValues: { values: [{ key: "t", cssSelector: "#firstHeading" }, { key: "e", cssSelector: "aside" }] }, options: {} })],
    chain("Start", "Code", "HX"),
  );
  assert.deepEqual(out(await run(bin, { trigger: [{}] }), "HX"), [{ t: "Ada", e: "" }]);
});

test("Html extraction: a missing field is n8n's error; a list of HTML strings gives one item each", async () => {
  const def = wf([start(), extract([{ key: "a", cssSelector: "a", returnValue: "attribute", attribute: "href" }], 1.2, { dataPropertyName: "pages" })], chain("Start", "Extract"));
  const r = await run(def, { trigger: [{ pages: ['<a href="1">x</a>', '<a href="2">y</a>'] }] });
  assert.deepEqual(out(r, "Extract"), [{ a: "1" }, { a: "2" }]);
  const bad = await run(def, { trigger: [{ other: "" }] });
  assert.match(bad.error?.message ?? "", /No property named "pages" exists!/);
});

test("htmldom: trees as parse5 (cheerio) and htmlparser2 (html-to-text) build them", () => {
  assert.equal(outerHtml(parseHtml("<p>one<p>two<table><tr><td>c</table>")), "<html><head></head><body><p>one</p><p>two<table><tbody><tr><td>c</td></tr></tbody></table></p></body></html>");
  assert.equal(outerHtml(parseHtml("<!DOCTYPE html><p>one<table><tr><td>c</table>")), "<!DOCTYPE html><html><head></head><body><p>one</p><table><tbody><tr><td>c</td></tr></tbody></table></body></html>");
  assert.equal(outerHtml(parseHtmlLoose("<p>a<div>b</div><td>c</td></br>")), "<p>a</p><div>b</div><td>c</td><br>");
  assert.deepEqual(selectAll("ul > li:nth-child(odd), h1 a", parseHtml("<h1><a>x</a></h1><ul><li>1<li>2<li>3</ul>")).map((e) => e.name), ["a", "li", "li"]);
  assert.throws(() => parseSelector("a::before"), /pseudo-elements/);
  assert.equal(htmlToText("<h2>Sub</h2><ol><li>a</li><li>b</li></ol><img src=i.png alt=pic>"), "SUB\n\n 1. a\n 2. b\n\npic [i.png]");
});
