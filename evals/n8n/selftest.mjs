#!/usr/bin/env node
// Self-test of the n8n-side runner on the bench's own workflows (workflows/):
// every run path, trigger injection, effect capture, credential faking and a
// model node pointed at the mock. Prints timings and container memory.
//
//   node evals/n8n/selftest.mjs [--repeat 3] [--keep-up]
//
// Starts the container if needed and stops it at the end unless --keep-up.
// Exit 1 when any expectation fails.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { up, down, memStats, IMAGE } from "./container.mjs";
import { runWorkflow, statsSampler } from "./run-workflow.mjs";

const W = join(dirname(fileURLToPath(import.meta.url)), "workflows");
const read = (f) => JSON.parse(readFileSync(join(W, f), "utf8"));
const args = process.argv.slice(2);
const repeat = args.includes("--repeat") ? Number(args[args.indexOf("--repeat") + 1]) : 3;

const sig = (r) => r.effects.map((e) => `${e.method} ${e.path}`).join(" | ");
const CASES = [
  {
    name: "a manual/set/code",
    wf: "a-manual-set-code.json",
    vias: ["pin", "cli"],
    check: (r) => r.nodes.Expand?.[0]?.items.main[0].length === 3 && r.effects.length === 0,
  },
  {
    name: "b http/if/http + header credential",
    wf: "b-http-if-http.json",
    trigger: "b.trigger.json",
    mock: "b.mock.json",
    credentials: "b.credentials.json",
    vias: ["pin", "cli"],
    check: (r) =>
      sig(r) === "GET /api/orders | POST /api/notify | POST /api/notify | POST /api/archive" &&
      r.effects[0].query.since === "2026-11-10" &&
      r.effects.filter((e) => e.path === "/api/notify").every((e) => e.headers.authorization === "Bearer dummy-bench-token-123") &&
      !r.effects[3].headers.authorization,
  },
  {
    name: "c1 schedule (synthetic trigger item)",
    wf: "c-schedule.json",
    mock: "c-schedule.mock.json",
    vias: ["pin", "cli"],
    check: (r) => r.effects.length === 1 && r.effects[0].body.hour === "09" && /Monday/.test(r.effects[0].body.text),
  },
  {
    name: "c2 webhook + Respond to Webhook",
    wf: "c-webhook.json",
    trigger: "c-webhook.trigger.json",
    mock: "c-webhook.mock.json",
    vias: ["webhook", "pin"],
    check: (r) => r.effects.length === 1 && r.effects[0].body.total === 17.5 && (r.via !== "webhook" || (r.response.status === 200 && r.response.body.ref === "ord-1001")),
  },
  {
    name: "d LLM chain -> Anthropic Messages at the mock",
    wf: "d-llm-chain.json",
    trigger: "d.trigger.json",
    mock: "d.mock.json",
    credentials: "llm.credentials.json",
    vias: ["pin"],
    check: (r) => sig(r) === "POST /v1/messages" && r.effects[0].headers["x-api-key"] === "sk-ant-bench-dummy-not-a-key" && r.effects[0].body.model === "claude-sonnet-5" && r.nodes.Summarise[0].items.main[0][0].text.includes("mock"),
  },
  {
    name: "e AI Agent + tool -> two Messages calls",
    wf: "e-llm-agent.json",
    trigger: "e.trigger.json",
    mock: "e.mock.json",
    credentials: "llm.credentials.json",
    vias: ["pin"],
    check: (r) => r.effects.length === 2 && r.effects[0].body.tools?.[0]?.name === "Stock_lookup" && r.effects[1].body.messages.at(-1).content[0].type === "tool_result" && r.nodes.Agent[0].items.main[0][0].output.includes("12"),
  },
  {
    name: "f real hostnames via HTTP(S)_PROXY",
    wf: "f-proxy-probe.json",
    mock: "f.mock.json",
    vias: ["pin"],
    // HTTPS to a host without a leaf: the mock makes one from the bench CA (PROPOSALS P26), so
    // the request is logged inside the tunnel (404, no fixture) instead of a refused CONNECT.
    check: (r) => sig(r) === "GET /v1/ping | GET /v1/secure" && r.effects[0].proxied === "http://api.example.test" && r.effects[1].proxied === "https://api.example.test" && r.effects[1].mintedLeaf === true && r.nodes["Plain HTTP"][0].items.main[0][0].pong === true,
  },
];

await up();
const idle = memStats();
console.log(`${IMAGE}; idle ${idle.used} of ${idle.limit}`);
let failed = 0;
const rows = [];
for (const c of CASES) {
  for (const via of c.vias) {
    const walls = [];
    const sampler = statsSampler(); // docker stats streams about once a second
    let ok = true;
    let note = "";
    for (let i = 0; i < repeat; i++) {
      try {
        const r = await runWorkflow(read(c.wf), {
          via,
          trigger: c.trigger ? read(c.trigger) : undefined,
          mock: c.mock ? read(c.mock) : {},
          credentials: c.credentials ? read(c.credentials) : {},
          timeoutS: 60,
        });
        walls.push(r.wallMs);
        if (r.status !== "success" || !c.check(r)) {
          ok = false;
          note = r.error?.message ?? `status ${r.status}; effects ${sig(r)}`;
        }
      } catch (e) {
        ok = false;
        note = e.message;
      }
    }
    await new Promise((r) => setTimeout(r, 2500));
    const peak = sampler.stop();
    if (!ok) failed++;
    walls.sort((a, b) => a - b);
    rows.push({ case: c.name, via, ok, medianMs: walls[Math.floor(walls.length / 2)] ?? null, peakMiB: peak, note });
    console.log(`${ok ? "ok  " : "FAIL"} ${c.name} via ${via}: median ${walls[Math.floor(walls.length / 2)]} ms of ${walls.length}, peak ${peak} MiB ${note}`);
  }
}
const after = memStats();
console.log(`after: ${after.used}`);
if (!args.includes("--keep-up")) down();
process.exit(failed ? 1 : 0);
