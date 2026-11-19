// Tolerant connector-shape readers (runtime/src/shapes.mjs), the result adapters that use
// them (each reader accepts every plausible shape and fails loudly on anything else), and
// the n8n-shaped prompts of classifier steps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { adaptResult } from "../skills/n8n-migrate/runtime/src/adapt.mjs";
import { gmailMessage, notionDatabase, parseAddressList } from "../skills/n8n-migrate/runtime/src/shapes.mjs";
import { convertItems, loadReferences } from "../skills/n8n-migrate/scripts/convert.mjs";

const refs = loadReferences();
const gmailGet = refs.toolMaps.maps["n8n-nodes-base.gmail"][">=2"].message.get;
const notionGet = refs.toolMaps.maps["n8n-nodes-base.notion"][">=2"].database.get;
const parsedSpec = gmailGet.resultWhen.find((c) => c.equals === false).result;

const b64url = (s) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const flat = { id: "m1", threadId: "t1", subject: "Hello", sender: "ann@x.test", toRecipients: ["bob@x.test", "cy@x.test"], ccRecipients: [], addressDisplayNames: { "ann@x.test": "Ann Lee" }, plaintextBody: "Hi Bob", date: "2026-11-16T08:41:00.000Z", labelIds: ["INBOX"] };
const rest = {
  id: "m1",
  threadId: "t1",
  labelIds: ["INBOX"],
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "From", value: '"Ann Lee" <ann@x.test>' },
      { name: "To", value: "bob@x.test, cy@x.test" },
      { name: "Subject", value: "Hello" },
      { name: "Date", value: "Mon, 16 Nov 2026 08:41:00 +0000" },
      { name: "List-Unsubscribe", value: "<https://x.test/u>" },
    ],
    parts: [
      { mimeType: "text/plain", body: { data: b64url("Hi Bob") } },
      { mimeType: "text/html", body: { data: b64url("<p>Hi Bob</p>") } },
    ],
  },
};

test("addresses: quoted names, commas inside quotes, bare addresses, objects", () => {
  assert.deepEqual(parseAddressList('"Lee, Ann" <ann@x.test>, bob@x.test'), [
    { address: "ann@x.test", name: "Lee, Ann" },
    { address: "bob@x.test", name: "" },
  ]);
  assert.deepEqual(parseAddressList([{ email: "a@x.test", displayName: "A" }, "b@x.test"]), [
    { address: "a@x.test", name: "A" },
    { address: "b@x.test", name: "" },
  ]);
  assert.deepEqual(parseAddressList({ value: [{ address: "a@x.test", name: "" }] }), [{ address: "a@x.test", name: "" }]);
});

test("gmail-message: the connector's flat shape and the REST shape give the same n8n fields", () => {
  for (const shape of [flat, rest, { message: flat }, JSON.stringify(rest)]) {
    const [j] = adaptResult(parsedSpec, shape);
    assert.equal(j.from.value[0].address, "ann@x.test");
    assert.equal(j.from.value[0].name, "Ann Lee");
    assert.equal(j.from.text, '"Ann Lee" <ann@x.test>');
    assert.deepEqual(j.to.value.map((r) => r.address), ["bob@x.test", "cy@x.test"]);
    assert.equal(j.cc, undefined, "no Cc gives no cc field, as mailparser");
    assert.equal(j.subject, "Hello");
    assert.equal(j.text, "Hi Bob");
    assert.equal(j.date, "2026-11-16T08:41:00.000Z");
    assert.equal(j.headers.from.startsWith("From: "), true);
  }
  const [r] = adaptResult(parsedSpec, rest);
  assert.equal(r.headers["list-unsubscribe"], "List-Unsubscribe: <https://x.test/u>", "headers the tool returned are kept as n8n's header lines");
  assert.equal(r.html, "<p>Hi Bob</p>");
  assert.equal(adaptResult(parsedSpec, flat)[0].html, false, "no HTML part is false, as mailparser");
  const [s] = adaptResult(gmailGet.result, flat);
  assert.equal(s.From, '"Ann Lee" <ann@x.test>');
  assert.equal(s.To, "bob@x.test, cy@x.test");
  assert.equal(s.sender, undefined, "the simplified view keeps only n8n's fields");
});

