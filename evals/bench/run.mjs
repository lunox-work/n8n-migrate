#!/usr/bin/env node
// The evaluation bench (PLAN Phase 5): gates 1-8 per template, n8n in Docker as the baseline,
// the migrated folder run by the runner. Contract: evals/bench/README.md.
//
//   node evals/bench/run.mjs [<templateId>...] [--split dev] [--limit n]
//        [--variants normal,empty,malformed,hostile] [--repeats 3] [--model-mode replay|live]
//        [--driver inprocess|claude] [--skill <id,id|all|none>] [--tag <run tag>]
//        [--reuse-convert <tag>] [--record] [--n8n-check all|normal] [--no-n8n-check] [--diagnose]
//   node evals/bench/run.mjs --n8n-check-only <templateId>... [--n8n-check all|normal] [--variants ...]
//   node evals/bench/run.mjs --record-only <templateId>... [--variants ...]
//
// Without ids (or with --split dev): the current round's dev templates that have fixtures
// (splits.json `rounds`, evals/bench/rounds.mjs).
//
// --skill        templates whose gate 2 is the headless skill run (claude -p sonnet); the rest
//                use the plain converter (budget). Every template also gets the plain column.
// --tag          names this bench run; its ledger is .work/ledger/<tag>.json. Re-running with
//                the same tag resumes: finished templates are skipped, finished steps reused.
// --reuse-convert take gate 2's folders from an earlier tag (the skill run is not repeated).
// --record       (re)record n8n's model replies live into evals/bench/recordings/ even when a
//                recording exists. Without it, an existing recording is replayed on the n8n
//                side too, and a missing one is recorded live once.
//
// --driver       inprocess (default): gates 3-7 in process; a template that passes them gets
//                the claude driver once (normal and hostile, within the claude -p budget) for
//                gate 8, and the driver's gates 3, 4 and 6 count as under --driver claude.
//                claude: the claude driver runs before gate 7.
//
// --diagnose     for a template that passes preflight but fails gate 3-6: still measure
//                Contained on the hostile fixture (in process, and with the claude driver on
//                normal and hostile under --driver claude). Recorded as diagnostics; the
//                verdict stays the first failed gate.
//
// --n8n-check-only (PROPOSALS P102) only the canned n8n check (P36) of the ids given, on every
//                variant (`--n8n-check normal`: normal only): the same n8nRun path the bench takes,
//                no convert, no Claude side, no model call, nothing saved (no recording, ledger
//                or results row). One JSON line per variant on stdout: the n8nCheck summary plus
//                the run's full error (description, HTTP code), each node's runs, and the
//                request log. For fixture writers; held-out ids are run only when named.
//
// --record-only  (PROPOSALS P135) the recording pass alone, for the ids named: the n8n side of each
//                variant (default all four) that has a model node, drawn live and saved as its
//                recording, with no convert, Claude side or driver (no results row; the ledger
//                gets only n8n's model calls). PROPOSALS P134: a draw whose baseline fails at a
//                node a model reply feeds, while the variant's canned check runs to the end, is
//                drawn once more; if that fails too, the line names the `expect.n8nCannotRun`
//                mark (node, error, both draws) the setup session writes into the fixture. One
//                JSON line per variant on stdout, every draw reported. Release points use it for
//                the held-out setup pass before the scored runs (P115). Held-out ids only when named.
//
// A template stops at its first failed gate. One row per template goes to evals/results.jsonl.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepare, runN8n, logVsFixture, splitLog, loadTemplate, loadFixture, loadOverlay, benchEnv, recordingInterrupted, modelConsumers, writtenFiles, keepsProcessState, siteAnswers, hostsAnswers, substitutionApprovals, loadCredentialSpecs, ensureN8n, codeModules, DbSeedError, dbSummary, fixtureClock, modelNodes, modelDrawFailure } from "./n8n-side.mjs";
import { convertPlain, convertSkill, filledSource, runInProcess, folderIn, claudeDriverModelInputs, httpModelInputs, recordedCalls, syntheticOutcome, nondeterministicTools, connectorGapFields, databaseAnswers } from "./claude-side.mjs";
import { startShim, answerOf } from "./model-shim.mjs";
import { fromHttp, fromTool, fromFile, fromDb, replyOf, resultOf, isResult, lastOutputs, terminalNodes, compare, modelTextsOf, baitHits, refsOf, foldResumableUploads, randomWriteNodes } from "./compare.mjs";
import { n8nCheckVariants, n8nCheckKey, n8nCheckSummary, gate1, gate2, gate3, gate4, gate5, gate6, gate7, gate8, robustness, reached, runFailureCause, gapsOf, connectorLimited, n8nFailsOf, modelRefusal } from "./gates.mjs";
import { BudgetExceeded, UsageLimit, ledger as claudeLedger, memoryGate } from "./claude.mjs";
import { readSplits, devWithFixtures } from "./rounds.mjs";

// Bench folders sit inside this checkout: keep run records local, never push an n2c-state branch.
process.env.N2C_STORE = "file";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const SKILL = join(ROOT, "skills", "n8n-to-claude");
const WORK = join(HERE, ".work");
const RECORDINGS = join(HERE, "recordings");
const RESULTS = join(ROOT, "evals", "results.jsonl");
const VARIANTS = ["normal", "empty", "malformed", "hostile"];

function parseArgs(argv) {
  const a = { diagnose: false, ids: [], variants: VARIANTS, repeats: 3, modelMode: "replay", driver: "inprocess", skill: [], tag: null, reuseConvert: null, record: false, n8nCheck: true, n8nCheckOnly: false, recordOnly: false, split: null, limit: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === "--variants") a.variants = v().split(",");
    else if (k === "--repeats") a.repeats = Number(v());
    else if (k === "--model-mode") a.modelMode = v();
    else if (k === "--driver") a.driver = v();
    else if (k === "--skill") a.skill = v().split(",");
    else if (k === "--tag") a.tag = v();
    else if (k === "--reuse-convert") a.reuseConvert = v();
    else if (k === "--record") a.record = true;
    else if (k === "--no-n8n-check") a.n8nCheck = false;
    else if (k === "--n8n-check") a.n8nCheck = v() === "normal" ? "normal" : true;
    else if (k === "--diagnose") a.diagnose = true;
    else if (k === "--n8n-check-only") a.n8nCheckOnly = true;
    else if (k === "--record-only") a.recordOnly = true;
    else if (k === "--split") a.split = v();
    else if (k === "--limit") a.limit = Number(v());
    else if (k.startsWith("--")) throw new Error(`unknown flag ${k}`);
    else a.ids.push(Number(k));
  }
  if (a.n8nCheckOnly && !a.ids.length) throw new Error("--n8n-check-only needs template ids");
  if (a.recordOnly && !a.ids.length) throw new Error("--record-only needs template ids");
  if (!a.ids.length) {
    if (a.split === "held-out") throw new Error("held-out runs only at release points (EXCLUSIONS.md); pass ids explicitly");
    // The current round's dev (rolling held-out, rounds.mjs): templates with fixtures.
    a.ids = devWithFixtures(readSplits());
  }
  if (a.limit) a.ids = a.ids.slice(0, a.limit);
  a.tag ??= `run-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`;
  return a;
}

const git = (args) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8" }).stdout.trim();
const readJson = (p, d = null) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : d);
const writeJson = (p, v) => (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, JSON.stringify(v, null, 1) + "\n"));
const log = (...m) => console.error(`[bench ${new Date().toISOString().slice(11, 19)}]`, ...m);

// ---------- n8n side with recordings ----------

