// Database sidecars for the bench's n8n (PROPOSALS P66): a Postgres and a MongoDB container on
// the bench's internal network, each started only while a template whose fixture declares that
// engine runs (n8n-side.mjs templateEnv -> container.mjs ensureDatabases), removed for the next
// template and by `container.mjs down`. Zero dependencies; drives the `docker` CLI.
//
// Per run (one template variant): a fresh database named for the run (bench_<id>_<variant>_<t>),
// seeded from the fixture's typed `db` (FIXTURES.md), its state snapshotted, n8n's credential
// pointed at it; after the run the state is snapshotted again and diffed (inserted, updated and
// deleted rows or documents, tables or collections created or dropped), and the statements n8n
// sent are read back (Postgres: log_statement=all as JSON log lines, filtered to the run's
// database and n8n's role; MongoDB: the database profiler at level 2). The diff is the write
// effect: it shows what the database holds after the run whatever SQL or command produced it,
// which model-written queries need. The statements are reported as reads (and searched for bait).
// The run's database is dropped when the next run seeds its own, so a pooled connection n8n
// keeps never sees another run's data and no run reuses another's name.
//
// Credentials here are the bench's own dummies and protect nothing.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

export const NET = "n8n2claude-net";
export const DB_USER = "bench";
export const DB_PASSWORD = "bench-db-not-a-secret";
const SUPER_PASSWORD = "bench-db-super-not-a-secret";

// Images pinned by tag and index digest. Postgres 17.11 on Alpine; MongoDB 7.0.48 (no Alpine
// build exists). Memory caps include the in-container clients the bench runs (psql, mongosh);
// measured peaks (cgroup memory.peak over a seed, writes and a collect): Postgres 109 MiB,
// MongoDB 234 MiB (WiredTiger cache 0.25 GB, the smallest it takes).
export const SIDECARS = {
  postgres: {
    name: "n8n2claude-postgres",
    image: "postgres:17.11-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24",
    alias: "postgres",
    port: 5432,
    memory: "256m",
    credentialType: "postgres",
  },
  mongodb: {
    name: "n8n2claude-mongo",
    image: "mongo:7.0.48@sha256:9896df581dfd0718b7abe112f4c37598d0986c54060e4ec1384997e6503c8c71",
    alias: "mongo",
    port: 27017,
    memory: "384m",
    credentialType: "mongoDb",
  },
};
export const ENGINES = Object.keys(SIDECARS);

// ---------- the plan: what a fixture asks the databases to hold ----------

const PG_LOG = "/var/lib/postgresql/data/log/bench.json";

// A database name for one run: lower case, under Postgres' 63 bytes, unique per run.
export function runDatabaseName(id, variant, stamp = Date.now()) {
  return `bench_${String(id).replace(/\W+/g, "")}_${String(variant).replace(/\W+/g, "")}_${Number(stamp).toString(36)}`.toLowerCase().slice(0, 63);
}

// "schema.table" or "table" (public) -> {schema, table}.
export function splitTable(name) {
  const s = String(name);
  const i = s.indexOf(".");
  return i < 0 ? { schema: "public", table: s } : { schema: s.slice(0, i), table: s.slice(i + 1) };
}

// A column type as SQL (`integer primary key`, `numeric(10,2)`, `text not null default ''`,
// `integer references sales.customers(id)`). Written by the fixture writer, so only a guard
// against a fragment that would end the statement: no `;`, no dollar quote, no comment.
export function columnTypeError(t) {
  if (typeof t !== "string" || !t.trim()) return "empty type";
  if (/;|\$|--|\/\*/.test(t)) return `type ${JSON.stringify(t)} holds ; $ -- or /*`;
  return null;
}

