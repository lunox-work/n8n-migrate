// The Postgres node v2's executeQuery and table operations as the runtime runs them (runtime postgres.mjs, pgformat.mjs,
// pgclient.mjs), expectations read from n8n 2.47.7's node and pg-promise 11.9.1. The host is a
// stand-in here; the bench runs the same code against Postgres 17 (PROPOSALS P129).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { wf, node, run, out } from "./runtime-helpers.mjs";
import { concatQueries, formatQuery } from "../skills/n8n-migrate/runtime/src/pgformat.mjs";
import { isSelectQuery, timestampISO, legacyDateValue, arrayElements, dbRequestEffect, tableDefaults } from "../skills/n8n-migrate/runtime/src/postgres.mjs";
import { checkContainment, requestEffect } from "../skills/n8n-migrate/runtime/src/engine.mjs";
import { sslOption, loadPg } from "../skills/n8n-migrate/runtime/src/pgclient.mjs";
import { executeDb } from "../skills/n8n-migrate/runtime/src/driver.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONN = { host: "db.example.com", port: 5432, database: "shop", user: "reader", ssl: "disable" };
const pgStep = (name, params, v = 2.5) => {
  const [n, step] = node(name, "postgres", { operation: "executeQuery", options: {}, ...params }, { v, kind: "db" });
  step.db = { engine: "postgres", operation: "executeQuery", credential: "DB", secret: "DB", connection: CONN, effect: "write" };
  return [n, step];
};
const def = (params, v) => wf([node("Start", "manualTrigger"), pgStep("Query", params, v)], [["Start", "Query"]], { allow: { tools: [], http: [], sql: [], db: [{ engine: "postgres", host: CONN.host, port: 5432, database: "shop" }] }, secrets: [{ name: "DB", credentialType: "postgres", hosts: ["db.example.com:5432"] }] });
const field = (name, dataTypeID) => ({ name, dataTypeID });
const tdef = (params, v = 2.5, settings = {}) => {
  const [n, step] = node("PG", "postgres", params, { v, kind: "db", settings });
  step.db = { engine: "postgres", operation: params.operation, credential: "DB", secret: "DB", connection: CONN, effect: "write" };
  return wf([node("Start", "manualTrigger"), [n, step]], [["Start", "PG"]], { allow: { tools: [], http: [], sql: [], db: [{ engine: "postgres", host: CONN.host, port: 5432, database: "shop" }] }, secrets: [{ name: "DB", credentialType: "postgres", hosts: ["db.example.com:5432"] }] });
};

test("pg-promise formatting: values written into the text, partial leaves the rest, concat trims and joins", () => {
  assert.equal(formatQuery("SELECT $1, $2, $3, $4, $5, $6", ["it's", 5, -2.5, true, null, [1, "a"]]), "SELECT 'it''s', 5, (-2.5), true, null, array[1,'a']");
  assert.equal(formatQuery("SELECT $1:name FROM t WHERE x = $2^", ["col", "raw()"]), 'SELECT "col" FROM t WHERE x = raw()');
  assert.equal(formatQuery("SELECT $1, $2", ["a"], { partial: true }), "SELECT 'a', $2");
  assert.throws(() => formatQuery("SELECT $2", ["a"]), /Variable \$2 out of range/);
  assert.equal(formatQuery("SELECT $1:json", [{ a: "it's" }]), `SELECT '{"a":"it''s"}'`);
  assert.equal(formatQuery("SELECT 1", []), "SELECT 1");
  assert.equal(concatQueries([{ query: " SELECT 1; \n", values: [] }, { query: ";;", values: [] }, { query: "SELECT $1", values: [2], options: { partial: true } }]), "SELECT 1;SELECT 2");
});

