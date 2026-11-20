// Gets n8n workflows into export files that analyze.mjs and convert.mjs read, so nobody has to
// download them from the n8n editor first. The only script besides cutover.mjs that uses the
// network; analyze.mjs and convert.mjs stay offline.
//
//   node pull.mjs <source>... [--out dir] [--active] [--no-sub-workflows] [--env-file f] [--json]
//
// Sources, any number in one call:
//   n8n.io/workflows/<id>[-slug]   a public template (api.n8n.io; no account, no key). Also
//   template:<id>                  written with https:// or www.
//   popular[:N] | trending[:N]     the N (default 5, at most 20) most-viewed or trending n8n.io
//                                  templates, to try it without any workflow of your own
//   n8n                            every workflow on your instance (not archived; --active:
//                                  published only)
//   <your n8n>/workflow/<id>       one workflow, as its editor link
//
// Two ways to reach your instance:
//   --login <your n8n address>     sign in in the browser (OAuth, n8n-oauth.mjs) and read over
//                                  n8n's MCP server: no key to create, but only workflows set
//                                  "Available in MCP". With --login and no source, `n8n` is meant.
//                                  --register-again drops the stored OAuth client first.
//   N8N_BASE_URL + N8N_API_KEY     the REST API from the environment (or --env-file, which reads
//                                  only those two names): sees every workflow the key can read.
//                                  The key goes only to N8N_BASE_URL's origin: an editor link on
//                                  another host is refused, never sent the key.
// No key or token is ever written or printed.
//
// Sub-workflows: from your instance (either way), the workflows the pulled ones call by a fixed
// id (Execute Workflow, sub-workflow tool and retriever nodes; analyze.mjs calledWorkflowIds) are
// fetched too, by id over the same route, and what those call, up to 3 levels and 50 extra
// workflows, so analyze.mjs does not stop at "sub-workflow X is not in the export". One it cannot
// get (not found, not Available in MCP) is a note, not a failure. --no-sub-workflows turns it off.
// Templates have no instance behind them, so their calls are not followed.
//
// Each workflow is written to <out>/<name>-<id>.json in the editor's Download shape, without
// `shared` (owner names and emails) and, for templates, without the author's profile.
// Exit: 0 all written, 1 some failed, 2 bad usage or nothing written.

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { calledWorkflowIds } from "./analyze.mjs";
import { createN8nClient } from "./n8n-api.mjs";
import { instanceBase, mcpClient, MCP_PATH, signIn as oauthSignIn } from "./n8n-oauth.mjs";

const TEMPLATES_API = "https://api.n8n.io/api/templates/workflows/";
const NODES_JSON = join(dirname(fileURLToPath(import.meta.url)), "..", "references", "nodes.json");
const SUB_DEPTH = 3;
const SUB_CAP = 50;
const USAGE = "usage: pull.mjs <n8n.io/workflows/<id> | template:<id> | popular[:N] | trending[:N] | n8n | <your n8n>/workflow/<id>>... [--login <your n8n address> [--register-again]] [--out dir] [--active] [--no-sub-workflows] [--env-file f] [--json]";
const ENABLE_MCP ="n8n shares a workflow over MCP only when it is set Available in MCP: Settings > Instance-level MCP > Workflows enabled, a project's or folder's Manage MCP access, or the workflow's Settings";

