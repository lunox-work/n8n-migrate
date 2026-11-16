// The Postgres node (n8n-nodes-base Postgres v2.x) as n8n 2.47.7 runs it, for the operations
// the runtime carries: executeQuery. step.kind "db", step.db = {engine: "postgres", operation,
// connection: {host, port, database, user, ssl}, secret}; the n8n parameters stay in
// step.params and are read as n8n reads them. The node itself runs here (browser-safe, no
// node: imports); the database is reached through one host request per node run:
//
//   {kind: "db", engine: "postgres", connection, secret, mode, texts, rawTypes, largeNumbers}
//     mode "single": texts is one text (every item's query, formatted and joined with ";"),
//       sent as one simple query; the value is {results: [{command, rowCount, rows, fields}]}
//       (one per statement) or {error}.
//     mode "independently" | "transaction": one text per item, run one after another on one
//       connection (in a transaction: BEGIN first, ROLLBACK at the first error, else COMMIT);
//       the value is {runs: [{results} | {error}]}, stopping after an error in a transaction.
//   largeNumbers "numbers": bigint and numeric columns come back as numbers (the node's "Output
//   Large-Format Numbers As" option; "text", the default, keeps pg's strings).
//   rawTypes: the type OIDs the host hands back as the server's text (dates and timestamps);
//   every other column comes parsed as pg's default parsers (pg-types 2.2.0) give it, which is
//   what n8n's pg-promise sees. Timestamps are made ISO here, as n8n's per-connection type
//   parsers do, with a timestamp without a zone read in the workflow's zone (n8n's process reads
//   it in its own zone, which on n8n's default set-up is the same; see PLAN known gaps).
//
// The host (pgclient.mjs: the task driver, or a bench host) runs the texts with node-postgres.
// Behaviour read from n8n 2.47.7's Postgres v2 node in the bench image: per item the query
// parameter (its `{{ }}` parts evaluated on the item even without a leading "=") and its Query
// Parameters option (from v2.5 each expression one or more values, from v2.8 one value with
// null and a missing field as SQL NULL); pg-promise formats the values into the text (pgformat.mjs);
// options from item 0; batching "single" (default), "independently" or "transaction"; one item
// per returned row, paired with the statement it came from; no rows at all gives
// {success: true} unless every query is a SELECT; errors as n8n words them.

import { NodeError, isObject } from "./util.mjs";
import { DateTime } from "../vendor/luxon.mjs";
import { concatQueries, formatQuery } from "./pgformat.mjs";

const DATE = 1082;
const TIMESTAMP = 1114;
const TIMESTAMPTZ = 1184;
const DATE_ARRAY = 1182;
const TIMESTAMP_ARRAY = 1115;
const TIMESTAMPTZ_ARRAY = 1185;
export const PG_RAW_TYPES = [DATE, TIMESTAMP, TIMESTAMPTZ, DATE_ARRAY, TIMESTAMP_ARRAY, TIMESTAMPTZ_ARRAY];

// ---------- SQL text: which statements a query holds ----------

// The text with string literals, quoted identifiers, dollar-quoted bodies and comments blanked,
// so `;` and keywords inside them do not count.
export function blankSql(sql) {
  const s = String(sql ?? "");
  let out = "";
  for (let i = 0; i < s.length; ) {
    const two = s.slice(i, i + 2);
    if (two === "/*") {
      const end = s.indexOf("*/", i + 2);
      i = end < 0 ? s.length : end + 2;
      out += " ";
    } else if (two === "--") {
      const end = s.indexOf("\n", i + 2);
      i = end < 0 ? s.length : end;
      out += " ";
    } else if (s[i] === "'") {
      // E'...' strings take backslash escapes; '' is a quote inside any string.
      const escapes = (s[i - 1] === "E" || s[i - 1] === "e") && (i < 2 || !/[A-Za-z0-9_]/.test(s[i - 2]));
      let j = i + 1;
      while (j < s.length) {
        if (escapes && s[j] === "\\" && j + 1 < s.length) j += 2;
        else if (s[j] === "'" && s[j + 1] === "'") j += 2;
        else if (s[j] === "'") break;
        else j++;
      }
      i = j + 1;
      out += "''";
    } else if (s[i] === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === "\\" && j + 1 < s.length ? 2 : 1;
      i = j < s.length ? j + 1 : j;
      out += '""';
    } else if (s[i] === "$" && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(s.slice(i))) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i))[0];
      const end = s.indexOf(tag, i + tag.length);
      i = end < 0 ? s.length : end + tag.length;
      out += " ";
    } else {
      out += s[i];
      i++;
    }
  }
  return out;
}

