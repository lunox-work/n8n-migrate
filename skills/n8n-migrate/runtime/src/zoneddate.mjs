// A native `Date` whose local time is one IANA zone, for n8n expressions (bench PROPOSALS P140).
//
// n8n evaluates an expression in its main process, so a native Date there (`new
// Date().getDate()`, `setDate`, `toString()`, `toLocaleString()`) uses that process's zone: its
// `TZ` environment variable, else the host's zone (UTC in n8n's own Docker image). The workflow's
// timezone setting and GENERIC_TIMEZONE only reach Luxon (`$now`, `DateTime`), never the native
// Date. A Code node runs in n8n's task runner, which is started without `TZ`
// (task-runner-process-js.js getProcessEnvVars), so its native Date has the runner host's zone.
// The runtime runs both in one process, so an expression gets this class instead of the process's
// Date when the run names the zone of n8n's main process (engine.mjs createRun `expressionZone`);
// a Code node keeps the process's own Date.
//
// The class extends Date, so `instanceof Date`, the time value, toISOString(), toJSON(), getUTC*()
// and Luxon's fromJSDate are unchanged; only the local-time methods are redefined, after
// ECMA-262's LocalTime and UTC(t) (a local time in a gap is read with the offset before the
// transition, a repeated one as the earlier instant). The zone's offsets come from Intl.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_MS = 86400000;
const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, "0");
// The year Date.UTC and the Date constructor add to a two-digit year (ECMA-262 MakeFullYear).
const BASE_YEAR = new Date(Date.UTC(0, 0)).getUTCFullYear();
// Time value of UTC fields without the two-digit-year rule (MakeDay/MakeTime, as the setters use).
const utcFields = (y, mo, d, h, mi, s, ms) => {
  const t = new Date(0);
  t.setUTCFullYear(y, mo, d);
  t.setUTCHours(h, mi, s, ms);
  return t.getTime();
};

