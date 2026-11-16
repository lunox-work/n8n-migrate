// Bench changes of round 5 batch 2 (R5b2): P123 (a Code node's native Date runs in n8n's task
// runner zone on the Claude side too), P124 (a model input that differs only in fields the tool
// map says the connector cannot give is connector-limited), P128 (a Gmail send's write reply
// fixtured over HTTP answers the connector's send_message too), P127 (corpus.json's frozen
// draw-day verdicts beside today's analyzer).

import { test } from "node:test";
import assert from "node:assert/strict";
import { CODE_NODE_TZ, connectorFixtures, connectorGapFields, gmailSendCalls, sameNormInput, stripJsonMembers } from "../evals/bench/claude-side.mjs";
import { sessionEnv } from "../evals/bench/claude-driver.mjs";
import { connectorLimited, gate4 } from "../evals/bench/gates.mjs";
import { keepDrawDay, refreshCurrent, setCurrent, currentVerdict } from "../evals/bench/fetch.mjs";

test("P123: the claude driver's session and the in-process run use n8n's Code-node zone", () => {
  assert.equal(CODE_NODE_TZ, "UTC");
  assert.equal(sessionEnv({ base: { TZ: "Asia/Singapore" } }).TZ, "UTC");
});

test("P124: JSON members taken out, plain and as escaped JSON, with their comma", () => {
  const plain = stripJsonMembers('{"a":"x, }","payload":{"m":"a/b","l":[1,{"y":"}"}]},"size":5120,"b":"\\"q\\""}', ["payload", "size"]);
  assert.deepEqual(plain, { text: '{"a":"x, }","b":"\\"q\\""}', removed: ["payload", "size"] });
  assert.deepEqual(stripJsonMembers('{\\"a\\":1,\\"payload\\":{\\"m\\":\\"x\\"}}', ["payload"]), { text: '{\\"a\\":1}', removed: ["payload"] });
  assert.deepEqual(stripJsonMembers('{"a":1}', ["payload"]), { text: '{"a":1}', removed: [] });
});

test("P124: gap fields come from connector reads only, never a write's returned ids", () => {
  const def = { steps: { T: { kind: "trigger", poll: { missingFields: ["payload"] } }, R: { kind: "tool", tool: { effect: "read", missingFields: ["labels"] } }, W: { kind: "tool", tool: { effect: "write", missingFields: ["id"] } } } };
  assert.deepEqual(connectorGapFields(def), [
    { node: "T", field: "payload" },
    { node: "R", field: "labels" },
  ]);
});

const call = (text) => ({ format: "openai", request: { messages: [{ role: "user", content: text }] } });
const claude = (text) => ({ system: "", messages: [{ role: "user", text }] });

test("P124: a model input that differs only in gap fields still differs, and says so", () => {
  const gaps = [{ node: "T", field: "payload" }];
  const r = sameNormInput(call('Mail: {"id":"1","payload":{"mimeType":"a"},"From":"x"}'), claude('Mail: {"id":"1","From":"x"}'), null, gaps);
  assert.equal(r.same, false);
  assert.deepEqual(r.gapOnly, gaps);
  const other = sameNormInput(call('Mail: {"id":"1","payload":{"mimeType":"a"},"From":"x"}'), claude('Mail: {"id":"2","From":"x"}'), null, gaps);
  assert.equal(other.same, false);
  assert.equal(other.gapOnly, undefined, "another difference left: not connector-limited");
  assert.equal(sameNormInput(call('Mail: {"id":"1"}'), claude('Mail: {"id":"1"}'), null, gaps).same, true);
});

test("P124: gate 4 marks entries connectorGap only when every differing input is gap-only, and connectorLimited reads it", () => {
  const cmp = { unmapped: [], writes: { missing: [], extra: [], fieldDiffs: [], matched: [] }, reads: { onlyN8n: [], onlyClaude: [] } };
  const gap = { same: false, at: "a", n8nAround: "b", gapOnly: [{ node: "T", field: "payload" }] };
  const g = gate4({ cmp, n8nStatus: "success", modelInputs: [{ step: "Agent", index: 0, input: gap }] });
  assert.equal(g.bucket, "field map");
  assert.deepEqual(connectorLimited(g, 4, [], null), [{ node: "T", field: "payload", text: "payload (tool map missingFields)" }]);
  const mixed = gate4({ cmp, n8nStatus: "success", modelInputs: [{ step: "Agent", index: 0, input: gap }, { step: "Agent", index: 1, input: { same: false, at: "c", n8nAround: "d" } }] });
  assert.equal(mixed.detail[0].connectorGap, undefined);
  assert.equal(connectorLimited(mixed, 4, [], null), null);
});

