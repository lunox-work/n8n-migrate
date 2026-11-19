// REST programs (runtime/src/rest.mjs) and the "same service over REST with your own key"
// mapping in the converter: Google Sheets v4 reads and writes make n8n's requests (n8n-nodes-base
// 2.47 GoogleSheet.ts), LinkedIn posts as its node sends them, and an unapproved LLM API call
// stays an http step.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { convertItems, loadReferences } from "../skills/n8n-migrate/scripts/convert.mjs";
import { loadInput } from "../skills/n8n-migrate/scripts/analyze.mjs";
import { preflight, start as startRun, resume } from "../skills/n8n-migrate/runtime/src/api.mjs";
import { node, wf, run, out, start } from "./runtime-helpers.mjs";
import { restPrograms } from "../skills/n8n-migrate/runtime/src/rest.mjs";

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

test("step mode (task driver): a program that grows the header it read replays the same requests after each resume", async () => {
  // appendOrUpdate with a new input column writes the header and adds the column to the rows
  // it read. The answer it was handed must not change in the result log, or the replay after a
  // resume skips the header write and every later request id shifts by one.
  const cols = { mappingMode: "autoMapInputData", matchingColumns: ["email"], value: {}, schema: schema("email", "name") };
  const def = wf([start(), withRest(sheetsStep("appendOrUpdate", cols, {}, 4.5))], [["Start", "Sheet"]], { allow, secrets });
  const values = () => [["email", "name"], ["ann@x.test", "Ann"]];
  const trigger = [{ email: "bo@x.test", name: "Bo", phone: "555" }];
  const once = sheetsHost(values());
  const res = await run(def, { host: once, trigger });
  assert.equal(res.status, "done", res.error?.message);
  const host = sheetsHost(values());
  let r = await startRun(def, { clock: { startedAt: "2026-11-14T03:00:00Z" }, virtualTime: true, trigger: { node: "Start", items: trigger.map((json) => ({ json })) }, batchSize: 1 });
  for (let k = 0; r.status === "needs" && k < 20; k++) {
    const state = JSON.parse(JSON.stringify(r.state)); // persisted between resumes, as the task driver does
    const answers = await Promise.all(r.requests.map(async (q) => ({ id: q.id, ok: true, value: JSON.parse(JSON.stringify(await host.http(q))) })));
    r = await resume(state, answers);
  }
  assert.equal(r.status, "done", JSON.stringify(r.error));
  assert.deepEqual(host.seen.map((q) => `${q.method} ${q.path}`), once.seen.map((q) => `${q.method} ${q.path}`));
  assert.ok(once.seen.some((q) => q.method === "PUT" && q.path.endsWith("Leads!1:1")), "the header write is part of the run");
});

test("a REST program step outside allow.http is refused before any request", async () => {
  const def = wf([start(), withRest(sheetsStep("append", { mappingMode: "defineBelow", value: { name: "x" }, schema: schema("name") }))], [["Start", "Sheet"]], { allow: { tools: [], sql: [], http: [] }, secrets });
  const host = sheetsHost([["name"]]);
  const res = await run(def, { host, trigger: [{}] });
  assert.notEqual(res.status, "done");
  assert.equal(host.seen.length, 0);
});

