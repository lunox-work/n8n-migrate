// Expected run times of a trigger's schedule (trigger step `schedule`: {cron: [...],
// everySeconds?, timezone}) and the runs a schedule missed since the last recorded run.
// Browser-safe: the task driver uses it for the missed-run alert, the artifact page to show
// missed runs in its history. Cron: 5 fields (minute first) or 6 (second first), as n8n
// accepts and the converter writes; evaluated in the schedule's timezone with Luxon, so DST
// moves fires the way n8n's cron does.

import { DateTime } from "../vendor/luxon.mjs";

const FIELDS = [
  { min: 0, max: 59 },
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], base: 1 },
  { min: 0, max: 7, names: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"], base: 0 },
];
const MAX_WINDOW_MS = 35 * 86400_000; // a gap longer than this is reported as "more than"
export const DEFAULT_GRACE_MS = 15 * 60_000; // cloud runs "can start several minutes late"

function value(s, f) {
  if (/^\d+$/.test(s)) return Number(s);
  const i = f.names ? f.names.indexOf(s.toLowerCase()) : -1;
  if (i < 0) throw new Error(`bad cron value "${s}"`);
  return i + f.base;
}
function field(text, f) {
  const set = new Set();
  for (const part of text.split(",")) {
    const m = /^([^/]+)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`bad cron field "${text}"`);
    const step = m[2] === undefined ? 1 : Number(m[2]);
    let lo;
    let hi;
    if (m[1] === "*" || m[1] === "?") [lo, hi] = [f.min, f.max];
    else if (m[1].includes("-")) [lo, hi] = m[1].split("-").map((x) => value(x, f));
    else (lo = value(m[1], f)), (hi = m[2] === undefined ? lo : f.max);
    if (step < 1 || lo < f.min || hi > f.max || lo > hi) throw new Error(`cron field out of range "${text}"`);
    for (let x = lo; x <= hi; x += step) set.add(x);
  }
  return set;
}
export function parseCron(expr) {
  const parts = String(expr ?? "").trim().split(/\s+/);
  if (parts.length === 5) parts.unshift("0");
  if (parts.length !== 6) throw new Error(`cron needs 5 or 6 fields: "${expr}"`);
  const s = parts.map((p, i) => field(p, FIELDS[i]));
  if (s[5].has(7)) s[5].add(0);
  return { sec: s[0], min: s[1], hour: s[2], dom: s[3], mon: s[4], dow: s[5], domStar: /^[*?]/.test(parts[3]), dowStar: /^[*?]/.test(parts[5]) };
}
function dayMatches(c, d) {
  if (!c.mon.has(d.month)) return false;
  const dow = d.weekday % 7;
  if (c.domStar && c.dowStar) return true;
  if (c.domStar) return c.dow.has(dow);
  if (c.dowStar) return c.dom.has(d.day);
  return c.dom.has(d.day) || c.dow.has(dow);
}

// Fire times (ms) in (fromMs, toMs], at most `limit`. `capped` when the limit cut the list.
export function expectedRuns(schedule, fromMs, toMs, { limit = 500 } = {}) {
  const out = [];
  if (!schedule || !(toMs > fromMs)) return { times: out, capped: false };
  const crons = (schedule.cron ?? []).filter(Boolean).map(parseCron);
  const zone = schedule.timezone || "UTC";
  if (!crons.length) {
    const every = Number(schedule.everySeconds) * 1000;
    if (!(every > 0)) return { times: out, capped: false };
    for (let t = fromMs + every; t <= toMs; t += every) {
      if (out.length >= limit) return { times: out, capped: true };
      out.push(t);
    }
    return { times: out, capped: false };
  }
  // Minute by minute in the zone; seconds fields fire within the minute.
  let dt = DateTime.fromMillis(Math.floor(fromMs / 60_000) * 60_000, { zone });
  if (!dt.isValid) dt = DateTime.fromMillis(Math.floor(fromMs / 60_000) * 60_000, { zone: "UTC" });
  for (let guard = 0; guard < 60 * 24 * 40 && dt.toMillis() <= toMs; guard++, dt = dt.plus({ minutes: 1 })) {
    const hits = new Set();
    for (const c of crons) {
      if (!c.min.has(dt.minute) || !c.hour.has(dt.hour) || !dayMatches(c, dt)) continue;
      for (const s of c.sec) hits.add(dt.toMillis() + s * 1000);
    }
    for (const t of [...hits].sort((a, b) => a - b)) {
      if (t <= fromMs || t > toMs) continue;
      if (out.length >= limit) return { times: out, capped: true };
      out.push(t);
    }
  }
  return { times: out, capped: false };
}

// Runs the schedule expected after the last run and before now minus the grace period.
// lastRunAt: when the last recorded run (any status) started; null when there is none (then
// nothing counts as missed: the first run is the cutover). -> {count, since, first, times,
// capped}. A fire within the grace period of now is the run that is starting now.
export function missedRuns({ schedule, lastRunAt, now = Date.now(), graceMs = DEFAULT_GRACE_MS } = {}) {
  const last = typeof lastRunAt === "number" ? lastRunAt : Date.parse(lastRunAt ?? "");
  if (!schedule || !Number.isFinite(last)) return { count: 0, since: null, first: null, times: [], capped: false };
  const from = Math.max(last, now - MAX_WINDOW_MS);
  const { times, capped } = expectedRuns(schedule, from, now - graceMs);
  return { count: times.length, since: new Date(last).toISOString(), first: times[0] ? new Date(times[0]).toISOString() : null, times: times.map((t) => new Date(t).toISOString()), capped: capped || from > last };
}

// The schedule of a definition's first enabled trigger that has one.
export function definitionSchedule(definition) {
  for (const s of Object.values(definition?.steps ?? {})) if (s.kind === "trigger" && s.schedule && s.settings?.disabled !== true) return s.schedule;
  return null;
}