// Legacy seeds (reads[].db.seed, untyped rows written before P66): column types inferred from the
// values, the widest that holds them all: integer -> bigint, number -> numeric, boolean, object
// or array -> jsonb, anything else (strings, all null) -> text. Columns in first-seen order.
export function inferColumns(rows = []) {
  const kinds = new Map();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r ?? {})) {
      if (!kinds.has(k)) kinds.set(k, new Set());
      if (v === null || v === undefined) continue;
      kinds.get(k).add(typeof v === "number" ? (Number.isInteger(v) ? "int" : "num") : typeof v === "boolean" ? "bool" : typeof v === "object" ? "json" : "text");
    }
  }
  const out = {};
  for (const [k, s] of kinds) {
    if (!s.size) out[k] = "text";
    else if (s.size === 1 && s.has("int")) out[k] = "bigint";
    else if ([...s].every((x) => x === "int" || x === "num")) out[k] = "numeric";
    else if (s.size === 1 && s.has("bool")) out[k] = "boolean";
    else if (s.size === 1 && s.has("json")) out[k] = "jsonb";
    else out[k] = "text";
  }
  return out;
}

// The databases one fixture variant needs: {postgres?: {database, tables: [...]}, mongodb?:
// {database, collections: [...]}} or null. From the fixture's top-level `db` (typed), else from
// legacy read seeds (types inferred, `inferred: true`); a read whose `db.engine` names an engine
// with neither gets an empty database of it, so n8n connects and finds nothing. MySQL has no
// sidecar: its reads keep the unreachable dummy (expect.n8nCannotRun).
export function dbPlan(fx, { id = fx?.template, variant = fx?.variant, stamp = Date.now() } = {}) {
  const plan = {};
  const pg = fx?.db?.postgres;
  if (pg) {
    plan.postgres = {
      tables: Object.entries(pg.tables ?? {}).map(([name, t]) => ({ ...splitTable(name), columns: Object.entries(t.columns ?? {}), constraints: t.constraints ?? [], rows: t.rows ?? [] })),
    };
  }
  const mg = fx?.db?.mongodb;
  if (mg) plan.mongodb = { collections: Object.entries(mg.collections ?? {}).map(([name, docs]) => ({ name, docs: docs ?? [] })) };
  const reads = (fx?.reads ?? []).filter((r) => r.db?.engine);
  if (!plan.postgres) {
    const seeds = new Map();
    for (const r of reads) if (r.db.engine === "postgres") for (const [name, rows] of Object.entries(r.db.seed ?? {})) if (!seeds.has(name)) seeds.set(name, rows);
    if (seeds.size || reads.some((r) => r.db.engine === "postgres")) {
      plan.postgres = { tables: [...seeds].map(([name, rows]) => ({ ...splitTable(name), columns: Object.entries(inferColumns(rows)), constraints: [], rows })), ...(seeds.size ? { inferred: true } : {}) };
    }
  }
  if (!plan.mongodb && reads.some((r) => r.db.engine === "mongodb")) {
    const cols = new Map();
    for (const r of reads) if (r.db.engine === "mongodb") for (const [name, docs] of Object.entries(r.db.seed ?? {})) if (!cols.has(name)) cols.set(name, docs);
    plan.mongodb = { collections: [...cols].map(([name, docs]) => ({ name, docs })) };
  }
  if (!Object.keys(plan).length) return null;
  for (const e of Object.keys(plan)) plan[e].database = runDatabaseName(id, variant, stamp);
  return plan;
}

// Problems a plan has before any container runs (validate.mjs and the run's fixture error): a
// row key that is not a column, a column type that could end the statement, a document that is
// not an object.
export function planErrors(plan) {
  const errs = [];
  for (const t of plan?.postgres?.tables ?? []) {
    const name = `${t.schema}.${t.table}`;
    // A legacy seed's table without rows has no columns to infer: it is created without any.
    if (!t.columns.length && !plan.postgres.inferred) errs.push(`db.postgres ${name}: no columns`);
    const cols = new Set(t.columns.map(([c]) => c));
    for (const [c, type] of t.columns) {
      const e = columnTypeError(type);
      if (e) errs.push(`db.postgres ${name}.${c}: ${e}`);
    }
    for (const c of t.constraints) if (columnTypeError(c)) errs.push(`db.postgres ${name}: constraint ${columnTypeError(c)}`);
    t.rows.forEach((r, i) => {
      if (!r || typeof r !== "object" || Array.isArray(r)) return errs.push(`db.postgres ${name} row ${i}: not an object`);
      for (const k of Object.keys(r)) if (!cols.has(k)) errs.push(`db.postgres ${name} row ${i}: ${k} is not a column`);
    });
  }
  for (const c of plan?.mongodb?.collections ?? []) {
    if (!/^[^$\0]+$/.test(c.name) || c.name.startsWith("system.")) errs.push(`db.mongodb ${c.name}: not a collection name`);
    c.docs.forEach((d, i) => (!d || typeof d !== "object" || Array.isArray(d)) && errs.push(`db.mongodb ${c.name} doc ${i}: not an object`));
  }
  return errs;
}

