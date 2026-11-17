// Connector responses as a real account returned them on 2026-11-18 (Claude Code 2.1.326; see
// evals/connectors/observed-2026-11-18.md). The texts keep the connectors' exact layout; names,
// ids and message bodies are made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { adaptResult } from "../skills/n8n-to-claude/runtime/src/adapt.mjs";
import { mcpValue } from "../skills/n8n-to-claude/runtime/src/driver.mjs";
import { mcpPayload } from "../skills/n8n-to-claude/runtime/src/artifact-driver.mjs";
import { slackMessages, slackUser, notionPage, notionRows, notionDatabase } from "../skills/n8n-to-claude/runtime/src/shapes.mjs";
import { loadInput } from "../skills/n8n-to-claude/scripts/analyze.mjs";
import { convertItems, loadReferences } from "../skills/n8n-to-claude/scripts/convert.mjs";

const refs = loadReferences();
const map = (node, ver, res, op) => refs.toolMaps.maps[node][ver][res][op];
const text = (t) => [{ type: "text", text: t }];

const CHANNEL = JSON.stringify({
  messages:
    "Channel: #ops (C0TEST01)\n\n=== Message at 2026-11-17 11:55:33 +08 === \nMessage TS: 1794887733.702439\n*Hi <!channel> ,*\n\nAudit next week.\nFiles: rules.png (ID: F0TEST, image/png, 1.2 MB)\n\n=== Message from Ops Bot (B0TEST01) at 2026-11-09 21:39:08 +08 === \nMessage TS: 1794231548.195439\nRoad closed tomorrow.\n\n=== Message from Ann Lee <ann@x.test> (U0TEST01) at 2022-10-11 17:33:33 +08 === \nMessage TS: 1665480813.931879\nLaptop is at the service centre.\nThread: 2 replies (latest: 2022-10-11 17:58:56 +08)\n\n=== Message from Ops Bot <bot@x.test> (U0TEST02) at 2026-10-29 12:26:13 +08 === \nMessage TS: 1793247973.417599\n<@U0TEST02|Ops Bot> has joined the channel",
  pagination_info: "There are more messages available. To view the next page, use cursor: `abc`\n",
});
const THREAD = JSON.stringify({
  messages:
    "=== THREAD PARENT MESSAGE ===\nFrom: Ann Lee <ann@x.test> (U0TEST01)\nTime: 2022-10-11 17:33:33 +08\nMessage TS: 1665480813.931879\nLaptop is at the service centre.\n\n=== THREAD REPLIES (2 total) ===\n\n--- Reply 1 of 2 ---\nFrom: Bo Tan <bo@x.test> (U0TEST03)\nTime: 2022-10-11 17:57:02 +08\nMessage TS: 1665482222.686839\nWhen is it ready?\nThanks\n\n--- Reply 2 of 2 ---\nFrom: Ann Lee <ann@x.test> (U0TEST01)\nTime: 2022-10-11 17:58:56 +08\nMessage TS: 1665482336.199139\nMonday.\n",
  pagination_info: "There are no more messages in this thread.\n",
});
const PROFILE = JSON.stringify({ result: "User ID: U0TEST01\nUsername: ann\nDisplay Name: Ann\nReal Name: Ann Lee\nPronouns: \nTitle: \nEmail: ann@x.test\nOrganization Name: Test Co\nPhone: \nStatus:  \nTimezone: Asia/Singapore\nAdmin: No\nOwner: No\nBot: No\nRestricted: No\n" });

