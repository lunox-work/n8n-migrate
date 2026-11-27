// Google Calendar over its REST API (runtime/src/rest.mjs googleCalendar, n8n-nodes-base 2.47
// GoogleCalendar.node.ts v1–1.4) and node tools mapped to REST carried into an agent's tool
// list: the converter keeps them, the runner makes n8n's requests with the model's $fromAI()
// values and feeds the items' JSON back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { convertItems, loadReferences } from "../skills/n8n-to-claude/scripts/convert.mjs";
import { loadInput } from "../skills/n8n-to-claude/scripts/analyze.mjs";
import { preflight, run } from "../skills/n8n-to-claude/runtime/src/api.mjs";

const refs = loadReferences();
const CLOCK = { startedAt: "2026-11-16T09:00:00Z" };
const LC = "@n8n/n8n-nodes-langchain.";

function convertJson(wf) {
  const dir = mkdtempSync(join(tmpdir(), "n8m-cal-"));
  const p = join(dir, "wf.json");
  writeFileSync(p, JSON.stringify(wf));
  const loaded = loadInput(p);
  rmSync(dir, { recursive: true, force: true });
  return convertItems(loaded.items, { refs, now: Date.parse("2026-11-14T00:00:00Z"), forceConvert: true })[0].definition;
}

// A calendar host: events pages by pageToken; records every request.
function calendarHost(pages, created = {}) {
  const seen = [];
  return {
    seen,
    http: async (q) => {
      const u = new URL(q.url);
      seen.push({ method: q.method, path: u.pathname, query: q.query, body: q.body, auth: q.auth?.secret });
      if (q.method === "POST") return { status: 200, body: { id: "new1", ...q.body, ...created } };
      if (q.method === "DELETE") return { status: 204, body: "" };
      const k = q.query?.pageToken ?? "";
      return { status: 200, body: pages[k] ?? { items: [] } };
    },
  };
}

const calendarTool = (name, v, params) => ({ parameters: params, name, type: "n8n-nodes-base.googleCalendarTool", typeVersion: v, position: [0, 200], credentials: { googleCalendarOAuth2Api: { id: "1", name: "Cal" } } });
const agentWf = (tools, settings = {}) => ({
  id: "cal01",
  name: "Calendar agent",
  nodes: [
    { parameters: {}, name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0] },
    { parameters: { promptType: "define", text: "={{ $json.q }}", options: {} }, name: "Agent", type: LC + "agent", typeVersion: 1.7, position: [200, 0] },
    { parameters: { model: "gpt-4o", options: {} }, name: "Model", type: LC + "lmChatOpenAi", typeVersion: 1, position: [100, 200] },
    ...tools,
  ],
  connections: {
    Start: { main: [[{ node: "Agent", type: "main", index: 0 }]] },
    Model: { ai_languageModel: [[{ node: "Agent", type: "ai_languageModel", index: 0 }]] },
    ...Object.fromEntries(tools.map((t) => [t.name, { ai_tool: [[{ node: "Agent", type: "ai_tool", index: 0 }]] }])),
  },
  settings: { executionOrder: "v1", ...settings },
});

