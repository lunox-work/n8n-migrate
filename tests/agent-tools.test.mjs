// Agent tools n8n offers that the runtime carries as n8n runs them: the Think tool (a no-op
// that hands the model's input back), tool names as n8n makes them from node names, $fromAI()
// descriptions over several lines, and RSS Read (a step, or a tool whose feed URL the model
// picks from the URLs the author wrote), with rss-parser's item shape (runtime/src/feed.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { convertItems, loadReferences, nodeNameToToolName, toolNameFor, fromAiSchema } from "../skills/n8n-to-claude/scripts/convert.mjs";
import { loadInput } from "../skills/n8n-to-claude/scripts/analyze.mjs";
import { preflight, run } from "../skills/n8n-to-claude/runtime/src/api.mjs";
import { parseXml, parseFeed } from "../skills/n8n-to-claude/runtime/src/feed.mjs";

const refs = loadReferences();
const CLOCK = { startedAt: "2026-11-16T09:00:00Z" };
const LC = "@n8n/n8n-nodes-langchain.";

function convertJson(wf, answers = {}) {
  const dir = mkdtempSync(join(tmpdir(), "n2c-tools-"));
  const p = join(dir, "wf.json");
  writeFileSync(p, JSON.stringify(wf));
  const loaded = loadInput(p);
  rmSync(dir, { recursive: true, force: true });
  return convertItems(loaded.items, { refs, now: Date.parse("2026-11-14T00:00:00Z"), forceConvert: true, answers })[0].definition;
}
const agentWf = (tools) => ({
  id: "tools01",
  name: "Tools agent",
  nodes: [
    { parameters: {}, name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0] },
    { parameters: { promptType: "define", text: "={{ $json.q }}", options: {} }, name: "Agent", type: LC + "agent", typeVersion: 1.7, position: [200, 0] },
    { parameters: { model: "gpt-4o", options: {} }, name: "Model", type: LC + "lmChatOpenAi", typeVersion: 1, position: [100, 200] },
    ...tools,
  ],
  connections: {
    Start: { main: [[{ node: "Agent", type: "main", index: 0 }]] },
    Model: { ai_languageModel: [[{ node: "Agent", type: "ai_languageModel", index: 0 }]] },
    ...Object.fromEntries(tools.map((t) => [t.name, { ai_tool: [[{ node: "Agent", type: "ai_tool", index: 0 }]] }])),
  },
  settings: { executionOrder: "v1" },
});

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>World</title>
    <link>https://news.example/</link>
    <item>
      <title><![CDATA[Fund agreed]]></title>
      <link>https://news.example/a1</link>
      <description><![CDATA[<p>Delegates agreed a fund &amp; more.</p>]]></description>
      <pubDate>Mon, 16 Nov 2026 07:58:00 GMT</pubDate>
      <guid isPermaLink="false">a1</guid>
      <dc:creator>Ada</dc:creator>
      <category>Climate</category>
      <category>Policy</category>
    </item>
    <item>
      <title>Talks resume</title>
      <link>https://news.example/a2</link>
      <description>Negotiators returned &amp;amp; met.</description>
      <enclosure url="https://news.example/a2.jpg" type="image/jpeg" length="10"/>
      <pubDate>not a date</pubDate>
    </item>
  </channel>
