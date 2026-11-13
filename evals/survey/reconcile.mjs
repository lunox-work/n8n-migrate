#!/usr/bin/env node
// Puts the analyzer's numbers next to the PLAN survey tables, and lists every
// template whose analyzer outcome differs from what the survey implied.
//
//   node evals/survey/reconcile.mjs <report.json> <corpus dir> [--markdown]
//
// <report.json>: `analyze.mjs <corpus dir> --json` output. <corpus dir>: the
// template files (evals/survey/data/wf). The survey side is a port of
// levers.py (lever sets, hard blocks) and classify.py (wake-up groups), so
// both columns come from the same files. Zero dependencies.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const [reportPath, dir] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const MD = process.argv.includes("--markdown");
if (!reportPath || !dir) {
  console.error("usage: reconcile.mjs <report.json> <corpus dir> [--markdown]");
  process.exit(2);
}
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const templates = new Map();
for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  const t = JSON.parse(readFileSync(join(dir, f), "utf8")).workflow;
  templates.set(String(t.id), t);
}

// ---------- survey side: port of levers.py need() and classify.py ----------

const set = (s) => new Set(s.split(/\s+/).filter(Boolean));
const PURE = set("stickyNote set code if merge switch splitOut splitInBatches aggregate filter markdown html noOp limit htmlExtract itemLists removeDuplicates summarize stopAndError dateTime sort function functionItem executionData debugHelper n8nTrainingCustomerDatastore manualTrigger scheduleTrigger respondToWebhook form wait");
const MODEL = set("lmChatOpenAi lmChatGoogleGemini lmChatOllama lmOpenAi lmOllama lmChatAnthropic lmChatOpenRouter lmOpenHuggingFaceInference chainLlm chainSummarization informationExtractor textClassifier outputParserStructured outputParserAutofixing");
const CONNECTOR = set("gmail googleDrive notion slack googleDocs googleSheets microsoftOutlook github microsoftExcel microsoftOneDrive");
const AGENT = set("agent memoryBufferWindow toolCalculator toolThink toolCode");
const AGENT_CONN = set("googleCalendarTool gmailTool googleDocsTool googleSheetsTool mcpClientTool");
const HTTP = set("httpRequest telegram whatsApp facebookGraphApi twitter linkedIn wordpress youTube discord uproc blotato googleAnalytics dropbox s3 n8n rssFeedRead hackerNews");
const AGENT_HTTP = set("toolHttpRequest httpRequestTool toolSerpApi toolWikipedia rssFeedReadTool baserowTool");
const DB = set("postgres supabase mongoDb mySql redis");
const AGENT_DB = set("postgresTool memoryPostgresChat");
const VECTOR = set("vectorStorePinecone vectorStoreInMemory vectorStoreQdrant vectorStoreSupabase vectorStorePGVector vectorStoreMongoDBAtlas embeddingsOpenAi embeddingsGoogleGemini documentDefaultDataLoader textSplitterRecursiveCharacterTextSplitter textSplitterTokenSplitter toolVectorStore");
const FILES = set("extractFromFile readBinaryFile writeBinaryFile convertToFile spreadsheetFile readWriteFile readPDF executeCommand");
const POLL = set("gmailTrigger googleDriveTrigger googleSheetsTrigger");
const RELAY = set("telegramTrigger whatsAppTrigger");
const BLOCK = { mcpTrigger: "n8n as MCP server", errorTrigger: "error workflow", emailSend: "SMTP", youtubeTranscripter: "community node" };

