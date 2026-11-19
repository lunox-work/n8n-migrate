// Bench fixes of session R4i: P100 (a request head sent twice through the mock's plain-HTTP
// proxy path) and P102 (the canned n8n check on its own). No Docker.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startMock, firstHead } from "../evals/n8n/mock-server.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const multipart = (boundary, file) =>
  Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="fileInput"; filename="s.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="dpi"\r\n\r\n300\r\n--${boundary}--\r\n`),
  ]);
const headOf = (target, body, boundary) => Buffer.from(`POST ${target} HTTP/1.1\r\nContent-Type: multipart/form-data; boundary=${boundary}\r\ncontent-length: ${body.length}\r\nHost: stirling.test:8080\r\nProxy-Connection: close\r\nConnection: close\r\n\r\n`);

test("P100 firstHead: an exact second copy of a proxied request head is dropped", () => {
  const body = multipart("b1", Buffer.alloc(300, 7));
  const head = headOf("http://stirling.test:8080/api/v1/convert/pdf/img", body, "b1");
  const twice = Buffer.concat([head, head, body]);
  const r = firstHead(twice);
  assert.equal(r.done, true);
  assert.equal(r.dropped, true);
  assert.ok(r.out.equals(Buffer.concat([head, body])));
  // Undecided while the bytes after the head could still be its copy.
  assert.deepEqual(firstHead(Buffer.concat([head, head.subarray(0, 40)])), { done: false });
  assert.deepEqual(firstHead(head.subarray(0, 20)), { done: false });
  // A single head with its body, a body-less request, and a request made to the mock directly
  // (origin-form) pass unchanged.
  const once = Buffer.concat([head, body]);
  assert.deepEqual(firstHead(once), { done: true, out: once, dropped: false });
  const get = Buffer.from("GET http://a.test/x HTTP/1.1\r\nHost: a.test\r\n\r\n");
  assert.deepEqual(firstHead(get), { done: true, out: get, dropped: false });
  const direct = Buffer.from("POST /model/x/v1/messages HTTP/1.1\r\n");
  assert.deepEqual(firstHead(direct), { done: true, out: direct, dropped: false });
  // A head with a body whose first bytes are not the head's goes on before the body is whole.
  assert.equal(firstHead(Buffer.concat([head, body.subarray(0, 10)])).done, true);
});

// Sends raw bytes in pieces over one socket and returns the whole reply.
function rawRequest(port, pieces) {
  return new Promise((ok, fail) => {
    const s = connect(port, "127.0.0.1");
    const out = [];
    s.on("data", (d) => out.push(d));
    s.on("end", () => ok(Buffer.concat(out).toString("latin1")));
    s.on("error", fail);
    s.on("connect", async () => {
      for (const p of pieces) {
        s.write(p);
        await new Promise((r) => setTimeout(r, 15));
      }
    });
  });
}

test("P100 mock: a streamed multipart body after a doubled head reaches the route whole, as one request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "n8m-p100-"));
  const log = join(dir, "effects.jsonl");
  const fixtures = join(dir, "fixtures.json");
  writeFileSync(fixtures, JSON.stringify({ __routes: [{ method: "POST", url: "http://stirling.test:8080/api/v1/convert/pdf/img", status: 200, body: { ok: true } }], __writeDefault: { status: 200, body: {} } }));
  const server = await startMock({ port: 0, log, fixtures, host: "127.0.0.1" });
  const port = server.address().port;
  try {
    const file = Buffer.alloc(2009, 0x41);
    const body = multipart("b2", file);
    const head = headOf("http://stirling.test:8080/api/v1/convert/pdf/img", body, "b2");
    // As n8n's proxy agent writes it: head, head again, then the body in stream-sized chunks.
    const reply = await rawRequest(port, [head, head, body.subarray(0, 500), body.subarray(500, 1700), body.subarray(1700)]);
    assert.match(reply, /^HTTP\/1\.1 200 /);
    assert.match(reply, /\{"ok":true\}/);
    // A normal proxied upload in pieces and a plain request to the mock still work.
    const reply2 = await rawRequest(port, [head, body.subarray(0, 100), body.subarray(100)]);
    assert.match(reply2, /^HTTP\/1\.1 200 /);
    const r3 = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(r3.status, 404);
    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 3, "no second, malformed request");
    assert.equal(lines[0].duplicateHead, true);
    assert.equal(lines[0].body.fileInput.size, 2009);
    assert.equal(lines[0].body.dpi, "300");
    assert.equal(lines[0].fixture, "route POST http://stirling.test:8080/api/v1/convert/pdf/img");
    assert.equal(lines[1].duplicateHead, undefined);
    assert.equal(lines[1].body.fileInput.size, 2009);
  } finally {
    server.close();
  }
});

test("P102 errorDetailOf: n8n's error as the editor's error panel shows it", async () => {
  const { errorDetailOf } = await import("../evals/bench/run.mjs");
  const d = errorDetailOf({ name: "NodeApiError", message: "Bad request - please check your parameters", description: '400 - ""', httpCode: "400", node: { name: "Split" }, stack: "NodeApiError: x" });
  assert.deepEqual(d, { node: "Split", name: "NodeApiError", message: "Bad request - please check your parameters", description: '400 - ""', httpCode: "400", stack: "NodeApiError: x" });
  assert.deepEqual(errorDetailOf({ message: "boom", context: { httpCode: 502 } }), { node: null, name: null, message: "boom", httpCode: "502" });
});

test("P102 run.mjs --n8n-check-only needs template ids (never the whole dev by default)", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "evals", "bench", "run.mjs"), "--n8n-check-only"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--n8n-check-only needs template ids/);
});