// ---------- Postgres SQL ----------

export const pgIdent = (s) => `"${String(s).replace(/"/g, '""')}"`;
const pgTable = (t) => `${pgIdent(t.schema)}.${pgIdent(t.table)}`;
const dollar = (text) => {
  let tag;
  do tag = `$s${randomBytes(4).toString("hex")}$`;
  while (text.includes(tag));
  return `${tag}${text}${tag}`;
};

// The seed script, run by the superuser in the run's database (owned by n8n's role): as n8n's
// role, the schemas and tables in fixture order (a reference names an earlier table), then each
// row through json_populate_record, so Postgres itself casts the JSON values to the column types
// and a column the row leaves out takes its default; then the table constraints, added after the
// rows (`... not valid` keeps rows that break it, as in a database that gained the constraint
// later); then every serial or identity sequence moves past the seeded keys, as a database that
// grew to those rows would have it.
export function pgSeedSql(plan) {
  const out = ["SET ROLE " + pgIdent(DB_USER) + ";"];
  const schemas = [...new Set((plan.tables ?? []).map((t) => t.schema))].filter((s) => s !== "public");
  for (const s of schemas) out.push(`CREATE SCHEMA IF NOT EXISTS ${pgIdent(s)};`);
  for (const t of plan.tables ?? []) out.push(`CREATE TABLE ${pgTable(t)} (${t.columns.map(([c, type]) => `${pgIdent(c)} ${type}`).join(", ")});`);
  for (const t of plan.tables ?? []) {
    for (const r of t.rows) {
      const cols = Object.keys(r);
      if (!cols.length) {
        out.push(`INSERT INTO ${pgTable(t)} DEFAULT VALUES;`);
        continue;
      }
      const list = cols.map(pgIdent).join(", ");
      out.push(`INSERT INTO ${pgTable(t)} (${list}) SELECT ${list} FROM json_populate_record(NULL::${pgTable(t)}, ${dollar(JSON.stringify(r))}::json);`);
    }
  }
  for (const t of plan.tables ?? []) for (const c of t.constraints ?? []) out.push(`ALTER TABLE ${pgTable(t)} ADD ${c};`);
  out.push(`DO $bench$ DECLARE r record; BEGIN
  FOR r IN SELECT n.nspname s, c.relname t, a.attname col, pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) seq
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
  LOOP
    IF r.seq IS NOT NULL THEN EXECUTE format('SELECT setval(%L, COALESCE((SELECT max(%I) FROM %I.%I), 0) + 1, false)', r.seq, r.col, r.s, r.t); END IF;
  END LOOP; END $bench$;`);
  out.push("RESET ROLE;");
  return out.join("\n");
}

// The user tables of a database with their primary-key columns, as one JSON line.
export const PG_TABLES_SQL = `SELECT coalesce(json_agg(json_build_object('schema', n.nspname, 'table', c.relname, 'pk',
  (SELECT coalesce(json_agg(a.attname ORDER BY array_position(i.indkey::int2[], a.attnum)), '[]'::json) FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = c.oid AND i.indisprimary)
) ORDER BY n.nspname, c.relname), '[]'::json)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%';`;

