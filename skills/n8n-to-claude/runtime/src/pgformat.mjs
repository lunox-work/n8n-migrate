// Query formatting as pg-promise 11.9.1 does it for n8n's Postgres node (v2): the node hands
// pg-promise {query, values: [...], options: {partial: true}} per item, pg-promise writes the
// values into the text itself (as.format, the array form: $1..$100000 with an optional
// modifier) and helpers.concat joins the formatted queries with ";" after trimming spaces, tabs,
// line breaks and semicolons off both ends of each. The text then goes to the server as one
// simple query. Ported from pg-promise's lib/formatting.js and lib/helpers/methods/concat.js for
// the values n8n's node passes (strings, numbers, booleans, null, arrays, plain objects); a
// value pg-promise would format through a function or a custom type is refused.
//
// pg-promise: MIT License, Copyright (c) 2015-2018 Vitaly Tomilov. Permission is hereby
// granted, free of charge, to any person obtaining a copy of this software and associated
// documentation files (the "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,
// and/or sell copies of the Software, and to permit persons to whom the Software is furnished to
// do so, subject to the following conditions: The above copyright notice and this permission
// notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE
// IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
// LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

const FM = { raw: 1, alias: 2, name: 4, json: 8, csv: 16, value: 32 };
const FM_MAP = { "^": FM.raw, ":raw": FM.raw, ":alias": FM.alias, "~": FM.name, ":name": FM.name, ":json": FM.json, ":csv": FM.csv, ":list": FM.csv, ":value": FM.value, "#": FM.value };
const MULTIPLE_VALUES = /\$([1-9][0-9]{0,16}(?![0-9])(\^|~|#|:raw|:alias|:name|:json|:csv|:list|:value)?)/g;
const HAS_MODIFIER = /\^|~|#|:raw|:alias|:name|:json|:csv|:list|:value/;
const MAX_VARIABLE = 100000;

export class PgFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "PgFormatError";
  }
}

