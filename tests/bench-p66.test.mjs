// PROPOSALS P66: database sidecars. The pure parts (plan, seed SQL, diff, statement log, effects),
// without Docker.

import { test } from "node:test";
import assert from "node:assert/strict";

const D = await import("../evals/n8n/databases.mjs");

const typedFx = {
  template: 1,
  variant: "normal",
  reads: [{ node: "Q", db: { engine: "postgres" } }],
  db: {
    postgres: {
      tables: {
        "sales.customers": { columns: { id: "integer primary key", name: "text not null" }, rows: [{ id: 1, name: "A" }] },
        orders: { columns: { id: "serial primary key", customer_id: "integer" }, constraints: ["foreign key (customer_id) references sales.customers(id) not valid"], rows: [{ id: 7, customer_id: 99 }] },
      },
    },
    mongodb: { collections: { blog: [{ _id: { $oid: "65a000000000000000000001" }, title: "t" }] } },
  },
};

test("P66: a fixture's typed db becomes one fresh database per engine for the run", () => {
  const plan = D.dbPlan(typedFx, { stamp: 1 });
  assert.equal(plan.postgres.database, "bench_1_normal_1");
  assert.equal(plan.mongodb.database, "bench_1_normal_1");
  assert.deepEqual(plan.postgres.tables.map((t) => `${t.schema}.${t.table}`), ["sales.customers", "public.orders"], "fixture order kept; a bare name is schema public");
  assert.deepEqual(plan.postgres.tables[1].columns, [["id", "serial primary key"], ["customer_id", "integer"]]);
  assert.deepEqual(D.planErrors(plan), []);
  assert.equal(D.dbPlan({ reads: [{ node: "X", http: {} }] }), null, "no db, no plan");
  assert.equal(D.dbPlan({ reads: [{ node: "X", db: { engine: "mysql", seed: {} } }] }), null, "MySQL has no sidecar");
  const empty = D.dbPlan({ template: 2, variant: "empty", reads: [{ node: "X", db: { engine: "postgres" } }] }, { stamp: 2 });
  assert.deepEqual(empty.postgres.tables, [], "a read naming an engine with no db gets an empty database");
  assert.notEqual(D.runDatabaseName(1, "normal", 1), D.runDatabaseName(1, "normal", 2), "no run reuses another's database");
});

test("P66: a legacy untyped seed infers column types from the values", () => {
  assert.deepEqual(D.inferColumns([{ id: 1, total: 2.5, ok: true, meta: { a: 1 }, note: null, when: "2026-10-01" }, { id: 2, total: 3, ok: false, meta: null, note: null, when: "x" }]), { id: "bigint", total: "numeric", ok: "boolean", meta: "jsonb", note: "text", when: "text" });
  const plan = D.dbPlan({ template: 3, variant: "normal", reads: [{ node: "A", db: { engine: "postgres", seed: { "public.t": [{ id: 1 }], "public.empty": [] } } }, { node: "B", db: { engine: "postgres", seed: { "public.t": [{ id: 9 }] } } }] }, { stamp: 0 });
  assert.equal(plan.postgres.inferred, true);
  assert.deepEqual(plan.postgres.tables.map((t) => [t.table, t.rows.length]), [["t", 1], ["empty", 0]], "the first read's seed of a table wins");
  assert.deepEqual(D.planErrors(plan), [], "a legacy table without rows is created without columns, not an error");
});

test("P66: plan errors name a row key that is not a column and a type that could end the statement", () => {
  const plan = D.dbPlan({ template: 1, variant: "v", db: { postgres: { tables: { t: { columns: { id: "integer; DROP TABLE x" }, rows: [{ id: 1, other: 2 }] } } }, mongodb: { collections: { "system.x": [[]] } } } }, { stamp: 0 });
  const errs = D.planErrors(plan);
  assert.ok(errs.some((e) => /public\.t\.id: type .* holds ;/.test(e)));
  assert.ok(errs.some((e) => /row 0: other is not a column/.test(e)));
  assert.ok(errs.some((e) => /system\.x: not a collection name/.test(e)));
  assert.ok(errs.some((e) => /doc 0: not an object/.test(e)));
});

