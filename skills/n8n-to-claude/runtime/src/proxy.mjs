// The variables an n8n expression or Code node sees ($json, $input, $('Node'), $node, ...).
//
// Mirrors n8n-workflow's WorkflowDataProxy (n8n 2.47):
// - `$json` / `$binary` read the current node's input item at the current item index.
// - `$('X').item` (and `.pairedItem()`, `.itemMatching(i)`) walk the paired-item lineage
//   back from the current input item to node X through each run's `source`; several
//   paths that land on different items raise "Multiple matches".
// - `$('X').first()/.last()/.all(branch?, run?)` read X's output on the branch through
//   which X (directly or not) feeds this node, from its last run by default.
// - `$node["X"].json` is index-based: X's output item at the current item index.
// - `$items(node?, output?, run?)`, `$item(i)`, `$prevNode`, `$runIndex`, `$itemIndex`,
//   `$workflow`, `$execution`, `$vars`, `$now`, `$today`, `$parameter`, `$evaluateExpression`.
// - `$env` is blocked (n8n's default N8N_BLOCK_ENV_ACCESS_IN_NODE): access throws.
// Determinism: `$now`, `Date.now()`, `new Date()` and Luxon's `DateTime.now()` read the
// run's logical clock; `Math.random` is seeded from the run id, step and run index.

import { DateTime, Duration, Interval, Settings } from "../vendor/luxon.mjs";
import { ExpressionError, UnsupportedExpression, RunnerError, hasOwn } from "./util.mjs";
import { makeScope, evaluateExpression, resolveParameter } from "./expression.mjs";
import { extend, extendOptional, EXTENDED_FUNCTIONS, setExtensionRandom } from "./extensions.mjs";
import { jmespathSearch } from "./jmespath.mjs";

const DENY = ["document", "global", "window", "Window", "globalThis", "self", "alert", "prompt", "confirm", "eval", "uneval", "setTimeout", "setInterval", "setImmediate", "clearImmediate", "queueMicrotask", "Function", "require", "module", "Buffer", "__dirname", "__filename", "fetch", "XMLHttpRequest", "Promise", "Generator", "GeneratorFunction", "AsyncFunction", "AsyncGenerator", "AsyncGeneratorFunction", "WebAssembly", "Reflect", "Proxy", "escape", "unescape", "WebSocket", "importScripts", "navigator", "location", "localStorage", "sessionStorage", "indexedDB"];
const BLOCKED_OBJECT_STATICS = new Set(["defineProperty", "defineProperties", "setPrototypeOf", "getPrototypeOf", "getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"]);
const SafeObject = new Proxy(Object, {
  get(t, k, r) {
    if (BLOCKED_OBJECT_STATICS.has(k)) return undefined;
    if (k === "create") return (proto) => Object.create(proto);
    return Reflect.get(t, k, r);
  },
});

const ALLOWED = {
  Object: SafeObject, Array, Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array,
  Map, WeakMap, Set, WeakSet, Error, TypeError, SyntaxError, EvalError, RangeError, ReferenceError, URIError, Intl, String, RegExp, Number, BigInt,
  Infinity, NaN, isFinite, isNaN, parseFloat, parseInt, JSON, ArrayBuffer, DataView, encodeURI, encodeURIComponent,
  decodeURI, decodeURIComponent, Boolean, Symbol, DateTime, Interval, Duration, undefined: undefined,
};

// Per-run objects that depend on the clock and seed.
export function runtimeGlobals(run, seedKey) {
  const now = () => run.clock.now;
  const FrozenDate = new Proxy(Date, {
    construct: (t, args) => (args.length ? new Date(...args) : new Date(now())),
    apply: () => new Date(now()).toString(),
    get: (t, k, r) => (k === "now" ? now : Reflect.get(t, k, r)),
  });
  const random = run.randomFor(seedKey);
  const SeededMath = Object.create(Math, { random: { value: random, enumerable: false } });
  return { Date: FrozenDate, Math: SeededMath, random };
}