</rss>`;

test("feed.mjs: xml2js's object shape and rss-parser's RSS 2.0 items", () => {
  const x = parseXml('<a k="1"><b>t</b><b/><c x="y">v</c><d>\n  <e>1</e>\n</d><f>  </f></a>');
  assert.deepEqual(x, { a: { $: { k: "1" }, b: ["t", ""], c: [{ _: "v", $: { x: "y" } }], d: [{ e: ["1"] }], f: ["  "] } });
  assert.throws(() => parseXml("<a>&nbsp;</a>"), /Invalid character entity/, "strict XML: no HTML entities");
  assert.deepEqual(parseXml("<a>&#169; &lt;</a>"), { a: "© <" });
  const feed = parseFeed(RSS);
  assert.deepEqual(feed.items[0], {
    creator: "Ada",
    title: "Fund agreed",
    link: "https://news.example/a1",
    pubDate: "Mon, 16 Nov 2026 07:58:00 GMT",
    "dc:creator": "Ada",
    content: "<p>Delegates agreed a fund &amp; more.</p>",
    contentSnippet: "Delegates agreed a fund & more.",
    guid: "a1",
    categories: ["Climate", "Policy"],
    isoDate: "2026-11-16T07:58:00.000Z",
  });
  assert.deepEqual(Object.keys(feed.items[1]), ["title", "link", "pubDate", "enclosure", "content", "contentSnippet"], "no isoDate for a date that does not parse");
  assert.deepEqual(feed.items[1].enclosure, { url: "https://news.example/a2.jpg", type: "image/jpeg", length: "10" });
  assert.deepEqual([feed.items[1].content, feed.items[1].contentSnippet], ["Negotiators returned &amp; met.", "Negotiators returned & met."], "one decoding by sax, one more by the snippet");
  assert.deepEqual([feed.title, feed.link], ["World", "https://news.example/"]);
  const atom = parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title><link href="https://a.example/" rel="alternate"/><entry><title>E</title><link href="https://a.example/e"/><updated>2026-11-16T01:00:00Z</updated><id>e1</id><content type="html">&lt;b&gt;Hi&lt;/b&gt;</content></entry></feed>');
  assert.deepEqual(atom.items[0], { title: "E", link: "https://a.example/e", pubDate: "2026-11-16T01:00:00.000Z", content: "<b>Hi</b>", contentSnippet: "Hi", id: "e1", isoDate: "2026-11-16T01:00:00.000Z" });
  assert.throws(() => parseFeed("<html><body/></html>"), /Feed not recognized/);
});

test("Think tool: offered as n8n names it and hands the model's input back; tool names as n8n makes them", async () => {
  assert.equal(nodeNameToToolName("Tool: Inject Creativity"), "Tool_Inject_Creativity");
  assert.equal(nodeNameToToolName("a".repeat(63) + " b"), "a".repeat(63));
  const wf = agentWf([
    { parameters: {}, name: "Think", type: LC + "toolThink", typeVersion: 1, position: [0, 200] },
    { parameters: { description: "Ponder first" }, name: "Plan: step", type: LC + "toolThink", typeVersion: 1.1, position: [0, 300] },
  ]);
  const def = convertJson(wf);
  assert.deepEqual(def.steps.Agent.agent.tools.map((t) => [t.name, t.kind, t.effect]), [["thinking_tool", "think", "none"], ["Plan_step", "think", "none"]]);
  assert.match(def.steps.Agent.agent.tools[0].description, /^Use the tool to think about something/);
  assert.equal(def.steps.Agent.agent.tools[1].description, "Ponder first");
  assert.deepEqual(def.steps.Agent.agent.tools[0].inputSchema, { type: "object", properties: { input: { type: "string" } } });
  assert.equal(preflight(def, {}).ok, true);
  let offered;
  let fed;
  const host = {
    agent: async (p) => {
      offered ??= p.tools.map((t) => t.name);
      if (p.turn === 0) return { intent: "tool-calls", calls: [{ name: "thinking_tool", args: { input: "Pick a calm idea" } }] };
      fed = p.transcript[0].results[0];
      return "done";
    },
  };
  const r = await run(def, { clock: CLOCK, virtualTime: true, trigger: { node: "Start", items: [{ json: { q: "Idea?" } }] }, host });
  assert.equal(r.status, "done");
  assert.deepEqual(offered, ["thinking_tool", "Plan_step"]);
  assert.deepEqual(fed, { name: "thinking_tool", ok: true, value: "Pick a calm idea" });
});

test("$fromAI() descriptions over several lines keep the description and the required flag", () => {
  const s = fromAiSchema({ a: "={{ $fromAI('lat', `Latitude.\nDo not ask.`, 'string') }}", b: "={{ $fromAI('unit', 'Unit', 'string', 'celsius') }}" });
  assert.deepEqual(s, { type: "object", properties: { lat: { type: "string", description: "Latitude.\nDo not ask." }, unit: { type: "string", description: "Unit" } }, required: ["lat"] });
});

test("RSS Read: a step with a literal URL, and an agent tool whose URL the model picks from the URLs written in it", async () => {
  // A step: GET with rss-parser's headers (v1.2: the relaxed Accept), one item per entry.
  const stepWf = {
    id: "rss01",
    name: "Feed",
    nodes: [
      { parameters: {}, name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0] },
      { parameters: { url: "https://news.example/rss.xml", options: {} }, name: "RSS Read", type: "n8n-nodes-base.rssFeedRead", typeVersion: 1.2, position: [200, 0] },
    ],
    connections: { Start: { main: [[{ node: "RSS Read", type: "main", index: 0 }]] } },
    settings: { executionOrder: "v1" },
  };
  const def = convertJson(stepWf);
  assert.deepEqual([def.steps["RSS Read"].kind, def.steps["RSS Read"].rest.program, def.steps["RSS Read"].auth], ["http", "rssFeedRead", undefined]);
  assert.deepEqual(def.allow.http, [{ method: "GET", host: "news.example", pathPrefix: "/rss.xml" }]);
  const seen = [];
  const host = { http: async (q) => (seen.push(q), { status: 200, headers: { "content-type": "application/rss+xml" }, body: RSS }) };
  const r = await run(def, { clock: CLOCK, virtualTime: true, trigger: { node: "Start", items: [{ json: {} }] }, host });
  assert.equal(r.status, "done");
  assert.deepEqual([seen[0].method, seen[0].url, seen[0].headers["User-Agent"], seen[0].headers.Accept], ["GET", "https://news.example/rss.xml", "rss-parser", "application/rss+xml, application/rdf+xml;q=0.8, application/atom+xml;q=0.6, application/xml;q=0.4, text/xml;q=0.4"]);
  assert.deepEqual(r.runData["RSS Read"][0].data.main[0].map((i) => i.json.title), ["Fund agreed", "Talks resume"]);

  // An agent tool: the URL is $fromAI() with the allowed feeds listed in its description.
  const urlParam = "={{ $fromAI('URL', `Use one of:\n- https://news.example/rss.xml (News)\n- https://other.example/feed/ (Other)`, 'string') }}";
  const toolWf = agentWf([{ parameters: { url: urlParam, options: {}, toolDescription: "Reads a feed." }, name: "Get News", type: "n8n-nodes-base.rssFeedReadTool", typeVersion: 1.2, position: [0, 200] }]);
  const tdef = convertJson(toolWf);
  const tool = tdef.steps.Agent.agent.tools[0];
  assert.deepEqual([tool.name, tool.kind, tool.effect, tool.inputSchema.required], ["Get_News", "rest", "read", ["URL"]]);
  assert.deepEqual(tdef.allow.http.map((a) => `${a.method} ${a.host}${a.pathPrefix}`), ["GET news.example/rss.xml", "GET other.example/feed/"]);
  assert.equal(preflight(tdef, {}).ok, true);
  const calls = [];
  const thost = {
    http: async (q) => (calls.push(q.url), { status: 200, body: RSS }),
    agent: async (p) => (p.turn === 0 ? { intent: "tool-calls", calls: [{ name: "Get_News", args: { URL: "https://news.example/rss.xml" } }] } : p.transcript[0].results[0]),
  };
  const tr = await run(tdef, { clock: CLOCK, virtualTime: true, trigger: { node: "Start", items: [{ json: { q: "news?" } }] }, host: thost });
  assert.equal(tr.status, "done");
  assert.deepEqual(calls, ["https://news.example/rss.xml"]);
  assert.deepEqual(tr.output?.[0]?.json?.output?.value?.map((x) => x.title) ?? tr.runData.Agent[0].data.main[0][0].json.output.value.map((x) => x.title), ["Fund agreed", "Talks resume"]);
  // A URL the author did not write is refused before any request.
  const bad = { ...thost, agent: async (p) => (p.turn === 0 ? { intent: "tool-calls", calls: [{ name: "Get_News", args: { URL: "https://evil.example/rss" } }] } : "x") };
  calls.length = 0;
  const br = await run(tdef, { clock: CLOCK, virtualTime: true, trigger: { node: "Start", items: [{ json: { q: "news?" } }] }, host: bad });
  assert.notEqual(br.status, "done");
  assert.deepEqual(calls, []);
  // A $fromAI URL that names no feed is refused by preflight until the person narrows it.
  const open = convertJson(agentWf([{ parameters: { url: "={{ $fromAI('URL') }}", options: {} }, name: "Any Feed", type: "n8n-nodes-base.rssFeedReadTool", typeVersion: 1.2, position: [0, 200] }]));
  const pf = preflight(open, {});
  assert.equal(pf.ok, false);
  assert.match(pf.issues.find((i) => i.level === "error").message, /agent tool "Any Feed": a request with a URL built at run time/);
});