export function zonedDateClass(zone, now = () => Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", era: "short" });
  const longName = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "long" });
  // Offset of the zone from UTC at time value t, in milliseconds east (UTC+8 -> 28800000; a
  // local mean time before standard zones keeps its seconds, as V8 does).
  const offsetAt = (t) => {
    const p = Object.fromEntries(parts.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    let y = Number(p.year);
    if (p.era === "BC" || p.era === "B") y = 1 - y;
    const wall = utcFields(y, Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second), 0);
    const whole = t - (((t % 1000) + 1000) % 1000);
    return wall - whole;
  };
  // UTC(t): the time value of local time value `local` in the zone.
  const fromLocal = (local) => {
    if (!Number.isFinite(local)) return NaN;
    const before = offsetAt(local - DAY_MS);
    const after = offsetAt(local + DAY_MS);
    const valid = [...new Set([before, after])].map((o) => local - o).filter((t) => offsetAt(t) === local - t);
    if (valid.length) return Math.min(...valid);
    return local - before;
  };
  const toLocal = (t) => t + offsetAt(t);
  // Local components of a time value, as the UTC components of its local time value.
  const fields = (t) => {
    const d = new Date(toLocal(t));
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), ms: d.getUTCMilliseconds(), day: d.getUTCDay() };
  };
  const make = (f) => fromLocal(utcFields(f.y, f.mo, f.d, f.h, f.mi, f.s, f.ms));
  const clip = (t) => (Number.isFinite(t) && Math.abs(t) <= 8.64e15 ? Math.trunc(t) : NaN);
  // A date-time string with no zone or offset is local time (ECMA-262 Date.parse); the host's
  // parser reads it in the process's zone, so its local fields are re-read in this one. Strings
  // with Z, an offset, a zone name, or the date-only ISO forms (UTC) are absolute.
  const absolute = (s) => /(Z|[+-]\d{2}:?\d{2}|\b(GMT|UTC|UT|[ECMP][SD]T)\b[^a-z]*)\s*(\([^)]*\))?\s*$/i.test(s) || /^\s*[+-]?\d{4,6}(-\d{2}(-\d{2})?)?\s*$/.test(s);
  const parse = (s) => {
    const host = Date.parse(s);
    if (!Number.isFinite(host) || absolute(String(s))) return host;
    const d = new Date(host);
    return fromLocal(utcFields(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()));
  };
  const time = (self) => Date.prototype.getTime.call(self);
  const set = (self, t) => Date.prototype.setTime.call(self, clip(t));
  const num = (v) => Number(v);
  const offsetText = (t) => {
    const o = Math.trunc(offsetAt(t) / 60000);
    return `GMT${o < 0 ? "-" : "+"}${pad(Math.trunc(Math.abs(o) / 60))}${pad(Math.abs(o) % 60)}`;
  };
  // V8 names the zone by its standard or daylight long name, whichever is in effect at t, not by
  // the name ICU gives that date (which falls back to "GMT-04:00" before the zone's metazone
  // existed); the two names are read from a reference year.
  const nameAt = (t) => longName.formatToParts(new Date(t)).find((x) => x.type === "timeZoneName")?.value ?? zone;
  const refYear = new Date(now()).getUTCFullYear();
  const REF = [Date.UTC(refYear, 0, 1), Date.UTC(refYear, 6, 1)].map((t) => ({ o: offsetAt(t), name: nameAt(t) })).sort((a, b) => a.o - b.o);
  const zoneName = (t) => {
    if (REF[0].o === REF[1].o) return REF[0].name;
    // In daylight time when the offset is above the year's lower one; in a year with one offset
    // (London's all-year summer time of 1968-71), above the reference year's standard offset.
    const y = new Date(toLocal(t)).getUTCFullYear();
    const [jan, jul] = [offsetAt(utcFields(y, 0, 1, 0, 0, 0, 0)), offsetAt(utcFields(y, 6, 1, 0, 0, 0, 0))];
    const daylight = jan !== jul ? offsetAt(t) > Math.min(jan, jul) : offsetAt(t) > REF[0].o;
    return daylight ? REF[1].name : REF[0].name;
  };
  const yearText = (y) => (y < 0 ? `-${pad(y, 6)}` : pad(y, 4));
  const withZone = (opts) => (opts && typeof opts === "object" && opts.timeZone !== undefined ? opts : { ...(opts ?? {}), timeZone: zone });

  class ZonedDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(now());
      else if (args.length === 1) {
        const v = args[0] instanceof Date ? time(args[0]) : args[0];
        super(typeof v === "string" ? parse(v) : v);
      } else {
        // Date.UTC applies the constructor's two-digit-year rule.
        const [y, mo, d = 1, h = 0, mi = 0, s = 0, ms = 0] = args.map(num);
        super(clip(fromLocal(Date.UTC(y, mo, d, h, mi, s, ms))));
      }
    }
    static now() {
      return now();
    }
    static parse(s) {
      return parse(String(s));
    }
    getTimezoneOffset() {
      const t = time(this);
      return Number.isFinite(t) ? -offsetAt(t) / 60000 : NaN;
    }
    getFullYear() {
      const t = time(this);
      return Number.isFinite(t) ? fields(t).y : NaN;
    }
    getYear() {
      const y = this.getFullYear();
      return Number.isFinite(y) ? y - BASE_YEAR : NaN;
    }
    getMonth() {
      const t = time(this);
      return Number.isFinite(t) ? fields(t).mo : NaN;
    }
    getDate() {
      const t = time(this);
      return Number.isFinite(t) ? fields(t).d : NaN;
    }
    getDay() {
      const t = time(this);
      return Number.isFinite(t) ? fields(t).day : NaN;
    }
    getHours() {
      const t = time(this);
      return Number.isFinite(t) ? fields(t).h : NaN;
    }
    getMinutes() {
      const t = time(this);
      return Number.isFinite(t) ? fields(t).mi : NaN;
    }
    getSeconds() {
      const t = time(this);
      return Number.isFinite(t) ? fields(t).s : NaN;
    }
    getMilliseconds() {
      const t = time(this);
      return Number.isFinite(t) ? fields(t).ms : NaN;
    }
    // Setters (ECMA-262 21.4.4.20-28): the other local fields stay; NaN stays NaN except for
    // setFullYear, which starts from +0's local time.
    setFullYear(y, ...rest) {
      const t = time(this);
      const f = fields(Number.isFinite(t) ? t : fromLocal(0));
      return set(this, make({ ...f, y: num(y), ...(rest.length > 0 ? { mo: num(rest[0]) } : {}), ...(rest.length > 1 ? { d: num(rest[1]) } : {}) }));
    }
    setMonth(mo, ...rest) {
      const t = time(this);
      if (!Number.isFinite(t)) return NaN;
      return set(this, make({ ...fields(t), mo: num(mo), ...(rest.length > 0 ? { d: num(rest[0]) } : {}) }));
    }
    setDate(d) {
      const t = time(this);
      if (!Number.isFinite(t)) return NaN;
      return set(this, make({ ...fields(t), d: num(d) }));
    }
    setHours(h, ...rest) {
      const t = time(this);
      if (!Number.isFinite(t)) return NaN;
      const [mi, s, ms] = rest.map(num);
      const f = fields(t);
      return set(this, make({ ...f, h: num(h), ...(rest.length > 0 ? { mi } : {}), ...(rest.length > 1 ? { s } : {}), ...(rest.length > 2 ? { ms } : {}) }));
    }
    setMinutes(mi, ...rest) {
      const t = time(this);
      if (!Number.isFinite(t)) return NaN;
      const [s, ms] = rest.map(num);
      return set(this, make({ ...fields(t), mi: num(mi), ...(rest.length > 0 ? { s } : {}), ...(rest.length > 1 ? { ms } : {}) }));
    }
    setSeconds(s, ...rest) {
      const t = time(this);
      if (!Number.isFinite(t)) return NaN;
      return set(this, make({ ...fields(t), s: num(s), ...(rest.length > 0 ? { ms: num(rest[0]) } : {}) }));
    }
    setMilliseconds(ms) {
      const t = time(this);
      if (!Number.isFinite(t)) return NaN;
      return set(this, make({ ...fields(t), ms: num(ms) }));
    }
    setYear(y) {
      const n = num(y);
      return this.setFullYear(Number.isFinite(n) && Math.trunc(n) >= 0 && Math.trunc(n) <= 99 ? BASE_YEAR + Math.trunc(n) : n);
    }
    toDateString() {
      const t = time(this);
      if (!Number.isFinite(t)) return "Invalid Date";
      const f = fields(t);
      return `${DAYS[f.day]} ${MONTHS[f.mo]} ${pad(f.d)} ${yearText(f.y)}`;
    }
    toTimeString() {
      const t = time(this);
      if (!Number.isFinite(t)) return "Invalid Date";
      const f = fields(t);
      return `${pad(f.h)}:${pad(f.mi)}:${pad(f.s)} ${offsetText(t)} (${zoneName(t)})`;
    }
    toString() {
      const t = time(this);
      if (!Number.isFinite(t)) return "Invalid Date";
      return `${this.toDateString()} ${this.toTimeString()}`;
    }
    toLocaleString(locales, opts) {
      return Date.prototype.toLocaleString.call(this, locales, withZone(opts));
    }
    toLocaleDateString(locales, opts) {
      return Date.prototype.toLocaleDateString.call(this, locales, withZone(opts));
    }
    toLocaleTimeString(locales, opts) {
      return Date.prototype.toLocaleTimeString.call(this, locales, withZone(opts));
    }
  }
  return ZonedDate;
}
