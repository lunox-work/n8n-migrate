#!/usr/bin/env node
// PreToolUse hook (matcher ^Write$) the claude driver adds beside the folder's own hooks:
// when the session writes the answer to a model or agent request (.n8m/inbox/<q>.txt), the
// content is replaced with n8n's recorded reply for the same model node and call index (or the
// node's unused call asked the same thing, PROPOSALS P76), so
// branches driven by model output run as they did in n8n. Anything else passes untouched.
//
//   node replay-hook.mjs <recordings.json>   (stdin: the hook input; stdout: the hook output)
// recordings.json: {recordings: [{node, index, format, response}], workflow, folder}.
// Its state (request id -> call index, and a log of each replayed request with its time,
// PROPOSALS P16) is kept next to it in replay-state.json.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { answerOf, runnerValue } from "./model-shim.mjs";
import { replayPick } from "./claude-side.mjs";

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
  const m = /\.n8m\/inbox\/(q\d+)\.txt$/.exec(fp);
  if (!m) return null;
  const { recordings, workflow, folder, runTime = null } = JSON.parse(readFileSync(recFile, "utf8"));
  const driver = JSON.parse(readFileSync(join(folder, ".n8m", "driver.json"), "utf8"));
  const run = JSON.parse(readFileSync(join(folder, ".n8m", "run.json"), "utf8"));
  const reqId = driver.handles?.[m[1]];
  const req = (run.requests ?? []).find((r) => r.id === reqId);
  if (!req || !["model", "agent"].includes(req.kind)) return null;
  const stateFile = join(dirname(recFile), "replay-state.json");
  const st = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { ids: {}, counts: {}, log: [] };
  const { key, index, rec, pairedBy } = replayPick({ recordings, workflow, state: st, reqId, req, runTime });
  // PROPOSALS P16: the request this reply answers and when, so the bench can check the
  // question (sameModelInput) and an agent turn's tools (sameToolTurn) as it does in process.
  // A second write of the same answer is marked, and only the first counts.
  const repeat = st.log.some((e) => e.id === reqId);
  st.log.push({ id: reqId, key, index, mode: rec ? "replay" : "live", t: new Date().toISOString(), ...(pairedBy ? { pairedBy } : {}), ...(repeat ? { repeat: true } : { req }) });
  writeFileSync(stateFile, JSON.stringify(st));
  if (!rec) return null;
  const v = runnerValue(req, answerOf(rec.format, rec.response));
  const content = typeof v === "string" ? v : JSON.stringify(v);
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "bench replay of n8n's recorded model reply", updatedInput: { ...h.tool_input, content } } };
}
