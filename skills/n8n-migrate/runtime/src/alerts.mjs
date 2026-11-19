// Run alerts: a failed run, a missed run and a write whose outcome is unknown
// notify the person through the one channel chosen at setup.
//
// definition.alerts = {channel: {connector, tool, target}}; the converter also lists the
// channel in definition.allow.alerts, its own category: an alert can go only to that target,
// with a fixed template, so a hostile tool response cannot turn the alert path into a way to
// post elsewhere or relay its text. The template carries the workflow name, the step name, an
// error class, the run id and counts; never an error message or payload data. Names come from
// the definition (the person's own workflow) and are cleaned: no line breaks, no angle
// brackets (Slack mentions), cut to 80 characters.
//
// Without a channel the task's final message states the failure (cloud task sessions are
// visible to the person); alertRequest returns null.
//
// Browser-safe and pure.

import { isObject } from "./util.mjs";
import { hashHex } from "./hash.mjs";

// The tools an alert can use, and how the fixed text becomes their arguments.
export const ALERT_TOOLS = {
  "slack.slack_send_message": (target, m) => ({ channel_id: target, message: m.text }),
  "gmail.create_draft": (target, m) => ({ to: [target], subject: m.subject, body: m.text }),
  "gmail.send_message": (target, m) => ({ to: [target], subject: m.subject, body: m.text }),
};
export const ALERT_KINDS = ["failed", "missed", "needs-check"];

export function cleanName(s, max = 80) {
  const t = String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t || "unnamed";
}
const errorClass = (e) => (/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(String(e ?? "")) ? String(e) : "Error");
const safeId = (s) => String(s ?? "").replace(/[^\w.:-]+/g, "").slice(0, 64) || "unknown";
const safeTime = (s) => (Number.isFinite(Date.parse(s ?? "")) ? new Date(Date.parse(s)).toISOString().replace(/\.\d{3}Z$/, "Z") : "an unknown time");

// The fixed message. info: {workflow, runId, step?, errorClass?, count?, since?, tool?}
export function alertMessage(kind, info = {}) {
  const wf = `"${cleanName(info.workflow)}"`;
  const run = safeId(info.runId);
  const step = info.step ? ` at step "${cleanName(info.step)}"` : "";
  let text;
  let subject;
  if (kind === "failed") {
    text = `n8n-migrate: run ${run} of ${wf} failed${step} (${errorClass(info.errorClass)}). The run record has the details; nothing after that step ran.`;
    subject = `Workflow failed: ${cleanName(info.workflow, 60)}`;
  } else if (kind === "missed") {
    const n = Math.max(0, Math.floor(Number(info.count) || 0));
    text = `n8n-migrate: ${wf} missed ${n}${info.capped ? " or more" : ""} scheduled run${n === 1 ? "" : "s"} since ${safeTime(info.since)}. Check that the scheduled task is enabled and the computer (for a local task) was on.`;
    subject = `Workflow missed runs: ${cleanName(info.workflow, 60)}`;
  } else if (kind === "needs-check") {
    text = `n8n-migrate: run ${run} of ${wf} stopped${step}: a write was going out when an earlier session ended, and it is not known whether it was sent${info.tool ? ` (${cleanName(info.tool, 60)})` : ""}. Check before re-sending; it is never sent again on its own.`;
    subject = `Workflow needs a check: ${cleanName(info.workflow, 60)}`;
  } else throw new Error(`unknown alert kind ${kind}`);
  return { kind, text, subject };
}

export function alertChannel(definition) {
  const ch = definition?.alerts?.channel;
  if (!isObject(ch) || !ch.connector || !ch.tool || !ch.target) return null;
  if (!ALERT_TOOLS[`${ch.connector}.${ch.tool}`]) return null;
  const listed = (definition.allow?.alerts ?? []).some((a) => a.connector === ch.connector && a.tool === ch.tool && a.target === ch.target);
  return listed ? ch : null;
}

// The request a driver hands out for an alert, or null without a usable channel. The effect
// key makes a resent alert for the same event a ledger replay, not a second message.
export function alertRequest(definition, kind, info = {}) {
  const ch = alertChannel(definition);
  if (!ch) return null;
  const m = alertMessage(kind, { workflow: definition.name, ...info });
  const args = ALERT_TOOLS[`${ch.connector}.${ch.tool}`](ch.target, m);
  const effectKey = `alert-${hashHex("sha256", `${kind}|${safeId(info.runId)}|${info.since ?? ""}|${info.count ?? ""}`).slice(0, 16)}`;
  return { kind: "tool", purpose: "alert", alert: kind, step: "(alert)", connector: ch.connector, tool: ch.tool, args, effect: "write", effectKey };
}

// Is this tool call exactly an alert the definition allows? (hooks: containment for alerts)
export function isAllowedAlert(definition, connector, tool, args) {
  const ch = alertChannel(definition);
  if (!ch || ch.connector !== connector || ch.tool !== tool) return false;
  const want = ALERT_TOOLS[`${connector}.${tool}`](ch.target, { text: "", subject: "" });
  for (const [k, v] of Object.entries(want)) if (k !== "message" && k !== "body" && k !== "subject" && JSON.stringify(args?.[k]) !== JSON.stringify(v)) return false;
  return true;
}
