// Bench changes of round 4 batch 2 (R4k): P107 (n8n's attribution footer), P108 (the in-process
// host follows redirects).

import { test } from "node:test";
import assert from "node:assert/strict";
import { compare, fromHttp, fromTool, stripAttribution } from "../evals/bench/compare.mjs";

const link = (type, id = "7610af6949bb") => `https://n8n.io/?utm_source=n8n-internal&utm_medium=powered_by&utm_campaign=${encodeURIComponent(type)}${id ? "_" + id : ""}`;
// n8n 2.47.7's HTML footer as its Send Email and Gmail nodes write it (tabs included).
const htmlFooter = (body, type, id) => `\n\t\t\t\t\t${body}\n\t\t\t\t\t<br>\n\t\t\t\t\t<br>\n\t\t\t\t\t---\n\t\t\t\t\t<br>\n\t\t\t\t\t<em>This email was sent automatically with <a href="${link(type, id)}" target="_blank">n8n</a></em>\n\t\t\t\t\t`;

test("P107: only n8n's own attribution footer, for the node type of the effect, is removed", () => {
  const send = "n8n-nodes-base.emailSend";
  assert.deepEqual(stripAttribution(htmlFooter("<p>Hi Tom</p>", send), send), { text: "<p>Hi Tom</p>", stripped: "html" });
  assert.deepEqual(stripAttribution(htmlFooter("<p>Hi</p>", send, ""), send), { text: "<p>Hi</p>", stripped: "html" }, "no instance id");
  assert.deepEqual(stripAttribution(htmlFooter("", send).trim(), send), { text: "", stripped: "html" }, "an empty body the transport trimmed");
  assert.deepEqual(stripAttribution("Hello\n\n---\nThis email was sent automatically with n8n\nhttps://n8n.io", "n8n-nodes-base.gmail"), { text: "Hello", stripped: "text" });
  // Anything else stays: another node type's link, a changed sentence, a footer not at the end.
  assert.equal(stripAttribution(htmlFooter("<p>Hi</p>", "n8n-nodes-base.gmail"), send).stripped, false);
  assert.equal(stripAttribution(htmlFooter("<p>Hi</p>", send).replace("automatically", "by hand"), send).stripped, false);
  assert.equal(stripAttribution(htmlFooter("<p>Hi</p>", send) + "<p>P.S.</p>", send).stripped, false);
  assert.equal(stripAttribution("Hello\n---\nThis email was sent automatically with n8n\nhttps://n8n.io", send).stripped, false);
});

test("P107: an SMTP send with n8n's footer pairs with the Gmail substitution; the Claude side is never stripped", () => {
  const smtp = (html) => fromHttp({ method: "SMTP", proxied: "smtp://mock", path: "/send", body: { to: ["tom@mail.example"], subject: "Thanks", html }, bodyEncoding: "json" });
  const gmail = (htmlBody) => fromTool({ connector: "gmail", tool: "send_message", args: { to: ["tom@mail.example"], subject: "Thanks", htmlBody } });
  const c = compare([smtp(htmlFooter("<p>Hi Tom</p>", "n8n-nodes-base.emailSend"))], [gmail("<p>Hi Tom</p>")]);
  assert.equal(c.ok, true, JSON.stringify(c.writes));
  assert.deepEqual(c.attributionStripped, [{ effect: "mail.send:tom@mail.example", field: "body", form: "html", nodeType: "n8n-nodes-base.emailSend" }]);
  // The same footer written by the Claude side is a difference.
  const back = compare([smtp("<p>Hi Tom</p>")], [gmail(htmlFooter("<p>Hi Tom</p>", "n8n-nodes-base.emailSend"))]);
  assert.equal(back.ok, false);
  assert.equal(back.attributionStripped, undefined);
  // A body that differs besides the footer still differs.
  assert.equal(compare([smtp(htmlFooter("<p>Hi Tom</p>", "n8n-nodes-base.emailSend"))], [gmail("<p>Hi Lena</p>")]).ok, false);
});

test("P108: the in-process host follows a redirect as executeHttp does, logging each hop", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { convertItems, loadReferences } = await import("../skills/n8n-migrate/scripts/convert.mjs");
  const { loadInput } = await import("../skills/n8n-migrate/scripts/analyze.mjs");
  const { runInProcess } = await import("../evals/bench/claude-side.mjs");
  const wfOf = (options) => ({
    id: "p108", name: "P108", settings: { executionOrder: "v1" },
    nodes: [
      { parameters: {}, name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0] },
      { parameters: { url: "https://wiki.example/wiki/Special:Random", options }, name: "Get Page", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [200, 0] },
      { parameters: { method: "POST", url: "https://hooks.example/notify", sendBody: true, bodyParameters: { parameters: [{ name: "page", value: "={{ $json.data ?? $json.error ?? 'none' }}" }] }, options: {} }, name: "Notify", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [400, 0] },
    ],
    connections: { Start: { main: [[{ node: "Get Page", type: "main", index: 0 }]] }, "Get Page": { main: [[{ node: "Notify", type: "main", index: 0 }]] } },
  });
  const fx = {
    template: 0, variant: "normal", now: "2026-11-16T09:00:00Z", trigger: { node: "Start", kind: "manual", items: [{ json: {} }] },
    reads: [{ node: "Get Page", http: { responses: [
      { method: "GET", url: "https://wiki.example/wiki/Special:Random", status: 302, headers: { location: "/wiki/Lighthouse" }, body: "" },
      { method: "GET", url: "https://wiki.example/wiki/Lighthouse", status: 200, body: "the lighthouse page" },
    ] } }],
    expect: {},
  };
  const dir = mkdtempSync(join(tmpdir(), "n8m-p108-"));
  const run = async (options) => {
    const wf = wfOf(options);
    writeFileSync(join(dir, "wf.json"), JSON.stringify(wf));
    const def = convertItems(loadInput(join(dir, "wf.json")).items, { refs: loadReferences(), now: Date.parse("2026-11-14T00:00:00Z"), forceConvert: true })[0].definition;
    const folder = join(dir, `folder-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(folder, "runtime"), { recursive: true });
    writeFileSync(join(folder, "definition.json"), JSON.stringify(def));
    for (const f of ["runner-core.mjs", "luxon.mjs"]) copyFileSync(new URL(`../skills/n8n-migrate/runtime/dist/${f}`, import.meta.url), join(folder, "runtime", f));
    return runInProcess(folder, fx, { wf, recordings: [], mode: "replay", liveFallback: false, startedAt: fx.now, log: () => {} });
  };
  try {
    const r = await run({});
    assert.deepEqual(r.seen.http.map((h) => [h.method, h.url, h.redirectFrom ?? null]), [
      ["GET", "https://wiki.example/wiki/Special:Random", null],
      ["GET", "https://wiki.example/wiki/Lighthouse", "https://wiki.example/wiki/Special:Random"],
      ["POST", "https://hooks.example/notify", null],
    ]);
    assert.equal(r.seen.http[2].body.page, "the lighthouse page");
    // followRedirects off: the 302 itself is the answer (n8n then fails on it unless told not to).
    const off = await run({ redirect: { redirect: { followRedirects: false } }, response: { response: { neverError: true } } });
    assert.deepEqual(off.seen.http.map((h) => h.url).slice(0, 2), ["https://wiki.example/wiki/Special:Random", "https://hooks.example/notify"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
