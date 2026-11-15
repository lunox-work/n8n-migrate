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
//   "__routes": [{method, url, any?, query?, bodyMatch?, status, headers?, body?, bodyBase64?, delayMs?}]
//   url is the real service URL without query; it is matched against the request's origin and
//   path (a proxied or TLS-intercepted request), or its path alone for a request made to the
//   mock directly. `{token}` in the url matches one run of non-slash characters (Telegram's
//   bot<token>). `query`, when given, must be carried by the request (subset, values compared
//   as strings; UUIDs match with or without dashes). `bodyMatch`, when given, must be carried by
//   the request body: an object is a subset of the parsed body (JSON or form; leaves compared as
//   strings, arrays element by element), a string must occur in the raw body text. The most
//   specific match wins (an exact path before `any`, then most query keys plus bodyMatch
//   leaves, then list order). `any: true` answers every path on the url's origin (a request
//   made to the mock directly names no origin and never matches it). Routes with the same
//   method + url + any + query + bodyMatch reply in turn and the last repeats. bodyBase64 is
//   binary. With __routes present, a write no route answers gets __writeDefault (logged
//   write-default) and a read gets 404 {"error":"no fixture"}, logged read-default.
//   A request the real service always refuses (serviceRefusal: Gmail send without
//   recipients, PROPOSALS P29) gets the service's error before any route, logged `service: …`.
//
// TLS (--tls-dir, evals/bench/tls.mjs): a CONNECT to a host with a leaf certificate in
// <dir>/hosts is answered 200 and the tunnel is terminated here with that leaf, so the
// request inside is logged and answered like a proxied plain-HTTP one (origin https://host,
// log field tls: true). A host without a leaf (PROPOSALS P26) gets one made here from the
// bench CA (mint-leaf.mjs; <dir>/ca.key), so its requests are logged and answered like any
// unrouted request (read-default 404, write-default) with log field mintedLeaf: true, a read
// gap in the request log instead of a refused connection. Without the CA key, or for an IP
// address, the CONNECT is logged and refused (502), as before.
//
// Model forwarding (--model-shim http://host:port): a request whose path starts with
// /model/<tag>/ (a model credential's base URL, set per node by the bench) is forwarded to the
// shim with header x-bench-model-tag: <tag> and the rest of the path; a request to
// api.anthropic.com/v1/messages or api.openai.com/v1/chat/completions that no route answers is
// forwarded with tag host:<host> (MODEL_HOSTS lists the hosts). The log line carries model: <tag>
// and the shim's reply.
//
// Forwarding to a host responder ("__forward": [{origin}] in the fixture map, needs --model-shim):
// a proxied or TLS-intercepted request to one of these origins is forwarded to the --model-shim
// URL with its path and query and header x-bench-forward-origin: <origin>, and answered with
// whatever that host server says. Used where the reply depends on state the host keeps (the
// cutover e2e's feed: Gmail's `after:` filter over items added while n8n runs). The log line
// carries forwarded: <origin> and the reply.
//
// Log line: {seq, t, method, [proxied], [duplicateHead], path, query, [rawQuery], headers, body, bodyEncoding, fixture}
// (duplicateHead: the client sent the request's head twice and the copy was dropped, P100)
// (query keeps the last value of a repeated key; rawQuery is the query string as sent)
// (proxied: the origin, when the client used this mock as its HTTP proxy)
// where body is parsed JSON when it parses, multipart/form-data as {field: value} (files as
// {filename, contentType, size, sha256}; bodyEncoding "multipart"), else text (or base64 when it
// is not UTF-8), and fixture is the key that answered (null when none did).
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
import { createHash } from "node:crypto";
import { mintLeaf } from "./mint-leaf.mjs";

