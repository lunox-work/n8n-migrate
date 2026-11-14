// Real limits of connector tools, enforced by the mock MCP server (evals/mocks/mcp-server.mjs)
// and the in-process mock host (tests/convert-mocks.mjs), so the bench fails an over-long post
// or an oversized page the real connector would refuse or cut. Only limits with a source:
//   - Slack chat.postMessage: text is truncated after 40,000 characters (Slack API docs,
//     "Truncating content"); the mock refuses instead, so a long digest is caught.
//   - Gmail search_threads: "The maximum allowed value is 50" for pageSize, default 20 (the
//     captured tool description); the mock refuses pageSize > 50 and returns at most pageSize
//     threads with a nextPageToken when it cut the list.

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

// A canned or fixture result cut to the page size the real tool returns.
export function pageResult(connector, tool, args = {}, result) {
  const p = LIMITS[`${connector}.${tool}`]?.page;
  if (!p || !result || typeof result !== "object" || !Array.isArray(result[p.list])) return result;
  const size = Math.min(Number(args[p.sizeArg] ?? p.default) || p.default, LIMITS[`${connector}.${tool}`].max?.[p.sizeArg] ?? Infinity);
  if (result[p.list].length <= size) return result;
  return { ...result, [p.list]: result[p.list].slice(0, size), [p.token]: result[p.token] ?? `mock-page-${size}` };
}