test("a Google Calendar tool (v1.2, $fromAI dates) is an agent tool over REST: n8n's query, the events fed back", async () => {
  const wf = agentWf(
    [
      calendarTool("Get Events", 1.2, { operation: "getAll", calendar: { __rl: true, mode: "list", value: "ann%40x.test" }, options: { timeMin: "={{ $fromAI('start_date') }}", timeMax: "={{ $fromAI('end_date') }}" }, descriptionType: "manual", toolDescription: "Read events" }),
      calendarTool("Create Event", 1.2, { operation: "create", calendar: { __rl: true, mode: "id", value: "ann@x.test" }, start: "={{ $fromAI('start') }}", end: "={{ $fromAI('end') }} ", useDefaultReminders: false, additionalFields: { summary: "={{ $fromAI('title') }}", attendees: [] } }),
    ],
    { timezone: "Europe/Paris" },
  );
  const def = convertJson(wf);
  assert.deepEqual(
    def.steps.Agent.agent.tools.map((t) => [t.name, t.kind, t.effect, t.inputSchema.required]),
    [
      ["Get_Events", "rest", "read", ["start_date", "end_date"]],
      ["Create_Event", "rest", "write", ["start", "end", "title"]],
    ],
  );
  assert.deepEqual(def.allow.http, [
    { method: "GET", host: "www.googleapis.com", pathPrefix: "/calendar/v3/calendars/" },
    { method: "POST", host: "www.googleapis.com", pathPrefix: "/calendar/v3/calendars/" },
  ]);
  assert.deepEqual(def.secrets, [{ name: "Cal", credentialType: "googleCalendarOAuth2Api", hosts: ["www.googleapis.com"] }]);
  assert.equal(preflight(def).ok, true, JSON.stringify(preflight(def).issues));

  const events = [{ id: "e1", summary: "Stand-up", start: { dateTime: "2026-11-17T09:30:00+01:00" } }];
  const host = calendarHost({ "": { items: events } });
  let fed;
  host.agent = async (p) => {
    if (p.turn === 0) return { intent: "tool-calls", calls: [{ name: "Get_Events", args: { start_date: "2026-11-17 00:00:00", end_date: "2026-11-17 23:59:59" } }, { name: "Create_Event", args: { start: "2026-11-17 15:00:00", end: "2026-11-17 15:30:00", title: "Call" } }] };
    fed = p.transcript[0].results;
    return "done";
  };
  const r = await run(def, { clock: CLOCK, virtualTime: true, trigger: { node: "Start", items: [{ json: { q: "Tuesday?" } }] }, host });
  assert.equal(r.status, "done", JSON.stringify(r.error));
  const [get, post] = host.seen;
  assert.equal(get.path, "/calendar/v3/calendars/ann@x.test/events", "a stored-encoded id is decoded once (v < 1.4), @ stays as n8n's requestPath leaves it");
  assert.deepEqual(get.query, { timeMax: "2026-11-17T22:59:59Z", timeMin: "2026-11-16T23:00:00Z", maxResults: 50 });
  assert.equal(get.auth, "Cal");
  assert.deepEqual(fed[0], { name: "Get_Events", ok: true, value: events[0] });
  assert.equal(post.path, "/calendar/v3/calendars/ann@x.test/events");
  assert.deepEqual(post.body, {
    start: { dateTime: "2026-11-17T14:00:00Z", timeZone: "Europe/Paris" },
    // "2026-11-17 15:30:00 " (the template's trailing space) is not ISO for moment: it falls back to Date(... UTC).
    end: { dateTime: "2026-11-17T15:30:00Z", timeZone: "Europe/Paris" },
    attendees: [],
    summary: "Call",
    reminders: { useDefault: false },
    recurrence: [],
  });
});

test("getAll v1.3 with returnAll pages by pageToken (maxResults 100, singleEvents) and orders keys as n8n does", async () => {
  const wf = agentWf([calendarTool("Cal", 1.3, { operation: "getAll", returnAll: true, calendar: { __rl: true, mode: "id", value: "me@x.test" }, timeMin: "={{ $now.minus(1, 'day').toISO() }}", timeMax: "2026-12-01T00:00:00+00:00", options: {} })]);
  const def = convertJson(wf);
  assert.equal(def.steps.Agent.agent.tools[0].kind, "rest");
  const host = calendarHost({ "": { items: [{ updated: "u", summary: "A", id: "1" }], nextPageToken: "p2" }, p2: { items: [{ id: "2" }], nextPageToken: "" } });
  let fed;
  host.agent = async (p) => (p.turn === 0 ? { intent: "tool-calls", calls: [{ name: "Cal", args: {} }] } : ((fed = p.transcript[0].results[0]), "ok"));
  const r = await run(def, { clock: CLOCK, virtualTime: true, trigger: { node: "Start", items: [{ json: { q: "free?" } }] }, host });
  assert.equal(r.status, "done", JSON.stringify(r.error));
  assert.deepEqual(
    host.seen.map((s) => s.query),
    [
      { timeMin: "2026-11-15T09:00:00Z", timeMax: "2026-12-01T00:00:00+00:00", singleEvents: true, maxResults: 100 },
      { timeMin: "2026-11-15T09:00:00Z", timeMax: "2026-12-01T00:00:00+00:00", singleEvents: true, maxResults: 100, pageToken: "p2" },
    ],
  );
  assert.deepEqual(fed.value, [{ id: "1", summary: "A", updated: "u" }, { id: "2" }]);
  assert.deepEqual(Object.keys(fed.value[0]), ["id", "summary", "updated"]);
});