test("an agent tool the converter cannot carry (a database tool) is refused by preflight, by name; a disabled one is not", () => {
  const my = (name, extra = {}) => ({ parameters: { query: "{{ $fromAI('sql_statement') }}", operation: "executeQuery", options: {} }, name, type: "n8n-nodes-base.mySqlTool", typeVersion: 2.4, position: [0, 200], credentials: { mySql: { id: "1", name: "DB" } }, ...extra });
  const def = convertJson(agentWf([my("MySQL")]));
  assert.equal(def.steps.MySQL.kind, "blocked");
  assert.deepEqual(def.steps.Agent.agent.tools, []);
  const pf = preflight(def, {});
  assert.equal(pf.ok, false);
  const e = pf.issues.find((i) => i.level === "error" && i.step === "Agent");
  assert.match(e.message, /^blocked: agent tool "MySQL" cannot be carried \(a database step needs .*\); without it the agent would answer without a tool n8n gives it$/);
  assert.equal(preflight(convertJson(agentWf([my("MySQL", { disabled: true })])), {}).ok, true, "n8n skips a disabled tool too");
});

test("a Postgres tool (executeQuery) waits for its credential's database, then runs as a db tool with the model's SQL", () => {
  const pg = { parameters: { query: "{{ $fromAI('sql_statement') }}", operation: "executeQuery", options: {} }, name: "Postgres", type: "n8n-nodes-base.postgresTool", typeVersion: 2.5, position: [0, 200], credentials: { postgres: { id: "1", name: "DB" } } };
  const waiting = convertJson(agentWf([pg]));
  assert.equal(waiting.steps.Postgres.kind, "blocked");
  assert.match(preflight(waiting, {}).issues.find((i) => i.level === "error" && i.step === "Agent").message, /the database the credential "DB" connects to is not known yet: answer question tools01\/database\/DB/);
  const def = convertJson(agentWf([pg]), { "tools01/database/DB": "postgres://reader@db.example.com:5433/shop?sslmode=require" });
  assert.equal(def.steps.Postgres.kind, "db");
  assert.deepEqual(def.steps.Postgres.db, { engine: "postgres", operation: "executeQuery", credential: "DB", secret: "DB", connection: { host: "db.example.com", port: 5433, database: "shop", user: "reader", ssl: "require" }, effect: "write", fidelity: "exact" });
  assert.deepEqual(def.allow.db, [{ engine: "postgres", host: "db.example.com", port: 5433, database: "shop" }]);
  assert.deepEqual(def.secrets.find((x) => x.name === "DB"), { name: "DB", credentialType: "postgres", hosts: ["db.example.com:5433"] });
  assert.deepEqual(def.steps.Agent.agent.tools.map((t) => [t.name, t.kind, t.effect, Object.keys(t.inputSchema.properties)]), [["Postgres", "db", "write", ["sql_statement"]]]);
  assert.match(def.steps.Postgres.reviewReasons.join(" "), /the model writes the SQL/);
  assert.equal(preflight(def, {}).issues.filter((i) => i.level === "error").length, 0);
  assert.match(preflight(def, { surface: "artifact" }).issues.find((i) => i.level === "error").message, /artifact page cannot/);
});

