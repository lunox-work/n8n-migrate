// n8n expression extension functions ("abc".toTitleCase(), [1,2].sum(), $now.format(...)).
//
// Reimplements the behaviour of n8n-workflow's extensions/*-extensions.ts (n8n 2.47) from
// their documented and observed behaviour; dispatch follows n8n's `extend()`:
// array -> Array extensions; an exact ISO string (YYYY-MM-DDTHH:mm:ss.sssZ) -> Date
// extensions (except toDate/toDateTime); string; number; DateTime or Date; other object;
// boolean. If the type has no such extension, a native method of that name is called;
// then the generic isEmpty/isNotEmpty; otherwise n8n's errors are thrown.

import { DateTime, Duration } from "../vendor/luxon.mjs";
import { ExpressionError, UnsupportedExpression, isEqual, hasOwn } from "./util.mjs";
import { hashHex, toBase64, fromBase64 } from "./hash.mjs";

const fail = (m) => {
  throw new ExpressionError(m);
};
const defineField = (o, k, v) => Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });

// ---------- date parsing shared with nodes (n8n type-validation tryToParseDateTime) ----------
export function tryToParseDateTime(value, zone) {
  if (DateTime.isDateTime(value) && value.isValid) return value;
  if (value instanceof Date) {
    const d = DateTime.fromJSDate(value, { zone });
    if (d.isValid) return d;
  }
  const s = String(value).trim();
  const opts = { zone, setZone: true };
  for (const parse of [DateTime.fromISO, DateTime.fromHTTP, DateTime.fromRFC2822, DateTime.fromSQL]) {
    const d = parse.call(DateTime, s, opts);
    if (d.isValid) return d;
  }
  const d = DateTime.fromMillis(Date.parse(s), { zone });
  if (d.isValid) return d;
  throw new ExpressionError("Value is not a valid date");
}

