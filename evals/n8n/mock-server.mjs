#!/usr/bin/env node
// HTTP mock for the n8n bench. Records every request as one JSON line and
// replies from a fixture map. Zero dependencies; runs on the host or in the
// bench sidecar container (see container.mjs).
//
//   node mock-server.mjs [--port 8080] [--log effects.jsonl] [--fixtures fixtures.json]
//                        [--relay <listenPort>=<host>:<port>]... [--tls-dir dir] [--model-shim url]
//
// Fixture map (re-read on every request; rewriting the file restarts reply lists):
//   { "POST /v1/messages": {"status": 200, "headers": {...}, "body": {...}},
//     "GET /items?page=2": {...},             exact path and query first
//     "GET /items":        [{...}, {...}],    a list replies in turn, the last repeats
//     "* /health":         {...},             any method
//     "GET http://api.example.test/v1/x": {...}  a proxied request's origin, tried first
//     "default":           {...} }            otherwise 404 {"error":"no fixture"}
// "body" that is not a string is sent as JSON. "delayMs" delays the reply.
//
// Bench routes (evals/bench, FIXTURES.md `http` sources), tried before the keys above:
//   "__routes": [{method, url, query?, bodyMatch?, status, headers?, body?, bodyBase64?, delayMs?}]
//   url is the real service URL without query; it is matched against the request's origin and
//   path (a proxied or TLS-intercepted request), or its path alone for a request made to the
//   mock directly. `{token}` in the url matches one run of non-slash characters (Telegram's
//   bot<token>). `query`, when given, must be carried by the request (subset, values compared
//   as strings; UUIDs match with or without dashes). `bodyMatch`, when given, must be carried by
//   the request body: an object is a subset of the parsed body (JSON or form; leaves compared as
//   strings, arrays element by element), a string must occur in the raw body text. The most
//   specific match wins (most query keys plus bodyMatch leaves, then list order). Routes with
//   the same method + url + query + bodyMatch reply in turn and the last repeats. bodyBase64 is binary.
//
// TLS (--tls-dir, evals/bench/tls.mjs): a CONNECT to a host with a leaf certificate in
// <dir>/hosts is answered 200 and the tunnel is terminated here with that leaf, so the
// request inside is logged and answered like a proxied plain-HTTP one (origin https://host,
// log field tls: true). CONNECT to any other host is logged and refused (502), as before.
//
// Model forwarding (--model-shim http://host:port): a request whose path starts with
// /model/<tag>/ (a model credential's base URL, set per node by the bench) is forwarded to the
// shim with header x-bench-model-tag: <tag> and the rest of the path; a request to
// api.anthropic.com/v1/messages or api.openai.com/v1/chat/completions that no route answers is
// forwarded with tag host:<host>. The log line carries model: <tag> and the shim's reply.
//
// Log line: {seq, t, method, [proxied], path, query, [rawQuery], headers, body, bodyEncoding, fixture}
// (query keeps the last value of a repeated key; rawQuery is the query string as sent)
// (proxied: the origin, when the client used this mock as its HTTP proxy)
// where body is parsed JSON when it parses, else text (or base64 when it is
// not UTF-8), and fixture is the key that answered (null when none did).
// The log is the ordered list of outgoing effects; truncate it between runs.
//
// --relay forwards TCP from a port in this process to another host, so the
// host reaches n8n on an internal Docker network without giving n8n egress.