test("tool and placeholder descriptions written as expressions are evaluated on the agent's item, as n8n does", async () => {
  const tool = {
    parameters: { url: "https://api.example/search", method: "GET", sendQuery: true, parametersQuery: { values: [{ name: "q", valueProvider: "modelRequired" }] }, toolDescription: "=Search the \"{{ $json.db }}\" database.", placeholderDefinitions: { values: [{ name: "tag", description: "=Options: {{ $json.tags }}" }] } },
    name: "Search",
    type: LC + "toolHttpRequest",
    typeVersion: 1.1,
    position: [0, 200],
  };
  const def = convertJson(agentWf([tool]));
  assert.equal(def.steps.Agent.agent.tools[0].description, '=Search the "{{ $json.db }}" database.', "kept as n8n wrote it");
  let offered;
  const host = { agent: async (p) => ((offered = p.tools[0]), "ok") };
  const r = await run(def, { clock: CLOCK, virtualTime: true, trigger: { node: "Start", items: [{ json: { q: "x", db: "", tags: "HR,IT" } }] }, host });
  assert.equal(r.status, "done");
  assert.equal(offered.description, 'Search the "" database.');
  assert.equal(offered.inputSchema.properties.tag.description, "Options: HR,IT");
  assert.equal(def.steps.Agent.agent.tools[0].inputSchema.properties.tag.description, "=Options: {{ $json.tags }}", "the definition is not changed by a run");
});

