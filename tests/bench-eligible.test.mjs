// Round 4 eligibility (EXCLUSIONS.md "Round 4 eligibility", evals/bench/eligible.mjs): each
// clause on small hand-written workflows run through the real analyzer with default answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, unwrap } from "../skills/n8n-to-claude/scripts/analyze.mjs";
import { checkEligibility, callTarget, stratumOf, pythonRefusals, extractParams } from "../evals/bench/eligible.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const refs = (f) => JSON.parse(readFileSync(join(ROOT, "skills/n8n-to-claude/references", f), "utf8"));
const nodesRef = refs("nodes.json");
const opts = { nodes: nodesRef, capabilities: refs("capabilities.json"), hosts: refs("http-hosts.json"), now: Date.parse("2026-11-16T00:00:00Z") };
const lists = JSON.parse(readFileSync(join(ROOT, "evals/bench/eligibility.json"), "utf8"));
const params = JSON.parse(readFileSync(join(ROOT, lists.n8nSelfFail.amendment1.params), "utf8"));

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
  return checkEligibility({ wf, report, lists, nodes: nodesRef.nodes, corpusEntry, params });
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
  const wf = chain(node("Start", `${B}manualTrigger`), node("Chain", `${L}chainLlm`, { promptType: "define", text: "hi" }, { typeVersion: 1.5 }), sheetsAppend());
  wf.nodes.push(node("LM", `${L}lmOpenAi`, { model: { __rl: true, mode: "list", value: "gpt-4o" } }));
  wf.connections.LM = { ai_languageModel: [[{ node: "Chain", type: "ai_languageModel", index: 0 }]] };
  assert.ok(clauses(check(wf)).includes("chat-model-in-completion-class"));
  wf.nodes.at(-1).parameters.model = { __rl: true, mode: "list", value: "gpt-3.5-turbo-instruct" };
  assert.equal(check(wf).eligible, true, JSON.stringify(check(wf).reasons));
});