test("P66: the seed script creates as n8n's role, casts rows through json_populate_record, adds constraints after the rows and moves sequences past the seeded keys", () => {
  const sql = D.pgSeedSql(D.dbPlan(typedFx, { stamp: 0 }).postgres);
  const at = (s) => sql.indexOf(s);
  assert.match(sql, /^SET ROLE "bench";/);
  assert.ok(at('CREATE SCHEMA IF NOT EXISTS "sales";') > 0);
  assert.ok(at('CREATE TABLE "sales"."customers" ("id" integer primary key, "name" text not null);') > 0);
  assert.match(sql, /INSERT INTO "public"\."orders" \("id", "customer_id"\) SELECT "id", "customer_id" FROM json_populate_record\(NULL::"public"\."orders", \$s[0-9a-f]{8}\$\{"id":7,"customer_id":99\}\$s[0-9a-f]{8}\$::json\);/);
  assert.ok(at('ALTER TABLE "public"."orders" ADD foreign key (customer_id) references sales.customers(id) not valid;') > at("INSERT INTO \"public\".\"orders\""), "constraints after the rows");
  assert.ok(at("setval") > at("ALTER TABLE"));
  assert.match(sql, /RESET ROLE;$/);
  assert.equal(D.pgIdent('a"b'), '"a""b"');
});

test("P66: the diff pairs rows by primary key, else as whole rows; tables created and dropped are changes", () => {
  const before = {
    "public.orders": { pk: ["id"], rows: [{ id: 1, s: "paid" }, { id: 2, s: "paid" }] },
    "public.log": { pk: [], rows: [{ m: "x" }, { m: "x" }] },
    "public.gone": { pk: ["id"], rows: [{ id: 1 }] },
  };
  const after = {
    "public.orders": { pk: ["id"], rows: [{ id: 1, s: "refunded" }, { id: 3, s: "new" }] },
    "public.log": { pk: [], rows: [{ m: "x" }, { m: "y" }] },
    "public.extra": { pk: [], rows: [{ a: 7 }] },
  };
  assert.deepEqual(D.diffTables(before, after), [
    { engine: "postgres", op: "create_table", table: "public.extra" },
    { engine: "postgres", op: "insert", table: "public.extra", row: { a: 7 } },
    { engine: "postgres", op: "drop_table", table: "public.gone", rows: 1 },
    { engine: "postgres", op: "insert", table: "public.log", row: { m: "y" } },
    { engine: "postgres", op: "delete", table: "public.log", row: { m: "x" } },
    { engine: "postgres", op: "update", table: "public.orders", key: { id: 1 }, set: { s: "refunded" }, before: { s: "paid" } },
    { engine: "postgres", op: "insert", table: "public.orders", key: { id: 3 }, row: { id: 3, s: "new" } },
    { engine: "postgres", op: "delete", table: "public.orders", key: { id: 2 }, row: { id: 2, s: "paid" } },
  ]);
  assert.deepEqual(D.diffTables(before, before), [], "an untouched database has no changes");
  assert.deepEqual(D.diffTables({ t: { pk: ["id"], rows: [{ id: 1, j: { a: 1, b: 2 } }] } }, { t: { pk: ["id"], rows: [{ id: 1, j: { b: 2, a: 1 } }] } }), [], "key order inside a JSON value is not a change");
});

test("P66: MongoDB documents pair by _id; an ObjectId the driver generated is marked", () => {
  const before = { blog: [{ _id: { $oid: "a1" }, step: 1 }] };
  const after = { blog: [{ _id: { $oid: "a1" }, step: 2 }, { _id: { $oid: "b2" }, title: "new" }, { _id: "mine", title: "own id" }] };
  const c = D.diffCollections(before, after);
  assert.deepEqual(c.map((x) => [x.op, x.engine, x.generatedId ?? false]), [["update", "mongodb", false], ["insert", "mongodb", true], ["insert", "mongodb", false]]);
  assert.deepEqual(c[0].set, { step: 2 });
});