const isNull = (v) => v === undefined || v === null;
const wrapText = (t) => `'${t}'`;
const safeText = (t) => t.replace(/'/g, "''");
const sqlName = (n) => `"${n.replace(/"/g, '""')}"`;

function refuseCustom(value) {
  if (typeof value === "function") throw new PgFormatError("a query parameter that is a function cannot be formatted as pg-promise would call it");
  if (!isNull(value) && typeof value === "object" && (typeof value.toPostgres === "function" || typeof value[Symbol.for("ctf.toPostgres")] === "function")) throw new PgFormatError("a query parameter with custom type formatting (toPostgres) cannot be formatted");
}

function toNumber(num) {
  if (typeof num === "bigint" || Number.isFinite(num)) {
    const s = num.toString();
    return num < 0 ? `(${s})` : s;
  }
  if (num === Number.POSITIVE_INFINITY) return wrapText("+Infinity");
  if (num === Number.NEGATIVE_INFINITY) return wrapText("-Infinity");
  return wrapText("NaN");
}

// JSON as pg-promise's utils.toJson writes it (BigInt as its digits).
const toJson = (data) => (data === undefined ? undefined : JSON.stringify(data, (_, v) => (typeof v === "bigint" ? `${v}#bigint` : v)).replace(/"(-?\d+)#bigint"/g, (_, n) => n));

function asName(name) {
  if (name && typeof name === "string") return /^\s*\*(\s*)$/.test(name) ? name : sqlName(name);
  if (name && typeof name === "object") {
    const keys = Array.isArray(name) ? name : Object.keys(name);
    if (!keys.length) throw new PgFormatError("Cannot retrieve sql names from an empty array/object.");
    return keys
      .map((v) => {
        if (!v || typeof v !== "string") throw new PgFormatError(`Invalid sql name: ${JSON.stringify(v)}`);
        return sqlName(v);
      })
      .join();
  }
  throw new TypeError(`Invalid sql name: ${JSON.stringify(name)}`);
}

function asAlias(name) {
  if (name && typeof name === "string")
    return name
      .split(".")
      .filter((f) => f)
      .map((a) => {
        const m = a.match(/^([a-z_][a-z0-9_$]*|[A-Z_][A-Z0-9_$]*)$/);
        return m && m[0] === a ? a : `"${a.replace(/"/g, '""')}"`;
      })
      .join(".");
  throw new TypeError(`Invalid sql alias: ${JSON.stringify(name)}`);
}

function formatArray(array) {
  const loop = (a) => "[" + a.map((v) => (Array.isArray(v) ? loop(v) : formatValue(v, null))).join() + "]";
  return array.length ? "array" + loop(array) : "'{}'";
}

function formatCSV(values) {
  if (Array.isArray(values)) return values.map((v) => formatValue(v, null)).join();
  if (typeof values === "object" && values !== null) return Object.keys(values).map((k) => formatValue(values[k], null)).join();
  return values === undefined ? "" : formatValue(values, null);
}

export function formatValue(value, fm) {
  refuseCustom(value);
  const isRaw = !!(fm & FM.raw);
  fm &= ~FM.raw;
  switch (fm) {
    case FM.alias:
      return asAlias(value);
    case FM.name:
      return asName(value);
    case FM.json: {
      const s = toJson(value);
      return isRaw ? s : wrapText(safeText(s));
    }
    case FM.csv:
      return formatCSV(value);
    case FM.value:
      if (isNull(value)) throw new TypeError("Open values cannot be null or undefined.");
      return safeText(formatValue(value, FM.raw));
    default:
      break;
  }
  if (isNull(value)) {
    if (isRaw) throw new TypeError("Values null/undefined cannot be used as raw text.");
    return "null";
  }
  switch (typeof value) {
    case "string":
      return isRaw ? value : wrapText(safeText(value));
    case "boolean":
      return value ? "true" : "false";
    case "number":
    case "bigint":
      return toNumber(value);
    case "symbol":
      throw new TypeError(`Type Symbol has no meaning for PostgreSQL: ${value.toString()}`);
    default:
      if (Array.isArray(value)) return formatArray(value);
      if (value instanceof Date) throw new PgFormatError("a Date query parameter is formatted in the server process's local time by pg; not carried");
      {
        const s = toJson(value);
        return isRaw ? s : wrapText(safeText(s));
      }
  }
}

function stripName(name) {
  const mod = name.match(HAS_MODIFIER);
  if (mod) return { name: name.substring(0, mod.index), fm: FM_MAP[mod[0]] };
  return { name, fm: null };
}

// pg-promise as.format(query, values, {partial}) for an array of values (or none).
export function formatQuery(query, values, { partial = false } = {}) {
  if (typeof query !== "string") throw new TypeError("Parameter 'query' must be a text string.");
  if (values === undefined) return query;
  if (!Array.isArray(values)) throw new PgFormatError("only an array of query parameters is carried");
  return query.replace(MULTIPLE_VALUES, (whole) => {
    const v = stripName(whole.substring(1));
    const idx = Number(v.name) - 1;
    if (idx >= MAX_VARIABLE) throw new RangeError(`Variable $${v.name} exceeds supported maximum of $${MAX_VARIABLE}`);
    if (idx < values.length) return formatValue(values[idx], v.fm);
    if (partial) return whole;
    throw new RangeError(`Variable $${v.name} out of range. Parameters array length: ${values.length}`);
  });
}

// pg-promise helpers.concat([{query, values, options}]): each formatted, trimmed of leading and
// trailing whitespace and semicolons, the empty ones dropped, joined with ";".
export function concatQueries(queries) {
  return queries
    .map((q) => formatQuery(q.query, q.values, q.options ?? {}).replace(/^[\s;]*|[\s;]*$/g, ""))
    .filter((q) => q)
    .join(";");
}
