#!/usr/bin/env node
// PROPOSALS P125: the n8n node's reads, n8n against Claude, on the bench's own n8n.
//
//   node evals/n8n/n8n-api-check.mjs [--workflow evals/n8n/workflows/n8n-api-backup.json] [--out result.json] [--keep]
//
// Gallery templates that read n8n through the n8n node (workflow backups and documentation)
// are not in the corpus, so this check stands in for a bench run of one: a pared-down nightly
// backup (evals/n8n/workflows/n8n-api-backup.json: the backup template's list-all read, plus
// a tagged list without Return All, a workflow get per item, an execution list per workflow
// with filters, an execution get with its data and a Return All execution list).
//
// 1. Seed the bench's n8n (container.mjs up) with three workflows tagged `n2c-api-check`, one
//    successful and one failed execution, and an API key with every scope.
// 2. n8n side: run the workflow in that n8n (run-workflow.mjs, kept until the end) with its
//    n8nApi credential pointed at the instance itself (http://localhost:5678/api/v1, which
//    NO_PROXY keeps off the mock).
// 3. Claude side: convert the same export with the site question answered with the instance's
//    host URL (BASE/api/v1: a loopback address, so the analyzer gives a local task), and run the
//    definition in process; its http requests go out for real (driver.mjs executeHttp) with the
//    key as the stored secret {header: "X-N8N-API-KEY", value}, under the definition's
//    allowlist and secret hosts.
// 4. Compare every read step's output items, and the Code step after the list, side by side.
//    The n8n side's own execution (still running while n8n read the lists) is left out of
//    execution lists on both sides; everything else must be equal.
// 5. Remove what it made (workflows, executions, tag, credential, API key) unless --keep.
//
// Prints {ok, outcome, steps: {<name>: {n8n, claude, equal, diff?}}}. Exit 0 when every step is
// equal, 1 otherwise. No model, no claude -p.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { up, rest, BASE } from "./container.mjs";
import { runWorkflow, scheduleItem } from "./run-workflow.mjs";
import { convertItems, loadReferences } from "../../skills/n8n-to-claude/scripts/convert.mjs";
import { unwrap } from "../../skills/n8n-to-claude/scripts/analyze.mjs";
import { run } from "../../skills/n8n-to-claude/runtime/src/api.mjs";
import { executeHttp } from "../../skills/n8n-to-claude/runtime/src/driver.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const WORKFLOW = resolve(opt("--workflow", join(HERE, "workflows", "n8n-api-backup.json")));
const OUT = opt("--out", null);
const KEEP = args.includes("--keep");
const TAG = "n2c-api-check";
const NOW = "2026-11-16T09:00:00Z";
const INSIDE = "http://localhost:5678/api/v1"; // the instance as its own nodes reach it

const seedWorkflow = (name, nodes, connections, tags) => ({ name, nodes, connections, settings: { executionOrder: "v1" }, tags });
const manual = { id: "m", name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0], parameters: {} };
const setNode = { id: "s", name: "Note", type: "n8n-nodes-base.set", typeVersion: 3.4, position: [220, 0], parameters: { mode: "manual", assignments: { assignments: [{ id: "a", name: "ok", value: true, type: "boolean" }] }, options: {} } };
const failNode = { id: "f", name: "Fail", type: "n8n-nodes-base.code", typeVersion: 2, position: [220, 0], parameters: { jsCode: "throw new Error('seeded failure');" } };
const link = (a, b) => ({ [a]: { main: [[{ node: b, type: "main", index: 0 }]] } });

function diff(a, b, path = "$", out = []) {
  if (out.length >= 5) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], `${path}.${k}`, out);
    return out;
  }
  out.push(`${path}: n8n ${JSON.stringify(a)?.slice(0, 120)} / claude ${JSON.stringify(b)?.slice(0, 120)}`);
  return out;
}

