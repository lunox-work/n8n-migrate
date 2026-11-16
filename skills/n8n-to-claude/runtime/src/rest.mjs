// REST programs: node operations an app has no connector tool for, run against the app's own
// REST API with the person's stored credential, when one operation takes more than one
// request (a read decides what the write sends) or the node builds its items from the answer
// itself (an RSS feed, image files). step.rest = {program}; the n8n parameters
// stay in step.params and are read as n8n reads them. Every request goes through
// exec.request, so containment (allow.http, the secret's hosts), the effect ledger and the
// result log apply as to any http step; step.auth names the secret. The requests and their
// bodies follow the n8n node's own code (n8n-nodes-base 2.47), so a reviewer can diff them.

import { NodeError, isObject } from "./util.mjs";
import { DateTime } from "../vendor/luxon.mjs";
import { parseFeed } from "./feed.mjs";
import { prepareBinary } from "./files.mjs";
import { base64ToBytes } from "./hash.mjs";

// ---------- Google Sheets v4 (n8n Google Sheets node v4.x, sheet: append | update | appendOrUpdate) ----------

const SHEETS = "https://sheets.googleapis.com";
const ROW_NUMBER = "row_number";
// n8n-workflow requestPath: each interpolated value is one path segment, percent-encoded,
// with : @ = , $ & left as they are.
const seg = (v) => encodeURIComponent(String(v)).replace(/%(?:3A|40|3D|2C|24|26)/g, decodeURIComponent);
const cellFormatDefault = (v) => (v < 4.1 ? "RAW" : "USER_ENTERED");
// encodeRange: a range with "!" is sent as is, a bare sheet title in single quotes.
const encodeRange = (range) => (range.includes("!") ? range : `'${range}'`);