test("Slack channel history: the connector's text becomes Slack message items", () => {
  const items = adaptResult(map("n8n-nodes-base.slack", ">=2", "channel", "history").result, mcpValue(text(CHANNEL)));
  assert.equal(items.length, 4);
  assert.deepEqual(
    items.map((i) => ({ ts: i.ts, user: i.user, bot_id: i.bot_id, reply_count: i.reply_count, subtype: i.subtype })),
    [
      { ts: "1794887733.702439", user: undefined, bot_id: undefined, reply_count: undefined, subtype: undefined },
      { ts: "1794231548.195439", user: undefined, bot_id: "B0TEST01", reply_count: undefined, subtype: undefined },
      { ts: "1665480813.931879", user: "U0TEST01", bot_id: undefined, reply_count: 2, subtype: undefined },
      { ts: "1793247973.417599", user: "U0TEST02", bot_id: undefined, reply_count: undefined, subtype: "channel_join" },
    ],
  );
  assert.equal(items[0].text, "*Hi <!channel> ,*\n\nAudit next week.\nFiles: rules.png (ID: F0TEST, image/png, 1.2 MB)");
  assert.equal(items[2].thread_ts, "1665480813.931879");
  assert.equal(items[2].user_email, "ann@x.test");
});

test("Slack thread replies: parent first, every message carries the parent's thread_ts", () => {
  const items = adaptResult(map("n8n-nodes-base.slack", ">=2", "channel", "replies").result, mcpValue(text(THREAD)));
  assert.deepEqual(items.map((i) => [i.ts, i.user, i.text, i.thread_ts]), [
    ["1665480813.931879", "U0TEST01", "Laptop is at the service centre.", "1665480813.931879"],
    ["1665482222.686839", "U0TEST03", "When is it ready?\nThanks", "1665480813.931879"],
    ["1665482336.199139", "U0TEST01", "Monday.", "1665480813.931879"],
  ]);
});

test("Slack: an empty channel gives no items; unknown text fails loudly; Slack's own objects pass", () => {
  assert.deepEqual(slackMessages(JSON.stringify({ messages: "Channel: #quiet (C0TEST09)\n\n" })).messages, []);
  assert.throws(() => slackMessages(JSON.stringify({ messages: "rate limited" })), /connector shape not recognised \(slack-messages\)/);
  assert.deepEqual(slackMessages({ messages: [{ ts: "1", text: "a" }] }).messages, [{ ts: "1", text: "a" }]);
});

test("Slack user info and profile from the connector's 'User ID:' text", () => {
  const user = adaptResult(map("n8n-nodes-base.slack", ">=2", "user", "info").result, mcpValue(text(PROFILE)));
  assert.deepEqual(user[0], { id: "U0TEST01", name: "ann", real_name: "Ann Lee", tz: "Asia/Singapore", is_admin: false, is_owner: false, is_bot: false, is_restricted: false, profile: { display_name: "Ann", real_name: "Ann Lee", email: "ann@x.test", title: "", phone: "", status_text: "" } });
  const profile = adaptResult(map("n8n-nodes-base.slack", ">=2", "user", "getProfile").result, mcpValue(text(PROFILE)));
  assert.equal(profile[0].email, "ann@x.test");
  assert.throws(() => slackUser("no such user"), /slack-user/);
});

test("Drive download: Claude Code's saved-file note and the JSON stub become base64 content", () => {
  const dir = mkdtempSync(join(tmpdir(), "n2c-blob-"));
  const file = join(dir, "mcp-claude_ai_Google_Drive-blob-1-x.csv");
  writeFileSync(file, "name,qty\nApple,3\nPear,5");
  const resp = [
    { type: "text", text: `[Resource from claude.ai Google Drive at googledrive://file/1abc] Binary content (text/csv, 23 bytes) saved to ${file}` },
    { type: "text", text: JSON.stringify({ id: "1abc", title: "Stock", mimeType: "text/csv", content: "(file sent separately)" }) },
  ];
  const v = mcpValue(resp);
  assert.equal(v.title, "Stock");
  assert.equal(Buffer.from(v.content, "base64").toString(), "name,qty\nApple,3\nPear,5");
  const rows = adaptResult(map("n8n-nodes-base.googleSheets", ">=3", "sheet", "read").result, v);
  assert.deepEqual(rows, [{ row_number: 2, name: "Apple", qty: "3" }, { row_number: 3, name: "Pear", qty: "5" }]);
  // A copy that is gone gives no content and says why (the adapter then finds no rows).
  rmSync(dir, { recursive: true, force: true });
  const gone = mcpValue(resp);
  assert.equal(gone.content, null);
  assert.match(gone.error, /could not be read \(ENOENT\)/);
});

