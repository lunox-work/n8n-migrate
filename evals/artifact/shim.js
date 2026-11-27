// Artifact runtime shim for local checks (evals/artifact/check.mjs). Not shipped.
//
// Implements, in the page, the call shapes of the artifact runtime contract 0.2.96 as written
// down in skills/n8n-to-claude/references/artifact-runtime.md: `window.claude.use(name)`
// resolving frozen namespaces after a tick, `mcp` (callTool / listTools / server / watchTool /
// invalidate / describeTool, CallToolResult with `payload`, rejections {code, message}),
// `sample` (sample(input, opts) -> {text, truncated, modelTierApplied}, sample.json,
// sample.limits, onText) and `db` (doc/collection refs with the path grammar, get / set /
// update / delete / acquire / onSnapshot, where / orderBy / limit).
//
// The answers and the store live in Node behind one exposed function,
// window.__n8mShimCall(op, args), so two pages share one db (the lock check) and the tool
// answers come from the same canned outputs the in-process runner uses
// (tests/convert-mocks.mjs). window.__n8mShimConfig = {deny: ["sample", ...]} makes use()
// resolve null for those names.
(() => {
  "use strict";
  const cfg = window.__n8mShimConfig || {};
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  async function call(op, args) {
    const r = await window.__n8mShimCall(op, clone(args ?? null));
    if (r && r.__error) throw Object.freeze({ ...r.__error });
    return r;
  }

  // ---------- mcp ----------
  const mcp = Object.freeze({
    callTool(server, tool, input, options) {
      if (typeof server !== "string" || typeof tool !== "string") return Promise.reject({ code: "bad_request", message: "server and tool must be strings" });
      return call("mcp.callTool", { server, tool, input: input ?? null, options: options && { cache: options.cache } });
    },
    listTools(server) {
      return call("mcp.listTools", { server: server ?? null });
    },
    async server(name) {
      const listed = await call("mcp.listTools", { server: name });
      const s = listed.servers[0];
      if (!s || !s.tools.length) throw { code: "server_not_connected", server: name, message: `${name} is not connected` };
      const handle = {};
      for (const t of s.tools) handle[t.name] = async (input) => (await mcp.callTool(name, t.name, input)).payload;
      return Object.freeze(handle);
    },
    watchTool(server, tool, input, handler) {
      if (typeof handler !== "function") throw new TypeError("handler must be a function");
      let live = true;
      Promise.resolve().then(() => mcp.callTool(server, tool, input).then((result) => live && handler({ type: "data", result }), (error) => live && handler({ type: "error", error })));
      return () => { live = false; };
    },
    invalidate: async () => {},
    describeTool: async () => { throw { code: "bad_request", message: "no schema available in the shim" }; },
  });

  // ---------- sample ----------
  async function sample(input, opts = {}) {
    if (typeof input !== "string" && !Array.isArray(input)) throw { code: "invalid_request", message: "input must be a string or turns" };
    const r = await call("sample", { input, json: false, modelTier: opts.modelTier ?? null, cache: opts.cache ?? null });
    if (typeof opts.onText === "function") setTimeout(() => opts.onText({ text: r.text, delta: r.text }), 0);
    return { text: r.text, truncated: false, modelTierApplied: opts.modelTier || "default" };
  }
  sample.json = async (input, opts = {}) => {
    const r = await call("sample", { input, json: true, modelTier: opts.modelTier ?? null, cache: opts.cache ?? null });
    return r.value;
  };
  sample.limits = async () => ({ maxPromptBytes: 262144, tools: { maxCount: 16 }, modelTiers: ["default", "complex", "quick"] });
  Object.freeze(sample);

  // ---------- db ----------
  const SEG = /^[A-Za-z0-9_.~:@+-]+$/;
  function segments(path, wantEven) {
    const segs = String(path).split("/");
    if (!segs.length || segs.length > 16 || segs.some((s) => !s || s === "." || s === ".." || !SEG.test(s) || s.length > 200)) throw new TypeError(`invalid path "${path}"`);
    if ((segs.length % 2 === 0) !== wantEven) throw new TypeError(`"${path}" has ${segs.length} segments; a ${wantEven ? "document" : "collection"} path needs an ${wantEven ? "even" : "odd"} number`);
    return segs;
  }
  const snapDoc = (path, r) => Object.freeze({ id: path.split("/").pop(), exists: !!r, data: () => (r ? clone(r) : undefined), metadata: { fromCache: false, hasPendingWrites: false } });
  function docRef(path) {
    segments(path, true);
    const ref = {
      id: path.split("/").pop(),
      path,
      get: async () => snapDoc(path, await call("db.get", { path })),
      set: async (data) => {
        if (!data || typeof data !== "object" || Array.isArray(data)) throw { code: "invalid_argument", message: "body must be an object" };
        await call("db.set", { path, data });
      },
      update: async (data) => call("db.update", { path, data }),
      delete: async () => call("db.delete", { path }),
      acquire: async (o) => call("db.acquire", { path, holder: o?.holder, ttlMs: o?.ttlMs ?? 0, data: o?.data ?? null }),
      onSnapshot(next, error) {
        let last;
        let live = true;
        const tick = async () => {
          if (!live) return;
          try {
            const r = await call("db.get", { path });
            const k = JSON.stringify(r);
            if (k !== last) { last = k; next(snapDoc(path, r)); }
          } catch (e) { if (error) error(e); live = false; return; }
          setTimeout(tick, 400);
        };
        setTimeout(tick, 0);
        return () => { live = false; };
      },
      collection: (sub) => collRef(`${path}/${sub}`),
    };
    return Object.freeze(ref);
  }
  function query(path, spec) {
    const q = {
      where: (field, op, value) => query(path, { ...spec, where: [...spec.where, { field, op, value }] }),
      orderBy: (field, dir = "asc") => query(path, { ...spec, orderBy: { field, dir } }),
      limit: (n) => query(path, { ...spec, limit: n }),
      async get() {
        const rows = await call("db.query", { path, ...spec });
        const docs = rows.map((r) => snapDoc(r.path, r.data));
        return Object.freeze({ docs, size: docs.length, empty: !docs.length, docChanges: () => docs.map((doc, i) => ({ type: "added", doc, oldIndex: -1, newIndex: i })), metadata: { fromCache: false, hasPendingWrites: false } });
      },
      onSnapshot(next, error) {
        let last;
        let live = true;
        const tick = async () => {
          if (!live) return;
          try {
            const snap = await q.get();
            const k = JSON.stringify(snap.docs.map((d) => [d.id, d.data()]));
            if (k !== last) { last = k; next(snap); }
          } catch (e) { if (error) error(e); live = false; return; }
          setTimeout(tick, 400);
        };
        setTimeout(tick, 0);
        return () => { live = false; };
      },
    };
    return Object.freeze(q);
  }
  function collRef(path) {
    segments(path, false);
    const base = query(path, { where: [], orderBy: null, limit: null });
    return Object.freeze({ ...base, path, doc: (id) => docRef(`${path}/${id ?? Math.random().toString(36).slice(2, 12)}`), add: async (data) => { const r = docRef(`${path}/${Math.random().toString(36).slice(2, 12)}`); await r.set(data); return r; } });
  }
  const db = Object.freeze({ doc: docRef, collection: collRef });

  // ---------- permissions (built in) ----------
  // cfg.permDeny: names the viewer declines; every request is logged on window.__n8mPermRequests.
  const permDeny = new Set(cfg.permDeny || []);
  window.__n8mPermRequests = [];
  const permissions = Object.freeze({
    state: async (name) => (name === undefined ? {} : permDeny.has(name) ? "denied" : "granted"),
    request: async (names = []) => {
      window.__n8mPermRequests.push([...names]);
      return Object.fromEntries(names.map((n) => [n, permDeny.has(n) ? "denied" : "granted"]));
    },
    manage: async () => {},
  });

  const spaces = { mcp, sample, db, permissions };
  const deny = new Set(cfg.deny || []);
  window.claude = Object.freeze({
    use(name) {
      return new Promise((resolve) => setTimeout(() => resolve(deny.has(name) ? null : spaces[name] ?? null), 5));
    },
  });
})();
