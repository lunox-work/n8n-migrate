// REST programs (runtime/src/rest.mjs) and the "same service over REST with your own key"
// mapping in the converter: Google Sheets v4 writes make n8n's requests (n8n-nodes-base 2.47
// GoogleSheet.ts), and an unapproved LLM API call stays an http step.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { convertItems, loadReferences } from "../skills/n8n-to-claude/scripts/convert.mjs";
import { loadInput } from "../skills/n8n-to-claude/scripts/analyze.mjs";
import { preflight } from "../skills/n8n-to-claude/runtime/src/api.mjs";
import { node, wf, run, out, start } from "./runtime-helpers.mjs";

const SHEET = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const HOST = "sheets.googleapis.com";
const allow = { tools: [], sql: [], http: ["GET", "POST", "PUT"].map((method) => ({ method, host: HOST, pathPrefix: "/v4/spreadsheets/" })) };
const secrets = [{ name: "Sheets account", credentialType: "googleSheetsOAuth2Api", hosts: [HOST] }];

// A host that answers the spreadsheet metadata and values reads, and records every request.
function sheetsHost(values) {
  const seen = [];
  return {
    seen,
    http: async (p) => {
      const u = new URL(p.url);
      seen.push({ method: p.method, path: decodeURIComponent(u.pathname), query: p.query, body: p.body, auth: p.auth?.secret });
      if (p.method === "GET" && u.pathname === `/v4/spreadsheets/${SHEET}`) return { status: 200, body: { sheets: [{ properties: { sheetId: 0, title: "Leads" } }, { properties: { sheetId: 7, title: "Other" } }] } };
      if (p.method === "GET") return { status: 200, body: { values } };
      return { status: 200, body: {} };
    },
  };
}

const sheetsStep = (operation, columns, options = {}, v = 4.6) =>
  node("Sheet", "googleSheets", { operation, documentId: { __rl: true, mode: "id", value: SHEET }, sheetName: { __rl: true, mode: "list", value: "gid=0" }, columns, options }, { v, kind: "http", auth: { credentialType: "googleSheetsOAuth2Api", secret: "Sheets account" } });
const withRest = ([name, step]) => [name, { ...step, rest: { program: "googleSheets" } }];
const schema = (...ids) => ids.map((id) => ({ id, displayName: id, type: "string", display: true, required: false, defaultMatch: false, canBeUsedToMatch: true }));

test("Sheets append (define below): metadata, sheet read, one empty row, then PUT at the next row in header order", async () => {
  const def = wf([start(), withRest(sheetsStep("append", { mappingMode: "defineBelow", value: { email: "={{ $json.e }}", name: "={{ $json.n }}" }, schema: schema("name", "email") }))], [["Start", "Sheet"]], { allow, secrets });
  const host = sheetsHost([["name", "email"], ["Ann", "ann@x.test"]]);
  const res = await run(def, { host, trigger: [{ n: "Bo", e: "bo@x.test" }, { n: "Cy" }] });
  assert.equal(res.status, "done", res.error?.message);
  assert.deepEqual(
    host.seen.map((r) => `${r.method} ${r.path}`),
    [`GET /v4/spreadsheets/${SHEET}`, `GET /v4/spreadsheets/${SHEET}/values/'Leads'`, `POST /v4/spreadsheets/${SHEET}:batchUpdate`, `PUT /v4/spreadsheets/${SHEET}/values/Leads!3:4`],
  );
  assert.deepEqual(host.seen[0].query, { fields: "sheets.properties" });
  assert.deepEqual(host.seen[1].query, { valueRenderOption: "FORMATTED_VALUE", dateTimeRenderOption: "FORMATTED_STRING" });
  assert.deepEqual(host.seen[2].body, { requests: [{ appendDimension: { sheetId: "0", dimension: "ROWS", length: 1 } }] }, "n8n sends the sheet id as a string");
  assert.deepEqual(host.seen[3].body, { range: "Leads!3:4", values: [["Bo", "bo@x.test"], ["Cy", ""]] });
  assert.deepEqual(host.seen[3].query, { valueInputOption: "USER_ENTERED" });
  assert.ok(host.seen.every((r) => r.auth === "Sheets account"));
  assert.deepEqual(out(res, "Sheet"), [{ email: "bo@x.test", name: "Bo" }, { name: "Cy" }], "an expression with no value leaves the key out, as in n8n's item JSON");
});

