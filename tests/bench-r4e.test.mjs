// Round-4 bench fixes (PROPOSALS P52, P53, P61, P83-P94): the pure parts, without Docker.

import { test } from "node:test";
import assert from "node:assert/strict";

test("P83: an OOM-killed n8n run is a failed baseline with status oom, never a bench error", async () => {
  const { runN8n, oomResult } = await import("../evals/bench/n8n-side.mjs");
  const shim = { setSession() {}, session: { calls: [] } };
  const prep = { id: 1, variant: "normal", files: [], models: [], routes: [], fixture: { trigger: { items: [], node: "T" }, reads: [] }, sources: {}, wf: { nodes: [] } };
  const crash = async () => {
    throw new Error("fetch failed");
  };
  const killed = () => ({ exists: true, running: false, oomKilled: true, exitCode: 137 });
  const r = await runN8n(prep, { shim, modelSession: {}, runWorkflow: crash, copyIn() {}, containerState: killed });
  assert.equal(r.result.status, "oom");
  assert.match(r.result.error.message, /memory cap .*exit 137.*fetch failed/);
  assert.equal(r.fallbackable, false);
  // A crash with the container still up (or stopped for another reason) stays a bench error.
  await assert.rejects(runN8n(prep, { shim, modelSession: {}, runWorkflow: crash, copyIn() {}, containerState: () => ({ running: true, oomKilled: false }) }), /fetch failed/);
  await assert.rejects(runN8n(prep, { shim, modelSession: {}, runWorkflow: crash, copyIn() {} }), /fetch failed/);
  assert.equal(oomResult(new Error("x")).status, "oom");
});

test("P85: a route URL without a path answers a request for /, on the mock, the in-process host and the driver's host mock alike", async () => {
  const { pickRoute } = await import("../evals/n8n/mock-server.mjs");
  const R = [{ method: "GET", url: "https://site.example", status: 200, body: "home" }];
  const sp = new URLSearchParams("");
  assert.equal(pickRoute(R, "GET", "https://site.example", "/", sp, new Map())?.f.body, "home");
  assert.equal(pickRoute(R, "GET", "https://site.example", "/other", sp, new Map()), null);
  assert.equal(pickRoute(R, "GET", null, "/", sp, new Map())?.f.body, "home", "a request to the mock directly matched by path, as before");
});

test("P84: the in-process host adds the transport headers the mock's Node server adds", async () => {
  const { transportHeaders } = await import("../evals/n8n/mock-server.mjs");
  const d = new Date("2026-11-15T14:27:03Z");
  assert.deepEqual(transportHeaders({ "content-type": "text/html" }, d), { date: "Sun, 15 Nov 2026 14:27:03 GMT", connection: "close", "transfer-encoding": "chunked" });
  assert.deepEqual(transportHeaders({ "Content-Length": "3", Date: "x" }, d), { connection: "close" }, "a fixture's own length or date wins, as in Node");
});

test("P61: a node that ships no credential gets the first one its n8n description declares for its parameters", async () => {
  const { credentialSpecs, credentialTypeFor, declaredCredential } = await import("../evals/bench/n8n-side.mjs");
  const specs = credentialSpecs([
    { name: "n8n-nodes-base.dropbox", version: 1, credentials: [{ name: "dropboxApi", required: true, displayOptions: { show: { authentication: ["accessToken"] } } }, { name: "dropboxOAuth2Api", required: true, displayOptions: { show: { authentication: ["oAuth2"] } } }], properties: [{ name: "authentication", default: "accessToken" }] },
    { name: "n8n-nodes-base.emailSend", version: [2, 2.1], credentials: [{ name: "smtp", required: true }] },
    { name: "n8n-nodes-base.wait", version: 1.1, credentials: [{ name: "httpBasicAuth", required: true, displayOptions: { show: { incomingAuthentication: ["basicAuth"] } } }], properties: [{ name: "incomingAuthentication", default: "none" }] },
    { name: "n8n-nodes-base.x", version: [1, 2], credentials: [{ name: "xOld", displayOptions: { show: { "@version": [{ _cnd: { lt: 2 } }] } } }, { name: "xNew", displayOptions: { show: { "@version": [{ _cnd: { gte: 2 } }] } } }] },
  ]);
  const node = (type, parameters = {}, typeVersion = 1) => ({ type, parameters, typeVersion, name: "n" });
  assert.equal(declaredCredential(node("n8n-nodes-base.dropbox"), specs), "dropboxApi", "the parameter's default picks the credential");
  assert.equal(declaredCredential(node("n8n-nodes-base.dropbox", { authentication: "oAuth2" }), specs), "dropboxOAuth2Api");
  assert.equal(declaredCredential(node("n8n-nodes-base.emailSend", {}, 2.1), specs), "smtp");
  assert.equal(declaredCredential(node("n8n-nodes-base.wait", {}, 1.1), specs), null, "a credential the parameters hide is never attached");
  assert.equal(declaredCredential(node("n8n-nodes-base.x", {}, 2), specs), "xNew");
  assert.equal(declaredCredential(node("n8n-nodes-base.x", {}, 1), specs), "xOld");
  assert.equal(credentialTypeFor(node("n8n-nodes-base.googleSheets", { authentication: "serviceAccount" }), specs), "googleApi", "the fixed list wins");
  assert.equal(credentialTypeFor(node("n8n-nodes-base.emailSend", {}, 2.1)), null, "without specs only the fixed list");
});

