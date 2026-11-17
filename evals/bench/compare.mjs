// The comparer: decides whether an n8n effect and a Claude effect are the same effect, using
// only its own table (effects.json). It never reads the converter's field map (PLAN Phase 6),
// so a wrong mapping cannot pass on both sides.
//
//   canonical effect = {side, service, action, effect: read|write|media, target, fields, raw}
//   fromHttp(entry)   an n8n mock-log line, or a runner http request ({method, url, query, body})
//   fromTool(call)    a connector call on the Claude side ({connector, tool, args})
//   fromFile(f)       a file on local disk after the run ({path, sha256, size}, PROPOSALS P44)
//   compare(n8n, claude, {modelTexts, mode}) -> {ok, writes, reads, reply, judge: [...]}
//
// Writes (and media calls) are matched as multisets by service.action.target, paired by
// content within one target (pairWrites), then compared field by field. Reads are compared as sets of service.action.target and reported; they do not fail
// the comparison, because a connector legitimately pages or batches differently from n8n's
// REST calls (a wrong read shows up in the writes it feeds). A text field that holds a model
// reply is model-written: byte-identical in replay mode, handed to the judge in live mode.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DateTime } from "../../skills/n8n-to-claude/runtime/vendor/luxon.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let TABLE = null;
export function table() {
  TABLE ??= JSON.parse(readFileSync(join(HERE, "effects.json"), "utf8"));
  return TABLE;
}

// ---------- small decoders ----------

function b64(s) {
  return Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

// A Gmail raw message (RFC 2822, base64url): headers and the first text/plain part. The body
// is decoded by its Content-Transfer-Encoding (the part's own, else the message's): base64, or
// quoted-printable (RFC 2045 6.7: `=\r\n` soft line breaks removed, `=XX` octets as UTF-8),
// which is what n8n's Gmail send and reply write (PROPOSALS P10).
const headerMap = (head) => {
  const headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line);
    if (m) headers[m[1].toLowerCase()] = m[2];
  }
  return headers;
};

