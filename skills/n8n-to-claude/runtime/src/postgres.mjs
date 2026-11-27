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
//   it in its own zone, which on n8n's default set-up is the same; see docs/DESIGN.md known gaps).
//
// The host (pgclient.mjs: the task driver, or a bench host) runs the texts with node-postgres.
// Behaviour read from n8n 2.47.7's Postgres v2 node in the bench image: per item the query
// parameter (its `{{ }}` parts evaluated on the item even without a leading "=") and its Query
// Parameters option (from v2.5 each expression one or more values, from v2.8 one value with
// null and a missing field as SQL NULL); pg-promise formats the values into the text (pgformat.mjs);
// options from item 0; batching "single" (default), "independently" or "transaction"; one item
// per returned row, paired with the statement it came from; no rows at all gives
// {success: true} unless every query is a SELECT; errors as n8n words them.

import { NodeError, ExpressionError, isObject, deepCopy, errorJson } from "./util.mjs";
import { validateFieldType } from "./filter.mjs";
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
  // pg-promise formats inside n8n's try, so a value it cannot format fails like a query: in
  // "single" mode before anything is sent, otherwise as that query's error ({error} in place of
  // its text; the host fails it where it stands).
  let texts;
  let formatError = null;
  if (mode === "single") {
    try {
      texts = [concatQueries(queries)];
    } catch (e) {
      formatError = { message: String(e?.message ?? e) };
    }
  } else
    texts = queries.map((q) => {
      try {
        return formatQuery(q.query, q.values);
      } catch (e) {
        return { error: { message: String(e?.message ?? e) } };
      }
    });
  let value;
  if (formatError) value = { error: formatError };
  else {
    const [r] = await exec.request([{ kind: "db", itemIndex: 0, engine: "postgres", connection: db.connection ?? null, secret: db.secret ?? null, mode, texts, rawTypes: PG_RAW_TYPES, largeNumbers }]);
    if (!r.ok) throw pgError(exec, r.error ?? {}, queries);
    value = r.value ?? {};
  }
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

// ---------- the table operations: select, insert, update, upsert, deleteTable ----------
//
// As n8n 2.47.7's Postgres v2 builds them (read in the bench image): per item a query of
// pg-promise placeholders and values (`$1:name.$2:name` for schema and table, `:csv` for an
// item's values), formatted by pgformat.mjs and run as executeQuery's are (batching, pairing,
// {success: true}, errors). insert, update and upsert first read the table's columns from
// information_schema (again whenever an item names another table) and check each item against
// them; update (from v2.2) first asks whether each item's row exists. The parameter defaults n8n
// fills from the node description are filled here (tableDefaults), as are the resource mapper
// checks n8n-core applies when `columns.value` is read (columnValues).

export const TABLE_OPERATIONS = ["select", "insert", "update", "upsert", "deleteTable"];
const SCHEMA_QUERY = "SELECT column_name, data_type, is_nullable, udt_name, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2";
const CONDITIONS = new Set(["equal", "!=", "LIKE", ">", "<", ">=", "<=", "IS NULL", "IS NOT NULL", "="]);

// The parameters n8n's workflow fills from the node description before the node runs (only
// those its display rules show), applied to a copy of step.params.
export function tableDefaults(v, params) {
  const p = { ...(params ?? {}) };
  const op = p.operation ?? "insert";
  const rl = (dflt) => ({ __rl: true, mode: "list", value: dflt });
  p.schema ??= rl("public");
  p.table ??= rl("");
  p.options ??= {};
  const whereShown = op === "select" || (op === "deleteTable" && (p.deleteCommand ?? "truncate") === "delete");
  if (op === "deleteTable") {
    p.deleteCommand ??= "truncate";
    if (p.deleteCommand === "truncate") p.restartSequences ??= false;
  }
  if (whereShown) {
    p.where ??= {};
    p.combineConditions ??= "AND";
    if (Array.isArray(p.where?.values))
      p.where = {
        ...p.where,
        values: p.where.values.map((c) => {
          if (!isObject(c)) return c;
          const out = { column: "", condition: "equal", ...c };
          if (!["IS NULL", "IS NOT NULL"].includes(out.condition)) out.value ??= "";
          return out;
        }),
      };
  }
  if (op === "select") {
    p.returnAll ??= false;
    if (!p.returnAll) p.limit ??= 50;
    p.sort ??= {};
    if (Array.isArray(p.sort?.values)) p.sort = { ...p.sort, values: p.sort.values.map((r) => (isObject(r) ? { column: "", direction: "ASC", ...r } : r)) };
  }
  if (["insert", "update", "upsert"].includes(op)) {
    if (v >= 2.2) p.columns ??= { mappingMode: "defineBelow", value: null };
    else {
      p.dataMode ??= "autoMapInputData";
      if (op !== "insert") p.columnToMatchOn ??= "";
      if (p.dataMode === "defineBelow") {
        p.valuesToSend ??= {};
        if (op !== "insert") p.valueToMatchOn ??= "";
      } else if (op === "update") delete p.valueToMatchOn; // hidden, so n8n drops it (and update then cannot read it)
    }
  }
  return p;
}

