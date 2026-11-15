// Round 4 eligibility (EXCLUSIONS.md "Round 4 eligibility", evals/bench/eligible.mjs): each
// clause on small hand-written workflows run through the real analyzer with default answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, unwrap } from "../skills/n8n-to-claude/scripts/analyze.mjs";
import { checkEligibility, callTarget, stratumOf } from "../evals/bench/eligible.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const refs = (f) => JSON.parse(readFileSync(join(ROOT, "skills/n8n-to-claude/references", f), "utf8"));
const nodesRef = refs("nodes.json");
const opts = { nodes: nodesRef, capabilities: refs("capabilities.json"), hosts: refs("http-hosts.json"), now: Date.parse("2026-11-16T00:00:00Z") };
const lists = JSON.parse(readFileSync(join(ROOT, "evals/bench/eligibility.json"), "utf8"));

const B = "n8n-nodes-base.";
const L = "@n8n/n8n-nodes-langchain.";
const node = (name, type, parameters = {}, extra = {}) => ({ name, type, typeVersion: 1, position: [0, 0], parameters, ...extra });
// A chain of nodes joined by main connections, first to last.
function chain(...ns) {
  const connections = {};
  for (let i = 0; i + 1 < ns.length; i++) connections[ns[i].name] = { main: [[{ node: ns[i + 1].name, type: "main", index: 0 }]] };
  return { nodes: ns, connections };
}
function check(wf, corpusEntry = null) {
  const report = analyze(unwrap({ workflow: { id: "t", name: "t", workflow: wf } }, "t"), opts).workflows[0];
  return checkEligibility({ wf, report, lists, nodes: nodesRef.nodes, corpusEntry });
}
const clauses = (r) => r.reasons.map((x) => x.id ?? x.clause);
const sheetsAppend = (name = "Sheet") => node(name, `${B}googleSheets`, { resource: "sheet", operation: "append", documentId: { __rl: true, mode: "id", value: "doc" }, sheetName: { __rl: true, mode: "name", value: "S" }, columns: { mappingMode: "autoMapInputData", value: {} } }, { typeVersion: 4.5, credentials: { googleSheetsOAuth2Api: { id: "1", name: "g" } } });

test("a manual workflow that writes to a sheet is eligible", () => {
  const r = check(chain(node("Start", `${B}manualTrigger`), node("Set", `${B}set`, {}, { typeVersion: 3.4 }), sheetsAppend()));
  assert.deepEqual(r.reasons, []);
  assert.equal(r.eligible, true);
  assert.equal(r.stratum, "manual");
});

test("a relay wake-up and a public chat page are out of scope", () => {
  const relay = check(chain(node("Hook", `${B}webhook`, { httpMethod: "POST", path: "x" }, { typeVersion: 2 }), sheetsAppend()));
  assert.equal(relay.eligible, false);
  assert.ok(clauses(relay).includes("relay-or-hosted"));
  const wf = chain(node("Chat", `${L}chatTrigger`, { public: true }, { typeVersion: 1.1 }), node("Agent", `${L}agent`, {}, { typeVersion: 1.8 }));
  wf.nodes.push(node("Model", `${L}lmChatOpenAi`, { model: "gpt-4o-mini" }, { typeVersion: 1.2 }));
  wf.connections.Model = { ai_languageModel: [[{ node: "Agent", type: "ai_languageModel", index: 0 }]] };
  const pub = check(wf);
  assert.ok(clauses(pub).includes("public-chat-page"), JSON.stringify(pub.reasons));
  wf.nodes[0].parameters.public = false;
  assert.equal(check(wf).eligible, true, JSON.stringify(check(wf).reasons));
});

test("a Form page and a Respond to Webhook are out of scope; a Form ending is a planned feature", () => {
  const trig = node("Form", `${B}formTrigger`, { formTitle: "f", formFields: { values: [{ fieldLabel: "a" }] } }, { typeVersion: 2.2 });
  const page = check(chain(trig, node("Page", `${B}form`, { formFields: { values: [{ fieldLabel: "b" }] } }), sheetsAppend()));
  assert.ok(clauses(page).includes("wait-on-webhook"));
  const end = check(chain(trig, sheetsAppend(), node("End", `${B}form`, { operation: "completion", completionTitle: "ok" })));
  assert.equal(end.eligible, true, JSON.stringify(end.reasons));
  const resp = check(chain({ ...trig, parameters: { ...trig.parameters, responseMode: "responseNode" } }, sheetsAppend(), node("Reply", `${B}respondToWebhook`, { respondWith: "text", responseBody: "ok" }, { typeVersion: 1.1 })));
  assert.ok(clauses(resp).includes("sync-webhook-reply"));
});