test("P52: a fixture with routes on localhost runs with localhost out of the n8n container's NO_PROXY; others keep the shared container", async () => {
  const { templateEnv, loopbackRouteHosts } = await import("../evals/bench/n8n-side.mjs");
  const routes = [{ node: "Get", method: "GET", url: "http://localhost:5678/rest/workflows" }, { node: "(bench)", method: "POST", url: "https://oauth2.googleapis.com/token" }];
  assert.deepEqual(loopbackRouteHosts(routes), ["localhost"]);
  const t = templateEnv({ routes, wf: { nodes: [] } });
  assert.equal(t.extraEnv.NO_PROXY, "127.0.0.1,::1,mock");
  assert.match(t.needs[0], /P52/);
  assert.deepEqual(templateEnv({ routes: [{ node: "A", method: "GET", url: "https://api.example/x" }], wf: { nodes: [] } }), { extraEnv: {}, runners: false, needs: [] });
});

test("container configuration hash: env, image and the runners sidecar each change it; key order does not", async () => {
  const { configHash } = await import("../evals/n8n/container.mjs");
  const base = configHash({ extraEnv: { A: "1", B: "2" } });
  assert.equal(configHash({ extraEnv: { B: "2", A: "1" } }), base);
  assert.notEqual(configHash({ extraEnv: { A: "1" } }), base, "a value dropped changes it");
  assert.notEqual(configHash({ extraEnv: { A: "1", B: "2" }, runners: true }), base);
  assert.notEqual(configHash({ extraEnv: { A: "1", B: "2" }, image: "other:1" }), base);
});

test("P93: only a template with an enabled Execute Command node runs with NODES_EXCLUDE=[]", async () => {
  const { templateEnv } = await import("../evals/bench/n8n-side.mjs");
  const wf = (disabled) => ({ nodes: [{ name: "Cmd", type: "n8n-nodes-base.executeCommand", disabled }] });
  assert.equal(templateEnv({ routes: [], wf: wf(false) }).extraEnv.NODES_EXCLUDE, "[]");
  assert.equal(templateEnv({ routes: [], wf: wf(true) }).extraEnv.NODES_EXCLUDE, undefined, "a disabled node needs nothing");
});

test("P92: a Python Code node gets the runners sidecar with exactly the modules it imports allowed", async () => {
  const { templateEnv, pythonImports } = await import("../evals/bench/n8n-side.mjs");
  const { runnersConfig } = await import("../evals/n8n/container.mjs");
  assert.deepEqual(pythonImports("import numpy as np\nfrom sklearn.cluster import KMeans\nimport os.path, json\nfrom . import local"), ["json", "numpy", "os", "sklearn"]);
  const t = templateEnv({ routes: [], wf: { nodes: [{ name: "Py", type: "n8n-nodes-base.code", parameters: { language: "python", pythonCode: "import re\nreturn []" } }] } });
  assert.deepEqual(t.runners, { stdlib: ["re"], external: ["re"] });
  assert.equal(templateEnv({ routes: [], wf: { nodes: [{ name: "Js", type: "n8n-nodes-base.code", parameters: { jsCode: "return []" } }] } }).runners, false);
  const image = { "task-runners": [{ "runner-type": "javascript", "env-overrides": { NODE_FUNCTION_ALLOW_BUILTIN: "crypto", NODE_FUNCTION_ALLOW_EXTERNAL: "moment" } }, { "runner-type": "python", "env-overrides": { N8N_RUNNERS_STDLIB_ALLOW: "", N8N_RUNNERS_EXTERNAL_ALLOW: "" } }] };
  const cfg = runnersConfig(image, t.runners);
  assert.equal(cfg["task-runners"][1]["env-overrides"].N8N_RUNNERS_STDLIB_ALLOW, "re");
  assert.equal(cfg["task-runners"][0]["env-overrides"].NODE_FUNCTION_ALLOW_EXTERNAL, "", "the JS runner keeps internal mode's defaults");
  assert.equal(image["task-runners"][1]["env-overrides"].N8N_RUNNERS_STDLIB_ALLOW, "", "the image's config is not changed in place");
});