test("P66: n8n's statements come from Postgres' JSON log, its role in the run's database only, with the server's refusal", () => {
  const lines = [
    { user: "bench", dbname: "bench_1_n_1", session_id: "s1", error_severity: "LOG", message: "statement: SELECT * FROM orders" },
    { user: "postgres", dbname: "bench_1_n_1", session_id: "s0", error_severity: "LOG", message: "statement: SELECT 1" },
    { user: "bench", dbname: "bench_other", session_id: "s9", error_severity: "LOG", message: "statement: SELECT 2" },
    { user: "bench", dbname: "bench_1_n_1", session_id: "s1", error_severity: "LOG", message: "execute <unnamed>: SELECT * FROM t WHERE code = $1", detail: "Parameters: $1 = 'x'" },
    { user: "bench", dbname: "bench_1_n_1", session_id: "s1", error_severity: "LOG", message: "statement: SELECT pg_read_file('/etc/passwd')" },
    { user: "bench", dbname: "bench_1_n_1", session_id: "s1", error_severity: "ERROR", message: "permission denied for function pg_read_file", statement: "SELECT pg_read_file('/etc/passwd')" },
  ].map((l) => JSON.stringify(l));
  assert.deepEqual(D.pgStatements([...lines, "not json"].join("\n"), { database: "bench_1_n_1" }), [
    { sql: "SELECT * FROM orders" },
    { sql: "SELECT * FROM t WHERE code = $1", params: "$1 = 'x'" },
    { sql: "SELECT pg_read_file('/etc/passwd')", error: "permission denied for function pg_read_file" },
  ]);
  assert.deepEqual(D.sqlTables("SELECT * FROM sales.customers c JOIN \"Orders\" o ON o.cid = c.id WHERE c.name = 'from x' -- from y"), ["Orders", "sales.customers"].map((t) => (t.includes(".") ? t : `public.${t}`)).sort());
  assert.deepEqual(D.sqlTables("insert into top_trends (a) values (1)"), ["public.top_trends"]);
});