function surveyNeed(wf) {
  const L = new Set();
  const B = new Set();
  for (const n of wf.nodes || []) {
    if (n.disabled) continue;
    const s = String(n.type || "").split(".").pop();
    const p = n.parameters || {};
    if (PURE.has(s) || MODEL.has(s) || CONNECTOR.has(s)) continue;
    if (AGENT.has(s) || AGENT_CONN.has(s)) L.add("agent");
    else if (HTTP.has(s)) L.add("http");
    else if (AGENT_HTTP.has(s)) L.add("agent").add("http");
    else if (DB.has(s)) L.add("db");
    else if (AGENT_DB.has(s)) L.add("agent").add("db");
    else if (VECTOR.has(s)) L.add("vector");
    else if (FILES.has(s)) L.add("files");
    else if (POLL.has(s)) L.add("poll");
    else if (RELAY.has(s)) L.add("relay");
    else if (s === "chatTrigger") L.add("chat");
    else if (s === "formTrigger") L.add("form");
    else if (s === "webhook") {
      if ((p.responseMode ?? "onReceived") === "onReceived") L.add("relay");
      else B.add("sync webhook reply");
    } else if (s === "openAi") {
      const r = p.resource ?? "text";
      const o = p.operation ?? "";
      if (r === "text" || r === "chat" || (r === "image" && o === "analyze"));
      else if (r === "assistant") L.add("agent");
      else L.add("http").add("media");
    } else if (["executeWorkflow", "toolWorkflow", "executeWorkflowTrigger"].includes(s)) {
      if (s === "toolWorkflow") L.add("agent");
      if (s === "executeWorkflowTrigger") {
        L.add("subwf");
        continue;
      }
      const w = p.workflowId;
      const v = w && typeof w === "object" ? w.value : w;
      if ((typeof v === "string" && v.includes("$workflow")) || p.source === "parameter") L.add("subwf");
      else B.add("external sub-workflow");
    } else if (BLOCK[s]) B.add(BLOCK[s]);
  }
  return { levers: L, blocks: B };
}

// classify.py wake-up groups.
function surveyWake(wf) {
  const short = (wf.nodes || []).map((n) => String(n.type || "").split(".").pop());
  const ts = new Set(short.filter((s) => s.toLowerCase().endsWith("trigger") || ["webhook", "cron", "interval", "start"].includes(s)));
  const nonManual = [...ts].filter((t) => !["manualTrigger", "start"].includes(t));
  if (!ts.size || !nonManual.length) return "manual";
  if (nonManual.every((t) => ["scheduleTrigger", "cron", "interval"].includes(t))) return "schedule";
  if (nonManual.some((t) => ["webhook", "chatTrigger", "formTrigger", "mcpTrigger"].includes(t))) return "listener";
  return "app";
}

// What the survey implied for one template's outcome. The worst block wins:
// an external sub-workflow or a community node keeps it in n8n, a synchronous
// webhook reply hosts it, n8n as an MCP server is replaced. SMTP and an error
// trigger were hard blocks in levers.py, but the survey's outcome table counts
// them as runnable after a substitution or a dropped branch.
function surveyOutcome(b) {
  if (b.has("external sub-workflow") || b.has("community node")) return "keep-in-n8n";
  if (b.has("sync webhook reply")) return "hosted";
  if (b.has("n8n as MCP server")) return "replaced";
  return "subscription";
}

// ---------- analyzer side ----------

const W = report.workflows;
const byId = new Map(W.map((w) => [w.id, w]));
const ids = [...templates.keys()].filter((id) => byId.has(id)).sort((a, b) => Number(a) - Number(b));
const survey = new Map(ids.map((id) => [id, { ...surveyNeed(templates.get(id).workflow || {}), wake: surveyWake(templates.get(id).workflow || {}) }]));

const out = [];
const table = (head, rows) => {
  if (MD) {
    out.push(`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`);
    for (const r of rows) out.push(`| ${r.join(" | ")} |`);
  } else {
    const w = head.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i]).length)));
    const line = (r) => r.map((x, i) => String(x).padEnd(w[i])).join("  ");
    out.push(line(head), ...rows.map(line));
  }
  out.push("");
};
const title = (t) => out.push(MD ? `### ${t}\n` : `== ${t}`);
const count = (f) => ids.filter((id) => f(byId.get(id), id)).length;
const triggerType = (w) => w.steps.find((s) => s.node === w.wakeup.nodes[0])?.type ?? "";

