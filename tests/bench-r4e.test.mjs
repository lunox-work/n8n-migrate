// Round-4 bench fixes (PROPOSALS P52, P53, P61, P83-P94): the pure parts, without Docker.

import { test } from "node:test";
import assert from "node:assert/strict";

test("P83: an OOM-killed n8n run is a failed baseline with status oom, never a bench error", async () => {
  const { runN8n, oomResult } = await import("../evals/bench/n8n-side.mjs");
  const shim = { setSession() {}, session: { calls: [] } };
  const prep = { id: 1, variant: "normal", files: [], models: [], routes: [], fixture: { trigger: { items: [], node: "T" }, reads: [] }, sources: {}, wf: { nodes: [] } };
  const crash = async () => {
    throw new Error("fetch failed");
  };
  const killed = () => ({ exists: true, running: false, oomKilled: true, exitCode: 137 });
  const r = await runN8n(prep, { shim, modelSession: {}, runWorkflow: crash, copyIn() {}, containerState: killed });
  assert.equal(r.result.status, "oom");
  assert.match(r.result.error.message, /memory cap .*exit 137.*fetch failed/);
  assert.equal(r.fallbackable, false);
  // A crash with the container still up (or stopped for another reason) stays a bench error.
  await assert.rejects(runN8n(prep, { shim, modelSession: {}, runWorkflow: crash, copyIn() {}, containerState: () => ({ running: true, oomKilled: false }) }), /fetch failed/);
  await assert.rejects(runN8n(prep, { shim, modelSession: {}, runWorkflow: crash, copyIn() {} }), /fetch failed/);
  assert.equal(oomResult(new Error("x")).status, "oom");
});

test("P85: a route URL without a path answers a request for /, on the mock, the in-process host and the driver's host mock alike", async () => {
  const { pickRoute } = await import("../evals/n8n/mock-server.mjs");
  const R = [{ method: "GET", url: "https://site.example", status: 200, body: "home" }];
  const sp = new URLSearchParams("");
  assert.equal(pickRoute(R, "GET", "https://site.example", "/", sp, new Map())?.f.body, "home");
  assert.equal(pickRoute(R, "GET", "https://site.example", "/other", sp, new Map()), null);
  assert.equal(pickRoute(R, "GET", null, "/", sp, new Map())?.f.body, "home", "a request to the mock directly matched by path, as before");
});

test("P84: the in-process host adds the transport headers the mock's Node server adds", async () => {
  const { transportHeaders } = await import("../evals/n8n/mock-server.mjs");
  const d = new Date("2026-11-15T14:27:03Z");
  assert.deepEqual(transportHeaders({ "content-type": "text/html" }, d), { date: "Sun, 15 Nov 2026 14:27:03 GMT", connection: "close", "transfer-encoding": "chunked" });
  assert.deepEqual(transportHeaders({ "Content-Length": "3", Date: "x" }, d), { connection: "close" }, "a fixture's own length or date wins, as in Node");
});
