// File steps (the files lever), as n8n-nodes-base 2.47.7 runs them: Extract From File, Convert
// To File, Spreadsheet File (v1, v2), Read/Write Files from Disk, Read Binary File(s), Write
// Binary File. Binary data is n8n's in-memory form: item.binary[prop] = {mimeType, fileType,
// fileExtension, data (base64), directory?, fileName?, fileSize, bytes}, built as n8n-core's
// prepareBinaryData builds it (prepareBinary below).
//
// Libraries: n8n reads PDF text with pdf.js and reads and writes spreadsheets with SheetJS. A
// re-implementation would differ in the details a model or a file comparison sees (pdf.js's
// text item order, SheetJS's General number format and its CSV byte order mark), so the
// runtime loads the same versions, vendored unmodified under runtime/vendor (pdfjs-dist
// 6.3.289, @e965/xlsx 0.20.3; Apache-2.0, see their SOURCE.txt). They are loaded on first use
// with import() relative to this module, from runtime/vendor in a migrated folder (convert.mjs
// copies them there only when the definition has such a step) or in the skill. The core stays
// browser-safe: nothing here imports node:. The artifact page cannot load them (preflight
// refuses such a step on that surface, files.lib).
//
// Disk: reading and writing local files goes through the host as a `file` request ({op:
// "read"|"write", path, ...}); the task driver answers it on a local task only, and preflight
// refuses a disk step on a cloud task or the artifact (files.disk). Paths are checked against
// definition.allow.files (engine.mjs checkContainment): the directories written in the steps.
//
// Not implemented, each refused by the converter with its reason: Extract From File csv (n8n
// parses with csv-parse), html, rtf, xml, ics; Convert To File iCal; Spreadsheet File v2 CSV
// reading; Compression; Edit Image (GraphicsMagick). Stated limits: text decoding when no
// encoding is set (n8n guesses with chardet) treats valid UTF-8 as UTF-8 and anything else as
// Latin-1; text encodings are UTF-8, ASCII, Latin-1 and UTF-16LE; MIME types come from a table
// of common extensions (n8n uses mime-types 3.0.2), and a file without a name or type is
// recognised by its first bytes only for PDF, PNG, JPEG, GIF, WebP and zip (xlsx, docx).

import { NodeError, UnsupportedNode, deepCopy, getPath, setPath, unsetPath, isObject } from "./util.mjs";
import { bytesToBase64, base64ToBytes, utf8Bytes } from "./hash.mjs";

const BASE = "n8n-nodes-base.";
const err = (exec, message, extra = {}) => new NodeError(message, { node: exec.name, ...extra });
const unsupported = (exec, what) => new UnsupportedNode(`${what} is not supported by the runtime`, { node: exec.name });
const inRange = (lo, hi) => (v) => v >= lo && v <= hi;

// ---------- MIME types (mime-types 3.0.2, common entries) ----------

const MIME_BY_EXT = {
  txt: "text/plain", text: "text/plain", csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json", pdf: "application/pdf", xml: "application/xml",
  html: "text/html", htm: "text/html", md: "text/markdown", markdown: "text/markdown", yaml: "text/yaml", yml: "text/yaml", ics: "text/calendar", js: "text/javascript", mjs: "text/javascript", css: "text/css",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xls: "application/vnd.ms-excel", ods: "application/vnd.oasis.opendocument.spreadsheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", doc: "application/msword", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", rtf: "application/rtf", epub: "application/epub+zip",
  zip: "application/zip", gz: "application/gzip", tar: "application/x-tar", bin: "application/octet-stream",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", ico: "image/vnd.microsoft.icon", heic: "image/heic",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/x-flac",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", avi: "video/x-msvideo",
};
const EXT_BY_MIME = {
  "text/plain": "txt", "text/csv": "csv", "text/tab-separated-values": "tsv", "application/json": "json", "application/pdf": "pdf", "application/xml": "xml", "text/xml": "xml",
  "text/html": "html", "text/markdown": "md", "text/calendar": "ics", "application/javascript": "js", "text/javascript": "js", "text/css": "css",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx", "application/vnd.ms-excel": "xls", "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx", "application/msword": "doc", "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx", "application/rtf": "rtf", "text/rtf": "rtf", "application/epub+zip": "epub",
  "application/zip": "zip", "application/gzip": "gz", "application/x-tar": "tar", "application/octet-stream": "bin",
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/bmp": "bmp", "image/tiff": "tif", "image/heic": "heic",
  "audio/mpeg": "mpga", "audio/wav": "wav", "audio/wave": "wav", "audio/x-wav": "wav", "audio/ogg": "oga", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/webm": "weba",
  "video/mp4": "mp4", "video/quicktime": "qt", "video/webm": "webm", "video/x-msvideo": "avi",
};
export const mimeLookup = (path) => MIME_BY_EXT[String(path ?? "").split(/[\\/]/).pop().split(".").pop().toLowerCase()] ?? false;
export const mimeExtension = (type) => EXT_BY_MIME[String(type ?? "").split(";")[0].trim().toLowerCase()] ?? false;

