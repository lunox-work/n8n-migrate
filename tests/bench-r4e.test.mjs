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
