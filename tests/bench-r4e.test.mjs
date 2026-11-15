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
