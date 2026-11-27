// Mock hosts for running converted definitions in-process. Not a test itself.
//
// The tool host checks every call against the tool's captured input schema
// (skills/n8n-to-claude/references/connectors) and answers with a canned output per tool.
// The canned outputs are plausible readings of the tool descriptions, not captured
// responses: the result adapters they exercise are marked `unverified` for that reason.
// The model host answers deterministically.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connectorRefusal, limitErrors, pageResult } from "../evals/mocks/limits.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemas = {};
for (const c of ["gmail", "google-drive", "slack", "notion"]) {
  const doc = JSON.parse(readFileSync(join(ROOT, "skills/n8n-to-claude/references/connectors", `${c}.json`), "utf8"));
  for (const t of doc.tools) schemas[`${c}.${t.name}`] = t.inputSchema;
}

// A search for recent mail (newer_than:) is answered with mail from the last hour, as Gmail
// would answer it: the runtime drops thread messages outside the query's dates (tool.window).
// Any other query gets fixed dates, so the cursors the tests compare do not move.
const mailDate = (args, fixed, minutesAgo) => (/(^|\s)newer_than:/.test(args?.query ?? "") ? new Date(Date.now() - minutesAgo * 60000).toISOString() : fixed);
export const CANNED = {
  "gmail.search_threads": (args) => ({
    threads: [
      {
        id: "t1",
        messageCount: 2,
        viewUrl: "https://mail.google.com/mail/u/0/#all/t1",
        messages: [
          { id: "m1", snippet: "Invoice 42: total $250.00 due on 1 Dec", subject: "Invoice 42", sender: "ann@example.com", toRecipients: ["me@example.com"], ccRecipients: [], date: mailDate(args, "2026-11-14T02:30:00Z", 30), labelIds: ["INBOX", "UNREAD"] },
          { id: "m2", snippet: "Small invoice: $40 for the domain", subject: "Re: Invoice 42", sender: "bo@example.com", toRecipients: ["me@example.com", "ann@example.com"], ccRecipients: [], date: mailDate(args, "2026-11-14T02:45:00Z", 15), labelIds: ["INBOX"] },
        ],
      },
    ],
    query: args.query ?? "",
  }),
  // get_message returns the message as search_threads lists it, plus display names (MINIMAL).
  "gmail.get_message": (args) => {
    const m = CANNED["gmail.search_threads"]({}).threads.flatMap((t) => t.messages).find((x) => x.id === args.messageId);
    return m ? { ...m, addressDisplayNames: m.sender === "ann@example.com" ? { "ann@example.com": "Ann Lee" } : {} } : { error: "not found" };
  },
  "slack.slack_send_message": (args) => ({ channel: args.channel_id, ts: "1763100000.000100", message_link: `https://example.slack.com/archives/${args.channel_id}/p1763100000000100` }),
};

export function toolHost(log = []) {
  return async (p) => {
    const key = `${p.connector}.${p.tool}`;
    const schema = schemas[key];
    if (!schema) throw new Error(`mock: no captured schema for ${key}`);
    const missing = (schema.required ?? []).filter((k) => p.args?.[k] === undefined);
    const unknown = Object.keys(p.args ?? {}).filter((k) => !(k in (schema.properties ?? {})));
    if (missing.length || unknown.length) throw new Error(`mock: ${key} args do not fit the schema (missing ${missing.join(",")}; unknown ${unknown.join(",")})`);
    for (const [k, v] of Object.entries(p.args ?? {})) {
      const t = [].concat(schema.properties[k].type ?? [])[0];
      const actual = Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
      if (t && !(t === actual || (t === "number" && actual === "integer"))) throw new Error(`mock: ${key}.${k} should be ${t}, got ${actual}`);
    }
    const over = limitErrors(p.connector, p.tool, p.args);
    if (over.length) throw new Error(`mock: ${key}: ${over.join("; ")}`);
    const refused = connectorRefusal(p.connector, p.tool, p.args);
    if (refused) throw new Error(`mock: ${key}: ${refused}`);
    log.push({ tool: key, args: p.args });
    return pageResult(p.connector, p.tool, p.args, (CANNED[key] ?? (() => ({ ok: true })))(p.args ?? {}));
  };
}

export const modelHost = (log = []) => async (p) => {
  log.push(p);
  return `Summary: ${String(p.prompt ?? p.messages?.at(-1)?.content ?? "").split("\n")[0].slice(0, 40)}`;
};