test("isSelectQuery: every statement's top-level command is SELECT, strings, comments and CTE bodies aside", () => {
  assert.equal(isSelectQuery("SELECT 1; select 'DELETE; x' -- UPDATE\n"), true);
  assert.equal(isSelectQuery("WITH d AS (SELECT 1) DELETE FROM t"), false);
  assert.equal(isSelectQuery("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d"), true, "n8n's test looks at the top level only");
  assert.equal(isSelectQuery("SELECT $$; INSERT$$"), true);
  assert.equal(isSelectQuery("CREATE TABLE t (a int)"), false);
  assert.equal(isSelectQuery(""), true);
  assert.equal(dbRequestEffect({ texts: ["SELECT 1;SELECT 2"] }), "read");
  assert.equal(requestEffect({ kind: "db", texts: ["SELECT 1", "UPDATE t SET a = 1"] }), "write");
});

test("timestamps as n8n's type parsers give them: ISO, a zone-less one read in the workflow's zone, DATE before v2.7 at local midnight", () => {
  assert.equal(timestampISO("2026-11-16 10:00:00", "America/New_York"), "2026-11-16T15:00:00.000Z");
  assert.equal(timestampISO("2026-11-16 10:00:00.123456", "UTC"), "2026-11-16T10:00:00.123Z");
  assert.equal(timestampISO("2026-11-16 10:00:00+05:30", "America/New_York"), "2026-11-16T04:30:00.000Z");
  assert.equal(timestampISO("infinity", "UTC"), "infinity");
  assert.equal(legacyDateValue("2026-11-16", "America/New_York"), "2026-11-16T05:00:00.000Z");
  assert.equal(legacyDateValue("infinity", "UTC"), null);
  assert.deepEqual(arrayElements('{2026-11-16,NULL,"a,b"}'), ["2026-11-16", null, "a,b"]);
  assert.equal(arrayElements("{{1}}"), null);
});

test("executeQuery: one simple query for every item, one item per row paired with its statement, {success: true} when nothing comes back", async () => {
  const seen = [];
  const host = (value) => ({ db: async (req) => (seen.push(req), value) });
  const rows = { results: [{ command: "SELECT", rows: [{ id: 1, at: "2026-11-16 10:00:00", d: "2026-11-16" }, { id: 2, at: null, d: null }], fields: [field("id", 23), field("at", 1114), field("d", 1082)] }] };
  const r = await run(def({ query: "SELECT * FROM orders WHERE region = '{{ $json.region }}';" }), { trigger: [{ region: "EU" }], host: host(rows) });
  assert.equal(r.status, "done", JSON.stringify(r.error));
  assert.deepEqual(seen[0], { engine: "postgres", connection: CONN, secret: "DB", mode: "single", texts: ["SELECT * FROM orders WHERE region = 'EU'"], rawTypes: [1082, 1114, 1184, 1182, 1115, 1185], largeNumbers: "text", step: "Query" });
  assert.deepEqual(out(r, "Query"), [
    { id: 1, at: "2026-11-16T15:00:00.000Z", d: "2026-11-16T05:00:00.000Z" },
    { id: 2, at: null, d: null },
  ]);
  assert.deepEqual(r.runData.Query[0].data.main[0][1].pairedItem, { item: 0 });
  const v27 = await run(def({ query: "SELECT d FROM t" }, 2.7), { trigger: [{}], host: host({ results: [{ rows: [{ d: "2026-11-16" }], fields: [field("d", 1082)] }] }) });
  assert.deepEqual(out(v27, "Query"), [{ d: "2026-11-16" }], "from v2.7 a DATE stays its text");
  const write = await run(def({ query: "UPDATE t SET a = 1" }), { trigger: [{}], host: host({ results: [{ command: "UPDATE", rows: [], fields: [] }] }) });
  assert.deepEqual(out(write, "Query"), [{ success: true }]);
  const none = await run(def({ query: "SELECT 1 WHERE false" }), { trigger: [{}], host: host({ results: [{ command: "SELECT", rows: [], fields: [] }] }) });
  assert.deepEqual(out(none, "Query"), []);
});

