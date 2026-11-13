// The mock connector server (evals/mocks/mcp-server.mjs) spoken to over stdio as an MCP
// client would: handshake, tool list with the captured names and schemas, fixture answers in
// order, schema-checked arguments, and the effects log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "evals/mocks/mcp-server.mjs");

const procs = [];
function client(args) {
  const p = spawn(process.execPath, ["--max-old-space-size=128", SERVER, ...args], { stdio: ["pipe", "pipe", "pipe"] });
  procs.push(p);
  let buf = "";
  const waiting = new Map();
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  let next = 1;
  return {
    request(method, params) {
      const id = next++;
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return new Promise((res) => waiting.set(id, res));
    },
    notify(method, params) {
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    },
    close() {
      p.stdin.end();
      return new Promise((res) => p.on("exit", res));
    },
  };
}

test("mock MCP server: handshake, captured tools, fixtures in order, schema check, effects log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "n2c-mcp-"));
  try {
    const fixtures = join(dir, "fixtures.json");
    const log = join(dir, "effects.jsonl");
    writeFileSync(
      fixtures,
      JSON.stringify({
        gmail: { search_threads: { responses: [{ result: { threads: [{ id: "t1" }] } }, { error: "quota" }], default: { result: { threads: [] } } } },
        slack: { slack_send_message: { default: { result: { channel: "{{args.channel_id}}", ts: "1.2" } } } },
      }),
    );
    const c = client(["--connector", "gmail", "--fixtures", fixtures, "--log", log]);
    const init = await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
    c.notify("notifications/initialized");
    assert.deepEqual((await c.request("ping")).result, {});
    const list = (await c.request("tools/list")).result.tools;
    const captured = JSON.parse(readFileSync(join(ROOT, "evals/mocks/connectors/gmail.json"), "utf8")).tools;
    assert.deepEqual(list.map((t) => t.name), captured.map((t) => t.name));
    assert.deepEqual(list.find((t) => t.name === "search_threads").inputSchema, captured.find((t) => t.name === "search_threads").inputSchema);

    const call = (name, args) => c.request("tools/call", { name, arguments: args });
    const a = await call("search_threads", { query: "is:unread", pageSize: 5 });
    assert.deepEqual(JSON.parse(a.result.content[0].text), { threads: [{ id: "t1" }] });
    const b = await call("search_threads", { query: "is:unread" });
    assert.equal(b.result.isError, true);
    assert.equal(b.result.content[0].text, "quota");
    const d = await call("search_threads", {});
    assert.deepEqual(JSON.parse(d.result.content[0].text), { threads: [] });
    const bad = await call("search_threads", { pageSize: "ten" });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /pageSize should be integer, got string/);
    const wrong = await call("send_message", { bcc: "x@example.com", body: "hi" });
    assert.equal(wrong.result.isError, true, "a string where the schema wants a list is refused");
    const unknown = await call("nope", {});
    assert.equal(unknown.error.code, -32602);
    assert.equal((await c.request("resources/list")).error.code, -32601);
    await c.close();

    const s = client(["--connector", "slack", "--fixtures", fixtures, "--log", log]);
    await s.request("initialize", { protocolVersion: "1999-01-01", capabilities: {} });
    const sent = await s.request("tools/call", { name: "slack_send_message", arguments: { channel_id: "C1", message: "hi" } });
    assert.deepEqual(JSON.parse(sent.result.content[0].text), { channel: "C1", ts: "1.2" });
    await s.close();

    const entries = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(
      entries.map((e) => [e.connector, e.tool, e.valid]),
      [
        ["gmail", "search_threads", true],
        ["gmail", "search_threads", true],
        ["gmail", "search_threads", true],
        ["gmail", "search_threads", false],
        ["gmail", "send_message", false],
        ["gmail", "nope", false],
        ["slack", "slack_send_message", true],
      ],
    );
    assert.deepEqual(entries[0].args, { query: "is:unread", pageSize: 5 });
    assert.ok(entries.every((e) => !Number.isNaN(Date.parse(e.t))));
  } finally {
    for (const p of procs) p.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mock MCP server names itself like the real connector", async () => {
  const { serverName, schemaFile } = await import(SERVER);
  const name = (c) => serverName(JSON.parse(readFileSync(schemaFile(c), "utf8")));
  assert.equal(name("gmail"), "claude_ai_Gmail");
  assert.equal(name("slack"), "claude_ai_Slack");
  assert.equal(name("google-drive"), "claude_ai_Google_Drive");
});
