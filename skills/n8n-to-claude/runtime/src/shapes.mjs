// Connector result shapes: tolerant readers for tool outputs whose real shape is not
// captured yet (the connectors publish input schemas only).
//
// A result adapter with `shape: "<name>"` (adapt.mjs) first passes the tool's raw output
// through the reader of that name. Each reader accepts every plausible shape it knows (the
// connector's own flat shape, the vendor's REST shape, a text rendering, a one-element
// wrapper) and returns one canonical object, documented per reader below. Output it does
// not recognise fails the step with "connector shape not recognised" and the keys it saw,
// never an item with silently empty fields.

import { isObject, NodeError } from "./util.mjs";

const keysOf = (v) => (isObject(v) ? Object.keys(v).slice(0, 12).join(", ") : Array.isArray(v) ? `a list of ${v.length}` : typeof v);

function unrecognised(shape, output, expected) {
  const seen = typeof output === "string" ? `text (${output.length} characters: "${output.replace(/\s+/g, " ").trim().slice(0, 60)}")` : `keys [${keysOf(output)}]`;
  return new NodeError(`connector shape not recognised (${shape}): the tool answered with ${seen}; expected ${expected}`);
}

function parseJsonText(output) {
  if (typeof output !== "string") return output;
  const t = output.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t);
    } catch {
      /* text */
    }
  }
  return output;
}

// A one-element wrapper ({message: {...}}, {result: {...}}, [{...}]) around the object.
function unwrapOne(v, keys) {
  if (Array.isArray(v) && v.length === 1) return unwrapOne(v[0], keys);
  if (isObject(v)) {
    for (const k of keys) if (isObject(v[k])) return v[k];
    if (isObject(v.structuredContent)) return unwrapOne(v.structuredContent, keys);
  }
  return v;
}

// ---------- email addresses ----------

// '"Name" <a@b>, c@d' -> [{address, name}]. Commas inside quotes do not split.
export function parseAddressList(text) {
  if (Array.isArray(text)) return text.flatMap((x) => (isObject(x) ? [{ address: String(x.address ?? x.email ?? ""), name: String(x.name ?? x.displayName ?? "") }] : parseAddressList(x)));
  if (isObject(text)) {
    if (Array.isArray(text.value)) return parseAddressList(text.value);
    if (text.address !== undefined || text.email !== undefined) return parseAddressList([text]);
    return [];
  }
  if (typeof text !== "string" || !text.trim()) return [];
  const parts = [];
  let cur = "";
  let quoted = false;
  let angle = false;
  for (const c of text) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === "<") angle = true;
    else if (!quoted && c === ">") angle = false;
    if (c === "," && !quoted && !angle) parts.push(cur), (cur = "");
    else cur += c;
  }
  parts.push(cur);
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = /^(.*?)\s*<([^>]*)>\s*$/.exec(p);
      if (!m) return { address: p.replace(/^"|"$/g, ""), name: "" };
      return { address: m[2].trim(), name: m[1].trim().replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"') };
    });
}

// ---------- gmail-message ----------
//
// Accepts: the Gmail connector's flat message (sender, toRecipients, ccRecipients,
// bccRecipients, addressDisplayNames, plaintextBody, htmlBody, subject, date, labelIds), the
// Gmail REST message (payload.headers, payload.parts / payload.body with base64url data),
// a message already in n8n's simplified (From, To, Subject) or parsed (from.value, text)
// form, and any of these under message/result or as a one-element list.
// Returns {id, threadId, labelIds, snippet, subject, date, from, to, cc, bcc, replyTo (each
// a list of {address, name}), text, html, headers (a list of {name, value} in the message's
// order; derived from the fields above when the tool returned none), headersDerived,
// messageId, inReplyTo, references (from the headers when given), attachments, viewUrl,
// sizeEstimate, historyId, internalDate}.