// n8n-workflow fileTypeFromMimeType.
export function fileTypeFromMimeType(m) {
  if (m.startsWith("application/json")) return "json";
  if (m.startsWith("text/html")) return "html";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("text/") || m.startsWith("application/javascript")) return "text";
  if (m.startsWith("application/pdf")) return "pdf";
  return undefined;
}

// pretty-bytes 5.6.0 with no options: "999 B", "1.66 kB", "12.3 MB".
export function prettyBytes(n) {
  if (!Number.isFinite(n)) throw new TypeError(`Expected a finite number, got ${typeof n}: ${n}`);
  const neg = n < 0;
  const pre = neg ? "-" : "";
  if (neg) n = -n;
  if (n < 1) return `${pre}${n} B`;
  const units = ["B", "kB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
  const e = Math.min(Math.floor(Math.log10(n) / 3), units.length - 1);
  return `${pre}${Number((n / 1000 ** e).toPrecision(3))} ${units[e]}`;
}

// The first bytes of a file (file-type's most common signatures).
function sniff(bytes) {
  const b = bytes;
  const at = (i, ...xs) => xs.every((x, k) => b[i + k] === x);
  if (at(0, 0x25, 0x50, 0x44, 0x46, 0x2d)) return { mime: "application/pdf", ext: "pdf" };
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { mime: "image/png", ext: "png" };
  if (at(0, 0xff, 0xd8, 0xff)) return { mime: "image/jpeg", ext: "jpg" };
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return { mime: "image/gif", ext: "gif" };
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return { mime: "image/webp", ext: "webp" };
  if (at(0, 0x50, 0x4b, 0x03, 0x04)) {
    const head = String.fromCharCode(...b.slice(0, Math.min(b.length, 4096)));
    if (head.includes("xl/")) return { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" };
    if (head.includes("word/")) return { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" };
    return { mime: "application/zip", ext: "zip" };
  }
  return null;
}

// path.parse (POSIX) for what prepareBinaryData reads: dir, base, ext.
function parsePath(p) {
  const s = String(p);
  const slash = s.lastIndexOf("/");
  const dir = slash > 0 ? s.slice(0, slash) : slash === 0 ? "/" : "";
  const base = s.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  return { dir, base, ext: dot > 0 ? base.slice(dot) : "" };
}

// n8n-core prepareBinaryData for a buffer (bytes), as its in-memory binary data mode stores it.
// opts.stream: the bytes came from a stream (a file read), which n8n never sniffs.
export function prepareBinary(bytes, filePath, mimeType, { stream = false, url } = {}) {
  let fileExtension;
  if (!mimeType && filePath) mimeType = mimeLookup(filePath) || undefined;
  if (!mimeType && !stream) {
    const s = sniff(bytes);
    if (s) (mimeType = s.mime), (fileExtension = s.ext);
  }
  if (!fileExtension && mimeType) fileExtension = mimeExtension(mimeType) || undefined;
  if (!mimeType) mimeType = "text/plain";
  const out = { mimeType, fileType: fileTypeFromMimeType(mimeType), fileExtension, data: "" };
  if (filePath) {
    const p = parsePath(filePath);
    if (url) out.directory = url;
    else if (p.dir !== "") out.directory = p.dir;
    out.fileName = p.base;
    if (p.ext.slice(1)) out.fileExtension = p.ext.slice(1);
  }
  out.data = bytesToBase64(bytes);
  out.fileSize = prettyBytes(bytes.length);
  out.bytes = bytes.length;
  if (out.fileType === undefined) delete out.fileType;
  if (out.fileExtension === undefined) delete out.fileExtension;
  return out;
}

// assertBinaryData + getBinaryDataBuffer: the bytes of item i's binary property.
export function binaryOf(exec, i, prop) {
  const item = exec.getInputData()[i];
  const b = item?.binary?.[prop];
  if (!item?.binary) throw err(exec, "No binary data exists on item!", { itemIndex: i });
  if (!b) throw err(exec, `This operation expects the node's input data to contain a binary file '${prop}', but none was found [item ${i}]`, { itemIndex: i });
  if (typeof b.data !== "string" || b.id) throw unsupported(exec, "binary data kept in n8n's binary store (binary.id)");
  return { meta: b, bytes: base64ToBytes(b.data) };
}

// A connector download whose file n8n puts into binary data (step.tool.binary, e.g. Google
// Drive's download): the item keeps its input json and binary, and binary[property] is the
// tool's base64 content, named and typed from the result (n8n: the response's content type,
// else the file's; options.fileName, else the file's name).
export function binaryFromTool(exec, results, items, spec) {
  const out = [];
  results.forEach((r, i) => {
    try {
      if (!r.ok) throw err(exec, r.error?.message ?? "tool call failed", { itemIndex: i });
      let v = r.value;
      if (typeof v === "string") {
        try {
          v = JSON.parse(v);
        } catch {}
      }
      const content = isObject(v) ? getPath(v, spec.content) : undefined;
      if (typeof content !== "string") throw err(exec, `the tool returned no file content (${spec.content})`, { itemIndex: i });
      const prop = String(exec.evaluate(spec.property ?? "data", i) || "data");
      const fileName = spec.fileName !== undefined ? exec.evaluate(spec.fileName, i) : getPath(v, spec.name ?? "name");
      const mime = spec.mimeType ? getPath(v, spec.mimeType) : undefined;
      const item = items[i];
      out.push({ json: item.json, binary: { ...(item.binary ?? {}), [prop]: prepareBinary(base64ToBytes(content), fileName || undefined, mime || undefined) }, pairedItem: { item: i } });
    } catch (e) {
      if (!exec.continueOnFail()) throw e;
      out.push({ json: { error: e.message }, pairedItem: { item: i } });
    }
  });
  return out;
}

// ---------- text encodings (iconv-lite subset) ----------

const ENC = (name) => {
  const n = String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (n === "utf8") return "utf8";
  if (n === "ascii" || n === "usascii") return "ascii";
  if (n === "latin1" || n === "iso88591" || n === "binary" || n === "cp819" || n === "l1") return "latin1";
  if (n === "utf16le" || n === "ucs2" || n === "utf16") return "utf16le";
  return null;
};
function validUtf8(bytes) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
function decodeText(exec, bytes, encoding, { stripBOM = true } = {}) {
  const e = encoding ? ENC(encoding) : validUtf8(bytes) ? "utf8" : "latin1";
  if (!e) throw unsupported(exec, `the text encoding "${encoding}"`);
  let s;
  if (e === "utf8") s = new TextDecoder("utf-8").decode(bytes);
  else if (e === "utf16le") s = new TextDecoder("utf-16le").decode(bytes);
  else s = Array.from(bytes, (c) => String.fromCharCode(e === "ascii" ? c & 0x7f : c)).join("");
  // iconv-lite strips a leading BOM unless stripBOM is false (TextDecoder already drops it).
  if (stripBOM === false && e === "utf8" && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) s = "﻿" + s;
  else if (stripBOM !== false && s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s;
}
function encodeText(exec, text, encoding, addBOM) {
  const e = ENC(encoding || "utf8");
  if (!e) throw unsupported(exec, `the text encoding "${encoding}"`);
  const s = String(text);
  let bytes;
  if (e === "utf8") bytes = utf8Bytes(s);
  else if (e === "utf16le") {
    bytes = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) (bytes[2 * i] = s.charCodeAt(i) & 255), (bytes[2 * i + 1] = s.charCodeAt(i) >> 8);
  } else bytes = Uint8Array.from(s, (c) => (e === "ascii" ? c.charCodeAt(0) & 0x7f : c.charCodeAt(0) > 255 ? 0x3f : c.charCodeAt(0)));
  if (addBOM && (e === "utf8" || e === "utf16le")) {
    const bom = e === "utf8" ? [0xef, 0xbb, 0xbf] : [0xff, 0xfe];
    const out = new Uint8Array(bom.length + bytes.length);
    out.set(bom);
    out.set(bytes, bom.length);
    bytes = out;
  }
  return bytes;
}

// ---------- vendored libraries ----------

const libs = {};
async function importVendor(rel) {
  let last;
  for (const base of ["./vendor/", "../vendor/"]) {
    try {
      return await import(base + rel);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}
// pdf.js prints warnings ("Warning: Cannot polyfill `DOMMatrix`…", about rendering, which text
// extraction does not use) with console.warn; they are dropped while it loads and works.
async function quietly(fn) {
  const { log, warn } = console;
  const keep = (orig) => (...a) => (typeof a[0] === "string" && a[0].startsWith("Warning: ") ? undefined : orig(...a));
  console.log = keep(log);
  console.warn = keep(warn);
  try {
    return await fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
}
const LIB_WHAT = { pdfjs: "PDF text extraction (pdf.js)", xlsx: "spreadsheet files (SheetJS)" };
async function lib(exec, name) {
  if (libs[name]) return libs[name];
  try {
    if (name === "pdfjs") {
      // pdf.js 6 calls Promise.withResolvers, which Node has from 22; the runtime runs on 20.
      Promise.withResolvers ??= function withResolvers() {
        let resolve, reject;
        const promise = new this((res, rej) => ((resolve = res), (reject = rej)));
        return { promise, resolve, reject };
      };
      libs[name] = await quietly(async () => {
        globalThis.pdfjsWorker ??= await importVendor("pdfjs/pdf.worker.min.mjs");
        return importVendor("pdfjs/pdf.min.mjs");
      });
    } else libs[name] = await importVendor("xlsx/xlsx.mjs");
  } catch (e) {
    throw err(exec, `${LIB_WHAT[name]} needs runtime/vendor/${name} next to the runner, which this surface could not load (${String(e?.message ?? e).slice(0, 160)}); run the workflow as a task`);
  }
  return libs[name];
}

// ---------- PDF (n8n-nodes-base utils/binary extractDataFromPDF) ----------

// Text items joined per line: a new line wherever an item's y differs from the last one's.
function pageText(content) {
  let lastY;
  const text = [];
  for (const item of content.items) {
    if (!("str" in item)) continue;
    text.push(lastY == item.transform[5] || !lastY ? item.str : `\n${item.str}`);
    lastY = item.transform[5];
  }
  return text.join("");
}
export async function pdfData(exec, bytes, { password, maxPages, joinPages = true } = {}) {
  const pdfjs = await lib(exec, "pdfjs");
  return quietly(async () => {
    const doc = await pdfjs.getDocument({ password, data: new Uint8Array(bytes), verbosity: 0 }).promise;
    try {
      const { info: docInfo, metadata } = await doc.getMetadata().catch(() => ({ info: null, metadata: null }));
      const info = docInfo && "Custom" in docInfo && docInfo.Custom instanceof Map ? { ...docInfo, Custom: Object.fromEntries(docInfo.Custom) } : docInfo;
      const pages = [];
      if (maxPages !== 0) {
        let n = doc.numPages;
        if (maxPages && maxPages < doc.numPages) n = maxPages;
        for (let i = 1; i <= n; i++) pages.push(pageText(await (await doc.getPage(i)).getTextContent()));
      }
      return deepCopy({ numpages: doc.numPages, numrender: doc.numPages, info, metadata: (metadata && Object.fromEntries([...metadata])) ?? undefined, text: joinPages ? pages.join("\n\n") : pages, version: pdfjs.version });
    } finally {
      await doc.loadingTask?.destroy?.();
    }
  });
}

// ---------- spreadsheets (n8n-nodes-base utils/binary convertJsonToSpreadsheetBinary) ----------

// n8n utilities flattenObject: nested objects become dotted keys; a Date its toString().
export function flattenObject(data) {
  const out = {};
  for (const k1 of Object.keys(data)) {
    const v = data[k1];
    if (v !== null && typeof v === "object") {
      if (v instanceof Date) {
        out[k1] = v.toString();
        continue;
      }
      const flat = flattenObject(v);
      for (const k2 in flat) if (flat[k2] !== undefined) out[`${k1}.${k2}`] = flat[k2];
    } else out[k1] = v;
  }
  return out;
}
const toBytes = (x) => (x instanceof Uint8Array ? x : x instanceof ArrayBuffer ? new Uint8Array(x) : typeof x === "string" ? Uint8Array.from(x, (c) => c.charCodeAt(0) & 255) : new Uint8Array(x));
async function spreadsheetFromItems(exec, items, fileFormat, options, defaultFileName) {
  const X = await lib(exec, "xlsx");
  const rows = items.map((it) => flattenObject(it.json));
  const sheet = X.utils.json_to_sheet(rows, options.headerRow === false ? { skipHeader: true } : undefined);
  const w = { bookType: fileFormat, bookSST: false, type: "array" };
  if (fileFormat === "csv" && options.delimiter?.length) w.FS = options.delimiter ?? ",";
  if (["xlsx", "ods"].includes(fileFormat) && options.compression) w.compression = true;
  const sheetName = options.sheetName || "Sheet";
  const out = X.write({ SheetNames: [sheetName], Sheets: { [sheetName]: sheet } }, w);
  return prepareBinary(toBytes(out), options.fileName !== undefined ? options.fileName : `${defaultFileName}.${fileFormat}`);
}
// The rows of a spreadsheet file read with SheetJS (Spreadsheet File v2 fromFile, non-CSV).
function sheetRows(exec, X, bytes, options, i, { formatDates = false, readAsString = null } = {}) {
  const xo = { raw: options.rawData };
  if (formatDates) (xo.cellDates = true), (xo.UTC = true);
  let wb;
  if (readAsString === "binary") wb = X.read(Array.from(bytes, (c) => String.fromCharCode(c)).join(""), { ...xo, type: "binary" });
  else if (readAsString === "string") wb = X.read(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes), { ...xo, type: "string" });
  else wb = X.read(bytes, { ...xo, type: "array" });
  if (wb.SheetNames.length === 0) throw err(exec, "Spreadsheet does not have any sheets!", { itemIndex: i });
  let name = wb.SheetNames[0];
  if (options.sheetName) {
    if (!wb.SheetNames.includes(options.sheetName)) throw err(exec, `Spreadsheet does not contain sheet called "${options.sheetName}"!`, { itemIndex: i });
    name = options.sheetName;
  }
  const sheet = wb.Sheets[name];
  if (formatDates) {
    for (const cell of Object.values(sheet)) {
      if (cell && typeof cell === "object" && cell.t === "d" && cell.v instanceof Date) {
        cell.t = "s";
        cell.v = cell.v.toISOString();
        delete cell.z;
      }
    }
  }
  const so = {};
  if (formatDates) so.UTC = true;
  if (options.range) so.range = isNaN(options.range) ? options.range : parseInt(options.range, 10);
  if (options.includeEmptyCells) so.defval = "";
  if (options.headerRow === false) so.header = 1;
  return X.utils.sheet_to_json(sheet, so);
}
const rowItems = (rows, options, i) => rows.map((r) => ({ json: deepCopy(options.headerRow === false ? { row: r } : r), pairedItem: { item: i } }));

// Spreadsheet File v2 fromFile (also Extract From File's spreadsheet operations).
async function fromFileV2(exec, items, formatProperty, { formatSpreadsheetDates = false } = {}) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    let fileExtension;
    let fileFormat;
    try {
      const options = exec.param("options", i, {});
      fileFormat = exec.param(formatProperty, i, "");
      const { meta, bytes } = binaryOf(exec, i, exec.param("binaryPropertyName", i, "data"));
      fileExtension = meta.fileExtension;
      if (fileFormat === "autodetect" && (meta.mimeType === "text/csv" || (meta.mimeType === "text/plain" && meta.fileExtension === "csv"))) fileFormat = "csv";
      if (fileFormat === "csv") throw unsupported(exec, "Reading CSV (n8n parses it with csv-parse)");
      const X = await lib(exec, "xlsx");
      const formatDates = formatSpreadsheetDates && ["xlsx", "xls", "ods"].includes(fileFormat) && options.rawData !== true;
      const rows = sheetRows(exec, X, bytes, options, i, { formatDates, readAsString: options.readAsString ? "binary" : null });
      if (!rows.length) continue;
      out.push(...rowItems(rows, options, i));
    } catch (e) {
      if (e instanceof UnsupportedNode) throw e;
      let message = e.message;
      if (fileExtension && fileExtension !== fileFormat) message = `The file selected in 'Input Binary Field' is not in ${fileFormat} format`;
      if (exec.continueOnFail()) {
        out.push({ json: { error: message }, pairedItem: { item: i } });
        continue;
      }
      throw err(exec, message, { itemIndex: i });
    }
  }
  return out;
}

const SHEET_WRITE = ["csv", "html", "rtf", "ods", "xls", "xlsx"];
const pairedAll = (n) => Array.from({ length: n }, (_, item) => ({ item }));

// ---------- createBinaryFromJson (Convert To File toJson, toText, toBinary) ----------

function binaryFromJson(exec, data, o) {
  let value = o.sourceKey ? getPath(data, o.sourceKey) : data;
  if (value === undefined) throw err(exec, `The value in "${o.sourceKey}" is not set`, { itemIndex: o.itemIndex || 0 });
  let bytes;
  let mimeType = o.mimeType;
  if (!o.dataIsBase64) {
    let text = value;
    if (typeof value === "object") {
      mimeType = "application/json";
      text = o.format ? JSON.stringify(value, null, 2) : JSON.stringify(value);
    }
    bytes = encodeText(exec, text, o.encoding, o.addBOM);
  } else {
    const invalid = () => err(exec, `The value in "${o.sourceKey}" is not valid Base64 data`, { itemIndex: o.itemIndex ?? 0, description: "Use Convert to Text File to write plain text to a file." });
    const bytesOf = (arr) => {
      if (o.strictBase64 && !arr.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) throw invalid();
      return Uint8Array.from(arr, (b) => Number(b) & 255);
    };
    if (Array.isArray(value)) bytes = bytesOf(value);
    else if (isObject(value) && value.type === "Buffer" && Array.isArray(value.data)) bytes = bytesOf(value.data);
    else {
      if (typeof value !== "string") throw invalid();
      let enc = value.trim();
      if (/^data:/i.test(enc)) {
        const m = /^data:([^;,]*)(?:;[^;,]*)*;base64,([\s\S]*)$/i.exec(enc);
        if (m) {
          mimeType ||= m[1] || undefined;
          enc = m[2];
        } else if (o.strictBase64) throw invalid();
      }
      if (o.strictBase64) {
        enc = enc.replace(/\s/g, "");
        const m = /^([A-Za-z0-9+/_-]*)(={0,2})$/.exec(enc);
        if (!m || m[1].length % 4 === 1 || (m[2].length > 0 && (enc.length % 4 !== 0 || m[1].length % 4 === 0))) throw invalid();
      }
      // Node's base64 decoding (n8n uses it here) stops at the first padding character.
      bytes = base64ToBytes(enc.split("=")[0]);
    }
  }
  const b = prepareBinary(bytes, o.fileName, mimeType);
  if (!b.fileName) b.fileName = `file${b.fileExtension ? `.${b.fileExtension}` : ""}`;
  return b;
}

// ---------- Extract From File ----------

const EXTRACT_SHEET = ["csv", "html", "rtf", "ods", "xls", "xlsx"];
const extractFromFile = {
  versions: inRange(1, 1.2),
  defaults: () => ({ operation: "csv", binaryPropertyName: "data", destinationKey: "data", options: {} }),
  async execute(exec) {
    const items = exec.getInputData();
    const op = exec.param("operation", 0);
    const v = exec.typeVersion;
    if (EXTRACT_SHEET.includes(op)) {
      if (!["xlsx", "xls", "ods"].includes(op)) throw unsupported(exec, `Extract From File "${op}"`);
      return [await fromFileV2(exec, items, "operation", { formatSpreadsheetDates: v >= 1.2 })];
    }
    if (["binaryToPropery", "fromJson", "text"].includes(op)) return [moveTo(exec, items, op)];
    if (op === "pdf") return [await extractPdf(exec, items)];
    throw unsupported(exec, `Extract From File "${op}"`);
  },
};

function moveTo(exec, items, op) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    try {
      const item = items[i];
      const options = exec.param("options", i, {});
      const prop = exec.param("binaryPropertyName", i, "data");
      const json = {};
      const { bytes } = binaryOf(exec, i, prop);
      if (options.keepSource && options.keepSource !== "binary") Object.assign(json, deepCopy(item.json));
      let value = op === "binaryToPropery" ? bytesToBase64(bytes) : decodeText(exec, bytes, options.encoding, { stripBOM: options.stripBOM });
      if (op === "fromJson") value = value === "" ? {} : JSON.parse(value);
      setPath(json, exec.param("destinationKey", i, ""), value);
      const next = { json, pairedItem: { item: i } };
      if (options.keepSource === "binary" || options.keepSource === "both") next.binary = item.binary;
      else {
        next.binary = deepCopy(item.binary);
        unsetPath(next.binary, prop);
      }
      out.push(next);
    } catch (e) {
      if (e instanceof UnsupportedNode) throw e;
      const message = /Unexpected token|is not valid JSON|JSON at position/.test(String(e.message)) ? "The file selected in 'Input Binary Field' is not in JSON format" : e.message;
      if (exec.continueOnFail()) {
        out.push({ json: { error: message }, pairedItem: { item: i } });
        continue;
      }
      throw err(exec, message, { itemIndex: i });
    }
  }
  return out;
}

async function extractPdf(exec, items) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    try {
      const item = items[i];
      const options = exec.param("options", i, {});
      const prop = exec.param("binaryPropertyName", i, "data");
      const { bytes } = binaryOf(exec, i, prop);
      const data = await pdfData(exec, bytes, { password: options.password, maxPages: options.maxPages, joinPages: options.joinPages });
      const next = { json: options.keepSource && options.keepSource !== "binary" ? { ...deepCopy(item.json), ...data } : data, pairedItem: { item: i } };
      if (options.keepSource === "binary" || options.keepSource === "both") next.binary = item.binary;
      else {
        next.binary = deepCopy(item.binary);
        unsetPath(next.binary, prop);
      }
      out.push(next);
    } catch (e) {
      if (e instanceof UnsupportedNode) throw e;
      if (exec.continueOnFail()) {
        out.push({ json: { error: e.message }, pairedItem: { item: i } });
        continue;
      }
      throw err(exec, e.message, { itemIndex: i });
    }
  }
  return out;
}