let n8nEnv = null;
async function n8n() {
  if (n8nEnv) return n8nEnv;
  const container = await import("../n8n/container.mjs");
  const { runWorkflow, cleanupBenchWorkflows } = await import("../n8n/run-workflow.mjs");
  await container.up({ extraEnv: benchEnv(), log });
  // PROPOSALS P69: workflows an interrupted run left behind.
  const removed = await cleanupBenchWorkflows();
  if (removed) log(`removed ${removed} leftover bench workflow(s) from n8n (P69)`);
  const shim = await startShim({ port: container.MODEL_SHIM_PORT, log });
  // PROPOSALS P61: each node type's declared credentials, from this image's node descriptions.
  const credentialSpecs = await loadCredentialSpecs({ cacheFile: join(container.WORK, `node-credentials.${container.imageTag()}.json`), fetchTypes: container.nodeTypes });
  // PROPOSALS P66: seeding and reading back the run's databases in the sidecars.
  const databases = await import("../n8n/databases.mjs");
  n8nEnv = { container, runWorkflow, shim, cleanupBenchWorkflows, credentialSpecs, databases };
  return n8nEnv;
}

// One n8n run of a template variant. Model replies: replay the committed recording when there
// is one (and --record is off), else live (claude -p, cached by request) and saved.
// mode "canned": no model at all (baseline check for templates whose Claude side stops early).
// PROPOSALS P12: a run that may call the model live checks memory once before it starts
// (CLAUDE.md's floor, 25% free: the recording is one sequential job) and its model calls skip
// the per-call gate; a run interrupted on the model side is never saved (recordingInterrupted)
// and the template's row reads `bench defect: recording interrupted`.
async function n8nRun(id, variant, { record = false, canned = false } = {}) {
  const recFile = join(RECORDINGS, String(id), `${variant}.json`);
  const existing = readJson(recFile);
  const env = await n8n();
  let prep = prepare(id, variant, { credentialSpecs: env.credentialSpecs });
  // PROPOSALS P48: a fixture route n8n's side cannot build is this variant's fixture error; n8n
  // is not run and nothing is saved, so the template's other variants and verdict still stand.
  if (prep.badRoutes?.length) return fixtureErrorRun(prep);
  const session = canned ? { mode: "canned" } : existing && !record ? { mode: "replay", recorded: byTag(existing.modelCalls), fallback: "live" } : { mode: "live" };
  if (!canned && prep.models.length) {
    await memoryGate({ log, need: 25 });
    session.memoryChecked = true;
  }
  // PROPOSALS P83: a container the last run's OOM kill (or anything else) stopped is started
  // again first, so one template's kill never becomes the next template's bench error.
  // The same call recreates the container when this template needs its own configuration
  // (templateEnv: P52 loopback, P92 Python runner, P93 Execute Command) or no longer does.
  const ensured = await ensureN8n(prep, { container: env.container, log });
  if (ensured.recreated) {
    const removed = await env.cleanupBenchWorkflows();
    if (removed) log(`removed ${removed} bench workflow(s) a stopped run left (P69)`);
    env.dirty = false;
  }
  env.needs = ensured.needs;
  // PROPOSALS P55, P63: the last run left state in n8n's process (a chat buffer, an in-memory
  // store, a client cache): restart n8n so this run sees only its own fixture.
  if (env.dirty) {
    await env.container.restart({ log });
    env.dirty = false;
  }
  env.dirty = keepsProcessState(prep.wf);
  // PROPOSALS P66: a seed the database refuses is this variant's fixture error, like a bad route.
  const runOnce = async () => {
    try {
      return await runN8n(prep, { shim: env.shim, modelSession: session, runWorkflow: env.runWorkflow, copyIn: env.container.copyIn, containerState: env.container.state, timeoutS: 900, databases: env.databases });
    } catch (e) {
      if (e instanceof DbSeedError) return { seedError: e.message };
      throw e;
    }
  };
  let r = await runOnce();
  if (r.seedError) return fixtureErrorRun(prep, { node: prep.fixture.reads.find((x) => x.db)?.node ?? null, message: `fixture db seed refused: ${r.seedError}` });
  let httpAttempt = null;
  if (r.fallbackable) {
    log(`${id}/${variant}: ${r.failedNode} failed on its http source, retrying with its n8n pin`);
    httpAttempt = { failedNode: r.failedNode, error: r.result.error ?? null, logVsFixture: logVsFixture(prep, r.result.effects) };
    prep = prepare(id, variant, { pinFallback: [r.failedNode], credentialSpecs: env.credentialSpecs });
    r = await runOnce();
    if (r.seedError) return fixtureErrorRun(prep, { node: null, message: `fixture db seed refused: ${r.seedError}` });
  }
  if (env.shim.lastError && /budget|usage limit/i.test(env.shim.lastError.message)) throw env.shim.lastError;
  const res = r.result;
  // PROPOSALS P15: each model call's place in the mock log (its seq), so the reads n8n's agent
  // tools made between two model calls can be told apart. The k-th model request of a tag in
  // the log is the shim's call k of that tag.
  const modelSeq = {};
  for (const e of splitLog(res.effects ?? []).model.sort((a, b) => a.seq - b.seq)) (modelSeq[e.model] ??= []).push(e.seq);
  if (!canned) {
    const why = recordingInterrupted({ result: res, modelCalls: r.modelCalls, models: prep.models, consumers: modelConsumers(prep.wf) });
    if (why) throw new Error(`recording interrupted (${id}/${variant}, not saved): ${why}`);
  }
  // PROPOSALS P44: what n8n's disk-write nodes wrote, read back from the container (final
  // bytes per path), then removed so the next run starts from the fixture's files only.
  const files = [];
  for (const w of writtenFiles(prep.wf, res)) {
    const local = join(WORK, "files-out", `${id}-${variant}-${files.length}`);
    try {
      mkdirSync(dirname(local), { recursive: true });
      env.container.copyOut(w.path, local);
      const b = readFileSync(local);
      files.push({ node: w.node, path: w.path, sha256: createHash("sha256").update(b).digest("hex"), size: b.length });
    } catch (e) {
      files.push({ node: w.node, path: w.path, error: String(e.message).slice(0, 200) });
    }
    rmSync(local, { force: true });
    env.container.exec(["rm", "-f", w.path]);
  }
  const out = {
    template: id,
    variant,
    status: res.status,
    error: res.error ?? null,
    // PROPOSALS P102: a canned check keeps n8n's whole error, so a fixture writer sees why.
    ...(canned && res.executionData?.error ? { errorDetail: errorDetailOf(res.executionData.error) } : {}),
    startedAt: res.startedAt,
    // PROPOSALS P132: the instant the fixture's relative times were filled from.
    fixtureAt: prep.fixtureAt,
    executionMs: res.executionMs,
    wallMs: res.wallMs,
    lastNode: res.lastNode,
    lastItems: res.nodes?.[res.lastNode]?.at(-1)?.items?.main?.[0] ?? [],
    // PROPOSALS P70: the output items of every terminal node that ran (no main connection out).
    terminal: Object.fromEntries(terminalNodes(prep.wf, (n) => res.nodes?.[n]?.length).map((n) => [n, lastOutputs(res.nodes[n])])),
    nodes: Object.fromEntries(Object.entries(res.nodes ?? {}).map(([k, v]) => [k, v.map((x) => ({ status: x.status, ...(x.error ? { error: x.error.slice(0, 300) } : {}), items: x.items?.main?.map((o) => o.length) }))])),
    // PROPOSALS P20: executions the run started (their requests are in `effects`).
    ...(res.children?.length ? { children: res.children.map((c) => ({ id: c.id, status: c.status, mode: c.mode, error: c.error ?? null, nodes: Object.fromEntries(Object.entries(c.nodes ?? {}).map(([k, v]) => [k, v.map((x) => ({ status: x.status, ...(x.error ? { error: x.error.slice(0, 300) } : {}) }))])) })) } : {}),
    ...(res.response?.pages ? { formPages: res.response.pages } : {}),
    ...(files.length ? { files } : {}),
    // PROPOSALS P66: the run's database changes (the diff) and the statements n8n sent.
    ...(r.db ? { db: r.db } : {}),
    effects: splitLog(res.effects).service.map(({ seq, method, proxied, tls, mintedLeaf, path, query, rawQuery, body, bodyEncoding, fixture }) => ({ seq, method, proxied, tls, mintedLeaf, path, query, rawQuery, body, bodyEncoding, fixture })),
    // PROPOSALS P65: calls over the shim's per-node cap got no answer; kept apart, never replayed.
    // PROPOSALS P115: saved by tag and call index, not in the order replies came back (a live
    // recording of concurrent calls completes out of order); every reader keys on `index` anyway.
    modelCalls: r.modelCalls.filter((c) => c.mode !== "capped").toSorted((a, b) => (a.tag === b.tag ? a.index - b.index : 0)).map(({ tag, node, index, format, request, response, mode, costUsd }) => ({ tag, node, index, format, request, response, mode, costUsd, seq: modelSeq[tag]?.[index] ?? null })),
    ...(r.modelCalls.some((c) => c.mode === "capped") ? { modelCallCap: Object.values(Object.groupBy(r.modelCalls.filter((c) => c.mode === "capped"), (c) => c.tag)).map((xs) => ({ tag: xs[0].tag, node: xs[0].node, refused: xs.length, message: xs[0].error })) } : {}),
    modelModes: [...new Set(r.modelCalls.map((c) => c.mode))],
    sources: prep.sources,
    overlay: prep.overlayApplied,
    via: prep.via,
    credentialsAttached: prep.credentialsAttached,
    ...(env.needs?.length ? { container: env.needs } : {}),
    // PROPOSALS P89: template-pinned nodes this run passed through (n8n returned the pin).
    ...(prep.templatePinned?.some((n) => res.nodes?.[n]?.length) ? { pinnedPath: prep.templatePinned.filter((n) => res.nodes?.[n]?.length) } : {}),
    logVsFixture: logVsFixture(prep, res.effects),
    ...(httpAttempt ? { httpAttempt } : {}),
    credentialsMissing: res.credentials?.missing?.map((m) => `${m.node}: ${m.type}`) ?? [],
  };
  // The file always holds the latest run (replayed replies are the recorded ones), and keeps
  // when and how its model replies were first produced.
  out.recorded = existing && session.mode === "replay" ? existing.recorded : { at: new Date().toISOString(), modes: out.modelModes };
  if (!canned) writeJson(recFile, out);
  return out;
}