test("a step without a bench counterpart today is pending a bounded fix", () => {
  const mail = check(chain(node("Start", `${B}manualTrigger`), node("Mail", `${B}emailSend`, { toEmail: "a@b.c", subject: "s", text: "t" }, { typeVersion: 2.1, credentials: { smtp: { id: "1", name: "s" } } })));
  assert.deepEqual([mail.pending, mail.built], [[], ["P53"]], "P53 is built (R4e): a capability now, no longer pending");
  assert.equal(mail.eligible, true, JSON.stringify(mail.reasons));
  const py = check(chain(node("Start", `${B}manualTrigger`), node("Py", `${B}code`, { language: "python", pythonCode: "return []" }, { typeVersion: 2 }), sheetsAppend()));
  assert.deepEqual(py.built, ["P92"]);
  const self = check(chain(node("Start", `${B}manualTrigger`), node("Get", `${B}httpRequest`, { url: "http://localhost:5678/rest/workflows" }, { typeVersion: 4.2 }), sheetsAppend()));
  assert.ok(self.built.includes("P52"));
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

// Amendment 1 (EXCLUSIONS.md "Round 4 eligibility, amendment 1"): self-fail clauses read from the
// template and n8n's own node descriptions (eligibility-params.json).
const amended = (r) => r.reasons.filter((x) => x.amendment === 1).map((x) => x.id);

test("amendment 1 (a): a required parameter n8n's description declares, left empty, unless it is the person's own resource", () => {
  const uproc = (extra = {}) => node("uProc", `${B}uproc`, { group: "geographic", tool: "getCountryNormalized", country: "={{ $json.country }}", additionalOptions: {}, ...extra });
  const r = check(chain(node("Start", `${B}manualTrigger`), uproc(), sheetsAppend()));
  assert.deepEqual(amended(r), ["required-empty"], JSON.stringify(r.reasons));
  assert.match(r.reasons.find((x) => x.amendment).detail, /Parameter "Language" is required/);
  assert.equal(r.eligible, false);
  assert.equal(r.baseEligible, true, "eligible under the clauses as first committed");
  assert.deepEqual(amended(check(chain(node("Start", `${B}manualTrigger`), uproc({ language: "en" }), sheetsAppend()))), []);
  // n8n checks no pinned node.
  const pinned = chain(node("Start", `${B}manualTrigger`), uproc(), sheetsAppend());
  pinned.pinData = { uProc: [{ json: { country: "IT" } }] };
  assert.deepEqual(amended(check(pinned)), []);
  // P91 placeholders: a recipient, a resource locator, a value loaded from the account.
  const mail = node("Mail", `${B}gmail`, { sendTo: "", subject: "s", message: "m" }, { typeVersion: 2.1, credentials: { gmailOAuth2: { id: "1", name: "g" } } });
  assert.deepEqual(amended(check(chain(node("Start", `${B}manualTrigger`), mail))), []);
  const sheet = sheetsAppend();
  sheet.parameters.documentId = { __rl: true, mode: "list", value: "" };
  assert.deepEqual(amended(check(chain(node("Start", `${B}manualTrigger`), sheet))), []);
  // Content left empty is not a placeholder.
  mail.parameters.subject = "";
  assert.deepEqual(amended(check(chain(node("Start", `${B}manualTrigger`), mail))), ["required-empty"]);
});

test("amendment 1 (a): a list rule for a refusal in the node's code (LinkedIn's empty post text)", () => {
  const li = (parameters) => node("LinkedIn", `${B}linkedIn`, { postAs: "person", additionalFields: {}, ...parameters }, { credentials: { linkedInOAuth2Api: { id: "1", name: "l" } } });
  const r = check(chain(node("Start", `${B}manualTrigger`), li({})));
  assert.deepEqual(amended(r), ["required-empty"], JSON.stringify(r.reasons));
  assert.match(r.reasons.find((x) => x.amendment).detail, /The Text field is empty/);
  assert.deepEqual(amended(check(chain(node("Start", `${B}manualTrigger`), li({ text: "={{ $json.post }}" })))), []);
});

test("amendment 1 (b): Python the native runner refuses (Pyodide-era constructs, top-level await, third-party imports)", () => {
  const P = lists.n8nSelfFail.amendment1.python;
  const what = (src) => pythonRefusals(src, P).map((h) => h.what);
  assert.deepEqual(what("items = _items\nreturn [{'json': {'n': len(items)}}]"), []);
  assert.deepEqual(what("import json, re\nfrom datetime import datetime\nreturn []"), []);
  assert.deepEqual(what("x = _input.first().json\nreturn [x]"), ["reads _input"]);
  assert.deepEqual(what("import micropip\nawait micropip.install('x')"), ["uses micropip, Pyodide's package installer", "`await` outside an async function"]);
  assert.deepEqual(what("async def f():\n    await g()\nreturn []"), []);
  assert.deepEqual(what("v = p.vector.to_py()"), ["converts a Pyodide JsProxy (.to_py())"]);
  assert.deepEqual(what("import numpy as np\nfrom sklearn.cluster import KMeans"), ["imports numpy, which is not in Python's standard library", "imports sklearn, which is not in Python's standard library"]);
  assert.deepEqual(what("try:\n    import numpy\nexcept ImportError:\n    numpy = None"), [], "an import inside try: is a fallback");
  assert.deepEqual(what("# _input and micropip in a comment\ns = '_input await'\nreturn []"), [], "comments and strings do not count");
  const wf = chain(node("Start", `${B}manualTrigger`), node("Py", `${B}code`, { language: "python", pythonCode: "return [{'json': _input.first().json}]" }, { typeVersion: 2 }), sheetsAppend());
  const r = check(wf);
  assert.deepEqual(amended(r), ["python-refused"], JSON.stringify(r.reasons));
  assert.deepEqual(r.built, ["P92"]);
  wf.nodes[1].parameters.pythonCode = "return [{'json': {'n': len(_items)}}]";
  assert.deepEqual(amended(check(wf)), []);
});

test("amendment 1 (c): a prompt taken from the input's chatInput with nothing on the main path to supply it", () => {
  const withModel = (wf, agent) => {
    wf.nodes.push(node("Model", `${L}lmChatOpenAi`, { model: "gpt-4o-mini" }, { typeVersion: 1.2 }));
    wf.connections.Model = { ai_languageModel: [[{ node: agent, type: "ai_languageModel", index: 0 }]] };
    return wf;
  };
  const sched = node("Every day", `${B}scheduleTrigger`, { rule: { interval: [{ field: "days" }] } }, { typeVersion: 1.2 });
  const agent = (parameters = {}) => node("Agent", `${L}agent`, { options: {}, ...parameters }, { typeVersion: 2 });
  const r = check(withModel(chain(sched, agent(), sheetsAppend()), "Agent"));
  assert.deepEqual(amended(r), ["chat-input-unfed"], JSON.stringify(r.reasons));
  assert.match(r.reasons.find((x) => x.amendment).detail, /promptType is auto/);
  // A chat trigger supplies it.
  assert.deepEqual(amended(check(withModel(chain(node("Chat", `${L}chatTrigger`, {}, { typeVersion: 1.1 }), agent()), "Agent"))), []);
  // An upstream field named chatInput supplies it.
  const set = node("Set", `${B}set`, { assignments: { assignments: [{ id: "a", name: "chatInput", type: "string", value: "write a post" }] }, options: {} }, { typeVersion: 3.4 });
  assert.deepEqual(amended(check(withModel(chain(sched, set, agent(), sheetsAppend()), "Agent"))), []);
  // A prompt the template defines needs nothing upstream; one that names $json.chatInput does.
  assert.deepEqual(amended(check(withModel(chain(sched, agent({ promptType: "define", text: "Write a post" }), sheetsAppend()), "Agent"))), []);
  assert.deepEqual(amended(check(withModel(chain(sched, agent({ promptType: "define", text: "={{ $json.chatInput }}" }), sheetsAppend()), "Agent"))), ["chat-input-unfed"]);
  // The OpenAI assistant's `prompt` option works the same way.
  const asst = node("Assistant", `${L}openAi`, { resource: "assistant", assistantId: { __rl: true, mode: "id", value: "asst_1" }, options: {} }, { typeVersion: 1.8, credentials: { openAiApi: { id: "1", name: "o" } } });
  assert.deepEqual(amended(check(chain(sched, asst, sheetsAppend()))), ["chat-input-unfed"]);
  asst.parameters.prompt = "define";
  asst.parameters.text = "={{ $json.body }}";
  assert.deepEqual(amended(check(chain(sched, asst, sheetsAppend()))), []);
});

test("amendment 1: the node-description extract keeps required, prompt-type and displayOptions properties only", () => {
  const descriptions = [
    {
      name: "thing",
      version: [1, 2],
      properties: [
        { displayName: "Op", name: "operation", type: "options", default: "a", options: [{ value: "a" }, { value: "b" }] },
        { displayName: "Body", name: "body", type: "string", default: "", required: true, displayOptions: { show: { operation: ["a"] } } },
        { displayName: "Note", name: "note", type: "notice", default: "" },
        { displayName: "Free", name: "free", type: "string", default: "" },
        { displayName: "Where", name: "where", type: "resourceLocator", default: { mode: "list", value: "" }, required: true },
      ],
    },
  ];
  const out = extractParams([{ prefix: "n8n-nodes-base", descriptions }], ["n8n-nodes-base.thing"]);
  assert.deepEqual(out["n8n-nodes-base.thing"][0].versions, [1, 2]);
  assert.deepEqual(out["n8n-nodes-base.thing"][0].props.map((p) => [p.name, !!p.required, !!p.account]), [["operation", false, false], ["body", true, false], ["where", true, true]]);
  assert.deepEqual(extractParams([{ prefix: "n8n-nodes-base", descriptions }], []), {});
  assert.equal(params.packages["n8n-nodes-base"], nodesRef.meta.packages["n8n-nodes-base"], "the extract and references/nodes.json read the same package version");
});