test("Drive download in an artifact: the MCP resource block's blob is the content", () => {
  const blob = Buffer.from("a,b\n1,2").toString("base64");
  const v = mcpPayload({ content: [{ type: "resource", resource: { uri: "googledrive://file/1abc", mimeType: "text/csv", blob } }, { type: "text", text: JSON.stringify({ id: "1abc", content: "(file sent separately)" }) }] });
  assert.deepEqual(v, { mimeType: "text/csv", id: "1abc", content: blob });
  const t = mcpPayload({ content: [{ type: "resource", resource: { uri: "x", mimeType: "text/plain", text: "héllo" } }] });
  assert.equal(Buffer.from(t.content, "base64").toString(), "héllo");
});

test("Drive search: title and viewUrl become n8n's name and webViewLink", () => {
  const out = { files: [{ id: "1abc", title: "Stock", mimeType: "application/vnd.google-apps.spreadsheet", viewUrl: "https://docs.google.com/x", owner: "ann@x.test" }], nextPageToken: "t" };
  const items = adaptResult(map("n8n-nodes-base.googleDrive", ">=3", "fileFolder", "search").result, out);
  assert.equal(items[0].name, "Stock");
  assert.equal(items[0].webViewLink, "https://docs.google.com/x");
  assert.deepEqual(adaptResult(map("n8n-nodes-base.googleDrive", ">=3", "fileFolder", "search").result, {}), []);
});

function convertOne(wf) {
  const dir = mkdtempSync(join(tmpdir(), "n2c-obs-"));
  const p = join(dir, "wf.json");
  writeFileSync(p, JSON.stringify(wf));
  const out = convertItems(loadInput(p).items, { refs, now: Date.parse("2026-11-18T00:00:00Z"), forceConvert: true });
  rmSync(dir, { recursive: true, force: true });
  return out[0].definition;
}
const manual = { parameters: {}, name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0] };
const wf = (node) => ({ id: "w1", name: "w", nodes: [manual, node], connections: { Start: { main: [[{ node: node.name, type: "main", index: 0 }]] } }, settings: { executionOrder: "v1" } });

test("Drive search queries use the connector's fields: title for name, parentId for parents", () => {
  const search = (parameters) => convertOne(wf({ name: "Find", type: "n8n-nodes-base.googleDrive", typeVersion: 3, position: [200, 0], parameters: { resource: "fileFolder", ...parameters }, credentials: { googleDriveOAuth2Api: { id: "1", name: "g" } } })).steps.Find.tool.args.query;
  assert.equal(search({ queryString: "invoice" }), "title contains 'invoice'");
  assert.equal(search({ searchMethod: "query", queryString: "name contains 'a' and '0Bfolder' in parents and mimeType != 'x'" }), "title contains 'a' and parentId = '0Bfolder' and mimeType != 'x'");
  assert.equal(search({ searchMethod: "query", queryString: "={{ $json.q }}" }), `={{ String(($json.q)).replace(/\\bname(\\s*(?:contains|!=|=))/g, "title$1").replace(/('[^']*')\\s+in\\s+parents\\b/g, "parentId = $1") }}`);
});

test("Drive trigger on a folder asks for parentId, not parents", () => {
  const def = convertOne({ id: "w2", name: "w", nodes: [{ name: "New file", type: "n8n-nodes-base.googleDriveTrigger", typeVersion: 1, position: [0, 0], parameters: { triggerOn: "specificFolder", folderToWatch: "0Bfolder", event: "fileCreated", pollTimes: { item: [{ mode: "everyHour" }] } }, credentials: { googleDriveOAuth2Api: { id: "1", name: "g" } } }], connections: {}, settings: { executionOrder: "v1" } });
  assert.match(def.steps["New file"].poll.tool.args.query, /parentId = '0Bfolder' and trashed = false/);
});