// Wake-up
title("Wake-up");
const listenerRelay = (w) => w.wakeup.kind === "relay" && /\.(webhook|formTrigger)$/.test(triggerType(w));
const groups = [
  ["Webhook, chat or form trigger", 45, "listener", (w) => ["endpoint", "mcp-server", "chat", "form"].includes(w.wakeup.kind) || listenerRelay(w)],
  ["App trigger (Telegram, WhatsApp, Gmail, Drive)", 24, "app", (w) => (w.wakeup.kind === "relay" && !listenerRelay(w)) || w.wakeup.kind === "poll"],
  ["Manual only", 20, "manual", (w) => ["manual", "subworkflow"].includes(w.wakeup.kind)],
  ["Schedule", 11, "schedule", (w) => w.wakeup.kind === "schedule"],
  ["Error trigger only", 0, null, (w) => w.wakeup.kind === "error"],
];
table(
  ["Wake-up", "PLAN", "survey port", "analyzer"],
  groups.map(([label, plan, g, f]) => [label, plan, g ? ids.filter((id) => survey.get(id).wake === g).length : 0, count(f)]),
);
table(
  ["Analyzer wake-up kind", "Templates"],
  Object.entries(report.summary.wakeups).map(([k, n]) => [k, n]),
);

// Contents
title("Contents");
const hasType = (w, re) => w.steps.some((s) => re.test(s.type));
const pin = (id) => {
  const p = templates.get(id).workflow?.pinData;
  return p && typeof p === "object" && Object.keys(p).length > 0;
};
const waitWebhook = (id) => (templates.get(id).workflow?.nodes || []).some((n) => /\.wait$/.test(n.type) && !n.disabled && ["webhook", "form"].includes(n.parameters?.resume));
table(
  ["Contents (enabled nodes)", "PLAN", "analyzer"],
  [
    ["LangChain nodes", 78, count((w) => hasType(w, /^@n8n\/n8n-nodes-langchain\./))],
    ["AI Agent node", 51, count((w) => hasType(w, /^@n8n\/n8n-nodes-langchain\.agent$/))],
    ["HTTP Request node", 54, count((w) => hasType(w, /\.httpRequest$/))],
    ["Code node", 35, count((w) => hasType(w, /^n8n-nodes-base\.(code|function|functionItem)$/))],
    ["Wait node", 17, count((w) => hasType(w, /^n8n-nodes-base\.wait$/))],
    ["Wait node resuming on a webhook or form", 0, count((w, id) => waitWebhook(id))],
    ["pinData present", 7, count((w, id) => pin(id))],
    ["Tutorials about n8n itself (not-an-automation)", "about 8", report.summary.notAnAutomation],
    ["LLM API called over HTTP (llm-api lever)", "not counted", count((w) => w.levers.includes("llm-api"))],
  ],
);

// Lever eligibility. Survey: templates without a hard block in levers.py.
// Analyzer: templates with outcome subscription (substitutions and dropped
// branches included). llm-api counts from the first row: the call runs as a
// model step once the substitution is approved.
title("Eligibility as each lever is added");
const ORDER = [["None: logic, model steps, first-party connectors", []], ["agent step, self-calling sub-workflows inlined", ["agent", "subwf"]], ["http step with stored secrets", ["http"]], ["Media through the original provider", ["media"]], ["Files in the script", ["files"]], ["Poll for Gmail, Drive and Sheets triggers", ["poll"]], ["Chat trigger becomes a skill", ["chat"]], ["Form trigger becomes an artifact form", ["form"]], ["Database through MCP or a driver", ["db"]], ["Vector store through MCP", ["vector"]], ["Relay to the cloud task's API trigger", ["relay"]]];
const PLAN_ELIG = [[null, 8], [53, 9], [73, 23], [16, 25], [18, 28], [7, 32], [28, 48], [9, 56], [9, 61], [11, 68], [15, 83]];
const surveyOk = ids.filter((id) => survey.get(id).blocks.size === 0);
const anaOk = ids.filter((id) => byId.get(id).outcome.kind === "subscription");
const haveS = new Set();
const haveA = new Set(["llm-api"]);
const rows = [];
ORDER.forEach(([label, ls], i) => {
  ls.forEach((l) => (haveS.add(l), haveA.add(l)));
  // "needing" counts the row's first lever, as the PLAN does (agent for the
  // agent + sub-workflow row).
  const needS = ls.length ? ids.filter((id) => survey.get(id).levers.has(ls[0])).length : "n/a";
  const needA = ls.length ? count((w) => w.levers.includes(ls[0])) : "n/a";
  const cumS = surveyOk.filter((id) => [...survey.get(id).levers].every((l) => haveS.has(l))).length;
  const cumA = anaOk.filter((id) => byId.get(id).levers.every((l) => haveA.has(l))).length;
  rows.push([label, PLAN_ELIG[i][0] ?? "n/a", needS, needA, PLAN_ELIG[i][1], cumS, cumA]);
});
table(["Lever", "needing: PLAN", "port", "analyzer", "cumulative: PLAN", "port", "analyzer"], rows);

