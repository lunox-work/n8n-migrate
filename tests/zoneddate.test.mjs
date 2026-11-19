// Bench PROPOSALS P140: a native Date in an n8n expression runs in n8n's main-process zone (its
// TZ), not the workflow's timezone and not the runner process's zone. The runtime's ZonedDate
// (runtime/src/zoneddate.mjs) must behave as Node's own Date does under TZ=<zone>; a child
// process with that TZ is the oracle. Then the engine: expressions get the zone, Code nodes keep
// the process's Date, and 3809's kind of expression (local setDate across a DST change, run just
// after midnight UTC) gives n8n's day.
// The bench: the Claude side takes the bench n8n container's TZ for expressions (claude-side.mjs
// EXPRESSION_TZ), in process and in the claude driver's session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { zonedDateClass } from "../skills/n8n-migrate/runtime/src/zoneddate.mjs";
import { run } from "../skills/n8n-migrate/runtime/src/index.mjs";

// Times around DST changes in both hemispheres, a leap day, year edges and plain days.
const TIMES = ["2026-03-08T06:59:59.500Z", "2026-03-08T07:00:00Z", "2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z", "2026-11-17T00:51:00Z", "2026-11-17T04:59:00Z", "2026-11-17T05:00:00Z", "2024-02-29T12:00:00Z", "2025-12-31T23:59:59.999Z", "2026-04-05T15:59:59Z", "2026-10-04T16:30:00Z", "1969-07-20T20:17:40Z"].map(Date.parse);

// Each probe: a function of (D, t) returning JSON-able values; run here with ZonedDate and in the
// oracle with the native Date.
const PROBE = `(D, t) => {
  const d = new D(t);
  const r = [d.getFullYear(), d.getMonth(), d.getDate(), d.getDay(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds(), d.getTimezoneOffset(), d.toString(), d.toDateString(), d.toTimeString(), d.toLocaleString("en-US"), d.toLocaleDateString("en-GB"), d.toLocaleTimeString("en-US"), String(d)];
  const e = new D(t); e.setDate(e.getDate() - 90); r.push(e.getTime(), e.toISOString().split("T")[0]);
  const f = new D(t); f.setHours(2, 30, 0, 0); r.push(f.getTime());
  const g = new D(t); g.setMonth(g.getMonth() + 1, 31); r.push(g.getTime());
  const h = new D(t); h.setFullYear(2025); r.push(h.getTime());
  const i = new D(t); i.setMinutes(90); i.setSeconds(-5); i.setMilliseconds(1500); r.push(i.getTime());
  const k = new D(NaN); k.setFullYear(2020); r.push(k.getTime());
  const m = new D(t); m.setFullYear(50); r.push(m.getTime(), m.getYear()); m.setYear(95); r.push(m.getTime(), m.getYear());
  r.push(new D(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), new D(d.getFullYear(), d.getMonth(), d.getDate(), 2, 30).getTime(), new D(2026, 2, 8, 2, 30).getTime(), new D(2026, 10, 1, 1, 30).getTime(), new D(99, 0, 1).getTime(), new D(2026, 13, 0).getTime());
  r.push(D.parse("2026-11-17T08:00:00"), D.parse("2026-11-17"), D.parse("2026-11-17T08:00:00Z"), D.parse("Nov 17, 2026 08:00"), D.parse("Tue, 17 Nov 2026 08:00:00 GMT"), new D("2026-03-08 02:30").getTime(), new D(NaN).getDate(), String(new D(NaN)));
  return r;
}`;