test("Notion: search titles, fetched pages, query rows and fetched data sources", () => {
  const search = adaptResult(map("n8n-nodes-base.notion", ">=2", "page", "search").result, { results: [{ id: "3e42d1cf-c124-80e0-ae8e-f3305621cded", title: "Roadmap", url: "https://app.notion.com/p/3e42d1cfc12480e0ae8ef3305621cded?pvs=204", type: "page" }], type: "workspace_search" });
  assert.equal(search[0].name, "Roadmap");
  const page = notionPage({ metadata: { type: "page" }, title: "Roadmap", url: "https://app.notion.com/p/3e42d1cfc12480e0ae8ef3305621cded?pvs=204", text: "<page>…</page>", icon: null, cover: null, page_last_edited_at: "2026-11-17T15:17:00.000Z" });
  assert.deepEqual(page, { object: "page", id: "3e42d1cf-c124-80e0-ae8e-f3305621cded", name: "Roadmap", url: "https://app.notion.com/p/3e42d1cfc12480e0ae8ef3305621cded?pvs=204", icon: null, cover: null, last_edited_time: "2026-11-17T15:17:00.000Z" });
  const rows = notionRows({ results: [{ Status: "Done", "date:Due date:start": "2026-09-28", "date:Due date:is_datetime": 0, Assignee: '["user://1"]', Name: "Ship it", url: "https://app.notion.com/p/3fe2d1cfc12480d2a322e0cf4da7e58e" }], has_more: false });
  assert.deepEqual(rows.results[0], { id: "3fe2d1cf-c124-80d2-a322-e0cf4da7e58e", url: "https://app.notion.com/p/3fe2d1cfc12480d2a322e0cf4da7e58e", property_status: "Done", property_due_date: { start: "2026-09-28", end: null }, property_assignee: '["user://1"]', property_name: "Ship it" });
  const state = { name: "Tasks", schema: { Name: { name: "Name", type: "title" }, Status: { name: "Status", type: "status" } }, url: "collection://3de2d1cf-c124-80cb-a4a3-000b2e44914f" };
  const db = notionDatabase({ metadata: { type: "data_source" }, title: "Tasks", url: "https://app.notion.com/p/3de2d1cfc12480e49791cfe3f327ef93?pvs=204", text: `<data-source url="{{collection://3de2d1cf-c124-80cb-a4a3-000b2e44914f}}">\n<data-source-state>\n${JSON.stringify(state)}\n</data-source-state>\n</data-source>` });
  assert.equal(db.id, "3de2d1cf-c124-80e4-9791-cfe3f327ef93");
  assert.equal(db.title[0].plain_text, "Tasks");
  assert.deepEqual(Object.keys(db.properties), ["Name", "Status"]);
});

test("a session without the step's tool: the failure names the fix", async () => {
  const { missingToolHint } = await import("../skills/n8n-to-claude/runtime/src/driver.mjs");
  assert.match(missingToolHint("Error: No such tool available: mcp__Notion__notion-search"), /^Error: No such tool available: mcp__Notion__notion-search \(the session has no such tool: check that the connector is attached/);
  assert.equal(missingToolHint("rate limited"), "rate limited");
});

test("cloud tasks name connector tools after the routine's connection", async () => {
  const { cloudPrefix } = await import("../skills/n8n-to-claude/scripts/convert.mjs");
  assert.deepEqual(["mcp__claude_ai_Notion__", "mcp__claude_ai_Google_Drive__", "mcp__claude_ai_Atlassian_MCP__"].map(cloudPrefix), ["mcp__Notion__", "mcp__Google-Drive__", "mcp__Atlassian-MCP__"]);
});