// getNodeParameter(name, i, undefined, {extractValue: true}) for the schema and table locators.
function locatorValue(exec, name, i) {
  const v = exec.param(name, i, undefined);
  return isObject(v) && "__rl" in v && "mode" in v && "value" in v ? v.value : v;
}

// n8n-core's check of a resource mapper's values when `columns.value` is read (mode "add" also
// requires the schema's required fields; the Postgres mapper offers no type conversion options,
// so values are checked loosely and a typed value is parsed: a number, a boolean, a DateTime).
function columnValues(exec, i, mode) {
  const values = exec.param("columns.value", i, undefined);
  const field = exec.params?.columns;
  if (!isObject(values) || !isObject(field) || !("mappingMode" in field && "schema" in field && "value" in field)) return values;
  const byId = new Map();
  for (const e of Array.isArray(field.schema) ? field.schema : []) if (isObject(e) && !byId.has(e.id)) byId.set(e.id, e);
  for (const key of Object.keys(values)) {
    const val = values[key];
    const entry = byId.get(key);
    const fail = (description) => new ExpressionError(`Invalid input for '${key}' [item ${i}]`, { node: exec.name, itemIndex: i, description });
    if (mode === "add" && entry?.required === true && entry.type !== "boolean" && (val === undefined || val === null)) throw fail(`The value "${key}" is required but not set`);
    if (!entry?.type) continue;
    if (val === null || val === undefined) {
      values[key] = undefined;
      continue;
    }
    const got = `'${key}' expects a ${entry.type} but we got ${typeof val === "object" ? (Array.isArray(val) ? "array" : "object") : `'${String(val)}'`}`;
    if (entry.type === "options") {
      const opts = Array.isArray(entry.options) ? entry.options : [];
      if (!opts.some((o) => o.value === val)) throw fail(`'${key}' expects one of the following values: [${opts.map((o) => o.value).join(", ")}] but we got ${typeof val === "object" ? (Array.isArray(val) ? "array" : "object") : `'${String(val)}'`}`);
      continue;
    }
    const r = validateFieldType(val, entry.type);
    if (!r.valid) throw fail(entry.type.toLowerCase() === "datetime" ? `${got} <br/><br/> Consider using <a href="https://moment.github.io/luxon/api-docs/index.html#datetimefromformat" target="_blank"><code>DateTime.fromFormat</code></a> to work with custom date formats.` : got);
    values[key] = r.newValue;
  }
  return values;
}

// n8n's convertArraysToPostgresFormat: a value for an ARRAY column (an array, or JSON text of
// one) becomes Postgres array text; anything else in a NOT NULL array column is refused.
function arraysToPostgres(exec, data, columns, i) {
  // n8n's deepCopy: a DateTime (a checked dateTime column) becomes its ISO text here.
  const out = deepCopy(data);
  for (const col of columns) {
    if (String(col.data_type).toUpperCase() !== "ARRAY") continue;
    let val = out[col.column_name];
    if (typeof val === "string") {
      try {
        val = JSON.parse(val);
      } catch (e) {
        throw new NodeError(e.message, { node: exec.name, itemIndex: i });
      }
    }
    if (Array.isArray(val)) {
      const parts = val.map((e) => {
        if (typeof e === "number") return e;
        if (typeof e === "boolean") e = String(e);
        if (typeof e === "object") e = JSON.stringify(e);
        if (typeof e === "string") return `"${e.replace(/"/g, '\\"')}"`;
        return e;
      });
      out[col.column_name] = `{${parts.join(",")}}`;
    } else if (col.is_nullable === "NO") throw new NodeError(`Column '${col.column_name}' has to be an array`, { node: exec.name, itemIndex: i });
  }
  return out;
}

// n8n's checkItemAgainstSchema: every key a column of the table, null only where nullable.
function checkAgainstSchema(exec, item, columns, i) {
  if (!columns.length) return item;
  const cols = new Map(columns.map((c) => [c.column_name, c]));
  for (const key of Object.keys(item)) {
    if (!cols.has(key)) throw new NodeError(`Column '${key}' does not exist in selected table`, { node: exec.name, itemIndex: i });
    if (item[key] === null && cols.get(key).is_nullable !== "YES") throw new NodeError(`Column '${key}' is not nullable`, { node: exec.name, itemIndex: i });
  }
  return item;
}

