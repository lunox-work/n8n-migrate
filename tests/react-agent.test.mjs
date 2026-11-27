// n8n's ReAct agent (agent node 1.x, agent: reActAgent) on a chat model, as LangChain's
// ChatAgent builds its prompt (@langchain/classic 1.0), and the 1.6 output wrapper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { convertItems, loadReferences } from "../skills/n8n-to-claude/scripts/convert.mjs";
import { loadInput } from "../skills/n8n-to-claude/scripts/analyze.mjs";
import { run } from "../skills/n8n-to-claude/runtime/src/api.mjs";

const LC = "@n8n/n8n-nodes-langchain.";
function convert(nodes, connections) {
  const dir = mkdtempSync(join(tmpdir(), "n8m-react-"));
  const p = join(dir, "wf.json");
  writeFileSync(p, JSON.stringify({ id: "w1", name: "react", nodes, connections, settings: { executionOrder: "v1" } }));
  const res = convertItems(loadInput(p).items, { refs: loadReferences(), now: Date.parse("2026-11-14T00:00:00Z"), forceConvert: true })[0];
  rmSync(dir, { recursive: true, force: true });
  return res.definition;
}
const nodes = (options, extra = []) => [
  { parameters: {}, name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0] },
  { parameters: { agent: "reActAgent", promptType: "define", text: "=Rewrite {{ $json.x }}", hasOutputParser: true, options }, name: "Agent", type: LC + "agent", typeVersion: 1.6, position: [200, 0] },
  { parameters: { options: {} }, name: "Model", type: LC + "lmChatAnthropic", typeVersion: 1.2, position: [200, 200] },
  { parameters: { jsonSchemaExample: '{\n\t"answer": "text"\n}' }, name: "Parser", type: LC + "outputParserStructured", typeVersion: 1.2, position: [400, 200] },
  ...extra,
];
const links = {
  Start: { main: [[{ node: "Agent", type: "main", index: 0 }]] },
  Model: { ai_languageModel: [[{ node: "Agent", type: "ai_languageModel", index: 0 }]] },
  Parser: { ai_outputParser: [[{ node: "Agent", type: "ai_outputParser", index: 0 }]] },
};

test("ReAct agent without tools: n8n's system message, parser instructions after the input, 1.6 output wrapper", async () => {
  const def = convert(nodes({ prefix: "You edit {{JSON}}.\n\n" }), links);
  const a = def.steps.Agent.agent;
  assert.ok(a.system.startsWith("You edit {JSON}.\n\n\n\n\n\nThe way you use the tools is by specifying a json blob"), JSON.stringify(a.system.slice(0, 80)));
  assert.ok(a.system.endsWith("Final Answer: the final answer to the original input question\n\nBegin! Reminder to always use the exact characters `Final Answer` when responding."));
  assert.ok(a.promptAppend.startsWith("\nYou must format your output as a JSON value"));
  assert.ok(a.promptAppend.includes('{"type":"object","properties":{"output":{"type":"object","properties":{"answer":{"type":"string"}},"additionalProperties":false}},"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'));
  assert.equal(a.wrapOutput, true);
  const seen = [];
  const res = await run(def, { trigger: [{ x: "it" }], clock: { startedAt: "2026-11-14T03:00:00Z" }, virtualTime: true, host: { agent: async (p) => (seen.push(p), { answer: "done" }) } });
  assert.equal(res.status, "done", res.error?.message);
  assert.ok(seen[0].prompt.startsWith("Rewrite it\nYou must format your output"));
  assert.deepEqual(res.runData.Agent[0].data.main[0][0].json, { output: { output: { answer: "done" } } });
});

test("ReAct agent with tools keeps native tool calls and says the prompt differs; the default prefix is LangChain's", () => {
  const def = convert(nodes({}), links);
  assert.ok(def.steps.Agent.agent.system.startsWith("Answer the following questions as best you can. You have access to the following tools:\n\n\n\n"));
  const tool = { parameters: { toolDescription: "Adds", jsCode: "return 1" }, name: "Calc", type: LC + "toolCode", typeVersion: 1.1, position: [300, 300] };
  const withTool = convert(nodes({}, [tool]), { ...links, Calc: { ai_tool: [[{ node: "Agent", type: "ai_tool", index: 0 }]] } });
  const a = withTool.steps.Agent;
  assert.equal(a.agent.promptAppend, undefined);
  assert.ok(a.reviewReasons.some((r) => /ReAct agent writes tool calls as text/.test(r)));
});
