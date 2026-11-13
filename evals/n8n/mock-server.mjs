#!/usr/bin/env node
// HTTP mock for the n8n bench. Records every request as one JSON line and
// replies from a fixture map. Zero dependencies; runs on the host or in the
// bench sidecar container (see container.mjs).
//
//   node mock-server.mjs [--port 8080] [--log effects.jsonl] [--fixtures fixtures.json]
//                        [--relay <listenPort>=<host>:<port>]...
//
// Fixture map (re-read on every request, so a runner swaps it between runs):
//   { "POST /v1/messages": {"status": 200, "headers": {...}, "body": {...}},
//     "GET /items?page=2": {...},             exact path and query first
//     "GET /items":        [{...}, {...}],    a list replies in turn, the last repeats
//     "* /health":         {...},             any method
//     "default":           {...} }            otherwise 404 {"error":"no fixture"}
// "body" that is not a string is sent as JSON. "delayMs" delays the reply.
//
// Log line: {seq, t, method, path, query, headers, body, bodyEncoding, fixture}
// where body is parsed JSON when it parses, else text (or base64 when it is
// not UTF-8), and fixture is the key that answered (null when none did).
// The log is the ordered list of outgoing effects; truncate it between runs.
//
// --relay forwards TCP from a port in this process to another host, so the
// host reaches n8n on an internal Docker network without giving n8n egress.

import { createServer } from "node:http";
import { createServer as createTcpServer, connect } from "node:net";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export function parseArgs(argv) {
  const a = { port: 8080, log: null, fixtures: null, relays: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      if (i + 1 >= argv.length) throw new Error(`${k} needs a value`);
      return argv[++i];
    };
    if (k === "--port") a.port = Number(v());
    else if (k === "--log") a.log = v();
    else if (k === "--fixtures") a.fixtures = v();
    else if (k === "--relay") {
      const m = /^(\d+)=([^:]+):(\d+)$/.exec(v());
      if (!m) throw new Error("--relay wants <listenPort>=<host>:<port>");
      a.relays.push({ listen: Number(m[1]), host: m[2], port: Number(m[3]) });
    } else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

function decodeBody(buf, contentType) {
  if (!buf.length) return { body: null, bodyEncoding: null };
  const text = buf.toString("utf8");
  if (Buffer.from(text, "utf8").equals(buf)) {
    if (/json/i.test(contentType || "") || /^\s*[[{]/.test(text)) {
      try {
        return { body: JSON.parse(text), bodyEncoding: "json" };
      } catch {}
    }
    if (/application\/x-www-form-urlencoded/i.test(contentType || "")) {
      return { body: Object.fromEntries(new URLSearchParams(text)), bodyEncoding: "form" };
    }
    return { body: text, bodyEncoding: "text" };
  }
  return { body: buf.toString("base64"), bodyEncoding: "base64" };
}

// Picks the fixture for a request; `counters` tracks list positions.
export function pickFixture(map, method, path, query, counters) {
  const keys = [];
  if (query) keys.push(`${method} ${path}?${query}`);
  keys.push(`${method} ${path}`);
  if (query) keys.push(`* ${path}?${query}`);
  keys.push(`* ${path}`, "default");
  for (const key of keys) {
    if (!(key in map)) continue;
    let f = map[key];
    if (Array.isArray(f)) {
      const n = counters.get(key) ?? 0;
      counters.set(key, n + 1);
      f = f[Math.min(n, f.length - 1)];
    }
    return { key, f: f ?? {} };
  }
  return { key: null, f: { status: 404, body: { error: "no fixture", method, path } } };
}

export function startMock({ port = 8080, log = null, fixtures = null, host = "0.0.0.0" } = {}) {
  let seq = 0;
  const counters = new Map();
  let fixturesStamp = null;
  const readFixtures = () => {
    if (!fixtures || !existsSync(fixtures)) return {};
    const raw = readFileSync(fixtures, "utf8");
    if (raw !== fixturesStamp) counters.clear(); // new fixture file: lists restart
    fixturesStamp = raw;
    return raw.trim() ? JSON.parse(raw) : {};
  };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const u = new URL(req.url, "http://mock");
      const query = u.search.slice(1);
      let map;
      try {
        map = readFixtures();
      } catch (e) {
        map = { default: { status: 500, body: { error: `fixtures unreadable: ${e.message}` } } };
      }
      const { key, f } = pickFixture(map, req.method, u.pathname, query, counters);
      const entry = {
        seq: ++seq,
        t: new Date().toISOString(),
        method: req.method,
        path: u.pathname,
        query: Object.fromEntries(u.searchParams),
        headers: req.headers,
        ...decodeBody(Buffer.concat(chunks), req.headers["content-type"]),
        fixture: key,
      };
      if (log) appendFileSync(log, JSON.stringify(entry) + "\n");
      const send = () => {
        const isText = typeof f.body === "string";
        const payload = f.body === undefined ? "" : isText ? f.body : JSON.stringify(f.body);
        const headers = { ...(isText || f.body === undefined ? {} : { "content-type": "application/json" }), ...(f.headers || {}) };
        res.writeHead(f.status ?? 200, headers);
        res.end(payload);
      };
      if (f.delayMs) setTimeout(send, f.delayMs);
      else send();
    });
  });
  return new Promise((ok) => server.listen(port, host, () => ok(server)));
}

export function startRelay({ listen, host, port }) {
  const server = createTcpServer((client) => {
    const upstream = connect(port, host);
    client.pipe(upstream).pipe(client);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
  });
  return new Promise((ok) => server.listen(listen, "0.0.0.0", () => ok(server)));
}

async function main() {
  let a;
  try {
    a = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  await startMock(a);
  for (const r of a.relays) await startRelay(r);
  console.error(`mock on :${a.port}${a.relays.map((r) => `, relay :${r.listen} -> ${r.host}:${r.port}`).join("")}`);
  const stop = () => process.exit(0);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