function convertWorkflow(nodes, connections) {
  const dir = mkdtempSync(join(tmpdir(), "n8m-rest-"));
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
  const { applyLookup } = await import("../skills/n8n-migrate/runtime/src/nodes2.mjs");
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

test("Sheets read over REST: the named tab, n8n's typed values, row numbers and row filters (n8n readSheet)", async () => {
  const read = (params, v = 4.5) => node("Sheet", "googleSheets", { operation: "read", documentId: { __rl: true, mode: "url", value: `https://docs.google.com/spreadsheets/d/${SHEET}/edit#gid=7` }, sheetName: { __rl: true, mode: "list", value: 7 }, options: {}, ...params }, { v, kind: "http", auth: { credentialType: "googleSheetsOAuth2Api", secret: "Sheets account" } });
  const values = [["name", "", "score", "ok"], ["Ann", "", 3, true], [], ["Bo", "", 0, false]];
  const host = sheetsHost(values);
  const res = await run(wf([start(), withRest(read({}))], [["Start", "Sheet"]], { allow, secrets }), { host, trigger: [{}] });
  assert.equal(res.status, "done", res.error?.message);
  assert.deepEqual(host.seen.map((r) => `${r.method} ${r.path}`), [`GET /v4/spreadsheets/${SHEET}`, `GET /v4/spreadsheets/${SHEET}/values/'Other'`], "the tab by its id, the spreadsheet id from the URL");
  assert.deepEqual(host.seen[1].query, { valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "FORMATTED_STRING" });
  assert.deepEqual(out(res, "Sheet"), [{ row_number: 2, name: "Ann", score: 3, ok: true }, { row_number: 4, name: "Bo", score: 0, ok: false }], "an empty column and an empty row dropped, values as the API types them");
  // Filters: first match per filter (4.5), AND, and an unknown column as n8n refuses it.
  const f = (values, combine) => ({ filtersUI: { values }, ...(combine ? { combineFilters: combine } : {}) });
  const one = await run(wf([start(), withRest(read({ ...f([{ lookupColumn: "score", lookupValue: "0" }]), options: { returnFirstMatch: true } }))], [["Start", "Sheet"]], { allow, secrets }), { host: sheetsHost(values), trigger: [{}] });
  assert.deepEqual(out(one, "Sheet"), [{ row_number: 4, name: "Bo", score: 0, ok: false }]);
  const and = await run(wf([start(), withRest(read(f([{ lookupColumn: "name", lookupValue: "Ann" }, { lookupColumn: "ok", lookupValue: "true" }], "AND")))], [["Start", "Sheet"]], { allow, secrets }), { host: sheetsHost(values), trigger: [{}] });
  assert.deepEqual(out(and, "Sheet"), [{ row_number: 2, name: "Ann", score: 3, ok: true }]);
  // A filter row the export saved without its value matches empty cells (n8n's default "").
  const blank = await run(wf([start(), withRest(read(f([{ lookupColumn: "ok" }])))], [["Start", "Sheet"]], { allow, secrets }), { host: sheetsHost([["name", "ok"], ["Ann", "yes"], ["Bo"]]), trigger: [{}] });
  assert.deepEqual(out(blank, "Sheet"), [{ row_number: 3, name: "Bo", ok: "" }]);
  const bad = await run(wf([start(), withRest(read(f([{ lookupColumn: "email", lookupValue: "x" }])))], [["Start", "Sheet"]], { allow, secrets }), { host: sheetsHost(values), trigger: [{}] });
  assert.match(bad.error?.message ?? "", /The column "email" could not be found/);
  // 4.2 and later read once per input item; 4.1 once.
  const twice = sheetsHost(values);
  await run(wf([start(), withRest(read({}, 4.2))], [["Start", "Sheet"]], { allow, secrets }), { host: twice, trigger: [{}, {}] });
  const once = sheetsHost(values);
  await run(wf([start(), withRest(read({}, 4.1))], [["Start", "Sheet"]], { allow, secrets }), { host: once, trigger: [{}, {}] });
  assert.equal(twice.seen.filter((r) => r.path.includes("/values/")).length, 2);
  assert.equal(once.seen.filter((r) => r.path.includes("/values/")).length, 1);
});

test("convert: a Sheets v4 read goes over REST only when a Sheets step of the workflow already does, under the same credential", () => {
  const cred = (name) => ({ googleSheetsOAuth2Api: { id: "1", name } });
  const reader = { parameters: { documentId: { __rl: true, mode: "id", value: SHEET }, sheetName: { __rl: true, mode: "list", value: 7 }, options: {} }, name: "Read", type: "n8n-nodes-base.googleSheets", typeVersion: 4.5, position: [200, 0], credentials: cred("My Google") };
  const writer = (name, credName) => ({ parameters: { operation: "append", documentId: { __rl: true, mode: "id", value: SHEET }, sheetName: { __rl: true, mode: "list", value: "gid=0" }, columns: { mappingMode: "autoMapInputData", value: {} }, options: {} }, name, type: "n8n-nodes-base.googleSheets", typeVersion: 4.5, position: [400, 0], credentials: cred(credName) });
  const links = { Start: { main: [[{ node: "Read", type: "main", index: 0 }]] }, Read: { main: [[{ node: "Add", type: "main", index: 0 }]] } };
  const both = convertWorkflow([manual, reader, writer("Add", "My Google")], links);
  assert.equal(both.steps.Read.kind, "http");
  assert.equal(both.steps.Read.rest.program, "googleSheets");
  assert.equal(both.steps.Read.rest.effect, "read");
  assert.deepEqual(both.steps.Read.auth, { credentialType: "googleSheetsOAuth2Api", secret: "My Google" });
  assert.equal(preflight(both, {}).ok, true, JSON.stringify(preflight(both, {}).issues));
  // Alone, or beside a write under another credential: the Drive export, as before.
  const alone = convertWorkflow([manual, reader], { Start: links.Start });
  assert.equal(alone.steps.Read.kind, "tool");
  assert.equal(alone.steps.Read.tool.name, "download_file_content");
  const other = convertWorkflow([manual, reader, writer("Add", "Another Google")], links);
  assert.equal(other.steps.Read.kind, "tool");
});

// R5b3 iteration 56: a spreadsheet create beside Sheets REST writes goes over the Sheets API, so
// the new spreadsheet's id and tabs reach the next steps as n8n gives them.
test("Sheets spreadsheet create: over REST beside a Sheets REST write (n8n's body, the API's answer as the item); alone through the Drive connector", async () => {
  const cred = { googleSheetsOAuth2Api: { id: "1", name: "My Google" } };
  const create = { parameters: { title: "={{ 'Leads ' + $json.n }}", options: { locale: "en_GB" }, resource: "spreadsheet", sheetsUi: { sheetValues: [{ title: "Leads" }] } }, name: "Create", type: "n8n-nodes-base.googleSheets", typeVersion: 4.5, position: [200, 0], credentials: cred };
  const add = { parameters: { operation: "append", documentId: { __rl: true, mode: "id", value: "={{ $json.spreadsheetId }}" }, sheetName: { __rl: true, mode: "id", value: "={{ $json.sheets[0].properties.sheetId }}" }, columns: { mappingMode: "autoMapInputData", value: {} }, options: {} }, name: "Add", type: "n8n-nodes-base.googleSheets", typeVersion: 4.5, position: [400, 0], credentials: cred };
  const links = { Start: { main: [[{ node: "Create", type: "main", index: 0 }]] }, Create: { main: [[{ node: "Add", type: "main", index: 0 }]] } };
  const def = convertWorkflow([manual, create, add], links);
  assert.deepEqual([def.steps.Create.kind, def.steps.Create.rest.program, def.steps.Create.rest.effect], ["http", "googleSheets", "write"]);
  assert.ok(def.allow.http.some((h) => h.method === "POST" && h.host === HOST && h.pathPrefix === "/v4/spreadsheets"));
  assert.equal(convertWorkflow([manual, create], { Start: links.Start }).steps.Create.tool.name, "create_file");
  const seen = [];
  const http = async (p) => {
    const u = new URL(p.url);
    seen.push({ method: p.method, path: u.pathname, body: p.body });
    if (p.method === "POST" && u.pathname === "/v4/spreadsheets") return { status: 200, body: { spreadsheetId: "NEW1", sheets: [{ properties: { sheetId: 42, title: "Leads" } }] } };
    return { status: 200, body: {} };
  };
  // The create step alone (the append's own requests are covered above).
  const r = await run({ ...def, steps: { Start: def.steps.Start, Create: def.steps.Create }, edges: def.edges.filter((e) => e.to === "Create") }, { host: { http }, trigger: [{ n: 1 }] });
  assert.equal(r.status, "done", JSON.stringify(r.error));
  assert.deepEqual(seen[0], { method: "POST", path: "/v4/spreadsheets", body: { properties: { title: "Leads 1", locale: "en_GB" }, sheets: [{ properties: { title: "Leads", hidden: false } }] } });
  assert.deepEqual(out(r, "Create"), [{ spreadsheetId: "NEW1", sheets: [{ properties: { sheetId: 42, title: "Leads" } }] }]);
});

// ---------- LinkedIn post:create (rest.mjs linkedIn, n8n LinkedIn node v1) ----------

function linkedInExec(params, items, answers) {
  const seen = [];
  return {
    seen,
    exec: {
      name: "Publish",
      typeVersion: 1,
      step: { auth: { credentialType: "linkedInOAuth2Api", secret: "LinkedIn" } },
      getInputData: () => items,
      continueOnFail: () => false,
      param: (p, i, d) => (p in params ? (typeof params[p] === "function" ? params[p](i) : params[p]) : d),
      request: async ([req]) => {
        seen.push(req);
        return [{ ok: true, value: answers(req) }];
      },
    },
  };
}

test("LinkedIn post:create: an image post as n8n sends it (little text, initializeUpload, bytes, /rest/posts, the urn from x-restli-id)", async () => {
  const png = Buffer.from("png bytes").toString("base64");
  const { exec, seen } = linkedInExec(
    { resource: "post", operation: "create", text: "Hi (all) @team_1 #ok", postAs: "organization", organization: "123", shareMediaCategory: "IMAGE", additionalFields: {} },
    [{ json: {}, binary: { data: { data: png, mimeType: "image/png", fileName: "a.png" } } }],
    (req) => (req.url.endsWith("action=initializeUpload") ? { status: 200, body: JSON.stringify({ value: { uploadUrl: "https://www.linkedin.com/dms-uploads/sp/x", image: "urn:li:image:1" } }) } : req.url.endsWith("/rest/posts") ? { status: 201, headers: { "x-restli-id": "urn:li:share:9" }, body: "" } : { status: 201, body: "" }),
  );
  const [out] = await restPrograms.linkedIn.execute(exec);
  assert.deepEqual(out, [{ json: { urn: "urn:li:share:9" }, pairedItem: { item: 0 } }]);
  assert.deepEqual(seen.map((r) => `${r.method} ${r.url}`), ["POST https://api.linkedin.com/rest/images?action=initializeUpload", "POST https://www.linkedin.com/dms-uploads/sp/x", "POST https://api.linkedin.com/rest/posts"]);
  assert.deepEqual(seen[0].body, { initializeUploadRequest: { owner: "urn:li:organization:123" } });
  assert.equal(seen[1].body, png);
  assert.equal(seen[1].bodyEncoding, "base64");
  assert.equal(seen[1].headers["Content-Type"], "image/png");
  assert.deepEqual(seen[2].body, { author: "urn:li:organization:123", lifecycleState: "PUBLISHED", distribution: { feedDistribution: "MAIN_FEED", thirdPartyDistributionChannels: [] }, visibility: "PUBLIC", content: { media: { title: "", id: "urn:li:image:1" } }, commentary: "Hi \\(all\\) \\@team\\_1 #ok" });
  for (const r of seen) assert.deepEqual([r.headers["LinkedIn-Version"], r.headers["X-Restli-Protocol-Version"], r.auth.secret], ["202604", "2.0.0", "LinkedIn"]);
});

test("LinkedIn post:create: a text post as a person keeps its visibility; empty text is refused as n8n refuses it", async () => {
  const { exec, seen } = linkedInExec({ text: "Hello", postAs: "person", person: "abc", additionalFields: { visibility: "CONNECTIONS" } }, [{ json: {} }], () => ({ status: 201, headers: { "X-RestLi-Id": "urn:li:share:1" }, body: "" }));
  const [out] = await restPrograms.linkedIn.execute(exec);
  assert.deepEqual(out[0].json, { urn: "urn:li:share:1" });
  assert.deepEqual(seen[0].body, { author: "urn:li:person:abc", lifecycleState: "PUBLISHED", distribution: { feedDistribution: "MAIN_FEED", thirdPartyDistributionChannels: [] }, visibility: "CONNECTIONS", commentary: "Hello" });
  const empty = linkedInExec({ text: "  " }, [{ json: {} }], () => ({ status: 201 }));
  await assert.rejects(restPrograms.linkedIn.execute(empty.exec), /The Text field is empty/);
});

test("convert: LinkedIn post:create becomes the linkedIn REST program with the step's credential", () => {
  const post = { parameters: { text: "={{ $json.t }}", postAs: "organization", organization: "123", additionalFields: {}, shareMediaCategory: "NONE" }, name: "Post", type: "n8n-nodes-base.linkedIn", typeVersion: 1, position: [200, 0], credentials: { linkedInOAuth2Api: { id: "1", name: "My LinkedIn" } } };
  const def = convertWorkflow([manual, post], { Start: { main: [[{ node: "Post", type: "main", index: 0 }]] } });
  const s = def.steps.Post;
  assert.equal(s.kind, "http");
  assert.equal(s.rest.program, "linkedIn");
  assert.equal(s.rest.effect, "write");
  assert.deepEqual(s.auth, { credentialType: "linkedInOAuth2Api", secret: "My LinkedIn" });
  assert.deepEqual(def.secrets.find((x) => x.name === "My LinkedIn").hosts.sort(), ["api.linkedin.com", "www.linkedin.com"]);
  assert.equal(preflight(def, {}).ok, true, JSON.stringify(preflight(def, {}).issues));
});

test("Facebook Graph API: sendBinaryData posts the item's binary as one multipart file part, named by <field>:<property>", async () => {
  const png = Buffer.from("img").toString("base64");
  const seen = [];
  const exec = {
    name: "FB",
    typeVersion: 1,
    step: { n8n: { typeVersion: 1 }, auth: { credentialType: "facebookGraphApi", secret: "FB token" } },
    getInputData: () => [{ json: {}, binary: { photo: { data: png, mimeType: "image/png", fileName: "p.png" } } }],
    continueOnFail: () => false,
    param: (p, i, d) => ({ hostUrl: "graph.facebook.com", httpRequestMethod: "POST", graphApiVersion: "v22.0", node: "me", edge: "photos", sendBinaryData: true, binaryPropertyName: "source:photo", options: {} })[p] ?? d,
    request: async ([req]) => (seen.push(req), [{ ok: true, value: { status: 200, body: '{"id":"1"}' } }]),
  };
  const [out] = await restPrograms.facebookGraph.execute(exec);
  assert.deepEqual(out[0].json, { id: "1" });
  assert.equal(seen[0].url, "https://graph.facebook.com/v22.0/me/photos?access_token={{secret}}");
  assert.equal(seen[0].contentType, "multipart-form-data");
  assert.deepEqual(seen[0].body, { source: { $file: { fileName: "p.png", mimeType: "image/png", data: png } } });
});

test("a Sheets read through the Drive export: rows lead with row_number, as n8n's read builds them", async () => {
  const def = convertWorkflow([manual, { parameters: { documentId: { __rl: true, mode: "id", value: SHEET }, sheetName: { __rl: true, mode: "list", value: "gid=0" }, options: {} }, name: "Read", type: "n8n-nodes-base.googleSheets", typeVersion: 4.5, position: [200, 0], credentials: { googleSheetsOAuth2Api: { id: "1", name: "My Google" } } }], { Start: { main: [[{ node: "Read", type: "main", index: 0 }]] } });
  const res = await run(def, { host: { tool: async () => ({ content: Buffer.from("name,score\nAnn,3").toString("base64") }) }, trigger: [{}] });
  assert.equal(res.status, "done", res.error?.message);
  assert.deepEqual(Object.keys(out(res, "Read")[0]), ["row_number", "name", "score"]);
});

test("convert: a Sheets read through the Drive export gets the spreadsheet id from a url-mode document, as n8n's getSpreadsheetId", async () => {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET}/edit#gid=7`;
  const reader = (documentId) => ({ parameters: { documentId, sheetName: { __rl: true, mode: "list", value: "gid=0" }, options: {} }, name: "Read", type: "n8n-nodes-base.googleSheets", typeVersion: 4.5, position: [200, 0], credentials: { googleSheetsOAuth2Api: { id: "1", name: "My Google" } } });
  const links = { Start: { main: [[{ node: "Read", type: "main", index: 0 }]] } };
  assert.equal(convertWorkflow([manual, reader({ __rl: true, mode: "url", value: url })], links).steps.Read.tool.args.fileId, SHEET);
  assert.equal(convertWorkflow([manual, reader({ __rl: true, mode: "id", value: SHEET })], links).steps.Read.tool.args.fileId, SHEET);
  assert.equal(convertWorkflow([manual, reader({ __rl: true, mode: "url", value: "https://example.test/short" })], links).steps.Read.tool.args.fileId, "", "no id in the URL: n8n's empty id");
  const def = convertWorkflow([manual, reader({ __rl: true, mode: "url", value: "={{ $json.sheet }}" })], links);
  const seen = [];
  const res = await run(def, { host: { tool: async (p) => (seen.push(p.args.fileId), { content: Buffer.from("name\nAnn").toString("base64") }) }, trigger: [{ sheet: url }] });
  assert.equal(res.status, "done", res.error?.message);
  assert.deepEqual(seen, [SHEET], "an expression is resolved per item, then the id taken from it");
});