function oracle(zone) {
  const r = spawnSync(process.execPath, ["-e", `const p = ${PROBE}; process.stdout.write(JSON.stringify(${JSON.stringify(TIMES)}.map((t) => p(Date, t))))`], { env: { ...process.env, TZ: zone }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

for (const zone of ["America/New_York", "Asia/Singapore", "Australia/Sydney", "Europe/London", "UTC", "Asia/Kolkata"]) {
  test(`ZonedDate behaves as the native Date under TZ=${zone}`, () => {
    const D = zonedDateClass(zone, () => TIMES[0]);
    const probe = eval(PROBE);
    const mine = JSON.parse(JSON.stringify(TIMES.map((t) => probe(D, t))));
    assert.deepEqual(mine, oracle(zone));
    const d = new D();
    assert.ok(d instanceof Date);
    assert.equal(d.getTime(), TIMES[0]);
    assert.equal(Object.prototype.toString.call(d), "[object Date]");
  });
}

const wf = (expr, code) => ({
  schemaVersion: 1,
  name: "P140",
  settings: { timezone: "Asia/Tokyo" },
  steps: {
    Start: { kind: "trigger", n8n: { type: "n8n-nodes-base.manualTrigger", typeVersion: 1 }, params: {} },
    Set: { kind: "logic", n8n: { type: "n8n-nodes-base.set", typeVersion: 3.4 }, params: { mode: "manual", assignments: { assignments: [{ id: "a", name: "startDate", value: expr, type: "string" }, { id: "b", name: "hour", value: "={{ new Date().getHours() }}", type: "number" }, { id: "c", name: "luxon", value: "={{ $now.toFormat('yyyy-MM-dd HH') }}", type: "string" }] }, options: {} } },
    Code: { kind: "code", n8n: { type: "n8n-nodes-base.code", typeVersion: 2 }, params: { jsCode: code } },
  },
  edges: [{ from: "Start", fromOutput: 0, to: "Set", toInput: 0 }, { from: "Set", fromOutput: 0, to: "Code", toInput: 0 }],
  allow: { tools: [], http: [], sql: [] },
  secrets: [],
});

test("P140: an expression's native Date takes n8n's main-process zone, a Code node keeps the process's, Luxon the workflow's", async () => {
  // 3809's kind: 90 days back by local setDate, run at 00:51 UTC on 2026-11-17. n8n's main process
  // under TZ=America/New_York sent 2026-08-18; UTC gives 2026-08-19.
  const expr = "={{ new Date(new Date().setDate(new Date().getDate() - 90)).toISOString().split('T')[0] }}";
  const def = wf(expr, "return $input.all().map((i) => ({ json: { ...i.json, codeHour: new Date().getHours() } }));");
  const tz = process.env.TZ;
  process.env.TZ = "UTC";
  try {
    const opts = { trigger: { node: "Start", items: [{ json: {} }] }, clock: { startedAt: "2026-11-17T00:51:00Z" }, virtualTime: true, mode: "manual" };
    const ny = await run(def, { ...opts, expressionZone: "America/New_York" });
    assert.equal(ny.status, "done");
    const out = ny.runData.Code[0].data.main[0][0].json;
    assert.equal(out.startDate, "2026-08-18");
    assert.equal(out.hour, 19);
    assert.equal(out.codeHour, 0);
    assert.equal(out.luxon, "2026-11-17 09");
    // Without a zone the process's Date serves expressions too (as before P140).
    const plain = await run(def, opts);
    assert.equal(plain.runData.Code[0].data.main[0][0].json.startDate, "2026-08-19");
    assert.equal(plain.runData.Code[0].data.main[0][0].json.hour, 0);
    // A little later both zones agree (the bench saw 3809 match at 01:02 UTC).
    const later = await run(def, { ...opts, clock: { startedAt: "2026-11-17T01:02:00Z" }, expressionZone: "America/New_York" });
    assert.equal(later.runData.Code[0].data.main[0][0].json.startDate, "2026-08-19");
    const laterUtc = await run(def, { ...opts, clock: { startedAt: "2026-11-17T01:02:00Z" } });
    assert.equal(laterUtc.runData.Code[0].data.main[0][0].json.startDate, "2026-08-19");
    // The environment names the zone where no option does (a task's runner process).
    process.env.N8M_EXPRESSION_TZ = "America/New_York";
    const env = await run(def, opts);
    assert.equal(env.runData.Code[0].data.main[0][0].json.startDate, "2026-08-18");
    delete process.env.N8M_EXPRESSION_TZ;
    await assert.rejects(async () => run(def, { ...opts, expressionZone: "Mars/Olympus" }), /expression zone Mars\/Olympus is not an IANA time zone/);
  } finally {
    delete process.env.N8M_EXPRESSION_TZ;
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

test("P140 on the bench: the Claude side's expressions take the bench n8n's main-process TZ, Code nodes the runner's", async () => {
  const { EXPRESSION_TZ, CODE_NODE_TZ } = await import("../evals/bench/claude-side.mjs");
  const { sessionEnv } = await import("../evals/bench/claude-driver.mjs");
  const { ENV } = await import("../evals/n8n/container.mjs");
  assert.equal(EXPRESSION_TZ, ENV.TZ);
  assert.equal(EXPRESSION_TZ, "America/New_York");
  const env = sessionEnv({ base: { TZ: "Asia/Singapore" } });
  assert.equal(env.TZ, CODE_NODE_TZ);
  assert.equal(env.N8M_EXPRESSION_TZ, "America/New_York");
});
