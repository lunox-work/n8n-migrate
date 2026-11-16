// Real limits of connector tools, enforced by the mock MCP server (evals/mocks/mcp-server.mjs)
// and the in-process mock host (tests/convert-mocks.mjs), so the bench fails an over-long post
// or an oversized page the real connector would refuse or cut. Only limits with a source:
//   - Slack chat.postMessage: text is truncated after 40,000 characters (Slack API docs,
//     "Truncating content"); the mock refuses instead, so a long digest is caught.
//   - Gmail search_threads: "The maximum allowed value is 50" for pageSize, default 20 (the
//     captured tool description); the mock refuses pageSize > 50 and returns at most pageSize
//     threads with a nextPageToken when it cut the list.

import { gmailSentMessage } from "../n8n/mock-server.mjs";

export const LIMITS = {
  "slack.slack_send_message": { maxChars: { message: 40_000 } },
  "slack.slack_send_message_draft": { maxChars: { message: 40_000 } },
  "slack.slack_schedule_message": { maxChars: { message: 40_000 } },
  "gmail.search_threads": { max: { pageSize: 50 }, page: { list: "threads", sizeArg: "pageSize", default: 20, token: "nextPageToken" } },
};

// Errors for arguments over a known limit ([] when none).
export function limitErrors(connector, tool, args = {}) {
  const l = LIMITS[`${connector}.${tool}`];
  if (!l) return [];
  const out = [];
  for (const [k, n] of Object.entries(l.maxChars ?? {})) if (typeof args[k] === "string" && args[k].length > n) out.push(`${k} is ${args[k].length} characters; ${connector}.${tool} takes at most ${n}`);
  for (const [k, n] of Object.entries(l.max ?? {})) if (typeof args[k] === "number" && args[k] > n) out.push(`${k} is ${args[k]}; ${connector}.${tool} allows at most ${n}`);
  return out;
}

// PROPOSALS P33: calls the real service refuses whatever the fixture says, as P29's
// serviceRefusal() does for the REST send. Gmail sends nothing without a recipient (the API's
// 400 "Recipient address required"); the connector's answer to such a call is not captured,
// so the refusal carries the API's message and is marked assumed in the mock's log:
//   - reply: `to` given and empty (the schema: "If specified, overrides the default reply
//     recipients") with no address in cc or bcc; an absent `to` keeps the default recipients.
//   - send_message: no address in to, cc or bcc and no draftId ("Required if draftId is not
//     provided").
//   - forward: no address in to, cc or bcc.
// Returns the refusal message or null.
const addresses = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]).filter((x) => typeof x === "string" && x.trim());
export function connectorRefusal(connector, tool, args = {}) {
  if (connector !== "gmail") return null;
  const any = ["to", "cc", "bcc"].some((k) => addresses(args?.[k]).length);
  const none = "Recipient address required (assumed: the Gmail API's refusal; the connector's answer is not captured)";
  if (tool === "reply") return Array.isArray(args?.to) && !any ? none : null;
  if (tool === "send_message") return !any && !args?.draftId ? none : null;
  if (tool === "forward") return !any ? none : null;
  return null;
}

// A canned or fixture result cut to the page size the real tool returns.
export function pageResult(connector, tool, args = {}, result) {
  const p = LIMITS[`${connector}.${tool}`]?.page;
  if (!p || !result || typeof result !== "object" || !Array.isArray(result[p.list])) return result;
  const size = Math.min(Number(args[p.sizeArg] ?? p.default) || p.default, LIMITS[`${connector}.${tool}`].max?.[p.sizeArg] ?? Infinity);
  if (result[p.list].length <= size) return result;
  return { ...result, [p.list]: result[p.list].slice(0, size), [p.token]: result[p.token] ?? `mock-page-${size}` };
}

// PROPOSALS P109: the answer to a call no fixture row answers, where the real service's answer
// is known and reaches a run's output. Gmail's send_message sends through users.messages.send,
// whose answer is the sent message's resource {id, threadId, labelIds: ["SENT"]}; the connector's
// own answer is not captured, so this is the API's (as n8n's Gmail node outputs it), with the
// ids of the n-th send of the run, the same as the HTTP mock's (mock-server.mjs serviceAnswer).
// `n` is the 1-based count of such default answers so far. Anything else: {"ok": true}.
export function connectorDefault(connector, tool, args = {}, n = 1) {
  if (connector === "gmail" && tool === "send_message") return gmailSentMessage(n);
  return { ok: true };
}
export const countsAsSend = (connector, tool) => connector === "gmail" && tool === "send_message";