// R5b1 iteration 50: n8n reads the match column's value with "" as the fallback only for a
// parameter that is not there; one whose expression resolves to undefined passes, and the
// update goes on (n8n's update.operation and appendOrUpdate.operation, read in the image).
test("Sheets update: a match value that resolves to undefined is not the missing-parameter error", async () => {
  const cols = { mappingMode: "defineBelow", matchingColumns: ["email"], value: { email: "={{ $json.e }}", status: "={{ $json.s }}" }, schema: schema("email", "name", "status") };
  const values = [["email", "name", "status"], ["ann@x.test", "Ann", "new"]];
  const host = sheetsHost(values);
  const res = await run(wf([start(), withRest(sheetsStep("update", cols))], [["Start", "Sheet"]], { allow, secrets }), { host, trigger: [{ s: "done" }] });
  assert.equal(res.status, "done", res.error?.message);
  const missing = { ...cols, value: { status: "={{ $json.s }}" } };
  const res2 = await run(wf([start(), withRest(sheetsStep("update", missing))], [["Start", "Sheet"]], { allow, secrets }), { host: sheetsHost(values), trigger: [{ s: "done" }] });
  assert.equal(res2.status, "failed");
  assert.match(res2.error.message, /The 'Column to Match On' parameter is required/);
});