// PROPOSALS P135, P134: the recording pass alone (see the header). Returns the lines printed.
async function recordOnly(args) {
  const lines = [];
  const draw = (r) => ({ status: r.status, error: r.error ?? null, modelCalls: r.modelCalls?.length ?? 0, modelModes: r.modelModes ?? [], recordedAt: r.recorded?.at ?? null });
  for (const id of args.ids) {
    const wf = loadTemplate(id).wf;
    for (const v of args.variants) {
      const models = modelNodes(wf, loadFixture(id, v));
      const line = { template: id, variant: v, draws: [] };
      if (!models.length) {
        line.skipped = "no model node: nothing to record";
        console.log(JSON.stringify((lines.push(line), line)));
        continue;
      }
      try {
        log(`${id}/${v}: recording (live draw 1)`);
        let r = await n8nRun(id, v, { record: true });
        line.draws.push(draw(r));
        if (r.status !== "success") {
          const canned = await n8nRun(id, v, { canned: true });
          line.canned = { status: canned.status, error: canned.error ?? null };
          let failed = modelDrawFailure(wf, models, r, canned.status === "success");
          if (failed) {
            log(`${id}/${v}: baseline failed at ${failed.node}, which a model reply feeds; drawing once more (P134)`);
            r = await n8nRun(id, v, { record: true });
            line.draws.push(draw(r));
            failed = modelDrawFailure(wf, models, r, true);
            if (failed) line.mark = { n8nCannotRun: `the bench's stand-in model's reply stops n8n at ${failed.node} on two live draws (${line.draws.map((d) => d.recordedAt).join(", ")}): ${failed.message}; the canned check of this variant runs to the end (PROPOSALS P134)` };
          }
        }
      } catch (e) {
        if (e instanceof BudgetExceeded || e instanceof UsageLimit || /budget|usage limit/i.test(e.message)) throw e;
        line.error = String(e.message).slice(0, 500);
      }
      lines.push(line);
      console.log(scrubHome(JSON.stringify(line)));
    }
  }
  return lines;
}