// Outcomes
title("Outcomes");
const o = (k, t) => count((w) => w.outcome.kind === k && (t === undefined || w.outcome.target === t));
const openOutcomeQ = (w) => w.questions.some((q) => q.affects === "outcome" && q.answer === null && Object.values(q.options).some((v) => v.startsWith("subscription") || v === "replaced"));
const onlyIncomplete = (w) => w.outcome.kind === "keep-in-n8n" && w.blockers.filter((b) => ["input-incomplete", "unsupported", "unmapped"].includes(b.kind)).every((b) => b.kind === "input-incomplete");
const surveyOut = new Map(ids.map((id) => [id, surveyOutcome(survey.get(id).blocks)]));
table(
  ["Outcome", "PLAN best case", "survey port", "analyzer (defaults)", "analyzer, if answers favour moving"],
  [
    ["Runs on the subscription", "87 to 93", [...surveyOut.values()].filter((x) => x === "subscription").length, o("subscription"), o("subscription") + count((w) => w.outcome.kind === "hosted" && openOutcomeQ(w)) + count(onlyIncomplete)],
    ["Replaced by Claude itself", 2, [...surveyOut.values()].filter((x) => x === "replaced").length, o("replaced"), o("replaced")],
    ["Hosted elsewhere, no model", 3, "", o("hosted", "no-key"), count((w) => w.outcome.kind === "hosted" && w.outcome.target === "no-key" && !openOutcomeQ(w))],
    ["Hosted elsewhere, API key", "2 to 8", "", o("hosted", "key"), count((w) => w.outcome.kind === "hosted" && w.outcome.target === "key" && !openOutcomeQ(w))],
    ["Hosted elsewhere, all (survey port: synchronous webhook replies only)", "", [...surveyOut.values()].filter((x) => x === "hosted").length, o("hosted"), ""],
    ["Kept in n8n", "", [...surveyOut.values()].filter((x) => x === "keep-in-n8n").length, o("keep-in-n8n"), o("keep-in-n8n") - count(onlyIncomplete)],
  ],
);
table(
  ["Subscription target", "analyzer"],
  Object.entries(report.summary.targets)
    .filter(([k]) => k.startsWith("subscription:"))
    .map(([k, n]) => [k.slice(13), n]),
);
out.push(`"if answers favour moving": endpoint callers and chat-app users are only you (or nobody waits), MCP clients only Claude, form and chat users inside the organisation, and every missing sub-workflow is in the export or is the workflow itself.`, "");

// Disagreements
title("Templates whose analyzer outcome differs from the survey's");
const diffs = ids.filter((id) => surveyOut.get(id) !== byId.get(id).outcome.kind);
table(
  ["Template", "Survey", "Analyzer", "Analyzer reason (cut)"],
  diffs.map((id) => {
    const w = byId.get(id);
    const s = survey.get(id);
    return [id, `${surveyOut.get(id)}${s.blocks.size ? ` (${[...s.blocks].join(", ")})` : ""}`, `${w.outcome.kind}${w.outcome.target ? `:${w.outcome.target}` : ""}`, w.outcome.reason.slice(0, 90).replace(/\|/g, "/")];
  }),
);
out.push(`${diffs.length} of ${ids.length} templates differ.`);
process.stdout.write(out.join("\n") + "\n");