test("P94: the bench image carries the pinned community packages; the image name follows the pins", async () => {
  const { benchImage, communityPackages, IMAGE } = await import("../evals/n8n/container.mjs");
  const pkgs = communityPackages();
  assert.ok(pkgs.every((p) => /^sha512-/.test(p.integrity) && /^\d+\.\d+\.\d+$/.test(p.version)), "every package pinned by version and integrity");
  assert.match(benchImage(), /^n8n2claude-n8n:2\.47\.7-[0-9a-f]{12}$/);
  assert.equal(benchImage([]), IMAGE, "no package: n8n's own image");
  assert.notEqual(benchImage([{ ...pkgs[0], version: "9.9.9" }]), benchImage(), "another pin, another image");
});

test("P53: an SMTP message from the sink is a mail.send effect that pairs with a Gmail send the bench approved as a substitution", async () => {
  const { smtpMessage } = await import("../evals/n8n/mock-server.mjs");
  const { fromHttp, fromTool, compare } = await import("../evals/bench/compare.mjs");
  const raw = 'From: shop@example.com\r\nTo: Ana <ana@example.com>\r\nSubject: =?UTF-8?Q?Your_coupon?=\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n<p>10% off</p>=\r\n<p>bye</p>';
  const body = smtpMessage(raw, { from: "shop@example.com", to: ["ana@example.com", "boss@example.com"] });
  assert.deepEqual([body.to, body.bcc, body.subject, body.html], [["Ana <ana@example.com>"], ["boss@example.com"], "Your coupon", "<p>10% off</p><p>bye</p>"]);
  const n = fromHttp({ method: "SMTP", proxied: "smtp://mock", path: "/send", body, bodyEncoding: "json" }, "n8n");
  assert.deepEqual([n.service, n.action, n.target], ["mail", "send", "ana@example.com"]);
  const c = fromTool({ connector: "gmail", tool: "send_message", args: { to: ["ana@example.com"], bcc: ["boss@example.com"], subject: "Your coupon", htmlBody: "<p>10% off</p><p>bye</p>" } }, "claude");
  const r = compare([n], [c]);
  assert.equal(r.ok, true, JSON.stringify(r.writes));
  assert.deepEqual(r.substituted, [{ effect: "mail.send:ana@example.com", id: "smtp-to-mail-connector", from: "gmail.send" }]);
  const wrong = fromTool({ connector: "gmail", tool: "send_message", args: { to: ["ana@example.com"], subject: "Other", htmlBody: "<p>10% off</p><p>bye</p>" } }, "claude");
  assert.equal(compare([n], [wrong]).ok, false, "a different subject or a missing Bcc still fails");
  // n8n's own Gmail REST send keeps pairing with the Gmail tool call; only the extra one substitutes.
  const own = { ...c, side: "n8n" };
  const r2 = compare([own, n], [c, { ...c }]);
  assert.equal(r2.ok, true, JSON.stringify(r2.writes));
  assert.equal(r2.substituted.length, 1);
  assert.equal(compare([own], [c]).substituted, undefined, "no SMTP send on n8n's side: nothing substitutes");
});