// ---------- strings ----------
const CURRENCY_SYMBOLS = ["Lek", "؋", "$", "ƒ", "₼", "Br", "BZ$", "$b", "KM", "P", "лв", "R$", "៛", "¥", "₡", "kn", "₱", "Kč", "kr", "RD$", "£", "€", "¢", "Q", "L", "Ft", "₹", "Rp", "﷼", "₪", "J$", "₩", "₭", "ден", "RM", "₨", "₮", "MT", "C$", "₦", "B/.", "Gs", "S/.", "zł", "lei", "₽", "Дин.", "S", "R", "CHF", "NT$", "฿", "TT$", "₺", "₴", "$U", "Bs", "₫", "Z$"];
const CURRENCY = new RegExp("(" + CURRENCY_SYMBOLS.map((x) => x.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|") + ")", "gu");
const TLD = "(?:[a-zA-Z]{2,}|xn--[a-zA-Z0-9]+)";
const HOST = `(?:(?:[-\\w]+\\.)+${TLD}|localhost|\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})`;
const DOMAIN_EXTRACT = new RegExp(`^(?:(?:https?|ftp):\\/\\/)?(?:mailto:)?(?:\\/\\/)?((?:www\\.)?${HOST})(?::\\d+)?(?:\\/[^\\s?]*)?(?:\\?[^\\s#]*)?(?:#[^\\s]*)?$`, "i");
const DOMAIN = new RegExp(`^(?:www\\.)?(${HOST})(?::\\d+)?(?:\\/[^\\s?]*)?(?:\\?[^\\s#]*)?(?:#[^\\s]*)?$`, "i");
const EMAIL = /(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@(?<domain>(\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))/;
const URL_TAIL = `(?::\\d+)?(?:\\/[^\\s?#]*)?(?:\\?[^\\s#]*)?(?=([^\\s]+#.*)?)#?[^\\s]*`;
const URL_EXACT = new RegExp(`^(?:(?:https?|ftp):\\/\\/)(?:www\\.)?(${HOST})${URL_TAIL}$`, "i");
const URL_ANY = new RegExp(`(?:(?:https?|ftp):\\/\\/)(?:www\\.)?(${HOST})${URL_TAIL}`, "i");

// title-case 3.x rules (used by n8n): small words stay lower except first/last, words with
// inner capitals stay, the first alphanumeric character of each other token is uppercased.
const SMALL_WORDS = /\b(?:an?d?|a[st]|because|but|by|en|for|i[fn]|neither|nor|o[fnr]|only|over|per|so|some|tha[tn]|the|to|up|upon|vs?\.?|versus|via|when|with|without|yet)\b/i;
function titleCase(input) {
  let out = "";
  for (const m of input.matchAll(/[^\s:–—-]+|./g)) {
    const token = m[0];
    const idx = m.index;
    const manual = /.(?=[A-Z]|\..)/.test(token);
    const small = SMALL_WORDS.test(token) && idx !== 0 && idx + token.length !== input.length;
    const url = input.charAt(idx + token.length) === ":" && !/\s/.test(input.charAt(idx + token.length + 1));
    out += !manual && !small && !url ? token.replace(/[A-Za-z0-9À-ÿ]/, (c) => c.toUpperCase()) : token;
  }
  return out;
}

// Latin transliteration for replaceSpecialChars. n8n uses the `transliteration` package,
// which also romanises other scripts; those are refused here rather than guessed.
const TRANSLIT = { ß: "ss", æ: "ae", Æ: "AE", ø: "o", Ø: "O", œ: "oe", Œ: "OE", đ: "d", Đ: "D", ł: "l", Ł: "L", þ: "th", Þ: "TH", ð: "d", Ð: "D", ı: "i", ħ: "h", Ħ: "H", ŧ: "t", Ŧ: "T", "‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", "…": "...", "€": "EUR", "£": "GBP", " ": " " };
function replaceSpecialChars(value) {
  let out = "";
  for (const ch of value.normalize("NFD")) {
    if (/[̀-ͯ]/.test(ch)) continue;
    if (ch.charCodeAt(0) < 128) out += ch;
    else if (TRANSLIT[ch] !== undefined) out += TRANSLIT[ch];
    else throw new UnsupportedExpression(`replaceSpecialChars(): cannot transliterate "${ch}" without n8n's transliteration tables`, { function: "replaceSpecialChars" });
  }
  return out;
}

function removeMarkdown(value) {
  let o = value;
  try {
    o = o.replace(/^([\s\t]*)([*\-+]|\d\.)\s+/gm, "$1");
    o = o.replace(/\n={2,}/g, "\n").replace(/~~/g, "").replace(/`{3}.*\n/g, "");
    o = o
      .replace(/<[\w|\s|=|'|"|:|(|)|,|;|/|0-9|.|-]+[>|\\>]/g, "")
      .replace(/^[=-]{2,}\s*$/g, "")
      .replace(/\[\^.+?\](: .*?$)?/g, "")
      .replace(/\s{0,2}\[.*?\]: .*?$/g, "")
      .replace(/!\[.*?\][[(].*?[\])]/g, "")
      .replace(/\[(.*?)\][[(].*?[\])]/g, "$1")
      .replace(/>/g, "")
      .replace(/^\s{1,2}\[(.*?)\]: (\S+)( ".*?")?\s*$/g, "")
      .replace(/^#{1,6}\s*([^#]*)\s*(#{1,6})?/gm, "$1")
      .replace(/([*_]{1,3})(\S.*?\S)\1/g, "$2")
      .replace(/(`{3,})(.*?)\1/gm, "$2")
      .replace(/^-{3,}\s*$/g, "")
      .replace(/`(.+?)`/g, "$1")
      .replace(/\n{2,}/g, "\n\n");
  } catch {
    return value;
  }
  return o;
}

function strToInt(value, [radix]) {
  const n = parseInt(value.replace(CURRENCY, ""), radix);
  if (Number.isNaN(n)) fail("cannot convert to integer");
  return n;
}
function strToFloat(value) {
  if (value.includes(",")) fail("cannot convert to float, expected . as decimal separator");
  const n = parseFloat(value.replace(CURRENCY, ""));
  if (Number.isNaN(n)) fail("cannot convert to float");
  return n;
}
function strToDateTime(value, [fmt] = [""]) {
  try {
    if (fmt) {
      if (["ms", "s", "us", "excel"].includes(fmt)) return numToDateTime(Number(value), [fmt]);
      return DateTime.fromFormat(value, fmt);
    }
    return tryToParseDateTime(value);
  } catch {
    fail("cannot convert to Luxon DateTime");
  }
}
function isEmail(value) {
  return EMAIL.test(value) && !value.includes(" ");
}
const SHA = { sha1: "sha1", sha224: "sha224", sha256: "sha256", sha384: "sha384", sha512: "sha512", sha3: "sha3-512" };

const STRING = {
  hash(value, [alg]) {
    const a = alg?.toLowerCase() ?? "md5";
    if (a === "base64") return toBase64(value);
    if (a === "md5") return hashHex("md5", value);
    if (SHA[a]) return hashHex(SHA[a], value);
    fail(`Unknown algorithm ${a}. Available algorithms are: md5,sha1,sha224,sha256,sha384,sha512,sha3, and Base64.`);
  },
  removeMarkdown,
  removeTags: (v) => v.replace(/<[^>]*>?/gm, ""),
  toDate(value) {
    const d = new Date(Date.parse(value));
    if (d.toString() === "Invalid Date") fail("cannot convert to date");
    if (!/:/.test(value)) d.setHours(0, 0, 0);
    return d;
  },
  toDateTime: strToDateTime,
  toBoolean(value) {
    const s = value.toLowerCase();
    return s.length > 0 && !["false", "no", "0"].includes(s);
  },
  toDecimalNumber: (v) => strToFloat(v),
  toNumber(value) {
    const n = Number(value.replace(CURRENCY, ""));
    if (Number.isNaN(n)) fail("cannot convert to number");
    return n;
  },
  toFloat: (v) => strToFloat(v),
  toInt: strToInt,
  toWholeNumber: strToInt,
  toSentenceCase(value) {
    let cur = value.slice();
    let buf = "";
    while (/\p{L}/u.test(cur)) {
      const ci = cur.search(/\p{L}/u);
      cur = cur.slice(0, ci) + cur[ci].toLocaleUpperCase() + cur.slice(ci + 1).toLocaleLowerCase();
      const pi = cur.search(/[!?.]/);
      if (pi === -1) {
        buf += cur;
        cur = "";
        break;
      }
      buf += cur.slice(0, pi + 1);
      cur = cur.slice(pi + 1);
    }
    return buf + cur;
  },
  toSnakeCase: (v) => v.toLocaleLowerCase().replace(/[ \-]/g, "_").replace(/[ -⁯⸀-⹿\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, ""),
  toTitleCase: titleCase,
  urlDecode: (v, [whole = false]) => (whole ? decodeURI(String(v)) : decodeURIComponent(String(v))),
  urlEncode: (v, [whole = false]) => (whole ? encodeURI(String(v)) : encodeURIComponent(String(v))),
  quote(value, [q = '"']) {
    const escaped = value.replace(/\\/g, "\\\\");
    return `${q}${escaped.split(q).join(`\\${q}`)}${q}`;
  },
  replaceSpecialChars,
  length: (v) => v.length,
  isDomain: (v) => DOMAIN.test(v),
  isEmail,
  isNumeric: (v) => !v.includes(" ") && !Number.isNaN(Number(v)) && !Number.isNaN(parseFloat(v)),
  isUrl: (v) => URL_EXACT.test(v),
  isEmpty: (v) => v === "",
  isNotEmpty: (v) => v !== "",
  toJsonString: (v) => JSON.stringify(v),
  extractEmail: (v) => EMAIL.exec(v)?.[0],
  extractDomain(v) {
    if (isEmail(v)) return EMAIL.exec(v)?.groups?.domain;
    return v.match(DOMAIN_EXTRACT)?.[1];
  },
  extractUrl: (v) => URL_ANY.exec(v)?.[0],
  extractUrlPath(v) {
    try {
      return new URL(v).pathname;
    } catch {
      return undefined;
    }
  },
  parseJson(v) {
    try {
      return JSON.parse(v);
    } catch {
      if (v.includes("'")) fail("Parsing failed. Check you're using double quotes");
      fail("Parsing failed");
    }
  },
  base64Encode: (v) => toBase64(v),
  base64Decode: (v) => fromBase64(v),
};

// ---------- numbers ----------
function numRound(value, [places = 0]) {
  return +value.toFixed(places);
}
function numToDateTime(value, [fmt = "ms"]) {
  if (!["ms", "s", "us", "excel"].includes(fmt)) fail(`Unsupported format '${String(fmt)}'. toDateTime() supports 'ms', 's', 'us' and 'excel'.`);
  if (fmt === "excel") return DateTime.fromSeconds((value - (25567 + 2)) * 86400);
  if (fmt === "s") return DateTime.fromSeconds(value);
  if (fmt === "us") return DateTime.fromMillis(value / 1000);
  return DateTime.fromMillis(value);
}
const NUMBER = {
  ceil: Math.ceil,
  floor: Math.floor,
  format: (v, [locales = "en-US", config = {}]) => new Intl.NumberFormat(locales, config).format(v),
  round: numRound,
  abs: Math.abs,
  isInteger: Number.isInteger,
  isEven(v) {
    if (!Number.isInteger(v)) fail("isEven() is only callable on integers");
    return v % 2 === 0;
  },
  isOdd(v) {
    if (!Number.isInteger(v)) fail("isOdd() is only callable on integers");
    return Math.abs(v) % 2 === 1;
  },
  toBoolean: (v) => v !== 0,
  toInt: (v) => numRound(v, []),
  toFloat: (v) => v,
  toDateTime: numToDateTime,
};

// ---------- arrays ----------
const readable = (o, f) => hasOwn(o, f) || (f in o && (Object.getPrototypeOf(o) === null || !(f in Object.getPrototypeOf(o))));
function unique(value, keys) {
  const view = (x) => (keys.length && x && typeof x === "object" ? keys.reduce((acc, k) => (defineField(acc, k, readable(x, k) ? x[k] : undefined), acc), {}) : x);
  const out = [];
  for (const x of value) if (!out.some((y) => isEqual(view(y), view(x)))) out.push(x);
  return out;
}
const numbersOnly = (arr, fn) => {
  if (arr.some((i) => typeof i !== "number")) fail(`${fn}(): all array elements must be numbers`);
};
function arrSum(v) {
  numbersOnly(v, "sum");
  return v.reduce((p, c) => p + c, 0);
}
function arrAverage(v) {
  numbersOnly(v, "average");
  return v.length === 0 ? 0 : arrSum(v) / v.length;
}
function objCompact(value) {
  const o = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === undefined || v === "nil" || v === "") continue;
    if (typeof v === "object") {
      if (Object.keys(v).length === 0) continue;
      defineField(o, k, objCompact(v));
    } else defineField(o, k, v);
  }
  return o;
}
function mergeObjects(value, [other]) {
  if (!other) return value;
  if (typeof other !== "object") fail("merge(): expected object arg");
  const o = { ...value };
  for (const [k, v] of Object.entries(other)) if (!hasOwn(o, k)) defineField(o, k, v);
  return o;
}
function chunk(value, [size]) {
  if (typeof size !== "number" || Number.isNaN(size) || size <= 0) fail("chunk(): expected positive numeric arg, e.g. .chunk(5)");
  const out = [];
  for (let i = 0; i < value.length; i += size) out.push(value.slice(i, i + size));
  return out;
}
const needArray = (others, fn, eg) => {
  if (!Array.isArray(others)) fail(`${fn}(): expected array arg, e.g. .${fn}(${eg})`);
};
let randomSource = Math.random;
export function setExtensionRandom(fn) {
  randomSource = fn;
}
const ARRAY = {
  removeDuplicates: (v, keys) => unique(v, keys),
  unique: (v, keys) => unique(v, keys),
  first: (v) => v[0],
  last: (v) => v[v.length - 1],
  reverse: (v) => [...v].reverse(),
  pluck(value, fields) {
    if (!fields.length) return value;
    const out = [];
    for (const cur of value) {
      if (!cur || typeof cur !== "object") continue;
      const p = [];
      for (const k of Object.keys(cur)) for (const f of fields) if (f === k) p.push(cur[k]);
      if (p.length) out.push(p.length === 1 ? p[0] : p);
    }
    return out;
  },
  randomItem: (v) => (v.length ? v[Math.floor(randomSource() * v.length)] : undefined),
  sum: arrSum,
  min(v) {
    numbersOnly(v, "min");
    return v.reduce((r, x) => Math.min(r, x), Infinity);
  },
  max(v) {
    numbersOnly(v, "max");
    return v.reduce((r, x) => Math.max(r, x), -Infinity);
  },
  average: arrAverage,
  isNotEmpty: (v) => v.length > 0,
  isEmpty: (v) => v.length === 0,
  compact: (v) =>
    v
      .filter((x) => !(x && typeof x === "object" && Object.keys(x).length === 0) && x !== null && x !== undefined && x !== "nil" && x !== "")
      .map((x) => (typeof x === "object" && x !== null ? objCompact(x) : x)),
  smartJoin(value, [kf, vf]) {
    if (!kf || !vf || typeof kf !== "string" || typeof vf !== "string") fail('smartJoin(): expected two string args, e.g. .smartJoin("name", "value")');
    return value.reduce((o, v) => {
      if (typeof v === "object" && v !== null && readable(v, kf) && readable(v, vf)) defineField(o, v[kf], v[vf]);
      return o;
    }, {});
  },
  chunk,
  renameKeys(value, args) {
    if (args.length === 0 || args.length % 2 !== 0) fail('renameKeys(): expected an even amount of args: from1, to1 [, from2, to2, ...]. e.g. .renameKeys("name", "title")');
    return value.map((v) => {
      if (typeof v !== "object" || v === null) return v;
      const o = { ...v };
      for (const [from, to] of chunk(args, [2])) {
        if (hasOwn(o, from)) {
          defineField(o, to, o[from]);
          delete o[from];
        }
      }
      return o;
    });
  },
  merge(value, [others]) {
    if (others === undefined) return value.reduce((acc, cur) => (cur !== null && typeof cur === "object" && !Array.isArray(cur) ? mergeObjects(acc, [cur]) : acc), {});
    needArray(others, "merge", "[{ id: 1, otherValue: 3 }]");
    const out = {};
    for (let i = 0; i < Math.max(value.length, others.length); i++) {
      if (value[i] !== undefined && typeof value[i] === "object" && typeof others[i] === "object") {
        for (const [k, v] of Object.entries(mergeObjects(value[i], [others[i]]))) defineField(out, k, v);
      }
    }
    return out;
  },
  mergeIntoObject(value, [others]) {
    needArray(others, "mergeIntoObject", "[{ id: 1, otherValue: 3 }]");
    const out = {};
    for (let i = 0; i < Math.max(value.length, others.length); i++) {
      const a = value[i] !== null && typeof value[i] === "object";
      const b = others[i] !== null && typeof others[i] === "object";
      const src = a ? mergeObjects(value[i], b ? [others[i]] : []) : b ? others[i] : undefined;
      if (src) for (const [k, v] of Object.entries(src)) defineField(out, k, v);
    }
    return out;
  },
  union(value, [others]) {
    needArray(others, "union", "[1, 2, 3, 4]");
    const arr = Array.from(value);
    for (const v of others) if (arr.findIndex((w) => isEqual(w, v)) === -1) arr.push(v);
    return unique(arr, []);
  },
  difference(value, [others]) {
    needArray(others, "difference", "[1, 2, 3, 4]");
    return unique(value.filter((v) => others.findIndex((w) => isEqual(w, v)) === -1), []);
  },
  intersection(value, [others]) {
    needArray(others, "intersection", "[1, 2, 3, 4]");
    const out = [...value.filter((v) => others.findIndex((w) => isEqual(w, v)) !== -1), ...others.filter((v) => value.findIndex((w) => isEqual(w, v)) !== -1)];
    return unique(out, []);
  },
  append: (v, args) => v.concat(args),
  toJsonString: (v) => JSON.stringify(v),
  toInt: () => undefined,
  toFloat: () => undefined,
  toBoolean: () => undefined,
  toDateTime: () => undefined,
};