export function parseArgs(argv) {
  const a = { port: 8080, log: null, fixtures: null, relays: [], tlsDir: null, modelShim: null, smtpPort: null };
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
    else if (k === "--smtp-port") a.smtpPort = Number(v());
    else if (k === "--relay") {
      const m = /^(\d+)=([^:]+):(\d+)$/.exec(v());
      if (!m) throw new Error("--relay wants <listenPort>=<host>:<port>");
      a.relays.push({ listen: Number(m[1]), host: m[2], port: Number(m[3]) });
    } else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

// multipart/form-data (PROPOSALS P3): {field: value}, a repeated field as a list, a file part as
// {filename, contentType, size, sha256}. Field values stay strings, as they are on the wire.
export function parseMultipart(buf, boundary) {
  const out = {};
  const s = buf.toString("latin1");
  const delim = `--${boundary}`;
  for (let part of s.split(delim).slice(1)) {
    if (part.startsWith("--")) break;
    part = part.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    const cut = part.search(/\r?\n\r?\n/);
    if (cut < 0) continue;
    const head = part.slice(0, cut);
    const raw = Buffer.from(part.slice(cut).replace(/^\r?\n\r?\n/, ""), "latin1");
    const disp = /content-disposition:[^\r\n]*/i.exec(head)?.[0] ?? "";
    const name = /\bname="([^"]*)"/i.exec(disp)?.[1];
    if (name === undefined) continue;
    const filename = /\bfilename="([^"]*)"/i.exec(disp)?.[1];
    const value =
      filename !== undefined
        ? { filename, contentType: /content-type:\s*([^\r\n;]+)/i.exec(head)?.[1]?.trim() ?? null, size: raw.length, sha256: createHash("sha256").update(raw).digest("hex") }
        : raw.toString("utf8");
    out[name] = name in out ? [].concat(out[name], [value]) : value;
  }
  return out;
}

function decodeBody(buf, contentType) {
  if (!buf.length) return { body: null, bodyEncoding: null };
  const boundary = /multipart\/form-data/i.test(contentType || "") ? /boundary="?([^";]+)"?/i.exec(contentType)?.[1] : null;
  if (boundary) return { body: parseMultipart(buf, boundary), bodyEncoding: "multipart" };
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

// Requests the real service refuses whatever a fixture says (PROPOSALS P29), answered before
// any route: Gmail's messages.send (JSON {raw} or the upload endpoint's MIME text) with no
// address in To, Cc or Bcc gets the API's 400 "Recipient address required", so a baseline that
// sends a recipient-less message fails as it would for real. Returns {key, f} or null.
const GMAIL_SEND = /^\/(upload\/)?gmail\/v1\/users\/[^/]+\/messages\/send$/;
const GMAIL_HOSTS = new Set(["https://www.googleapis.com", "https://gmail.googleapis.com"]);
export function mimeRecipients(mime) {
  const text = String(mime ?? "");
  const cut = text.search(/\r?\n\r?\n/);
  const head = (cut < 0 ? text : text.slice(0, cut)).replace(/\r?\n[ \t]+/g, " ");
  return head.split(/\r?\n/).filter((l) => /^(to|cc|bcc):/i.test(l)).flatMap((l) => l.slice(l.indexOf(":") + 1).split(",")).map((x) => x.trim()).filter((x) => x.includes("@"));
}
export function serviceRefusal(method, origin, path, body) {
  if (String(method).toUpperCase() !== "POST" || !GMAIL_SEND.test(path) || (origin && !GMAIL_HOSTS.has(origin))) return null;
  let mime = null;
  if (body && typeof body === "object" && typeof body.raw === "string") mime = Buffer.from(body.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  else if (typeof body === "string") mime = body;
  if (mime === null || mimeRecipients(mime).length) return null;
  const message = "Recipient address required";
  return { key: "service: gmail send without recipients", f: { status: 400, body: { error: { code: 400, message, errors: [{ message, domain: "global", reason: "invalidArgument" }], status: "INVALID_ARGUMENT" } } } };
}

// PROPOSALS P84: the transport headers Node's HTTP server adds to every answer this mock writes
// (res.writeHead with the fixture's headers, then res.end): `date` (unless the fixture sets one),
// `connection: close` (n8n's proxied and TLS-intercepted requests close their connection), and
// `transfer-encoding: chunked` (no length is known when the head is written) unless the fixture
// sets a length or an encoding. The in-process host adds the same, so a step that hands a whole
// response (headers included) to a model sees the same text on both sides.
export function transportHeaders(headers = {}, date = new Date()) {
  const has = (k) => Object.keys(headers ?? {}).some((h) => h.toLowerCase() === k);
  return {
    ...(has("date") ? {} : { date: date.toUTCString() }),
    ...(has("connection") ? {} : { connection: "close" }),
    ...(has("content-length") || has("transfer-encoding") ? {} : { "transfer-encoding": "chunked" }),
  };
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
  return `${r.method} ${r.url}${r.any ? " any" : ""}${r.query && Object.keys(r.query).length ? " " + JSON.stringify(r.query) : ""}${r.bodyMatch !== undefined ? " body " + JSON.stringify(r.bodyMatch) : ""}`;
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
    const u = /^https?:\/\/[^/]+(\/.*)?$/.exec(r.url);
    let hit;
    // `any` (PROPOSALS P19): the response answers every path on its origin (a page tool or an
    // image fetch whose URL the model writes). Only for requests that name an origin.
    if (r.any) hit = !!origin && safeDecode(origin).toLowerCase() === new URL(r.url).origin.toLowerCase();
    // PROPOSALS P85: a route URL with no path (`https://host`) is the origin's `/`, as every
    // client requests it (new URL(...).pathname).
    else hit = origin ? routeRegex(u && !u[1] ? `${r.url}/` : r.url).test(full) : routeRegex(u ? u[1] || "/" : r.url).test(bare);
    if (!hit) continue;
    const q = r.query ?? {};
    if (!Object.entries(q).every(([k, v]) => searchParams.get(k) === String(v))) continue;
    if (r.bodyMatch !== undefined && !bodyCarries(r.bodyMatch, body)) continue;
    // A route for the exact path always beats an `any` route; then the most query keys and
    // bodyMatch leaves; then list order.
    const n = (r.any ? 0 : 1e6) + Object.keys(q).length + (r.bodyMatch !== undefined ? leaves(r.bodyMatch) : 0);
    if (!best || n > best.n) best = { n, r };
  }
  if (!best) return null;
  const groupKey = routeKey(best.r);
  const group = routes.filter((r) => routeKey(r) === groupKey);
  const i = counters.get(groupKey) ?? 0;
  counters.set(groupKey, i + 1);
  return { key: `route ${groupKey}`, f: group[Math.min(i, group.length - 1)] };
}