const COMMANDS = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE"]);
// The first SELECT/INSERT/UPDATE/DELETE/MERGE word outside parentheses (a CTE's body or a
// subquery does not count, so WITH x AS (SELECT ...) DELETE ... is a DELETE), or null.
function topCommand(statement) {
  let depth = 0;
  for (const m of statement.matchAll(/[()]|[A-Za-z_][A-Za-z0-9_]*/g)) {
    if (m[0] === "(") depth++;
    else if (m[0] === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && COMMANDS.has(m[0].toUpperCase())) return m[0].toUpperCase();
  }
  return null;
}
export const sqlStatements = (sql) =>
  blankSql(sql)
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);
// n8n's test for "the query only reads": every statement's top-level command is SELECT (an
// empty query counts as one).
export function isSelectQuery(sql) {
  return sqlStatements(sql).every((st) => topCommand(st) === "SELECT");
}

// ---------- values n8n's node binds ----------

const RESOLVABLE = /({{[\s\S]*?}})/g;
const resolvables = (text) => (text ? [...String(text).matchAll(RESOLVABLE)].map((m) => m[1]) : []);
// n8n's evaluateExpression() of its Postgres helpers: the text a value becomes.
const valueText = (v) => (v === undefined ? "" : v === null ? "null" : typeof v === "object" ? JSON.stringify(v) : v.toString());
const isJsonText = (s) => {
  try {
    JSON.parse(String(s).trim());
    return true;
  } catch {
    return false;
  }
};
const listOf = (s) =>
  s === undefined
    ? []
    : String(s)
        .split(",")
        .filter((x) => x)
        .map((x) => x.trim());