// ---------- objects ----------
const OBJECT = {
  isEmpty: (v) => Object.keys(v).length === 0,
  isNotEmpty: (v) => Object.keys(v).length !== 0,
  hasField: (v, [name]) => name in v,
  removeField(v, [name]) {
    if (!(name in v)) return v;
    const o = { ...v };
    delete o[name];
    return o;
  },
  removeFieldsContaining(v, [match]) {
    if (typeof match !== "string" || match === "") fail("removeFieldsContaining(): expected non-empty string arg");
    const o = { ...v };
    for (const [k, x] of Object.entries(v)) if (typeof x === "string" && x.includes(match)) delete o[k];
    return o;
  },
  keepFieldsContaining(v, [match]) {
    if (typeof match !== "string" || match === "") fail("argument of keepFieldsContaining must be a non-empty string");
    const o = { ...v };
    for (const [k, x] of Object.entries(v)) if (typeof x !== "string" || !x.includes(match)) delete o[k];
    return o;
  },
  compact: objCompact,
  urlEncode: (v) => new URLSearchParams(v).toString(),
  keys: (v) => Object.keys(v),
  values: (v) => Object.values(v),
  toJsonString: (v) => JSON.stringify(v),
  toInt: () => undefined,
  toFloat: () => undefined,
  toBoolean: () => undefined,
  toDateTime: () => undefined,
};