test("tool names: older Code, Workflow and Vector Store tools keep the name typed in the tool, as n8n offers them", () => {
  assert.equal(toolNameFor("Code Tool", LC + "toolCode", 1.1, { name: "my_color_selector" }), "my_color_selector");
  assert.equal(toolNameFor("Code Tool", LC + "toolCode", 1.2, { name: "my_color_selector" }), "Code_Tool", "from 1.2 n8n names the tool after the node");
  assert.equal(toolNameFor("List columns tool", LC + "toolWorkflow", 2, { name: "list_columns" }), "list_columns");
  assert.equal(toolNameFor("List columns tool", LC + "toolWorkflow", 2.2, { name: "list_columns" }), "List_columns_tool");
  assert.equal(toolNameFor("Docs", LC + "toolVectorStore", 1, { name: "users_info" }), "users_info");
  assert.equal(toolNameFor("Code Tool", LC + "toolCode", 1, {}), "Code_Tool", "no typed name: the node's name");
  assert.equal(toolNameFor("Search", LC + "toolHttpRequest", 1.1, { name: "x" }), "Search", "other tools: always the node's name");
  const wf = agentWf([{ parameters: { name: "my_color_selector", description: "Pick a colour", jsCode: "return 'blue';" }, name: "Code Tool", type: LC + "toolCode", typeVersion: 1.1, position: [0, 200] }]);
  const def = convertJson(wf);
  assert.deepEqual(def.steps.Agent.agent.tools.map((t) => [t.name, t.node, t.kind]), [["my_color_selector", "Code Tool", "code"]]);
});