// n8n's error object (NodeApiError, NodeOperationError, a runner's error) as the fields a person
// reads in the editor's error panel.
export function errorDetailOf(e) {
  const pick = (v, n = 2000) => (v === undefined || v === null || v === "" ? undefined : typeof v === "string" ? v.slice(0, n) : JSON.stringify(v).slice(0, n));
  const out = { node: e.node?.name ?? null, name: e.name ?? null, message: pick(e.message), description: pick(e.description), httpCode: pick(e.httpCode ?? e.context?.httpCode, 20), cause: pick(e.cause?.message ?? e.cause), stack: pick(e.stack, 600) };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

// PROPOSALS P102: the canned n8n check alone, for the ids named (no convert, no Claude side, no
// model call, nothing saved). Prints one JSON line per variant; returns how many variants ran.
async function n8nCheckOnly(args) {
  let n = 0;
  for (const id of args.ids) {
    for (const v of n8nCheckVariants(args.n8nCheck || true, args.variants)) {
      const t0 = Date.now();
      log(`${id}/${v}: n8n check (canned, check only)`);
      let r;
      try {
        r = await n8nRun(id, v, { canned: true });
      } catch (e) {
        console.log(JSON.stringify({ template: id, variant: v, benchError: String(e.stack ?? e).slice(0, 1500) }));
        continue;
      }
      n++;
      const steps = { [n8nCheckKey(v)]: summarizeCheck(r) };
      const line = {
        template: id,
        variant: v,
        seconds: Math.round((Date.now() - t0) / 1000),
        ...n8nCheckSummary(steps, [v])[v],
        ...(r.errorDetail ? { errorDetail: r.errorDetail } : {}),
        lastNode: r.lastNode ?? null,
        nodes: r.nodes ?? null,
        ...(r.children ? { children: r.children } : {}),
        requests: (r.effects ?? []).map((e) => `${e.method} ${e.proxied ?? ""}${e.path} -> ${e.fixture ?? "none"}`),
        modelModes: r.modelModes,
        credentialsAttached: r.credentialsAttached,
        credentialsMissing: r.credentialsMissing,
        ...(r.pinnedPath ? { pinnedPath: r.pinnedPath } : {}),
        ...(r.httpAttempt ? { httpAttempt: r.httpAttempt } : {}),
        ...(r.badRoutes ? { badRoutes: r.badRoutes } : {}),
      };
      console.log(scrubHome(JSON.stringify(line)));
    }
  }
  return n;
}

// The n8n run of a variant whose fixture cannot be used (PROPOSALS P48): status
// `fixture error`, no effects, no model calls, the reason in `error`.
const FIXTURE_ERROR = "fixture error";
// `error` (PROPOSALS P66: a refused db seed) replaces the bad-route reason.
function fixtureErrorRun(prep, error = null) {
  const b = prep.badRoutes?.[0];
  const message = error?.message ?? `fixture route url cannot be parsed: ${b.method} ${JSON.stringify(b.url)} (${b.error})${prep.badRoutes.length > 1 ? ` and ${prep.badRoutes.length - 1} more` : ""}`;
  return { template: prep.id, variant: prep.variant, status: FIXTURE_ERROR, error: { node: error ? error.node : b.node, message }, effects: [], modelCalls: [], modelModes: [], sources: prep.sources, overlay: prep.overlayApplied, via: prep.via, credentialsAttached: prep.credentialsAttached, logVsFixture: null, credentialsMissing: [], badRoutes: prep.badRoutes };
}

const byTag = (calls) => {
  const m = {};
  for (const c of calls ?? []) (m[c.tag] ??= [])[c.index] = c;
  return m;
};

// ---------- effects of each side ----------

// `result` (PROPOSALS P70, gates 4 and 5 only, never bait): when n8n's run made no write, media
// call or disk write and gives no reply, its terminal nodes' output items are its effects.
function n8nEffects(rec, fx, { result = false } = {}) {
  // PROPOSALS P46: n8n's resumable Drive upload (POST, PUT of the bytes, PATCH of the metadata)
  // is one create_file, as the connector's is.
  // PROPOSALS P66: the database changes are writes, n8n's statements reads (bait is searched in both).
  const list = [...foldResumableUploads(rec.effects).map((e) => fromHttp(e, "n8n")).filter(Boolean), ...(rec.files ?? []).filter((f) => !f.error).map((f) => fromFile(f, "n8n")), ...(rec.db?.changes ?? []).map((c) => fromDb(c, "n8n")), ...(rec.db?.statements ?? []).map((c) => fromDb(c, "n8n"))];
  if (["chat", "form"].includes(fx.trigger.kind)) list.push(replyOf(rec.lastItems?.map((j) => ({ json: j })), "n8n"));
  else if (result && !list.some((e) => e.effect === "write" || e.effect === "media")) {
    // A recording made before P70 has only the last node's first output.
    const terminal = rec.terminal ?? (rec.lastNode ? { [rec.lastNode]: [rec.lastItems ?? []] } : {});
    for (const [node, outputs] of Object.entries(terminal)) list.push(resultOf(node, outputs, "n8n"));
  }
  return list;
}

// PROPOSALS P70: the Claude side's output items of the nodes n8n's result effects name.
const claudeResults = (n8nList, outputsOf) => n8nList.filter(isResult).map((e) => resultOf(e.target, outputsOf(e.target), "claude"));

// A Claude-side call as an effect; a connector call may name a message the fixture serves
// (PROPOSALS P10: a reply tool call resolves its thread, recipients and subject from it).
// A database change or statement (PROPOSALS P66: the same shape as n8n's `db` entries, for when
// the runtime's database steps report them) is compared by the same table.
const claudeEffect = (e, fx) => (e.connector ? fromTool(e, "claude", refsOf(fx)) : e.file ? fromFile(e, "claude") : e.engine && (e.op || e.sql !== undefined || e.command !== undefined) ? fromDb(e, "claude") : fromHttp(e, "claude"));

function claudeEffects(run, fx, n8nList = []) {
  const list = [...run.seen.tools.filter((t) => !t.invalid).map((t) => fromTool(t, "claude", refsOf(fx))), ...run.seen.http.map((h) => fromHttp(h, "claude")).filter(Boolean), ...(run.files ?? []).map((f) => fromFile(f, "claude")), ...(run.seen.db ?? []).map((d) => fromDb(d, "claude"))];
  if (["chat", "form"].includes(fx.trigger.kind) && run.res.status === "done") list.push(replyOf(run.res.output, "claude"));
  list.push(...claudeResults(n8nList, (node) => lastOutputs(run.res.runData?.[node])));
  return list;
}

// Rows are committed: the home path goes, and so does a start of it that a sliced text cut off
// at the end of a JSON string ("…exactly /Users/na" as a detail's last characters).
export function scrubHome(text, home = homedir()) {
  let out = String(text).split(home).join("~");
  const top = home.split("/").slice(0, 2).join("/") + "/";
  for (let k = home.length - 1; k > top.length; k--) out = out.split(home.slice(0, k) + '"').join('~"');
  return out;
}

// ---------- one template ----------

async function benchTemplate(id, args, L) {
  const t = (L.templates[id] ??= { steps: {} });
  const S = t.steps;
  const wf = loadTemplate(id).wf;
  const fxN = loadFixture(id, "normal");
  // PROPOSALS P133: a write node that builds a value with a randomness source.
  const random = randomWriteNodes(wf, fxN.writes ?? []).length > 0;
  const overlay = loadOverlay(id);
  const gates = {};
  const drivers = {};
  const metrics = {};
  const save = () => writeJson(L.file, L.data);
  // PROPOSALS P4: timestamps of the run itself are masked where the sides differ only by them;
  // the window is around n8n's start, the zone is the template's (n8n's default otherwise).
  const runTime = (rec) => (rec?.startedAt ? { startMs: Date.parse(rec.startedAt), zone: wf.settings?.timezone || "America/New_York" } : null);
  const stop = (g) => ({ gates, reached: reached(gates), drivers, metrics });

  // Gate 1: analyze.
  if (!S.analyze) {
    const r = spawnSync(process.execPath, [join(SKILL, "scripts", "analyze.mjs"), join(HERE, "data", "wf", `${id}.json`), "--json", "--now", "2026-11-16T00:00:00Z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    let report = null;
    try {
      report = JSON.parse(r.stdout);
    } catch {}
    S.analyze = { status: r.status, report: report && { workflows: report.workflows.map((w) => ({ outcome: w.outcome, unmapped: w.unmapped })) }, error: r.status !== 0 && !report ? r.stderr.slice(-500) : null };
    save();
  }
  gates[1] = gate1(S.analyze.report, S.analyze.error);
  if (!gates[1].pass) return stop();

  // Gate 2: convert. The plain converter always (second column); the skill run where asked.
  const dir = join(WORK, "runs", args.tag, String(id));
  if (!S.plain) {
    // PROPOSALS P78: the overlay's placeholder fills on the export the Claude side converts.
    const filled = filledSource(id, overlay);
    const source = filled ? join(dir, "source.filled.json") : undefined;
    if (filled) mkdirSync(dir, { recursive: true }), writeFileSync(source, filled);
    const p = convertPlain(id, join(dir, "plain"), source ? { source } : {});
    S.plain = { status: p.status, folder: p.folder, ms: p.ms, ...(filled ? { filledSource: true } : {}) };
    save();
  }
  const useSkill = args.skill.includes("all") || args.skill.includes(String(id));
  if (useSkill && !S.skill) {
    const reuse = args.reuseConvert && readJson(join(WORK, "ledger", `${args.reuseConvert}.json`))?.templates?.[id]?.steps?.skill;
    if (reuse?.folder && existsSync(reuse.folder)) {
      const to = join(dir, "skill", "project", "repo");
      rmSync(join(dir, "skill"), { recursive: true, force: true });
      mkdirSync(dirname(to), { recursive: true });
      cpSync(dirname(reuse.folder), to, { recursive: true });
      S.skill = { ...reuse, folder: folderIn(to), reusedFrom: args.reuseConvert };
    } else {
      log(`${id}: headless skill run (sonnet)`);
      S.skill = await convertSkill(id, join(dir, "skill"), { log });
    }
    save();
  }
  let folder = useSkill ? S.skill.folder : S.plain.folder;
  drivers.convert = useSkill ? "skill (claude -p sonnet, headless)" : "plain convert.mjs (no skill run: budget)";
  // The overlay's Claude half: overrides merged into the folder, then a regenerate (black box).
  // Placeholder fills and time compression alike; the latter is listed apart in the row.
  const claudeOv = [overlay?.claude?.overrides, overlay?.timeCompression?.claude?.overrides].filter(Boolean);
  // PROPOSALS P77: the setup answer for a credential's site (the person names the site their
  // n8n credential points to) comes from the bench credential n8n's run uses.
  if (folder && !S.overlayApplied) {
    const sites = siteAnswers(readJson(join(folder, "report.json")), wf, loadFixture(id, "normal"), overlay);
    if (Object.keys(sites).length) claudeOv.push({ answers: sites });
    // PROPOSALS P80: a step whose host comes from data is answered "public", as n8n runs it.
    const hosts = hostsAnswers(readJson(join(folder, "report.json")));
    if (Object.keys(hosts).length) claudeOv.push({ answers: hosts });
    // PROPOSALS P129: a credential's database is the Claude side's own Postgres.
    const dbs = databaseAnswers(readJson(join(folder, "report.json")), id);
    if (Object.keys(dbs).length) claudeOv.push({ answers: dbs });
    // PROPOSALS P53: the substitutions the converter offers are approved, as the person would.
    const approve = substitutionApprovals(readJson(join(folder, "definition.json")), readJson(join(SKILL, "references", "tool-maps.json")));
    if (approve.length) claudeOv.push({ approve });
  }
  if (folder && claudeOv.length && !S.overlayApplied) {
    const of = join(folder, "overrides.json");
    const o = readJson(of, {});
    for (const ov of claudeOv) {
      o.steps = { ...(o.steps ?? {}), ...(ov.steps ?? {}) };
      o.answers = { ...(o.answers ?? {}), ...(ov.answers ?? {}) };
      if (ov.approve) o.approve = [...new Set([...(o.approve ?? []), ...ov.approve])];
    }
    writeFileSync(of, JSON.stringify(o, null, 2) + "\n");
    const r = spawnSync(process.execPath, [join(SKILL, "scripts", "convert.mjs"), "--regenerate", folder], { encoding: "utf8" });
    S.overlayApplied = { status: r.status, steps: claudeOv.flatMap((ov) => Object.keys(ov.steps ?? {})), ...(claudeOv.some((ov) => ov.answers) ? { answers: Object.assign({}, ...claudeOv.map((ov) => ov.answers ?? {})) } : {}), ...(claudeOv.some((ov) => ov.approve) ? { approved: claudeOv.flatMap((ov) => ov.approve ?? []) } : {}), ...(overlay?.timeCompression?.claude ? { timeCompression: Object.keys(overlay.timeCompression.claude.overrides?.steps ?? {}) } : {}) };
    save();
  }
  const g2 = async (f, skillError) => {
    const definition = f ? readJson(join(f, "definition.json")) : null;
    const report = f ? readJson(join(f, "report.json")) : null;
    let validateIssues = [];
    let preflight = null;
    if (definition) {
      const core = await import(pathToFileURL(join(f, "runtime", "runner-core.mjs")).href);
      validateIssues = core.validateDefinition(definition);
      preflight = core.preflight(definition, {});
    }
    const templateNodes = wf.nodes.filter((n) => !n.disabled && n.type !== "n8n-nodes-base.stickyNote").map((n) => n.name);
    return { gate: gate2({ folder: f, definition, report, validateIssues, templateNodes, skillError }), preflight };
  };
  const plainCol = await g2(S.plain.folder);
  S.plainColumn = { gate2: plainCol.gate, preflightOk: plainCol.preflight?.ok ?? null, preflightErrors: plainCol.preflight?.issues?.filter((i) => i.level === "error").map((i) => i.message) ?? [] };
  const under = useSkill ? await g2(folder, S.skill?.error) : plainCol;
  gates[2] = under.gate;
  if (useSkill) metrics.skill = { ms: S.skill.ms, costUsd: S.skill.costUsd, turns: S.skill.turns, usage: S.skill.usage };
  if (!gates[2].pass) return stop();

  // Gate 3 (static half): preflight. A template that cannot start never needs n8n's model
  // replies; its n8n baseline still runs once with canned models, for the request log.
  if (!under.preflight.ok) {
    gates[3] = { ...runFailureCause({ error: { name: "PreflightFailed", issues: under.preflight.issues } }), driver: "inprocess (preflight)" };
    // PROPOSALS P36: every variant gets the canned run (`--n8n-check normal`: normal only), so
    // fixture defects in the other variants show before a converter change lets the template
    // run. No model is called; nothing is saved as a recording.
    if (args.n8nCheck) {
      for (const v of n8nCheckVariants(args.n8nCheck, args.variants)) {
        if (S[n8nCheckKey(v)]) continue;
        log(`${id}/${v}: n8n check (canned)`);
        S[n8nCheckKey(v)] = summarizeCheck(await n8nRun(id, v, { canned: true }));
        save();
      }
      drivers.n8nCheck = n8nCheckSummary(S, VARIANTS);
    }
    return stop();
  }

  // n8n baseline per variant (recorded or replayed), fetched only when a gate needs it, so a
  // template that fails gate 4 spends no model calls on its other variants.
  const recs = {};
  const need = async (v) => {
    if (recs[v] !== undefined) return recs[v];
    if (!S[`n8n:${v}`]) {
      log(`${id}/${v}: n8n`);
      const r = await n8nRun(id, v, { record: args.record });
      S[`n8n:${v}`] = { status: r.status, error: r.error, ...(r.db ? { db: dbSummary(r.db) } : {}), ...(r.modelCallCap ? { modelCallCap: r.modelCallCap } : {}), modelModes: r.modelModes, executionMs: r.executionMs, wallMs: r.wallMs, startedAt: r.startedAt, logVsFixture: r.logVsFixture, httpAttempt: r.httpAttempt ?? null, sources: r.sources, overlay: r.overlay, credentialsAttached: r.credentialsAttached ?? [], ...(r.container ? { container: r.container } : {}), ...(r.pinnedPath ? { pinnedPath: r.pinnedPath } : {}) };
      save();
    }
    // PROPOSALS P48: a fixture error has no recording (and must not read an older one).
    recs[v] = S[`n8n:${v}`].status === FIXTURE_ERROR ? { status: FIXTURE_ERROR, error: S[`n8n:${v}`].error, effects: [], modelCalls: [] } : readJson(join(RECORDINGS, String(id), `${v}.json`));
    return recs[v];
  };
  await need("normal");
  metrics.n8n = { executionMs: recs.normal?.executionMs, wallMs: recs.normal?.wallMs };

  const evaluate = async (rep) => {
    const out = { runs: {}, gates: {} };
    const g = out.gates;
    const runV = async (v) => (out.runs[v] ??= await runInProcess(folder, loadFixture(id, v, { at: fixtureClock(recs[v]) }), { wf, recordings: recordedCalls(await need(v), loadFixture(id, v, { at: fixtureClock(recs[v]) })), n8nEffects: recs[v]?.effects ?? [], n8nSources: recs[v]?.sources ?? {}, mode: args.modelMode, startedAt: recs[v]?.startedAt, runTime: runTime(recs[v]), log }));
    const N = await runV("normal");
    g[3] = { ...gate3(N.res), driver: "inprocess" };
    // In replay mode the Claude side runs on n8n's recorded replies: a baseline that failed
    // gives it nothing trustworthy to replay, whatever the Claude side did.
    // PROPOSALS P54: a fixture that says the baseline fails on the template's own configuration
    // (expect.n8nFails) gets that named in the cause; the row reports it apart (n8nFails).
    if (recs.normal?.status !== "success") g[3] = { pass: false, bucket: "fixture", cause: `${fxN.expect?.n8nFails ? "n8n baseline fails on the template itself (expect.n8nFails, P54)" : "n8n baseline failed on the normal fixture"}: ${recs.normal?.error?.node ?? "?"}: ${recs.normal?.error?.message ?? recs.normal?.status}${recs.normal?.modelCallCap ? ` (${recs.normal.modelCallCap[0].message})` : ""}`, detail: { claudeSide: g[3] }, driver: "inprocess" };
    if (!g[3].pass) return out;
    const modelTexts = modelTextsOf(recs.normal?.modelCalls, answerOf);
    const n8nN = n8nEffects(recs.normal, fxN, { result: true });
    const cmp = compare(n8nN, claudeEffects(N, fxN, n8nN), { modelTexts, mode: args.modelMode, random, runTime: runTime(recs.normal) });
    out.cmp = cmp;
    let judged = [];
    if (args.modelMode === "live" && cmp.judge.length) {
      const { judgePairs } = await import("./judge.mjs");
      judged = await judgePairs(cmp.judge, { purpose: `judge ${id} rep${rep}` });
      out.judged = judged;
    }
    g[4] = { ...gate4({ cmp, modelInputs: N.seen.models.filter((m) => m.mode === "replay"), n8nStatus: recs.normal?.status, judged }), driver: "inprocess" };
    if (!g[4].pass) return out;
    const vr = {};
    for (const v of ["empty", "malformed"].filter((x) => args.variants.includes(x))) {
      const fx = loadFixture(id, v, { at: fixtureClock(recs[v]) });
      const run = await runV(v);
      const n8nOk = recs[v]?.status === "success";
      const claudeOk = run.res.status === "done";
      const n8nV = n8nOk ? n8nEffects(recs[v], fx, { result: true }) : [];
      const c = n8nOk && claudeOk ? compare(n8nV, claudeEffects(run, fx, n8nV), { modelTexts: modelTextsOf(recs[v]?.modelCalls, answerOf), mode: args.modelMode, random, runTime: runTime(recs[v]) }) : null;
      vr[v] = { n8nOk, claudeOk, relation: robustness(n8nOk, claudeOk, c), claudeRun: { status: run.res.status, error: run.res.error }, n8nError: recs[v]?.error ?? null, ...(recs[v]?.status === FIXTURE_ERROR ? { fixtureError: recs[v].error.message } : {}), ...(c && !c.ok ? { writes: c.writes } : {}) };
    }
    g[5] = { ...gate5(vr), driver: "inprocess" };
    out.robust = vr;
    if (!g[5].pass) return out;
    if (args.variants.includes("hostile")) {
      const fx = loadFixture(id, "hostile", { at: fixtureClock(recs.hostile) });
      const run = await runV("hostile");
      const n8nHits = baitHits(n8nEffects(recs.hostile, fx), fx.expect.bait ?? []);
      if (recs.hostile?.status === FIXTURE_ERROR) g[6] = { pass: false, bucket: "fixture", cause: `hostile: ${recs.hostile.error.message}`, driver: "inprocess" };
      else g[6] = { ...gate6({ claudeCalls: run.seen, allow: run.definition.allow ?? {}, claudeEffects: claudeEffects(run, fx), n8nBaitHits: n8nHits, bait: fx.expect.bait ?? [], baitHits, modelInputs: run.seen.models.filter((m) => m.mode === "replay"), synthetic: syntheticOutcome(fx, { models: run.seen.models, http: run.seen.http }) }), driver: "inprocess" };
    }
    return out;
  };

  const first = await evaluate(1);
  Object.assign(gates, first.gates);
  // PROPOSALS P28: tool definitions offered to the model; descriptions reported, not gated.
  const defs = toolDefsSummary(first.runs.normal?.seen.models ?? []);
  if (defs) drivers.toolDefs = defs;
  t.evidence = {
    normal: first.runs.normal && { status: first.runs.normal.res.status, error: first.runs.normal.res.error, models: first.runs.normal.seen.models, tools: first.runs.normal.seen.tools.map((x) => `${x.connector}.${x.tool}${x.invalid ? " (invalid: " + x.invalid + ")" : ""} <- ${x.fixture}`), http: first.runs.normal.seen.http.map((h) => `${h.method} ${h.url} <- ${h.fixture}`) },
    cmp: first.cmp && { ok: first.cmp.ok, writes: first.cmp.writes, reads: first.cmp.reads, unmapped: first.cmp.unmapped, runTimeMasked: first.cmp.runTimeMasked, ...(first.cmp.randomMasked ? { randomMasked: first.cmp.randomMasked } : {}) },
    robust: first.robust ?? null,
    judged: first.judged ?? null,
  };
  save();
  if ([3, 4, 5, 6].some((g) => !gates[g]?.pass)) {
    // Diagnostics: the verdict stands (first failed gate), but Contained is measured anyway on
    // the hostile fixture, in process and with the claude driver, because it is about a model
    // reading hostile data and says nothing about equivalence.
    if (args.diagnose) {
      t.diagnostics ??= {};
      const D = t.diagnostics;
      if (!D.inprocessHostile && args.variants.includes("hostile")) {
        const rec = await need("hostile");
        const fx = loadFixture(id, "hostile", { at: fixtureClock(rec) });
        const run = await runInProcess(folder, fx, { wf, recordings: recordedCalls(rec, fx), n8nEffects: rec?.effects ?? [], n8nSources: rec?.sources ?? {}, mode: args.modelMode, startedAt: rec?.startedAt, runTime: runTime(rec), log });
        const n8nHits = baitHits(n8nEffects(rec, fx), fx.expect.bait ?? []);
        D.inprocessHostile = { run: { status: run.res.status, error: run.res.error?.message ?? null }, n8n: rec?.status, gate6: gate6({ claudeCalls: run.seen, allow: run.definition.allow ?? {}, claudeEffects: claudeEffects(run, fx), n8nBaitHits: n8nHits, bait: fx.expect.bait ?? [], baitHits, synthetic: syntheticOutcome(fx, { models: run.seen.models, http: run.seen.http }) }), calls: [...run.seen.tools.map((x) => `${x.connector}.${x.tool}`), ...run.seen.http.map((h) => `${h.method} ${h.url}`)] };
        save();
      }
      if (args.driver === "claude") {
        const { runClaudeDriver } = await import("./claude-driver.mjs");
        for (const v of ["normal", "hostile"]) {
          if (D[`claude:${v}`]) continue;
          log(`${id}/${v}: claude driver (haiku), diagnostic`);
          const rec = await need(v);
          const fx = loadFixture(id, v, { at: fixtureClock(rec) });
          const r = await runClaudeDriver(folder, fx, { wf, recordings: recordedCalls(rec, fx), startedAt: rec?.startedAt, runTime: runTime(rec), label: `${args.tag}-${id}-${v}`, log });
          if (r.run || r.summary?.notRun) {
            const ce = r.effects.map((e) => claudeEffect(e, fx)).filter(Boolean);
            r.gate6 = gate6({ claudeCalls: { tools: r.effects.filter((e) => e.connector), http: r.effects.filter((e) => e.url) }, allow: r.allow ?? {}, claudeEffects: ce, n8nBaitHits: baitHits(n8nEffects(rec, fx), fx.expect.bait ?? []), bait: v === "hostile" ? fx.expect.bait ?? [] : [], baitHits, synthetic: syntheticOutcome(fx, { models: r.replayLog ?? [], http: r.effects.filter((e) => e.url) }) });
            if (v === "normal" && rec) r.cmp = compare(n8nEffects(rec, fx), ce.concat(["chat", "form"].includes(fx.trigger.kind) && r.run?.status === "done" ? [replyOf(r.run.output, "claude")] : []), { modelTexts: modelTextsOf(rec.modelCalls, answerOf), mode: args.modelMode, random, runTime: runTime(rec) });
          }
          D[`claude:${v}`] = r;
          save();
        }
        drivers.claudeDiagnostic = Object.fromEntries(["normal", "hostile"].map((v) => [v, { ...D[`claude:${v}`]?.summary, gate6: D[`claude:${v}`]?.gate6 && { pass: D[`claude:${v}`].gate6.pass, cause: D[`claude:${v}`].gate6.cause ?? null }, writesMatchN8n: D[`claude:${v}`]?.cmp ? D[`claude:${v}`].cmp.ok : undefined, metrics: D[`claude:${v}`]?.metrics }]));
        metrics.claudeDriver = D["claude:normal"]?.metrics;
      }
      metrics.diagnostics = { inprocessHostileGate6: D.inprocessHostile?.gate6 ?? null };
    }
    return stop();
  }

  // Claude driver (claude -p haiku with hooks) on normal and hostile, once per template. Its
  // gates 3, 4 and 6 must pass too. Returns true when the template stops here.
  const claudeDriverGates = async () => {
    const { runClaudeDriver } = await import("./claude-driver.mjs");
    const slips = {};
    for (const v of ["normal", "hostile"]) {
      if (!S[`claude:${v}`]) {
        log(`${id}/${v}: claude driver (haiku)`);
        S[`claude:${v}`] = await runClaudeDriver(folder, loadFixture(id, v, { at: fixtureClock(recs[v]) }), { wf, recordings: recordedCalls(await need(v), loadFixture(id, v, { at: fixtureClock(recs[v]) })), startedAt: recs[v]?.startedAt, runTime: runTime(recs[v]), label: `${args.tag}-${id}-${v}`, log });
        save();
      }
      // PROPOSALS P40: a protocol slip (the session broke the runner protocol; not a gate
      // verdict) is retried once on the same commit. Both attempts are kept; the retry's run is
      // the one the gates read, so a slip never turns a failure into a pass by itself, and a
      // slip that repeats stands as the verdict (and counts as a flip if it differs).
      if (S[`claude:${v}`].summary?.slip && !S[`claude:${v}:slip`]) {
        log(`${id}/${v}: claude driver protocol slip (${S[`claude:${v}`].summary.slip.outstanding.join(", ")}); retrying once`);
        S[`claude:${v}:slip`] = S[`claude:${v}`];
        S[`claude:${v}`] = await runClaudeDriver(folder, loadFixture(id, v, { at: fixtureClock(recs[v]) }), { wf, recordings: recordedCalls(await need(v), loadFixture(id, v, { at: fixtureClock(recs[v]) })), startedAt: recs[v]?.startedAt, runTime: runTime(recs[v]), label: `${args.tag}-${id}-${v}-retry`, log });
        save();
      }
      if (S[`claude:${v}:slip`]) slips[v] = { attempts: [S[`claude:${v}:slip`].summary, S[`claude:${v}`].summary].map((x) => ({ runStatus: x?.runStatus ?? null, slip: x?.slip ?? null, finalText: x?.finalText ?? null, stopReason: x?.stopReason ?? null })), repeated: !!S[`claude:${v}`].summary?.slip };
    }
    const cn = S["claude:normal"];
    const ch = S["claude:hostile"];
    drivers.claude = { normal: cn.summary, hostile: ch.summary, ...(Object.keys(slips).length ? { slips } : {}) };
    metrics.claudeDriver = cn.metrics;
    if (!cn.summary?.notRun) {
    const n8nCN = n8nEffects(recs.normal, fxN, { result: true });
    const cNormal = cn.run && compare(n8nCN, cn.effects.map((e) => claudeEffect(e, fxN)).filter(Boolean).concat(["chat", "form"].includes(fxN.trigger.kind) && cn.run.status === "done" ? [replyOf(cn.run.output, "claude")] : [], claudeResults(n8nCN, (node) => cn.run.outputs?.[node] ?? null)), { modelTexts: modelTextsOf(recs.normal?.modelCalls, answerOf), mode: args.modelMode, random, runTime: runTime(recs.normal) });
    const g3c = cn.run?.status === "done" ? { pass: true } : modelRefusal(slips.normal) ?? { ...runFailureCause({ error: cn.run?.error ?? { message: cn.summary?.problem ?? "no run" } }) };
    if (!g3c.pass) gates[3] = { ...g3c, driver: "claude", inprocess: gates[3] };
    else {
      // PROPOSALS P16: the driver's replayed requests are checked like the in-process ones.
      const modelInputs = claudeDriverModelInputs({ replayLog: cn.replayLog ?? [], effects: cn.effects ?? [], recordings: recordedCalls(recs.normal, loadFixture(id, "normal", { at: fixtureClock(recs.normal) })), n8nEffects: recs.normal?.effects ?? [], n8nSources: recs.normal?.sources ?? {}, runTime: runTime(recs.normal), nondeterministic: nondeterministicTools(wf), gapFields: connectorGapFields(folderDefinition(folder)) }).concat(httpModelInputs(cn.httpModelCalls ?? [], recs.normal?.modelCalls ?? [], runTime(recs.normal)));
      drivers.claude.modelChecks = { replayed: modelInputs.length, inputsDiffer: modelInputs.filter((m) => !m.input?.same).length, toolTurns: modelInputs.filter((m) => m.tools).length, toolTurnsFailed: modelInputs.filter((m) => m.tools && !m.tools.same).length, toolDefs: toolDefsSummary(modelInputs), ...(cn.replayLog ? {} : { note: "run made before P16: no replayed requests kept" }) };
      const g4c = gate4({ cmp: cNormal, modelInputs, n8nStatus: recs.normal?.status });
      if (!g4c.pass) gates[4] = { ...g4c, driver: "claude", inprocess: gates[4] };
      // PROPOSALS P35: the hostile run's replayed requests get the tool-list check (P28).
      const recH = await need("hostile");
      const fxH = loadFixture(id, "hostile", { at: fixtureClock(recH) });
      const hostileInputs = claudeDriverModelInputs({ replayLog: ch.replayLog ?? [], effects: ch.effects ?? [], recordings: recordedCalls(recH, fxH), n8nEffects: recH?.effects ?? [], n8nSources: recH?.sources ?? {}, runTime: runTime(recH), nondeterministic: nondeterministicTools(wf) });
      drivers.claude.hostileToolDefs = toolDefsSummary(hostileInputs);
      const g6c = gate6({ claudeCalls: { tools: ch.effects.filter((e) => e.connector), http: ch.effects.filter((e) => e.url) }, allow: ch.allow ?? {}, claudeEffects: ch.effects.map((e) => claudeEffect(e, fxH)).filter(Boolean), n8nBaitHits: baitHits(n8nEffects(recs.hostile, fxH), fxH.expect.bait ?? []), bait: fxH.expect.bait ?? [], baitHits, modelInputs: hostileInputs, synthetic: syntheticOutcome(fxH, { models: ch.replayLog ?? [], http: ch.effects.filter((e) => e.url) }) });
      if (!g6c.pass) gates[6] = { ...g6c, driver: "claude", inprocess: gates[6] };
    }
    for (const g of [3, 4, 6]) if (gates[g].pass) gates[g].driver = "inprocess+claude";
    if ([3, 4, 5, 6].some((g) => !gates[g]?.pass)) return true;
    }
    return false;
  };
  if (args.driver === "claude" && (await claudeDriverGates())) return stop();

  // Gate 7: repeats (in process).
  const reps = [first.gates];
  for (let k = 2; k <= args.repeats; k++) reps.push((await evaluate(k)).gates);
  gates[7] = { ...gate7(reps), driver: "inprocess" };
  if (!gates[7].pass) return stop();

  // Gate 8 needs the claude driver's measurement (PROPOSALS P2): an in-process run that got
  // here runs the driver once now, and the driver's gates 3, 4 and 6 count as above.
  if (args.driver !== "claude") {
    log(`${id}: gates 3-7 passed in process; claude driver (haiku) for gate 8`);
    drivers.claudeForGate8 = true;
    if (await claudeDriverGates()) return stop();
  }

  // Gate 8: the provisional ceiling, on the claude driver's normal run.
  const ceiling = readJson(join(HERE, "ceiling.json"));
  const interval = (S.analyze.report?.workflows?.[0]?.schedule?.shortestIntervalS) ?? undefined;
  gates[8] = { ...gate8(metrics.claudeDriver, ceiling, { intervalS: interval, missing: S["claude:normal"]?.summary?.notRun }), driver: "claude", provisional: true };
  return stop();
}

// PROPOSALS P28: per run, how many replayed requests offered tools, how many differ from n8n's
// in names or schema shapes (gated), and which tools' descriptions differ (reported only).
function toolDefsSummary(models) {
  const withDefs = models.filter((m) => m.toolDefs);
  if (!withDefs.length) return null;
  const desc = [...new Set(withDefs.flatMap((m) => m.toolDefs.descriptions.map((d) => d.tool)))];
  const parser = withDefs.find((m) => m.toolDefs.parser)?.toolDefs.parser ?? null;
  // PROPOSALS P34: description differences by kind (artefacts are gated in gate 4).
  const kinds = {};
  for (const m of withDefs) for (const d of m.toolDefs.descriptions) for (const x of d.diff) (kinds[x.kind ?? "reworded"] ??= new Set()).add(`${d.tool}${x.at === "(tool)" ? "" : "." + x.at}`);
  const descriptionKinds = Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, [...v]]));
  return { requests: withDefs.length, differ: withDefs.filter((m) => !m.toolDefs.same).length, descriptionsDiffer: desc, ...(desc.length ? { descriptionKinds } : {}), ...(parser ? { parser } : {}) };
}

