#!/usr/bin/env node
// PreToolUse hook (matcher ^Write$) the claude driver adds beside the folder's own hooks:
// when the session writes the answer to a model or agent request (.n2c/inbox/<q>.txt), the
// content is replaced with n8n's recorded reply for the same model node and call index, so
// branches driven by model output run as they did in n8n. Anything else passes untouched.
//
//   node replay-hook.mjs <recordings.json>   (stdin: the hook input; stdout: the hook output)
// recordings.json: {recordings: [{node, index, format, response}], workflow, folder}.
// Its state (request id -> call index) is kept next to it in replay-state.json.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { answerOf, runnerValue } from "./model-shim.mjs";
import { modelKeyFor } from "./claude-side.mjs";

const recFile = process.argv[2];
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    const out = handle(JSON.parse(input || "{}"));
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (e) {
    process.stderr.write(`replay hook: ${e.message}\n`);
  }
  process.exit(0);
});

function handle(h) {
  const fp = h.tool_input?.file_path ?? "";
  const m = /\.n2c\/inbox\/(q\d+)\.txt$/.exec(fp);
  if (!m) return null;
  const { recordings, workflow, folder } = JSON.parse(readFileSync(recFile, "utf8"));
  const driver = JSON.parse(readFileSync(join(folder, ".n2c", "driver.json"), "utf8"));
  const run = JSON.parse(readFileSync(join(folder, ".n2c", "run.json"), "utf8"));
  const reqId = driver.handles?.[m[1]];
  const req = (run.requests ?? []).find((r) => r.id === reqId);
  if (!req || !["model", "agent"].includes(req.kind)) return null;
  const stateFile = join(dirname(recFile), "replay-state.json");
  const st = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { ids: {}, counts: {}, log: [] };
  const step = String(reqId).split("#")[0];
  const key = modelKeyFor(workflow, step);
  if (st.ids[reqId] === undefined) {
    st.ids[reqId] = st.counts[key] ?? 0;
    st.counts[key] = st.ids[reqId] + 1;
  }
  const index = st.ids[reqId];
  const rec = recordings.filter((r) => r.node === key)[index];
  st.log.push({ id: reqId, key, index, mode: rec ? "replay" : "live" });
  writeFileSync(stateFile, JSON.stringify(st));
  if (!rec) return null;
  const v = runnerValue(req, answerOf(rec.format, rec.response));
  const content = typeof v === "string" ? v : JSON.stringify(v);
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "bench replay of n8n's recorded model reply", updatedInput: { ...h.tool_input, content } } };
}