// ---------- Convert To File ----------

const convertToFile = {
  versions: inRange(1, 1.2),
  defaults: () => ({ operation: "csv", binaryPropertyName: "data", options: {} }),
  async execute(exec) {
    const items = exec.getInputData();
    const op = exec.param("operation", 0);
    const v = exec.typeVersion;
    if (SHEET_WRITE.includes(op)) {
      const paired = pairedAll(items.length);
      try {
        const options = exec.param("options", 0, {});
        const b = await spreadsheetFromItems(exec, items, op, options, "File");
        return [[{ json: {}, binary: { [exec.param("binaryPropertyName", 0, "data")]: b }, pairedItem: paired }]];
      } catch (e) {
        if (e instanceof UnsupportedNode) throw e;
        if (exec.continueOnFail()) return [[{ json: { error: e.message }, pairedItem: paired }]];
        throw err(exec, e.message);
      }
    }
    if (op === "toJson") return [toJson(exec, items)];
    if (op === "toText" || op === "toBinary") {
      const out = [];
      for (let i = 0; i < items.length; i++) {
        try {
          const options = exec.param("options", i, {});
          const o =
            op === "toText"
              ? { sourceKey: exec.param("sourceProperty", i), fileName: options.fileName || "file.txt", mimeType: "text/plain", dataIsBase64: false, encoding: options.encoding, addBOM: options.addBOM, itemIndex: i }
              : { sourceKey: exec.param("sourceProperty", i), fileName: options.fileName, mimeType: options.mimeType, dataIsBase64: v === 1 ? options.dataIsBase64 !== false : true, strictBase64: v >= 1.2, encoding: options.encoding, addBOM: options.addBOM, itemIndex: i };
          out.push({ json: {}, binary: { [exec.param("binaryPropertyName", i, "data")]: binaryFromJson(exec, items[i].json, o) }, pairedItem: { item: i } });
        } catch (e) {
          if (exec.continueOnFail()) {
            out.push({ json: { error: e.message }, pairedItem: { item: i } });
            continue;
          }
          throw err(exec, e.message, { itemIndex: i });
        }
      }
      return [out];
    }
    throw unsupported(exec, `Convert To File "${op}"`);
  },
};

