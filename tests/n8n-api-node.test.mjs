// The n8n node (n8n-nodes-base.n8n) as a read-only http step against the person's n8n
// instance: which operations move and which stay blocked, the site question and the
// local-versus-cloud rule, the converter's REST program with its allowlist and secret host, the
// runtime's requests (n8n 2.47.7's, as observed on the bench, PROPOSALS P125), and the wording
// in the report and MIGRATION.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, unwrap, renderText, N8N_STAYS_NOTE } from "../skills/n8n-to-claude/scripts/analyze.mjs";
import { convertItems, loadReferences, migrationMd } from "../skills/n8n-to-claude/scripts/convert.mjs";
import { localHost } from "../skills/n8n-to-claude/runtime/src/engine.mjs";
import { run } from "../skills/n8n-to-claude/runtime/src/api.mjs";

const refs = loadReferences();
const NOW = Date.parse("2026-11-16T00:00:00Z");
const CRED = { n8nApi: { id: "c1", name: "n8n account" } };

// Schedule -> one n8n node (params) -> Slack.
function wfWith(params, { id = "napi", name = "Nightly list", extra = [] } = {}) {
  return {
    id,
    name,
    nodes: [
      { id: "1", name: "Every night", type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.2, position: [0, 0], parameters: { rule: { interval: [{ field: "days", triggerAtHour: 2 }] } } },
      { id: "2", name: "Read n8n", type: "n8n-nodes-base.n8n", typeVersion: 1, position: [200, 0], parameters: params, credentials: CRED },
      { id: "3", name: "Post", type: "n8n-nodes-base.slack", typeVersion: 2.3, position: [400, 0], parameters: { select: "channel", channelId: { __rl: true, mode: "name", value: "#ops" }, text: "={{ $items().length }}" }, credentials: { slackOAuth2Api: { id: "s", name: "Slack" } } },
      ...extra,
    ],
    connections: { "Every night": { main: [[{ node: "Read n8n", type: "main", index: 0 }]] }, "Read n8n": { main: [[{ node: "Post", type: "main", index: 0 }]] } },
    settings: { executionOrder: "v1", timezone: "UTC" },
  };
}
const analyzeWf = (wf, answers = {}) => analyze(unwrap(wf, "wf.json"), { nodes: refs.nodes, capabilities: refs.capabilities, hosts: refs.hosts, answers, now: NOW }).workflows[0];
const convertWf = (wf, answers = {}) => convertItems(unwrap(wf, "wf.json"), { refs, now: NOW, answers, forceConvert: true })[0];
const siteId = (wf) => `${wf.id}/site/n8n account`;

const READS = ["workflow:getAll", "workflow:get", "execution:getAll", "execution:get"];