// Called before any evaluation: Luxon's global settings follow the run.
export function enterRun(run) {
  Settings.defaultZone = run.timezone;
  Settings.now = () => run.clock.now;
}

function pairedItemError(message, extra) {
  return new ExpressionError(message, extra);
}

// exec: one node execution (see engine.mjs NodeExecution). Returns a lookup(name) function.
export function createLookup(exec, itemIndex, extras = {}) {
  const run = exec.run;
  const graph = run.graph;
  const runData = run.runData;
  const input = exec.connectionInputData || [];
  const g = (exec._globals ??= runtimeGlobals(run, `${exec.name}#${exec.runIndex}`));
  setExtensionRandom(g.random);

  const taskOf = (src) => runData[src.previousNode]?.[src.previousNodeRun || 0];
  const outputOf = (task, src) => {
    const out = task?.data?.main?.[src.previousNodeOutput || 0];
    if (!out) throw pairedItemError("Can’t get data for expression", { description: `Expected output #${src.previousNodeOutput || 0} from node ${src.previousNode}` });
    return out;
  };
  const normPaired = (p) => (p == null ? [] : (Array.isArray(p) ? p : [p]).map((x) => (typeof x === "number" ? { item: x } : x)));

  // n8n's $getPairedItem: resolve the item of `dest` that `pairedItem` (an item of the
  // node after `source.previousNode`) descends from.
  function getPairedItem(dest, source, pairedItem, method = "$getPairedItem", seen = new Map()) {
    if (typeof pairedItem === "number") pairedItem = { item: pairedItem };
    const src = pairedItem.sourceOverwrite || source;
    if (!src) throw pairedItemError("Paired item resolution failed", { description: `Could not trace back to node '${dest}'` });
    const key = `${src.previousNode}|${src.previousNodeRun || 0}|${src.previousNodeOutput || 0}|${pairedItem.item}`;
    if (seen.has(key)) {
      const r = seen.get(key);
      if (r === null) throw new RunnerError("Paired item ancestry contains a cycle");
      if (r.error) throw r.error;
      return r.item;
    }
    seen.set(key, null);
    try {
      const task = taskOf(src);
      const out = outputOf(task, src);
      const item = out[pairedItem.item];
      if (src.previousNode === dest) {
        if (pairedItem.item >= out.length) throw pairedItemError(`Paired item data for ${method} from node '${src.previousNode}' is unavailable`);
        seen.set(key, { item });
        return item;
      }
      const next = normPaired(item?.pairedItem);
      if (!next.length) throw pairedItemError(`Paired item data for ${method} from node '${src.previousNode}' is unavailable. Ensure '${src.previousNode}' is providing the required output.`);
      const sources = task?.source ?? [];
      const links = next.flatMap((p) => {
        const inputIndex = p.input ?? 0;
        if (inputIndex >= sources.length) return [];
        return [{ source: p.sourceOverwrite ?? sources[inputIndex], pairedItem: { ...p, input: inputIndex } }];
      });
      // n8n throws a UserError here, which its evaluator swallows: the value becomes undefined.
      if (!links.length) throw new RunnerError(sources.length === 0 ? "Invalid expression" : "Branch not found");
      const results = links.map((l) => {
        try {
          return { ok: true, item: getPairedItem(dest, l.source, l.pairedItem, method, seen) };
        } catch (e) {
          return { ok: false, error: e };
        }
      });
      if (results.every((r) => !r.ok)) throw results[0].error;
      const ok = results.filter((r) => r.ok).map((r) => r.item);
      if (ok.some((x) => x !== ok[0])) throw pairedItemError("Multiple matches found", { description: `Multiple matching items for item [${pairedItem.item}]` });
      seen.set(key, { item: ok[0] });
      return ok[0];
    } catch (e) {
      seen.set(key, { error: e });
      throw e;
    }
  }

  // Node context (n8n getContext("node")): read-only view of what a node stored.
  const contextOf = (name) => Object.freeze({ ...(run.nodeContext?.[name] ?? {}) });
  const nodeExists = (name) => hasOwn(run.definition.steps, name);
  const executed = (name) => hasOwn(runData, name);
  const ensureExecuted = (name) => {
    if (!executed(name)) throw pairedItemError(`Node '${name}' hasn't been executed`, { description: "An expression references this node, but the node is unexecuted." });
  };
  // n8n getNodeExecutionData (long syntax).
  function nodeOutput(name, outputIndex, runIndex) {
    if (!nodeExists(name)) throw pairedItemError("Referenced node doesn't exist", { node: name });
    ensureExecuted(name);
    const runs = runData[name];
    const r = runIndex === undefined || runIndex === -1 ? runs.length - 1 : runIndex;
    if (runs.length <= r) throw pairedItemError(`Run ${r} of node "${name}" not found`);
    const main = runs[r].data?.main;
    if (!main?.length || main[0] === null) throw pairedItemError("No data found from `main` input");
    let oi = outputIndex;
    if (oi === undefined) {
      const c = graph.connectionIndexes(exec.name, name);
      if (c === undefined) throw pairedItemError(`connect "${exec.name}" to "${name}"`);
      oi = c.sourceIndex;
    }
    if (main.length <= oi) throw pairedItemError(`Node "${name}" has no branch with index ${oi}.`);
    return main[oi] ?? [];
  }

  function dollar(name) {
    if (!name) {
      name = exec.source?.main?.[0]?.previousNode;
      if (!name) throw pairedItemError("When calling $(), please specify a node");
    }
    if (!nodeExists(name)) throw pairedItemError("Referenced node doesn't exist", { node: name });
    const pairedMethod = (method) => (idx) => {
      if (idx === undefined) {
        if (method === "itemMatching") throw pairedItemError("Missing item index for .itemMatching()");
        idx = itemIndex;
      }
      if (!graph.ancestors(exec.name).has(name)) throw pairedItemError(`No path back to node '${name}'`, { description: `There is no connection back to the node '${name}', but it's used in an expression here.` });
      ensureExecuted(name);
      if (!input.length) {
        const out = nodeOutput(name, undefined, undefined);
        if (out.length) {
          if (idx >= out.length) throw pairedItemError(`"${name}" node has ${out.length} item(s) but expression references item ${idx}`);
          return out[idx];
        }
      }
      const it = input[idx];
      if (!it) throw pairedItemError("Can’t get data for expression", { description: `Some intermediate nodes between ‘${name}‘ and ‘${exec.name}‘ have not executed yet.` });
      if (it.pairedItem === undefined) throw pairedItemError(`Paired item data for ${method} from node '${exec.name}' is unavailable.`);
      if (!exec.source) throw pairedItemError("Can’t get data for expression", { description: "Missing sourceData (probably an internal error)" });
      const p = typeof it.pairedItem === "number" ? { item: it.pairedItem } : it.pairedItem;
      const src = exec.source.main[p.input || 0] ?? exec.source.main[0];
      return getPairedItem(name, src, p, method);
    };
    const branchOf = (b) => b ?? graph.connectionIndexes(exec.name, name)?.sourceIndex ?? 0;
    const handle = {
      get isExecuted() {
        return executed(name);
      },
      get item() {
        return pairedMethod("item")();
      },
      pairedItem: pairedMethod("pairedItem"),
      itemMatching: pairedMethod("itemMatching"),
      first(b, r) {
        ensureExecuted(name);
        return nodeOutput(name, branchOf(b), r)[0];
      },
      last(b, r) {
        ensureExecuted(name);
        const o = nodeOutput(name, branchOf(b), r);
        return o.length ? o[o.length - 1] : undefined;
      },
      all(b, r) {
        ensureExecuted(name);
        return nodeOutput(name, branchOf(b), r);
      },
      get params() {
        return run.definition.steps[name]?.params;
      },
      get context() {
        return contextOf(name);
      },
    };
    return handle;
  }

  const inputProxy = {
    get item() {
      if (!input.length) throw pairedItemError("No execution data available");
      return input[itemIndex];
    },
    first(...a) {
      if (!input.length) throw pairedItemError("No execution data available");
      if (a.length) throw pairedItemError("$input.first() takes no arguments. To get items from a specific upstream node, use $('NodeName').first() (or $('NodeName').all() for every item).");
      return input[0];
    },
    last(...a) {
      if (!input.length) throw pairedItemError("No execution data available");
      if (a.length) throw pairedItemError("$input.last() takes no arguments. To get items from a specific upstream node, use $('NodeName').last() (or $('NodeName').all() for every item).");
      return input[input.length - 1];
    },
    all() {
      if (!input.length) throw pairedItemError("No execution data available");
      return input;
    },
    get params() {
      const prev = exec.source?.main?.[0]?.previousNode;
      return prev ? run.definition.steps[prev]?.params : undefined;
    },
    get context() {
      const prev = exec.source?.main?.[0]?.previousNode;
      return prev ? contextOf(prev) : {};
    },
  };

  const currentJson = () => {
    if (!input.length) {
      if (extras.lenientMissing) return undefined;
      throw pairedItemError(`Node '${exec.name}' hasn't been executed`);
    }
    if (input.length <= itemIndex) throw pairedItemError(`"${exec.name}" node has ${input.length} item(s) but you're trying to access item ${itemIndex}`);
    return input[itemIndex].json;
  };
  const stripBinary = (b) => {
    const out = {};
    for (const [k, v] of Object.entries(b || {})) {
      out[k] = {};
      for (const p in v) if (p !== "data") out[k][p] = v[p];
    }
    return out;
  };

  const nodeGetter = new Proxy(
    {},
    {
      has: () => true,
      get(_, nodeName) {
        if (typeof nodeName !== "string") return undefined;
        if (!nodeExists(nodeName)) throw pairedItemError("Referenced node doesn't exist", { node: nodeName });
        return {
          get json() {
            const out = nodeOutput(nodeName, undefined, undefined);
            if (out.length === 0) throw pairedItemError(`Node '${nodeName}' hasn't been executed`);
            if (out.length <= itemIndex) throw pairedItemError(`"${nodeName}" node has ${out.length} item(s) but you're trying to access item ${itemIndex}`);
            return out[itemIndex].json;
          },
          get data() {
            return this.json;
          },
          get binary() {
            const out = nodeOutput(nodeName, undefined, undefined);
            return stripBinary(out[itemIndex]?.binary);
          },
          get parameter() {
            return run.definition.steps[nodeName]?.params;
          },
          get runIndex() {
            return executed(nodeName) ? runData[nodeName].length - 1 : -1;
          },
          get context() {
            return contextOf(nodeName);
          },
        };
      },
    },
  );

  const parameterProxy = (raw) =>
    new Proxy(
      {},
      {
        has: (_, k) => typeof k === "string" && hasOwn(exec.params, k),
        ownKeys: () => Object.keys(exec.params),
        getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
        get(_, k) {
          if (typeof k !== "string") return undefined;
          const v = exec.params[k];
          return raw ? v : resolveParameter(v, () => scopeAt(itemIndex));
        },
      },
    );
  const scopeAt = (i) => (i === itemIndex ? scope : makeScope(createLookup(exec, i, extras)));

  const prevNode = () => {
    const s = exec.source?.main?.[0];
    if (!s) return undefined;
    return { name: s.previousNode, outputIndex: s.previousNodeOutput || 0, runIndex: s.previousNodeRun || 0 };
  };
  const nowDT = () => DateTime.fromMillis(run.clock.now, { zone: run.timezone });

  const values = {
    $: dollar,
    $input: inputProxy,
    $node: nodeGetter,
    $items(nodeName, outputIndex, runIndex) {
      if (nodeName === undefined) {
        const prev = prevNode()?.name;
        let res = input;
        if (prev && run.definition.steps[prev]?.settings?.executeOnce === true) res = res.slice(0, 1);
        return res.length ? res : [];
      }
      return nodeOutput(nodeName, outputIndex || 0, runIndex === undefined ? -1 : runIndex);
    },
    $item(i, r) {
      return new Proxy({}, { has: () => true, get: (_, k) => (typeof k === "string" ? createLookup(exec, i, { ...extras, defaultRunIndex: r })(k) : undefined) });
    },
    $getPairedItem: (dest, source, pairedItem) => getPairedItem(dest, source, pairedItem),
    $evaluateExpression: (expr, i) => evaluateExpression("=" + expr, scopeAt(i || itemIndex)),
    $jmespath: jmespath,
    $jmesPath: jmespath,
    DateTime,
    Duration,
    Interval,
    __ext: extend,
    __extOpt: extendOptional,
    process: { env: {} },
    console: run.console,
    ...EXTENDED_FUNCTIONS,
  };
  function jmespath(data, query) {
    if (typeof data !== "object" || typeof query !== "string") throw new ExpressionError("expected two arguments (Object, string) for this function");
    if (query.includes("\\") || /__proto__|prototype|constructor/.test(query)) throw new ExpressionError("Cannot access this property in a jmespath query due to security concerns");
    return jmespathSearch(Array.isArray(data) ? data : { ...data }, query);
  }

  function lookup(name) {
    if (extras.locals && hasOwn(extras.locals, name)) return extras.locals[name];
    switch (name) {
      case "$json":
      case "$data":
        return currentJson();
      case "$binary":
        return input.length ? stripBinary(input[itemIndex]?.binary) : undefined;
      case "$parameter":
        return parameterProxy(false);
      case "$rawParameter":
        return parameterProxy(true);
      case "$prevNode":
        return prevNode() ?? {};
      case "$runIndex":
      case "$thisRunIndex":
        return exec.runIndex;
      case "$itemIndex":
      case "$position":
      case "$thisItemIndex":
        return itemIndex;
      case "$thisItem":
        return input[itemIndex];
      case "$mode":
        return run.mode;
      case "$workflow":
        return { id: run.workflow.id, name: run.workflow.name, active: run.workflow.active };
      case "$execution":
        return run.executionInfo;
      case "$vars":
        return run.vars;
      case "$env":
        throw new ExpressionError("access to env vars denied", { description: "n8n blocks $env in nodes by default (N8N_BLOCK_ENV_ACCESS_IN_NODE); the runtime keeps it blocked." });
      case "$now":
        return nowDT();
      case "$today":
        return nowDT().set({ hour: 0, minute: 0, second: 0, millisecond: 0 });
      case "$nodeVersion":
        return exec.step.n8n?.typeVersion;
      case "$nodeId":
        return exec.step.n8n?.id;
      case "$webhookId":
        return exec.step.n8n?.webhookId;
      case "$fromAI":
      case "$fromAi":
      case "$fromai":
        throw new UnsupportedExpression("$fromAI() only has a value inside a tool an agent calls", { function: "$fromAI" });
      case "$tool":
      case "$agentInfo":
      case "$self":
        throw new UnsupportedExpression(`${name} is not supported`, { function: name });
      case "Date":
        return g.Date;
      case "Math":
        return g.Math;
    }
    if (hasOwn(values, name)) return values[name];
    if (hasOwn(ALLOWED, name)) return ALLOWED[name];
    if (DENY.includes(name)) return {};
    return undefined;
  }
  const scope = makeScope(lookup);
  lookup.scope = scope;
  return lookup;
}

export function createScope(exec, itemIndex, extras) {
  return createLookup(exec, itemIndex, extras).scope;
}