function toJson(exec, items) {
  const mode = exec.param("mode", 0, "once");
  if (mode === "once") {
    const options = exec.param("options", 0, {});
    try {
      const b = binaryFromJson(exec, items.map((it) => it.json), { fileName: options.fileName, mimeType: "application/json", encoding: options.encoding, addBOM: options.addBOM, format: options.format });
      return [{ json: {}, binary: { [exec.param("binaryPropertyName", 0, "data")]: b }, pairedItem: pairedAll(items.length) }];
    } catch (e) {
      // n8n 2.47.7 pushes the error item and then throws anyway (toJson.operation, mode once).
      throw err(exec, e.message);
    }
  }
  const out = [];
  for (let i = 0; i < items.length; i++) {
    try {
      const options = exec.param("options", i, {});
      const b = binaryFromJson(exec, items[i].json, { fileName: options.fileName, encoding: options.encoding, addBOM: options.addBOM, format: options.format, mimeType: "application/json", itemIndex: i });
      out.push({ json: {}, binary: { [exec.param("binaryPropertyName", i, "data")]: b }, pairedItem: { item: i } });
    } catch (e) {
      if (exec.continueOnFail()) {
        out.push({ json: { error: e.message }, pairedItem: { item: i } });
        continue;
      }
      throw err(exec, e.message, { itemIndex: i });
    }
  }
  return out;
}