// Every row of those tables as one JSON object {"schema.table": {pk, rows}}, rows in key order
// (physical order for a table without a key).
export function pgRowsSql(tables) {
  if (!tables.length) return "SELECT '{}'::json;";
  const part = (t) => {
    const order = t.pk.length ? t.pk.map((c) => `x.${pgIdent(c)}`).join(", ") : "x.ctid";
    return `${dollar(`${t.schema}.${t.table}`)}::text, json_build_object('pk', ${dollar(JSON.stringify(t.pk))}::json, 'rows', (SELECT coalesce(json_agg(x ORDER BY ${order}), '[]'::json) FROM ${pgTable(t)} x))`;
  };
  // json_build_object takes at most 100 arguments: one object per table, merged.
  return `SELECT ${tables.map((t) => `jsonb_build_object(${part(t)})`).join(" || ")};`;
}

// The statements n8n sent to the run's database, from Postgres' JSON log (log_statement=all):
// lines of n8n's role in that database. A statement the server refused carries the error.
export function pgStatements(text, { database, user = DB_USER } = {}) {
  const out = [];
  const lastBySession = new Map();
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.dbname !== database || e.user !== user) continue;
    const m = /^(?:statement|execute [^:]*): ([\s\S]*)$/.exec(e.message ?? "");
    if (m) {
      const s = { sql: m[1].trim() };
      const p = /^parameters: ([\s\S]*)$/i.exec(e.detail ?? "");
      if (p) s.params = p[1];
      out.push(s);
      lastBySession.set(e.session_id, s);
      continue;
    }
    if (/^(ERROR|FATAL)$/.test(e.error_severity ?? "") && lastBySession.has(e.session_id)) lastBySession.get(e.session_id).error = e.message;
  }
  return out;
}