test("executeQuery: Query Parameters by version, '$1' in quotes as text, n8n's error wording", async () => {
  const seen = [];
  const host = { db: async (req) => (seen.push(req), { results: [{ rows: [{ ok: 1 }], fields: [] }] }) };
  await run(def({ query: "SELECT $1, $2", options: { queryReplacement: "={{ $json.a }}, {{ $json.b }}" } }, 2.5), { trigger: [{ a: "x,y", b: 3 }], host });
  assert.equal(seen[0].texts[0], "SELECT 'x', 'y'", "before v2.8 an expression's text is split at commas");
  await run(def({ query: "SELECT $1, $2", options: { queryReplacement: "={{ $json.a }}, {{ $json.b }}" } }, 2.8), { trigger: [{ a: "x,y" }], host });
  assert.equal(seen[1].texts[0], "SELECT 'x,y', null", "from v2.8 one value each, a missing field as NULL");
  await run(def({ query: "SELECT '$1' AS a" }), { trigger: [{}], host });
  assert.equal(seen[2].texts[0], "SELECT '$1' AS a");
  const bad = await run(def({ query: "SELEC 1" }), { trigger: [{}], host: { db: async () => ({ error: { message: 'syntax error at or near "SELEC"', code: "42601" } }) } });
  assert.equal(bad.status, "failed");
  assert.equal(bad.error.message, 'Syntax error at line 1 near "SELEC"');
  const down = await run(def({ query: "SELECT 1" }), { trigger: [{}], host: { db: async () => ({ error: { message: "connect ECONNREFUSED 10.0.0.5:5432", code: "ECONNREFUSED" } }) } });
  assert.equal(down.error.message, "Connection refused");
  assert.equal(down.error.description, "10.0.0.5:5432");
});