// ---------- Spreadsheet File ----------

const spreadsheetFile = {
  versions: inRange(1, 2),
  defaults: (v, p = {}) => ({ operation: "fromFile", binaryPropertyName: "data", fileFormat: v >= 2 && (p.operation ?? "fromFile") === "fromFile" ? "autodetect" : "xls", options: {} }),
  async execute(exec) {
    const items = exec.getInputData();
    const op = exec.param("operation", 0);
    const v2 = exec.typeVersion >= 2;
    if (op === "fromFile") {
      if (v2) return [await fromFileV2(exec, items, "fileFormat")];
      // v1 reads every format, CSV included, with SheetJS.
      const out = [];
      for (let i = 0; i < items.length; i++) {
        try {
          const options = exec.param("options", i, {});
          const { bytes } = binaryOf(exec, i, exec.param("binaryPropertyName", i, "data"));
          const X = await lib(exec, "xlsx");
          const rows = sheetRows(exec, X, bytes, options, i, { readAsString: options.readAsString ? "string" : null });
          if (!rows.length) continue;
          out.push(...rowItems(rows, options, i));
        } catch (e) {
          if (e instanceof UnsupportedNode) throw e;
          if (exec.continueOnFail()) {
            out.push({ json: { error: e.message }, pairedItem: { item: i } });
            continue;
          }
          throw err(exec, e.message, { itemIndex: i });
        }
      }
      return [out];
    }
    if (op === "toFile") {
      const paired = pairedAll(items.length);
      try {
        const fmt = exec.param("fileFormat", 0, "xls");
        const options = exec.param("options", 0, {});
        if (!SHEET_WRITE.includes(fmt)) throw err(exec, `The file format "${fmt}" is not supported`);
        // v1 names the file spreadsheet.<format> and sets no delimiter; v2 is Convert To File's.
        const b = await spreadsheetFromItems(exec, items, fmt, v2 ? options : { ...options, delimiter: undefined }, "spreadsheet");
        return [[{ json: {}, binary: { [exec.param("binaryPropertyName", 0, "data")]: b }, pairedItem: paired }]];
      } catch (e) {
        if (e instanceof UnsupportedNode) throw e;
        if (exec.continueOnFail()) return [[{ json: { error: e.message }, pairedItem: paired }]];
        throw e instanceof NodeError ? e : err(exec, e.message);
      }
    }
    if (exec.continueOnFail()) return [[{ json: { error: `The operation "${op}" is not supported!` } }]];
    throw err(exec, `The operation "${op}" is not supported!`);
  },
};