test("P86: an expression-mode LLM API URL with nothing to evaluate is the literal URL, so the node can be listed as a model", async () => {
  const { modelRoute, literalUrl } = await import("../evals/bench/n8n-side.mjs");
  const http = (url) => ({ name: "Call", type: "n8n-nodes-base.httpRequest", parameters: { url } });
  assert.deepEqual(modelRoute(http("=https://api.openai.com/v1/chat/completions"), { listed: true }), { spec: null, host: "api.openai.com" });
  assert.match(modelRoute(http("=https://api.openai.com/{{ $json.path }}"), { listed: true }).why, /built at run time/);
  assert.equal(literalUrl("= https://x.example/a"), "https://x.example/a");
  assert.equal(literalUrl("https://x.example/a"), "https://x.example/a");
  assert.equal(literalUrl("={{ $json.u }}"), null);
});

test("P88: a response answered as if authorised is reported when the run used it", async () => {
  const { routesOf, logVsFixture } = await import("../evals/bench/n8n-side.mjs");
  const fx = { reads: [], writeReplies: [{ node: "Post", http: { responses: [{ method: "POST", url: "https://sheets.googleapis.com/v4/x", status: 200, body: {}, assumedAuthorised: true }] } }] };
  const prep = { routes: routesOf(fx).routes };
  assert.equal(prep.routes[0].assumedAuthorised, true);
  const used = [{ method: "POST", proxied: "https://sheets.googleapis.com", path: "/v4/x", fixture: "route POST https://sheets.googleapis.com/v4/x" }];
  assert.deepEqual(logVsFixture(prep, used).assumedAuthorised, [{ node: "Post", method: "POST", url: "https://sheets.googleapis.com/v4/x" }]);
  assert.equal(logVsFixture(prep, []).assumedAuthorised, undefined);
});

test("P89: a models or writes entry the template pins is warned about; the pins stay", async () => {
  const { pinnedWarnings } = await import("../evals/bench/validate.mjs");
  const wf = { pinData: { Trigger: [{}], Post: [{ json: { id: 1 } }] } };
  const fx = { trigger: { node: "Trigger" }, models: ["Agent"], writes: ["Post"] };
  assert.deepEqual(pinnedWarnings(fx, wf).length, 1);
  assert.match(pinnedWarnings(fx, wf)[0], /writes: "Post" is pinned/);
  assert.deepEqual(pinnedWarnings({ ...fx, writes: ["Trigger"] }, wf), [], "the trigger's own pin is the fixture's business");
});

test("P87: modules a template's Code nodes require are named, builtins told apart", async () => {
  const { codeModules } = await import("../evals/bench/n8n-side.mjs");
  const wf = { nodes: [
    { name: "A", type: "n8n-nodes-base.code", parameters: { jsCode: "const yt = require('youtube-transcript');\nconst c = require(\"crypto\");\nconst x = require('@scope/pkg/sub');" } },
    { name: "Py", type: "n8n-nodes-base.code", parameters: { language: "python", pythonCode: "require('x')" } },
    { name: "Off", type: "n8n-nodes-base.code", disabled: true, parameters: { jsCode: "require('lodash')" } },
    { name: "T", type: "@n8n/n8n-nodes-langchain.toolCode", parameters: { jsCode: "return require('node:fs')" } },
  ] };
  assert.deepEqual(codeModules(wf), [
    { node: "A", module: "youtube-transcript", builtin: false },
    { node: "A", module: "crypto", builtin: true },
    { node: "A", module: "@scope/pkg", builtin: false },
    { node: "T", module: "node:fs", builtin: true },
  ]);
});

test("P90: relative times in a fixture are filled from the run's start, the same on both sides", async () => {
  const { fillRelativeTimes } = await import("../evals/bench/n8n-side.mjs");
  const at = Date.parse("2026-11-16T09:00:00.000Z");
  const fx = { trigger: { items: [{ json: { created: "{{bench.now-5m}}", day: "{{bench.now+1d|date}}", ts: "{{bench.now|epoch}}", note: "posted {{bench.now-2h|rfc2822}}", other: "{{ $json.x }}" } }] } };
  assert.deepEqual(fillRelativeTimes(fx, at).trigger.items[0].json, { created: "2026-11-16T08:55:00.000Z", day: "2026-11-17", ts: 1794819600, note: "posted Mon, 16 Nov 2026 07:00:00 +0000", other: "{{ $json.x }}" });
  assert.deepEqual(fillRelativeTimes(fx, "2026-11-16T09:00:00.000Z"), fillRelativeTimes(fx, at), "an ISO start (a recording's startedAt) counts the same");
});
