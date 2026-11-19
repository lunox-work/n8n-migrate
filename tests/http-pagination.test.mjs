// HTTP Request pagination as n8n 2.47 runs it (HttpRequestV3 builds the settings, n8n-core
// requestWithAuthenticationPaginated requests page after page with $response and $pageCount):
// one request per page under the allowlist, each page's body becomes items.
import { test } from "node:test";
import assert from "node:assert/strict";
import { node, wf, run, out, start } from "./runtime-helpers.mjs";

const HOST = "api.example.com";
const allow = { tools: [], sql: [], http: [{ method: "GET", host: HOST, pathPrefix: "/" }] };
const httpStep = (pagination, extra = {}) =>
  node("Search", "httpRequest", { url: `https://${HOST}/v2/search`, sendQuery: true, queryParameters: { parameters: [{ name: "q", value: "={{ $json.q }}" }] }, options: { pagination: { pagination } }, ...extra }, { v: 4.2 });

function pagesHost(pages) {
  const seen = [];
  return {
    seen,
    http: async (r) => {
      seen.push({ url: r.url, query: r.query });
      const n = Number(r.query?.page ?? new URL(r.url).searchParams.get("page") ?? 1);
      return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(pages[n - 1] ?? { data: [] }) };
    },
  };
}

test("update a parameter per page until the complete expression holds, with a page limit", async () => {
  const pg = { parameters: { parameters: [{ name: "page", value: "={{ $pageCount + 1 }}" }] }, maxRequests: 3, requestInterval: 2000, limitPagesFetched: true, completeExpression: "={{ $response.body.data.isEmpty() }}", paginationCompleteWhen: "other" };
  const def = wf([start(), httpStep(pg)], [["Start", "Search"]], { allow });
  const host = pagesHost([{ data: [1, 2] }, { data: [3] }, { data: [] }]);
  const r = await run(def, { host, trigger: [{ q: "agency" }] });
  assert.equal(r.status, "done", JSON.stringify(r.error));
  assert.deepEqual(host.seen.map((s) => s.query), [{ q: "agency", page: "1" }, { q: "agency", page: "2" }, { q: "agency", page: "3" }].map((q) => ({ ...q, page: Number(q.page) })));
  assert.deepEqual(out(r, "Search"), [{ data: [1, 2] }, { data: [3] }, { data: [] }], "every page fetched is output, the empty last one too (n8n stops after it)");
  const limited = await run(wrapMax(def, 2), { host: pagesHost([{ data: [1] }, { data: [2] }, { data: [3] }]), trigger: [{ q: "x" }] });
  assert.equal(out(limited, "Search").length, 2);
});
function wrapMax(def, n) {
  const d = structuredClone(def);
  d.steps.Search.params.options.pagination.pagination.maxRequests = n;
  return d;
}

test("response is empty: an empty array ends it; next URL mode follows the response", async () => {
  const empty = wf([start(), httpStep({ parameters: { parameters: [{ name: "page", value: "={{ $pageCount + 1 }}" }] }, paginationCompleteWhen: "responseIsEmpty" })], [["Start", "Search"]], { allow });
  const host = { seen: [], http: async (r) => (host.seen.push(r.query.page), { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(r.query.page < 3 ? [{ n: r.query.page }] : []) }) };
  const r = await run(empty, { host, trigger: [{ q: "x" }] });
  assert.equal(r.status, "done", JSON.stringify(r.error));
  assert.deepEqual(host.seen, [1, 2, 3]);
  assert.deepEqual(out(r, "Search"), [{ n: 1 }, { n: 2 }]);

  const next = wf([start(), httpStep({ paginationMode: "responseContainsNextURL", nextURL: "={{ $response.body.next }}", paginationCompleteWhen: "other", completeExpression: "={{ !$response.body.next }}" })], [["Start", "Search"]], { allow });
  const urls = [];
  const h2 = {
    http: async (r) => {
      urls.push(r.url);
      const page = Number(new URL(r.url).searchParams.get("page") ?? 1);
      return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [page], next: page < 2 ? `https://${HOST}/v2/search?page=${page + 1}` : null }) };
    },
  };
  const r2 = await run(next, { host: h2, trigger: [{ q: "x" }] });
  assert.equal(r2.status, "done", JSON.stringify(r2.error));
  assert.deepEqual(urls, [`https://${HOST}/v2/search`, `https://${HOST}/v2/search?page=2`]);
});

