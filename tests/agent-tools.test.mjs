// Agent tools n8n offers that the runtime carries as n8n runs them: the Think tool (a no-op
// that hands the model's input back), tool names as n8n makes them from node names, $fromAI()
// descriptions over several lines, and RSS Read (a step, or a tool whose feed URL the model
// picks from the URLs the author wrote), with rss-parser's item shape (runtime/src/feed.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { convertItems, loadReferences, nodeNameToToolName, fromAiSchema } from "../skills/n8n-to-claude/scripts/convert.mjs";
import { loadInput } from "../skills/n8n-to-claude/scripts/analyze.mjs";
import { preflight, run } from "../skills/n8n-to-claude/runtime/src/api.mjs";
import { parseXml, parseFeed } from "../skills/n8n-to-claude/runtime/src/feed.mjs";

const refs = loadReferences();
const CLOCK = { startedAt: "2026-11-16T09:00:00Z" };
const LC = "@n8n/n8n-nodes-langchain.";

function convertJson(wf) {
  const dir = mkdtempSync(join(tmpdir(), "n2c-tools-"));
  const p = join(dir, "wf.json");
  writeFileSync(p, JSON.stringify(wf));
  const loaded = loadInput(p);
  rmSync(dir, { recursive: true, force: true });
  return convertItems(loaded.items, { refs, now: Date.parse("2026-11-14T00:00:00Z"), forceConvert: true })[0].definition;
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