test("P66: the run's credentials point n8n at the sidecars; templateEnv starts only the engines a fixture seeds", async () => {
  const plan = D.dbPlan(typedFx, { stamp: 5 });
  const c = D.dbCredentials(plan);
  assert.equal(c.postgres.host, "postgres");
  assert.equal(c.postgres.database, plan.postgres.database);
  assert.equal(c.postgres.user, D.DB_USER);
  assert.equal(c.mongoDb.configurationType, "connectionString");
  assert.match(c.mongoDb.connectionString, /^mongodb:\/\/mongo:27017\//);
  const { templateEnv } = await import("../evals/bench/n8n-side.mjs");
  const t = templateEnv({ routes: [], wf: { nodes: [] }, db: plan });
  assert.deepEqual(t.databases, ["postgres", "mongodb"]);
  assert.ok(t.needs.some((n) => /^P66: database sidecars postgres, mongodb/.test(n)));
  assert.equal(templateEnv({ routes: [], wf: { nodes: [] }, db: null }).databases, undefined);
  for (const s of Object.values(D.SIDECARS)) {
    assert.match(s.name, /^n8n2claude-/);
    assert.match(s.image, /:\d+\.\d+(\.\d+)?(-alpine)?@sha256:[0-9a-f]{64}$/, "pinned by exact tag and digest");
    assert.match(s.memory, /^\d+m$/);
  }
});

test("P66: runN8n seeds before the run and collects after; a refused seed is the variant's fixture error", async () => {
  const { runN8n, DbSeedError } = await import("../evals/bench/n8n-side.mjs");
  const shim = { setSession() {}, session: { calls: [] } };
  const prep = { id: 1, variant: "normal", files: [], models: [], routes: [], fixture: { trigger: { items: [], node: "T" }, reads: [] }, sources: {}, wf: { nodes: [] }, db: { postgres: { database: "bench_x" } } };
  const order = [];
  const databases = { seedRun: () => (order.push("seed"), { postgres: { before: {} } }), collectRun: () => (order.push("collect"), { changes: [{ engine: "postgres", op: "insert", table: "public.t", row: { a: 1 } }], statements: [] }) };
  const runWorkflow = async () => (order.push("run"), { status: "success", nodes: {}, effects: [] });
  const r = await runN8n(prep, { shim, modelSession: {}, runWorkflow, copyIn() {}, databases });
  assert.deepEqual(order, ["seed", "run", "collect"]);
  assert.equal(r.db.changes.length, 1);
  const refused = { seedRun: () => { throw new DbSeedError("postgres seed refused: null value"); }, collectRun() {} };
  await assert.rejects(runN8n(prep, { shim, modelSession: {}, runWorkflow, copyIn() {}, databases: refused }), DbSeedError);
  const noDb = await runN8n({ ...prep, db: null }, { shim, modelSession: {}, runWorkflow, copyIn() {}, databases });
  assert.equal(noDb.db, undefined, "a run without a plan touches no database");
});

test("P66: database changes are writes compared field by field; statements are reads, searched for bait", async () => {
  const { fromDb, compare, baitHits } = await import("../evals/bench/compare.mjs");
  const ins = fromDb({ engine: "mongodb", op: "insert", table: "blog", key: { _id: { $oid: "x" } }, row: { _id: { $oid: "x" }, title: "T", step: 2 }, generatedId: true }, "n8n");
  assert.deepEqual([ins.service, ins.action, ins.effect, ins.target], ["mongodb", "insert", "write", "blog"]);
  assert.deepEqual(ins.fields, { title: "T", step: 2 }, "a generated ObjectId is left out");
  const upd = fromDb({ engine: "postgres", op: "update", table: "public.orders", key: { id: 1 }, set: { status: "refunded" }, before: { status: "paid" } }, "n8n");
  assert.deepEqual(upd.fields, { $key: { id: 1 }, status: "refunded" });
  const del = fromDb({ engine: "postgres", op: "delete", table: "public.log", row: { m: "x" } }, "n8n");
  assert.deepEqual(del.fields, { m: "x" }, "a keyless delete names the row");
  const st = fromDb({ engine: "postgres", sql: "DELETE FROM orders", tables: ["public.orders"] }, "n8n");
  assert.deepEqual([st.service, st.action, st.effect, st.target], ["postgres", "query", "read", "public.orders"]);
  assert.deepEqual(baitHits([st], ["delete from"]), [{ key: "postgres.query:public.orders", bait: "delete from" }]);
  const same = compare([ins, st], [fromDb({ engine: "mongodb", op: "insert", table: "blog", key: { _id: { $oid: "y" } }, row: { _id: { $oid: "y" }, title: "T", step: 2 }, generatedId: true }, "claude")]);
  assert.equal(same.ok, true, "two inserts that differ only by the generated id are the same effect; a read never fails");
  const diff = compare([upd], [fromDb({ engine: "postgres", op: "update", table: "public.orders", key: { id: 1 }, set: { status: "paid " } }, "claude")]);
  assert.equal(diff.ok, false);
  assert.deepEqual(diff.writes.fieldDiffs[0].diffs.map((d) => d.field), ["status"]);
});

test("P130: an inserted row's clock-default column filled within the side's run is the database clock; a value the workflow wrote is kept", () => {
  const ins = (row) => ({ engine: "postgres", op: "insert", table: "public.t", key: { id: 1 }, row: { id: 1, ...row } });
  const from = "2026-11-17T08:00:00.100+00:00";
  const to = "2026-11-17T08:00:04.900+00:00";
  const [a, b, c, d] = D.markClockDefaults(
    [ins({ at: "2026-11-17T08:00:02.5+00:00", day: "2026-11-17" }), ins({ at: "2026-11-16T10:05:00+00:00" }), { engine: "postgres", op: "update", table: "public.t", key: { id: 1 }, set: { at: "2026-11-17T08:00:02+00:00" } }, ins({ at: "2026-11-17T08:00:02+00:00" })],
    { "public.t": ["at", "day"] },
    from,
    to,
  );
  assert.deepEqual(a.row, { id: 1, at: D.DB_CLOCK, day: D.DB_CLOCK });
  assert.deepEqual(a.generated, ["at", "day"]);
  assert.equal(b.row.at, "2026-11-16T10:05:00+00:00", "outside the run's window: written by the workflow, compared as written");
  assert.equal(c.set.at, "2026-11-17T08:00:02+00:00", "only inserts take a column default");
  assert.equal(d.row.at, D.DB_CLOCK);
  assert.equal(D.markClockDefaults([ins({ at: "2026-11-17T08:00:02+00:00" })], {}, from, to)[0].row.at, "2026-11-17T08:00:02+00:00", "a column without a clock default is kept");
  assert.match(D.PG_CLOCK_DEFAULTS_SQL, /column_default ~\* '\^\(now\\\(\\\)\|current_timestamp/);
});
