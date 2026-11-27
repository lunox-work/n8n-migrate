#!/usr/bin/env node
// Claude Code hooks for a migrated workflow folder (wired in .claude/settings.json):
//
//   node runtime/hook.mjs pre    PreToolUse on connector tools (matcher ^mcp__)
//   node runtime/hook.mjs post   PostToolUse on the same tools
//
// pre: a connector call goes through only when it is an outstanding runner request for that
// tool, with exactly the request's arguments once @n8m placeholders are expanded. Anything
// else is denied with the reason (containment and argument fidelity). When the input held
// placeholders, the hook returns the exact arguments as updatedInput.
// post: the tool's response is saved verbatim as the request's result
// (.n8m/results/<handle>.json), so the model never retypes a connector payload. With
// task.json hideToolOutput, the model sees only a short "saved" note instead of the payload.
//
// Run safety: for a write, pre records "sending" in the effect ledger (record store) before
// the call goes out, and refuses a write the ledger already has as sent (its stored result is
// replayed instead) or as sending (outcome unknown: check before re-sending); post records
// "sent" with the result, or "failed" when the tool answered with an error. An alert call
// must also match the definition's one alert channel (alerts.mjs).
//
// Fails closed: an error inside the pre hook denies the call.

import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { paths, loadTask, outstanding, markHooksActive, overflowResult, toolName, expandArgs, deepEqual, diffPaths, compactArgs, mcpValue, saveResult, hasResult, logEvent, RUNNER_CMD, setRunner, openStore, ledgerGet, ledgerWrite, isWrite } from "./driver.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = dirname(HERE);
// The core: runner-core.mjs beside this file in a workflow folder, index.mjs in the source tree.
export async function loadCore(dir = HERE) {
  return import(pathToFileURL(join(dir, existsSync(join(dir, "runner-core.mjs")) ? "runner-core.mjs" : "index.mjs")).href);
}