import { createServer, request as httpRequest } from "node:http";
import { createServer as createTcpServer, connect } from "node:net";
import { TLSSocket } from "node:tls";
import { appendFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";

export function parseArgs(argv) {
  const a = { port: 8080, log: null, fixtures: null, relays: [], tlsDir: null, modelShim: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      if (i + 1 >= argv.length) throw new Error(`${k} needs a value`);
      return argv[++i];
    };
    if (k === "--port") a.port = Number(v());
    else if (k === "--log") a.log = v();
    else if (k === "--fixtures") a.fixtures = v();
    else if (k === "--tls-dir") a.tlsDir = v();
    else if (k === "--model-shim") a.modelShim = v();
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
// `origin` (e.g. "http://api.example.test") is set for proxied requests; keys
// that name it ("GET http://api.example.test/v1/x") are tried first.
export function pickFixture(map, method, path, query, counters, origin = null) {
  const keys = [];
  if (origin) {
    if (query) keys.push(`${method} ${origin}${path}?${query}`);
    keys.push(`${method} ${origin}${path}`, `* ${origin}${path}`);
  }
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

const safeDecode = (x) => {
  try {
    return decodeURIComponent(x);
  } catch {
    return x;
  }
};
// A UUID with or without dashes is the same id to the services that use them (Notion).
const undash = (s) => s.replace(/([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})/gi, (...m) => m.slice(1, 6).join("").toLowerCase());
const routeRegex = (url) => new RegExp("^" + undash(safeDecode(url)).split("{token}").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+") + "$");

const isPlain = (x) => x && typeof x === "object" && !Array.isArray(x);
// Does the request body carry `want` (a bodyMatch)? See the header.
export function bodyCarries(want, body) {
  if (typeof want === "string") return (typeof body === "string" ? body : JSON.stringify(body ?? "")).includes(want);
  let got = body;
  if (typeof got === "string") {
    try {
      got = JSON.parse(got);
    } catch {
      return false;
    }
  }
  const sub = (w, g) => {
    if (Array.isArray(w)) return Array.isArray(g) && w.every((x, i) => sub(x, g[i]));
    if (isPlain(w)) return isPlain(g) && Object.entries(w).every(([k, v]) => sub(v, g[k]));
    return g !== undefined && g !== null && String(g) === String(w);
  };
  return sub(want, got);
}
const leaves = (w) => (typeof w === "string" ? 1 : Array.isArray(w) ? w.reduce((n, x) => n + leaves(x), 0) : isPlain(w) ? Object.values(w).reduce((n, x) => n + leaves(x), 0) : 1);

// The group a route replies in turn with: method, url, query and bodyMatch. Also the log's
// `fixture` value ("route <key>"), so the request log can be diffed against the fixture.
export function routeKey(r) {
  return `${r.method} ${r.url}${r.query && Object.keys(r.query).length ? " " + JSON.stringify(r.query) : ""}${r.bodyMatch !== undefined ? " body " + JSON.stringify(r.bodyMatch) : ""}`;
}

// Picks the bench route for a request (see the header). `searchParams` is a URLSearchParams;
// `counters` tracks reply positions per route group; `body` is the parsed request body (only
// routes with a bodyMatch read it). Returns {key, f} or null.
export function pickRoute(routes, method, origin, path, searchParams, counters, body) {
  if (!Array.isArray(routes) || !routes.length) return null;
  const full = undash(safeDecode(`${origin ?? ""}${path}`));
  const bare = undash(safeDecode(path));
  let best = null;
  for (const r of routes) {
    if (r.method !== "*" && String(r.method).toUpperCase() !== method) continue;
    const re = routeRegex(r.url);
    const u = /^https?:\/\/[^/]+(\/.*)?$/.exec(r.url);
    const hit = origin ? re.test(full) : routeRegex(u ? u[1] || "/" : r.url).test(bare);
    if (!hit) continue;
    const q = r.query ?? {};
    if (!Object.entries(q).every(([k, v]) => searchParams.get(k) === String(v))) continue;
    if (r.bodyMatch !== undefined && !bodyCarries(r.bodyMatch, body)) continue;
    const n = Object.keys(q).length + (r.bodyMatch !== undefined ? leaves(r.bodyMatch) : 0);
    if (!best || n > best.n) best = { n, r };
  }
  if (!best) return null;
  const groupKey = routeKey(best.r);
  const group = routes.filter((r) => routeKey(r) === groupKey);
  const i = counters.get(groupKey) ?? 0;
  counters.set(groupKey, i + 1);
  return { key: `route ${groupKey}`, f: group[Math.min(i, group.length - 1)] };
}

const MODEL_HOSTS = { "api.anthropic.com": /^\/v1\/messages$/, "api.openai.com": /^\/v1\/chat\/completions$/ };

export function startMock({ port = 8080, log = null, fixtures = null, host = "0.0.0.0", tlsDir = null, modelShim = null } = {}) {
  let seq = 0;
  const counters = new Map();
  let fixturesStamp = null;
  // A rewritten fixture file (new inode or mtime) restarts the reply lists,
  // so a runner that writes the file before each run gets the same replies.
  const readFixtures = () => {
    if (!fixtures || !existsSync(fixtures)) return {};
    const st = statSync(fixtures);
    const stamp = `${st.ino}:${st.mtimeMs}:${st.size}`;
    if (stamp !== fixturesStamp) counters.clear();
    fixturesStamp = stamp;
    const raw = readFileSync(fixtures, "utf8");
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
      const mitm = req.socket.__mitm ?? null;
      const origin = mitm ? `https://${mitm}` : /^https?:\/\//.test(req.url) ? `${u.protocol}//${u.host}` : null;
      const raw = Buffer.concat(chunks);
      const entry = {
        seq: ++seq,
        t: new Date().toISOString(),
        method: req.method,
        ...(origin ? { proxied: origin } : {}),
        ...(mitm ? { tls: true } : {}),
        path: u.pathname,
        query: Object.fromEntries(u.searchParams),
        ...(query ? { rawQuery: query } : {}),
        headers: req.headers,
        ...decodeBody(raw, req.headers["content-type"]),
        fixture: null,
      };
      // Model calls go to the host's shim, which answers them (live, replay or canned).
      const tagged = /^\/model\/([^/]+)(\/.*)$/.exec(u.pathname);
      const route = tagged ? null : pickRoute(map.__routes, req.method, origin, u.pathname, u.searchParams, counters, entry.body);
      const hostOnly = origin ? origin.replace(/^https?:\/\//, "").replace(/:\d+$/, "") : null;
      const modelTag = tagged ? safeDecode(tagged[1]) : !route && hostOnly && MODEL_HOSTS[hostOnly]?.test(u.pathname) ? `host:${hostOnly}` : null;
      if (modelTag && modelShim) {
        entry.model = modelTag;
        entry.fixture = "model-shim";
        const target = new URL((tagged ? tagged[2] : u.pathname) + u.search, modelShim);
        const fwd = httpRequest(target, { method: req.method, headers: { ...req.headers, host: target.host, "x-bench-model-tag": modelTag, "content-length": raw.length } }, (up) => {
          const parts = [];
          up.on("data", (c) => parts.push(c));
          up.on("end", () => {
            const body = Buffer.concat(parts);
            entry.reply = { status: up.statusCode, ...decodeBody(body, up.headers["content-type"]) };
            if (log) appendFileSync(log, JSON.stringify(entry) + "\n");
            res.writeHead(up.statusCode ?? 502, { "content-type": up.headers["content-type"] ?? "application/json" });
            res.end(body);
          });
        });
        fwd.setTimeout(600_000, () => fwd.destroy(new Error("model shim timeout")));
        fwd.on("error", (e) => {
          entry.reply = { status: 502, body: { error: `model shim: ${e.message}` } };
          if (log) appendFileSync(log, JSON.stringify(entry) + "\n");
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `bench model shim unreachable: ${e.message}` } }));
        });
        fwd.end(raw);
        return;
      }
      // A write no fixture answers is accepted (200 {}), as the mock MCP server answers an
      // unfixtured call with {"ok": true}; reads still get the 404 so fixture gaps show.
      const writeDefault = !route && map.__writeDefault && ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && origin ? { key: "write-default", f: map.__writeDefault } : null;
      const { key, f } = route ?? writeDefault ?? pickFixture(map, req.method, u.pathname, query, counters, origin);
      entry.fixture = key;
      if (log) appendFileSync(log, JSON.stringify(entry) + "\n");
      const send = () => {
        if (f.bodyBase64 !== undefined) {
          res.writeHead(f.status ?? 200, { "content-type": "application/octet-stream", ...(f.headers || {}) });
          res.end(Buffer.from(f.bodyBase64, "base64"));
          return;
        }
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
  // A client that uses this mock as an HTTPS proxy sends CONNECT host:443. With a leaf for
  // that host in --tls-dir the tunnel is terminated here (the client trusts the bench CA);
  // otherwise it is logged and refused.
  const leaves = new Map();
  const leafFor = (h) => {
    if (!tlsDir || !/^[a-z0-9.-]+$/i.test(h)) return null;
    if (leaves.has(h)) return leaves.get(h);
    const key = join(tlsDir, "hosts", `${h.toLowerCase()}.key`);
    const cert = join(tlsDir, "hosts", `${h.toLowerCase()}.pem`);
    const leaf = existsSync(key) && existsSync(cert) ? { key: readFileSync(key), cert: readFileSync(cert) } : null;
    if (leaf) leaves.set(h, leaf);
    return leaf;
  };
  server.on("connect", (req, socket, head) => {
    const [h, p = "443"] = String(req.url).split(":");
    const leaf = leafFor(h);
    if (leaf) {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) socket.unshift(head);
      const tlsSocket = new TLSSocket(socket, { isServer: true, key: leaf.key, cert: leaf.cert, ALPNProtocols: ["http/1.1"] });
      tlsSocket.__mitm = p === "443" ? h.toLowerCase() : `${h.toLowerCase()}:${p}`;
      tlsSocket.on("error", () => socket.destroy());
      server.emit("connection", tlsSocket);
      return;
    }
    const entry = { seq: ++seq, t: new Date().toISOString(), method: "CONNECT", path: req.url, query: {}, headers: req.headers, body: null, bodyEncoding: null, fixture: null };
    if (log) appendFileSync(log, JSON.stringify(entry) + "\n");
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
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
  await startMock({ port: a.port, log: a.log, fixtures: a.fixtures, tlsDir: a.tlsDir, modelShim: a.modelShim });
  for (const r of a.relays) await startRelay(r);
  console.error(`mock on :${a.port}${a.relays.map((r) => `, relay :${r.listen} -> ${r.host}:${r.port}`).join("")}`);
  const stop = () => process.exit(0);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