test("a recurring event in a v1.2 getAll fails the tool call (no RRULE engine) instead of differing silently", async () => {
  const wf = agentWf([calendarTool("Cal", 1.2, { operation: "getAll", calendar: { __rl: true, mode: "id", value: "me@x.test" }, options: {} })]);
  const def = convertJson(wf);
  const host = calendarHost({ "": { items: [{ id: "r", recurrence: ["RRULE:FREQ=WEEKLY"] }] } });
  let fed;
  host.agent = async (p) => (p.turn === 0 ? { intent: "tool-calls", calls: [{ name: "Cal", args: {} }] } : ((fed = p.transcript[0].results[0]), "ok"));
  const r = await run(def, { clock: CLOCK, virtualTime: true, trigger: { node: "Start", items: [{ json: { q: "x" } }] }, host });
  assert.equal(r.status, "done");
  assert.equal(fed.ok, false);
  assert.match(fed.error.message, /next occurrence/);
});

test("a Google Calendar step (not a tool) runs the same program; an empty calendar id fails as n8n's requestPath does", async () => {
  const wf = {
    id: "cal02",
    name: "Calendar step",
    nodes: [
      { parameters: {}, name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0] },
      { parameters: { operation: "delete", calendar: { __rl: true, mode: "id", value: "={{ $json.cal }}" }, eventId: "={{ $json.ev }}", options: {} }, name: "Delete", type: "n8n-nodes-base.googleCalendar", typeVersion: 1.3, position: [200, 0], credentials: { googleCalendarOAuth2Api: { id: "1", name: "Cal" } } },
    ],
    connections: { Start: { main: [[{ node: "Delete", type: "main", index: 0 }]] } },
    settings: { executionOrder: "v1" },
  };
  const def = convertJson(wf);
  assert.equal(def.steps.Delete.rest.program, "googleCalendar");
  assert.equal(preflight(def).ok, true, JSON.stringify(preflight(def).issues));
  const host = calendarHost({});
  const r = await run(def, { clock: CLOCK, virtualTime: true, trigger: { node: "Start", items: [{ json: { cal: "me@x.test", ev: "e 1" } }] }, host });
  assert.equal(r.status, "done", JSON.stringify(r.error));
  assert.deepEqual(host.seen.map((s) => `${s.method} ${s.path}`), ["DELETE /calendar/v3/calendars/me@x.test/events/e%201"]);
  assert.deepEqual(r.runData.Delete[0].data.main[0].map((i) => i.json), [{ success: true }]);
  const bad = await run(def, { clock: CLOCK, virtualTime: true, trigger: { node: "Start", items: [{ json: { cal: "", ev: "e1" } }] }, host: calendarHost({}) });
  assert.equal(bad.status, "failed");
  assert.match(bad.error.message, /Invalid identifier: "" is not allowed/);
});

test("an X tweet (Twitter node v2, tweet create) is one request template: POST api.x.com/2/tweets {text}, the reply's data as the item", async () => {
  const wf = {
    id: "x01",
    name: "Tweet",
    nodes: [
      { parameters: {}, name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0] },
      { parameters: { text: "={{ $json.t }}", additionalFields: {} }, name: "Post tweet", type: "n8n-nodes-base.twitter", typeVersion: 2, position: [200, 0], credentials: { twitterOAuth2Api: { id: "1", name: "X" } } },
    ],
    connections: { Start: { main: [[{ node: "Post tweet", type: "main", index: 0 }]] } },
    settings: { executionOrder: "v1" },
  };
  const def = convertJson(wf);
  assert.deepEqual(def.allow.http, [{ method: "POST", host: "api.x.com", pathPrefix: "/2/tweets" }]);
  assert.equal(preflight(def).ok, true, JSON.stringify(preflight(def).issues));
  const seen = [];
  const host = { http: async (q) => (seen.push(q), { status: 201, headers: { "content-type": "application/json" }, body: JSON.stringify({ data: { id: "19", text: "hi", edit_history_tweet_ids: ["19"] } }) }) };
  const r = await run(def, { clock: CLOCK, virtualTime: true, trigger: { node: "Start", items: [{ json: { t: "hi" } }] }, host });
  assert.equal(r.status, "done", JSON.stringify(r.error));
  assert.equal(seen[0].url, "https://api.x.com/2/tweets");
  assert.deepEqual(seen[0].body, { text: "hi" });
  assert.equal(seen[0].auth.secret, "X");
  assert.deepEqual(r.runData["Post tweet"][0].data.main[0].map((i) => i.json), [{ id: "19", text: "hi", edit_history_tweet_ids: ["19"] }]);
});
