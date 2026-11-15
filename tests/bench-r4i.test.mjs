// Bench fixes of session R4i: P102 (the canned n8n check on its own). No Docker.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