test("P128: a Gmail send reply fixtured over HTTP only answers send_message for its node", () => {
  const body = { id: "19a8f3b2c4d5e601", threadId: "19a8f3b2c4d5e601", labelIds: ["SENT"] };
  const fx = {
    reads: [],
    writeReplies: [
      { node: "Send", http: { responses: [{ method: "POST", url: "https://www.googleapis.com/gmail/v1/users/me/messages/send", status: 200, body }] } },
      { node: "Own", connector: { connector: "gmail", calls: [{ tool: "send_message", result: { id: "x" } }] }, http: { responses: [{ method: "POST", url: "https://www.googleapis.com/gmail/v1/users/me/messages/send", body: { id: "y" } }] } },
      { node: "Other", http: { responses: [{ method: "POST", url: "https://api.example.com/gmail/v1/users/me/messages/send", body }] } },
    ],
  };
  assert.deepEqual(gmailSendCalls(fx), [{ tool: "send_message", result: body, node: "Send", derived: "gmail-send-reply" }]);
  assert.deepEqual(
    connectorFixtures(fx)["gmail.send_message"].map((c) => c.node),
    ["Own", "Send"],
  );
});

const report = (kind, target = null, wakeup = "schedule") => ({ outcome: { kind, target }, wakeup: { kind: wakeup } });

test("P127: a rebuild keeps every draw-day field of an entry it already holds; only current* is today's", () => {
  const prev = { rank: 1053, id: 7, topUp: 5, outcome: "keep-in-n8n", target: null, wakeup: "manual", r4: "ineligible", r4Reasons: ["outcome: keep-in-n8n"], pool: "fresh-other" };
  const today = { rank: 1053, id: 7, topUp: 5, outcome: "subscription", target: "cloud-task", wakeup: "manual", r4: "eligible", pool: "fresh" };
  const e = keepDrawDay(today, { ...prev });
  assert.deepEqual(e, { ...prev, currentOutcome: "subscription", currentTarget: "cloud-task", currentWakeup: "manual" });
  assert.equal(currentVerdict(e).outcome, "subscription");
  const same = keepDrawDay({ ...prev, r4: "eligible" }, { ...prev });
  assert.deepEqual(same, prev, "today's verdict equal to the draw day's leaves no current* fields");
  const fresh = keepDrawDay({ id: 8, outcome: "hosted", target: "hosted", wakeup: "chat", pool: "fresh-other" }, undefined);
  assert.deepEqual(fresh, { id: 8, outcome: "hosted", target: "hosted", wakeup: "chat", pool: "fresh-other" }, "a new entry's draw day is today");
  const notAnalyzed = keepDrawDay({ id: 9, excluded: "paid" }, { id: 9, excluded: "paid", currentOutcome: "x" });
  assert.equal(notAnalyzed.currentOutcome, "x", "an entry today's walk did not analyze keeps its last current*");
});

test("P127: refreshCurrent writes current* only, skips held-out ids and entries never analyzed", () => {
  const templates = [
    { id: 1, outcome: "keep-in-n8n", target: null, wakeup: "schedule", pool: "refusal" },
    { id: 2, outcome: "subscription", target: "cloud-task", wakeup: "schedule", pool: "eligible" },
    { id: 3, outcome: "keep-in-n8n", target: null, wakeup: "manual", pool: "fresh-other" },
    { id: 4, excluded: "paid" },
    { id: 5, outcome: "hosted", target: "hosted", wakeup: "chat" },
  ];
  const before = JSON.parse(JSON.stringify(templates));
  const answers = { 1: report("subscription", "cloud-task"), 2: report("subscription", "cloud-task"), 3: report("subscription", "cloud-task", "manual") };
  const n = refreshCurrent(templates, (e) => answers[e.id] ?? null, new Set([3]));
  assert.deepEqual(n, { analyzed: 2, differ: 1, skipped: 1, missing: 1 });
  assert.deepEqual(templates[0], { ...before[0], currentOutcome: "subscription", currentTarget: "cloud-task", currentWakeup: "schedule" });
  for (const i of [1, 2, 3, 4]) assert.deepEqual(templates[i], before[i]);
  const e = { outcome: "a", target: null, wakeup: "w", currentOutcome: "b", currentTarget: null, currentWakeup: "w" };
  assert.deepEqual(setCurrent(e, report("a", null, "w")), { outcome: "a", target: null, wakeup: "w" }, "a verdict back to the draw day's drops current*");
});
