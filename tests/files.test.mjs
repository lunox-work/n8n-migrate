// The files lever (runtime/src/files.mjs): Extract From File, Convert To File, Spreadsheet File,
// Read/Write Files from Disk, Read/Write Binary File, Read PDF, and connector downloads into
// binary data, with real small files. Expected bytes and shapes come from n8n 2.47.7 (its
// pdfjs-dist 6.3.289 and @e965/xlsx 0.20.3, run in the bench's container) where noted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { convertItems, loadReferences, writeFolder } from "../skills/n8n-to-claude/scripts/convert.mjs";
import { loadInput } from "../skills/n8n-to-claude/scripts/analyze.mjs";
import { preflight, run } from "../skills/n8n-to-claude/runtime/src/api.mjs";
import { prettyBytes, mimeLookup, mimeExtension, prepareBinary, normalizePath, flattenObject } from "../skills/n8n-to-claude/runtime/src/files.mjs";
import { executeFile, taskSurface } from "../skills/n8n-to-claude/runtime/src/driver.mjs";

const refs = loadReferences();
const CLOCK = { startedAt: "2026-11-16T09:00:00Z" };
const B = "n8n-nodes-base.";

function convertJson(wf) {
  const dir = mkdtempSync(join(tmpdir(), "n8m-files-"));
  const p = join(dir, "wf.json");
  writeFileSync(p, JSON.stringify(wf));
  const loaded = loadInput(p);
  rmSync(dir, { recursive: true, force: true });
  return convertItems(loaded.items, { refs, now: Date.parse("2026-11-14T00:00:00Z"), forceConvert: true })[0];
}
// Manual trigger -> the given nodes in a chain.
const chain = (nodes) => ({
  id: "files01",
  name: "Files",
  nodes: [{ parameters: {}, name: "Start", type: B + "manualTrigger", typeVersion: 1, position: [0, 0] }, ...nodes.map((n, i) => ({ position: [200 * (i + 1), 0], ...n }))],
  connections: Object.fromEntries(["Start", ...nodes.map((n) => n.name)].slice(0, -1).map((from, i) => [from, { main: [[{ node: nodes[i].name, type: "main", index: 0 }]] }])),
  settings: { executionOrder: "v1" },
});
const out = (r, step) => r.runData[step]?.[0]?.data?.main?.[0] ?? [];
const b64 = (s) => Buffer.from(s).toString("base64");