async function main() {
  await up({ log: () => {} });
  const made = { workflows: [], executions: [], tag: null, apiKey: null };
  try {
    // 1. Seed.
    const tag = await rest("POST", "/tags", { name: `${TAG}` }).catch(async () => (await rest("GET", "/tags")).find((t) => t.name === TAG));
    made.tag = tag.id;
    const seeds = [
      ["n2c api check: alpha", [manual, setNode], link("Start", "Note"), "run"],
      ["n2c api check: beta", [manual, failNode], link("Start", "Fail"), "run"],
      ["n2c api check: gamma", [manual, setNode], link("Start", "Note"), null],
    ];
    for (const [name, nodes, connections, runIt] of seeds) {
      if (runIt) {
        const r = await runWorkflow({ name, nodes, connections, settings: { executionOrder: "v1" } }, { via: "pin", keep: true, now: NOW });
        made.workflows.push(r.workflow.id);
        made.executions.push(r.executionId);
        const wf = await rest("GET", `/workflows/${r.workflow.id}`);
        await rest("PATCH", `/workflows/${r.workflow.id}`, { versionId: wf.versionId, tags: [tag.id] });
      } else {
        const w = await rest("POST", "/workflows", seedWorkflow(`bench: ${name}`, nodes, connections, [tag.id]));
        made.workflows.push(w.id);
      }
    }
    const key = await rest("POST", "/api-keys", { label: `${TAG}-${Date.now()}`, scopes: await rest("GET", "/api-keys/scopes"), expiresAt: null });
    made.apiKey = key.id;

    // 2. n8n side.
    const source = JSON.parse(readFileSync(WORKFLOW, "utf8"));
    const credName = source.nodes.find((n) => n.credentials?.n8nApi).credentials.n8nApi.name;
    const n8n = await runWorkflow(source, { via: "pin", keep: true, now: NOW, credentials: { [credName]: { apiKey: key.rawApiKey, baseUrl: INSIDE } } });
    made.workflows.push(n8n.workflow.id);
    made.executions.push(n8n.executionId);

    // 3. Claude side.
    const [res] = convertItems(unwrap({ ...source, id: "n8n-api-check" }, "n8n-api-backup.json"), { refs: loadReferences(), now: Date.parse(NOW), answers: { [`n8n-api-check/site/${credName}`]: `${BASE}/api/v1` } });
    if (!res.definition) throw new Error(`the converter refused the workflow: ${res.report.workflows[0].outcome.reason}`);
    const report = res.report.workflows[0];
    const def = res.definition;
    const secret = JSON.stringify({ header: "X-N8N-API-KEY", value: key.rawApiKey });
    const host = { http: async (req) => {
      const r = await executeHttp(req, { secrets: () => secret });
      if (!r.ok) throw Object.assign(new Error(r.error.message), { name: r.error.name });
      return r.value;
    } };
    const trigger = { node: "Schedule Trigger", items: [{ json: n8n.trigger.items[0] }] };
    const claude = await run(def, { trigger, host, mode: "trigger", clock: { startedAt: NOW } });

    // 4. Compare.
    const own = String(n8n.executionId);
    const items = (side, name) => {
      const runs = side === "n8n" ? n8n.executionData.runData?.[name] : claude.runData?.[name];
      const list = (runs ?? []).flatMap((r) => (r?.data?.main?.[0] ?? []).map((it) => it.json));
      return list.filter((j) => !(name !== "n8n" && name !== "Tagged workflows" && name !== "Get workflow" && name !== "Backup files" && String(j?.id) === own));
    };
    const steps = {};
    for (const n of source.nodes.filter((x) => x.type !== "n8n-nodes-base.scheduleTrigger").map((x) => x.name)) {
      const a = items("n8n", n);
      const b = items("claude", n);
      const equal = JSON.stringify(a) === JSON.stringify(b);
      steps[n] = { n8n: a.length, claude: b.length, equal, ...(equal ? {} : { diff: diff(a, b) }) };
    }
    const result = {
      ok: Object.values(steps).every((s) => s.equal) && n8n.status === "success" && claude.status === "done",
      n8nStatus: n8n.status,
      claudeStatus: claude.status,
      ...(claude.error ? { claudeError: claude.error } : {}),
      outcome: { kind: report.outcome.kind, target: report.outcome.target, reason: report.outcome.reason },
      allowHttp: def.allow.http,
      secrets: def.secrets,
      steps,
    };
    if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 2) + "\n");
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result.ok ? 0 : 1;
  } finally {
    if (!KEEP) {
      for (const id of made.executions) await rest("POST", "/executions/delete", { ids: [id] }).catch(() => {});
      for (const id of made.workflows) {
        await rest("POST", `/workflows/${id}/archive`, {}).catch(() => {});
        await rest("DELETE", `/workflows/${id}`).catch(() => {});
      }
      for (const c of (await rest("GET", "/credentials").catch(() => [])) ?? []) if (c.type === "n8nApi") await rest("DELETE", `/credentials/${c.id}`).catch(() => {});
      if (made.tag) await rest("DELETE", `/tags/${made.tag}`).catch(() => {});
      if (made.apiKey) await rest("DELETE", `/api-keys/${made.apiKey}`).catch(() => {});
    }
  }
}

process.exitCode = await main();
