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

export function notionDatabase(output) {
  const v = unwrapOne(parseJsonText(output), ["database", "result"]);
  if (isObject(v)) {
    if (isObject(v.properties) && (v.object === "database" || Array.isArray(v.title))) {
      return { public_url: null, ...v, properties: Object.fromEntries(Object.entries(v.properties).map(([k, p]) => [k, isObject(p) && p.type && isObject(p[p.type]) ? p : restProperty(k, p)])) };
    }
    const s = fromState(v, { url: v.url });
    if (s) return s;
    if (typeof v.text === "string") return notionDatabase(v.text);
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
      const out = fromState(state, { url: attr(dbTag, "url"), title: attr(dbTag, "title") });
      if (out) return out;
    }
  }
  throw unrecognised("notion-database", output, "a Notion database (properties), a data source state (schema), or <database> text with a <data-source-state>");
}

export const SHAPES = { "gmail-message": gmailMessage, "notion-database": notionDatabase };

export function readShape(name, output) {
  const fn = SHAPES[name];
  if (!fn) throw new NodeError(`unknown result shape "${name}"`);
  return fn(output);
}