const BOOLEAN = {
  toBoolean: (v) => v,
  toInt: (v) => (v ? 1 : 0),
  toFloat: (v) => (v ? 1 : 0),
  toNumber: (v) => (v ? 1 : 0),
  toDateTime: () => undefined,
};

// ---------- dates (Luxon DateTime or JS Date) ----------
const DURATION_MAP = { day: "days", month: "months", year: "years", week: "weeks", hour: "hours", minute: "minutes", second: "seconds", millisecond: "milliseconds", ms: "milliseconds", sec: "seconds", secs: "seconds", hr: "hours", hrs: "hours", min: "minutes", mins: "minutes" };
const UNIT_MAP = { days: "day", months: "month", years: "year", hours: "hour", minutes: "minute", seconds: "second", milliseconds: "millisecond", hrs: "hour", hr: "hour", mins: "minute", min: "minute", secs: "second", sec: "second", ms: "millisecond" };
const DURATION_UNITS = ["milliseconds", "seconds", "minutes", "hours", "days", "weeks", "months", "quarters", "years"];
const DATE_PARTS = ["day", "week", "month", "year", "hour", "minute", "second", "millisecond", "weekNumber", "yearDayNumber", "weekday"];
const isDT = (d) => !!d && DateTime.isDateTime(d);
const asDT = (d) => (isDT(d) ? d : DateTime.fromJSDate(d));
const dur = (v, u) => ({ [DURATION_MAP[u] || u]: v });
function toDT(d) {
  if (isDT(d)) return d;
  if (typeof d === "string") return strToDateTime(d);
  return DateTime.fromJSDate(d);
}
function convertToDateTime(v) {
  if (typeof v === "string") {
    const c = DateTime.fromJSDate(new Date(v));
    return c.invalidReason !== null ? undefined : c;
  }
  if (v instanceof Date) return DateTime.fromJSDate(v);
  if (isDT(v)) return v;
  return undefined;
}
function plusMinus(sign) {
  return (date, args) => {
    const op = sign > 0 ? "plus" : "minus";
    const d = args.length === 1 ? args[0] : dur(args[0] ?? 0, args[1] ?? "minutes");
    if (isDT(date)) return date[op](d);
    return DateTime.fromJSDate(date)[op](d).toJSDate();
  };
}
function diffTo(date, [other, unit = "days"]) {
  let units = Array.isArray(unit) ? unit : [unit];
  if (!units.length) units = ["days"];
  const ok = new Set([...DATE_PARTS, ...DURATION_UNITS]);
  const bad = units.find((u) => !ok.has(u));
  if (bad) fail(`Unsupported unit '${String(bad)}'. Supported: ${DURATION_UNITS.map((u) => `'${u}'`).join(", ")}.`);
  const r = date.diff(toDT(other), units);
  return units.length > 1 ? r.toObject() : r.as(units[0]);
}
const DATE = {
  beginningOf(date, [raw = "week"]) {
    const unit = UNIT_MAP[raw] || raw;
    return isDT(date) ? date.startOf(unit) : DateTime.fromJSDate(date).startOf(unit).toJSDate();
  },
  endOfMonth: (date) => (isDT(date) ? date.endOf("month") : DateTime.fromJSDate(date).endOf("month").toJSDate()),
  extract(date, [part = "week"]) {
    if (part === "yearDayNumber") {
      const d = isDT(date) ? date.toJSDate() : date;
      const first = new Date(d.getFullYear(), 0, 0);
      const diff = d.getTime() - first.getTime() + (first.getTimezoneOffset() - d.getTimezoneOffset()) * 60000;
      return Math.floor(diff / 86400000);
    }
    const p = part === "week" ? "weekNumber" : part;
    return asDT(date).get(UNIT_MAP[p] || p);
  },
  isBetween(date, args) {
    if (args.length !== 2) fail("isBetween(): expected exactly two args");
    const a = convertToDateTime(args[0]);
    const b = convertToDateTime(args[1]);
    if (!a || !b) return undefined;
    return a > b ? b < date && date < a : b > date && date > a;
  },
  isDst: (date) => asDT(date).isInDST,
  isInLast(date, [v = 0, unit = "minutes"]) {
    const past = DateTime.now().minus(dur(v, unit));
    const d = asDT(date);
    return past <= d && d <= DateTime.now();
  },
  isWeekend: (date) => [6, 7].includes(asDT(date).weekday),
  minus: plusMinus(-1),
  plus: plusMinus(1),
  format: (date, [fmt, opts = {}]) => asDT(date).toFormat(fmt, { ...opts }),
  toDateTime: toDT,
  diffTo,
  diffToNow: (date, [unit]) => diffTo(date, [DateTime.now(), unit]),
  toInt: (d) => (isDT(d) ? d.toMillis() : d.getTime()),
  toFloat: (d) => (isDT(d) ? d.toMillis() : d.getTime()),
  toBoolean: () => undefined,
  isEmpty: () => false,
  isNotEmpty: () => true,
};