// One command-line source as {kind, ...}, or {kind: "bad", error}.
export function parseSource(arg) {
  const s = String(arg).trim();
  let m = s.match(/^template:(\d+)$/i);
  if (m) return { kind: "template", id: m[1] };
  m = s.match(/^(?:https?:\/\/)?(?:www\.)?n8n\.io\/workflows\/(\d+)(?:[-/?#][^\s]*)?$/i);
  if (m) return { kind: "template", id: m[1] };
  if (s.toLowerCase() === "n8n") return { kind: "instance" };
  m = s.match(/^(popular|trending)(?::(\d+))?$/i);
  if (m) return { kind: "trending", sort: m[1].toLowerCase() === "popular" ? "views:desc" : "trendingScore:desc", count: Math.min(20, Math.max(1, Number(m[2] ?? 5))) };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { kind: "bad", error: `not a source: ${s}` };
  }
  m = u.pathname.match(/^(.*?)\/workflow\/([A-Za-z0-9_-]+)\/?$/);
  if ((u.protocol === "https:" || u.protocol === "http:") && m && m[2] !== "new") return { kind: "editor", base: `${u.origin}${m[1]}`, id: m[2] };
  return { kind: "bad", error: `not a source: ${s} (an editor link looks like https://<your n8n>/workflow/<id>)` };
}

// KEY=VALUE lines; only N8N_BASE_URL and N8N_API_KEY are taken.
export function readEnvFile(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?(N8N_BASE_URL|N8N_API_KEY)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

const sameBase = (a, b) => {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/, "") === y.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  } catch {
    return false;
  }
};

const fileName = (name, id) => {
  const slug = String(name ?? "workflow").normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").toLowerCase().slice(0, 60) || "workflow";
  return `${slug}-${String(id ?? "x").replace(/[^\w-]/g, "")}.json`;
};

// The editor's Download shape from a public API or MCP workflow object (the draft graph, as the
// editor's Download gives; MCP's copy of the published graph is left out).
function exportShape(wf) {
  const { shared: _shared, activeVersion: _active, nodeGroups: _groups, ...rest } = wf;
  return rest;
}

async function trendingIds(count, fetchImpl, sort = "trendingScore:desc") {
  let r;
  try {
    r = await fetchImpl(`https://api.n8n.io/api/templates/search?page=1&rows=${count}&sort=${sort}`, { headers: { accept: "application/json" } });
  } catch (e) {
    throw new Error(`trending templates: ${e.cause?.code ?? e.message}`);
  }
  if (!r.ok) throw new Error(`trending templates: HTTP ${r.status}`);
  const ids = ((await r.json())?.workflows ?? []).map((w) => w?.id).filter((x) => x != null);
  if (!ids.length) throw new Error("trending templates: n8n.io listed none");
  return ids.slice(0, count).map(String);
}

async function getTemplate(id, fetchImpl) {
  let r;
  try {
    r = await fetchImpl(TEMPLATES_API + id, { headers: { accept: "application/json" } });
  } catch (e) {
    throw new Error(`template ${id}: ${e.cause?.code ?? e.message}`);
  }
  if (!r.ok) throw new Error(`template ${id}: HTTP ${r.status}${r.status === 400 || r.status === 404 ? " (no such template)" : ""}`);
  const t = (await r.json())?.workflow;
  if (!t?.workflow || !Array.isArray(t.workflow.nodes)) throw new Error(`template ${id}: the response holds no workflow`);
  return { id: String(t.id ?? id), name: t.name ?? `template ${id}`, ...t.workflow };
}

// Resolves every source and writes the files. Returns {written: [{file, id, name, source,
// calledBy?}], errors: [{source, error}], notes}. `env` holds N8N_BASE_URL / N8N_API_KEY.
// `subWorkflows: false` does not fetch the workflows the pulled ones call.
export async function pull(sources, { out, active = false, env = process.env, fetch: fetchImpl = globalThis.fetch, login = null, registerAgain = false, signIn = oauthSignIn, log, subWorkflows = true } = {}) {
  const written = [];
  const errors = [];
  const notes = [];
  if (login) return pullSignedIn(sources, { out, active, env, fetchImpl, login, registerAgain, signIn, log, subWorkflows, written, errors, notes });
  const base = String(env.N8N_BASE_URL ?? "").trim().replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  const key = String(env.N8N_API_KEY ?? "").trim();
  const clean = (m) => (key ? String(m).split(key).join("[key]") : String(m));
  let client = null;
  const instance = (source) => {
    if (!base || !key) throw new Error(`${source}: set N8N_BASE_URL and N8N_API_KEY first (n8n: Settings > n8n API > Create an API key), in your own terminal or an --env-file; never paste the key into a chat`);
    return (client ??= createN8nClient({ base, key, fetch: fetchImpl }));
  };
  const saveAny = saver(out, written);
  // Workflows from the instance, whose calls are followed afterwards.
  const roots = [];
  const save = (wf, source, fromInstance = false) => {
    if (saveAny(wf, source) && fromInstance) roots.push(wf);
  };
  for (const raw of sources) {
    const src = parseSource(raw);
    try {
      if (src.kind === "bad") throw new Error(src.error);
      if (src.kind === "template") save(await getTemplate(src.id, fetchImpl), raw);
      else if (src.kind === "trending") for (const id of await trendingIds(src.count, fetchImpl, src.sort)) save(await getTemplate(id, fetchImpl), raw);
      else if (src.kind === "editor") {
        if (base && !sameBase(src.base, base)) throw new Error(`${raw}: not on N8N_BASE_URL's instance, so the API key is not sent there; set N8N_BASE_URL to ${src.base} if that is yours`);
        if (!base) throw new Error(`${raw}: set N8N_BASE_URL=${src.base} and N8N_API_KEY first (n8n: Settings > n8n API), in your own terminal or an --env-file; never paste the key into a chat`);
        const wf = await instance(raw).getWorkflow(src.id);
        if (!wf) throw new Error(`${raw}: no workflow ${src.id} on ${base}`);
        save(exportShape(wf), raw, true);
      } else {
        const c = instance(raw);
        const list = await c.listWorkflows({ active });
        if (!list.length) throw new Error(`${raw}: the key reads no ${active ? "published " : ""}workflows on ${base}`);
        for (const wf of list) save(exportShape(Array.isArray(wf.nodes) ? wf : ((await c.getWorkflow(wf.id)) ?? wf)), raw, true);
      }
    } catch (e) {
      errors.push({ source: String(raw), error: clean(e.message) });
    }
  }
  if (subWorkflows && client && roots.length) await followCalls(roots, (id) => client.getWorkflow(id), { save: saveAny, notes, where: base, clean });
  return { written, errors, notes };
}

// Writes one workflow file unless that file is already written; true when it wrote.
function saver(out, written) {
  const seen = new Set();
  return (wf, source, calledBy = null) => {
    const file = fileName(wf.name, wf.id);
    if (seen.has(file)) return false;
    seen.add(file);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, file), JSON.stringify(wf, null, 2) + "\n");
    written.push({ file, id: String(wf.id ?? ""), name: String(wf.name ?? ""), source, ...(calledBy !== null ? { calledBy } : {}) });
    return true;
  };
}