function colName(n) {
  let s = "";
  do {
    n -= 1;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = (n / 26) >> 0;
  } while (n > 0);
  return s;
}
function colNumber(c) {
  let n = 0;
  for (const ch of c.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
const colWithOffset = (start, offset) => colName(colNumber(start) + offset);

function decodeRange(s) {
  const [name, range = ""] = s.split("!");
  const out = { name, range, start: {}, end: {} };
  const cell = (c) => {
    const m = /([a-zA-Z]{1,10})([0-9]{0,10})/.exec(c);
    return m ? { column: m[1], row: Number(m[2]) } : {};
  };
  if (range) {
    const [a, b] = range.split(":");
    if (a) out.start = cell(a);
    if (b) out.end = cell(b);
  }
  return out;
}

// The spreadsheet id from n8n's documentId resource locator (router.ts getSpreadsheetId).
function spreadsheetIdOf(exec, rl) {
  const mode = isObject(rl) ? rl.mode : "id";
  const value = isObject(rl) ? rl.value : rl;
  if (!value) throw new NodeError(`Can not get sheet '${mode}' with a value of '${value}'`, { node: exec.name });
  if (mode === "url") return /([-\w]{25,})/.exec(String(value))?.[0] ?? "";
  return String(value);
}
// The sheet from n8n's sheetName resource locator, as extractValue gives it.
function sheetRefOf(rl) {
  const mode = isObject(rl) ? rl.mode : "id";
  const value = String(isObject(rl) ? rl.value : rl ?? "");
  if (mode === "url") return { mode, value: /https:\/\/docs\.google\.com\/spreadsheets\/d\/[0-9a-zA-Z\-_]+.*#gid=([0-9]+)/.exec(value)?.[1] ?? value };
  if (mode === "id") return { mode, value: /((gid=)?[0-9]{1,})/.exec(value)?.[1] ?? value };
  return { mode, value };
}
const sheetIdOf = (v) => (v === "gid=0" ? 0 : parseInt(v, 10));

// One JSON request to a Google API with the step's stored credential; throws n8n's
// "<status> - <body>" NodeError on an HTTP error.
function googleClient(exec, base) {
  const auth = exec.step.auth?.secret ? { credentialType: exec.step.auth.credentialType, secret: exec.step.auth.secret } : undefined;
  return async (method, path, { query, body } = {}) => {
    const req = { kind: "http", itemIndex: 0, method, url: base + path, query: query ?? {}, headers: {} };
    if (body !== undefined) {
      req.body = body;
      req.contentType = "json";
    }
    if (auth) req.auth = auth;
    const [r] = await exec.request([req]);
    if (!r.ok) throw new NodeError(r.error?.message ?? "request failed", { node: exec.name });
    const v = r.value ?? {};
    const status = Number(v.status ?? 200);
    let b = v.body;
    if (typeof b === "string" && /^\s*[[{]/.test(b)) {
      try {
        b = JSON.parse(b);
      } catch {
        /* text */
      }
    }
    if (status >= 400) throw new NodeError(`${status} - ${typeof b === "string" ? b : JSON.stringify(b)}`, { node: exec.name, httpCode: String(status) });
    return b ?? {};
  };
}

function sheetHelper(exec, id) {
  const api = googleClient(exec, SHEETS);
  const h = {
    hint: undefined,
    async getData(range, valueRenderOption) {
      const r = await api("GET", `/v4/spreadsheets/${seg(id)}/values/${seg(encodeRange(range))}`, { query: { valueRenderOption, dateTimeRenderOption: "FORMATTED_STRING" } });
      return r.values;
    },
    async getSheet(ref) {
      const r = await api("GET", `/v4/spreadsheets/${seg(id)}`, { query: { fields: "sheets.properties" } });
      const found = (r.sheets ?? []).find((s) => (ref.mode === "name" ? s.properties?.title === ref.value : s.properties?.sheetId === sheetIdOf(ref.value)));
      if (!found?.properties?.title) throw new NodeError(`Sheet with ${ref.mode === "name" ? "name" : "ID"} ${ref.value} not found`, { node: exec.name });
      return found.properties;
    },
    async appendEmptyRows(sheetId, rows) {
      return api("POST", `/v4/spreadsheets/${seg(id)}:batchUpdate`, { body: { requests: [{ appendDimension: { sheetId, dimension: "ROWS", length: rows } }] } });
    },
    async batchUpdate(data, valueInputOption) {
      return api("POST", `/v4/spreadsheets/${seg(id)}/values:batchUpdate`, { body: { data, valueInputOption } });
    },
    async updateRows(sheetName, data, valueInputOption, row, rowsLength, useAppend) {
      const [name] = sheetName.split("!");
      const range = `${name}!${row}:${rowsLength ? row + rowsLength - 1 : row}`;
      const path = `/v4/spreadsheets/${seg(id)}/values/${seg(encodeRange(range))}`;
      return useAppend ? api("POST", `${path}:append`, { body: { range, values: data }, query: { valueInputOption } }) : api("PUT", path, { body: { range, values: data }, query: { valueInputOption } });
    },
    async toRows(inputData, range, keyRowIndex, columnNamesList, emptyValue = "") {
      const d = decodeRange(range);
      const header = columnNamesList ?? (h.hint !== undefined ? [h.hint] : undefined) ?? (await h.getData(`${d.name}!${keyRowIndex}:${keyRowIndex}`, "UNFORMATTED_VALUE"));
      h.hint = undefined;
      if (header === undefined) throw new NodeError("Could not retrieve the column data", { node: exec.name });
      const names = header ? header[0] : [];
      return inputData.map((item) =>
        names.map((key) => {
          const v = item[key];
          if (v === undefined || v === null) return emptyValue;
          return typeof v === "object" ? JSON.stringify(v) : v;
        }),
      );
    },
    async appendSheetData({ inputData, range, keyRowIndex, valueInputMode, columnNamesList, lastRow, useAppend }) {
      const data = await h.toRows(inputData, range, keyRowIndex, columnNamesList, useAppend ? null : "");
      const row = lastRow || ((await h.getData(range, "UNFORMATTED_VALUE")) || []).length + 1;
      return h.updateRows(range, data, valueInputMode, row, data.length, useAppend);
    },
    // Values of the key column below the header (getColumnValues with the sheet data at hand).
    columnValues(sheetData, keyIndex, dataStartRowIndex) {
      return sheetData
        .slice(dataStartRowIndex - 1)
        .map((row) => row[keyIndex])
        .splice(1)
        .flatMap((v) => v);
    },
    prepareUpdate({ inputData, indexKey, range, upsert, columnNames, columnValues, dataStartRowIndex }) {
      const d = decodeRange(range);
      const keyIndex = columnNames.indexOf(indexKey);
      if (keyIndex === -1 && !upsert) throw new NodeError(`Could not find column for key "${indexKey}"`, { node: exec.name });
      const updateData = [];
      const appendData = [];
      for (const item of inputData) {
        const key = item[indexKey];
        if (key === undefined || key === null) {
          if (upsert) appendData.push(item);
          continue;
        }
        const at = columnValues.findIndex((x) => x?.toString() === key.toString());
        if (at === -1) {
          if (upsert) appendData.push(item);
          continue;
        }
        const row = at + dataStartRowIndex + 1;
        for (const name of columnNames) {
          if (name === indexKey || item[name] === undefined || item[name] === null) continue;
          let value = item[name];
          if (typeof value === "object") value = JSON.stringify(value);
          updateData.push({ range: `${d.name}!${colWithOffset(d.start.column || "A", columnNames.indexOf(name))}${row}`, values: [[value]] });
        }
      }
      return { updateData, appendData };
    },
    prepareByRowNumber(inputData, range, columnNames) {
      const d = decodeRange(range);
      const updateData = [];
      for (const item of inputData) {
        for (const name of columnNames) {
          if (name === ROW_NUMBER || item[name] === undefined || item[name] === null) continue;
          let value = item[name];
          if (typeof value === "object") value = JSON.stringify(value);
          updateData.push({ range: `${d.name}!${colWithOffset(d.start.column || "A", columnNames.indexOf(name))}${item.row_number}`, values: [[value]] });
        }
      }
      return { updateData };
    },
  };
  return h;
}

function checkSchema(exec, columnNames, schema) {
  const live = new Set((columnNames ?? []).filter((c) => c !== ""));
  const cols = live.has(ROW_NUMBER) ? schema.map((s) => s.id) : schema.filter((s) => s.id !== ROW_NUMBER).map((s) => s.id);
  const missing = cols.filter((c) => !live.has(c));
  if (missing.length) throw new NodeError(`Column names were updated after the node's setup (missing columns: ${missing.join(", ")})`, { node: exec.name });
}

// autoMapInputData (GoogleSheets.utils.ts): item fields become columns; new ones are added to
// the header row first (handlingExtraData insertInNewColumn, the default).
async function autoMap(exec, sheet, sheetName, items, options, prefetched) {
  const out = [];
  const headerRow = options.locationDefine?.values ? parseInt(options.locationDefine.values.headerRow, 10) : 1;
  const extra = options.handlingExtraData || "insertInNewColumn";
  let columnNames = prefetched !== undefined ? prefetched : ((await sheet.getData(`${sheetName}!${headerRow}:${headerRow}`, "FORMATTED_VALUE")) ?? [])[0] ?? [];
  if (extra === "insertInNewColumn") {
    if (!columnNames.length) {
      await sheet.updateRows(sheetName, [Object.keys(items[0].json).filter((k) => k !== ROW_NUMBER)], options.cellFormat || "RAW", headerRow);
      columnNames = Object.keys(items[0].json);
    }
    const added = new Set();
    for (const item of items) {
      for (const k of Object.keys(item.json)) if (k !== ROW_NUMBER && !columnNames.includes(k)) added.add(k);
      if (item.json[ROW_NUMBER]) {
        const { [ROW_NUMBER]: _, ...rest } = item.json;
        out.push(rest);
      } else out.push(item.json);
    }
    if (added.size) {
      columnNames = columnNames.concat([...added]);
      await sheet.updateRows(sheetName, [columnNames], options.cellFormat || "RAW", headerRow);
    }
  }
  if (extra === "ignoreIt") for (const item of items) out.push(item.json);
  if (extra === "error")
    items.forEach((item, i) => {
      for (const k of Object.keys(item.json)) if (!columnNames.includes(k)) throw new NodeError("Unexpected fields in node input", { node: exec.name, itemIndex: i });
      out.push(item.json);
    });
  const hint = columnNames.filter((n) => n !== ROW_NUMBER);
  if (hint.length) sheet.hint = hint;
  return out;
}

async function sheetsAppend(exec, sheet, range, sheetId) {
  const items = exec.getInputData();
  const v = exec.typeVersion;
  let dataMode = exec.param("columns.mappingMode", 0, "defineBelow");
  if (!items.length || dataMode === "nothing") return [];
  const options = exec.param("options", 0, {});
  const keyRowIndex = options.locationDefine?.values?.headerRow ? Number(options.locationDefine.values.headerRow) : 1;
  const sheetData = await sheet.getData(range, "FORMATTED_VALUE");
  if (!sheetData?.length) dataMode = "autoMapInputData";
  const headerRow = sheetData?.[keyRowIndex - 1];
  if (v >= 4.4 && dataMode !== "autoMapInputData") {
    if (headerRow === undefined) throw new NodeError(`Could not retrieve the column names from row ${keyRowIndex}`, { node: exec.name });
    const schema = exec.param("columns.schema", 0, [], { rawExpressions: true });
    if (!Array.isArray(schema) || !schema.length) throw new NodeError("`columns.schema` is required when `columns.mappingMode` is `defineBelow`", { node: exec.name });
    checkSchema(exec, headerRow, schema);
  }
  let inputData;
  if (dataMode === "autoMapInputData") inputData = await autoMap(exec, sheet, range, items, options, headerRow ? headerRow : undefined);
  else {
    inputData = items.map((_, i) => {
      const m = exec.param("columns.value", i, {});
      if (!Object.keys(m).length) throw new NodeError("At least one value has to be added under 'Values to Send'", { node: exec.name });
      return m;
    });
    if (headerRow) sheet.hint = headerRow;
  }
  if (!inputData.length) return [];
  const valueInputMode = options.cellFormat || cellFormatDefault(v);
  if (options.useAppend) await sheet.appendSheetData({ inputData, range, keyRowIndex, valueInputMode, useAppend: true });
  else {
    await sheet.appendEmptyRows(sheetId, 1);
    await sheet.appendSheetData({ inputData, range, keyRowIndex, valueInputMode, lastRow: (sheetData ?? [{}]).length + 1 });
  }
  if (dataMode === "autoMapInputData") return items.map((it, i) => ({ json: it.json, pairedItem: { item: i } }));
  return inputData.map((json, i) => ({ json, pairedItem: { item: i } }));
}

// update and appendOrUpdate share most of n8n's code; `upsert` is appendOrUpdate.
async function sheetsUpdate(exec, sheet, sheetName, sheetId, upsert) {
  const items = exec.getInputData();
  const v = exec.typeVersion;
  const range = `${sheetName}!A:Z`;
  const options = exec.param("options", 0, {});
  const valueInputMode = options.cellFormat ?? cellFormatDefault(v);
  let keyRowIndex = 0;
  let dataStartRowIndex = 1;
  const loc = options.locationDefine?.values;
  if (loc?.headerRow) keyRowIndex = parseInt(loc.headerRow, 10) - 1;
  if (loc?.firstDataRow) dataStartRowIndex = parseInt(loc.firstDataRow, 10) - 1;
  let dataMode = exec.param("columns.mappingMode", 0, "defineBelow");
  const sheetData = (await sheet.getData(sheetName, "FORMATTED_VALUE")) ?? (upsert ? [] : undefined);
  if (!upsert && sheetData?.[keyRowIndex] === undefined) throw new NodeError(`Could not retrieve the column names from row ${keyRowIndex + 1}`, { node: exec.name });
  if (upsert && !sheetData[keyRowIndex] && dataMode !== "autoMapInputData") {
    if (!sheetData.length) dataMode = "autoMapInputData";
    else throw new NodeError(`Could not retrieve the column names from row ${keyRowIndex + 1}`, { node: exec.name });
  }
  let columnNames = sheetData[keyRowIndex] ?? [];
  if (upsert && v >= 4.4) checkSchema(exec, columnNames, exec.param("columns.schema", 0, [], { rawExpressions: true }));
  const matching = exec.param("columns.matchingColumns", 0, [], { rawExpressions: true });
  if (!Array.isArray(matching) || !matching.length) throw new NodeError(`\`columns.matchingColumns\` is required for the ${upsert ? "Append or Update Row" : "Update Row"} operation`, { node: exec.name });
  const keyIndex = columnNames.indexOf(matching[0]);
  const columnValues = sheet.columnValues(sheetData, keyIndex, dataStartRowIndex);
  const updateData = [];
  const appendData = [];
  const mapped = [];
  const newColumns = new Set();
  for (let i = 0; i < items.length; i++) {
    if (dataMode === "nothing") continue;
    const inputData = [];
    if (dataMode === "autoMapInputData") {
      const extra = options.handlingExtraData || "insertInNewColumn";
      if (extra === "error") for (const k of Object.keys(items[i].json)) if (!columnNames.includes(k)) throw new NodeError("Unexpected fields in node input", { node: exec.name, itemIndex: i });
      if (extra === "insertInNewColumn") for (const k of Object.keys(items[i].json)) if (!columnNames.includes(k) && k !== ROW_NUMBER) newColumns.add(k);
      inputData.push(items[i].json);
    } else {
      const match = exec.param(`columns.value`, i, {})[matching[0]] ?? "";
      if (match === "") throw new NodeError("The 'Column to Match On' parameter is required", { node: exec.name, itemIndex: i });
      const values = exec.param("columns.value", i, {});
      if (!Object.keys(values).length) throw new NodeError("At least one value has to be added under 'Values to Send'", { node: exec.name });
      for (const k of Object.keys(values)) {
        if (!upsert && k === ROW_NUMBER && values[k] === undefined && v >= 4.6) throw new NodeError("row_number is null or undefined", { node: exec.name });
        if (values[k] === undefined || values[k] === null) values[k] = "";
      }
      inputData.push(values);
      mapped.push(values);
    }
    if (newColumns.size) {
      const names = columnNames.concat([...newColumns]);
      await sheet.updateRows(sheetName, [names], options.cellFormat || cellFormatDefault(v), keyRowIndex + 1);
      columnNames = names;
      if (upsert) sheetData[keyRowIndex] = names;
      newColumns.clear();
    }
    const prepared = !upsert && matching[0] === ROW_NUMBER ? sheet.prepareByRowNumber(inputData, range, columnNames) : sheet.prepareUpdate({ inputData, indexKey: matching[0], range, upsert, columnNames, columnValues, dataStartRowIndex });
    updateData.push(...prepared.updateData);
    if (upsert) appendData.push(...prepared.appendData);
  }
  if (updateData.length) await sheet.batchUpdate(updateData, valueInputMode);
  if (upsert && appendData.length) {
    const lastRow = sheetData.length + 1;
    if (options.useAppend) await sheet.appendSheetData({ inputData: appendData, range, keyRowIndex: keyRowIndex + 1, valueInputMode, columnNamesList: [columnNames], lastRow, useAppend: true });
    else {
      await sheet.appendEmptyRows(sheetId, 1);
      await sheet.appendSheetData({ inputData: appendData, range, keyRowIndex: keyRowIndex + 1, valueInputMode, columnNamesList: [columnNames], lastRow });
    }
  }
  if (dataMode === "autoMapInputData") return items.map((it, i) => ({ json: it.json, pairedItem: { item: i } }));
  if (!upsert && !updateData.length) return [];
  return mapped.map((json, i) => ({ json, pairedItem: { item: i } }));
}

const googleSheets = {
  versions: (v) => v >= 4,
  operations: ["append", "update", "appendOrUpdate"],
  async execute(exec) {
    const operation = exec.param("operation", 0, "read", { rawExpressions: true });
    const resource = exec.param("resource", 0, "sheet", { rawExpressions: true });
    if (resource !== "sheet" || !googleSheets.operations.includes(operation)) throw new NodeError(`Google Sheets ${resource} ${operation} has no REST program`, { node: exec.name });
    try {
      const id = spreadsheetIdOf(exec, exec.param("documentId", 0));
      const sheet = sheetHelper(exec, id);
      const props = await sheet.getSheet(sheetRefOf(exec.param("sheetName", 0)));
      const sheetId = String(props.sheetId);
      const out = operation === "append" ? await sheetsAppend(exec, sheet, props.title, sheetId) : await sheetsUpdate(exec, sheet, props.title, sheetId, operation === "appendOrUpdate");
      return [out];
    } catch (e) {
      if (e?.name === "Suspend" || e?.name === "ContainmentViolation") throw e;
      if (exec.continueOnFail()) return [[{ json: exec.getInputData()[0]?.json ?? {}, error: { message: e.message } }]];
      throw e;
    }
  },
};

// ---------- Google Calendar v3 (n8n Google Calendar node v1–1.4, event: getAll | get | create | delete) ----------

const GOOGLE_API = "https://www.googleapis.com";
// n8n-workflow requestPath: toPathSegment refuses an empty value and "." / ".." segments.
function pathSeg(exec, v, itemIndex) {
  if (v === null || v === undefined) throw new NodeError("Invalid identifier: a value is required", { node: exec.name, itemIndex });
  const value = String(v);
  if (value === "" || /(^|[/\\])\.{1,2}([/\\]|$)/.test(value)) throw new NodeError(`Invalid identifier: "${value}" is not allowed`, { node: exec.name, itemIndex });
  return seg(value);
}
// decodePathValue: each run of %XX escapes is decoded once (calendar ids were stored encoded
// before node version 1.4).
const decodePathValue = (v) =>
  typeof v === "string"
    ? v.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
        try {
          return decodeURIComponent(run);
        } catch {
          return run;
        }
      })
    : v;
const rlValue = (v) => (isObject(v) && "__rl" in v ? v.value : v);
const dateObjectToISO = (v) => (DateTime.isDateTime(v) ? v.toISO() : v instanceof Date ? v.toISOString() : v);

// moment.tz(input, zone): an ISO 8601 string without an offset is wall time in `zone`, one with
// an offset (or Z) is that instant; anything else falls back to `new Date(input + " UTC")`, so
// it is read as UTC (moment's createFromInputFallback). Returns a luxon DateTime, or null for
// moment's invalid date.
const MOMENT_ISO = /^\s*(\d{4})-(\d\d)(?:-(\d\d))?(?:(?:T| )(\d\d)(?::(\d\d)(?::(\d\d)(?:[.,](\d+))?)?)?(\s*Z|[+-]\d\d(?::?\d\d)?)?)?$/;
function momentTz(input, zone) {
  if (DateTime.isDateTime(input)) return input.isValid ? input : null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : DateTime.fromJSDate(input);
  if (typeof input === "number") return DateTime.fromMillis(input);
  const text = String(input ?? "");
  const m = MOMENT_ISO.exec(text);
  if (m && !(m[3] === undefined && m[4] !== undefined)) {
    const [, y, mo, d = "01", h = "00", mi = "00", sec = "00", frac = "", off] = m;
    const ms = Number((frac + "000").slice(0, 3));
    const parts = { year: Number(y), month: Number(mo), day: Number(d), hour: Number(h), minute: Number(mi), second: Number(sec), millisecond: ms };
    let dt;
    if (off === undefined) dt = DateTime.fromObject(parts, { zone });
    else {
      const o = off.trim();
      const offset = o === "Z" ? "UTC" : `UTC${o.slice(0, 3)}:${o.length > 3 ? o.slice(-2) : "00"}`;
      dt = DateTime.fromObject(parts, { zone: offset });
    }
    return dt.isValid ? dt : null;
  }
  const fallback = new Date(`${text} UTC`);
  return Number.isNaN(fallback.getTime()) ? null : DateTime.fromJSDate(fallback);
}
// moment(...).utc().format() and .utc().format(fmt) with moment tokens YYYY MM DD HH mm ss.
const utcFormat = (dt, fmt = "yyyy-MM-dd'T'HH:mm:ss'Z'") => (dt ? dt.toUTC().toFormat(fmt) : "Invalid date");
// GenericFunctions addTimezoneToDate: a date that already ends in Z or +hh:mm is sent as is.
function addTimezoneToDate(date, zone) {
  const s = String(date);
  if (s.endsWith("Z") || /\+\d{2}:\d{2}$/.test(s)) return s;
  return utcFormat(momentTz(s, zone));
}
// GenericFunctions parseAttendees.
function parseAttendees(exec, attendees, itemIndex) {
  if (!Array.isArray(attendees) || !attendees.every((a) => typeof a === "string" && a.split(",").every((e) => e.trim().length > 0))) {
    throw new NodeError("Invalid attendee value", { node: exec.name, itemIndex, description: "Set each attendee to an email address string. To include multiple addresses in one entry, separate them with commas." });
  }
  return attendees.flatMap((a) => a.split(",").map((email) => ({ email: email.trim() })));
}
// utilities sortItemKeysByPriorityList (node version 1.3 and later).
const CALENDAR_KEYS = ["id", "summary", "start", "end", "attendees", "creator", "organizer", "description", "location", "created", "updated"];
function sortKeys(json) {
  const keys = Object.keys(json).sort((a, b) => {
    const ia = CALENDAR_KEYS.indexOf(a);
    const ib = CALENDAR_KEYS.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
  return Object.fromEntries(keys.map((k) => [k, json[k]]));
}
// helpers.returnJsonArray: a list gives one item per entry, an object one item.
const asItems = (data) => (Array.isArray(data) ? data : [data]).filter((json) => isObject(json));

const googleCalendar = {
  versions: (v) => v >= 1 && v <= 1.4,
  operations: ["getAll", "get", "create", "delete"],
  async execute(exec) {
    const items = exec.getInputData();
    const v = exec.typeVersion;
    const resource = exec.param("resource", 0, "event", { rawExpressions: true });
    const operation = exec.param("operation", 0, "create", { rawExpressions: true });
    if (resource !== "event" || !googleCalendar.operations.includes(operation)) throw new NodeError(`Google Calendar ${resource} ${operation} has no REST program`, { node: exec.name });
    const api = googleClient(exec, GOOGLE_API);
    const timezone = exec.run.timezone;
    // n8n keeps one query object for the whole run of the node, items included.
    const qs = {};
    const out = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const rawId = rlValue(exec.param("calendar", i, ""));
        const calendarId = pathSeg(exec, v < 1.4 ? decodePathValue(rawId) : rawId, i);
        let data;
        if (operation === "getAll") {
          const returnAll = exec.param("returnAll", i, false);
          const options = exec.param("options", i, {});
          const tz = rlValue(options.timeZone) || "";
          if (v >= 1.3) {
            const timeMin = dateObjectToISO(exec.param("timeMin", i, "={{ $now }}"));
            const timeMax = dateObjectToISO(exec.param("timeMax", i, "={{ $now.plus({ week: 1 }) }}"));
            if (timeMin) qs.timeMin = addTimezoneToDate(timeMin, tz || timezone);
            if (timeMax) qs.timeMax = addTimezoneToDate(timeMax, tz || timezone);
            if (!options.recurringEventHandling || options.recurringEventHandling === "expand") qs.singleEvents = true;
          }
          if (options.iCalUID) qs.iCalUID = options.iCalUID;
          if (options.maxAttendees) qs.maxAttendees = options.maxAttendees;
          if (options.orderBy) qs.orderBy = options.orderBy;
          if (options.query) qs.q = options.query;
          if (options.showDeleted) qs.showDeleted = options.showDeleted;
          if (options.showHiddenInvitations) qs.showHiddenInvitations = options.showHiddenInvitations;
          if (options.singleEvents) qs.singleEvents = options.singleEvents;
          if (options.timeMax) qs.timeMax = addTimezoneToDate(dateObjectToISO(options.timeMax), tz || timezone);
          if (options.timeMin) qs.timeMin = addTimezoneToDate(dateObjectToISO(options.timeMin), tz || timezone);
          if (tz) qs.timeZone = tz;
          if (options.updatedMin) qs.updatedMin = addTimezoneToDate(dateObjectToISO(options.updatedMin), tz || timezone);
          if (options.fields) qs.fields = options.fields;
          const path = `/calendar/v3/calendars/${calendarId}/events`;
          if (returnAll) {
            data = [];
            qs.maxResults = 100;
            let page;
            do {
              page = await api("GET", path, { query: { ...qs } });
              qs.pageToken = page.nextPageToken;
              if (qs.pageToken === undefined) delete qs.pageToken;
              data.push(...(Array.isArray(page.items) ? page.items : []));
            } while (page.nextPageToken !== undefined && page.nextPageToken !== "");
          } else {
            qs.maxResults = exec.param("limit", i, 50);
            data = (await api("GET", path, { query: { ...qs } })).items;
          }
          if (data) {
            if (v >= 1.3 && options.recurringEventHandling === "next" && data.some((e) => e?.recurrence)) throw new NodeError('Recurring Event Handling "next" (one more request per recurring event) has no REST program yet', { node: exec.name, itemIndex: i });
            if (v >= 1.3 && options.recurringEventHandling === "first") {
              data = data.filter((e) => !(qs.timeMin && e.recurrence && e.created && e.created < qs.timeMin) && !(qs.timeMax && e.recurrence && e.created && e.created > qs.timeMax));
            } else if (v < 1.3 && data.some((e) => Array.isArray(e?.recurrence) && e.recurrence.some((r) => String(r).toUpperCase().startsWith("RRULE")))) {
              // addNextOccurrence needs an RRULE engine (n8n uses the rrule package).
              throw new NodeError("the next occurrence of a recurring event (node version 1.2 and older) is not computed by the runtime", { node: exec.name, itemIndex: i });
            }
          }
        } else if (operation === "get") {
          const eventId = pathSeg(exec, exec.param("eventId", i), i);
          const options = exec.param("options", i, {});
          const tz = rlValue(options.timeZone) || "";
          if (options.maxAttendees) qs.maxAttendees = options.maxAttendees;
          if (tz) qs.timeZone = tz;
          data = await api("GET", `/calendar/v3/calendars/${calendarId}/events/${eventId}`, { query: { ...qs } });
          if (data) {
            if (v >= 1.3 && options.returnNextInstance && data.recurrence) throw new NodeError('"Return Next Instance of Recurring Event" (a second request for the instances) has no REST program yet', { node: exec.name, itemIndex: i });
            // addNextOccurrence needs an RRULE engine (n8n uses the rrule package).
            if (Array.isArray(data.recurrence) && data.recurrence.some((r) => String(r).toUpperCase().startsWith("RRULE"))) throw new NodeError("the next occurrence of a recurring event is not computed by the runtime", { node: exec.name, itemIndex: i });
            data = [data];
          }
        } else if (operation === "delete") {
          const eventId = pathSeg(exec, exec.param("eventId", i), i);
          const options = exec.param("options", i, {});
          if (options.sendUpdates) qs.sendUpdates = options.sendUpdates;
          // n8n sets sendUpdates on its query object but sends the delete without it.
          await api("DELETE", `/calendar/v3/calendars/${calendarId}/events/${eventId}`);
          data = { success: true };
        } else {
          const start = dateObjectToISO(exec.param("start", i, v >= 1.3 ? "={{ $now }}" : ""));
          const end = dateObjectToISO(exec.param("end", i, v >= 1.3 ? "={{ $now.plus(1, 'hour') }}" : ""));
          const useDefaultReminders = exec.param("useDefaultReminders", i, true);
          const f = exec.param("additionalFields", i, {});
          if (f.maxAttendees) qs.maxAttendees = f.maxAttendees;
          if (f.sendNotifications) qs.sendNotifications = f.sendNotifications;
          if (f.sendUpdates) qs.sendUpdates = f.sendUpdates;
          const body = {
            start: { dateTime: utcFormat(momentTz(start, timezone)), timeZone: timezone },
            end: { dateTime: utcFormat(momentTz(end, timezone)), timeZone: timezone },
          };
          if (f.attendees) body.attendees = parseAttendees(exec, f.attendees, i);
          if (f.color) body.colorId = f.color;
          if (f.description) body.description = f.description;
          if (f.guestsCanInviteOthers) body.guestsCanInviteOthers = f.guestsCanInviteOthers;
          if (f.guestsCanModify) body.guestsCanModify = f.guestsCanModify;
          if (f.guestsCanSeeOtherGuests) body.guestsCanSeeOtherGuests = f.guestsCanSeeOtherGuests;
          if (f.id) body.id = f.id;
          if (f.location) body.location = f.location;
          if (f.summary) body.summary = f.summary;
          if (f.showMeAs) body.transparency = f.showMeAs;
          if (f.visibility) body.visibility = f.visibility;
          if (!useDefaultReminders) {
            const reminders = exec.param("remindersUi", i, {}).remindersValues;
            body.reminders = { useDefault: false };
            if (reminders) body.reminders.overrides = reminders;
          }
          if (f.allday === "yes") {
            body.start = { date: momentTz(start, timezone)?.setZone(timezone).toFormat("yyyy-MM-dd") ?? "Invalid date" };
            body.end = { date: momentTz(end, timezone)?.setZone(timezone).toFormat("yyyy-MM-dd") ?? "Invalid date" };
          }
          body.recurrence = [];
          if (f.rrule) body.recurrence = [`RRULE:${f.rrule}`];
          else {
            if (f.repeatHowManyTimes && f.repeatUntil) throw new NodeError("You can set either 'Repeat How Many Times' or 'Repeat Until' but not both", { node: exec.name, itemIndex: i });
            if (f.repeatFrecuency) body.recurrence.push(`FREQ=${String(f.repeatFrecuency).toUpperCase()};`);
            if (f.repeatHowManyTimes) body.recurrence.push(`COUNT=${f.repeatHowManyTimes};`);
            if (f.repeatUntil) body.recurrence.push(`UNTIL=${utcFormat(momentTz(dateObjectToISO(f.repeatUntil), "UTC"), "yyyyMMdd'T'HHmmss")}Z`);
            if (body.recurrence.length) body.recurrence = [`RRULE:${body.recurrence.join("")}`];
          }
          if (f.conferenceDataUi?.conferenceDataValues) {
            qs.conferenceDataVersion = 1;
            body.conferenceData = { createRequest: { requestId: globalThis.crypto.randomUUID(), conferenceSolution: { type: f.conferenceDataUi.conferenceDataValues.conferenceSolution } } };
          }
          data = await api("POST", `/calendar/v3/calendars/${calendarId}/events`, { body, query: { ...qs } });
        }
        for (const json of asItems(data ?? [])) out.push({ json, pairedItem: { item: i } });
      } catch (e) {
        if (e?.name === "Suspend" || e?.name === "ContainmentViolation") throw e;
        if (!exec.continueOnFail()) throw e;
        out.push({ json: { error: e.message }, pairedItem: { item: i } });
      }
    }
    return [v >= 1.3 ? out.map((it) => ({ ...it, json: sortKeys(it.json) })) : out];
  },
};

// ---------- RSS Read (n8n RSS Read node v1–1.2, also as an agent tool) ----------
//
// n8n-nodes-base 2.47 RssFeedRead.node.ts + GenericFunctions.ts parseFeedUrl: per item (v1:
// the first only) a GET of the URL with rss-parser's User-Agent and an Accept header (v1.2:
// the relaxed list), the text parsed by rss-parser (feed.mjs), one item per feed entry. No
// credential. The URL's host must be in allow.http like any request (convert.mjs applyRss).

const RSS_HEADERS = { "User-Agent": "rss-parser", Accept: "application/rss+xml" };
const RSS_RELAXED_ACCEPT = "application/rss+xml, application/rdf+xml;q=0.8, application/atom+xml;q=0.6, application/xml;q=0.4, text/xml;q=0.4";
const validUrl = (u) => {
  try {
    new URL(u);
    return true;
  } catch {
    return false;
  }
};

const rssFeedRead = {
  versions: (v) => v >= 1 && v <= 1.2,
  async execute(exec) {
    const items = exec.getInputData();
    const v = exec.typeVersion;
    const count = v >= 1.1 ? items.length : items.length ? 1 : 0;
    const out = [];
    for (let i = 0; i < count; i++) {
      const paired = v >= 1.1 ? [{ item: i }] : items.map((_, k) => ({ item: k }));
      try {
        const url = exec.param("url", i, "");
        const options = exec.param("options", i, {}) ?? {};
        if (!url) throw new NodeError('The parameter "URL" has to be set!', { node: exec.name, itemIndex: i });
        if (!validUrl(url)) throw new NodeError('The provided "URL" is not valid!', { node: exec.name, itemIndex: i });
        const headers = { ...RSS_HEADERS, ...(v >= 1.2 ? { Accept: RSS_RELAXED_ACCEPT } : {}) };
        const [r] = await exec.request([{ kind: "http", itemIndex: i, method: "GET", url: String(url), query: {}, headers }]);
        if (!r.ok) throw new NodeError(r.error?.message ?? "request failed", { node: exec.name, itemIndex: i });
        const status = Number(r.value?.status ?? 200);
        if (status >= 400) throw new NodeError(`Request failed with status code ${status}`, { node: exec.name, itemIndex: i, httpCode: String(status) });
        const body = r.value?.body;
        const text = typeof body === "string" ? body : body === undefined || body === null ? "" : typeof body === "object" ? JSON.stringify(body) : String(body);
        const custom = typeof options.customFields === "string" && options.customFields ? options.customFields.split(",").map((f) => f.trim()) : [];
        let feed;
        try {
          feed = parseFeed(text, { customItemFields: custom });
        } catch (e) {
          throw new NodeError(e?.message ?? String(e), { node: exec.name, itemIndex: i });
        }
        if (feed.items) for (const it of feed.items) out.push({ json: it, pairedItem: paired.length === 1 ? paired[0] : paired });
      } catch (e) {
        if (e?.name === "Suspend" || e?.name === "ContainmentViolation") throw e;
        if (exec.continueOnFail()) {
          out.push({ json: { error: e.message }, pairedItem: paired.length === 1 ? paired[0] : paired });
          continue;
        }
        throw e;
      }
    }
    return [out];
  },
};

// ---------- OpenAI image generation (legacy OpenAI node v1 image:create; OpenAI v1.x image:generate) ----------
// POST /v1/images/generations with the person's OpenAI key (the same service, through the
// original provider, as n8n calls it), the body each node builds (n8n-nodes-base OpenAi
// ImageDescription, declarative routing; @n8n/n8n-nodes-langchain vendors/OpenAi/v1
// image/generate), and the items each node makes of the answer: a binary item per image
// (b64_json through prepareBinaryData with the path "data", so the type comes from the bytes),
// or the JSON entries when image URLs are asked for.

const OPENAI = "https://api.openai.com/v1";

async function imagesRequest(exec, i, body) {
  const req = { kind: "http", itemIndex: i, method: "POST", url: `${OPENAI}/images/generations`, query: {}, headers: {}, body, contentType: "json" };
  if (exec.step.auth?.secret) req.auth = { credentialType: exec.step.auth.credentialType, secret: exec.step.auth.secret };
  const [r] = await exec.request([req]);
  if (!r.ok) throw new NodeError(r.error?.message ?? "request failed", { node: exec.name, itemIndex: i });
  const v = r.value ?? {};
  let b = v.body;
  if (typeof b === "string" && /^\s*[[{]/.test(b)) {
    try {
      b = JSON.parse(b);
    } catch {
      /* text */
    }
  }
  const status = Number(v.status ?? 200);
  if (status >= 400) throw new NodeError(`${status} - ${typeof b === "string" ? b : JSON.stringify(b)}`, { node: exec.name, itemIndex: i, httpCode: String(status) });
  return isObject(b) ? b : {};
}

// Legacy node v1, declarative routing: displayed top-level parameters are sent with their
// defaults (prompt, model "dall-e-2", response_format from responseFormat "binaryData");
// options only when set and shown for the model (n, size for dall-e-2 and dall-e-3; quality
// and style for dall-e-3).
async function legacyImage(exec, i) {
  const model = exec.param("model", i, "dall-e-2");
  const format = exec.param("responseFormat", i, "binaryData");
  const o = exec.param("options", i, {});
  const body = { prompt: exec.param("prompt", i, ""), model, response_format: format === "imageUrl" ? "url" : "b64_json" };
  if (o.n !== undefined) body.n = o.n;
  if (o.quality !== undefined && model === "dall-e-3") body.quality = o.quality;
  if (o.size !== undefined && (model === "dall-e-2" || model === "dall-e-3")) body.size = o.size;
  if (o.style !== undefined && model === "dall-e-3") body.style = o.style;
  const data = (await imagesRequest(exec, i, body)).data ?? [];
  if (format === "imageUrl") return data.map((json) => ({ json, pairedItem: { item: i } }));
  return data.map((e) => ({ json: {}, binary: { data: prepareBinary(base64ToBytes(String(e?.b64_json ?? "")), "data") }, pairedItem: { item: i } }));
}

// OpenAI node v1.x image:generate.
async function langchainImage(exec, i) {
  const model = exec.param("model", i, "dall-e-3");
  const prompt = String(exec.param("prompt", i, ""));
  if (!prompt.trim()) throw new NodeError("A non-empty prompt is required.", { node: exec.name, itemIndex: i });
  const options = { ...exec.param("options", i, {}) };
  const asUrl = !!options.returnImageUrls;
  const prop = options.binaryPropertyOutput || "data";
  delete options.binaryPropertyOutput;
  if (options.dalleQuality) {
    options.quality = options.dalleQuality;
    delete options.dalleQuality;
  }
  delete options.returnImageUrls;
  const body = { prompt, model, ...(model !== "gpt-image-1" ? { response_format: asUrl ? "url" : "b64_json" } : {}), ...options };
  const data = (await imagesRequest(exec, i, body)).data ?? [];
  if (asUrl) return data.map((json) => ({ json, pairedItem: { item: i } }));
  return data.map((e) => {
    const bin = prepareBinary(base64ToBytes(String(e?.b64_json ?? "")), "data");
    const { data: _, ...meta } = bin;
    return { json: meta, binary: { [prop]: bin }, pairedItem: { item: i } };
  });
}

const openAiImage = {
  versions: () => true,
  async execute(exec) {
    const legacy = exec.step.n8n?.type === "n8n-nodes-base.openAi";
    const out = [];
    const items = exec.getInputData();
    for (let i = 0; i < items.length; i++) {
      try {
        out.push(...(legacy ? await legacyImage(exec, i) : await langchainImage(exec, i)));
      } catch (e) {
        if (e?.name === "Suspend" || e?.name === "ContainmentViolation") throw e;
        if (exec.continueOnFail()) {
          out.push({ json: { error: e.message }, pairedItem: { item: i } });
          continue;
        }
        throw e;
      }
    }
    return [out];
  },
};

// ---------- Facebook Graph API (n8n-nodes-base.facebookGraphApi v1, v1.1) ----------
// n8n-nodes-base 2.47.7 FacebookGraphApi.node.js, per item: the access token (credential
// facebookGraphApi) as query `access_token` first, then `fields` (options.fields.field names,
// comma-joined), then each options.queryParameters.parameter name/value, then the keys of
// options.queryParametersJson (when it parses); `https://<hostUrl>/<graphApiVersion>/<node>[/<edge>]`
// with each path value encoded as n8n-workflow requestPath encodes a segment (v1 decodes an
// already-encoded value first); the method as set; the JSON answer is the item. A text answer
// fails with n8n's message. The token goes in the URL (placement url) to graph.facebook.com and
// graph-video.facebook.com only.
const GRAPH_HOSTS = ["graph.facebook.com", "graph-video.facebook.com"];
const SEGMENT_KEEP = /%(?:21|24|26|27|28|29|2A|2B|2C|3B|3D|3A|40)/gi;
function graphSegment(v, decodeFirst) {
  let s = String(v);
  if (decodeFirst) {
    try {
      s = decodeURIComponent(s);
    } catch {
      /* keep it */
    }
  }
  return encodeURIComponent(s).replace(SEGMENT_KEEP, decodeURIComponent);
}
const facebookGraph = {
  versions: () => true,
  async execute(exec) {
    const out = [];
    const items = exec.getInputData();
    const v1 = Number(exec.step.n8n?.typeVersion ?? 1) < 1.1;
    for (let i = 0; i < items.length; i++) {
      try {
        if (exec.param("authType", i, "accessToken") !== "accessToken") throw new NodeError("Facebook Graph API with OAuth2 is not carried over; use an access token credential", { node: exec.name, itemIndex: i });
        if (exec.param("sendBinaryData", i, false)) throw new NodeError("Facebook Graph API binary uploads are not carried over", { node: exec.name, itemIndex: i });
        const hostUrl = String(exec.param("hostUrl", i, "graph.facebook.com"));
        if (!GRAPH_HOSTS.includes(hostUrl)) throw new NodeError(`The Host URL "${hostUrl}" is not supported`, { node: exec.name, itemIndex: i });
        const method = String(exec.param("httpRequestMethod", i, "GET")).toUpperCase();
        const version = String(exec.param("graphApiVersion", i, "") ?? "");
        const node = String(exec.param("node", i, ""));
        const edge = String(exec.param("edge", i, "") ?? "");
        const o = exec.param("options", i, {}) ?? {};
        let path = version ? `/${graphSegment(version, false)}` : "";
        for (const part of node.split("/")) path += part ? `/${graphSegment(part, v1)}` : "/";
        if (edge) path += `/${graphSegment(edge, v1)}`;
        const query = {};
        if (o.fields?.field !== undefined) query.fields = [].concat(o.fields.field).map((f) => f?.name).join(",");
        for (const p of [].concat(o.queryParameters?.parameter ?? [])) if (p && p.name !== undefined) query[p.name] = p.value;
        if (o.queryParametersJson) {
          try {
            Object.assign(query, JSON.parse(o.queryParametersJson));
          } catch {
            /* n8n ignores JSON it cannot read */
          }
        }
        const req = { kind: "http", itemIndex: i, method, url: `https://${hostUrl}${path}?access_token={{secret}}`, query, headers: { accept: "application/json,text/*;q=0.99" } };
        if (exec.step.auth?.secret) req.auth = { credentialType: exec.step.auth.credentialType, secret: exec.step.auth.secret, placement: "url" };
        const [r] = await exec.request([req]);
        if (!r.ok) throw new NodeError(r.error?.message ?? "request failed", { node: exec.name, itemIndex: i });
        const val = r.value ?? {};
        let b = val.body;
        if (typeof b === "string" && /^\s*[[{]/.test(b)) {
          try {
            b = JSON.parse(b);
          } catch {
            /* text */
          }
        }
        const status = Number(val.status ?? 200);
        if (status >= 400) throw new NodeError(`${status} - ${typeof b === "string" ? b : JSON.stringify(b)}`, { node: exec.name, itemIndex: i, httpCode: String(status) });
        if (typeof b === "string") throw new NodeError("Response body is not valid JSON.", { node: exec.name, itemIndex: i });
        out.push({ json: b ?? {}, pairedItem: { item: i } });
      } catch (e) {
        if (e?.name === "Suspend" || e?.name === "ContainmentViolation") throw e;
        if (exec.continueOnFail()) {
          out.push({ json: { error: e.message }, pairedItem: { item: i } });
          continue;
        }
        throw e;
      }
    }
    return [out];
  },
};

// ---------- Discord webhook message (n8n-nodes-base.discord v1) ----------
// n8n-nodes-base 2.47.7 Discord/v1/DiscordV1.node.js, per item: POST to the node's webhookUri
// (the webhook's own URL, which carries its token, as the node parameter holds it) with JSON
// {content: text, embeds (options.embeds, a JSON list), username, components (JSON),
// avatar_url (options.avatarUrl), flags, tts, payload_json (JSON), attachments (JSON)}, each
// sent only when truthy; neither content nor embeds is n8n's error. allowedMentions is never
// sent (n8n reads options.allowed_mentions, which the form never sets). A payload_json switches
// n8n to a multipart body, not carried over. The item is {success: true}. n8n's waits on
// Discord's rate-limit headers are not repeated, and the body goes as application/json without
// n8n's charset parameter.
function jsonOption(exec, i, v, what) {
  try {
    return JSON.parse(v);
  } catch {
    throw new NodeError(`${what} must be valid JSON.`, { node: exec.name, itemIndex: i });
  }
}
const discordWebhookV1 = {
  versions: () => true,
  async execute(exec) {
    const out = [];
    const items = exec.getInputData();
    if (!exec.param("webhookUri", 0, "")) throw new NodeError("Webhook uri is required.", { node: exec.name });
    for (let i = 0; i < items.length; i++) {
      try {
        const url = String(exec.param("webhookUri", i, ""));
        const o = exec.param("options", i, {}) ?? {};
        const body = { content: exec.param("text", i, "") };
        if (!body.content && !o.embeds) throw new NodeError("Either content or embeds must be set.", { node: exec.name, itemIndex: i });
        if (o.embeds) {
          body.embeds = jsonOption(exec, i, o.embeds, "Embeds");
          if (!Array.isArray(body.embeds)) throw new NodeError("Embeds must be valid JSON.", { node: exec.name, itemIndex: i });
        }
        if (o.username) body.username = o.username;
        if (o.components) body.components = jsonOption(exec, i, o.components, "Components");
        if (o.avatarUrl) body.avatar_url = o.avatarUrl;
        if (o.flags) body.flags = o.flags;
        if (o.tts) body.tts = o.tts;
        if (o.payloadJson) throw new NodeError("a Discord payload JSON (a multipart message) is not carried over", { node: exec.name, itemIndex: i });
        if (o.attachments) body.attachments = jsonOption(exec, i, o.attachments, "Attachments");
        for (const k of ["content", "username", "avatar_url", "embeds", "flags", "components", "attachments"]) if (!body[k]) delete body[k];
        const [r] = await exec.request([{ kind: "http", itemIndex: i, method: "POST", url, query: {}, headers: {}, body, contentType: "json" }]);
        if (!r.ok) throw new NodeError(r.error?.message ?? "request failed", { node: exec.name, itemIndex: i });
        const status = Number(r.value?.status ?? 200);
        if (status >= 400) {
          const b = r.value?.body;
          throw new NodeError(`${status} - ${typeof b === "string" ? b : JSON.stringify(b)}`, { node: exec.name, itemIndex: i, httpCode: String(status) });
        }
        out.push({ json: { success: true }, pairedItem: { item: i } });
      } catch (e) {
        if (e?.name === "Suspend" || e?.name === "ContainmentViolation") throw e;
        if (exec.continueOnFail()) {
          out.push({ json: { error: e.message }, pairedItem: { item: i } });
          continue;
        }
        throw e;
      }
    }
    return [out];
  },
};

// ---------- Wikipedia (agent tool; @n8n/n8n-nodes-langchain ToolWikipedia v1) ----------
//
// n8n runs LangChain's WikipediaQueryRun (@langchain/community 1.1.27, MIT) with its defaults:
// a search GET of https://en.wikipedia.org/w/api.php (action=query, list=search, srsearch,
// format=json, as URLSearchParams writes them), then for each of the first 3 results a GET with
// prop=extracts, explaintext=true, redirects=1, titles=<title>; each page with details adds
// "Page: <title>\nSummary: <extract>"; the summaries joined by a blank line and cut to 4000
// characters, or "No good Wikipedia Search Result was found". A non-2xx answer throws "Network
// response was not ok" (fetch's ok), JSON that does not parse throws the parser's error. The
// tool is a LangChain Tool: its input is the model's `input` argument (undefined when absent,
// which URLSearchParams writes as "undefined"). Ported from the library's _call,
// _fetchSearchResults and _fetchPage; requests go through exec.request like any other.
const WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php";
async function wikipediaGet(exec, params) {
  const [r] = await exec.request([{ kind: "http", itemIndex: 0, method: "GET", url: `${WIKIPEDIA_API}?${new URLSearchParams(params).toString()}`, query: {}, headers: {} }]);
  if (!r.ok) throw new Error(r.error?.message ?? "fetch failed");
  const status = Number(r.value?.status ?? 200);
  if (status < 200 || status > 299) throw new Error("Network response was not ok");
  const body = r.value?.body;
  return typeof body === "string" ? JSON.parse(body) : body;
}
const wikipedia = {
  versions: (v) => v === 1,
  async execute(exec) {
    const query = exec.toolInput?.input;
    const search = await wikipediaGet(exec, { action: "query", list: "search", srsearch: `${query}`, format: "json" });
    const summaries = [];
    for (let i = 0; i < Math.min(3, search.query.search.length); i += 1) {
      const page = search.query.search[i].title;
      const { pages } = (await wikipediaGet(exec, { action: "query", prop: "extracts", explaintext: "true", redirects: "1", format: "json", titles: page })).query;
      const details = pages[Object.keys(pages)[0]];
      if (details) summaries.push(`Page: ${page}\nSummary: ${details.extract}`);
    }
    const text = summaries.length === 0 ? "No good Wikipedia Search Result was found" : summaries.join("\n\n").slice(0, 4000);
    return [[{ json: text }]];
  },
};

export const restPrograms = { googleSheets, googleCalendar, rssFeedRead, openAiImage, facebookGraph, discordWebhookV1, wikipedia };