test("a db request reaches only the database the definition allows, its secret only that host and port", () => {
  const d = def({ query: "SELECT 1" });
  const req = { kind: "db", id: "Query#0#0", engine: "postgres", connection: CONN, secret: "DB" };
  assert.doesNotThrow(() => checkContainment(d, req));
  assert.throws(() => checkContainment(d, { ...req, connection: { ...CONN, database: "other" } }), /not in the definition's allowlist/);
  assert.throws(() => checkContainment({ ...d, secrets: [{ name: "DB", hosts: ["db.example.com:6543"] }] }, req), /may not be sent to db.example.com:5432/);
});

test("the task driver runs a db request with the step's secret as the password, and says when it is missing", async () => {
  const seen = [];
  const client = async (req, o) => (seen.push(o), { results: [] });
  const ok = await executeDb({ engine: "postgres", connection: CONN, secret: "DB", texts: ["SELECT 1"] }, { secrets: (n) => (n === "DB" ? "pw" : undefined) }, { client });
  assert.deepEqual(ok, { ok: true, value: { results: [] } });
  assert.deepEqual(seen, [{ password: "pw" }]);
  const missing = await executeDb({ engine: "postgres", connection: CONN, secret: "DB", texts: ["SELECT 1"] }, { secrets: () => undefined }, { client });
  assert.match(missing.error.message, /secret "DB" is not available \(local: set N8M_SECRET_DB\)/);
});

test("the vendored node-postgres loads from runtime/vendor/pg, and SSL answers map to pg's option", () => {
  assert.ok(existsSync(join(HERE, "..", "skills/n8n-migrate/runtime/vendor/pg/node_modules/pg/package.json")));
  const pg = loadPg();
  assert.equal(typeof pg.Client, "function");
  assert.equal(pg.types.builtins.NUMERIC > 0, true);
  assert.equal(sslOption("disable"), false);
  assert.deepEqual(sslOption("no-verify"), { rejectUnauthorized: false });
  assert.equal(sslOption("require"), true);
});

// Table operations: a host stand-in that answers the information_schema read with `columns`,
// SELECT EXISTS with `exists`, and every other statement with no rows (or `rows`).
const COLS = [
  { column_name: "id", data_type: "integer", is_nullable: "NO", udt_name: "int4", column_default: "nextval('t_id_seq'::regclass)" },
  { column_name: "name", data_type: "text", is_nullable: "NO", udt_name: "text", column_default: null },
  { column_name: "tags", data_type: "ARRAY", is_nullable: "YES", udt_name: "_text", column_default: null },
];
const tableHost = ({ columns = COLS, exists = true, rows = [] } = {}) => {
  const texts = [];
  return {
    texts,
    db: async (req) => {
      texts.push(...req.texts);
      if (req.mode !== "single") return { runs: req.texts.map(() => ({ results: [{ rows, fields: [] }] })) };
      const t = req.texts[0];
      return { results: t.split(";").map((x) => ({ rows: /information_schema/.test(x) ? columns : /SELECT EXISTS/.test(x) ? [{ exists }] : rows, fields: [] })) };
    },
  };
};
const rl = (value) => ({ __rl: true, mode: "list", value });
const SCHEMA_Q = "SELECT column_name, data_type, is_nullable, udt_name, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 't'";

test("table operations: n8n's defaults (schema public, condition equal, limit 50, truncate) filled before the node runs", () => {
  const p = tableDefaults(2.5, { operation: "select", table: rl("t"), where: { values: [{ column: "a", value: "1" }, { column: "b", condition: "IS NULL" }] }, sort: { values: [{ column: "a" }] } });
  assert.deepEqual(p.schema, rl("public"));
  assert.deepEqual(p.where.values, [{ column: "a", condition: "equal", value: "1" }, { column: "b", condition: "IS NULL" }]);
  assert.deepEqual(p.sort.values, [{ column: "a", direction: "ASC" }]);
  assert.equal(p.limit, 50);
  assert.equal(tableDefaults(2.5, { operation: "select", returnAll: true }).limit, undefined, "limit is hidden with Return All");
  assert.equal(tableDefaults(2.5, { operation: "deleteTable" }).deleteCommand, "truncate");
  assert.deepEqual(tableDefaults(2.5, { operation: "insert" }).columns, { mappingMode: "defineBelow", value: null });
  assert.equal(tableDefaults(2.1, { operation: "update", valueToMatchOn: "1" }).valueToMatchOn, undefined, "hidden in auto-map mode, so n8n drops it");
});

test("select: where, sort and limit as pg-promise placeholders; no rows is no item", async () => {
  const h = tableHost();
  const params = { operation: "select", table: rl("t"), where: { values: [{ column: "code", value: "={{ $json.c }}" }, { column: "n", condition: ">", value: "2" }] }, combineConditions: "OR", sort: { values: [{ column: "n", direction: "DESC" }] }, options: {} };
  const r = await run(tdef(params), { trigger: [{ c: "x'y" }, { c: "z" }], host: h });
  assert.equal(r.status, "done", JSON.stringify(r.error));
  assert.deepEqual(h.texts, [`SELECT * FROM "public"."t" WHERE "code" = 'x''y' OR "n" > 2 ORDER BY "n" DESC LIMIT 50;SELECT * FROM "public"."t" WHERE "code" = 'z' OR "n" > 2 ORDER BY "n" DESC LIMIT 50`]);
  assert.deepEqual(out(r, "PG"), []);
  const h2 = tableHost({ rows: [{ id: 1 }] });
  const r2 = await run(tdef({ operation: "select", table: rl("t"), returnAll: true, options: { outputColumns: ["id"] } }), { trigger: [{}], host: h2 });
  assert.deepEqual(h2.texts, [`SELECT "id" FROM "public"."t"`]);
  assert.deepEqual(out(r2, "PG"), [{ id: 1 }]);
  const bad = await run(tdef({ operation: "select", table: rl("t"), where: { values: [{ column: "a", condition: "~", value: "x" }] } }), { trigger: [{}], host: tableHost() });
  assert.equal(bad.error.message, "Invalid where clause");
});

test("insert: the table's columns read first, each item checked against them, then INSERT ... RETURNING *", async () => {
  const h = tableHost({ rows: [{ id: 12, name: "n" }] });
  const columns = { mappingMode: "defineBelow", value: { name: "={{ $json.n }}", tags: "={{ $json.t }}" }, matchingColumns: ["id"], schema: [{ id: "name", type: "string", required: true }, { id: "tags", type: "array" }] };
  const r = await run(tdef({ operation: "insert", table: rl("t"), columns, options: {} }, 2.5), { trigger: [{ n: "n", t: ["a", 'b"c'] }], host: h });
  assert.equal(r.status, "done", JSON.stringify(r.error));
  assert.deepEqual(h.texts, [SCHEMA_Q, `INSERT INTO "public"."t"("name","tags") VALUES('n','{"a","b\\"c"}') RETURNING *`]);
  assert.deepEqual(out(r, "PG"), [{ id: 12, name: "n" }]);
  const missing = await run(tdef({ operation: "insert", table: rl("t"), columns, options: {} }, 2.5), { trigger: [{}], host: tableHost() });
  assert.equal(missing.error.message, "Invalid input for 'name' [item 0]");
  assert.equal(missing.error.description, 'The value "name" is required but not set');
  const unknown = await run(tdef({ operation: "insert", table: rl("t"), columns: { mappingMode: "autoMapInputData", value: {}, matchingColumns: [], schema: [] }, options: { skipOnConflict: true } }, 2.5), { trigger: [{ name: "a", other: 1 }], host: tableHost() });
  assert.equal(unknown.error.message, "Column 'other' does not exist in selected table");
});

test("update asks whether each row exists; upsert and deleteTable build n8n's statements", async () => {
  const h = tableHost();
  const columns = { mappingMode: "autoMapInputData", value: {}, matchingColumns: ["id"], schema: [] };
  const r = await run(tdef({ operation: "update", table: rl("t"), columns, options: {} }, 2.5), { trigger: [{ id: 3, name: "n" }], host: h });
  assert.equal(r.status, "done", JSON.stringify(r.error));
  assert.deepEqual(h.texts, [SCHEMA_Q, `SELECT EXISTS(SELECT 1 FROM "public"."t" WHERE "id"=3)`, `UPDATE "public"."t" SET "name" = 'n' WHERE "id" = 3 RETURNING *`]);
  assert.deepEqual(out(r, "PG"), [{ success: true }]);
  const gone = await run(tdef({ operation: "update", table: rl("t"), columns, options: {} }, 2.5), { trigger: [{ id: 3, name: "n" }], host: tableHost({ exists: false }) });
  assert.equal(gone.error.message, "The row you are trying to update doesn't exist");
  const u = tableHost();
  await run(tdef({ operation: "upsert", table: rl("t"), columns, options: {} }, 2.5), { trigger: [{ id: 3, name: "n" }], host: u });
  assert.equal(u.texts[1], `INSERT INTO "public"."t"("id","name") VALUES(3,'n') ON CONFLICT ("id") DO UPDATE  SET "name" = 'n' RETURNING *`);
  const d = tableHost();
  await run(tdef({ operation: "deleteTable", table: rl("t"), deleteCommand: "delete", where: { values: [{ column: "id", value: "3" }] } }), { trigger: [{}], host: d });
  assert.deepEqual(d.texts, [`DELETE FROM "public"."t" WHERE "id" = '3'`]);
});

test("a value pg-promise cannot format fails as that query's error: before sending in single mode, in place under independent batching", async () => {
  const h = tableHost();
  const r = await run(tdef({ operation: "select", table: rl("t"), options: { outputColumns: [] } }), { trigger: [{}], host: h });
  assert.equal(r.error.message, "Cannot retrieve sql names from an empty array/object.");
  assert.deepEqual(h.texts, []);
  const seen = [];
  await run(tdef({ operation: "select", table: rl("t"), options: { outputColumns: [], queryBatching: "independently" } }, 2.5, { onError: "continueRegularOutput" }), { trigger: [{}], host: { db: async (req) => (seen.push(req.texts), { runs: [{ error: req.texts[0].error }] }) } });
  assert.deepEqual(seen[0], [{ error: { message: "Cannot retrieve sql names from an empty array/object." } }]);
});