function summarizeCheck(r) {
  return { status: r.status, error: r.error, ...(r.db ? { db: dbSummary(r.db) } : {}), ...(r.modelCallCap ? { modelCallCap: r.modelCallCap } : {}), modelModes: r.modelModes, sources: r.sources, overlay: r.overlay, credentialsAttached: r.credentialsAttached ?? [], ...(r.container ? { container: r.container } : {}), ...(r.pinnedPath ? { pinnedPath: r.pinnedPath } : {}), logVsFixture: r.logVsFixture, httpAttempt: r.httpAttempt ?? null, executionMs: r.executionMs, credentialsMissing: r.credentialsMissing };
}

// A converted folder's definition, or null when there is none to read.
function folderDefinition(folder) {
  try {
    return JSON.parse(readFileSync(join(folder, "definition.json"), "utf8"));
  } catch {
    return null;
  }
}

// PROPOSALS P1: a failure that traces to a field the fixture marks as a connector gap.
function connectorLimitedOf(id, g, failed) {
  if (!failed) return null;
  let gaps = [];
  try {
    gaps = gapsOf(loadFixture(id, "normal"));
  } catch {}
  const hits = connectorLimited(failed, g, gaps, loadTemplate(id).wf);
  return hits ? hits.map((h) => `${h.node}: ${h.field}`) : null;
}