function out(o) {
  process.stdout.write(JSON.stringify(o) + "\n");
}
function deny(P, reason, extra = {}) {
  try {
    logEvent(P, { event: "hook-deny", reason, ...extra });
  } catch {}
  out({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
}

export function pre(P, input, core) {
  const task = loadTask(P);
  const name = input.tool_name;
  const args = input.tool_input ?? {};
  const { state, list } = outstanding(P);
  if (state?.runId) markHooksActive(P, state.runId);
  const pending = list.filter((x) => x.req.kind === "tool" && !hasResult(P, x.handle));
  const same = pending.filter((x) => toolName(task, x.req) === name);
  if (!same.length) {
    const want = pending.map((x) => `${toolName(task, x.req)} (${x.handle})`);
    return deny(P, `${name} is not the runner's next request${want.length ? `; the outstanding call is ${want.join(", ")}` : ""}. Do not call tools on your own: run \`${RUNNER_CMD} next\` and do only what it says.`, { tool: name, args });
  }
  for (const x of same) {
    const expanded = expandArgs(args, x.handle, x.req.args ?? {});
    if (deepEqual(expanded, x.req.args ?? {})) {
      if (x.req.purpose === "alert" && core && !core.isAllowedAlert(readDefinition(P), x.req.connector, x.req.tool, expanded)) return deny(P, `${name}: this alert does not match the workflow's alert channel; refused.`, { tool: name, handle: x.handle });
      if (isWrite(x.req) && core) {
        const store = openStore(P, task);
        const entry = ledgerGet(store, core, x.req.effectKey);
        if (entry?.status === "sent") {
          saveResult(P, x.handle, { ok: true, value: entry.result ?? null, capturedBy: "ledger" });
          return deny(P, `This write was already sent in an earlier session; its result is reused and it is not sent again. Run \`${RUNNER_CMD} next\`.`, { tool: name, handle: x.handle, ledger: "sent" });
        }
        // A "sending" mark by the driver of this checkout for this hand-out (hooks were not
        // seen yet) is this call; any other "sending" is an earlier session's.
        const own = entry?.status === "sending" && entry.by === "driver" && (readDriver(P).handed?.[x.handle] ?? 0) > 0;
        if (entry?.status === "sending" && !own) return deny(P, `This write may already have gone out in an earlier session (outcome unknown). It is not sent again; run \`${RUNNER_CMD} next\`.`, { tool: name, handle: x.handle, ledger: "sending" });
        ledgerWrite(store, core, x.req, "sending", { runId: outstanding(P).state?.runId, by: "hook" });
      }
      mkdirSync(join(P.n8m, "calls"), { recursive: true });
      writeFileSync(join(P.n8m, "calls", `${String(input.tool_use_id ?? "last").replace(/[^\w-]/g, "_")}.json`), JSON.stringify({ handle: x.handle, id: x.req.id }));
      logEvent(P, { event: "hook-allow", tool: name, handle: x.handle, expanded: !deepEqual(expanded, args) });
      if (!deepEqual(expanded, args)) {
        // No permissionDecision: the allowlist in .claude/settings.json still decides.
        return out({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: expanded } });
      }
      return;
    }
  }
  const x = same[0];
  const diff = diffPaths(expandArgs(args, x.handle, x.req.args ?? {}), x.req.args ?? {});
  return deny(P, `The arguments differ from request ${x.handle} (${diff.slice(0, 5).join(", ")}). Call ${name} again with exactly: ${JSON.stringify(compactArgs(x.req.args ?? {}, x.handle, task.hooks ? task.compactOver : 0))}`, { tool: name, handle: x.handle, diff });
}

export function post(P, input, core) {
  const task = loadTask(P);
  const callFile = join(P.n8m, "calls", `${String(input.tool_use_id ?? "last").replace(/[^\w-]/g, "_")}.json`);
  let handle;
  const { list, state } = outstanding(P);
  if (existsSync(callFile)) {
    handle = JSON.parse(readFileSync(callFile, "utf8")).handle;
    rmSync(callFile, { force: true });
  } else {
    // No record from the pre hook (it did not run): match by tool and arguments.
    const x = list.find((y) => y.req.kind === "tool" && toolName(task, y.req) === input.tool_name && deepEqual(input.tool_input ?? {}, y.req.args ?? {}) && !hasResult(P, y.handle));
    handle = x?.handle;
  }
  const req = list.find((y) => y.handle === handle)?.req;
  if (!handle) {
    logEvent(P, { event: "hook-post-unmatched", tool: input.tool_name });
    return;
  }
  const resp = input.tool_response;
  const isError = resp && typeof resp === "object" && !Array.isArray(resp) && resp.isError === true;
  const value = mcpValue(resp);
  // An oversized response arrives as Claude Code's note with the path of the full text.
  const overflow = overflowResult(typeof value === "string" ? value : null);
  const result = overflow ?? (isError ? { ok: false, error: { name: "ToolError", message: typeof value === "string" ? value : JSON.stringify(value) } } : { ok: true, value });
  saveResult(P, handle, { ...result, capturedBy: overflow ? "hook-overflow-file" : "hook" });
  if (isWrite(req) && core) ledgerWrite(openStore(P, task), core, req, result.ok ? "sent" : "failed", { runId: state?.runId, result: result.value, error: result.error });
  const bytes = overflow?.ok ? Buffer.byteLength(JSON.stringify(overflow.value)) : Buffer.byteLength(typeof resp === "string" ? resp : JSON.stringify(resp ?? null));
  logEvent(P, { event: "hook-capture", tool: input.tool_name, handle, bytes, responseType: Array.isArray(resp) ? "array" : typeof resp, ...(overflow ? { overflow: overflow.ok ? "read" : "unreadable" } : {}) });
  const note = `Saved as result ${handle} (${bytes} bytes). Now run: ${RUNNER_CMD} next`;
  if (task.hideToolOutput) out({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedMCPToolOutput: [{ type: "text", text: note }] } });
  else out({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `The runner saved this response as ${handle}; do not retype it. Next: run ${RUNNER_CMD} next` } });
}

function readDriver(P) {
  try {
    return JSON.parse(readFileSync(P.driver, "utf8"));
  } catch {
    return {};
  }
}
function readDefinition(P) {
  return JSON.parse(readFileSync(P.definition, "utf8"));
}

// Entry point for one folder (also called by the repo-root dispatcher, n8m-hook.mjs).
export async function runHook(which, input, dir = DIR) {
  const P = paths(dir, input.cwd ?? process.cwd());
  setRunner(P.dir, input.cwd ?? process.cwd());
  const core = await loadCore(dir === DIR ? HERE : join(dir, "runtime"));
  if (which === "pre") pre(P, input, core);
  else if (which === "post") post(P, input, core);
}

const isMain = process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isMain) {
  const which = process.argv[2];
  let P = paths(DIR);
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
    const input = JSON.parse(raw || "{}");
    P = paths(DIR, input.cwd ?? process.cwd());
    if (process.env.N8M_HOOK_DEBUG) {
      mkdirSync(P.n8m, { recursive: true });
      writeFileSync(join(P.n8m, `hook-${which}-${Date.now()}.json`), raw);
    }
    await runHook(which, input);
    process.exit(0);
  } catch (e) {
    if (which === "pre") {
      deny(P, `The runner's hook failed (${e.message}); the call is refused. Run \`${RUNNER_CMD} next\`.`);
      process.exit(0);
    }
    process.stderr.write(`n8m hook: ${e.message}\n`);
    process.exit(1);
  }
}