// Model APIs on fixed hosts that no route answers are forwarded to the shim, tagged host:<host>
// (evals/bench/n8n-side.mjs SHIM_MODELS routes Groq, Mistral and Vertex nodes, and LLM APIs over
// HTTP, this way; PROPOSALS P18). Every format here is one the shim speaks.
export const MODEL_HOSTS = [
  { host: "api.anthropic.com", path: /^\/v1\/messages$/ },
  { host: "api.openai.com", path: /^\/v1\/chat\/completions$/ },
  { host: "openrouter.ai", path: /^\/api\/v1\/chat\/completions$/ },
  { host: "api.groq.com", path: /^\/openai\/v1\/chat\/completions$/ },
  { host: "api.mistral.ai", path: /^\/v1\/chat\/completions$/ },
  { host: "router.huggingface.co", path: /^\/hf-inference\/models\/.+/ },
  { host: /^(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com$|^aiplatform\.(?:eu|us)\.rep\.googleapis\.com$/, path: /:(?:stream)?generateContent$/ },
];
export const modelHost = (host, path) => MODEL_HOSTS.some((m) => (typeof m.host === "string" ? m.host === host : m.host.test(host)) && m.path.test(path));

// PROPOSALS P100: n8n reaches a plain `http://` host through this mock as its forward proxy
// with http-proxy-agent 7.0.2, whose connect() regenerates the request's stored head
// (`_implicitHeader()`), which resets Node's `_headerSent`: when a streamed body (a disk-stored
// binary as multipart) already queued a write, the next write sends the head again, so the
// socket carries head, the same head, then the body. Node's parser would read the second head
// as body (cut by its content-length) and the rest as a malformed request (an empty 400). The
// real request, sent without a proxy, has one head; the bench's proxy is what adds the copy.
// firstHead() looks at a plain connection's first bytes and drops an exact second copy of an
// absolute-form (proxied) request head. -> {done, out, dropped}; done false: more bytes needed.
const CRLF2 = Buffer.from("\r\n\r\n");
export function firstHead(buf) {
  const eol = buf.indexOf("\r\n");
  if (eol < 0) return buf.length > 8192 ? { done: true, out: buf, dropped: false } : { done: false };
  if (!/^[A-Z]+ https?:\/\/\S+ HTTP\/1\.[01]$/.test(buf.subarray(0, eol).toString("latin1"))) return { done: true, out: buf, dropped: false };
  const end = buf.indexOf(CRLF2);
  if (end < 0) return buf.length > 65536 ? { done: true, out: buf, dropped: false } : { done: false };
  const head = buf.subarray(0, end + 4);
  const rest = buf.subarray(end + 4);
  if (rest.length >= head.length) return rest.subarray(0, head.length).equals(head) ? { done: true, out: Buffer.concat([head, rest.subarray(head.length)]), dropped: true } : { done: true, out: buf, dropped: false };
  // Fewer bytes than a head after it: wait only while they could still be its copy and the
  // head says a body follows (a request without one never gets a second write).
  const text = head.toString("latin1");
  const body = /\r\ncontent-length:\s*[1-9]/i.test(text) || /\r\ntransfer-encoding:\s*chunked/i.test(text);
  return body && head.subarray(0, rest.length).equals(rest) ? { done: false } : { done: true, out: buf, dropped: false };
}

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
        ...(req.socket.__minted ? { mintedLeaf: true } : {}),
        ...(req.socket.__duplicateHead ? { duplicateHead: true } : {}),
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
      const modelTag = tagged ? safeDecode(tagged[1]) : !route && hostOnly && modelHost(hostOnly, u.pathname) ? `host:${hostOnly}` : null;
      const forward = !modelTag && origin && modelShim && Array.isArray(map.__forward) ? map.__forward.find((f) => f && f.origin === origin) : null;
      if ((modelTag || forward) && modelShim) {
        if (modelTag) entry.model = modelTag;
        else entry.forwarded = origin;
        entry.fixture = modelTag ? "model-shim" : "forward";
        const target = new URL((tagged ? tagged[2] : u.pathname) + u.search, modelShim);
        const extra = modelTag ? { "x-bench-model-tag": modelTag } : { "x-bench-forward-origin": origin };
        // The body is forwarded whole, so its length replaces any chunked encoding (a request
        // with both headers is refused by node's parser: PROPOSALS P47).
        const { "transfer-encoding": _te, ...inHeaders } = req.headers;
        const fwd = httpRequest(target, { method: req.method, headers: { ...inHeaders, host: target.host, ...extra, "content-length": raw.length } }, (up) => {
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
      let { key, f } = serviceRefusal(req.method, origin, u.pathname, entry.body) ?? route ?? writeDefault ?? pickFixture(map, req.method, u.pathname, query, counters, origin);
      // A read no bench route answers (PROPOSALS P19): 404, logged as read-default, the twin of
      // write-default, so a fixture gap shows in the request log.
      if (key === null && Array.isArray(map.__routes)) key = "read-default";
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
  // PROPOSALS P100: a plain connection's first request goes through firstHead() before Node's
  // parser sees it (TLS tunnels, emitted below, carry no such copy and go straight in).
  const [httpConnection] = server.listeners("connection");
  server.removeListener("connection", httpConnection);
  server.on("connection", (sock) => {
    if (sock instanceof TLSSocket) return httpConnection.call(server, sock);
    let buf = Buffer.alloc(0);
    const hand = (out, dropped) => {
      sock.removeListener("data", onData);
      sock.removeListener("end", onEnd);
      sock.pause();
      if (dropped) sock.__duplicateHead = true;
      if (out.length) sock.unshift(out);
      httpConnection.call(server, sock);
      sock.resume();
    };
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const r = firstHead(buf);
      if (r.done) hand(r.out, r.dropped);
    };
    const onEnd = () => hand(buf, false);
    sock.on("data", onData);
    sock.on("end", onEnd);
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
    let leaf = existsSync(key) && existsSync(cert) ? { key: readFileSync(key), cert: readFileSync(cert) } : null;
    if (!leaf && existsSync(join(tlsDir, "ca.key")) && existsSync(join(tlsDir, "ca.pem"))) {
      try {
        leaf = { ...mintLeaf(h, { caKeyPem: readFileSync(join(tlsDir, "ca.key")), caCertPem: readFileSync(join(tlsDir, "ca.pem")) }), minted: true };
      } catch {
        leaf = null;
      }
    }
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
      if (leaf.minted) tlsSocket.__minted = true;
      tlsSocket.on("error", () => socket.destroy());
      server.emit("connection", tlsSocket);
      return;
    }
    const entry = { seq: ++seq, t: new Date().toISOString(), method: "CONNECT", path: req.url, query: {}, headers: req.headers, body: null, bodyEncoding: null, fixture: null };
    if (log) appendFileSync(log, JSON.stringify(entry) + "\n");
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  // PROPOSALS P53: a message the SMTP sink accepted, logged like a request (see startSmtp).
  server.logSmtp = ({ raw, envelope }) => {
    const entry = { seq: ++seq, t: new Date().toISOString(), method: "SMTP", proxied: "smtp://mock", path: "/send", query: {}, headers: {}, body: smtpMessage(raw, envelope), bodyEncoding: "json", fixture: "smtp-sink" };
    if (log) appendFileSync(log, JSON.stringify(entry) + "\n");
  };
  return new Promise((ok) => server.listen(port, host, () => ok(server)));
}

// ---------- SMTP sink (PROPOSALS P53) ----------
//
// `--smtp-port <n>`: a minimal SMTP server (RFC 5321: EHLO/HELO, AUTH PLAIN and LOGIN accepted
// whatever the login, MAIL, RCPT, DATA, RSET, NOOP, QUIT; no STARTTLS offered) that accepts every
// message and logs it like an HTTP request, one line per message: method "SMTP", proxied
// "smtp://<host the client named in EHLO's peer: mock>", path "/send", body the parsed message
// (smtpMessage) and fixture "smtp-sink". Nothing is relayed anywhere.

// RFC 2047 encoded words (=?charset?B|Q?...?=) in a header, decoded as UTF-8.
export function decodeWords(v) {
  return String(v ?? "")
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_, cs, enc, txt) => {
      const buf = /b/i.test(enc) ? Buffer.from(txt, "base64") : Buffer.from(txt.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
      return buf.toString(/^utf-?8$/i.test(cs) ? "utf8" : "latin1");
    });
}
const qpDecode = (s) => {
  const flat = String(s).replace(/=\r?\n/g, "");
  return Buffer.from(flat.replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8");
};
function splitHead(raw) {
  const cut = raw.search(/\r?\n\r?\n/);
  const head = cut < 0 ? raw : raw.slice(0, cut);
  const body = cut < 0 ? "" : raw.slice(cut).replace(/^\r?\n\r?\n/, "");
  const headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line);
    if (m) headers[m[1].toLowerCase()] = m[2];
  }
  return { headers, body };
}
// Addresses in a header ("A <a@x>, b@y"): the list of entries, display names kept.
export function addressList(v) {
  const out = [];
  let cur = "";
  let q = false;
  for (const ch of decodeWords(v)) {
    if (ch === '"') q = !q;
    if (ch === "," && !q) out.push(cur), (cur = "");
    else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
const bare = (a) => (/<([^>]+)>/.exec(a)?.[1] ?? a).trim().toLowerCase();
// A MIME message (as received in DATA) -> {from, to, cc, bcc, replyTo, subject, text, html,
// attachments: [{filename, contentType, size, sha256}]}; bcc are the envelope recipients the
// headers do not name.
export function smtpMessage(raw, envelope = { from: null, to: [] }) {
  const out = { text: undefined, html: undefined, attachments: [] };
  const walk = (part) => {
    const { headers, body } = splitHead(part);
    const ct = headers["content-type"] ?? "text/plain";
    const boundary = /boundary="?([^";]+)"?/i.exec(ct)?.[1];
    if (/^multipart\//i.test(ct) && boundary) {
      for (const p of body.split(`--${boundary}`).slice(1)) {
        if (p.startsWith("--")) break;
        walk(p.replace(/^\r?\n/, ""));
      }
      return;
    }
    const cte = headers["content-transfer-encoding"] ?? "";
    const bytes = /base64/i.test(cte) ? Buffer.from(body.replace(/\s+/g, ""), "base64") : /quoted-printable/i.test(cte) ? Buffer.from(qpDecode(body), "utf8") : Buffer.from(body, "utf8");
    const disp = headers["content-disposition"] ?? "";
    const filename = decodeWords(/filename="?([^";]+)"?/i.exec(disp)?.[1] ?? /name="?([^";]+)"?/i.exec(ct)?.[1] ?? "");
    if (/attachment/i.test(disp) || (filename && !/^text\/(plain|html)/i.test(ct))) {
      out.attachments.push({ filename: filename || null, contentType: ct.split(";")[0].trim(), size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    } else if (/^text\/html/i.test(ct) && out.html === undefined) out.html = bytes.toString("utf8").replace(/\r\n/g, "\n").trim();
    else if (/^text\//i.test(ct) && out.text === undefined) out.text = bytes.toString("utf8").replace(/\r\n/g, "\n").trim();
  };
  walk(raw);
  const { headers } = splitHead(raw);
  const to = addressList(headers.to ?? "");
  const cc = addressList(headers.cc ?? "");
  const named = new Set([...to, ...cc].map(bare));
  return {
    from: decodeWords(headers.from ?? "") || null,
    to,
    cc,
    bcc: (envelope.to ?? []).filter((a) => !named.has(bare(a))),
    ...(headers["reply-to"] ? { replyTo: addressList(headers["reply-to"]) } : {}),
    subject: decodeWords(headers.subject ?? ""),
    ...(out.text !== undefined ? { text: out.text } : {}),
    ...(out.html !== undefined ? { html: out.html } : {}),
    attachments: out.attachments,
    envelope: { from: envelope.from, to: envelope.to ?? [] },
  };
}

export function startSmtp({ port, host = "0.0.0.0", name = "mock", onMessage }) {
  const server = createTcpServer((sock) => {
    let buf = "";
    let data = null;
    let env = { from: null, to: [] };
    let auth = null;
    const say = (l) => sock.write(`${l}\r\n`);
    say(`220 ${name} ESMTP n8n2claude bench sink`);
    sock.setEncoding("latin1");
    sock.on("data", (chunk) => {
      buf += chunk;
      let i;
      while (true) {
        if (data !== null) {
          data += buf;
          buf = "";
          const probe = `\r\n${data}`;
          const end = probe.indexOf("\r\n.\r\n");
          if (end < 0) return;
          const raw = Buffer.from(probe.slice(2, Math.max(2, end)).replace(/^\.\./gm, "."), "latin1").toString("utf8");
          buf = probe.slice(end + 5);
          try {
            onMessage?.({ raw, envelope: env });
          } catch {}
          data = null;
          env = { from: null, to: [] };
          say("250 2.0.0 queued by the bench sink");
          continue;
        }
        if ((i = buf.indexOf("\r\n")) < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (auth === "login-user") (auth = "login-pass"), say("334 UGFzc3dvcmQ6");
        else if (auth === "login-pass") (auth = null), say("235 2.7.0 accepted");
        else if (/^(EHLO|HELO)\b/i.test(line)) /^EHLO/i.test(line) ? sock.write(`250-${name}\r\n250-AUTH PLAIN LOGIN\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n`) : say(`250 ${name}`);
        else if (/^AUTH PLAIN\s+\S/i.test(line)) say("235 2.7.0 accepted");
        else if (/^AUTH PLAIN$/i.test(line)) (auth = "login-pass"), say("334 ");
        else if (/^AUTH LOGIN\s+\S/i.test(line)) (auth = "login-pass"), say("334 UGFzc3dvcmQ6");
        else if (/^AUTH LOGIN$/i.test(line)) (auth = "login-user"), say("334 VXNlcm5hbWU6");
        else if (/^MAIL FROM:/i.test(line)) (env.from = /<([^>]*)>/.exec(line)?.[1] ?? null), say("250 2.1.0 ok");
        else if (/^RCPT TO:/i.test(line)) env.to.push(/<([^>]*)>/.exec(line)?.[1] ?? line.slice(8).trim()), say("250 2.1.5 ok");
        else if (/^DATA$/i.test(line)) (data = ""), say("354 end with <CRLF>.<CRLF>");
        else if (/^RSET$/i.test(line)) (env = { from: null, to: [] }), say("250 2.0.0 ok");
        else if (/^NOOP/i.test(line)) say("250 2.0.0 ok");
        else if (/^QUIT$/i.test(line)) say("221 2.0.0 bye"), sock.end();
        else if (/^STARTTLS$/i.test(line)) say("454 4.7.0 TLS not available");
        else say("502 5.5.2 not implemented");
      }
    });
    sock.on("error", () => sock.destroy());
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
  const mock = await startMock({ port: a.port, log: a.log, fixtures: a.fixtures, tlsDir: a.tlsDir, modelShim: a.modelShim });
  if (a.smtpPort) await startSmtp({ port: a.smtpPort, onMessage: (m) => mock.logSmtp(m) });
  for (const r of a.relays) await startRelay(r);
  console.error(`mock on :${a.port}${a.smtpPort ? `, smtp sink :${a.smtpPort}` : ""}${a.relays.map((r) => `, relay :${r.listen} -> ${r.host}:${r.port}`).join("")}`);
  const stop = () => process.exit(0);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