function n8nCannotRunOf(id) {
  try {
    return loadFixture(id, "normal").expect?.n8nCannotRun ?? null;
  } catch {
    return null;
  }
}

// ---------- main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.n8nCheckOnly) {
    let code = 0;
    try {
      const n = await n8nCheckOnly(args);
      log(`n8n check only: ${n} variant run(s), no claude -p, nothing saved`);
    } catch (e) {
      log(`stopped: ${e.stack ?? e.message}`);
      code = 3;
    } finally {
      if (n8nEnv) n8nEnv.shim.server.close();
      if (n8nEnv) n8nEnv.databases.removeDatabases();
    }
    process.exit(code);
  }
  if (args.recordOnly) {
    let code = 0;
    const before = claudeLedger().length;
    try {
      const lines = await recordOnly(args);
      log(`record only: ${lines.reduce((n, l) => n + l.draws.length, 0)} live draw(s), ${claudeLedger().length - before} claude -p (n8n's model calls), no results row`);
    } catch (e) {
      log(`stopped: ${e.stack ?? e.message}`);
      code = 3;
    } finally {
      if (n8nEnv) n8nEnv.shim.server.close();
      if (n8nEnv) n8nEnv.databases.removeDatabases();
    }
    process.exit(code);
  }
  const file = join(WORK, "ledger", `${args.tag}.json`);
  const L = { file, data: readJson(file, { tag: args.tag, started: new Date().toISOString(), args: { ...args, ids: undefined }, templates: {} }) };
  L.templates = L.data.templates;
  const commit = git(["rev-parse", "--short", "HEAD"]);
  const skillCommit = git(["log", "-1", "--format=%h", "--", "skills/n8n-to-claude"]);
  const claudeBefore = claudeLedger();
  log(`tag ${args.tag}, ${args.ids.length} templates, commit ${commit} (skill ${skillCommit})`);
  let stopped = null;
  try {
    for (const id of args.ids) {
      if (L.templates[id]?.done) {
        log(`${id}: done in this tag, skipped`);
        continue;
      }
      const t0 = Date.now();
      const usedBefore = claudeLedger().length;
      let r;
      try {
        r = await benchTemplate(id, args, L);
      } catch (e) {
        if (e instanceof BudgetExceeded || e instanceof UsageLimit || /budget|usage limit/i.test(e.message)) throw e;
        log(`${id}: bench error: ${e.stack}`);
        r = { gates: {}, reached: 0, drivers: {}, metrics: {}, benchError: e.message.slice(0, 500) };
      }
      const t = L.templates[id];
      const g = r.reached;
      const failed = r.gates[g];
      const runs = claudeLedger().slice(usedBefore);
      const row = {
        date: new Date().toISOString(),
        tag: args.tag,
        template: id,
        commit,
        skillCommit,
        reached: g,
        passedAll: g === 9,
        gate: g <= 8 ? g : null,
        cause: r.benchError ? `bench error: ${r.benchError}` : failed?.cause ?? null,
        bucket: r.benchError ? "bench defect" : failed?.bucket ?? null,
        connectorLimited: !r.benchError && !!connectorLimitedOf(id, g, failed),
        connectorGapsHit: r.benchError ? null : connectorLimitedOf(id, g, failed),
        // PROPOSALS P21: the fixture says the bench's n8n image cannot run the main path.
        n8nCannotRun: n8nCannotRunOf(id),
        n8nFails: (() => {
          try {
            return n8nFailsOf(loadFixture(id, "normal"), t.steps);
          } catch {
            return null;
          }
        })(),
        // PROPOSALS P50: what gate 4 compared (comparedOf); `noEffect` names a pass that
        // compared no effect ("reply", "result" (P70) or "model inputs"), reported apart by summary.mjs.
        compared: r.gates?.[4]?.detail?.compared ?? (r.gates?.[4]?.bucket === "bench defect" && /^nothing compared/.test(r.gates[4].cause ?? "") ? r.gates[4].detail : null),
        noEffect: g === 9 ? r.gates?.[4]?.detail?.compared?.class ?? null : null,
        detail: failed?.detail ?? null,
        gates: Object.fromEntries(Object.entries(r.gates).map(([k, v]) => [k, { pass: v.pass, driver: v.driver ?? null, ...(v.pass ? {} : { bucket: v.bucket, cause: v.cause }) }])),
        drivers: r.drivers,
        modelMode: args.modelMode,
        plainColumn: t.steps.plainColumn ?? null,
        config: loadOverlay(id) ? { file: `evals/bench/config/${id}.json`, n8n: t.steps["n8n:normal"]?.overlay ?? t.steps.n8nCheck?.overlay ?? [], claude: t.steps.overlayApplied ?? null, env: Object.keys(loadOverlay(id).env ?? {}), nonPlaceholder: loadOverlay(id).timeCompression ? [{ kind: "time-compression", why: loadOverlay(id).timeCompression.why ?? null }] : [] } : null,
        credentialsAttached: t.steps["n8n:normal"]?.credentialsAttached ?? t.steps.n8nCheck?.credentialsAttached ?? [],
        // The n8n container's template-specific configuration (n8n-side.mjs templateEnv).
        n8nContainer: t.steps["n8n:normal"]?.container ?? t.steps.n8nCheck?.container ?? null,
        // PROPOSALS P53: substitutions the bench approved as the person would (not placeholder fills).
        substitutionsApproved: t.steps.overlayApplied?.approved ?? null,
        // PROPOSALS P89: nodes n8n served from the template's own pinData on the normal run.
        pinnedPath: t.steps["n8n:normal"]?.pinnedPath ?? t.steps.n8nCheck?.pinnedPath ?? null,
        // PROPOSALS P87: modules the template's Code nodes require (n8n's default refuses them).
        codeModules: (() => {
          const m = codeModules(loadTemplate(id).wf);
          return m.length ? m : null;
        })(),
        stubs: t.steps["n8n:normal"]?.sources ?? t.steps.n8nCheck?.sources ?? null,
        n8nModelModes: t.steps["n8n:normal"]?.modelModes ?? t.steps.n8nCheck?.modelModes ?? null,
        logVsFixture: t.steps["n8n:normal"]?.logVsFixture ?? t.steps.n8nCheck?.logVsFixture ?? null,
        httpAttempt: t.steps["n8n:normal"]?.httpAttempt ?? t.steps.n8nCheck?.httpAttempt ?? null,
        metrics: { benchWallMs: Date.now() - t0, ...r.metrics, claudeRuns: runs.length, claudeCostUsd: Math.round(runs.reduce((s, x) => s + (x.costUsd ?? 0), 0) * 10000) / 10000 },
      };
      appendFileSync(RESULTS, scrubHome(JSON.stringify(row)) + "\n"); // rows are committed: no home path
      t.done = true;
      t.row = row;
      writeJson(file, L.data);
      log(`${id}: reached gate ${g}${g <= 8 ? ` (${row.bucket}: ${row.cause})` : " (all passed)"}`);
    }
  } catch (e) {
    stopped = e.message;
    log(`stopped: ${e.message}. Resume with --tag ${args.tag}`);
  } finally {
    writeJson(file, L.data);
    const used = claudeLedger().slice(claudeBefore.length);
    log(`claude -p runs this invocation: ${used.length}, $${used.reduce((s, x) => s + (x.costUsd ?? 0), 0).toFixed(4)} at API prices; total in ledger ${claudeLedger().length}`);
    if (n8nEnv) n8nEnv.shim.server.close();
    // PROPOSALS P66: database sidecars live only while a template that seeds them runs.
    if (n8nEnv) n8nEnv.databases.removeDatabases();
  }
  process.exit(stopped ? 3 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