function b64urlText(data) {
  try {
    const bin = atob(String(data).replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

function restBodies(payload, out = {}) {
  if (!isObject(payload)) return out;
  const mime = String(payload.mimeType ?? "");
  if (payload.body?.data && !payload.filename) {
    if (mime === "text/plain" && out.text === undefined) out.text = b64urlText(payload.body.data);
    if (mime === "text/html" && out.html === undefined) out.html = b64urlText(payload.body.data);
  }
  for (const p of payload.parts ?? []) restBodies(p, out);
  return out;
}

function headerList(v) {
  if (Array.isArray(v)) return v.filter((h) => isObject(h) && typeof h.name === "string").map((h) => ({ name: h.name, value: String(h.value ?? "") }));
  if (isObject(v)) return Object.entries(v).filter(([, x]) => typeof x === "string").map(([name, value]) => ({ name, value }));
  return [];
}

const formatAddress = ({ address, name }) => (name ? `"${name.replace(/"/g, '\\"')}" <${address}>` : address);

export function gmailMessage(output) {
  const m = unwrapOne(parseJsonText(output), ["message", "result", "email"]);
  if (!isObject(m)) throw unrecognised("gmail-message", output, "one message object (sender/toRecipients, payload.headers, or From/from)");
  const restHeaders = headerList(m.payload?.headers);
  const given = restHeaders.length ? restHeaders : headerList(m.headers);
  const h = (name) => given.find((x) => x.name.toLowerCase() === name)?.value;
  const names = isObject(m.addressDisplayNames) ? m.addressDisplayNames : {};
  const named = (list) => list.map((a) => ({ address: a.address, name: a.name || String(names[a.address] ?? "") }));
  const pick = (flat, header, simpleKey, parsedKey) => {
    if (m[flat] !== undefined) return named(parseAddressList(m[flat]));
    if (m[parsedKey] !== undefined && (isObject(m[parsedKey]) || Array.isArray(m[parsedKey]))) return parseAddressList(m[parsedKey]);
    if (h(header) !== undefined) return parseAddressList(h(header));
    if (m[simpleKey] !== undefined) return parseAddressList(m[simpleKey]);
    return [];
  };
  const recognised = m.sender !== undefined || m.toRecipients !== undefined || restHeaders.length > 0 || m.From !== undefined || isObject(m.from) || typeof m.from === "string" || m.plaintextBody !== undefined;
  if (!recognised) throw unrecognised("gmail-message", output, "a message with sender/toRecipients, payload.headers, or From/from");
  const bodies = restBodies(m.payload);
  const from = pick("sender", "from", "From", "from");
  const to = pick("toRecipients", "to", "To", "to");
  const cc = pick("ccRecipients", "cc", "Cc", "cc");
  const bcc = pick("bccRecipients", "bcc", "Bcc", "bcc");
  const replyTo = pick("replyTo", "reply-to", "Reply-To", "replyTo");
  const subject = m.subject ?? h("subject") ?? m.Subject;
  const dateRaw = m.date ?? h("date") ?? (m.internalDate !== undefined ? Number(m.internalDate) : undefined);
  const dt = dateRaw === undefined ? undefined : new Date(typeof dateRaw === "number" ? dateRaw : String(dateRaw));
  const date = dt && Number.isFinite(dt.getTime()) ? dt.toISOString() : dateRaw;
  let headers = given;
  if (!headers.length) {
    headers = [];
    const add = (name, list) => list.length && headers.push({ name, value: list.map(formatAddress).join(", ") });
    add("From", from);
    add("To", to);
    add("Cc", cc);
    if (subject !== undefined) headers.push({ name: "Subject", value: String(subject) });
    if (dt && Number.isFinite(dt.getTime())) headers.push({ name: "Date", value: dt.toUTCString().replace("GMT", "+0000") });
  }
  const text = m.plaintextBody ?? m.text ?? m.textPlain ?? bodies.text;
  const html = m.htmlBody ?? (typeof m.html === "string" ? m.html : undefined) ?? bodies.html;
  const allHeaders = given;
  const hv = (name) => allHeaders.find((x) => x.name.toLowerCase() === name)?.value;
  return {
    id: m.id ?? (typeof m.messageId === "string" && !m.messageId.startsWith("<") ? m.messageId : undefined),
    threadId: m.threadId,
    labelIds: m.labelIds ?? (Array.isArray(m.labels) ? m.labels.map((l) => (isObject(l) ? l.id : l)) : undefined),
    snippet: m.snippet,
    subject,
    date,
    from,
    to,
    cc,
    bcc,
    replyTo,
    text,
    html,
    headers,
    headersDerived: !given.length,
    messageId: hv("message-id") ?? (typeof m.messageId === "string" && m.messageId.startsWith("<") ? m.messageId : undefined),
    inReplyTo: hv("in-reply-to") ?? m.inReplyTo,
    references: hv("references") ?? m.references,
    attachments: m.attachments ?? [],
    viewUrl: m.viewUrl,
    sizeEstimate: m.sizeEstimate,
    historyId: m.historyId,
    internalDate: m.internalDate,
  };
}

// ---------- notion-database ----------
//
// Accepts: a Notion REST database object (object: "database", properties), a data source
// state ({name, schema} or {title, properties}), and the connector's text rendering
// (<database url=... title=...> with a <data-source-state>{json}</data-source-state>).
// Returns a REST-shaped database: {object: "database", id, url, title: [rich text], properties:
// {name: {id?, name, type, [type]: config}}, public_url: null}. Property ids
// and option colours appear only when the tool returned them.

const uuid = (hex) => (/^[0-9a-f]{32}$/i.test(hex) ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toLowerCase() : hex);
const idFromUrl = (url) => {
  const m = /([0-9a-f]{32})(?:[?#]|$)/i.exec(String(url ?? "")) ?? /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(String(url ?? ""));
  return m ? uuid(m[1].replace(/-/g, "")) : undefined;
};
const richText = (s) => (s === undefined || s === null ? [] : [{ type: "text", text: { content: String(s), link: null }, plain_text: String(s), href: null }]);
const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") : undefined;
};

function restProperty(name, p) {
  if (!isObject(p)) p = { type: String(p) };
  const type = String(p.type ?? "rich_text");
  const out = { ...(p.id !== undefined ? { id: p.id } : {}), name: p.name ?? name, type };
  let config = isObject(p[type]) ? { ...p[type] } : {};
  const opts = p.options ?? config.options ?? (type === "status" ? p.status?.options : undefined);
  if (Array.isArray(opts)) config.options = opts.map((o) => (isObject(o) ? { ...(o.id !== undefined ? { id: o.id } : {}), name: String(o.name ?? ""), ...(o.color !== undefined ? { color: o.color } : {}) } : { name: String(o) }));
  for (const [k, v] of Object.entries(p)) if (!["id", "name", "type", "options", type, "description"].includes(k)) config[k] = v;
  out[type] = config;
  return out;
}

function fromState(state, { url, title } = {}) {
  const schema = isObject(state.schema) ? state.schema : isObject(state.properties) ? state.properties : null;
  if (!schema) return null;
  const name = title ?? state.name ?? (Array.isArray(state.title) ? state.title.map((t) => t.plain_text ?? t.text?.content ?? "").join("") : state.title);
  const properties = Object.fromEntries(Object.entries(schema).map(([k, p]) => [k, restProperty(k, p)]));
  const id = idFromUrl(url) ?? (typeof state.id === "string" ? uuid(state.id.replace(/-/g, "")) : undefined);
  return { object: "database", id, url: id ? `https://www.notion.so/${id.replace(/-/g, "")}` : url, public_url: null, title: richText(name), properties };
}

export function notionDatabase(output, outer = {}) {
  const v = unwrapOne(parseJsonText(output), ["database", "result"]);
  if (isObject(v)) {
    if (isObject(v.properties) && (v.object === "database" || Array.isArray(v.title))) {
      return { public_url: null, ...v, properties: Object.fromEntries(Object.entries(v.properties).map(([k, p]) => [k, isObject(p) && p.type && isObject(p[p.type]) ? p : restProperty(k, p)])) };
    }
    const s = fromState(v, { url: v.url });
    if (s) return s;
    // notion-fetch: {metadata: {type}, title, url, text: "<data-source ...><data-source-state>"}
    // (observed 2026-11-18); the outer url is the database's, the state's url its data source's.
    if (typeof v.text === "string") return notionDatabase(v.text, { url: v.url, title: typeof v.title === "string" ? v.title : undefined });
  }
  if (typeof v === "string") {
    const dbTag = /<database\b[^>]*>/.exec(v)?.[0] ?? "";
    const states = [...v.matchAll(/<data-source-state>([\s\S]*?)<\/data-source-state>/g)].map((m) => {
      try {
        return JSON.parse(m[1]);
      } catch {
        return null;
      }
    });
    const state = states.find(isObject);
    if (state) {
      const out = fromState(state, { url: attr(dbTag, "url") ?? outer.url, title: attr(dbTag, "title") ?? outer.title });
      if (out) return out;
    }
  }
  throw unrecognised("notion-database", output, "a Notion database (properties), a data source state (schema), or <database> text with a <data-source-state>");
}

// ---------- notion-page, notion-rows ----------
//
// notion-fetch of a page answers {metadata: {type: "page"}, title, url, text, icon, cover, path,
// page_last_edited_at} (observed 2026-11-18): the page id is only in the url. Returns
// {object: "page", id, name, url, icon, cover, last_edited_time}, the fields n8n's simplified
// page output shares (its property_* need the page's properties, which the tool renders as text).
export function notionPage(output) {
  const v = unwrapOne(parseJsonText(output), ["page", "result"]);
  if (isObject(v) && (v.object === "page" || typeof v.url === "string")) {
    const name = typeof v.title === "string" ? v.title : Array.isArray(v.title) ? v.title.map((t) => t.plain_text ?? "").join("") : v.name;
    const out = { object: "page", id: v.id ?? idFromUrl(v.url), name: name ?? "", url: v.url };
    for (const [k, from] of [["icon", "icon"], ["cover", "cover"], ["last_edited_time", "page_last_edited_at"], ["last_edited_time", "last_edited_time"], ["properties", "properties"]]) if (v[from] !== undefined && out[k] === undefined) out[k] = v[from];
    return out;
  }
  throw unrecognised("notion-page", output, "a Notion page (url, title)");
}

// notion-query-data-sources (rows mode) answers {results: [{<property>: value, ..., url}],
// has_more} (observed 2026-11-18). Returns {results: [{id, url, property_<snake_case name>}]}:
// n8n's simplified row keys; a date's expanded columns (date:<name>:start/end) become
// property_<name> = {start, end}. The title property is not marked, so n8n's `name` is missing.
const snake = (k) => String(k).trim().replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
export function notionRows(output) {
  const v = parseJsonText(output);
  const rows = Array.isArray(v) ? v : isObject(v) && Array.isArray(v.results) ? v.results : null;
  if (!rows) throw unrecognised("notion-rows", output, "{results: [rows]}");
  const out = rows.map((r) => {
    if (!isObject(r)) return { value: r };
    if (r.object === "page" && isObject(r.properties)) return r;
    const row = { id: r.id ?? idFromUrl(r.url), url: r.url };
    // {id, url, properties: {name: plain value}} (the bench's assumed rows) or the flat row.
    const props = isObject(r.properties) ? r.properties : r;
    for (const [k, x] of Object.entries(props)) {
      if (props === r && (k === "url" || k === "id")) continue;
      const d = /^date:(.+):(start|end|is_datetime)$/.exec(k);
      if (d) {
        if (d[2] === "is_datetime") continue;
        const key = `property_${snake(d[1])}`;
        row[key] = { ...(isObject(row[key]) ? row[key] : { start: null, end: null }), [d[2]]: x ?? null };
      } else row[`property_${snake(k)}`] = x;
    }
    return row;
  });
  return { results: out, has_more: isObject(v) ? Boolean(v.has_more) : false };
}

// ---------- slack-messages, slack-user ----------
//
// The Slack connector answers reads as text, not Slack's REST objects (observed 2026-11-18):
//   slack_read_channel -> {messages: "Channel: #x (C..)\n\n=== Message from Name <mail> (U..) at
//     2026-11-17 11:55:33 +08 === \nMessage TS: 1794887733.702439\n<text>\nThread: 2 replies
//     (latest: ...)\n\n=== Message ...", pagination_info: "..."}; the author part can be absent.
//   slack_read_thread -> {messages: "=== THREAD PARENT MESSAGE ===\nFrom: Name <mail> (U..)\n
//     Time: ...\nMessage TS: ...\n<text>\n\n=== THREAD REPLIES (n total) ===\n\n--- Reply 1 of n
//     ---\nFrom: ...\nTime: ...\nMessage TS: ...\n<text>", ...}
// slack-messages returns {messages: [{type: "message", user | bot_id, user_name, user_email,
// text, ts, thread_ts, reply_count, subtype}]}; Slack's own objects ({messages: [{ts, ...}]})
// pass through. Blocks, attachments, reactions and edits are not in the text.
const AUTHOR_RE = /^(.*?)(?: <([^<>]*)>)? \(([A-Z0-9]+)\)$/;
function author(s, m) {
  const a = AUTHOR_RE.exec(String(s ?? "").trim());
  if (!a) return;
  if (/^B/.test(a[3])) m.bot_id = a[3];
  else m.user = a[3];
  if (a[1]) m.user_name = a[1];
  if (a[2]) m.user_email = a[2];
}
export function parseSlackText(text) {
  const segs = [];
  let cur = null;
  let threadParent = null;
  for (const line of String(text).split("\n")) {
    const head = /^=== Message(?: from (.+?))? at (.+?) ===\s*$/.exec(line);
    if (head || /^=== THREAD PARENT MESSAGE ===\s*$/.test(line) || /^--- Reply \d+ of \d+ ---\s*$/.test(line)) {
      cur = { m: { type: "message" }, lines: [], reply: /^--- Reply/.test(line), parent: /PARENT/.test(line) };
      if (head) {
        author(head[1], cur.m);
        cur.m.date = head[2];
      }
      segs.push(cur);
      continue;
    }
    if (!cur || /^=== THREAD REPLIES \(\d+ total\) ===\s*$/.test(line)) continue;
    let m;
    if (!cur.lines.length && (m = /^From: (.*)$/.exec(line))) author(m[1], cur.m);
    else if (!cur.lines.length && (m = /^Time: (.*)$/.exec(line))) cur.m.date = m[1];
    else if (!cur.lines.length && cur.m.ts === undefined && (m = /^Message TS: (\S+)/.exec(line))) cur.m.ts = m[1];
    else cur.lines.push(line);
  }
  for (const seg of segs) {
    while (seg.lines.length && seg.lines.at(-1).trim() === "") seg.lines.pop();
    const last = seg.lines.at(-1) ?? "";
    const t = /^Thread: (\d+) repl(?:y|ies)\b/.exec(last);
    if (t) {
      seg.m.reply_count = Number(t[1]);
      seg.m.thread_ts = seg.m.ts;
      seg.lines.pop();
    }
    seg.m.text = seg.lines.join("\n");
    if (/^<@[A-Z0-9]+(\|[^>]*)?> has joined the channel$/.test(seg.m.text)) seg.m.subtype = "channel_join";
    if (seg.parent) threadParent = seg.m.ts;
  }
  if (threadParent) for (const seg of segs) seg.m.thread_ts = threadParent;
  return segs.map((s) => s.m);
}
export function slackMessages(output) {
  const v = parseJsonText(output);
  if (isObject(v) && Array.isArray(v.messages)) return { ...v };
  const text = isObject(v) ? v.messages ?? v.result ?? v.text : v;
  if (typeof text === "string" && /(^|\n)(=== Message\b|=== THREAD PARENT MESSAGE ===)/.test(text)) return { messages: parseSlackText(text), has_more: isObject(v) && /more messages available/i.test(String(v.pagination_info ?? "")) };
  if (typeof text === "string" && /^Channel: .*\n*$/.test(text.trim() + "\n")) return { messages: [] };
  throw unrecognised("slack-messages", output, "Slack messages (a list, or the connector's '=== Message' text)");
}

// slack_read_user_profile -> {result: "User ID: U..\nUsername: ..\nDisplay Name: ..\nReal Name:
// ..\nPronouns: ..\nTitle: ..\nEmail: ..\nOrganization Name: ..\nPhone: ..\nStatus: ..\n
// Timezone: ..\nAdmin: No\nOwner: No\nBot: No\nRestricted: No"} (observed 2026-11-18).
// Returns Slack's user object as n8n's user info gives it: {id, name, real_name, tz, is_admin,
// is_owner, is_bot, is_restricted, profile: {display_name, real_name, email, title, phone,
// pronouns, status_text}}; team, colour, images and the tz offset are not in the text.
export function slackUser(output) {
  const v = parseJsonText(output);
  const o = unwrapOne(v, ["user"]);
  if (isObject(o) && (o.id !== undefined || isObject(o.profile))) return o;
  const text = isObject(v) ? v.result ?? v.text : v;
  if (typeof text !== "string" || !/^User ID: /m.test(text)) throw unrecognised("slack-user", output, "a Slack user (id, profile) or the connector's 'User ID:' text");
  const f = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z ]+): ?(.*)$/.exec(line);
    if (m) f[m[1].trim()] = m[2].trim();
  }
  const yes = (k) => (f[k] === undefined ? undefined : /^yes|true$/i.test(f[k]));
  const nz = (x) => (x === undefined || x === "" ? undefined : x);
  const profile = Object.fromEntries(Object.entries({ display_name: f["Display Name"] ?? "", real_name: f["Real Name"] ?? "", email: nz(f.Email), title: f.Title ?? "", phone: f.Phone ?? "", pronouns: nz(f.Pronouns), status_text: f.Status ?? "" }).filter(([, x]) => x !== undefined));
  return Object.fromEntries(Object.entries({ id: f["User ID"], name: f.Username, real_name: f["Real Name"], tz: nz(f.Timezone), is_admin: yes("Admin"), is_owner: yes("Owner"), is_bot: yes("Bot"), is_restricted: yes("Restricted"), profile }).filter(([, x]) => x !== undefined));
}

export const SHAPES = { "gmail-message": gmailMessage, "notion-database": notionDatabase, "notion-page": notionPage, "notion-rows": notionRows, "slack-messages": slackMessages, "slack-user": slackUser };

export function readShape(name, output) {
  const fn = SHAPES[name];
  if (!fn) throw new NodeError(`unknown result shape "${name}"`);
  return fn(output);
}