// ---------- local disk (host `file` requests) ----------

// A path as the host reads it: "./" and "../" segments resolved, never above its start.
export function normalizePath(p) {
  const s = String(p ?? "");
  const abs = s.startsWith("/");
  const parts = [];
  for (const seg of s.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length || parts.at(-1) === "..") {
        if (abs) return null;
        parts.push("..");
      } else parts.pop();
    } else parts.push(seg);
  }
  if (parts.includes("..")) return null;
  return (abs ? "/" : "./") + parts.join("/");
}

// A host request's own control flow (a task driver's suspension, a containment refusal) is
// never turned into a step error.
const passThrough = (e) => e?.name === "Suspend" || e?.name === "ContainmentViolation" || e?.name === "BadInput";

async function diskRequest(exec, i, req) {
  const [r] = await exec.request([{ kind: "file", itemIndex: i, ...req }]);
  if (!r.ok) throw err(exec, r.error?.message ?? `file ${req.op} failed`, { itemIndex: i });
  return r.value ?? {};
}

const readFiles = (exec, items, { selectorParam, propParam, legacy, many }) => async () => {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    let selector;
    try {
      selector = String(exec.param(selectorParam, i, "")).trim();
      const options = legacy ? {} : exec.param("options", i, {});
      const prop = legacy ? exec.param(propParam, i, "data") : options.dataPropertyName || "data";
      const res = await diskRequest(exec, i, { op: "read", path: selector, glob: many });
      const files = res.files ?? [];
      if (!files.length && !legacy && exec.typeVersion > 1) throw err(exec, "No file(s) found", { itemIndex: i, description: `No file matching the selector "${selector}" found` });
      for (const f of files) {
        const b = prepareBinary(base64ToBytes(f.data ?? ""), f.path, undefined, { stream: true });
        if (legacy && !many) {
          const item = items[i];
          out.push({ json: item.json, binary: { ...(item.binary ?? {}), [prop]: b }, pairedItem: { item: i } });
          continue;
        }
        if (options.fileName !== undefined) b.fileName = options.fileName;
        if (options.fileExtension !== undefined) b.fileExtension = options.fileExtension;
        if (options.mimeType !== undefined) b.mimeType = options.mimeType;
        out.push({ binary: { [prop]: b }, json: legacy ? {} : { mimeType: b.mimeType, fileType: b.fileType, fileName: b.fileName, fileExtension: b.fileExtension, fileSize: b.fileSize }, pairedItem: { item: i } });
      }
    } catch (e) {
      if (passThrough(e)) throw e;
      if (exec.continueOnFail()) {
        out.push({ json: { error: e.message }, pairedItem: { item: i } });
        continue;
      }
      throw e instanceof NodeError ? e : err(exec, e.message, { itemIndex: i });
    }
  }
  return out;
};