// Sub-workflows (top comment): fetches what `roots` call by a fixed id with get(id), which gives
// the workflow, null when the instance has no such id, or throws (code "not_in_mcp" when n8n does
// not share it over MCP); then what those call, breadth first. Each one fetched is saved with
// `calledBy` (the caller's name); each one not fetched becomes a note, never an error.
async function followCalls(roots, get, { save, notes, where, clean }) {
  const nodes = JSON.parse(readFileSync(NODES_JSON, "utf8"));
  const have = new Set(roots.map((w) => String(w.id)));
  const notShared = [];
  const left = [];
  let tries = 0;
  let level = roots;
  for (let depth = 1; level.length; depth++) {
    const next = [];
    for (const caller of level) {
      const callerName = String(caller.name ?? caller.id);
      for (const { id, name } of calledWorkflowIds(caller, nodes)) {
        if (have.has(id)) continue;
        have.add(id);
        const label = `${name ? `"${name}" ` : ""}(${id}, called by "${callerName}")`;
        if (depth > SUB_DEPTH || tries >= SUB_CAP) {
          left.push(label);
          continue;
        }
        tries++;
        try {
          const wf = await get(id);
          if (!wf) notes.push(`sub-workflow ${label} is not on ${where}, so the caller will report it missing`);
          else {
            const sub = exportShape(wf);
            if (save(sub, "sub-workflow", callerName)) next.push(sub);
          }
        } catch (e) {
          if (e.code === "not_in_mcp") notShared.push(label);
          else notes.push(`sub-workflow ${label} could not be fetched: ${clean(e.message)}`);
        }
      }
    }
    level = next;
  }
  if (notShared.length) notes.push(`sub-workflows not shared over MCP (${notShared.length}): ${notShared.join(", ")}. ${ENABLE_MCP}; or use an API key, which reads every workflow`);
  if (left.length) notes.push(`sub-workflows past ${SUB_DEPTH} levels or ${SUB_CAP} fetched were not fetched (${left.length}): ${left.join(", ")}; pull them by their editor links`);
}