// A small real PDF: two pages, two lines and one line drawn in two pieces on page 1.
function pdf(pages) {
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + 2 * i} 0 R`).join(" ")}] /Count ${pages.length} >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"];
  pages.forEach((content, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`);
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  let s = "%PDF-1.4\n";
  const at = [];
  objs.forEach((o, i) => {
    at.push(s.length);
    s += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const x = s.length;
  s += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(s, "latin1");
}
const PDF = pdf(["BT /F1 12 Tf 72 720 Td (Invoice 42) Tj 0 -14 Td (Total: 19.90 EUR) Tj 0 -14 Td (Paid ) Tj (in full) Tj ET", "BT /F1 12 Tf 72 720 Td (Page two) Tj ET"]);
const pdfItem = (extra = {}) => ({ json: { source: "mail" }, binary: { data: { ...prepareBinary(new Uint8Array(PDF), "invoice.pdf"), ...extra } } });

test("binary data as n8n-core prepareBinaryData builds it: MIME types, sizes, names", () => {
  // pretty-bytes 5.6.0 and mime-types 3.0.2, as n8n 2.47.7 answers them.
  assert.deepEqual([0, 999, 1000, 1662, 1290, 12345678].map(prettyBytes), ["0 B", "999 B", "1 kB", "1.66 kB", "1.29 kB", "12.3 MB"]);
  assert.deepEqual(["x.pdf", "a/b.CSV", "s.xlsx", "m.mp3", "y.yml", "z.unknown"].map(mimeLookup), ["application/pdf", "text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "audio/mpeg", "text/yaml", false]);
  assert.deepEqual(["text/plain", "audio/mpeg", "image/jpeg", "text/csv; charset=utf-8", "video/quicktime"].map(mimeExtension), ["txt", "mpga", "jpg", "csv", "qt"]);
  const b = prepareBinary(new Uint8Array([1, 2, 3]), "/files/out/report.csv");
  assert.deepEqual(Object.keys(b), ["mimeType", "fileType", "fileExtension", "data", "directory", "fileName", "fileSize", "bytes"]);
  assert.deepEqual(b, { mimeType: "text/csv", fileType: "text", fileExtension: "csv", data: "AQID", directory: "/files/out", fileName: "report.csv", fileSize: "3 B", bytes: 3 });
  // No name and no type: the first bytes (file-type), else text/plain.
  assert.equal(prepareBinary(new Uint8Array(PDF)).mimeType, "application/pdf");
  // text/plain is the fallback after the extension is looked up, so it gets none (as in n8n-core).
  assert.deepEqual(prepareBinary(utf8("plain")), { mimeType: "text/plain", fileType: "text", data: "cGxhaW4=", fileSize: "5 B", bytes: 5 });
  assert.deepEqual(flattenObject({ a: { b: 1, c: { d: null } }, e: [1, { f: 2 }] }), { "a.b": 1, "a.c.d": null, "e.0": 1, "e.1.f": 2 });
});
const utf8 = (s) => new Uint8Array(Buffer.from(s));

test("Extract From File pdf: pdf.js text, lines by position, pages joined, as n8n extracts it", async () => {
  const conv = convertJson(chain([{ parameters: { operation: "pdf", options: {} }, name: "Extract", type: B + "extractFromFile", typeVersion: 1 }]));
  const def = conv.definition;
  assert.deepEqual([def.steps.Extract.kind, def.steps.Extract.files, def.steps.Extract.blocked], ["logic", { lib: "pdfjs" }, undefined]);
  assert.equal(preflight(def, {}).ok, true);
  const r = await run(def, { clock: CLOCK, trigger: { node: "Start", items: [pdfItem()] } });
  assert.equal(r.status, "done", r.error?.message);
  const [item] = out(r, "Extract");
  assert.deepEqual(Object.keys(item.json), ["numpages", "numrender", "info", "text", "version"]);
  assert.equal(item.json.text, "Invoice 42\nTotal: 19.90 EUR\nPaid in full\n\nPage two");
  assert.deepEqual([item.json.numpages, item.json.version, item.json.info.PDFFormatVersion], [2, "6.3.289", "1.4"]);
  assert.deepEqual(item.binary, {}, "the PDF leaves the item unless keepSource keeps it");
  // joinPages false, maxPages, keepSource both (the input json first, the binary kept).
  const opt = convertJson(chain([{ parameters: { operation: "pdf", options: { joinPages: false, maxPages: 1, keepSource: "both" } }, name: "Extract", type: B + "extractFromFile", typeVersion: 1 }])).definition;
  const [k] = out(await run(opt, { clock: CLOCK, trigger: { node: "Start", items: [pdfItem()] } }), "Extract");
  assert.deepEqual([k.json.source, k.json.text, Object.keys(k.binary)], ["mail", ["Invoice 42\nTotal: 19.90 EUR\nPaid in full"], ["data"]]);
  // Not a PDF: pdf.js's own error, as n8n reports it (2860's malformed CV: "Invalid PDF structure.").
  const bad = await run(def, { clock: CLOCK, trigger: { node: "Start", items: [{ json: {}, binary: { data: prepareBinary(utf8("not a pdf at all"), "cv.pdf") } }] } });
  assert.equal(bad.status, "failed");
  assert.match(bad.error.message, /Invalid PDF structure|PDF/);
  // The legacy Read PDF node: the same text, the binary kept.
  const legacy = convertJson(chain([{ parameters: {}, name: "Read PDF", type: B + "readPDF", typeVersion: 1 }])).definition;
  const [l] = out(await run(legacy, { clock: CLOCK, trigger: { node: "Start", items: [pdfItem()] } }), "Read PDF");
  assert.deepEqual([l.json.text.split("\n")[0], Object.keys(l.binary)], ["Invoice 42", ["data"]]);
});

test("Convert To File csv writes SheetJS's bytes: n8n 2.47.7's file for the same rows, byte for byte", async () => {
  const rows = [{ a: 1, b: "x,y", c: true, d: 0.30000000000000004, e: 'He said "hi"', f: 1234567890123, g: "é ünï", h: null, i: " lead" }, { a: 2.5, j: "new\nline", b: "", k: 1e21, l: -0.000001234 }];
  const def = convertJson(chain([{ parameters: { options: {} }, name: "Convert to CSV", type: B + "convertToFile", typeVersion: 1.1 }])).definition;
  assert.deepEqual(def.steps["Convert to CSV"].files, { lib: "xlsx" });
  const r = await run(def, { clock: CLOCK, trigger: { node: "Start", items: rows.map((json) => ({ json })) } });
  assert.equal(r.status, "done", r.error?.message);
  const [item] = out(r, "Convert to CSV");
  // n8n 2.47.7 (@e965/xlsx 0.20.3 json_to_sheet + write csv) produced exactly these bytes.
  const N8N = "77u/YSxiLGMsZCxlLGYsZyxoLGksaixrLGwKMSwieCx5IixUUlVFLDAuMywiSGUgc2FpZCAiImhpIiIiLDEuMjM0NTdFKzEyLMOpIMO8bsOvLCwgbGVhZCwsLAoyLjUsLCwsLCwsLCwibmV3CmxpbmUiLDFFKzIxLC0wLjAwMDAwMTIzNA==";
  assert.equal(item.binary.data.data, N8N);
  assert.deepEqual({ ...item.binary.data, data: "…" }, { mimeType: "text/csv", fileType: "text", fileExtension: "csv", data: "…", fileName: "File.csv", fileSize: "133 B", bytes: 133 });
  assert.deepEqual([item.json, item.pairedItem], [{}, [{ item: 0 }, { item: 1 }]]);
  // xlsx out, then Extract From File xlsx and Spreadsheet File v1 back in: the same rows.
  const round = convertJson(chain([
    { parameters: { operation: "xlsx", options: { sheetName: "People" } }, name: "To XLSX", type: B + "convertToFile", typeVersion: 1.1 },
    { parameters: { operation: "xlsx", options: {} }, name: "From XLSX", type: B + "extractFromFile", typeVersion: 1 },
  ])).definition;
  const people = [{ name: "Ada", age: 36, active: true }, { name: "Bo", age: 41.5, active: false }];
  const rr = await run(round, { clock: CLOCK, trigger: { node: "Start", items: people.map((json) => ({ json })) } });
  assert.equal(rr.status, "done", rr.error?.message);
  assert.equal(out(rr, "To XLSX")[0].binary.data.fileName, "File.xlsx");
  assert.deepEqual(out(rr, "From XLSX").map((i) => i.json), people);
  // Spreadsheet File v1 reads CSV with SheetJS (v2 parses CSV with csv-parse: refused below).
  const v1 = convertJson(chain([{ parameters: { options: {} }, name: "Read Sheet", type: B + "spreadsheetFile", typeVersion: 1 }])).definition;
  const csv = { json: {}, binary: { data: prepareBinary(utf8("name,qty\nAda,3\nBo,4\n"), "list.csv") } };
  assert.deepEqual(out(await run(v1, { clock: CLOCK, trigger: { node: "Start", items: [csv] } }), "Read Sheet").map((i) => i.json), [{ name: "Ada", qty: 3 }, { name: "Bo", qty: 4 }]);
  const v1w = convertJson(chain([{ parameters: { operation: "toFile", fileFormat: "csv", options: {} }, name: "Write Sheet", type: B + "spreadsheetFile", typeVersion: 1 }])).definition;
  const [w] = out(await run(v1w, { clock: CLOCK, trigger: { node: "Start", items: [{ json: { x: 1 } }] } }), "Write Sheet");
  assert.deepEqual([w.binary.data.fileName, Buffer.from(w.binary.data.data, "base64").toString()], ["spreadsheet.csv", "﻿x\n1"]);
  const v2auto = convertJson(chain([{ parameters: { options: {} }, name: "Read Sheet", type: B + "spreadsheetFile", typeVersion: 2 }])).definition;
  const ra = await run(v2auto, { clock: CLOCK, trigger: { node: "Start", items: [csv] } });
  assert.equal(ra.status, "failed");
  assert.match(ra.error.message, /Reading CSV .* is not supported by the runtime/);
});

test("Convert To File toJson, toText, toBinary and Extract From File fromJson, text, binaryToPropery", async () => {
  const def = convertJson(chain([
    { parameters: { operation: "toJson", options: {} }, name: "To JSON", type: B + "convertToFile", typeVersion: 1.1 },
    { parameters: { operation: "fromJson", options: {} }, name: "From JSON", type: B + "extractFromFile", typeVersion: 1 },
  ])).definition;
  assert.equal(def.steps["To JSON"].files, undefined, "no library needed");
  const r = await run(def, { clock: CLOCK, trigger: { node: "Start", items: [{ json: { a: 1 } }, { json: { b: "é" } }] } });
  assert.equal(r.status, "done", r.error?.message);
  const [j] = out(r, "To JSON");
  assert.deepEqual({ ...j.binary.data, data: Buffer.from(j.binary.data.data, "base64").toString() }, { mimeType: "application/json", fileType: "json", fileExtension: "json", data: '[{"a":1},{"b":"é"}]', fileSize: "20 B", bytes: 20, fileName: "file.json" });
  assert.deepEqual(out(r, "From JSON")[0].json, { data: [{ a: 1 }, { b: "é" }] });
  // toText from a field, then text back (a UTF-8 BOM stripped); toBinary from base64 and a data URI.
  const t = convertJson(chain([
    { parameters: { operation: "toText", sourceProperty: "body", options: { addBOM: true } }, name: "To Text", type: B + "convertToFile", typeVersion: 1.1 },
    { parameters: { operation: "text", destinationKey: "content", options: {} }, name: "Read Text", type: B + "extractFromFile", typeVersion: 1 },
  ])).definition;
  const rt = await run(t, { clock: CLOCK, trigger: { node: "Start", items: [{ json: { body: "Grüße" } }] } });
  assert.deepEqual([out(rt, "To Text")[0].binary.data.fileName, out(rt, "To Text")[0].binary.data.bytes, out(rt, "Read Text")[0].json], ["file.txt", 10, { content: "Grüße" }]);
  const bin = convertJson(chain([{ parameters: { operation: "toBinary", sourceProperty: "file", options: {} }, name: "To File", type: B + "convertToFile", typeVersion: 1.2 }])).definition;
  const rb = await run(bin, { clock: CLOCK, trigger: { node: "Start", items: [{ json: { file: b64("abc") } }, { json: { file: `data:image/png;base64,${b64("png!")}` } }] } });
  assert.deepEqual(out(rb, "To File").map((i) => [i.binary.data.mimeType, i.binary.data.fileName, Buffer.from(i.binary.data.data, "base64").toString()]), [["text/plain", "file", "abc"], ["image/png", "file.png", "png!"]], "no type given: text/plain without an extension, so n8n names it file");
  // v1.2 checks base64 strictly; v1.1 decodes leniently, as Node does.
  const strict = await run(bin, { clock: CLOCK, trigger: { node: "Start", items: [{ json: { file: "abcde" } }] } });
  assert.match(strict.error.message, /is not valid Base64 data/);
  const p = convertJson(chain([{ parameters: { operation: "binaryToPropery", options: {} }, name: "To Property", type: B + "extractFromFile", typeVersion: 1 }])).definition;
  assert.deepEqual(out(await run(p, { clock: CLOCK, trigger: { node: "Start", items: [{ json: {}, binary: { data: prepareBinary(utf8("hi"), "a.txt") } }] } }), "To Property")[0].json, { data: "aGk=" });
});

test("disk steps: local tasks only, paths limited to the directories written in the step", async () => {
  const conv = convertJson(chain([
    { parameters: { options: {} }, name: "To JSON", type: B + "convertToFile", typeVersion: 1.1, parameters: { operation: "toJson", options: {} } },
    { parameters: { operation: "write", fileName: "=/data/out/{{ $('Start').first().json.name ?? 'x' }}.json", options: {} }, name: "Save", type: B + "readWriteFile", typeVersion: 1 },
    { parameters: { fileSelector: "/data/in/*.json", options: {} }, name: "Load", type: B + "readWriteFile", typeVersion: 1 },
  ]));
  const def = conv.definition;
  assert.deepEqual([def.steps.Save.files, def.steps.Load.files], [{ disk: "write" }, { disk: "read" }]);
  assert.deepEqual(def.allow.files.map((a) => [a.op, a.dir]), [["write", "/data/out/"], ["read", "/data/in/"]]);
  assert.equal(preflight(def, {}).ok, true);
  assert.equal(preflight(def, { surface: "local-task" }).ok, true);
  for (const surface of ["cloud-task", "artifact"]) assert.match(preflight(def, { surface }).issues.find((i) => i.level === "error" && i.step === "Save").message, /local disk, which only a local task has/);
  const files = {};
  const host = {
    file: async (q) => {
      if (q.op === "write") return (files[q.path] = q.data), { path: q.path };
      return { files: Object.keys(files).filter((p) => p.startsWith("/data/in/")).map((p) => ({ path: p, data: files[p] })) };
    },
  };
  files["/data/in/a.json"] = b64('{"k":1}');
  const r = await run(def, { clock: CLOCK, host, trigger: { node: "Start", items: [{ json: { v: 1 } }] } });
  assert.equal(r.status, "done", r.error?.message);
  assert.deepEqual(Object.keys(files).sort(), ["/data/in/a.json", "/data/out/x.json"]);
  assert.deepEqual(out(r, "Save")[0].json, { fileName: "/data/out/x.json" });
  const [loaded] = out(r, "Load");
  assert.deepEqual(loaded.json, { mimeType: "application/json", fileType: "json", fileName: "a.json", fileExtension: "json", fileSize: "7 B" });
  assert.equal(loaded.binary.data.directory, "/data/in");
  // A path the data steers outside the directory is refused before the host sees it.
  const esc = await run(def, { clock: CLOCK, host, trigger: { node: "Start", items: [{ json: { name: "../../etc/passwd" } }] } });
  assert.equal(esc.status, "failed");
  assert.equal(esc.error.name, "ContainmentViolation");
  assert.equal(files["/etc/passwd.json"], undefined);
  assert.deepEqual([normalizePath("/data/out/../in/x"), normalizePath("/data/../../x"), normalizePath("rel/./a"), normalizePath("../a")], ["/data/in/x", null, "./rel/a", null]);
  // A path with no directory written is refused by preflight until narrowed.
  const open = convertJson(chain([{ parameters: { fileName: "={{ $json.path }}", options: {} }, name: "Write", type: B + "writeBinaryFile", typeVersion: 1 }])).definition;
  assert.match(preflight(open, {}).issues.find((i) => i.level === "error").message, /step "Write": a file write whose path is built at run time/);
});

test("the task driver reads and writes the disk on a local task and refuses on a cloud task", () => {
  const dir = mkdtempSync(join(tmpdir(), "n8m-disk-"));
  try {
    const local = { secrets: "env", store: { kind: "file" } };
    assert.deepEqual([taskSurface(local), taskSurface({ secrets: "proxy" }), taskSurface({ store: { kind: "git" } })], ["local-task", "cloud-task", "cloud-task"]);
    assert.deepEqual(executeFile({ op: "write", path: "out/a.txt", data: b64("one") }, local, dir), { ok: true, value: { path: "out/a.txt", bytes: 3 } });
    executeFile({ op: "write", path: "out/a.txt", data: b64("+two"), append: true }, local, dir);
    executeFile({ op: "write", path: join(dir, "out", "sub", "b.txt"), data: b64("b") }, local, dir);
    assert.equal(readFileSync(join(dir, "out", "a.txt"), "utf8"), "one+two");
    const one = executeFile({ op: "read", path: "out/a.txt" }, local, dir);
    assert.deepEqual(one.value.files, [{ path: "out/a.txt", data: b64("one+two") }]);
    assert.deepEqual(executeFile({ op: "read", path: "out/*.txt", glob: true }, local, dir).value.files.map((f) => f.path), ["out/a.txt"]);
    assert.deepEqual(executeFile({ op: "read", path: "out/**/*.txt", glob: true }, local, dir).value.files.map((f) => f.path), ["out/a.txt", "out/sub/b.txt"]);
    assert.deepEqual(executeFile({ op: "read", path: "none/*.txt", glob: true }, local, dir).value.files, []);
    assert.match(executeFile({ op: "read", path: "missing.txt" }, local, dir).error.message, /could not be accessed/);
    assert.match(executeFile({ op: "read", path: "/*", glob: true }, local, dir).error.message, /whole disk/);
    assert.match(executeFile({ op: "write", path: "x.txt", data: "" }, { secrets: "proxy" }, dir).error.message, /only on a local task/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Drive download puts the file into binary data, so a PDF step after it runs", async () => {
  const conv = convertJson(chain([
    { parameters: { operation: "download", fileId: { __rl: true, mode: "id", value: "f1" }, options: {} }, name: "Download", type: B + "googleDrive", typeVersion: 3, credentials: { googleDriveOAuth2Api: { id: "1", name: "Drive" } } },
    { parameters: { operation: "pdf", options: {} }, name: "Extract", type: B + "extractFromFile", typeVersion: 1 },
  ]));
  const def = conv.definition;
  assert.deepEqual(def.steps.Download.tool.binary, { property: "data", content: "content", mimeType: "mimeType", name: "title" });
  const host = { tool: async (q) => ({ fileId: q.args.fileId, title: "invoice.pdf", mimeType: "application/pdf", content: PDF.toString("base64") }) };
  const r = await run(def, { clock: CLOCK, host, trigger: { node: "Start", items: [{ json: { id: "f1" } }] } });
  assert.equal(r.status, "done", r.error?.message);
  const [d] = out(r, "Download");
  assert.deepEqual([d.json, d.binary.data.fileName, d.binary.data.mimeType, d.binary.data.fileSize], [{ id: "f1" }, "invoice.pdf", "application/pdf", prettyBytes(PDF.length)]);
  assert.equal(out(r, "Extract")[0].json.text.split("\n")[0], "Invoice 42");
});

test("file steps the runtime does not carry stay blocked with their reason; libraries ship only where used", () => {
  const reasons = (nodes) => Object.fromEntries(Object.entries(convertJson(chain(nodes)).definition.steps).filter(([, s]) => s.kind === "blocked").map(([n, s]) => [n, s.blocked.reason]));
  const r = reasons([
    { parameters: { operation: "csv", options: {} }, name: "CSV In", type: B + "extractFromFile", typeVersion: 1 },
    { parameters: { operation: "xml", options: {} }, name: "XML In", type: B + "extractFromFile", typeVersion: 1 },
    { parameters: { operation: "fromFile", fileFormat: "csv", options: {} }, name: "Sheet CSV", type: B + "spreadsheetFile", typeVersion: 2 },
    { parameters: { operation: "resize", width: 100, height: 100, options: {} }, name: "Resize", type: B + "editImage", typeVersion: 1 },
    { parameters: { operation: "compress", options: {} }, name: "Zip", type: B + "compression", typeVersion: 1.1 },
    { parameters: { operation: "iCal", options: {} }, name: "ICS", type: B + "convertToFile", typeVersion: 1.1 },
  ]);
  assert.match(r["CSV In"], /csv-parse/);
  assert.match(r["XML In"], /not implemented yet/);
  assert.match(r["Sheet CSV"], /csv-parse/);
  assert.match(r.Resize, /GraphicsMagick/);
  assert.match(r.Zip, /Compression/);
  assert.match(r.ICS, /Convert To File iCal is not implemented yet/);
  // writeFolder copies runtime/vendor/<lib> only for a definition that loads it.
  const dir = mkdtempSync(join(tmpdir(), "n8m-vendor-"));
  try {
    const withPdf = convertJson(chain([{ parameters: { operation: "pdf", options: {} }, name: "Extract", type: B + "extractFromFile", typeVersion: 1 }]));
    const folder = writeFolder(dir, withPdf, { refs });
    assert.deepEqual(readdirSync(join(folder, "runtime", "vendor")), ["pdfjs"]);
    assert.ok(existsSync(join(folder, "runtime", "vendor", "pdfjs", "LICENSE")));
    const plain = convertJson(chain([{ parameters: { operation: "toJson", options: {} }, name: "To JSON", type: B + "convertToFile", typeVersion: 1.1 }]));
    const folder2 = writeFolder(join(dir, "b"), plain, { refs });
    assert.equal(existsSync(join(folder2, "runtime", "vendor")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an HTTP download of a spreadsheet or document becomes binary data, never text (n8n's binary content types)", async () => {
  const def = convertJson(chain([{ parameters: { url: "https://files.example/report.xlsx", options: {} }, name: "Download", type: B + "httpRequest", typeVersion: 4.2 }])).definition;
  for (const ct of ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/msword", "application/pdf"]) {
    const r = await run(def, { clock: CLOCK, host: { http: async () => ({ status: 200, headers: { "content-type": ct }, body: "PK\u0003\u0004" }) }, trigger: { node: "Start", items: [{ json: {} }] } });
    assert.equal(r.status, "done", ct);
    const bin = r.runData.Download[0].data.main[0][0].binary.data;
    assert.equal(bin.mimeType, ct);
    assert.equal(bin.fileName, "report.xlsx");
    assert.equal(bin.data, Buffer.from([0x50, 0x4b, 3, 4]).toString("base64"));
  }
  const t = await run(def, { clock: CLOCK, host: { http: async () => ({ status: 200, headers: { "content-type": "text/csv" }, body: "a,b\n1,2" }) }, trigger: { node: "Start", items: [{ json: {} }] } });
  assert.deepEqual(out(t, "Download")[0].json, { data: "a,b\n1,2" });
});