test("a next URL on another host is refused by the allowlist; the same page five times stops the node", async () => {
  const off = wf([start(), httpStep({ paginationMode: "responseContainsNextURL", nextURL: "={{ $response.body.next }}", paginationCompleteWhen: "other", completeExpression: "={{ !$response.body.next }}" })], [["Start", "Search"]], { allow });
  const r = await run(off, { host: { http: async () => ({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ next: "https://evil.example/x" }) }) }, trigger: [{ q: "x" }] });
  assert.equal(r.status, "failed");
  assert.match(r.error.message, /not in the definition's allowlist/);

  const loop = wf([start(), httpStep({ parameters: { parameters: [{ name: "page", value: "={{ 1 }}" }] }, paginationCompleteWhen: "responseIsEmpty" })], [["Start", "Search"]], { allow });
  const same = await run(loop, { host: { http: async () => ({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify([1]) }) }, trigger: [{ q: "x" }] });
  assert.equal(same.status, "failed");
  assert.match(same.error.message, /identical 5x/);
});

test("preflight names the step whose URL is built at run time: its host cannot be known before a run", async () => {
  const { preflight } = await import("../skills/n8n-migrate/runtime/src/api.mjs");
  const paged = wf([start(), httpStep({ parameters: { parameters: [{ name: "page", value: "={{ $pageCount + 1 }}" }] } })], [["Start", "Search"]], { allow });
  assert.equal(preflight(paged).ok, true, "pagination runs");
  const anyHost = wf([start(), node("Get", "httpRequest", { url: "={{ $json.url }}" }, { v: 4.2 })], [["Start", "Get"]], { allow: { tools: [], sql: [], http: [{ method: "GET", host: "*", note: 'step "Get": URL built at run time' }] } });
  assert.match(preflight(anyHost).issues.find((i) => i.level === "error").message, /^step "Get": a request with a URL built at run time .* its host cannot be known before a run/);
});

test("HTTP Request file responses and binary bodies as n8n's HTTP Request v3 builds them", async () => {
  const H = "files.example.com";
  const allowAll = { tools: [], sql: [], http: [{ method: "GET", host: H, pathPrefix: "/" }, { method: "POST", host: H, pathPrefix: "/" }] };
  const bytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0xe9, 0x00]);
  const seen = [];
  const host = {
    http: async (r) => {
      seen.push(r);
      if (r.method === "POST") return { status: 201, headers: { "content-type": "application/json" }, body: JSON.stringify({ id: 7 }) };
      // A latin1 byte string under a binary type (the bench's in-process host) and bodyBase64 (the driver).
      if (r.url.endsWith("/doc")) return { status: 200, headers: { "content-type": "application/pdf; charset=binary", "content-disposition": 'attachment; filename="report.pdf"' }, body: String.fromCharCode(...bytes) };
      return { status: 200, headers: { "content-type": "image/png" }, bodyBase64: Buffer.from(bytes).toString("base64") };
    },
  };
  const def = wf(
    [
      start(),
      node("Doc", "httpRequest", { url: `https://${H}/files/doc`, options: {} }, { v: 4.2 }),
      node("Img", "httpRequest", { url: `https://${H}/`, options: { response: { response: { responseFormat: "file", outputPropertyName: "pic" } } } }, { v: 4.2 }),
      node("Up", "httpRequest", { method: "POST", url: `https://${H}/upload`, sendBody: true, contentType: "binaryData", inputDataFieldName: "data", sendHeaders: true, headerParameters: { parameters: [{ name: "Content-Type", value: "text/plain" }] }, options: {} }, { v: 4.2 }),
    ],
    [["Start", "Doc"], ["Doc", "Img"], ["Img", "Up"]],
    { allow: allowAll },
  );
  const r = await run(def, { host, trigger: [{ q: 1 }] });
  assert.equal(r.status, "done", JSON.stringify(r.error));
  const doc = r.runData.Doc[0].data.main[0][0];
  assert.deepEqual(doc.json, { q: 1 });
  assert.equal(doc.binary.data.fileName, "report.pdf");
  assert.equal(doc.binary.data.mimeType, "application/pdf");
  assert.equal(doc.binary.data.directory, `https://${H}/files/doc`);
  assert.equal(doc.binary.data.data, Buffer.from(bytes).toString("base64"));
  const img = r.runData.Img[0].data.main[0][0];
  assert.deepEqual(Object.keys(img.binary).sort(), ["data", "pic"]);
  assert.equal(img.binary.pic.fileName, "pic.png", "no name from the URL: <property>.<extension>");
  const post = seen.find((x) => x.method === "POST");
  assert.equal(post.bodyEncoding, "base64");
  assert.equal(post.body, Buffer.from(bytes).toString("base64"));
  assert.equal(post.headers["content-type"], "application/pdf", "the binary's type wins over the step's header");
});
