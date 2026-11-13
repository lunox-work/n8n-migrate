// Reads tool schemas recorded in a Claude Code transcript (deferred_tools_record
// entries) and writes one mock file per connector. Never calls a tool.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const [transcript, outDir] = process.argv.slice(2);
const CONNECTORS = { Gmail: "gmail", Google_Drive: "google-drive", Slack: "slack", Notion: "notion", Atlassian_MCP: "atlassian", ClickUp: "clickup", HubSpot: "hubspot" };
const schemas = new Map();
const names = new Set();
for (const line of readFileSync(transcript, "utf8").trim().split("\n")) {
  const o = JSON.parse(line);
  const a = o.attachment;
  if (a?.type === "deferred_tools_delta") for (const n of a.addedNames || []) names.add(n);
  if (a?.type === "deferred_tools_record") for (const e of a.entries || []) schemas.set(e.name, e);
}
mkdirSync(outDir, { recursive: true });
// Account-specific identifiers in descriptions (e.g. "user_id is U0...") are redacted.
const redact = (v) => JSON.parse(JSON.stringify(v).replace(/\b(user_id is |user_id is: )U[A-Z0-9]{8,}\b/g, "$1U_REDACTED"));
const trim = (s) => { s = (s || "").replace(/\s+/g, " ").trim(); return s.length > 300 ? s.slice(0, 297) + "..." : s; };
const summary = {};
for (const [seg, file] of Object.entries(CONNECTORS)) {
  const prefix = `mcp__claude_ai_${seg}__`;
  const all = [...names].filter((n) => n.startsWith(prefix)).sort();
  const tools = all.map((full) => {
    const e = schemas.get(full);
    const name = full.slice(prefix.length);
    return e ? { name, description: trim(e.description), inputSchema: e.input_schema } : { name, description: null, inputSchema: null, schemaCaptured: false };
  });
  const captured = tools.filter((t) => t.inputSchema).length;
  const doc = {
    connector: file,
    toolPrefix: prefix,
    capturedAt: "2026-11-14",
    source: "tool schemas visible to a Claude Code session on the author's account, 2026-11-14",
    note: captured < tools.length ? `${captured} of ${tools.length} tools have a captured schema; the rest are listed by name only (schemaCaptured: false). Load them with ToolSearch select: and re-run the extractor to fill them.` : `all ${tools.length} tools captured`,
    tools,
  };
  writeFileSync(join(outDir, `${file}.json`), JSON.stringify(redact(doc), null, 2) + "\n");
  summary[file] = `${captured}/${tools.length}`;
}
console.log(JSON.stringify(summary));
