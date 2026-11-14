// Preloaded into the claude driver's node processes (NODE_OPTIONS --import, PROPOSALS P5).
// In a process that runs a folder's runtime/runner.mjs, and only there, global fetch is
// replaced by one that sends every request to the bench mock (N2C_BENCH_HTTP_MOCK, a host
// mock-server.mjs) in absolute form, so the mock logs and answers it as a proxied request
// (origin https://host), as it does for n8n. The Claude Code binary does not read
// NODE_OPTIONS, so the session's own traffic is untouched; hooks and other scripts keep the
// real fetch, and they make no http calls anyway.
// Each request goes out on its own connection (`agent: false`, `Connection: close`, PROPOSALS
// P8): the runner can be busy for longer than the mock's keep-alive timeout between two
// requests, and a pooled socket the mock has closed meanwhile fails the next request with
// `socket hang up` / `ECONNRESET`, a transport race of the bench's own making.

import { request } from "node:http";

const mock = process.env.N2C_BENCH_HTTP_MOCK;
if (mock && /[\\/]runtime[\\/]runner\.mjs$/.test(process.argv[1] ?? "")) {
  const m = new URL(mock);
  globalThis.fetch = (input, init = {}) =>
    new Promise((resolve, reject) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const u = new URL(url);
      const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries());
      let body = init.body;
      if (body instanceof URLSearchParams) {
        body = body.toString();
        headers["content-type"] ??= "application/x-www-form-urlencoded;charset=UTF-8";
      }
      if (body !== undefined && body !== null && typeof body !== "string" && !Buffer.isBuffer(body)) body = Buffer.from(body);
      delete headers.connection;
      const req = request({ host: m.hostname, port: m.port, method: init.method ?? "GET", path: u.href, agent: false, headers: { ...headers, host: u.host, connection: "close" } }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers)) for (const x of [].concat(v)) h.append(k, x);
          const empty = [101, 204, 205, 304].includes(res.statusCode);
          resolve(new Response(empty ? null : Buffer.concat(chunks), { status: res.statusCode, statusText: res.statusMessage, headers: h }));
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      init.signal?.addEventListener("abort", () => req.destroy(Object.assign(new Error("aborted"), { name: "AbortError" })));
      if (body !== undefined && body !== null) req.write(body);
      req.end();
    });
}
