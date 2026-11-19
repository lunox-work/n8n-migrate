// Gmail reply recipients: n8n's Gmail reply (v2.x) addresses the reply from the replied-to
// message's headers (From, plus Reply-To from node 2.2 when present). The connector's reply
// tool picks its own default recipients (assumed: it may follow Reply-To), so the runner reads
// the message with get_message and passes `to` explicitly. A hostile Reply-To on a v2.1 step
// therefore never receives the reply.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { convertItems, loadReferences } from "../skills/n8n-migrate/scripts/convert.mjs";
import { loadInput } from "../skills/n8n-migrate/scripts/analyze.mjs";
import { preflight, run } from "../skills/n8n-migrate/runtime/src/api.mjs";

const refs = loadReferences();
const CLOCK = { startedAt: "2026-11-16T09:00:00Z" };

function convertJson(wf) {
  const dir = mkdtempSync(join(tmpdir(), "n8m-reply-"));
  const p = join(dir, "wf.json");
  writeFileSync(p, JSON.stringify(wf));
  const loaded = loadInput(p);
  rmSync(dir, { recursive: true, force: true });
  return convertItems(loaded.items, { refs, now: Date.parse("2026-11-14T00:00:00Z"), forceConvert: true })[0].definition;
}

const replyWf = (v, options = {}) => ({
  id: "reply01",
  name: "Reply",
  nodes: [
    { parameters: {}, name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0] },
    { parameters: { operation: "reply", messageId: "={{ $json.id }}", message: "Thanks, booked.", options }, name: "Send reply", type: "n8n-nodes-base.gmail", typeVersion: v, position: [200, 0], credentials: { gmailOAuth2: { id: "1", name: "Gmail" } } },
  ],
  connections: { Start: { main: [[{ node: "Send reply", type: "main", index: 0 }]] } },
  settings: { executionOrder: "v1" },
});

// The connector's message row: a lookalike sender and a hostile Reply-To.
const MESSAGE = { id: "m1", subject: "Meeting", sender: "dana@northwind.example.co", replyTo: "assistant@evil.example", toRecipients: ["dana@northwind.example"] };
function gmailHost(message = MESSAGE) {
  const calls = [];
  return {
    calls,
    tool: async (p) => {
      calls.push({ tool: p.tool, args: p.args });
      if (p.tool === "get_message") return message;
      return { id: "sent1", threadId: "m1" };
    },
  };
}

test("v2.1 reply: the runner reads the message and replies to its sender, never to its Reply-To", async () => {
  const def = convertJson(replyWf(2.1));
  const step = def.steps["Send reply"];
  assert.deepEqual(step.tool.recipients, { tool: "get_message", idArg: "messageId", arg: "to", from: ["sender", "from", "From"] });
  assert.equal(step.tool.args.replyAll, undefined, "n8n's replyToSenderOnly is not mapped onto the tool's replyAll");
  assert.ok(def.allow.tools.some((t) => t.connector === "gmail" && t.tool === "get_message"));
  assert.ok(step.tool.caveats.some((c) => /sender only/.test(c)), "the other To recipients n8n would add are named as a caveat");
  assert.equal(preflight(def).ok, true, JSON.stringify(preflight(def).issues));
  const host = gmailHost();
  const r = await run(def, { clock: CLOCK, virtualTime: true, trigger: { node: "Start", items: [{ json: { id: "m1" } }] }, host });
  assert.equal(r.status, "done", JSON.stringify(r.error));
  assert.deepEqual(host.calls.map((c) => c.tool), ["get_message", "reply"]);
  assert.deepEqual(host.calls[0].args, { messageId: "m1" });
  assert.deepEqual(host.calls[1].args.to, ["dana@northwind.example.co"]);
  assert.equal(host.calls[1].args.messageId, "m1");
});

test("v2.2 reply follows the message's Reply-To as n8n 2.2 does, flagged because the connector field is assumed; senderOnly drops the caveat", async () => {
  const def = convertJson(replyWf(2.2, { replyToSenderOnly: true }));
  const step = def.steps["Send reply"];
  assert.deepEqual(step.tool.recipients.replyTo, ["replyTo", "reply-to", "Reply-To"]);
  assert.ok(step.reviewReasons.some((x) => /Reply-To/.test(x)));
  assert.ok(!(step.tool.caveats ?? []).some((c) => /sender only/.test(c)));
  const host = gmailHost();
  const r = await run(def, { clock: CLOCK, virtualTime: true, trigger: { node: "Start", items: [{ json: { id: "m1" } }] }, host });
  assert.equal(r.status, "done", JSON.stringify(r.error));
  assert.deepEqual(host.calls[1].args.to, ["assistant@evil.example"]);
  const noReplyTo = gmailHost({ id: "m1", payload: { headers: [{ name: "From", value: '"Ann Lee" <ann@x.test>' }] } });
  const r2 = await run(def, { clock: CLOCK, virtualTime: true, trigger: { node: "Start", items: [{ json: { id: "m1" } }] }, host: noReplyTo });
  assert.equal(r2.status, "done", JSON.stringify(r2.error));
  assert.deepEqual(noReplyTo.calls[1].args.to, ["ann@x.test"], "REST-shaped headers and a display name are read too");
});

test("a message without any sender address is answered with an empty recipient list, as n8n's request has none; the connector never chooses", async () => {
  const def = convertJson(replyWf(2.1));
  const host = gmailHost({ id: "m1", subject: "x" });
  const r = await run(def, { clock: CLOCK, virtualTime: true, trigger: { node: "Start", items: [{ json: { id: "m1" } }] }, host });
  assert.equal(r.status, "done", JSON.stringify(r.error));
  assert.deepEqual(host.calls.map((c) => c.tool), ["get_message", "reply"]);
  assert.deepEqual(host.calls[1].args.to, []);
});