// The tables a statement names after FROM, JOIN, INTO, UPDATE or TABLE (strings and comments
// removed first), lower-cased unless quoted. A read's key for the report only; writes come from
// the diff.
export function sqlTables(sql) {
  const s = String(sql).replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/'(?:[^']|'')*'/g, "''");
  const id = `(?:"(?:[^"]|"")+"|[A-Za-z_][\\w$]*)`;
  const re = new RegExp(`\\b(?:from|join|into|update|table)\\s+(?:only\\s+|if\\s+(?:not\\s+)?exists\\s+)?(${id}(?:\\s*\\.\\s*${id})?)`, "gi");
  const norm = (p) => (p.startsWith('"') ? p.slice(1, -1).replace(/""/g, '"') : p.toLowerCase());
  const out = new Set();
  for (const m of s.matchAll(re)) {
    const parts = m[1].split(/\s*\.\s*(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(norm);
    if (["select", "lateral", "unnest"].includes(parts[0])) continue;
    out.add(parts.length > 1 ? parts.join(".") : `public.${parts[0]}`);
  }
  return [...out].sort();
}

// ---------- the diff (both engines) ----------

const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}` : JSON.stringify(v));
const pick = (row, cols) => Object.fromEntries(cols.map((c) => [c, row?.[c] ?? null]));

// before/after: {"<table>": {pk: [cols], rows: [row]}}. Rows pair by primary key when the table
// has one (a changed row is an update of the columns that differ), else as a multiset of whole
// rows. -> [{engine, op, table, key?, row?, set?, before?, rows?}] with op insert, update,
// delete, create_table or drop_table, in table order, then key order.
export function diffTables(before = {}, after = {}, engine = "postgres") {
  const out = [];
  for (const table of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const b = before[table];
    const a = after[table];
    if (!b) out.push({ engine, op: "create_table", table });
    if (!a) {
      out.push({ engine, op: "drop_table", table, rows: b.rows.length });
      continue;
    }
    const pk = a.pk?.length ? a.pk : b?.pk ?? [];
    const was = b?.rows ?? [];
    if (pk.length) {
      const keyOf = (r) => stable(pick(r, pk));
      const old = new Map(was.map((r) => [keyOf(r), r]));
      const now = new Map(a.rows.map((r) => [keyOf(r), r]));
      for (const r of a.rows) {
        const o = old.get(keyOf(r));
        if (!o) out.push({ engine, op: "insert", table, key: pick(r, pk), row: r });
        else {
          const cols = [...new Set([...Object.keys(o), ...Object.keys(r)])].filter((c) => stable(o[c]) !== stable(r[c]));
          if (cols.length) out.push({ engine, op: "update", table, key: pick(r, pk), set: Object.fromEntries(cols.map((c) => [c, r[c] === undefined ? null : r[c]])), before: Object.fromEntries(cols.map((c) => [c, o[c] === undefined ? null : o[c]])) });
        }
      }
      for (const r of was) if (!now.has(keyOf(r))) out.push({ engine, op: "delete", table, key: pick(r, pk), row: r });
    } else {
      const left = new Map();
      for (const r of was) left.set(stable(r), (left.get(stable(r)) ?? 0) + 1);
      for (const r of a.rows) {
        const k = stable(r);
        if (left.get(k)) left.set(k, left.get(k) - 1);
        else out.push({ engine, op: "insert", table, row: r });
      }
      for (const r of was) {
        const k = stable(r);
        if (left.get(k)) {
          left.set(k, left.get(k) - 1);
          out.push({ engine, op: "delete", table, row: r });
        }
      }
    }
  }
  return out;
}

// MongoDB collections as diffTables tables: documents keyed by _id. A document the run inserted
// whose _id is an ObjectId the driver generated is marked `generatedId` (its value differs on
// every run, so the comparer leaves it out).
export function mongoTables(snapshot = {}) {
  return Object.fromEntries(Object.entries(snapshot).map(([name, docs]) => [name, { pk: ["_id"], rows: docs }]));
}
export function diffCollections(before = {}, after = {}) {
  return diffTables(mongoTables(before), mongoTables(after), "mongodb").map((c) => (c.op === "insert" && c.key?._id && typeof c.key._id === "object" && "$oid" in c.key._id ? { ...c, generatedId: true } : c));
}

// ---------- docker ----------

function docker(args, { input, allowFail = false } = {}) {
  const r = spawnSync("docker", args, { input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) throw new Error(`docker ${args.slice(0, 3).join(" ")} failed (${r.status}): ${(r.stderr || "").trim().slice(0, 2000)}`);
  return r;
}
const running = (name) => docker(["inspect", "-f", "{{.State.Running}}", name], { allowFail: true }).stdout?.trim() === "true";
const exists = (name) => docker(["inspect", name], { allowFail: true }).status === 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runArgs(engine) {
  const s = SIDECARS[engine];
  const base = ["run", "-d", "--name", s.name, "--label", `n8n2claude.db=${engine}`, `--memory=${s.memory}`, `--memory-swap=${s.memory}`, "--network", NET, "--network-alias", s.alias];
  if (engine === "postgres") {
    return [
      ...base, "-e", `POSTGRES_PASSWORD=${SUPER_PASSWORD}`, s.image,
      "-c", "shared_buffers=32MB", "-c", "max_connections=40", "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off", "-c", "timezone=UTC",
      "-c", "log_statement=all", "-c", "logging_collector=on", "-c", "log_destination=jsonlog", "-c", "log_directory=log", "-c", "log_filename=bench.log", "-c", "log_rotation_age=0", "-c", "log_rotation_size=0",
    ];
  }
  return [...base, s.image, "mongod", "--bind_ip_all", "--wiredTigerCacheSizeGB", "0.25", "--setParameter", "diagnosticDataCollectionEnabled=false", "--quiet"];
}

// psql as the superuser over the container's socket. -> stdout (throws with the server's error).
export function psql(database, sql, { allowFail = false } = {}) {
  const r = docker(["exec", "-i", SIDECARS.postgres.name, "psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database], { input: sql, allowFail: true });
  if (r.status !== 0 && !allowFail) throw new Error((r.stderr || r.stdout || "").trim().slice(0, 1500));
  return r.stdout;
}

// mongosh against the container's mongod; `input` is written to /tmp/bench-in.json first.
export function mongosh(script, { input } = {}) {
  const s = SIDECARS.mongodb.name;
  if (input !== undefined) docker(["exec", "-i", s, "sh", "-c", "cat > /tmp/bench-in.json"], { input });
  const r = docker(["exec", s, "mongosh", "--quiet", "--norc", "mongodb://127.0.0.1:27017/admin?directConnection=true", "--eval", script], { allowFail: true });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || "").trim().slice(0, 1500));
  return r.stdout;
}

async function waitReady(engine, timeoutMs = 90_000) {
  const t0 = Date.now();
  const s = SIDECARS[engine];
  let last = "";
  while (Date.now() - t0 < timeoutMs) {
    if (!running(s.name)) throw new Error(`${s.name} stopped:\n${docker(["logs", "--tail", "30", s.name], { allowFail: true }).stderr}`);
    // Postgres: over TCP, which the image's init server (socket only) never answers.
    const r =
      engine === "postgres"
        ? docker(["exec", "-e", `PGPASSWORD=${SUPER_PASSWORD}`, s.name, "psql", "-X", "-q", "-At", "-h", "127.0.0.1", "-U", "postgres", "-c", "SELECT 1"], { allowFail: true })
        : docker(["exec", s.name, "mongosh", "--quiet", "--norc", "mongodb://127.0.0.1:27017/admin?directConnection=true", "--eval", "db.runCommand({ping: 1}).ok"], { allowFail: true });
    if (r.status === 0 && /1/.test(r.stdout)) return Date.now() - t0;
    last = (r.stderr || r.stdout || "").trim().slice(0, 200);
    await sleep(1000);
  }
  throw new Error(`${s.name} not ready after ${timeoutMs / 1000}s (${last})`);
}

// Starts the sidecars `engines` names and removes the others (the bench network must exist).
// -> [engine started]
export async function ensureDatabases(engines = [], { log = console.error } = {}) {
  const want = new Set(engines.filter((e) => SIDECARS[e]));
  for (const e of ENGINES) if (!want.has(e) && exists(SIDECARS[e].name)) {
    docker(["rm", "-f", "-v", SIDECARS[e].name], { allowFail: true });
    log(`${SIDECARS[e].name} removed (no database of its engine in this run)`);
  }
  const started = [];
  for (const e of want) {
    const s = SIDECARS[e];
    if (running(s.name)) continue;
    docker(["rm", "-f", "-v", s.name], { allowFail: true });
    docker(runArgs(e));
    const ms = await waitReady(e);
    if (e === "postgres") psql("postgres", `DO $b$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN CREATE ROLE ${pgIdent(DB_USER)} LOGIN PASSWORD '${DB_PASSWORD}'; END IF; END $b$;`);
    log(`${s.name} up (${s.image.split("@")[0]}, ${s.memory} cap, ${Math.round(ms / 100) / 10} s)`);
    started.push(e);
  }
  return started;
}

export function removeDatabases() {
  for (const e of ENGINES) docker(["rm", "-f", "-v", SIDECARS[e].name], { allowFail: true });
}

// The n8n credential data for each engine of a plan (n8n 2.47.7 credential property names).
export function dbCredentials(plan) {
  const out = {};
  if (plan?.postgres) out.postgres = { host: SIDECARS.postgres.alias, database: plan.postgres.database, user: DB_USER, password: DB_PASSWORD, port: SIDECARS.postgres.port, ssl: "disable", allowUnauthorizedCerts: false, maxConnections: 10 };
  if (plan?.mongodb) out.mongoDb = { configurationType: "connectionString", connectionString: `mongodb://${SIDECARS.mongodb.alias}:${SIDECARS.mongodb.port}/?directConnection=true`, database: plan.mongodb.database, tls: false };
  return out;
}