const TYPES = [
  ["Array", ARRAY],
  ["Date", DATE],
  ["Number", NUMBER],
  ["Object", OBJECT],
  ["String", STRING],
  ["Boolean", BOOLEAN],
];
const GENERIC = {
  isEmpty: (v) => v === null || v === undefined || !v,
  isNotEmpty: (v) => !(v === null || v === undefined || !v),
};

// Every name n8n 2.47 rewrites as an extension call (its EXPRESSION_EXTENSION_METHODS).
export const N8N_EXTENSION_NAMES = {
  Array: "removeDuplicates unique first last reverse pluck randomItem sum min max average isNotEmpty isEmpty compact smartJoin chunk renameKeys merge mergeIntoObject union difference intersection append toJsonString toInt toFloat toBoolean toDateTime",
  Date: "beginningOf endOfMonth extract isBetween isDst isInLast isWeekend minus plus format toDateTime diffTo diffToNow toInt toFloat toBoolean isEmpty isNotEmpty",
  Number: "ceil floor format round abs isInteger isEven isOdd toBoolean toInt toFloat toDateTime",
  Object: "isEmpty isNotEmpty hasField removeField removeFieldsContaining keepFieldsContaining compact urlEncode keys values toJsonString toInt toFloat toBoolean toDateTime",
  String: "hash removeMarkdown removeTags toDate toDateTime toBoolean toDecimalNumber toNumber toFloat toInt toWholeNumber toSentenceCase toSnakeCase toTitleCase urlDecode urlEncode quote replaceSpecialChars length isDomain isEmail isNumeric isUrl isEmpty isNotEmpty toJsonString extractEmail extractDomain extractUrl extractUrlPath parseJson base64Encode base64Decode",
  Boolean: "toBoolean toInt toFloat toNumber toDateTime",
};
export const EXTENSION_NAMES = [...new Set([...Object.values(N8N_EXTENSION_NAMES).flatMap((s) => s.split(" ")), "isEmpty", "isNotEmpty"])];