test("only the workflow and execution reads move; every other operation is blocked with its reason", () => {
  const ops = Object.keys(refs.nodes.nodes["n8n-nodes-base.n8n"].operations);
  assert.ok(ops.length >= 17, "the catalogue lists the node's operations");
  for (const opKey of ops) {
    const [resource, operation] = opKey.split(":");
    const w = analyzeWf(wfWith({ resource, operation }));
    const step = w.steps.find((s) => s.node === "Read n8n");
    if (READS.includes(opKey)) {
      assert.equal(step.kind, "http", opKey);
      assert.equal(step.effect, "read", opKey);
      assert.equal(w.outcome.kind, "subscription", opKey);
      assert.equal(w.blockers.length, 0, opKey);
    } else {
      assert.equal(w.outcome.kind, "keep-in-n8n", opKey);
      const b = w.blockers.find((x) => x.nodes.includes("Read n8n"));
      assert.equal(b?.kind, "unsupported", opKey);
      if (opKey.startsWith("credential:")) assert.match(b.reason, /credentials of any kind stay in n8n/, opKey);
      else if (step.effect === "write") assert.match(b.reason, /a write to n8n needs the writes question and the person's approval/, opKey);
      else assert.match(b.reason, /only (reads of workflows and executions|the workflow list and the current workflow) move/, opKey);
    }
  }
  // create, update, publish, unpublish, delete: each a write with the approval reason.
  for (const op of ["create", "update", "activate", "deactivate", "delete"]) {
    const w = analyzeWf(wfWith({ resource: "workflow", operation: op }));
    assert.match(w.outcome.reason, /approval/, op);
  }
  // An operation chosen by an expression, or one the node does not have, stays blocked too.
  for (const params of [{ resource: "workflow", operation: "={{ $json.op }}" }, { resource: "credential", operation: "getAll" }]) {
    const w = analyzeWf(wfWith(params));
    assert.equal(w.outcome.kind, "keep-in-n8n", JSON.stringify(params));
    assert.match(w.outcome.reason, /other than reading workflows or executions/);
  }
});

test("a sub-workflow picked by an expression stays blocked: n8n's public API cannot run a workflow", () => {
  const wf = wfWith({ resource: "workflow", operation: "getAll" }, {
    extra: [{ id: "4", name: "Run it", type: "n8n-nodes-base.executeWorkflow", typeVersion: 1.2, position: [400, 200], parameters: { workflowId: { __rl: true, mode: "id", value: "={{ $json.id }}" }, options: {} } }],
  });
  wf.connections["Read n8n"].main[0].push({ node: "Run it", type: "main", index: 0 });
  const w = analyzeWf(wf);
  assert.equal(w.outcome.kind, "keep-in-n8n");
  assert.match(w.outcome.reason, /picked at run time from the ones in n8n; n8n's public API has no endpoint that runs a workflow/);
});

test("the site question: one per n8nApi credential, its answer picks a cloud or a local task", () => {
  const wf = wfWith({});
  const w = analyzeWf(wf);
  const q = w.questions.find((x) => x.id === siteId(wf));
  assert.ok(q, "asks for the n8n site");
  assert.match(q.text, /Base URL field, for example https:\/\/n8n\.example\.com\/api\/v1/);
  assert.match(q.text, /localhost, a private IP, a \.local or internal name\) makes it a local task/);
  assert.match(q.text, /work only while it keeps running/);
  assert.equal(w.outcome.target, "cloud-task", "unanswered: the schedule decides");

  const cloud = analyzeWf(wf, { [siteId(wf)]: "https://n8n.example.com/api/v1" });
  assert.equal(cloud.outcome.target, "cloud-task");
  assert.equal(cloud.requires.some((r) => r.kind === "local-network"), false);

  for (const site of ["http://localhost:5678/api/v1", "http://192.168.1.20:5678", "https://n8n.local", "http://n8n:5678/api/v1", "http://10.0.0.5/api/v1", "http://[::1]:5678"]) {
    const local = analyzeWf(wf, { [siteId(wf)]: site });
    assert.equal(local.outcome.kind, "subscription", site);
    assert.equal(local.outcome.target, "local-task", site);
    assert.match(local.outcome.reason, /n8n at .* is a local address a cloud task cannot reach, so a local task$/, site);
    const r = local.requires.find((x) => x.kind === "local-network");
    assert.deepEqual(r.surfaces, { cloudTask: "no", localTask: "ok", artifact: "no" }, site);
  }
});

test("a local site address is the same rule for every site credential (WordPress too)", () => {
  const wp = {
    id: "wp",
    name: "Post",
    nodes: [
      { id: "1", name: "Daily", type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.2, position: [0, 0], parameters: { rule: { interval: [{ field: "days" }] } } },
      { id: "2", name: "WP", type: "n8n-nodes-base.wordpress", typeVersion: 1, position: [200, 0], parameters: { title: "x", additionalFields: {} }, credentials: { wordpressApi: { id: "w", name: "Blog" } } },
    ],
    connections: { Daily: { main: [[{ node: "WP", type: "main", index: 0 }]] } },
    settings: { executionOrder: "v1", timezone: "UTC" },
  };
  assert.equal(analyzeWf(wp, { "wp/site/Blog": "https://blog.example.com" }).outcome.target, "cloud-task");
  const local = analyzeWf(wp, { "wp/site/Blog": "http://wordpress.lan" });
  assert.equal(local.outcome.target, "local-task");
  assert.match(local.outcome.reason, /WordPress at wordpress\.lan is a local address/);
});

test("localHost: loopback, private, link-local, local names and dotless names; public hosts are not", () => {
  for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.0.10", "169.254.169.254", "100.64.0.1", "::1", "[fd00::1]", "fe80::1", "n8n", "nas.local", "box.internal", "n8n.home.arpa", "app.localhost"]) assert.equal(localHost(h), true, h);
  for (const h of ["n8n.example.com", "8.8.8.8", "acme.app.n8n.cloud", "2606:4700::1111"]) assert.equal(localHost(h), false, h);
});

test("the report says the step keeps calling n8n and is useful only while n8n keeps running", () => {
  const wf = wfWith({});
  const report = analyze(unwrap(wf, "wf.json"), { nodes: refs.nodes, capabilities: refs.capabilities, hosts: refs.hosts, answers: {}, now: NOW });
  const r = report.workflows[0].requires.find((x) => x.kind === "http" && x.note);
  assert.equal(r.note, N8N_STAYS_NOTE);
  assert.match(renderText(report), /note: "Read n8n" keeps calling your n8n instance through its public API \(reads only\), so it is useful only while n8n keeps running/);
});

test("convert: a REST program on the answered site, allowlisted and with the key sent only to its host", () => {
  const wf = wfWith({ resource: "execution", operation: "getAll", returnAll: true });
  const res = convertWf(wf, { [siteId(wf)]: "https://n8n.example.com/" });
  const step = res.definition.steps["Read n8n"];
  assert.equal(step.kind, "http");
  assert.equal(step.blocked, undefined);
  assert.equal(step.rest.program, "n8nApi");
  assert.equal(step.rest.effect, "read");
  assert.equal(step.rest.base, "https://n8n.example.com/api/v1", "an address without a path gets /api/v1");
  assert.deepEqual(step.auth, { credentialType: "n8nApi", secret: "n8n account" });
  assert.deepEqual(res.definition.allow.http, [{ method: "GET", host: "n8n.example.com", pathPrefix: "/api/v1/executions" }]);
  assert.deepEqual(res.definition.secrets, [{ name: "n8n account", credentialType: "n8nApi", hosts: ["n8n.example.com"] }]);
  assert.ok(step.rest.caveats.some((c) => /X-N8N-API-KEY/.test(c)));
  // A path in the answer is kept as the Base URL n8n would use.
  const withPath = convertWf(wf, { [siteId(wf)]: "https://ops.example.com/n8n/api/v1" });
  assert.equal(withPath.definition.steps["Read n8n"].rest.base, "https://ops.example.com/n8n/api/v1");
  assert.deepEqual(withPath.definition.allow.http, [{ method: "GET", host: "ops.example.com", pathPrefix: "/n8n/api/v1/executions" }]);
});

test("convert: unanswered site blocks the step on the question; a write stays blocked with its reason", () => {
  const wf = wfWith({});
  const res = convertWf(wf);
  const step = res.definition.steps["Read n8n"];
  assert.equal(step.kind, "blocked");
  assert.equal(step.blocked.kind, "input-incomplete");
  assert.match(step.blocked.reason, new RegExp(`answer question ${siteId(wf)}`));
  const w = convertWf(wfWith({ resource: "workflow", operation: "update" }), { [siteId(wf)]: "https://n8n.example.com" });
  assert.equal(w.refused, false, "forced");
  assert.equal(w.definition.steps["Read n8n"].kind, "blocked");
  assert.match(w.definition.steps["Read n8n"].blocked.reason, /^updates an n8n workflow: .*approval/);
});

test("convert: a local site makes the folder a local task, and MIGRATION.md says it keeps calling n8n", () => {
  const wf = wfWith({});
  const res = convertWf(wf, { [siteId(wf)]: "http://localhost:5678/api/v1" });
  const wr = res.report.workflows[0];
  assert.equal(wr.outcome.target, "local-task");
  assert.deepEqual(res.definition.secrets[0].hosts, ["localhost"]);
  const md = migrationMd(wr, res.definition);
  assert.match(md, /\*\*Keeps calling n8n:\*\* Read n8n reads workflows or executions from your n8n instance at localhost:5678 through its public API\. This workflow is useful only while n8n keeps running there; nothing is written to n8n\./);
  assert.match(md, /as a local task on your computer/);
});

// A host that answers like n8n's public API: workflows in pages of two by cursor.
function n8nHost() {
  const seen = [];
  const wfs = [{ id: "w1", name: "a" }, { id: "w2", name: "b" }, { id: "w3", name: "c" }];
  return {
    seen,
    http: async (q) => {
      const u = new URL(q.url);
      seen.push({ method: q.method, path: u.pathname, query: { ...q.query }, accept: q.headers?.Accept, auth: q.auth?.secret });
      if (u.pathname === "/api/v1/workflows") {
        const start = q.query.cursor === "c1" ? 2 : 0;
        return { status: 200, headers: { "content-type": "application/json" }, body: { data: wfs.slice(start, start + 2), nextCursor: start === 0 ? "c1" : null } };
      }
      if (u.pathname === "/api/v1/workflows/w2") return { status: 200, body: { id: "w2", name: "b", nodes: [] } };
      if (u.pathname === "/api/v1/executions") return { status: 200, body: { data: [{ id: "9" }], nextCursor: "e1" } };
      if (u.pathname === "/api/v1/executions/9") return { status: 200, body: { id: "9", data: {} } };
      return { status: 404, body: { message: "Not Found" } };
    },
  };
}
async function runRead(params, { items = [{}], onError } = {}) {
  const wf = wfWith(params);
  if (onError) wf.nodes[1].onError = onError;
  const def = convertWf(wf, { [siteId(wf)]: "https://n8n.example.com/api/v1" }).definition;
  const host = n8nHost();
  const res = await run(def, { trigger: { node: "Every night", items: items.map((json) => ({ json })) }, host: { ...host, tool: async () => ({ ok: true }) }, clock: { startedAt: "2026-11-16T09:00:00Z" }, virtualTime: true });
  const out = (res.runData["Read n8n"]?.[0]?.data?.main?.[0] ?? []).map((it) => it.json);
  return { res, out, seen: host.seen };
}

test("runtime: workflow Get Many follows the cursor with Return All (the default) and gives one item per workflow", async () => {
  const { out, seen } = await runRead({ filters: {} });
  assert.deepEqual(out.map((j) => j.id), ["w1", "w2", "w3"]);
  assert.deepEqual(seen.map((s) => [s.path, s.query]), [["/api/v1/workflows", {}], ["/api/v1/workflows", { cursor: "c1" }]]);
  assert.equal(seen[0].accept, "application/json");
  assert.equal(seen[0].auth, "n8n account");
});

test("runtime: without Return All one page with limit, filters in the node's order (tags only when set)", async () => {
  const { out, seen } = await runRead({ returnAll: false, limit: 3, filters: { activeWorkflows: true, tags: "a,b", name: "", projectId: "p1", excludePinnedData: true } });
  assert.deepEqual(out.map((j) => j.id), ["w1", "w2"], "no further page, no trimming");
  assert.equal(seen.length, 1);
  assert.deepEqual(Object.entries(seen[0].query), [["limit", 3], ["active", true], ["tags", "a,b"], ["name", ""], ["projectId", "p1"], ["excludePinnedData", true]]);
  const off = await runRead({ filters: { activeWorkflows: false, tags: "" } });
  assert.deepEqual(off.seen[0].query, { active: false });
});

test("runtime: execution Get Many sends limit 100 by default, the workflow, status and includeData", async () => {
  const { out, seen } = await runRead({ resource: "execution", filters: { workflowId: { __rl: true, mode: "url", value: "https://x.app.n8n.cloud/workflow/w1" }, status: "error" }, options: { activeWorkflows: true } });
  assert.deepEqual(out, [{ id: "9" }]);
  assert.deepEqual(seen.map((s) => [s.path, s.query]), [["/api/v1/executions", { limit: 100, workflowId: "w1", status: "error", includeData: true }]]);
  const empty = await runRead({ resource: "execution", filters: { workflowId: { __rl: true, mode: "list", value: "" } } });
  assert.deepEqual(empty.seen[0].query, { limit: 100 }, "an empty workflow filter is not sent");
});

test("runtime: Get by id per input item, a URL-mode id, includeData on an execution, n8n's 404 message", async () => {
  const per = await runRead({ operation: "get", workflowId: { __rl: true, mode: "id", value: "={{ $json.id }}" } }, { items: [{ id: "w2" }, { id: "w2" }] });
  assert.deepEqual(per.out, [{ id: "w2", name: "b", nodes: [] }, { id: "w2", name: "b", nodes: [] }]);
  const url = await runRead({ operation: "get", workflowId: { __rl: true, mode: "url", value: "https://x.app.n8n.cloud/workflow/w2" } });
  assert.equal(url.seen[0].path, "/api/v1/workflows/w2");
  const ex = await runRead({ resource: "execution", operation: "get", executionId: "9", options: { activeWorkflows: true } });
  assert.deepEqual(ex.seen.map((s) => [s.path, s.query]), [["/api/v1/executions/9", { includeData: true }]]);
  const missing = await runRead({ operation: "get", workflowId: { __rl: true, mode: "id", value: "nope" } }, { onError: "continueRegularOutput" });
  assert.deepEqual(missing.out, [{ error: "The resource you are requesting could not be found" }]);
});