test("a workflow tool without $fromAI() is n8n's DynamicTool: one optional `input`, handed to the sub-workflow as {query}", () => {
  const wf = agentWf([
    { parameters: { name: "list_columns", description: "List the columns", workflowId: { __rl: true, value: "={{ $workflow.id }}", mode: "id" }, workflowInputs: { mappingMode: "defineBelow", value: {}, matchingColumns: [], schema: [] } }, name: "List columns tool", type: LC + "toolWorkflow", typeVersion: 2, position: [0, 200] },
    { parameters: { inputSource: "passthrough" }, name: "When called", type: "n8n-nodes-base.executeWorkflowTrigger", typeVersion: 1.1, position: [0, 400] },
  ]);
  const def = convertJson(wf);
  const t = def.steps.Agent.agent.tools[0];
  assert.deepEqual([t.name, t.kind, t.inputSchema], ["list_columns", "subflow", { type: "object", properties: { input: { type: "string" } } }]);
  assert.deepEqual(def.steps["List columns tool"].subflow.inputs, { query: "={{ $fromAI('input') }}" }, "no input schema listed: n8n sends {query: input}");
  // Mapped values without $fromAI() (the sub-workflow's schema is listed): still a DynamicTool, the values go as written.
  const wf2 = agentWf([
    { parameters: { name: "list_columns", description: "List the columns", workflowId: { __rl: true, value: "={{ $workflow.id }}", mode: "id" }, workflowInputs: { mappingMode: "defineBelow", value: { query: "none", operation: "column_names" }, matchingColumns: [], schema: [{ id: "query" }, { id: "operation" }] } }, name: "List columns tool", type: LC + "toolWorkflow", typeVersion: 2, position: [0, 200] },
    { parameters: { inputSource: "passthrough" }, name: "When called", type: "n8n-nodes-base.executeWorkflowTrigger", typeVersion: 1.1, position: [0, 400] },
  ]);
  const def2 = convertJson(wf2);
  assert.deepEqual([def2.steps.Agent.agent.tools[0].inputSchema, def2.steps["List columns tool"].subflow.inputs], [{ type: "object", properties: { input: { type: "string" } } }, { query: "none", operation: "column_names" }]);
});

test("an HTTP Request tool's response reaches the agent as n8n 2.47.7 hands it: JSON optimizer fields, text under its property", async () => {
  const { convertItems, loadReferences } = await import("../skills/n8n-to-claude/scripts/convert.mjs");
  const tool = (name, parameters) => ({ name, type: "n8n-nodes-base.httpRequestTool", typeVersion: 4.2, position: [0, 0], parameters: { method: "GET", toolDescription: name, ...parameters } });
  const wf = {
    id: "ht01",
    name: "HTTP tool shapes",
    nodes: [
      { name: "Chat", type: "@n8n/n8n-nodes-langchain.chatTrigger", typeVersion: 1.1, position: [0, 0], parameters: {} },
      { name: "Agent", type: "@n8n/n8n-nodes-langchain.agent", typeVersion: 1.7, position: [200, 0], parameters: {} },
      { name: "Model", type: "@n8n/n8n-nodes-langchain.lmChatOpenAi", typeVersion: 1, position: [200, 200], parameters: {} },
      tool("List", { url: "https://api.example.com/items", optimizeResponse: true, responseType: "json", fieldsToInclude: "selected", fields: "name,meta.size" }),
      tool("Read", { url: "https://api.example.com/readme", options: { response: { response: { responseFormat: "text" } } } }),
    ],
    connections: { Chat: { main: [[{ node: "Agent", type: "main", index: 0 }]] }, Model: { ai_languageModel: [[{ node: "Agent", type: "ai_languageModel", index: 0 }]] }, List: { ai_tool: [[{ node: "Agent", type: "ai_tool", index: 0 }]] }, Read: { ai_tool: [[{ node: "Agent", type: "ai_tool", index: 0 }]] } },
  };
  const [res] = convertItems([{ id: "ht01", name: wf.name, wf, file: "x.json" }], { refs: loadReferences(), forceConvert: true });
  const def = res.definition;
  assert.deepEqual(def.steps.List.http.optimize, { type: "json", fieldsToInclude: "selected", fields: "name,meta.size" });
  assert.equal(def.steps.Read.http.textAs, "data");
  const { run } = await import("../skills/n8n-to-claude/runtime/src/api.mjs");
  let turn = 0;
  const fed = [];
  const host = {
    agent: async (p) => {
      turn++;
      if (turn === 1) return { intent: "tool-calls", calls: [{ name: "List", args: {} }, { name: "Read", args: {} }] };
      fed.push(...p.transcript.at(-1).results);
      return "done";
    },
    http: async (q) => (q.url.endsWith("/items") ? { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify([{ name: "a", meta: { size: 1, x: 2 }, url: "u" }]) } : { status: 200, headers: { "content-type": "text/plain" }, body: "# Readme" }),
  };
  const r = await run(def, { trigger: { node: "Chat", items: [{ chatInput: "go", sessionId: "s" }] }, host });
  assert.equal(r.status, "done", JSON.stringify(r.error));
  assert.deepEqual(fed.map((x) => x.value), [[{ name: "a", meta: { size: 1 } }], [{ data: "# Readme" }]]);
});