function addWhere(exec, i, query, values) {
  const raw = exec.param("where", i, []);
  const clauses = Array.isArray(raw?.values) ? raw.values : [];
  if (clauses.some((c) => !isObject(c) || !("column" in c) || typeof c.condition !== "string" || !CONDITIONS.has(c.condition))) throw new NodeError("Invalid where clause", { node: exec.name, itemIndex: i });
  if (!clauses.length) return [query, values];
  const combine = exec.param("combineConditions", i, "AND") === "OR" ? "OR" : "AND";
  let n = values.length + 1;
  let where = " WHERE";
  const add = [];
  clauses.forEach((c, k) => {
    let condition = c.condition === "equal" ? "=" : c.condition;
    let value = c.value;
    if ([">", "<", ">=", "<="].includes(condition) && String(value).trim() !== "" && !Number.isNaN(Number(value))) value = Number(value);
    const col = `$${n}:name`;
    add.push(c.column);
    n++;
    let val = "";
    if (condition !== "IS NULL" && condition !== "IS NOT NULL") {
      val = ` $${n}`;
      add.push(value);
      n++;
    }
    where += ` ${col} ${condition}${val}${k === clauses.length - 1 ? "" : ` ${combine}`}`;
  });
  return [query + where, values.concat(...add)];
}

function addSort(exec, i, query, values) {
  const rules = exec.param("sort", i, [])?.values || [];
  if (!rules.length) return [query, values];
  let n = values.length + 1;
  let order = " ORDER BY";
  const add = [];
  rules.forEach((r, k) => {
    add.push(r.column);
    order += ` $${n}:name ${r.direction === "DESC" ? "DESC" : "ASC"}${k === rules.length - 1 ? "" : ","}`;
    n++;
  });
  return [query + order, values.concat(...add)];
}

const addReturning = (query, outputColumns, values) => (outputColumns.includes("*") ? [`${query} RETURNING *`, values] : [`${query} RETURNING $${values.length + 1}:name`, [...values, outputColumns]]);

// One statement through the host outside the node's batching (n8n's db.any): its first result's
// rows, or the server's error thrown as the node's.
async function readRows(exec, text) {
  const db = exec.step.db ?? {};
  const [r] = await exec.request([{ kind: "db", itemIndex: 0, engine: "postgres", connection: db.connection ?? null, secret: db.secret ?? null, mode: "single", texts: [text], rawTypes: PG_RAW_TYPES, largeNumbers: "text" }]);
  const err = !r.ok ? r.error : r.value?.error;
  if (err) throw new NodeError(String(err.message ?? err), { node: exec.name, ...(err.detail ? { description: err.detail } : {}) });
  return r.value?.results?.[0]?.rows ?? [];
}
const readColumns = (exec, schema, table) => readRows(exec, formatQuery(SCHEMA_QUERY, [schema, table]));

function selectQueries(exec, items) {
  const queries = [];
  for (let i = 0; i < items.length; i++) {
    let values = [locatorValue(exec, "schema", i), locatorValue(exec, "table", i)];
    const outputColumns = exec.param("options.outputColumns", i, ["*"]);
    let query;
    if (outputColumns.includes("*")) query = "SELECT * FROM $1:name.$2:name";
    else {
      values.push(outputColumns);
      query = `SELECT $${values.length}:name FROM $1:name.$2:name`;
    }
    [query, values] = addWhere(exec, i, query, values);
    [query, values] = addSort(exec, i, query, values);
    if (!exec.param("returnAll", i, false)) {
      const raw = exec.param("limit", i, 50);
      if (Number.isNaN(Number(raw))) throw new NodeError("Failed to parse value to number", { node: exec.name, itemIndex: i });
      values.push(Number(raw));
      query += ` LIMIT $${values.length}`;
    }
    queries.push({ query, values });
  }
  return queries;
}

function deleteQueries(exec, items) {
  const queries = [];
  for (let i = 0; i < items.length; i++) {
    const options = exec.param("options", i, {});
    let values = [locatorValue(exec, "schema", i), locatorValue(exec, "table", i)];
    const command = exec.param("deleteCommand", i, undefined);
    let query = "";
    const cascade = options.cascade ? " CASCADE" : "";
    if (command === "drop") query = `DROP TABLE IF EXISTS $1:name.$2:name${cascade}`;
    if (command === "truncate") query = `TRUNCATE TABLE $1:name.$2:name${exec.param("restartSequences", i, false) ? " RESTART IDENTITY" : ""}${cascade}`;
    if (command === "delete") [query, values] = addWhere(exec, i, "DELETE FROM $1:name.$2:name", values);
    if (query === "") throw new NodeError("Invalid delete command, only drop, delete and truncate are supported ", { node: exec.name, itemIndex: i });
    queries.push({ query, values });
  }
  return queries;
}