// --login: one browser sign-in, then every instance source reads over MCP with that token.
async function pullSignedIn(sources, { out, active, env, fetchImpl, login, registerAgain, signIn, log, subWorkflows, written, errors, notes }) {
  let base;
  try {
    base = instanceBase(login);
  } catch (e) {
    errors.push({ source: String(login), error: e.message });
    return { written, errors, notes };
  }
  const save = saver(out, written);
  const parsed = (sources.length ? sources : ["n8n"]).map((raw) => ({ raw, src: parseSource(raw) }));
  for (const { raw, src } of parsed) {
    if (src.kind === "bad") errors.push({ source: String(raw), error: src.error });
    else if (src.kind === "editor" && src.base !== base) errors.push({ source: String(raw), error: `${raw}: not on ${base}, the instance you sign in to` });
  }
  for (const { raw, src } of parsed.filter((p) => p.src.kind === "template" || p.src.kind === "trending")) {
    try {
      if (src.kind === "trending") for (const id of await trendingIds(src.count, fetchImpl, src.sort)) save(await getTemplate(id, fetchImpl), raw);
      else save(await getTemplate(src.id, fetchImpl), raw);
    } catch (e) {
      errors.push({ source: String(raw), error: e.message });
    }
  }
  const wanted = parsed.filter((p) => p.src.kind === "instance" || (p.src.kind === "editor" && p.src.base === base));
  if (!wanted.length) return { written, errors, notes };
  let session;
  try {
    session = await signIn(base, { fetch: fetchImpl, env, registerAgain, ...(log ? { log } : {}) });
  } catch (e) {
    errors.push({ source: String(login), error: `sign-in to ${base}: ${e.message}` });
    return { written, errors, notes };
  }
  const mcp = mcpClient({ url: `${base}${MCP_PATH}`, token: session.token, fetch: fetchImpl });
  const notShared = [];
  const roots = [];
  const one = async (id, raw, name) => {
    try {
      const wf = exportShape(await mcp.workflow(id));
      if (save(wf, raw)) roots.push(wf);
    } catch (e) {
      if (e.code === "not_in_mcp") notShared.push(name ?? id);
      else throw e;
    }
  };
  try {
    for (const { raw, src } of wanted) {
      try {
        if (src.kind === "editor") await one(src.id, raw);
        else {
          const { data, count } = await mcp.searchWorkflows();
          const list = data.filter((w) => !w.isArchived && (!active || w.active === true));
          if (count !== null && count > data.length) notes.push(`n8n's MCP server lists at most ${data.length} workflows in one call and has ${count}; for the rest, give their editor links or use an API key`);
          for (const w of list) {
            if (w.availableInMCP === false) notShared.push(w.name ?? w.id);
            else await one(w.id, raw, w.name);
          }
          if (!list.length) notes.push(`no ${active ? "published " : ""}workflows are visible to this sign-in on ${base}`);
        }
      } catch (e) {
        errors.push({ source: String(raw), error: String(e.message).split(session.token).join("[token]") });
      }
    }
    // get_workflow_details takes the id; n8n answers "not found" for an id it does not have.
    const get = async (id) => {
      try {
        return await mcp.workflow(id);
      } catch (e) {
        if (e.code !== "not_in_mcp" && /not found/i.test(e.message)) return null;
        throw e;
      }
    };
    if (subWorkflows && roots.length) await followCalls(roots, get, { save, notes, where: base, clean: (m) => String(m).split(session.token).join("[token]") });
  } finally {
    await session.done?.();
  }
  if (notShared.length) errors.push({ source: "mcp", error: `not shared over MCP (${notShared.length}): ${notShared.join(", ")}. ${ENABLE_MCP}; or use an API key, which reads every workflow` });
  return { written, errors, notes };
}

function parseArgs(argv) {
  const a = { sources: [], out: resolve("n8n-exports"), active: false, envFile: null, json: false, login: null, registerAgain: false, subWorkflows: true };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${x} needs a value`);
      return argv[++i];
    };
    if (x === "--out") a.out = resolve(val());
    else if (x === "--active") a.active = true;
    else if (x === "--no-sub-workflows") a.subWorkflows = false;
    else if (x === "--login") a.login = val();
    else if (x === "--register-again") a.registerAgain = true;
    else if (x === "--env-file") a.envFile = resolve(val());
    else if (x === "--json") a.json = true;
    else if (x === "-h" || x === "--help") a.help = true;
    else if (x.startsWith("--")) throw new Error(`unknown option ${x}`);
    else a.sources.push(x);
  }
  return a;
}

async function main() {
  let a;
  try {
    a = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    process.exit(2);
  }
  if (a.help) return console.log(USAGE);
  if (!a.sources.length && !a.login) {
    console.error(USAGE);
    process.exit(2);
  }
  let env = process.env;
  if (a.envFile) {
    try {
      env = { ...process.env, ...readEnvFile(readFileSync(a.envFile, "utf8")) };
    } catch (e) {
      console.error(`cannot read --env-file ${a.envFile}: ${e.message}`);
      process.exit(2);
    }
  }
  const r = await pull(a.sources, { out: a.out, active: a.active, env, login: a.login, registerAgain: a.registerAgain, subWorkflows: a.subWorkflows });
  if (a.json) process.stdout.write(JSON.stringify({ out: a.out, ...r }, null, 2) + "\n");
  else {
    for (const w of r.written) console.log(`wrote ${join(a.out, w.file)}  ${w.name}${w.calledBy !== undefined ? `  (sub-workflow called by "${w.calledBy}")` : ""}`);
    for (const e of r.errors) console.error(`failed ${e.error}`);
    for (const n of r.notes) console.error(`note: ${n}`);
    if (r.written.length) console.log(`\n${r.written.length} workflow${r.written.length === 1 ? "" : "s"} in ${a.out}. Next: node ${join(fileURLToPath(new URL(".", import.meta.url)), "analyze.mjs")} ${a.out}`);
  }
  process.exit(!r.written.length ? 2 : r.errors.length ? 1 : 0);
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) main();