test("gmail-message: output it does not recognise fails the step instead of emitting empty fields", () => {
  assert.throws(() => gmailMessage({ ok: true, data: [] }), /connector shape not recognised \(gmail-message\).*keys \[ok, data\]/);
  assert.throws(() => adaptResult(parsedSpec, "Message not found"), /connector shape not recognised.*text \(17 characters/);
});

test("notion-database: REST object, data source state and the connector's text all give REST properties", () => {
  const state = { name: "Tasks", schema: { Name: { type: "title" }, Stage: { type: "select", options: ["A", { name: "B", color: "red", id: "x1" }] }, Due: { type: "date" } } };
  const text = `<database url="https://www.notion.so/acme/0123456789abcdef0123456789abcdef?v=1" title="Tasks">\n<data-source url="collection://ffff"><data-source-state>${JSON.stringify(state)}</data-source-state></data-source></database>`;
  const fromText = notionDatabase(text);
  assert.equal(fromText.id, "01234567-89ab-cdef-0123-456789abcdef");
  assert.equal(fromText.url, "https://www.notion.so/0123456789abcdef0123456789abcdef");
  assert.equal(fromText.title[0].plain_text, "Tasks");
  assert.deepEqual(fromText.properties.Stage, { name: "Stage", type: "select", select: { options: [{ name: "A" }, { id: "x1", name: "B", color: "red" }] } });
  assert.deepEqual(fromText.properties.Due, { name: "Due", type: "date", date: {} });
  assert.deepEqual(notionDatabase({ text }).properties, fromText.properties, "text wrapped as {text}");
  assert.deepEqual(notionDatabase(state).properties, fromText.properties, "the state as JSON");
  const restDb = { object: "database", id: "abc", title: [{ plain_text: "Tasks" }], properties: { Name: { id: "title", name: "Name", type: "title", title: {} } }, url: "https://www.notion.so/abc" };
  assert.deepEqual(notionDatabase(restDb).properties, restDb.properties, "a REST object passes through");
  assert.deepEqual(adaptResult(notionGet.result, text), [{ id: fromText.id, name: "Tasks", url: fromText.url }], "simple: id, name, url as n8n's simplifyObjects");
  assert.throws(() => adaptResult(notionGet.result, "Could not find database"), /connector shape not recognised \(notion-database\)/);
});

test("resultWhen: the converter picks the adapter for the option the export sets (n8n's default otherwise)", () => {
  const wf = (simple) => ({
    name: "w",
    nodes: [
      { parameters: {}, name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0] },
      { parameters: { operation: "get", messageId: "={{ $json.id }}", ...(simple === undefined ? {} : { simple }) }, name: "Get", type: "n8n-nodes-base.gmail", typeVersion: 2.1, position: [200, 0], credentials: { gmailOAuth2: { id: "1", name: "Gmail" } } },
    ],
    connections: { Start: { main: [[{ node: "Get", type: "main", index: 0 }]] } },
  });
  const resultOf = (simple) => convertItems([{ id: "w", wf: wf(simple), file: "w.json" }], { refs, now: Date.parse("2026-11-14T00:00:00Z"), forceConvert: true })[0].definition.steps.Get.tool.result;
  assert.deepEqual(resultOf(undefined), gmailGet.result);
  assert.deepEqual(resultOf(true), gmailGet.result);
  assert.deepEqual(resultOf(false), parsedSpec);
});

test("classifier and sentiment steps send n8n's system message: template, LangChain format instructions, rules", () => {
  const def = (node) =>
    convertItems(
      [
        {
          id: "c",
          file: "c.json",
          wf: {
            name: "c",
            nodes: [
              { parameters: {}, name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0] },
              node,
              { parameters: { options: {} }, name: "Model", type: "@n8n/n8n-nodes-langchain.lmChatAnthropic", typeVersion: 1.3, position: [200, 200], credentials: { anthropicApi: { id: "1", name: "A" } } },
            ],
            connections: { Start: { main: [[{ node: node.name, type: "main", index: 0 }]] }, Model: { ai_languageModel: [[{ node: node.name, type: "ai_languageModel", index: 0 }]] } },
          },
        },
      ],
      { refs, now: Date.parse("2026-11-14T00:00:00Z"), forceConvert: true },
    )[0].definition.steps[node.name].model;
  const tc = def({ parameters: { inputText: "={{ $json.text }}", categories: { categories: [{ category: "spam", description: "junk" }, { category: "ham" }] }, options: {} }, name: "Classify", type: "@n8n/n8n-nodes-langchain.textClassifier", typeVersion: 1, position: [200, 0] });
  const parts = tc.system.split("\n\t");
  assert.equal(parts[0], "Please classify the text provided by the user into one of the following categories: spam, ham, and use the provided formatting instructions below. Don't explain, and only output the json.");
  assert.match(parts[1], /^You must format your output as a JSON value that adheres to a given "JSON Schema" instance\./);
  assert.match(parts[1], /"required": \["foo"\]\}\}\}\}\n/, "LangChain classic's example, braces as n8n sends them");
  const schemaText = /```json\n(.*)\n```\n$/.exec(parts[1])[1];
  assert.deepEqual(JSON.parse(schemaText), {
    type: "object",
    properties: { spam: { type: "boolean", description: 'Should be true if the input has category "spam" (description: junk)' }, ham: { type: "boolean", description: 'Should be true if the input has category "ham" (description: undefined)' } },
    required: ["spam", "ham"],
    additionalProperties: false,
    $schema: "http://json-schema.org/draft-07/schema#",
  });
  assert.deepEqual(parts.slice(2), ["Categories are mutually exclusive, and only one can be true", "If there is not a very fitting category, select none of the categories."]);
  const sa = def({ parameters: { inputText: "={{ $json.text }}", options: { categories: "Good,Bad" } }, name: "Sentiment", type: "@n8n/n8n-nodes-langchain.sentimentAnalysis", typeVersion: 1.1, position: [200, 0] });
  assert.match(sa.system, /Categorize it into one of the following: Good,Bad\. Use the provided formatting instructions\. Only output the JSON\.\n\t\t\t\tYou must format/);
  assert.deepEqual(sa.outputSchema.required, ["sentiment", "strength", "confidence"], "n8n asks for all three fields even without detailed results");
  assert.deepEqual(sa.outputTemplate, { sentimentAnalysis: { category: "$output.sentiment" } });
});