test("Sheets update and appendOrUpdate: one cell per changed column; new rows appended (useAppend: null for empty cells)", async () => {
  const cols = { mappingMode: "defineBelow", matchingColumns: ["email"], value: { email: "={{ $json.e }}", status: "={{ $json.s }}" }, schema: schema("email", "name", "status") };
  const values = [["email", "name", "status"], ["ann@x.test", "Ann", "new"], ["bo@x.test", "Bo", "new"]];
  const up = await (async () => {
    const host = sheetsHost(values);
    const res = await run(wf([start(), withRest(sheetsStep("update", cols))], [["Start", "Sheet"]], { allow, secrets }), { host, trigger: [{ e: "bo@x.test", s: "done" }, { e: "zed@x.test", s: "x" }] });
    return { res, host };
  })();
  assert.equal(up.res.status, "done", up.res.error?.message);
  const batch = up.host.seen.find((r) => r.path.endsWith("/values:batchUpdate"));
  assert.deepEqual(batch.body, { data: [{ range: "Leads!C3", values: [["done"]] }], valueInputOption: "USER_ENTERED" });
  assert.equal(up.host.seen.filter((r) => r.method !== "GET").length, 1, "an unmatched key is skipped by update");

  const host = sheetsHost(values);
  const res = await run(wf([start(), withRest(sheetsStep("appendOrUpdate", cols, { useAppend: true }))], [["Start", "Sheet"]], { allow, secrets }), { host, trigger: [{ e: "ann@x.test", s: "seen" }, { e: "zed@x.test", s: "new" }] });
  assert.equal(res.status, "done", res.error?.message);
  const writes = host.seen.filter((r) => r.method !== "GET");
  assert.deepEqual(writes.map((r) => `${r.method} ${r.path}`), [`POST /v4/spreadsheets/${SHEET}/values:batchUpdate`, `POST /v4/spreadsheets/${SHEET}/values/Leads!4:4:append`]);
  assert.deepEqual(writes[0].body.data, [{ range: "Leads!C2", values: [["seen"]] }]);
  assert.deepEqual(writes[1].body, { range: "Leads!4:4", values: [["zed@x.test", null, "new"]] });
});

test("a REST program step outside allow.http is refused before any request", async () => {
  const def = wf([start(), withRest(sheetsStep("append", { mappingMode: "defineBelow", value: { name: "x" }, schema: schema("name") }))], [["Start", "Sheet"]], { allow: { tools: [], sql: [], http: [] }, secrets });
  const host = sheetsHost([["name"]]);
  const res = await run(def, { host, trigger: [{}] });
  assert.notEqual(res.status, "done");
  assert.equal(host.seen.length, 0);
});

function convertWorkflow(nodes, connections) {
  const dir = mkdtempSync(join(tmpdir(), "n2c-rest-"));
  const p = join(dir, "wf.json");
  writeFileSync(p, JSON.stringify({ id: "w1", name: "rest", nodes, connections, settings: { executionOrder: "v1" } }));
  const res = convertItems(loadInput(p).items, { refs: loadReferences(), now: Date.parse("2026-11-14T00:00:00Z"), forceConvert: true })[0];
  rmSync(dir, { recursive: true, force: true });
  return res.definition;
}
const manual = { parameters: {}, name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0] };

