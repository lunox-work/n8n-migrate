// REST programs: node operations an app has no connector tool for, run against the app's own
// REST API with the person's stored credential, when one operation takes more than one
// request (a read decides what the write sends). step.rest = {program}; the n8n parameters
// stay in step.params and are read as n8n reads them. Every request goes through
// exec.request, so containment (allow.http, the secret's hosts), the effect ledger and the
// result log apply as to any http step; step.auth names the secret. The requests and their
// bodies follow the n8n node's own code (n8n-nodes-base 2.47), so a reviewer can diff them.

import { NodeError, isObject } from "./util.mjs";

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

function sheetsClient(exec) {
  const auth = exec.step.auth?.secret ? { credentialType: exec.step.auth.credentialType, secret: exec.step.auth.secret } : undefined;
  return async (method, path, { query, body } = {}) => {
    const req = { kind: "http", itemIndex: 0, method, url: SHEETS + path, query: query ?? {}, headers: {} };
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
  const api = sheetsClient(exec);
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

export const restPrograms = { googleSheets };