// One item's {query, values} for executeQuery.
function itemQuery(exec, i, v, options) {
  let query = exec.param("query", i, "");
  if (typeof query !== "string") query = String(query);
  // `{{ }}` parts are evaluated on the item even when the parameter has no leading "=".
  for (const r of resolvables(query)) {
    const val = exec.evaluate("=" + r, i);
    query = query.replace(r, typeof val === "function" ? String(val) : val);
  }
  let values = [];
  let replacement = exec.param("options.queryReplacement", i, "");
  if (typeof replacement === "number") replacement = String(replacement);
  if (typeof replacement === "string") {
    const raw = exec.step.params?.options?.queryReplacement;
    if (raw) {
      if (v >= 2.5) {
        const text = String(raw).replace(/^=+/, "");
        const parts = resolvables(text);
        if (parts.length) {
          for (const part of parts) {
            const got = exec.evaluate("=" + part, i);
            if (Array.isArray(got)) {
              for (const el of got) {
                if (el === undefined) {
                  if (v >= 2.8) values.push(null);
                  continue;
                }
                values.push(typeof el === "object" && el !== null ? JSON.stringify(el) : el);
              }
              continue;
            }
            if (v >= 2.8) {
              values.push(got === null || got === undefined ? null : valueText(got));
              continue;
            }
            const t = valueText(got);
            const each = isJsonText(t) ? [t] : listOf(t);
            if (each.length) values.push(...each);
          }
        } else values.push(...listOf(text));
      } else {
        for (const part of String(raw).replace(/^=+/, "").split(",").filter((x) => x).map((x) => x.trim())) {
          const inner = resolvables(part);
          if (inner.length) for (const r of inner) values.push(exec.evaluate("=" + r, i));
          else values.push(part);
        }
      }
    }
  } else if (Array.isArray(replacement)) values = replacement;
  else if (v >= 2.8 && (replacement === null || replacement === undefined)) values = [null];
  else throw new NodeError("Query Parameters must be a string of comma-separated values or an array of values", { node: exec.name, itemIndex: i });
  // A '$1' written inside quotes is text, not a parameter, when nothing is bound (or the option
  // says so): it becomes the next parameter, holding the text $1.
  if (!replacement || options.treatQueryParametersInSingleQuotesAsText) {
    let next = values.length + 1;
    for (const lit of query.match(/'\$[0-9]+'/g) ?? []) {
      query = query.replace(lit, `$${next}`);
      values.push(lit.replace(/'/g, ""));
      next++;
    }
  }
  return { query, values, options: { partial: true } };
}

// ---------- what comes back ----------

const OFFSET = /(?:[+-]\d{2}(?::?\d{2}){0,2}|Z)$/i;
// n8n's parseDateToISO (`new Date(text).toISOString()`, the text when it is no date), with a
// timestamp that names no offset read in `zone`.
export function timestampISO(text, zone) {
  if (typeof text !== "string") return text;
  if (OFFSET.test(text.trim())) {
    const d = new Date(text);
    return Number.isNaN(d.getTime()) ? text : d.toISOString();
  }
  const dt = DateTime.fromSQL(text, { zone });
  if (dt.isValid) return dt.toUTC().toISO();
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? text : d.toISOString();
}
// pg-types' DATE parser (a Date at local midnight, Infinity for infinity), as the item's JSON
// holds it: midnight in `zone` as ISO, null for an infinite date.
export function legacyDateValue(text, zone) {
  if (typeof text !== "string") return text;
  if (/^-?infinity$/i.test(text)) return null;
  const m = /^(\d{1,})-(\d{2})-(\d{2})( BC)?$/.exec(text);
  if (!m) return text;
  const year = m[4] ? 1 - Number(m[1]) : Number(m[1]);
  const dt = DateTime.fromObject({ year, month: Number(m[2]), day: Number(m[3]) }, { zone });
  return dt.isValid ? dt.toUTC().toISO() : text;
}
// A one-dimensional Postgres array literal's elements (NULL as null), or null when it is not
// one this reads.
export function arrayElements(text) {
  if (typeof text !== "string" || text[0] !== "{" || text.at(-1) !== "}") return null;
  const body = text.slice(1, -1);
  if (body === "") return [];
  const out = [];
  let i = 0;
  while (i <= body.length) {
    if (body[i] === "{") return null;
    let el = "";
    let quoted = false;
    if (body[i] === '"') {
      quoted = true;
      i++;
      while (i < body.length && body[i] !== '"') {
        if (body[i] === "\\") i++;
        el += body[i];
        i++;
      }
      i++;
    } else {
      while (i < body.length && body[i] !== ",") el += body[i++];
    }
    out.push(!quoted && el === "NULL" ? null : el);
    if (body[i] === ",") i++;
    else break;
  }
  return out;
}

function convertRow(row, fields, v, zone) {
  for (const f of fields) {
    const val = row[f.name];
    if (val === null || val === undefined) continue;
    const t = f.dataTypeID;
    if (t === TIMESTAMP || t === TIMESTAMPTZ) row[f.name] = timestampISO(val, zone);
    else if (t === DATE) row[f.name] = v >= 2.7 ? val : legacyDateValue(val, zone);
    else if (t === DATE_ARRAY || t === TIMESTAMP_ARRAY || t === TIMESTAMPTZ_ARRAY) {
      const els = arrayElements(val);
      if (!els) continue;
      const one = t === DATE_ARRAY ? (x) => (v >= 2.7 ? x : legacyDateValue(x, zone)) : (x) => timestampISO(x, zone);
      row[f.name] = els.map((x) => (x === null ? null : one(x)));
    }
  }
  return row;
}
function resultRows(results, v, zone) {
  return (results ?? []).map((r) => (r.rows ?? []).map((row) => convertRow(isObject(row) ? row : {}, r.fields ?? [], v, zone)));
}

// n8n's parsePostgresError: a syntax error names its line, the description is the server's
// detail or hint or the failed query, a connection failure is named.
function pgError(exec, e, queries, itemIndex) {
  let message = String(e?.message ?? e);
  if (message.includes("syntax error at or near") && queries.length) {
    const snippet = /syntax error at or near "(.*)"/.exec(message)?.[1];
    const at = snippet === undefined ? -1 : queries.findIndex((q) => q.query.includes(snippet));
    if (at !== -1) {
      if (!itemIndex) itemIndex = at;
      const line = queries[at].query.split("\n").findIndex((l) => l.includes(snippet));
      message = `Syntax error at line ${line + 1} near "${snippet}"`;
    }
  }
  let description = e?.description || e?.detail || e?.hint;
  if (!description && queries[itemIndex || 0]?.query) description = `Failed query: ${queries[itemIndex || 0].query}`;
  for (const [code, text] of [
    ["ECONNREFUSED", "Connection refused"],
    ["ENOTFOUND", "Host not found"],
    ["ETIMEDOUT", "Connection timed out"],
  ])
    if (String(e?.message ?? "").includes(code)) {
      message = text;
      description = String(e.message).split(`${code} `)[1]?.trim() ?? description;
    }
  return new NodeError(message, { node: exec.name, itemIndex: itemIndex ?? 0, description });
}

async function runPostgres(exec, queries, options, v) {
  const db = exec.step.db ?? {};
  const mode = options.queryBatching || "single";
  const zone = exec.run?.timezone;
  // "Output Large-Format Numbers As" numbers: the host turns bigint and numeric text into
  // numbers (pgclient.mjs, by pg's own type names), as n8n's receive handler does.
  const largeNumbers = options.largeNumbersOutput === "numbers" ? "numbers" : "text";
  const pairOf = (i) => ({ item: i });
  const texts = mode === "single" ? [concatQueries(queries)] : queries.map((q) => formatQuery(q.query, q.values));
  const [r] = await exec.request([{ kind: "db", itemIndex: 0, engine: "postgres", connection: db.connection ?? null, secret: db.secret ?? null, mode, texts, rawTypes: PG_RAW_TYPES, largeNumbers }]);
  if (!r.ok) throw pgError(exec, r.error ?? {}, queries);
  const value = r.value ?? {};
  if (mode === "single") {
    if (value.error) {
      const err = pgError(exec, value.error, queries);
      if (!exec.continueOnFail()) throw err;
      return [{ json: { message: err.message, error: { message: err.message, ...(err.description ? { description: err.description } : {}) } } }];
    }
    // One item per row, paired with the statement (not the item) it came from, as n8n pairs it.
    const out = resultRows(value.results, v, zone).flatMap((rows, i) => rows.map((json) => ({ json, pairedItem: pairOf(i) })));
    if (out.length) return out;
    const paired = queries.map((_, i) => pairOf(i));
    if (v < 2.3) return options.operation === "select" ? [] : [{ json: { success: true }, pairedItem: paired }];
    return queries.every((q) => isSelectQuery(q.query)) ? [] : [{ json: { success: true }, pairedItem: paired }];
  }
  const out = [];
  for (let i = 0; i < queries.length; i++) {
    const run = value.runs?.[i];
    if (!run) break;
    if (run.error) {
      const err = pgError(exec, run.error, queries, i);
      if (!exec.continueOnFail()) throw err;
      out.push({ json: { error: { message: err.message, ...(err.description ? { description: err.description } : {}) } }, pairedItem: pairOf(i) });
      if (mode === "transaction") break;
      continue;
    }
    let rows = resultRows(run.results, v, zone).flat();
    if (!rows.length) rows = v < 2.3 ? (options.operation === "select" ? [] : [{ success: true }]) : isSelectQuery(queries[i].query) ? [] : [{ success: true }];
    out.push(...rows.map((json) => ({ json, pairedItem: pairOf(i) })));
  }
  return out;
}

export const postgres = {
  versions: (v) => v >= 2 && v < 3,
  async execute(exec) {
    const v = exec.typeVersion;
    const operation = exec.param("operation", 0, "insert");
    const resource = exec.param("resource", 0, "database");
    if (resource !== "database") throw new NodeError(`The operation "${operation}" is not supported!`, { node: exec.name });
    const options = { ...(exec.param("options", 0, {}) ?? {}), nodeVersion: v, operation };
    if (operation !== "executeQuery") throw new NodeError(`Postgres ${operation} is not carried by the runtime`, { node: exec.name });
    const items = exec.getInputData();
    const queries = items.map((_, i) => itemQuery(exec, i, v, options));
    return [await runPostgres(exec, queries, options, v)];
  },
};

// What a db request does to the database, for the effect ledger: a read only when every text
// holds SELECT statements alone (n8n's own test), else a write.
export function dbRequestEffect(req) {
  return (req.texts ?? []).every((t) => isSelectQuery(t)) ? "read" : "write";
}
