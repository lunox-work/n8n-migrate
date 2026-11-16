#!/usr/bin/env node
// Mock connector: a zero-dependency stdio MCP server for one connector, for the task-driver
// evals (claude -p against mocks; never a real account).
//
//   node evals/mocks/mcp-server.mjs --connector gmail [--schemas <file>] [--fixtures <file>]
//        [--log <effects.jsonl>]
//
// Tools: exactly the captured tool names and input schemas of the real connector, from
// evals/mocks/connectors/<connector>.json (the full captured list), or --schemas. Register it
// under the server name the real connector has in a Claude session (the file's toolPrefix,
// e.g. mcp__claude_ai_Gmail__ -> server "claude_ai_Gmail"), so the model sees the same tool
// names as with the real connector. `serverName` prints that name.
//
// Fixtures (JSON): {"<connector>": {"<tool>": {"responses": [r, ...], "default": r, "reuse"?: true}}}.
// The n-th call of a tool gets responses[n], then default; with neither, the service's known
// answer (limits.mjs connectorDefault: Gmail send_message's sent message, P109), else
// {"ok": true}. A
// response with `args` is matched to calls first: the first unused one whose args are a
// subset of the call's; with `reuse` (a read: the same arguments answer the same) a used one
// whose args fit comes next; otherwise the first unused response, in order.
// r is {"result": <JSON>} (sent as one text block holding the JSON), {"text": "..."},
// {"error": "message"} (a tool error, isError), or a bare JSON value (same as result).
// Strings of the form "{{args.<name>}}" in a result are replaced by that argument.
//
// Every tools/call is validated against the tool's input schema (type, required,
// properties, enum, items, additionalProperties: false). An invalid call gets a tool error
// and nothing else; an unknown tool gets JSON-RPC error -32602. Known real limits
// (evals/mocks/limits.mjs: Slack message length, Gmail page size) are enforced the same way,
// and a fixture list longer than the tool's page is cut to the page with a nextPageToken. Every call, valid or not, is
// appended to --log as {t, connector, tool, args, valid, error?}.
//
// Protocol: JSON-RPC 2.0, newline-delimited, over stdio: initialize, notifications/initialized,
// ping, tools/list, tools/call. The server answers with the protocol version the client asks
// for when it knows it, else its latest.

import { readFileSync, appendFileSync, existsSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connectorDefault, connectorRefusal, countsAsSend, limitErrors, pageResult } from "./limits.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export function schemaFile(connector) {
  for (const p of [join(HERE, "connectors", `${connector}.json`), join(ROOT, "skills/n8n-to-claude/references/connectors", `${connector}.json`)]) if (existsSync(p)) return p;
  throw new Error(`no captured schemas for connector "${connector}"`);
}

export function serverName(doc) {
  const m = /^mcp__(.+)__$/.exec(doc.toolPrefix ?? "");
  if (!m) throw new Error(`connector file has no toolPrefix of the form mcp__<server>__`);
  return m[1];
}

// ---------- a small JSON Schema check (what tool input schemas use) ----------

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
export function checkSchema(v, s, path = "$", out = []) {
  if (!s || typeof s !== "object") return out;
  if (s.type) {
    const types = [].concat(s.type);
    const t = typeOf(v);
    if (!types.some((x) => x === t || (x === "number" && t === "integer"))) {
      out.push(`${path} should be ${types.join("|")}, got ${t}`);
      return out;
    }
  }
  if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) out.push(`${path} should be one of ${JSON.stringify(s.enum)}`);
  if (s.anyOf && !s.anyOf.some((x) => !checkSchema(v, x, path).length)) out.push(`${path} matches no allowed shape`);
  if (typeOf(v) === "object") {
    for (const k of s.required ?? []) if (v[k] === undefined) out.push(`${path}.${k} is required`);
    for (const [k, x] of Object.entries(v)) {
      if (s.properties?.[k]) checkSchema(x, s.properties[k], `${path}.${k}`, out);
      else if (s.additionalProperties === false) out.push(`${path}.${k} is not allowed`);
      else if (typeof s.additionalProperties === "object") checkSchema(x, s.additionalProperties, `${path}.${k}`, out);
    }
  }
  if (typeOf(v) === "array" && s.items) v.forEach((x, i) => checkSchema(x, s.items, `${path}[${i}]`, out));
  return out;
}

const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
function subset(want, got) {
  if (!isObj(want)) return JSON.stringify(want) === JSON.stringify(got);
  return isObj(got) && Object.entries(want).every(([k, v]) => subset(v, got[k]));
}

function fill(v, args) {
  if (typeof v === "string") {
    const m = /^\{\{args\.([\w.-]+)\}\}$/.exec(v);
    return m ? args?.[m[1]] : v;
  }
  if (Array.isArray(v)) return v.map((x) => fill(x, args));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, args)]));
  return v;
}

