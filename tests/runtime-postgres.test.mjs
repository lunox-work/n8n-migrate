// The Postgres node v2's executeQuery as the runtime runs it (runtime postgres.mjs, pgformat.mjs,
// pgclient.mjs), expectations read from n8n 2.47.7's node and pg-promise 11.9.1. The host is a
// stand-in here; the bench runs the same code against Postgres 17 (PROPOSALS P129).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { wf, node, run, out } from "./runtime-helpers.mjs";
import { concatQueries, formatQuery } from "../skills/n8n-to-claude/runtime/src/pgformat.mjs";
import { isSelectQuery, timestampISO, legacyDateValue, arrayElements, dbRequestEffect } from "../skills/n8n-to-claude/runtime/src/postgres.mjs";
import { checkContainment, requestEffect } from "../skills/n8n-to-claude/runtime/src/engine.mjs";
import { sslOption, loadPg } from "../skills/n8n-to-claude/runtime/src/pgclient.mjs";
import { executeDb } from "../skills/n8n-to-claude/runtime/src/driver.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONN = { host: "db.example.com", port: 5432, database: "shop", user: "reader", ssl: "disable" };
const pgStep = (name, params, v = 2.5) => {
  const [n, step] = node(name, "postgres", { operation: "executeQuery", options: {}, ...params }, { v, kind: "db" });
  step.db = { engine: "postgres", operation: "executeQuery", credential: "DB", secret: "DB", connection: CONN, effect: "write" };
  return [n, step];
};
const def = (params, v) => wf([node("Start", "manualTrigger"), pgStep("Query", params, v)], [["Start", "Query"]], { allow: { tools: [], http: [], sql: [], db: [{ engine: "postgres", host: CONN.host, port: 5432, database: "shop" }] }, secrets: [{ name: "DB", credentialType: "postgres", hosts: ["db.example.com:5432"] }] });
const field = (name, dataTypeID) => ({ name, dataTypeID });

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
  assert.match(missing.error.message, /secret "DB" is not available \(local: set N2C_SECRET_DB\)/);
});

test("the vendored node-postgres loads from runtime/vendor/pg, and SSL answers map to pg's option", () => {
  assert.ok(existsSync(join(HERE, "..", "skills/n8n-to-claude/runtime/vendor/pg/node_modules/pg/package.json")));
  const pg = loadPg();
  assert.equal(typeof pg.Client, "function");
  assert.equal(pg.types.builtins.NUMERIC > 0, true);
  assert.equal(sslOption("disable"), false);
  assert.deepEqual(sslOption("no-verify"), { rejectUnauthorized: false });
  assert.equal(sslOption("require"), true);
});