test("convert: Sheets v4 writes become the googleSheets REST program with the stored credential; v3 stays blocked", () => {
  const sheet = (v) => ({ parameters: { operation: "append", documentId: { __rl: true, mode: "id", value: SHEET }, sheetName: { __rl: true, mode: "list", value: "gid=0" }, columns: { mappingMode: "autoMapInputData", value: {} }, options: {} }, name: "Add", type: "n8n-nodes-base.googleSheets", typeVersion: v, position: [200, 0], credentials: { googleSheetsOAuth2Api: { id: "1", name: "My Google" } } });
  const def = convertWorkflow([manual, sheet(4.5)], { Start: { main: [[{ node: "Add", type: "main", index: 0 }]] } });
  const s = def.steps.Add;
  assert.equal(s.kind, "http");
  assert.equal(s.rest.program, "googleSheets");
  assert.deepEqual(s.auth, { credentialType: "googleSheetsOAuth2Api", secret: "My Google" });
  assert.deepEqual(def.allow.http.filter((a) => a.host === HOST).map((a) => a.method).sort(), ["GET", "POST", "PUT"]);
  assert.deepEqual(def.secrets.find((x) => x.name === "My Google").hosts, [HOST]);
  assert.equal(preflight(def, {}).ok, true, JSON.stringify(preflight(def, {}).issues));
  const old = convertWorkflow([manual, sheet(3)], { Start: { main: [[{ node: "Add", type: "main", index: 0 }]] } });
  assert.equal(old.steps.Add.kind, "blocked");
});

test("convert: an LLM API call over HTTP stays an http step with the person's key unless the substitution is approved", () => {
  const call = { parameters: { method: "POST", url: "https://api.openai.com/v1/chat/completions", authentication: "predefinedCredentialType", nodeCredentialType: "openAiApi", sendBody: true, specifyBody: "json", jsonBody: '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}', options: {} }, name: "Ask", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [200, 0], credentials: { openAiApi: { id: "2", name: "OpenAI" } } };
  const links = { Start: { main: [[{ node: "Ask", type: "main", index: 0 }]] } };
  const def = convertWorkflow([manual, call], links);
  const s = def.steps.Ask;
  assert.equal(s.kind, "http");
  assert.equal(s.substitution.approved, false);
  assert.ok(s.reviewReasons.some((r) => /your own API key/.test(r)));
  assert.ok(def.allow.http.some((a) => a.host === "api.openai.com" && a.method === "POST"));
  assert.deepEqual(def.secrets.find((x) => x.name === "OpenAI").hosts, ["api.openai.com"]);
});

test("Sheets read row filters follow n8n's lookupValues: first match per filter, OR order, AND, 4.6 stop", async () => {
  const { applyLookup } = await import("../skills/n8n-to-claude/runtime/src/nodes2.mjs");
  const rows = [
    { row_number: 2, q: "a", status: "false" },
    { row_number: 3, q: "b", status: "" },
    { row_number: 4, q: "c" },
    { row_number: 5, q: "d", status: "false" },
  ];
  const exec = { name: "Read" };
  const nums = (r) => r.map((x) => x.row_number);
  assert.deepEqual(nums(applyLookup(exec, rows, { filters: [{ lookupColumn: "status", lookupValue: "false" }] })), [2], "first match only by default");
  assert.deepEqual(nums(applyLookup(exec, rows, { filters: [{ lookupColumn: "status", lookupValue: "false" }], returnAll: true })), [2, 5]);
  assert.deepEqual(nums(applyLookup(exec, rows, { filters: [{ lookupColumn: "status", lookupValue: "" }] })), [3], "a missing cell is empty text too, but the first match wins");
  assert.deepEqual(nums(applyLookup(exec, rows, { filters: [{ lookupColumn: "q", lookupValue: "d" }, { lookupColumn: "q", lookupValue: "a" }] })), [5, 2], "OR keeps filter order");
  assert.deepEqual(nums(applyLookup(exec, rows, { filters: [{ lookupColumn: "q", lookupValue: "d" }, { lookupColumn: "q", lookupValue: "a" }], stopAtFirst: true })), [5]);
  assert.deepEqual(nums(applyLookup(exec, rows, { filters: [{ lookupColumn: "status", lookupValue: "false" }, { lookupColumn: "q", lookupValue: "d" }], combine: "AND", returnAll: true })), [5]);
  assert.throws(() => applyLookup(exec, rows, { filters: [{ lookupColumn: "nope", lookupValue: "x" }] }), /could not be found/);
});