export function decodeQuotedPrintable(s) {
  const flat = String(s).replace(/=\r?\n/g, "");
  const bytes = [];
  for (let i = 0; i < flat.length; i++) {
    const hex = flat[i] === "=" ? /^[0-9A-Fa-f]{2}/.exec(flat.slice(i + 1, i + 3)) : null;
    if (hex) {
      bytes.push(parseInt(hex[0], 16));
      i += 2;
    } else bytes.push(...Buffer.from(flat[i], "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}

export function parseMime(raw) {
  const text = b64(raw);
  const [head, ...rest] = text.split(/\r?\n\r?\n/);
  const headers = headerMap(head);
  let body = rest.join("\n\n");
  let cte = headers["content-transfer-encoding"] ?? "";
  const boundary = /boundary="?([^";]+)"?/i.exec(headers["content-type"] ?? "")?.[1];
  if (boundary) {
    const part = body.split(`--${boundary}`).find((p) => /content-type:\s*text\/plain/i.test(p)) ?? body.split(`--${boundary}`)[1] ?? "";
    const [partHead, ...partBody] = part.replace(/^\r?\n/, "").split(/\r?\n\r?\n/);
    cte = headerMap(partHead)["content-transfer-encoding"] ?? cte;
    body = partBody.join("\n\n");
  }
  if (/base64/i.test(cte)) body = b64(body.replace(/\s+/g, ""));
  else if (/quoted-printable/i.test(cte)) body = decodeQuotedPrintable(body);
  return { headers, text: body.trim() };
}

// The JSON metadata part of a multipart upload body (text, or base64 when binary).
export function multipartJson(body, encoding) {
  const s = encoding === "base64" ? Buffer.from(String(body), "base64").toString("latin1") : typeof body === "string" ? body : JSON.stringify(body ?? "");
  for (const m of s.matchAll(/\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g)) {
    try {
      const v = JSON.parse(m[0]);
      if (v && typeof v === "object") return v;
    } catch {}
  }
  return {};
}

// ---------- field extraction ----------

function get(obj, path) {
  let v = obj;
  for (const k of path.split(".")) {
    if (v == null) return undefined;
    v = v[k];
  }
  return v;
}

function extractor(ctx) {
  return (spec) => {
    for (const p of [].concat(spec ?? [])) {
      if (p === "") return "";
      const [root, ...rest] = p.split(".");
      const tail = rest.join(".");
      let v;
      if (root === "query") v = tail ? ctx.query?.(tail) : ctx.queryObj;
      else if (root === "path") v = ctx.groups?.[tail];
      else if (root === "mime") {
        ctx.mime ??= ctx.body?.raw ? parseMime(ctx.body.raw) : { headers: {}, text: undefined };
        v = tail === "text" ? ctx.mime.text : ctx.mime.headers[tail.toLowerCase()];
      } else if (root === "multipart") {
        ctx.multipart ??= multipartJson(ctx.body, ctx.bodyEncoding);
        v = get(ctx.multipart, tail);
      } else if (root === "sha256_base64" || root === "sha256_utf8") {
        // PROPOSALS P46: the SHA-256 of bytes a field carries (base64 or text), so an upload's
        // content compares with the other side's by hash.
        const raw = extractor(ctx)(tail);
        v = typeof raw === "string" ? createHash("sha256").update(Buffer.from(raw, root === "sha256_base64" ? "base64" : "utf8")).digest("hex") : undefined;
      } else if (root === "reply") v = ctx.reply?.[tail];
      else if (root === "body") v = tail ? get(ctx.body, tail) : ctx.body;
      else if (root === "args") v = tail ? get(ctx.args, tail) : ctx.args;
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return undefined;
  };
}

const hostMatch = (pattern, host) => [].concat(pattern).some((p) => p === "*" || p === host || (p.startsWith("*.") && host.endsWith(p.slice(1))));

function build(side, rule, ctx, raw) {
  const pick = extractor(ctx);
  const fields = {};
  for (const [name, f] of Object.entries(rule.fields ?? {})) {
    const v = pick(f.from);
    if (v !== undefined) fields[name] = v;
  }
  const t = pick(rule.target);
  return { side, service: rule.service, action: rule.action, effect: rule.effect, target: normTarget(t, rule.targetCmp), fields, cmp: Object.fromEntries(Object.entries(rule.fields ?? {}).map(([k, f]) => [k, f.cmp])), raw };
}

export function normTarget(t, how) {
  if (t === undefined || t === null) return "";
  if (how === "set") return setNorm(t).join(",");
  if (Array.isArray(t)) return t.map((x) => normTarget(x, how)).sort().join(",");
  const s = typeof t === "string" ? t : JSON.stringify(t);
  if (how === "id") return s.toLowerCase().replace(/^.*[/#]/, "").replace(/[^0-9a-z]/g, "").slice(-32);
  return s.trim();
}

// An HTTP request: an n8n mock-log line ({method, proxied, path, query, rawQuery, body,
// bodyEncoding}) or a runner http request ({method, url, query, body}).
export function fromHttp(entry, side = "n8n") {
  const T = table();
  let u;
  try {
    u = entry.url ? new URL(entry.url) : new URL(`${entry.proxied ?? "http://mock"}${entry.path}${entry.rawQuery ? "?" + entry.rawQuery : ""}`);
  } catch {
    return null;
  }
  const method = String(entry.method ?? "GET").toUpperCase();
  const host = u.hostname.toLowerCase();
  // A multipart/form-data body (PROPOSALS P3): the mock decodes n8n's into {field: value}; the
  // runner's request carries the same fields with JSON types. Form fields are strings on the
  // wire, so both sides are compared as strings (file parts stay objects).
  if (entry.bodyEncoding === "multipart" || /multipart/i.test(entry.contentType ?? "")) entry = { ...entry, body: formStrings(entry.body) };
  const sp = new URLSearchParams(u.search);
  for (const [k, v] of Object.entries(entry.url ? entry.query ?? {} : {})) for (const x of [].concat(v)) sp.append(k, typeof x === "string" ? x : JSON.stringify(x));
  const path = decodeURIComponent(u.pathname);
  if (T.ignore.some((r) => (r.method === "*" || r.method === method) && hostMatch(r.host, host) && (!r.path || new RegExp(r.path).test(path)))) return null;
  const query = (k) => {
    const all = sp.getAll(k);
    return all.length > 1 ? all : all[0];
  };
  const queryObj = Object.fromEntries([...new Set(sp.keys())].map((k) => [k, query(k)]));
  for (const rule of T.http) {
    if (rule.method !== "*" && rule.method !== method) continue;
    if (!hostMatch(rule.host, host)) continue;
    const m = new RegExp(rule.path).exec(path);
    if (!m) continue;
    if (rule.when && !Object.entries(rule.when).every(([p, v]) => (p.startsWith("query.") ? query(p.slice(6)) === v : true))) continue;
    return build(side, rule, { body: entry.body, bodyEncoding: entry.bodyEncoding, query, queryObj, groups: m.groups ?? {} }, { method, url: `${u.origin}${u.pathname}`, query: queryObj, body: entry.body });
  }
  // No rule: the effect is still recorded, keyed by host and a path with ids generalised, so it
  // can only match the same raw request on the other side. PROPOSALS P113: a credential carried
  // in the query (`access_token`, OAuth 2.0 bearer token as a URI query parameter, RFC 6750 2.3)
  // is left out, as header credentials are: n8n's bench dummy and the Claude side's secret
  // placeholder are not the request's content.
  const generic = path.replace(/\/[0-9A-Za-z_-]{12,}(?=\/|$)/g, "/:id").replace(/\/\d+(?=\/|$)/g, "/:n");
  const { access_token: _token, ...queryNoCredential } = queryObj;
  return { side, service: host, action: `${method} ${generic}`, effect: ["GET", "HEAD", "OPTIONS"].includes(method) ? "read" : "write", target: path, fields: { body: entry.body, query: queryNoCredential }, cmp: { body: "exact", query: "exact" }, raw: { method, url: `${u.origin}${u.pathname}` }, unmapped: true };
}

// PROPOSALS P46: n8n 2.47.7's Google Drive upload of a stored binary is a resumable upload:
// POST /upload/drive/v3/files?uploadType=resumable with the metadata ({name, parents}), PUT of
// the bytes to the session URL the POST's Location names (?upload_id=...), then PATCH
// /drive/v3/files/<id> with name, mimeType and addParents. Drive's docs (guides/manage-uploads,
// "Perform a resumable upload") make it one file creation; the connector's create_file is one
// call. So the three mock-log lines fold into one POST line whose body carries the metadata of
// both requests and `contentSha256`, the bytes' hash (text bodies as UTF-8, base64 as decoded;
// a JSON body was re-parsed by the mock, so its bytes are not known and no hash is given). The
// PATCH is dropped; the PUT stays (effects.json ignores it). Lines are matched in log order: a
// resumable POST, the next unused PUT on the upload path with an upload_id, then the next PATCH
// of a file whose body names the same file (or names none). Anything else is left as it is.
const DRIVE_HOSTS = /^https:\/\/(www|content)\.googleapis\.com$/;
const queryOf = (e) => e.query ?? Object.fromEntries(new URLSearchParams(e.rawQuery ?? ""));
export function foldResumableUploads(entries = []) {
  const list = [...entries].map((e, i) => ({ e, i })).sort((a, b) => (a.e.seq ?? a.i) - (b.e.seq ?? b.i));
  const drop = new Set();
  const folded = new Map();
  const used = new Set();
  for (let k = 0; k < list.length; k++) {
    const { e: post, i } = list[k];
    if (post.method !== "POST" || !DRIVE_HOSTS.test(String(post.proxied ?? "")) || post.path !== "/upload/drive/v3/files" || queryOf(post).uploadType !== "resumable") continue;
    const meta = post.body && typeof post.body === "object" && !Array.isArray(post.body) ? post.body : {};
    const putAt = list.findIndex((x, j) => j > k && !used.has(x.i) && x.e.method === "PUT" && DRIVE_HOSTS.test(String(x.e.proxied ?? "")) && x.e.path === "/upload/drive/v3/files" && queryOf(x.e).upload_id);
    if (putAt < 0) continue;
    const put = list[putAt].e;
    used.add(list[putAt].i);
    const patchAt = list.findIndex((x, j) => j > putAt && !used.has(x.i) && x.e.method === "PATCH" && DRIVE_HOSTS.test(String(x.e.proxied ?? "")) && /^\/drive\/v3\/files\/[^/]+$/.test(x.e.path) && (!meta.name || !x.e.body?.name || x.e.body.name === meta.name));
    const patch = patchAt >= 0 ? list[patchAt].e : null;
    if (patch) used.add(list[patchAt].i), drop.add(list[patchAt].i);
    const bytes = put.bodyEncoding === "base64" ? Buffer.from(String(put.body ?? ""), "base64") : typeof put.body === "string" ? Buffer.from(put.body, "utf8") : put.body == null ? Buffer.alloc(0) : null;
    const addParents = patch ? queryOf(patch).addParents : undefined;
    const body = { ...meta, ...(patch?.body && typeof patch.body === "object" ? patch.body : {}) };
    if (!body.parents && addParents) body.parents = String(addParents).split(",").filter(Boolean);
    if (bytes) body.contentSha256 = createHash("sha256").update(bytes).digest("hex");
    folded.set(i, { ...post, body, bodyEncoding: "json", folded: { put: put.seq ?? null, patch: patch?.seq ?? null } });
  }
  return entries.flatMap((e, i) => (drop.has(i) ? [] : [folded.get(i) ?? e]));
}

const isFile = (v) => v && typeof v === "object" && !Array.isArray(v) && "filename" in v && "sha256" in v;
export function formStrings(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const one = (v) => (isFile(v) ? v : v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  return Object.fromEntries(Object.keys(body).sort().map((k) => [k, Array.isArray(body[k]) ? body[k].map(one) : one(body[k])]));
}

// refs: what the fixture says about things a call names only by id (refsOf). A rule with
// `replyTo` (a reply tool) resolves `reply.*` from the message it answers (replyFields).
export function fromTool(call, side = "claude", refs = null) {
  const rule = table().tools.find((t) => t.connector === call.connector && t.tool === call.tool);
  if (!rule) return { side, service: call.connector, action: call.tool, effect: call.effect === "read" ? "read" : "write", target: "", fields: { args: call.args }, cmp: { args: "exact" }, raw: call, unmapped: true };
  const ctx = { args: call.args ?? {} };
  if (rule.replyTo) ctx.reply = replyFields(refs?.[rule.service], extractor({ args: ctx.args })(rule.replyTo), ctx.args);
  return build(side, rule, ctx, call);
}

// ---------- the message a reply answers (PROPOSALS P10) ----------
//
// A Gmail reply tool call names only the message it answers (`messageId`); n8n's Gmail reply
// sends the whole message over REST. Gmail's API docs (guides/threads, "Adding drafts and
// messages to threads"; users.messages.send) put a reply in the message's thread (`threadId`)
// with a matching Subject, and RFC 5322 3.6.3 sends it to the message's Reply-To, else its
// From; reply-all adds the message's To (and keeps its Cc), without the account's own address.
// So a reply's thread, recipients and subject are read from the replied-to message as the
// fixture serves it: REST message resources (payload.headers, threadId), connector message
// rows (sender, toRecipients, ccRecipients, subject), thread lists (a message inherits its
// thread's id), n8n items; the account's address from a profile response.

const addrOf = (v) => {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap(addrOf);
  if (typeof v === "object") return v.value ? addrOf(v.value) : v.address ? [String(v.address)] : v.text ? addrOf(v.text) : [];
  return String(v).split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((x) => x.trim()).filter(Boolean);
};

export function refsOf(fx) {
  const messages = new Map();
  let self = null;
  const add = (id, info) => {
    const m = messages.get(id) ?? {};
    for (const [k, v] of Object.entries(info)) if (m[k] === undefined && v !== undefined && !(Array.isArray(v) && !v.length)) m[k] = v;
    messages.set(id, m);
  };
  const walk = (v, threadId) => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, threadId));
    if (!v || typeof v !== "object") {
      if (typeof v === "string" && /^\s*[{[]/.test(v)) {
        try {
          walk(JSON.parse(v), threadId);
        } catch {}
      }
      return;
    }
    if (typeof v.emailAddress === "string" && ("messagesTotal" in v || "historyId" in v)) self ??= v.emailAddress;
    if (typeof v.id === "string") {
      const h = Array.isArray(v.payload?.headers) ? Object.fromEntries(v.payload.headers.map((x) => [String(x.name).toLowerCase(), x.value])) : null;
      const hdr = (k) => h?.[k] ?? v.headers?.[k] ?? v[k[0].toUpperCase() + k.slice(1)] ?? v[k];
      const isMessage = h || "sender" in v || "toRecipients" in v || (("threadId" in v || threadId) && (hdr("from") !== undefined || hdr("subject") !== undefined));
      if (isMessage)
        add(v.id, {
          thread: v.threadId ?? threadId,
          from: addrOf(h?.from ?? v.sender ?? hdr("from")),
          replyTo: addrOf(h?.["reply-to"] ?? v.replyTo ?? hdr("reply-to")),
          to: addrOf(h?.to ?? v.toRecipients ?? hdr("to")),
          cc: addrOf(h?.cc ?? v.ccRecipients ?? hdr("cc")),
          subject: h?.subject ?? v.subject ?? hdr("subject"),
        });
      if (Array.isArray(v.messages)) return walk(v.messages, v.threadId ?? v.id);
    }
    for (const x of Object.values(v)) walk(x, undefined);
  };
  const sources = [...(fx?.reads ?? []), ...(fx?.writeReplies ?? [])];
  for (const r of sources) walk((r.http?.responses ?? []).map((x) => x.body), undefined);
  for (const r of sources) walk((r.connector?.calls ?? []).map((c) => c.result ?? c.text), undefined);
  for (const r of sources) walk(r.n8n?.items ?? [], undefined);
  walk(fx?.trigger?.items ?? [], undefined);
  return { gmail: { messages, self } };
}

const bare = (a) => (/<([^>]+)>/.exec(a)?.[1] ?? a).trim().toLowerCase();

export function replyFields(ref, messageId, args = {}) {
  const m = messageId != null ? ref?.messages?.get(String(messageId)) : null;
  if (!m) return {};
  const notSelf = (list) => list.filter((a) => !ref.self || bare(a) !== bare(ref.self));
  const primary = m.replyTo?.length ? m.replyTo : m.from ?? [];
  const all = args.replyAll === true;
  const recipient = all ? notSelf([...primary, ...(m.to ?? [])]) : primary;
  return { thread: m.thread, recipient: recipient.length ? recipient : undefined, cc: all && m.cc?.length ? notSelf(m.cc) : undefined, subject: m.subject };
}

export function reply(text, side) {
  const r = table().reply;
  return { side, service: r.service, action: r.action, effect: r.effect, target: "", fields: { text }, cmp: { text: "text" }, raw: { text } };
}

// PROPOSALS P70: a run with no effect and no reply (a manual workflow whose result stays in its
// last nodes) is compared on what it computed: each terminal node's output items (n8n's
// terminal nodes: the ones that ran with no connection to a node that ran), json only, keyed by node, so
// the same node's items are paired. A pass compared this way is reported apart (`noEffect`
// "result"), like a reply-only pass. `outputs` is the node's last run: a list of outputs, each
// a list of item json.
export function resultOf(node, outputs, side) {
  const r = table().result;
  return { side, service: r.service, action: r.action, effect: r.effect, target: String(node), fields: { items: outputs ?? null }, cmp: { items: "exact" }, raw: { node } };
}
export const isResult = (e) => e?.service === table().result.service && e?.action === table().result.action;

// The last run's outputs of `node` as lists of item json, from n8n's summarised run data
// ({items: {main: [[json]]}}) or the runtime's ({data: {main: [[{json}]]}}).
export function lastOutputs(runs) {
  const last = [].concat(runs ?? []).at(-1);
  if (!last) return null;
  if (last.items?.main) return last.items.main.map((o) => (Array.isArray(o) ? o : []));
  return (last.data?.main ?? []).map((o) => (o ?? []).map((i) => i?.json ?? i));
}

// n8n's terminal nodes: enabled nodes that ran and whose connections (of any kind) lead to no
// node that ran: the last executed node of each path (a model, memory or tool sub-node runs too,
// but hands its output to its root node over an ai_* link; a node whose next node never ran,
// e.g. after an empty output, is where that path ended).
export function terminalNodes(wf, ran) {
  const outs = (name) => Object.values(wf?.connections?.[name] ?? {}).some((byOutput) => (byOutput ?? []).some((list) => (list ?? []).some((c) => c?.node && ran(c.node))));
  return (wf?.nodes ?? []).filter((n) => !n.disabled && ran(n.name) && !outs(n.name)).map((n) => n.name);
}

// A file on local disk after the run (PROPOSALS P44, effects.json `file`): {path, sha256, size},
// the path already resolved as n8n resolves it (n8n-side.mjs containerPath), the bytes the
// file holds at the end of the run. Keyed by path, so a write to another path never pairs.
export function fromFile(f, side) {
  const r = table().file;
  return { side, service: r.service, action: r.action, effect: r.effect, target: String(f.path), fields: { sha256: f.sha256, size: f.size }, cmp: Object.fromEntries(Object.entries(r.fields).map(([k, x]) => [k, x.cmp])), raw: { path: f.path, ...(f.node ? { node: f.node } : {}) } };
}

// A database change or statement (PROPOSALS P66, effects.json `db`): a change from the diff of
// the run's database ({engine, op, table, key?, row?, set?, rows?}) is a write keyed by
// engine.op:table, one field per column so a model-written column is judged on its own: an
// insert's row (an ObjectId the driver generated left out), an update's `$key` and changed
// columns, a delete's `$key` (or its row, for a table without a key), a dropped table's `rows`.
// A statement ({engine, sql|command, tables?|collection}) is a read keyed by the tables it names.
export function fromDb(c, side) {
  const r = table().db;
  if (c.sql !== undefined || c.command !== undefined) {
    const target = (c.tables ?? (c.collection ? [c.collection] : [])).join(",");
    return { side, service: c.engine, action: r.statement.action, effect: "read", target, fields: { statement: c.sql ?? c.command, ...(c.params ? { params: c.params } : {}) }, cmp: { statement: "exact", params: "exact" }, raw: c };
  }
  const fields = {};
  if (c.op === "insert") Object.assign(fields, c.row ?? {}), c.generatedId && delete fields._id;
  else if (c.op === "update") Object.assign(fields, { $key: c.key }, c.set ?? {});
  else if (c.op === "delete") Object.assign(fields, c.key ? { $key: c.key } : c.row ?? {});
  else if (c.op === "drop_table") fields.rows = c.rows;
  return { side, service: c.engine, action: c.op, effect: r.changes[c.op]?.effect ?? "write", target: String(c.table), fields, cmp: Object.fromEntries(Object.keys(fields).map((k) => [k, "exact"])), raw: c };
}

// ---------- comparison ----------

const keyOf = (e) => `${e.service}.${e.action}:${e.target}`;
const isWrite = (e) => e.effect === "write" || e.effect === "media";

function setNorm(v) {
  const list = [].concat(v ?? []).flatMap((x) => (typeof x === "string" ? x.split(",") : [x]));
  return list
    .map((x) => (typeof x === "string" ? (/<([^>]+)>/.exec(x)?.[1] ?? x).trim().toLowerCase() : JSON.stringify(x)))
    .filter((x) => x !== "")
    .sort();
}

// Model-written: the value is a model reply (or a string leaf of one), holds one of at least
// 12 characters, or is held in one.
export function modelWritten(value, modelTexts = []) {
  if (typeof value !== "string" || !value.trim()) return false;
  const v = value.trim();
  return modelTexts.some((t) => {
    const s = String(t ?? "").trim();
    if (s.length < 12) return v === s;
    return v === s || v.includes(s) || (v.length >= 12 && s.includes(v));
  });
}

// A field is model-written when its value (or every item of a list) holds a model reply.
function isModelWritten(v, modelTexts) {
  if (Array.isArray(v)) return v.length > 0 && v.every((x) => modelWritten(typeof x === "string" ? x : JSON.stringify(x), modelTexts));
  return modelWritten(typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v), modelTexts);
}

// A reply's subject: the same once leading Re:/Fw:/Fwd: prefixes are dropped (Gmail threads
// by matching Subject; whether a client adds "Re: " is not an effect).
const subjectNorm = (v) => String(v ?? "").trim().replace(/^(?:(?:re|fwd?|aw)\s*:\s*)+/i, "").trim();

// The comparison for a field: a `subject` rule on either side wins (a reply row against a REST
// send); otherwise the n8n side's rule, then the Claude side's.
const cmpFor = (a, b, f) => (a.cmp[f] === "subject" || b.cmp[f] === "subject" ? "subject" : a.cmp[f] ?? b.cmp[f] ?? "exact");

export function sameField(cmp, a, b) {
  if (a === undefined && b === undefined) return true;
  // PROPOSALS P46: compared when both sides carry it (an upload's content hash, which only some
  // upload paths expose), never failed for being absent on one side.
  if (cmp === "ifBoth") return a === undefined || b === undefined || JSON.stringify(a) === JSON.stringify(b);
  if (cmp === "subject") return subjectNorm(a) === subjectNorm(b);
  if (cmp === "set") return JSON.stringify(setNorm(a)) === JSON.stringify(setNorm(b));
  if (cmp === "id") return normTarget(a, "id") === normTarget(b, "id");
  if (cmp === "text") return String(a ?? "").trim() === String(b ?? "").trim();
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------- run-time timestamps (PROPOSALS P4) ----------
//
// n8n's $now/$today read the container's wall clock; the Claude side's clock is virtual from
// n8n's startedAt. A timestamp of the run itself therefore differs by seconds between the
// sides. maskRunTime() replaces each timestamp that lies within ±10 minutes of the run's start
// with a token. Only the clock digits are masked: the token keeps the format's shape (every
// non-digit character) and the zone or offset is kept verbatim, so a format or timezone
// difference still shows. Strings without a zone are read in the run's timezone (the
// template's settings.timezone, else n8n's default America/New_York), never in UTC, so a
// wrong-zone local time stays 5 hours off. Date-only strings are never masked.
// runTime: {startMs, zone, windowMs?}.

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const DAY_RE = "(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)[a-z]*";
const hour12 = (h, ap) => (ap ? (Number(h) % 12) + (/^p/i.test(ap) ? 12 : 0) : Number(h));
const RUN_TIME_FORMATS = [
  // Date.prototype.toString: Sat Nov 14 2026 00:01:23 GMT-0500 (Eastern Standard Time)
  { re: new RegExp(`\\b${DAY_RE} ${MONTH_RE} \\d{2} \\d{4} \\d{2}:\\d{2}:\\d{2}(?= GMT[+-]\\d{4})`, "g"), zone: / GMT[+-]\d{4}(?: \([^)]*\))?/y, ms: (m, z) => Date.parse(`${m}${z.replace(/ \(.*$/, "")}`) },
  // RFC 1123 / 2822: Sat, 14 Nov 2026 05:01:23 GMT
  { re: new RegExp(`\\b(?:${DAY_RE}, )?\\d{1,2} ${MONTH_RE} \\d{4} \\d{2}:\\d{2}(?::\\d{2})?(?= (?:GMT|UTC|[+-]\\d{4}))`, "g"), zone: / (?:GMT|UTC|[+-]\d{4})/y, ms: (m, z) => Date.parse(`${m}${z}`) },
  // ISO 8601 with T or a space, optional seconds, fraction and zone
  {
    re: /\b(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?![\d:])/g,
    zone: /(?:Z|[+-]\d{2}:?\d{2})(?!\d)/y,
    ms: (m, z, g, zone) => (z ? Date.parse(`${g[1]}-${g[2]}-${g[3]}T${g[4]}:${g[5]}:${g[6] ?? "00"}${g[7] ? "." + g[7].slice(0, 3) : ""}${z.length === 5 ? z.slice(0, 3) + ":" + z.slice(3) : z}`) : local(zone, +g[1], +g[2], +g[3], +g[4], +g[5], +(g[6] ?? 0))),
  },
  // en-US locale: 11/14/2026, 12:01:23 AM
  { re: /\b(\d{1,2})\/(\d{1,2})\/(\d{4}),? (\d{1,2}):(\d{2})(?::(\d{2}))?(?: ?([AaPp][Mm]))?/g, ms: (m, z, g, zone) => local(zone, +g[3], +g[1], +g[2], hour12(g[4], g[7]), +g[5], +(g[6] ?? 0)) },
  // Long English: November 14th 2026, 12:01:23 am / Nov 14, 2026 at 12:01 AM
  { re: new RegExp(`\\b(${MONTH_RE}) (\\d{1,2})(?:st|nd|rd|th)?,? (\\d{4}),? (?:at )?(\\d{1,2}):(\\d{2})(?::(\\d{2}))?(?: ?([AaPp])\\.?[Mm]\\.?)?`, "g"), ms: (m, z, g, zone) => local(zone, +g[3], MON[g[1].slice(0, 3).toLowerCase()], +g[2], hour12(g[4], g[7]), +g[5], +(g[6] ?? 0)) },
  // Epoch milliseconds and seconds
  { re: /(?<![\d.])\d{13}(?![\d.])/g, ms: (m) => Number(m) },
  { re: /(?<![\d.])\d{10}(?![\d.])/g, ms: (m) => Number(m) * 1000 },
];

function local(zone, y, mo, d, h, mi, s) {
  if (!mo) return NaN;
  const dt = DateTime.fromObject({ year: y, month: mo, day: d, hour: h, minute: mi, second: s }, { zone: zone || "America/New_York" });
  return dt.isValid ? dt.toMillis() : NaN;
}

export function maskRunTime(text, runTime) {
  if (typeof text !== "string" || !runTime || !Number.isFinite(runTime.startMs)) return text;
  const win = runTime.windowMs ?? 10 * 60 * 1000;
  let s = text;
  for (const f of RUN_TIME_FORMATS) {
    s = s.replace(f.re, (m, ...rest) => {
      const offset = rest.find((x) => typeof x === "number");
      const groups = [m, ...rest.slice(0, rest.indexOf(offset))];
      let z = "";
      if (f.zone) {
        f.zone.lastIndex = offset + m.length;
        z = f.zone.exec(s)?.[0] ?? "";
      }
      const t = f.ms(m, z, groups, runTime.zone);
      return Number.isFinite(t) && Math.abs(t - runTime.startMs) <= win ? `<run-time:${m.replace(/\d/g, "#")}>` : m;
    });
  }
  return s;
}

// Are a and b the same once run-time timestamps are masked on both sides? (exact and text
// fields only; ids and sets never carry them.)
export function sameUpToRunTime(cmp, a, b, runTime) {
  if (!runTime || cmp === "set" || cmp === "id" || cmp === "subject") return false;
  const str = (v) => (typeof v === "string" ? v : JSON.stringify(v ?? null));
  const ma = maskRunTime(str(a), runTime);
  const mb = maskRunTime(str(b), runTime);
  if (ma === str(a) && mb === str(b)) return false;
  return cmp === "text" ? ma.trim() === mb.trim() : ma === mb;
}

// ---------- pairing writes with one target (PROPOSALS P6) ----------
//
// Writes are a multiset per service.action.target. When one target gets several writes, n8n
// may send them in a different order from the runner (its HTTP Request node sends items
// concurrently), so pairing by list order compares each write with the wrong partner.
// pairWrites() pairs the writes of each key by content: a maximum-weight assignment where a
// pair's weight is the number of fields that are the same (sameField, or the same once
// run-time timestamps are masked; a differing object field counts its share of equal keys). Ties go to the pairing closest to list order (smallest
// total |i - j| within the key), so equal-content writes keep their order and the result is
// deterministic. Pairs count stays min(n8n, claude) per key, as with order pairing.
// Returns, for each n8n write, the index of its Claude write or -1.

const plainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Similarity of two effects in thousandths of a field: a field that is the same counts 1000;
// two differing object fields (a generic body) count the share of their top-level keys that
// are the same.
function fieldScore(a, b, runTime, random = false) {
  let n = 0;
  for (const f of new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])) {
    const cmp = cmpFor(a, b, f);
    const x = a.fields[f];
    const y = b.fields[f];
    if (sameField(cmp, x, y) || sameUpToRunTime(cmp, x, y, runTime) || (random && sameRandomShape(cmp, x, y))) n += 1000;
    else if (cmp === "exact" && plainObject(x) && plainObject(y)) {
      const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
      let same = 0;
      for (const k of keys) if (sameField("exact", x[k], y[k]) || sameUpToRunTime("exact", x[k], y[k], runTime)) same++;
      n += Math.floor((1000 * same) / keys.size);
    }
  }
  return n;
}

export function pairWrites(nW, cW, runTime = null, random = false) {
  const out = nW.map(() => -1);
  const groups = new Map();
  nW.forEach((a, i) => {
    const k = keyOf(a);
    if (!groups.has(k)) groups.set(k, { n: [], c: [] });
    groups.get(k).n.push(i);
  });
  cW.forEach((b, j) => groups.get(keyOf(b))?.c.push(j));
  for (const { n, c } of groups.values()) {
    if (!c.length) continue;
    if (n.length === 1 && c.length === 1) {
      out[n[0]] = c[0];
      continue;
    }
    // Integer weights: field matches dominate; displacement only breaks ties.
    const tie = n.length * Math.max(n.length, c.length) + 1;
    const w = n.map((i, x) => c.map((j, y) => fieldScore(nW[i], cW[j], runTime, random) * tie - Math.abs(x - y)));
    const assign = maxAssignment(w);
    assign.forEach((y, x) => {
      if (y >= 0) out[n[x]] = c[y];
    });
  }
  return out;
}

// Maximum-weight assignment on a rows × cols integer matrix (Hungarian method, O(n²m)):
// every row is assigned when rows <= cols, else every column. Returns the column per row, -1
// for an unassigned row. Deterministic: ties resolve by index order.
export function maxAssignment(w) {
  const rows = w.length;
  const cols = rows ? w[0].length : 0;
  if (!rows || !cols) return new Array(rows).fill(-1);
  const flip = rows > cols;
  const m = flip ? cols : rows;
  const k = flip ? rows : cols;
  const cost = (i, j) => -(flip ? w[j][i] : w[i][j]);
  const u = new Array(m + 1).fill(0);
  const v = new Array(k + 1).fill(0);
  const p = new Array(k + 1).fill(0);
  const way = new Array(k + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(k + 1).fill(Infinity);
    const usedC = new Array(k + 1).fill(false);
    do {
      usedC[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= k; j++) {
        if (usedC[j]) continue;
        const cur = cost(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= k; j++) {
        if (usedC[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const out = new Array(rows).fill(-1);
  for (let j = 1; j <= k; j++) {
    if (!p[j]) continue;
    if (flip) out[j - 1] = p[j] - 1;
    else out[p[j] - 1] = j - 1;
  }
  return out;
}

// ---------- random values in a write (PROPOSALS P133) ----------
//
// A write whose own n8n node builds a value with a randomness source in an expression
// (`{{ … Math.random() … }}`, crypto's random calls) sends a different value on every run, on
// n8n's side as on the Claude side, so no run can match it. Decided from n8n's workflow, never
// from a template id: randomWriteNodes() names the fixture's write nodes whose parameters hold
// such an expression. When there is one, a field of a paired write that differs is compared by
// type and shape (sameRandomShape: every number becomes `#`, every digit run in a string `#`,
// every UUID `<uuid>`), and a match is listed in `randomMasked` with both values, never gated.
// A difference in anything but those digits still fails.
const RANDOM_EXPR = /\bMath\.random\s*\(|\bcrypto\.(?:randomUUID|randomInt|randomBytes|getRandomValues)\s*\(|\$randomString\b/;
export function randomWriteNodes(wf, writes = []) {
  const want = new Set(writes);
  const expr = (v) => (typeof v === "string" ? v.startsWith("=") && RANDOM_EXPR.test(v) : Array.isArray(v) ? v.some(expr) : v && typeof v === "object" ? Object.values(v).some(expr) : false);
  return (wf?.nodes ?? []).filter((n) => !n.disabled && want.has(n.name) && expr(n.parameters ?? {})).map((n) => n.name);
}
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
export function randomShape(v) {
  if (typeof v === "string") return v.replace(UUID_RE, "<uuid>").replace(/\d+(?:\.\d+)?/g, "#");
  if (typeof v === "number") return "#";
  if (Array.isArray(v)) return v.map(randomShape);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, randomShape(x)]));
  return v;
}
export function sameRandomShape(cmp, a, b) {
  if (cmp === "id" || cmp === "set") return false;
  return JSON.stringify(randomShape(a)) === JSON.stringify(randomShape(b));
}

// mode: "replay" (model-written text must be byte-identical) or "live" (it goes to the judge).
// runTime ({startMs, zone}): timestamps of the run itself are masked in fields that differ
// only by them (maskRunTime); such fields are listed in `runTimeMasked`.
// PROPOSALS P53: approved substitutions (effects.json `substitutions`). A Claude-side write of a
// substitute kind (Gmail's send) that n8n has no write of its own kind and target left for is
// compared as n8n's kind (an SMTP send), and marked `substituted`. Writes n8n also made of the
// Claude kind keep pairing as themselves first.
export function applySubstitutions(n8n, claude) {
  const subs = table().substitutions?.list ?? [];
  let out = claude;
  for (const s of subs) {
    let left = n8n.filter((e) => isWrite(e) && e.service === s.n8n.service && e.action === s.n8n.action).length;
    if (!left) continue;
    const seen = new Map();
    out = out.map((e) => {
      if (!left || !isWrite(e) || !s.claude.some((c) => c.service === e.service && c.action === e.action)) return e;
      const own = keyOf(e);
      seen.set(own, (seen.get(own) ?? 0) + 1);
      if (seen.get(own) <= n8n.filter((x) => isWrite(x) && keyOf(x) === own).length) return e;
      left--;
      return { ...e, service: s.n8n.service, action: s.n8n.action, substituted: { id: s.id, from: `${e.service}.${e.action}` } };
    });
  }
  return out;
}

// PROPOSALS P107: n8n's attribution footer (effects.json `attribution`). n8n 2.47.7 appends it
// in the node itself: an HTML body becomes `\n<tabs>${html}\n<tabs><br>\n<tabs><br>\n<tabs>---
// \n<tabs><br>\n<tabs><em>This email was sent automatically with <a href="${link}"
// target="_blank">n8n</a></em>\n<tabs>`, a text body `${text}\n\n---\nThis email was sent
// automatically with n8n\nhttps://n8n.io`, where link is n8n.io with utm_campaign = the node
// type, then `_` and the instance id when n8n has one. Only that exact tail is removed (with
// the HTML form's leading line break and indentation), only for the node type the effect's
// service comes from, only on the n8n side.
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function stripAttribution(text, nodeType) {
  if (typeof text !== "string") return { text, stripped: false };
  const link = `https://n8n\\.io/\\?utm_source=n8n-internal&utm_medium=powered_by&utm_campaign=${escRe(encodeURIComponent(nodeType))}(?:_[^"\\s]+)?`;
  // The line break before the first <br> is gone when the body was empty and the mock or the
  // transport trimmed the message's ends.
  const html = new RegExp(`(?:^\\s*|\\r?\\n[\\t ]*)<br>\\r?\\n[\\t ]*<br>\\r?\\n[\\t ]*---\\r?\\n[\\t ]*<br>\\r?\\n[\\t ]*<em>This email was sent automatically with <a href="${link}" target="_blank">n8n</a></em>(?:\\r?\\n[\\t ]*)?$`);
  if (html.test(text)) return { text: text.replace(html, "").replace(/^\r?\n[\t ]*/, ""), stripped: "html" };
  const plain = /(?:^\s*|\r?\n\r?\n)---\r?\nThis email was sent automatically with n8n\r?\nhttps:\/\/n8n\.io\s*$/;
  if (plain.test(text)) return { text: text.replace(plain, ""), stripped: "text" };
  // PROPOSALS P111: Slack's message (v2.1 on, `includeLinkToWorkflow` default on, a text message)
  // gets `\n_Automated with this <{base URL}workflow/{workflow id}?utm_source=n8n-internal&
  // utm_medium=powered_by&utm_campaign=n8n-nodes-base.slack[_{instance id}]|n8n workflow>_`
  // (Slack V2 GenericFunctions.js in the 2.47.7 image). Blocks and attachments carry the line
  // in an added block or attachment, which the comparer does not compare.
  const slack = new RegExp(`(?:^|\\n)_Automated with this <[^\\s|>]*workflow/[^\\s?|>]*\\?utm_source=n8n-internal&utm_medium=powered_by&utm_campaign=${escRe(encodeURIComponent(nodeType))}(?:_[^\\s|>]+)?\\|n8n workflow>_$`);
  if (slack.test(text)) return { text: text.replace(slack, ""), stripped: "slack" };
  // PROPOSALS P131: Telegram's sendMessage (v1.1 on, `appendAttribution` default on) gets
  // `\n\n_This message was sent automatically with _[n8n](<link>)` in Markdown (its default parse
  // mode) or `\n\n<em>This message was sent automatically with </em><a href="<link>"
  // target="_blank">n8n</a>` in HTML (Telegram GenericFunctions.js in the 2.47.7 image).
  const tgMd = new RegExp(`\\n\\n_This message was sent automatically with _\\[n8n\\]\\(${link}\\)$`);
  if (tgMd.test(text)) return { text: text.replace(tgMd, ""), stripped: "telegram-markdown" };
  const tgHtml = new RegExp(`\\n\\n<em>This message was sent automatically with </em><a href="${link}" target="_blank">n8n</a>$`);
  if (tgHtml.test(text)) return { text: text.replace(tgHtml, ""), stripped: "telegram-html" };
  return { text, stripped: false };
}

export function stripAttributionAll(n8n) {
  const list = table().attribution?.list ?? [];
  return n8n.map((e) => {
    const rule = list.find((r) => r.service === e.service && r.action === e.action);
    if (!rule || typeof e.fields?.[rule.field] !== "string") return e;
    const { text, stripped } = stripAttribution(e.fields[rule.field], rule.nodeType);
    return stripped ? { ...e, fields: { ...e.fields, [rule.field]: text }, attributionStripped: { field: rule.field, form: stripped, nodeType: rule.nodeType } } : e;
  });
}

// random (PROPOSALS P133): true when a write node of the template builds a value with a
// randomness source (randomWriteNodes); differing fields equal by sameRandomShape go to
// `randomMasked`.
export function compare(n8n, claude, { modelTexts = [], mode = "replay", runTime = null, random = false } = {}) {
  n8n = stripAttributionAll(n8n);
  claude = applySubstitutions(n8n, claude);
  const nW = n8n.filter(isWrite);
  const cW = claude.filter(isWrite);
  const used = new Set();
  const writes = { matched: [], missing: [], extra: [], fieldDiffs: [] };
  const judge = [];
  const runTimeMasked = [];
  const randomMasked = [];
  const pairOf = pairWrites(nW, cW, runTime, random);
  nW.forEach((a, ai) => {
    const i = pairOf[ai];
    if (i < 0) {
      writes.missing.push(summary(a));
      return;
    }
    used.add(i);
    const b = cW[i];
    const diffs = [];
    for (const f of new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])) {
      const cmp = cmpFor(a, b, f);
      if (sameField(cmp, a.fields[f], b.fields[f])) continue;
      if (sameUpToRunTime(cmp, a.fields[f], b.fields[f], runTime)) {
        runTimeMasked.push({ effect: keyOf(a), field: f });
        continue;
      }
      if (random && sameRandomShape(cmp, a.fields[f], b.fields[f])) {
        randomMasked.push({ effect: keyOf(a), field: f, n8n: a.fields[f], claude: b.fields[f] });
        continue;
      }
      if (isModelWritten(a.fields[f], modelTexts)) {
        if (mode === "live") {
          judge.push({ effect: keyOf(a), field: f, n8n: a.fields[f], claude: b.fields[f] });
          continue;
        }
        diffs.push({ field: f, n8n: a.fields[f], claude: b.fields[f], modelWritten: true });
        continue;
      }
      diffs.push({ field: f, n8n: a.fields[f], claude: b.fields[f] });
    }
    writes.matched.push(keyOf(a));
    if (diffs.length) writes.fieldDiffs.push({ effect: keyOf(a), diffs });
  });
  cW.forEach((b, j) => used.has(j) || writes.extra.push(summary(b)));
  const nR = new Set(n8n.filter((e) => e.effect === "read").map(keyOf));
  const cR = new Set(claude.filter((e) => e.effect === "read").map(keyOf));
  const reads = { onlyN8n: [...nR].filter((k) => !cR.has(k)), onlyClaude: [...cR].filter((k) => !nR.has(k)) };
  const order = nW.map(keyOf).join("|") === cW.map(keyOf).join("|");
  const ok = !writes.missing.length && !writes.extra.length && !writes.fieldDiffs.length;
  const substituted = claude.filter((e) => e.substituted).map((e) => ({ effect: keyOf(e), ...e.substituted }));
  const attributionStripped = n8n.filter((e) => e.attributionStripped).map((e) => ({ effect: keyOf(e), ...e.attributionStripped }));
  return { ok, writes, reads, sameOrder: order, judge, runTimeMasked, ...(randomMasked.length ? { randomMasked } : {}), unmapped: [...n8n, ...claude].filter((e) => e.unmapped).map(summary), ...(substituted.length ? { substituted } : {}), ...(attributionStripped.length ? { attributionStripped } : {}) };
}

function summary(e) {
  return { key: keyOf(e), effect: e.effect, fields: e.fields, ...(e.unmapped ? { unmapped: true } : {}) };
}

// Text of every model reply in a recording (and the string leaves of replies that are JSON),
// used to tell model-written fields from deterministic ones.
export function modelTextsOf(calls, answerOf) {
  const out = [];
  for (const c of calls ?? []) {
    const a = answerOf(c.format, c.response);
    if (a.text) {
      out.push(a.text);
      const t = a.text.trim();
      const s = t.indexOf("{");
      try {
        leaves(JSON.parse(s >= 0 ? t.slice(s, t.lastIndexOf("}") + 1) : t), out);
      } catch {}
    }
    for (const call of a.calls ?? []) leaves(call.input, out);
  }
  return out.filter((x) => typeof x === "string" && x.trim().length >= 3);
}

function leaves(v, out) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => leaves(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => leaves(x, out));
}

// The final answer of a chat/form run from the last node's items (n8n's chat trigger replies
// with output, else text, else the item).
export function replyText(items) {
  const last = (items ?? []).at(-1);
  if (last === undefined) return undefined;
  const j = last?.json ?? last;
  if (j && typeof j === "object") return typeof j.output === "string" ? j.output : typeof j.text === "string" ? j.text : JSON.stringify(j.output ?? j.text ?? j);
  return String(j);
}

// PROPOSALS P30: whether the answer replyText() reads is text or a JSON value it serialised.
// An agent's final answer is text in n8n even when it reads as JSON; a side that typed it as
// an object serialises to the same characters, so the type is compared beside the text.
export function replyValueType(items) {
  const last = (items ?? []).at(-1);
  if (last === undefined) return undefined;
  const j = last?.json ?? last;
  if (!j || typeof j !== "object") return "text";
  const v = typeof j.output === "string" ? j.output : typeof j.text === "string" ? j.text : j.output ?? j.text ?? j;
  return typeof v === "string" ? "text" : "json";
}

// The chat or form reply effect of a run's last items: its text and its value type (exact).
export function replyOf(items, side) {
  const e = reply(replyText(items), side);
  const t = replyValueType(items);
  if (t) e.fields.valueType = e.raw.valueType = t;
  return e;
}

// Where a bait string shows up in a side's outgoing effects (requests, never responses).
export function baitHits(effects, bait = []) {
  const hits = [];
  for (const e of effects) {
    const s = JSON.stringify({ target: e.target, fields: e.fields }).toLowerCase();
    for (const b of bait) if (b && s.includes(String(b).toLowerCase())) hits.push({ key: keyOf(e), bait: b });
  }
  return hits;
}

export { keyOf };