test("Wikipedia tool: LangChain's WikipediaQueryRun as n8n runs it (search, then an extract per top result)", async () => {
  const wf = agentWf([{ parameters: {}, name: "Fetch Wikipedia Information", type: LC + "toolWikipedia", typeVersion: 1, position: [0, 200] }]);
  const def = convertJson(wf);
  const [tool] = def.steps.Agent.agent.tools;
  assert.deepEqual([tool.name, tool.kind, tool.effect], ["Fetch_Wikipedia_Information", "rest", "read"]);
  assert.equal(tool.description, "A tool for interacting with and fetching data from the Wikipedia API. The input should always be a string query.");
  assert.deepEqual(tool.inputSchema, { type: "object", properties: { input: { type: "string" } } });
  assert.deepEqual(def.allow.http.map((h) => [h.method, h.host, h.pathPrefix]), [["GET", "en.wikipedia.org", "/w/api.php"]]);
  assert.equal(preflight(def, {}).ok, true);
  const titles = ["Heat pump", "Air source heat pump", "Coefficient of performance", "Geothermal heat pump"];
  const seen = [];
  const http = async (req) => {
    const u = new URL(req.url);
    seen.push([...u.searchParams.entries()]);
    if (u.searchParams.get("list") === "search") return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ query: { search: titles.map((title) => ({ title })) } }) };
    const t = u.searchParams.get("titles");
    if (t === "Air source heat pump") return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ query: { pages: {} } }) };
    return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ query: { pages: { 7: { pageid: 7, title: t, extract: `About ${t}.` } } } }) };
  };
  let fed;
  const host = {
    http,
    agent: async (p) => {
      if (p.turn === 0) return { intent: "tool-calls", calls: [{ name: "Fetch_Wikipedia_Information", args: { input: "heat pumps & cold" } }] };
      fed = p.transcript[0].results[0];
      return "done";
    },
  };
  const r = await run(def, { clock: CLOCK, virtualTime: true, trigger: { node: "Start", items: [{ json: { q: "Heat pumps?" } }] }, host });
  assert.equal(r.status, "done");
  // The first 3 results; a page without details is skipped.
  assert.deepEqual(fed, { name: "Fetch_Wikipedia_Information", ok: true, value: "Page: Heat pump\nSummary: About Heat pump.\n\nPage: Coefficient of performance\nSummary: About Coefficient of performance." });
  assert.deepEqual(seen[0], [["action", "query"], ["list", "search"], ["srsearch", "heat pumps & cold"], ["format", "json"]]);
  assert.deepEqual(seen[1], [["action", "query"], ["prop", "extracts"], ["explaintext", "true"], ["redirects", "1"], ["format", "json"], ["titles", "Heat pump"]]);
  assert.equal(seen.length, 4);
  // No result: LangChain's sentence; an answer that is not 2xx: its error.
  const none = { ...host, http: async () => ({ status: 200, headers: { "content-type": "application/json" }, body: '{"query":{"search":[]}}' }) };
  await run(def, { clock: CLOCK, virtualTime: true, trigger: { node: "Start", items: [{ json: { q: "x" } }] }, host: none });
  assert.equal(fed.value, "No good Wikipedia Search Result was found");
  const down = { ...host, http: async () => ({ status: 503, headers: {}, body: "" }) };
  await run(def, { clock: CLOCK, virtualTime: true, trigger: { node: "Start", items: [{ json: { q: "x" } }] }, host: down });
  assert.deepEqual([fed.ok, fed.error?.message], [false, "Network response was not ok"]);
});
