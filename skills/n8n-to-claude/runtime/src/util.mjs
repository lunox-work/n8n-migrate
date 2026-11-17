// Shared helpers for the runner core. No `node:` imports: the core also runs in a browser.
//
// The lodash-style path helpers mirror how n8n nodes read and write dotted keys
// ("a.b[0].c"), because n8n's nodes use lodash get/set/unset for dot notation.

export const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
export const isPlainObject = (x) => isObject(x) && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
export const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

// ---------- errors ----------

export class RunnerError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = this.constructor.name;
    Object.assign(this, extra);
  }
}
// An n8n expression error that n8n itself throws (not swallowed by its evaluator).
export class ExpressionError extends RunnerError {}
// Something n8n supports that this runtime does not (yet). Never silently skipped.
export class UnsupportedExpression extends RunnerError {}
export class UnsupportedNode extends RunnerError {}
// A request whose target is outside definition.allow, or a secret sent to a host it is not for.
export class ContainmentViolation extends RunnerError {}
// A node failed (n8n's NodeOperationError / NodeApiError).
export class NodeError extends RunnerError {}
// Malformed definition, trigger, state or results (CLI exit 2).
export class BadInput extends RunnerError {}

export function errorJson(e) {
  if (!e || typeof e !== "object") return { name: "Error", message: String(e) };
  const out = { name: e.name || "Error", message: String(e.message ?? e) };
  for (const k of ["node", "itemIndex", "description", "function", "requestId", "httpCode"]) if (e[k] !== undefined) out[k] = e[k];
  return out;
}

// ---------- copying and comparing ----------

// JSON-safe deep copy (n8n's deepCopy keeps Dates as ISO via toJSON). Luxon DateTimes
// become their ISO string, which is what n8n stores when a DateTime lands in item JSON.
export function deepCopy(v, seen = new Map()) {
  if (v === null || typeof v !== "object") return v;
  if (typeof v.toJSON === "function" && !Array.isArray(v)) return v.toJSON();
  if (seen.has(v)) return seen.get(v);
  if (Array.isArray(v)) {
    const out = [];
    seen.set(v, out);
    for (const x of v) out.push(deepCopy(x, seen));
    return out;
  }
  const out = {};
  seen.set(v, out);
  for (const k of Object.keys(v)) out[k] = deepCopy(v[k], seen);
  return out;
}

// lodash isEqual for JSON-ish values (arrays, plain objects, primitives, Dates).
export function isEqual(a, b) {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => isEqual(x, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => hasOwn(b, k) && isEqual(a[k], b[k]));
}

// Stable JSON (sorted keys) for hashing and request comparison.
export function stableStringify(v) {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (typeof v.toJSON === "function" && !Array.isArray(v)) return JSON.stringify(v.toJSON());
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}

// ---------- lodash-style paths ----------

// lodash toPath: "a.b[0]['c.d']" -> ["a", "b", "0", "c.d"]
export function toPath(path) {
  if (Array.isArray(path)) return path.map(String);
  const s = String(path);
  const out = [];
  const re = /[^.[\]]+|\[(?:(-?\d+(?:\.\d+)?)|(["'])((?:(?!\2)[^\\]|\\.)*?)\2)\]|(?=(?:\.|\[\])(?:\.|\[\]|$))/g;
  if (s.charCodeAt(0) === 46) out.push("");
  s.replace(re, (match, num, quote, sub) => {
    out.push(quote ? sub.replace(/\\(\\)?/g, "$1") : num !== undefined ? num : match);
    return match;
  });
  return out;
}

export function getPath(obj, path, dflt) {
  const keys = typeof path === "string" && hasOwn(obj, path) ? [path] : toPath(path);
  let cur = obj;
  for (const k of keys) {
    if (cur == null) return dflt;
    cur = cur[k];
  }
  return cur === undefined ? dflt : cur;
}

const isIndex = (k) => /^(?:0|[1-9]\d*)$/.test(k);

export function setPath(obj, path, value) {
  if (obj == null || typeof obj !== "object") return obj;
  const keys = toPath(path);
  let cur = obj;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k === "__proto__" || k === "constructor" || k === "prototype") return obj;
    if (i === keys.length - 1) {
      cur[k] = value;
    } else {
      const next = cur[k];
      if (next === null || typeof next !== "object") cur[k] = isIndex(keys[i + 1]) ? [] : {};
      cur = cur[k];
    }
  }
  return obj;
}

export function unsetPath(obj, path) {
  const keys = toPath(path);
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur == null || typeof cur !== "object") return true;
    cur = cur[keys[i]];
  }
  if (cur != null && typeof cur === "object") delete cur[keys[keys.length - 1]];
  return true;
}

// ---------- deterministic randomness ----------

export function seedFrom(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

// mulberry32: small, fast, good enough for Math.random in Code nodes.
export function seededRandom(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- misc ----------

export const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

export function typeName(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

// n8n's NodeApiError message for an HTTP status (n8n-workflow 2.47.7 STATUS_CODE_MESSAGES), as the
// HTTP Request node and declarative nodes (the n8n node) fail with it.
export const API_STATUS_MESSAGES = {
  400: "Bad request - please check your parameters",
  401: "Authorization failed - please check your credentials",
  403: "Forbidden - perhaps check your credentials?",
  404: "The resource you are requesting could not be found",
  405: "Method not allowed - please check you are using the right HTTP method",
  429: "The service is receiving too many requests from you",
  500: "The service was not able to process your request",
  502: "Bad gateway - the service failed to handle your request",
  503: "Service unavailable - try again later or consider setting this node to retry automatically (in the node settings)",
  504: "Gateway timed out - perhaps try again later?",
};