// insert, update and upsert: {queries, errors} with errors per item index under continue on fail.
async function writeQueries(exec, items, op, v) {
  let schema = locatorValue(exec, "schema", 0);
  let table = locatorValue(exec, "table", 0);
  let current = [schema, table];
  let columns = await readColumns(exec, schema, table);
  const queries = [];
  const errors = new Map();
  for (let i = 0; i < items.length; i++) {
    try {
      schema = locatorValue(exec, "schema", i);
      table = locatorValue(exec, "table", i);
      const matchOn = op === "insert" ? [] : v < 2.2 ? [exec.param("columnToMatchOn", i, undefined)] : exec.param("columns.matchingColumns", i, undefined);
      const dataMode = v < 2.2 ? exec.param("dataMode", i, undefined) : exec.param("columns.mappingMode", i, undefined);
      let item = {};
      let valueToMatchOn = "";
      if (op === "update" && v < 2.2) valueToMatchOn = exec.param("valueToMatchOn", i, undefined);
      if (dataMode === "autoMapInputData") {
        item = items[i].json;
        if (op === "update" && v < 2.2) valueToMatchOn = item[matchOn[0]];
      }
      if (dataMode === "defineBelow") {
        if (v < 2.2) {
          const pairs = exec.param("valuesToSend", i, [])?.values ?? [];
          item = Object.fromEntries(pairs.map(({ column, value }) => [column, value]));
          if (op !== "insert") item[matchOn[0]] = exec.param("valueToMatchOn", i, undefined);
        } else if (op === "insert" && columns.some((c) => c.data_type === "json")) {
          // n8n reads the whole mapper here (no value checks) and writes json columns as JSON text.
          item = exec.param("columns", i, undefined)?.value;
          for (const c of columns) if (c.data_type === "json" && item[c.column_name] !== null && item[c.column_name] !== undefined) item[c.column_name] = JSON.stringify(item[c.column_name]);
        } else item = columnValues(exec, i, op === "insert" ? "add" : op);
      }
      if (op === "update") {
        if (v < 2.2) {
          if (!item[matchOn[0]] && dataMode === "autoMapInputData") throw new NodeError("Column to match on not found in input item. Add a column to match on or set the 'Data Mode' to 'Define Below' to define the value to match on.", { node: exec.name });
        } else {
          const pairs = matchOn.flatMap((c) => [c, item[c]]);
          const where = [];
          for (let k = 3; k < 3 + pairs.length; k += 2) where.push(`$${k}:name=$${k + 1}`);
          const [row] = await readRows(exec, formatQuery(`SELECT EXISTS(SELECT 1 FROM $1:name.$2:name WHERE ${where.join(" AND ")})`, [schema, table, ...pairs]));
          if (!row?.exists) {
            const desc = matchOn.map((c) => `${c}=${item[c]}`).join(", ");
            throw new NodeError("The row you are trying to update doesn't exist", { node: exec.name, itemIndex: i, description: `No rows matching the provided values (${desc}) were found in the table "${table}".` });
          }
        }
      }
      if (op === "upsert") {
        if (!item[matchOn[0]]) throw new NodeError("Column to match on not found in input item. Add a column to match on or set the 'Data Mode' to 'Define Below' to define the value to match on.", { node: exec.name });
        if (Object.keys(item).length === 1) throw new NodeError("Add values to update or insert to the input item or set the 'Data Mode' to 'Define Below' to define the values to insert or update.", { node: exec.name });
      }
      if (current[0] !== schema || current[1] !== table) {
        current = [schema, table];
        columns = await readColumns(exec, schema, table);
      }
      if (v >= 2.4) item = arraysToPostgres(exec, item, columns, i);
      item = checkAgainstSchema(exec, item, columns, i);
      const outputColumns = exec.param("options.outputColumns", i, ["*"]);
      let query;
      let values = [schema, table];
      if (op === "insert") {
        const options = exec.param("options", i, {});
        query = `INSERT INTO $1:name.$2:name($3:name) VALUES($3:csv)${options.skipOnConflict ? " ON CONFLICT DO NOTHING" : ""}`;
        values.push(item);
        if (v >= 2.6 && Object.keys(item).length === 0) query = "INSERT INTO $1:name.$2:name DEFAULT VALUES";
      } else if (op === "update") {
        let n = 3;
        const conditions = [];
        if (v < 2.2) {
          conditions.push(`$${n}:name = $${n + 1}`);
          n += 2;
          values.push(matchOn[0], valueToMatchOn);
        } else
          for (const c of matchOn) {
            conditions.push(`$${n}:name = $${n + 1}`);
            n += 2;
            values.push(c, item[c]);
          }
        const updateColumns = Object.keys(item).filter((c) => !matchOn.includes(c));
        if (!updateColumns.length) throw new NodeError("Add values to update to the input item or set the 'Data Mode' to 'Define Below' to define the values to update.", { node: exec.name });
        const sets = [];
        for (const c of updateColumns) {
          sets.push(`$${n}:name = $${n + 1}`);
          n += 2;
          values.push(c, item[c]);
        }
        query = `UPDATE $1:name.$2:name SET ${sets.join(", ")} WHERE ${conditions.join(" AND ")}`;
      } else {
        let n = 3;
        const conflict = [];
        for (const c of matchOn) {
          conflict.push(`$${n}:name`);
          n++;
          values.push(c);
        }
        const insert = `INSERT INTO $1:name.$2:name($${n}:name) VALUES($${n}:csv) ON CONFLICT (${conflict.join(",")})`;
        n++;
        values.push(item);
        const sets = [];
        for (const c of Object.keys(item).filter((c) => !matchOn.includes(c))) {
          sets.push(`$${n}:name = $${n + 1}`);
          n += 2;
          values.push(c, item[c]);
        }
        query = `${insert}${sets.length ? ` DO UPDATE  SET ${sets.join(", ")}` : " DO NOTHING "}`;
      }
      [query, values] = addReturning(query, outputColumns, values);
      queries.push({ query, values });
    } catch (e) {
      if (!exec.continueOnFail()) throw e;
      errors.set(i, { json: { error: errorJson(e) }, pairedItem: { item: i } });
    }
  }
  return { queries, errors };
}