async function writeFiles(exec, items, { legacy }) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    try {
      const prop = exec.param("dataPropertyName", i, "data");
      const fileName = exec.param("fileName", i);
      const options = exec.param("options", legacy ? 0 : i, {});
      const item = items[i];
      const { meta } = binaryOf(exec, i, prop);
      await diskRequest(exec, i, { op: "write", path: String(fileName), data: meta.data, append: !!options.append });
      const next = { json: { ...item.json, fileName }, pairedItem: { item: i } };
      if (item.binary !== undefined) next.binary = { ...item.binary };
      out.push(next);
    } catch (e) {
      if (e instanceof UnsupportedNode || passThrough(e)) throw e;
      if (exec.continueOnFail()) {
        out.push({ json: { error: e.message }, pairedItem: { item: i } });
        continue;
      }
      throw e instanceof NodeError ? e : err(exec, e.message, { itemIndex: i });
    }
  }
  return out;
}

const readWriteFile = {
  versions: inRange(1, 1.1),
  defaults: () => ({ operation: "read", fileSelector: "", dataPropertyName: "data", options: {} }),
  async execute(exec) {
    const items = exec.getInputData();
    const op = exec.param("operation", 0);
    if (op === "read") return [await readFiles(exec, items, { selectorParam: "fileSelector", many: true })()];
    if (op === "write") return [await writeFiles(exec, items, { legacy: false })];
    throw unsupported(exec, `Read/Write Files from Disk "${op}"`);
  },
};
const readBinaryFile = { versions: inRange(1, 1), defaults: () => ({ filePath: "", dataPropertyName: "data" }), execute: async (exec) => [await readFiles(exec, exec.getInputData(), { selectorParam: "filePath", propParam: "dataPropertyName", legacy: true, many: false })()] };
const writeBinaryFile = { versions: inRange(1, 1), defaults: () => ({ fileName: "", dataPropertyName: "data", options: {} }), execute: async (exec) => [await writeFiles(exec, exec.getInputData(), { legacy: true })] };

