// The comparer: decides whether an n8n effect and a Claude effect are the same effect, using
// only its own table (effects.json). It never reads the converter's field map (PLAN Phase 6),
// so a wrong mapping cannot pass on both sides.
//
//   canonical effect = {side, service, action, effect: read|write|media, target, fields, raw}
//   fromHttp(entry)   an n8n mock-log line, or a runner http request ({method, url, query, body})
//   fromTool(call)    a connector call on the Claude side ({connector, tool, args})
//   compare(n8n, claude, {modelTexts, mode}) -> {ok, writes, reads, reply, judge: [...]}
//
// Writes (and media calls) are matched as multisets by service.action.target, paired by
// content within one target (pairWrites), then compared field by field. Reads are compared as sets of service.action.target and reported; they do not fail
// the comparison, because a connector legitimately pages or batches differently from n8n's
// REST calls (a wrong read shows up in the writes it feeds). A text field that holds a model
// reply is model-written: byte-identical in replay mode, handed to the judge in live mode.

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

// A Gmail raw message (RFC 2822, base64url): headers and the first text/plain part.
export function parseMime(raw) {
  const text = b64(raw);
  const [head, ...rest] = text.split(/\r?\n\r?\n/);
  const headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line);
    if (m) headers[m[1].toLowerCase()] = m[2];
  }
  let body = rest.join("\n\n");
  const boundary = /boundary="?([^";]+)"?/i.exec(headers["content-type"] ?? "")?.[1];
  if (boundary) {
    const part = body.split(`--${boundary}`).find((p) => /content-type:\s*text\/plain/i.test(p)) ?? body.split(`--${boundary}`)[1] ?? "";
    body = part.split(/\r?\n\r?\n/).slice(1).join("\n\n");
  }
  if (/base64/i.test(headers["content-transfer-encoding"] ?? "")) body = b64(body.replace(/\s+/g, ""));
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
      } else if (root === "body") v = tail ? get(ctx.body, tail) : ctx.body;
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
  // can only match the same raw request on the other side.
  const generic = path.replace(/\/[0-9A-Za-z_-]{12,}(?=\/|$)/g, "/:id").replace(/\/\d+(?=\/|$)/g, "/:n");
  return { side, service: host, action: `${method} ${generic}`, effect: ["GET", "HEAD", "OPTIONS"].includes(method) ? "read" : "write", target: path, fields: { body: entry.body, query: queryObj }, cmp: { body: "exact", query: "exact" }, raw: { method, url: `${u.origin}${u.pathname}` }, unmapped: true };
}

const isFile = (v) => v && typeof v === "object" && !Array.isArray(v) && "filename" in v && "sha256" in v;
export function formStrings(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const one = (v) => (isFile(v) ? v : v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  return Object.fromEntries(Object.keys(body).sort().map((k) => [k, Array.isArray(body[k]) ? body[k].map(one) : one(body[k])]));
}

export function fromTool(call, side = "claude") {
  const rule = table().tools.find((t) => t.connector === call.connector && t.tool === call.tool);
  if (!rule) return { side, service: call.connector, action: call.tool, effect: call.effect === "read" ? "read" : "write", target: "", fields: { args: call.args }, cmp: { args: "exact" }, raw: call, unmapped: true };
  return build(side, rule, { args: call.args ?? {} }, call);
}

export function reply(text, side) {
  const r = table().reply;
  return { side, service: r.service, action: r.action, effect: r.effect, target: "", fields: { text }, cmp: { text: "text" }, raw: { text } };
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

export function sameField(cmp, a, b) {
  if (a === undefined && b === undefined) return true;
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
  if (!runTime || cmp === "set" || cmp === "id") return false;
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
function fieldScore(a, b, runTime) {
  let n = 0;
  for (const f of new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])) {
    const cmp = a.cmp[f] ?? b.cmp[f] ?? "exact";
    const x = a.fields[f];
    const y = b.fields[f];
    if (sameField(cmp, x, y) || sameUpToRunTime(cmp, x, y, runTime)) n += 1000;
    else if (cmp === "exact" && plainObject(x) && plainObject(y)) {
      const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
      let same = 0;
      for (const k of keys) if (sameField("exact", x[k], y[k]) || sameUpToRunTime("exact", x[k], y[k], runTime)) same++;
      n += Math.floor((1000 * same) / keys.size);
    }
  }
  return n;
}

export function pairWrites(nW, cW, runTime = null) {
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
    const w = n.map((i, x) => c.map((j, y) => fieldScore(nW[i], cW[j], runTime) * tie - Math.abs(x - y)));
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

// mode: "replay" (model-written text must be byte-identical) or "live" (it goes to the judge).
// runTime ({startMs, zone}): timestamps of the run itself are masked in fields that differ
// only by them (maskRunTime); such fields are listed in `runTimeMasked`.
export function compare(n8n, claude, { modelTexts = [], mode = "replay", runTime = null } = {}) {
  const nW = n8n.filter(isWrite);
  const cW = claude.filter(isWrite);
  const used = new Set();
  const writes = { matched: [], missing: [], extra: [], fieldDiffs: [] };
  const judge = [];
  const runTimeMasked = [];
  const pairOf = pairWrites(nW, cW, runTime);
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
      const cmp = a.cmp[f] ?? b.cmp[f] ?? "exact";
      if (sameField(cmp, a.fields[f], b.fields[f])) continue;
      if (sameUpToRunTime(cmp, a.fields[f], b.fields[f], runTime)) {
        runTimeMasked.push({ effect: keyOf(a), field: f });
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
  return { ok, writes, reads, sameOrder: order, judge, runTimeMasked, unmapped: [...n8n, ...claude].filter((e) => e.unmapped).map(summary) };
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