// n8n's runQueriesAndHandleErrors: with an item refused before its query and batching not
// "independently", nothing runs and only the refusals come out; otherwise they are slotted back
// by position among the results.
async function runWithErrors(exec, queries, options, v, errors) {
  if (errors.size && options.queryBatching !== "independently") return [...errors.values()];
  const data = await runPostgres(exec, queries, options, v);
  const total = data.length + errors.size;
  const out = new Array(total);
  let k = 0;
  for (let i = 0; i < total; i++) {
    if (errors.has(i)) out[i] = errors.get(i);
    else if (k < data.length) out[i] = data[k++];
  }
  return out;
}

// n8n's replaceEmptyStringsByNulls: in place on each item's JSON, as n8n's shallow item copy does.
function emptyStringsToNull(items, on) {
  if (!on) return items;
  for (const it of items) for (const k of Object.keys(it.json ?? {})) if (it.json[k] === "") it.json[k] = null;
  return items;
}

export const postgres = {
  versions: (v) => v >= 2 && v < 3,
  async execute(exec) {
    const v = exec.typeVersion;
    exec.params = tableDefaults(v, exec.params);
    const operation = exec.param("operation", 0, "insert");
    const resource = exec.param("resource", 0, "database");
    if (resource !== "database") throw new NodeError(`The operation "${operation}" is not supported!`, { node: exec.name });
    const options = { ...(exec.param("options", 0, {}) ?? {}), nodeVersion: v, operation };
    let items = exec.getInputData();
    if (operation === "executeQuery") {
      const queries = items.map((_, i) => itemQuery(exec, i, v, options));
      return [await runPostgres(exec, queries, options, v)];
    }
    if (!TABLE_OPERATIONS.includes(operation)) throw new NodeError(`Postgres ${operation} is not carried by the runtime`, { node: exec.name });
    if (operation !== "deleteTable") items = emptyStringsToNull(items, options.replaceEmptyStrings);
    if (operation === "select") return [await runPostgres(exec, selectQueries(exec, items), options, v)];
    if (operation === "deleteTable") return [await runPostgres(exec, deleteQueries(exec, items), options, v)];
    const { queries, errors } = await writeQueries(exec, items, operation, v);
    return [await runWithErrors(exec, queries, options, v, errors)];
  },
};

// What a db request does to the database, for the effect ledger: a read only when every text
// holds SELECT statements alone (n8n's own test), else a write.
export function dbRequestEffect(req) {
  return (req.texts ?? []).every((t) => typeof t !== "string" || isSelectQuery(t)) ? "read" : "write";
}