const isIsoDateString = (s) => typeof s === "string" && s.length > 0 && /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z/.test(s) && !Number.isNaN(new Date(s).valueOf()) && new Date(s).toISOString() === s;

function find(input, name) {
  if (["__proto__", "constructor", "prototype", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"].includes(name)) {
    fail(`Cannot access "${name}" via expression extension due to security concerns`);
  }
  // n8n converts an ISO string to a Date to pick the Date table but then calls the
  // function with the original string (so e.g. "2024-…Z".plus(1, "day") is an Invalid
  // Date in n8n too); `original` keeps that behaviour.
  const original = input;
  let table;
  let typeName;
  if (Array.isArray(input)) [typeName, table] = ["Array", ARRAY];
  else if (isIsoDateString(input) && name !== "toDate" && name !== "toDateTime") {
    input = new Date(input);
    [typeName, table] = ["Date", DATE];
  } else if (typeof input === "string") [typeName, table] = ["String", STRING];
  else if (typeof input === "number") [typeName, table] = ["Number", NUMBER];
  else if (input && (isDT(input) || input instanceof Date)) [typeName, table] = ["Date", DATE];
  else if (input !== null && typeof input === "object") [typeName, table] = ["Object", OBJECT];
  else if (typeof input === "boolean") [typeName, table] = ["Boolean", BOOLEAN];
  if (table && hasOwn(table, name)) return { input: original, fn: table[name], extended: true };
  if (typeName && N8N_EXTENSION_NAMES[typeName].split(" ").includes(name)) {
    throw new UnsupportedExpression(`${name}() on ${typeName} is an n8n expression function this runtime does not implement`, { function: name });
  }
  if (input && name && typeof input[name] === "function") return { input, fn: input[name], extended: false };
  if (hasOwn(GENERIC, name)) return { input, fn: GENERIC[name], extended: true };
  return undefined;
}

// extend(input, name, args) as injected by the rewriter.
export function extend(input, name, args) {
  const f = find(input, name);
  if (!f) {
    if (input === undefined || input === null) fail(`${name} can't be used on ${String(input)} value`);
    const have = TYPES.filter(([t]) => N8N_EXTENSION_NAMES[t].split(" ").includes(name)).map(([t]) => t);
    if (!have.length) fail(`Unknown expression function: ${name}`);
    if (have.length > 1) {
      const last = `"${have.pop()}"`;
      fail(`${name}() is only callable on types ${have.map((t) => `"${t}"`).join(", ")}, and ${last}`);
    }
    fail(`${name}() is only callable on type "${have[0]}"`);
  }
  return f.extended ? f.fn(f.input, args) : f.fn.apply(f.input, args);
}

export function extendOptional(input, name, args) {
  if (input === undefined || input === null) return undefined;
  const f = find(input, name);
  if (!f) return undefined;
  return f.extended ? f.fn(f.input, args) : f.fn.apply(f.input, args);
}

// Global helper functions n8n adds to expressions (extended-functions.ts).
function ifEmpty(value, dflt) {
  if (arguments.length !== 2) fail("expected two arguments (value, defaultValue) for this function");
  if (value === undefined || value === null || value === "") return dflt;
  if (typeof value === "object") {
    if (Array.isArray(value) && !value.length) return dflt;
    if (!Object.keys(value).length) return dflt;
  }
  return value;
}
function numberList(start, end) {
  const size = Math.abs(start - end) + 1;
  const arr = new Array(size);
  let cur = start;
  for (let i = 0; i < size; i++) arr[i] = start < end ? cur++ : cur--;
  return arr;
}
function zip(keys, values) {
  if (!Array.isArray(keys) || !Array.isArray(values)) fail("keys and values must be arrays");
  if (keys.length !== values.length) fail("keys and values not of equal length");
  const o = {};
  keys.forEach((k, i) => defineField(o, k, values[i]));
  return o;
}
function toPathSegment(value) {
  const s = String(value);
  if (s === "." || s === "..") fail(`"${s}" is not a valid path segment`);
  return encodeURIComponent(s);
}
const average = (...args) => arrAverage(args);
const not = (v) => !v;
export const EXTENDED_FUNCTIONS = { min: Math.min, max: Math.max, not, average, numberList, zip, toPathSegment, $min: Math.min, $max: Math.max, $average: average, $not: not, $ifEmpty: ifEmpty };

// For coverage reports: whether a method name used in expressions is supported.
export function methodSupport(name) {
  const n8nHas = Object.values(N8N_EXTENSION_NAMES).some((s) => s.split(" ").includes(name)) || name === "isEmpty" || name === "isNotEmpty";
  const weHave = TYPES.some(([, t]) => hasOwn(t, name)) || hasOwn(GENERIC, name);
  if (n8nHas) return weHave ? "extension" : "missing";
  const natives = [String.prototype, Array.prototype, Number.prototype, Date.prototype, Object.prototype, RegExp.prototype, Map.prototype, Set.prototype, Promise.prototype, DateTime.prototype, Duration.prototype];
  const statics = [Object, Array, JSON, Math, Number, String, Date, DateTime, Duration, Promise];
  if (natives.some((p) => typeof p[name] === "function") || statics.some((s) => typeof s[name] === "function")) return "native";
  return "other";
}