test("a sub-workflow call by id is missing from the export; a self-call is not", () => {
  assert.equal(callTarget({ workflowId: { __rl: true, mode: "id", value: "={{ $workflow.id }}" } }), "self");
  assert.equal(callTarget({ workflowId: { __rl: true, mode: "list", value: "AbC123" } }), "id");
  assert.equal(callTarget({ source: "parameter", workflowJson: "{}" }), "inline");
  const r = check(chain(node("Start", `${B}manualTrigger`), node("Call", `${B}executeWorkflow`, { workflowId: { __rl: true, mode: "list", value: "AbC123" } }, { typeVersion: 1.2 }), sheetsAppend()));
  assert.ok(clauses(r).includes("sub-workflow-missing"));
});

test("an empty required parameter and a chat model in the completion class make n8n fail on its own", () => {
  const fb = check(chain(node("Start", `${B}manualTrigger`), node("FB", `${B}facebookGraphApi`, { httpRequestMethod: "POST" }, { credentials: { facebookGraphApi: { id: "1", name: "f" } } })));
  assert.ok(clauses(fb).includes("required-empty"));
  const wf = chain(node("Start", `${B}manualTrigger`), node("Chain", `${L}chainLlm`, { prompt: "hi" }, { typeVersion: 1.5 }), sheetsAppend());
  wf.nodes.push(node("LM", `${L}lmOpenAi`, { model: { __rl: true, mode: "list", value: "gpt-4o" } }));
  wf.connections.LM = { ai_languageModel: [[{ node: "Chain", type: "ai_languageModel", index: 0 }]] };
  assert.ok(clauses(check(wf)).includes("chat-model-in-completion-class"));
  wf.nodes.at(-1).parameters.model = { __rl: true, mode: "list", value: "gpt-3.5-turbo-instruct" };
  assert.equal(check(wf).eligible, true, JSON.stringify(check(wf).reasons));
});

test("a step without a bench counterpart today is pending a bounded fix", () => {
  const mail = check(chain(node("Start", `${B}manualTrigger`), node("Mail", `${B}emailSend`, { toEmail: "a@b.c", subject: "s", text: "t" }, { typeVersion: 2.1, credentials: { smtp: { id: "1", name: "s" } } })));
  assert.deepEqual(mail.pending, ["P53"]);
  assert.equal(mail.eligible, true, JSON.stringify(mail.reasons));
  const py = check(chain(node("Start", `${B}manualTrigger`), node("Py", `${B}code`, { language: "python", pythonCode: "return []" }, { typeVersion: 2 }), sheetsAppend()));
  assert.deepEqual(py.pending, ["R4-python"]);
  const self = check(chain(node("Start", `${B}manualTrigger`), node("Get", `${B}httpRequest`, { url: "http://localhost:5678/rest/workflows" }, { typeVersion: 4.2 }), sheetsAppend()));
  assert.ok(self.pending.includes("P52"));
});

test("a node type outside the planned-feature map, a persistent-connection trigger and a hand call are ineligible", () => {
  const r = check(chain(node("Start", `${B}manualTrigger`), node("Ssh", `${B}ssh`, { command: "ls" }, { credentials: { sshPassword: { id: "1", name: "s" } } })));
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.some((x) => x.clause === "feature" || x.clause === "bench"), JSON.stringify(r.reasons));
  const imap = check(chain(node("Mail", `${B}emailReadImap`, {}, { typeVersion: 2, credentials: { imap: { id: "1", name: "i" } } }), sheetsAppend()));
  assert.ok(clauses(imap).includes("persistent-connection"));
  const ok = chain(node("Start", `${B}manualTrigger`), sheetsAppend());
  assert.ok(clauses(check(ok, { id: 1, r4Hand: "wiring hands the write no value" })).includes("hand"));
  assert.ok(clauses(check(ok, { id: 1, excluded: "tutorial" })).includes("exclusion"));
});

test("strata follow the fetch's wake-up strata", () => {
  assert.equal(stratumOf("subworkflow"), "other");
  assert.equal(stratumOf("chat"), "chat");
});