// ---------- per run ----------

function pgSnapshot(database) {
  const tables = JSON.parse(psql(database, PG_TABLES_SQL).trim() || "[]");
  return JSON.parse(psql(database, pgRowsSql(tables)).trim() || "{}");
}
const MONGO_SNAPSHOT = `const snap = (d) => Object.fromEntries(d.getCollectionNames().filter((n) => !n.startsWith("system.")).sort().map((n) => [n, d.getCollection(n).find().sort({ $natural: 1 }).toArray()]));`;

// Fresh databases for the run, seeded; earlier runs' databases dropped. -> {postgres?: {before},
// mongodb?: {before}}; throws DbSeedError (a fixture error) when the seed is refused.
export class DbSeedError extends Error {}
export function seedRun(plan) {
  const state = {};
  const errs = planErrors(plan);
  if (errs.length) throw new DbSeedError(errs.slice(0, 3).join("; "));
  if (plan.postgres) {
    const db = plan.postgres.database;
    psql("postgres", `SELECT format('DROP DATABASE %I WITH (FORCE)', datname) FROM pg_database WHERE datname LIKE 'bench\\_%' AND datname <> '${db}'\n\\gexec\nCREATE DATABASE ${pgIdent(db)} OWNER ${pgIdent(DB_USER)};`);
    try {
      psql(db, pgSeedSql(plan.postgres));
    } catch (e) {
      throw new DbSeedError(`postgres seed refused: ${e.message}`);
    }
    state.postgres = { before: pgSnapshot(db) };
  }
  if (plan.mongodb) {
    const input = JSON.stringify({ database: plan.mongodb.database, collections: plan.mongodb.collections });
    let out;
    try {
      out = mongosh(
        `${MONGO_SNAPSHOT}
const s = EJSON.parse(require("fs").readFileSync("/tmp/bench-in.json", "utf8"));
for (const n of db.getMongo().getDBNames()) if (n.startsWith("bench_") && n !== s.database) db.getSiblingDB(n).dropDatabase();
const d = db.getSiblingDB(s.database);
d.dropDatabase();
for (const c of s.collections) { d.createCollection(c.name); if (c.docs.length) d.getCollection(c.name).insertMany(c.docs); }
const before = snap(d);
d.setProfilingLevel(2);
print(EJSON.stringify(before, { relaxed: true }));`,
        { input },
      );
    } catch (e) {
      throw new DbSeedError(`mongodb seed refused: ${e.message}`);
    }
    state.mongodb = { before: JSON.parse(out.trim().split("\n").at(-1)) };
  }
  return state;
}