// Read Binary Files (v1): one glob, every match an item, run once (n8n reads the selector of
// item 0 only).
const readBinaryFiles = {
  versions: inRange(1, 1),
  defaults: () => ({ fileSelector: "", dataPropertyName: "data" }),
  async execute(exec) {
    const selector = String(exec.param("fileSelector", 0, ""));
    const prop = exec.param("dataPropertyName", 0, "data");
    const res = await diskRequest(exec, 0, { op: "read", path: selector, glob: true });
    return [(res.files ?? []).map((f) => ({ json: {}, binary: { [prop]: prepareBinary(base64ToBytes(f.data ?? ""), f.path, undefined, { stream: true }) }, pairedItem: { item: 0 } }))];
  },
};

// Read PDF (legacy, v1): the same extraction, the item's binary kept, no pairing.
const readPDF = {
  versions: inRange(1, 1),
  defaults: () => ({ binaryPropertyName: "data", encrypted: false, password: "" }),
  async execute(exec) {
    const items = exec.getInputData();
    const out = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const { bytes } = binaryOf(exec, i, exec.param("binaryPropertyName", i, "data"));
        const password = exec.param("encrypted", i, false) === true ? exec.param("password", i, "") : undefined;
        out.push({ binary: items[i].binary, json: await pdfData(exec, bytes, { password }) });
      } catch (e) {
        if (e instanceof UnsupportedNode) throw e;
        if (exec.continueOnFail()) {
          out.push({ json: { error: e.message }, pairedItem: { item: i } });
          continue;
        }
        throw err(exec, e.message, { itemIndex: i });
      }
    }
    return [out];
  },
};

export const FILES = {
  [BASE + "readPDF"]: readPDF,
  [BASE + "extractFromFile"]: extractFromFile,
  [BASE + "convertToFile"]: convertToFile,
  [BASE + "spreadsheetFile"]: spreadsheetFile,
  [BASE + "readWriteFile"]: readWriteFile,
  [BASE + "readBinaryFile"]: readBinaryFile,
  [BASE + "readBinaryFiles"]: readBinaryFiles,
  [BASE + "writeBinaryFile"]: writeBinaryFile,
};