export function createServer({ connector, doc, fixtures = {}, log }) {
  const tools = doc.tools.filter((t) => t.inputSchema);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const counts = new Map();
  let sends = 0;
  const mine = fixtures[connector] ?? {};
  const record = (entry) => {
    if (log) appendFileSync(log, JSON.stringify({ t: new Date().toISOString(), connector, ...entry }) + "\n");
  };
  const respond = (tool, args) => {
    const f = mine[tool] ?? {};
    const list = Array.isArray(f.responses) ? f.responses : [];
    if (!counts.has(tool)) counts.set(tool, new Set());
    const used = counts.get(tool);
    const fits = (x) => x && typeof x === "object" && x.args && subset(x.args, args);
    let i = list.findIndex((x, j) => !used.has(j) && fits(x));
    if (i < 0 && f.reuse) i = list.findIndex(fits);
    // PROPOSALS P112: a row whose args give an identifier (`id`, `…Id`, `…_id`) the call carries
    // with another value names another resource and is never a fallback; such a call gets the
    // default. Free-text arguments (a query with the run's time) still fall back.
    const contradicts = (x) => x && typeof x === "object" && isObj(x.args) && isObj(args) && Object.entries(x.args).some(([k, v]) => /^id$|Id$|_id$/.test(k) && args[k] !== undefined && !subset(v, args[k]));
    if (i < 0) i = list.findIndex((x, j) => !used.has(j) && !contradicts(x));
    if (i >= 0) used.add(i);
    let r = i >= 0 ? list[i] : f.default;
    if (r && typeof r === "object" && !Array.isArray(r) && "args" in r && ("result" in r || "text" in r || "error" in r)) {
      const { args: _a, ...rest } = r;
      r = rest;
    }
    // P109: an unanswered call gets the service's known answer (connectorDefault), else {"ok": true}.
    if (r === undefined) r = { result: connectorDefault(connector, tool, args, countsAsSend(connector, tool) ? ++sends : 0) };
    if (r === null || typeof r !== "object" || Array.isArray(r) || !("result" in r || "text" in r || "error" in r)) r = { result: r };
    if ("error" in r) return { content: [{ type: "text", text: String(r.error) }], isError: true };
    if ("text" in r) return { content: [{ type: "text", text: String(fill(r.text, args)) }] };
    return { content: [{ type: "text", text: JSON.stringify(pageResult(connector, tool, args, fill(r.result, args))) }] };
  };
  return function handle(msg) {
    const { id, method, params } = msg ?? {};
    const reply = (result) => ({ jsonrpc: "2.0", id, result });
    const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
    if (id === undefined || id === null) return null; // a notification: no reply
    if (method === "initialize") {
      const asked = params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `n2c-mock-${connector}`, version: "0.1.0" },
        instructions: `Mock ${connector} connector for n8n-to-claude evals. No real account.`,
      });
    }
    if (method === "ping") return reply({});
    if (method === "tools/list") return reply({ tools: tools.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema })) });
    if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const tool = byName.get(name);
      if (!tool) {
        record({ tool: name, args, valid: false, error: "unknown tool" });
        return fail(-32602, `Unknown tool: ${name}`);
      }
      const errors = checkSchema(args, { ...tool.inputSchema, type: "object" });
      if (errors.length) {
        record({ tool: name, args, valid: false, error: errors.join("; ") });
        return reply({ content: [{ type: "text", text: `Invalid arguments for ${name}: ${errors.join("; ")}` }], isError: true });
      }
      const over = limitErrors(connector, name, args);
      if (over.length) {
        record({ tool: name, args, valid: false, error: over.join("; "), limit: true });
        return reply({ content: [{ type: "text", text: `Invalid arguments for ${name}: ${over.join("; ")}` }], isError: true });
      }
      // PROPOSALS P33: what the real service refuses (no effect, logged invalid like a limit).
      const refused = connectorRefusal(connector, name, args);
      if (refused) {
        record({ tool: name, args, valid: false, error: refused, refusal: true });
        return reply({ content: [{ type: "text", text: refused }], isError: true });
      }
      record({ tool: name, args, valid: true });
      return reply(respond(name, args));
    }
    return fail(-32601, `Method not found: ${method}`);
  };
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const k = argv[i].slice(2);
    const n = argv[i + 1];
    if (n === undefined || n.startsWith("--")) flags[k] = true;
    else (flags[k] = n), i++;
  }
  return flags;
}

const isMain = process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isMain) {
  const flags = parseArgs(process.argv.slice(2));
  const connector = flags.connector;
  if (!connector || connector === true) {
    process.stderr.write("usage: mcp-server.mjs --connector <name> [--schemas f] [--fixtures f] [--log f]\n");
    process.exit(2);
  }
  const doc = JSON.parse(readFileSync(flags.schemas && flags.schemas !== true ? flags.schemas : schemaFile(connector), "utf8"));
  if (process.argv.includes("serverName")) {
    process.stdout.write(serverName(doc) + "\n");
    process.exit(0);
  }
  const fixtures = flags.fixtures && flags.fixtures !== true ? JSON.parse(readFileSync(flags.fixtures, "utf8")) : {};
  const handle = createServer({ connector, doc, fixtures, log: flags.log && flags.log !== true ? flags.log : undefined });
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
        continue;
      }
      const out = Array.isArray(msg) ? msg.map(handle).filter(Boolean) : handle(msg);
      if (out && (!Array.isArray(out) || out.length)) process.stdout.write(JSON.stringify(out) + "\n");
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