// After the run: the diff against the seeded state and the statements n8n sent.
// -> {changes: [...], statements: [{engine, sql|command, ...}]}
export function collectRun(plan, state) {
  const changes = [];
  const statements = [];
  if (plan.postgres && state.postgres) {
    const db = plan.postgres.database;
    for (const s of pgStatements(docker(["exec", SIDECARS.postgres.name, "cat", PG_LOG], { allowFail: true }).stdout ?? "", { database: db })) statements.push({ engine: "postgres", ...s, tables: sqlTables(s.sql) });
    changes.push(...diffTables(state.postgres.before, pgSnapshot(db), "postgres"));
  }
  if (plan.mongodb && state.mongodb) {
    const out = mongosh(`${MONGO_SNAPSHOT}
const d = db.getSiblingDB(${JSON.stringify(plan.mongodb.database)});
d.setProfilingLevel(0);
const ops = d.system.profile.find({ ns: { $ne: d.getName() + ".system.profile" } }).sort({ ts: 1 }).toArray().filter((p) => !/^mongosh/.test(p.appName ?? ""));
const statements = ops.map((p) => { const c = { ...(p.command ?? {}) }; for (const k of ["lsid", "$db", "$clusterTime", "$readPreference", "txnNumber"]) delete c[k]; return { op: p.op, collection: String(p.ns ?? "").split(".").slice(1).join("."), command: c, ...(p.errMsg ? { error: p.errMsg } : {}) }; });
print(EJSON.stringify({ statements, after: snap(d) }, { relaxed: true }));`);
    const r = JSON.parse(out.trim().split("\n").at(-1));
    for (const s of r.statements) statements.push({ engine: "mongodb", ...s });
    changes.push(...diffCollections(state.mongodb.before, r.after));
  }
  return { changes, statements };
}
