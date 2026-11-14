#!/usr/bin/env node
// The evaluation bench (PLAN Phase 5): gates 1-8 per template, n8n in Docker as the baseline,
// the migrated folder run by the runner. Contract: evals/bench/README.md.
//
//   node evals/bench/run.mjs [<templateId>...] [--split dev] [--limit n]
//        [--variants normal,empty,malformed,hostile] [--repeats 3] [--model-mode replay|live]
//        [--driver inprocess|claude] [--skill <id,id|all|none>] [--tag <run tag>]
//        [--reuse-convert <tag>] [--record] [--no-n8n-check] [--diagnose]
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
// A template stops at its first failed gate. One row per template goes to evals/results.jsonl.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepare, runN8n, logVsFixture, splitLog, loadTemplate, loadFixture, loadOverlay, overlayEnv } from "./n8n-side.mjs";
import { convertPlain, convertSkill, runInProcess, folderIn } from "./claude-side.mjs";
import { startShim, answerOf } from "./model-shim.mjs";
import { fromHttp, fromTool, reply, replyText, compare, modelTextsOf, baitHits } from "./compare.mjs";
import { gate1, gate2, gate3, gate4, gate5, gate6, gate7, gate8, robustness, reached, runFailureCause, gapsOf, connectorLimited } from "./gates.mjs";
import { BudgetExceeded, UsageLimit, ledger as claudeLedger } from "./claude.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const SKILL = join(ROOT, "skills", "n8n-to-claude");
const WORK = join(HERE, ".work");
const RECORDINGS = join(HERE, "recordings");
const RESULTS = join(ROOT, "evals", "results.jsonl");
const VARIANTS = ["normal", "empty", "malformed", "hostile"];

function parseArgs(argv) {
  const a = { diagnose: false, ids: [], variants: VARIANTS, repeats: 3, modelMode: "replay", driver: "inprocess", skill: [], tag: null, reuseConvert: null, record: false, n8nCheck: true, split: null, limit: null };
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
    else if (k === "--diagnose") a.diagnose = true;
    else if (k === "--split") a.split = v();
    else if (k === "--limit") a.limit = Number(v());
    else if (k.startsWith("--")) throw new Error(`unknown flag ${k}`);
    else a.ids.push(Number(k));
  }
  if (!a.ids.length) {
    const splits = JSON.parse(readFileSync(join(HERE, "splits.json"), "utf8"));
    if (a.split === "held-out") throw new Error("held-out runs only at release points (EXCLUSIONS.md); pass ids explicitly");
    a.ids = splits.dev.map((x) => x.id).filter((id) => existsSync(join(HERE, "fixtures", String(id))));
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
  const { runWorkflow } = await import("../n8n/run-workflow.mjs");
  await container.up({ extraEnv: overlayEnv(), log });
  const shim = await startShim({ port: container.MODEL_SHIM_PORT, log });
  n8nEnv = { container, runWorkflow, shim };
  return n8nEnv;
}

// One n8n run of a template variant. Model replies: replay the committed recording when there
// is one (and --record is off), else live (claude -p, cached by request) and saved.
// mode "canned": no model at all (baseline check for templates whose Claude side stops early).
async function n8nRun(id, variant, { record = false, canned = false } = {}) {
  const recFile = join(RECORDINGS, String(id), `${variant}.json`);
  const existing = readJson(recFile);
  const env = await n8n();
  let prep = prepare(id, variant);
  const session = canned ? { mode: "canned" } : existing && !record ? { mode: "replay", recorded: byTag(existing.modelCalls), fallback: "live" } : { mode: "live" };
  let r = await runN8n(prep, { shim: env.shim, modelSession: session, runWorkflow: env.runWorkflow, copyIn: env.container.copyIn, timeoutS: 900 });
  let httpAttempt = null;
  if (r.fallbackable) {
    log(`${id}/${variant}: ${r.failedNode} failed on its http source, retrying with its n8n pin`);
    httpAttempt = { failedNode: r.failedNode, error: r.result.error ?? null, logVsFixture: logVsFixture(prep, r.result.effects) };
    prep = prepare(id, variant, { pinFallback: [r.failedNode] });
    r = await runN8n(prep, { shim: env.shim, modelSession: session, runWorkflow: env.runWorkflow, copyIn: env.container.copyIn, timeoutS: 900 });
  }
  if (env.shim.lastError && /budget|usage limit/i.test(env.shim.lastError.message)) throw env.shim.lastError;
  const res = r.result;
  const out = {
    template: id,
    variant,
    status: res.status,
    error: res.error ?? null,
    startedAt: res.startedAt,
    executionMs: res.executionMs,
    wallMs: res.wallMs,
    lastNode: res.lastNode,
    lastItems: res.nodes?.[res.lastNode]?.at(-1)?.items?.main?.[0] ?? [],
    nodes: Object.fromEntries(Object.entries(res.nodes ?? {}).map(([k, v]) => [k, v.map((x) => ({ status: x.status, ...(x.error ? { error: x.error.slice(0, 300) } : {}), items: x.items?.main?.map((o) => o.length) }))])),
    effects: splitLog(res.effects).service.map(({ seq, method, proxied, tls, path, query, rawQuery, body, bodyEncoding, fixture }) => ({ seq, method, proxied, tls, path, query, rawQuery, body, bodyEncoding, fixture })),
    modelCalls: r.modelCalls.map(({ tag, node, index, format, request, response, mode, costUsd }) => ({ tag, node, index, format, request, response, mode, costUsd })),
    modelModes: [...new Set(r.modelCalls.map((c) => c.mode))],
    sources: prep.sources,
    overlay: prep.overlayApplied,
    via: prep.via,
    credentialsAttached: prep.credentialsAttached,
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

const byTag = (calls) => {
  const m = {};
  for (const c of calls ?? []) (m[c.tag] ??= [])[c.index] = c;
  return m;
};

// ---------- effects of each side ----------

function n8nEffects(rec, fx) {
  const list = rec.effects.map((e) => fromHttp(e, "n8n")).filter(Boolean);
  if (["chat", "form"].includes(fx.trigger.kind)) list.push(reply(replyText(rec.lastItems?.map((j) => ({ json: j }))), "n8n"));
  return list;
}

function claudeEffects(run, fx) {
  const list = [...run.seen.tools.filter((t) => !t.invalid).map((t) => fromTool(t, "claude")), ...run.seen.http.map((h) => fromHttp(h, "claude")).filter(Boolean)];
  if (["chat", "form"].includes(fx.trigger.kind) && run.res.status === "done") list.push(reply(replyText(run.res.output), "claude"));
  return list;
}

// ---------- one template ----------

async function benchTemplate(id, args, L) {
  const t = (L.templates[id] ??= { steps: {} });
  const S = t.steps;
  const wf = loadTemplate(id).wf;
  const fxN = loadFixture(id, "normal");
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
    const p = convertPlain(id, join(dir, "plain"));
    S.plain = { status: p.status, folder: p.folder, ms: p.ms };
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
  if (folder && claudeOv.length && !S.overlayApplied) {
    const of = join(folder, "overrides.json");
    const o = readJson(of, {});
    for (const ov of claudeOv) {
      o.steps = { ...(o.steps ?? {}), ...(ov.steps ?? {}) };
      o.answers = { ...(o.answers ?? {}), ...(ov.answers ?? {}) };
    }
    writeFileSync(of, JSON.stringify(o, null, 2) + "\n");
    const r = spawnSync(process.execPath, [join(SKILL, "scripts", "convert.mjs"), "--regenerate", folder], { encoding: "utf8" });
    S.overlayApplied = { status: r.status, steps: claudeOv.flatMap((ov) => Object.keys(ov.steps ?? {})), ...(overlay?.timeCompression?.claude ? { timeCompression: Object.keys(overlay.timeCompression.claude.overrides?.steps ?? {}) } : {}) };
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
    if (args.n8nCheck && !S.n8nCheck) {
      S.n8nCheck = summarizeCheck(await n8nRun(id, "normal", { canned: true }));
      save();
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
      S[`n8n:${v}`] = { status: r.status, error: r.error, modelModes: r.modelModes, executionMs: r.executionMs, wallMs: r.wallMs, startedAt: r.startedAt, logVsFixture: r.logVsFixture, httpAttempt: r.httpAttempt ?? null, sources: r.sources, overlay: r.overlay, credentialsAttached: r.credentialsAttached ?? [] };
      save();
    }
    recs[v] = readJson(join(RECORDINGS, String(id), `${v}.json`));
    return recs[v];
  };
  await need("normal");
  metrics.n8n = { executionMs: recs.normal?.executionMs, wallMs: recs.normal?.wallMs };

  const evaluate = async (rep) => {
    const out = { runs: {}, gates: {} };
    const g = out.gates;
    const runV = async (v) => (out.runs[v] ??= await runInProcess(folder, loadFixture(id, v), { wf, recordings: (await need(v))?.modelCalls ?? [], mode: args.modelMode, startedAt: recs[v]?.startedAt, runTime: runTime(recs[v]), log }));
    const N = await runV("normal");
    g[3] = { ...gate3(N.res), driver: "inprocess" };
    // In replay mode the Claude side runs on n8n's recorded replies: a baseline that failed
    // gives it nothing trustworthy to replay, whatever the Claude side did.
    if (recs.normal?.status !== "success") g[3] = { pass: false, bucket: "fixture", cause: `n8n baseline failed on the normal fixture: ${recs.normal?.error?.node ?? "?"}: ${recs.normal?.error?.message ?? recs.normal?.status}`, detail: { claudeSide: g[3] }, driver: "inprocess" };
    if (!g[3].pass) return out;
    const modelTexts = modelTextsOf(recs.normal?.modelCalls, answerOf);
    const cmp = compare(n8nEffects(recs.normal, fxN), claudeEffects(N, fxN), { modelTexts, mode: args.modelMode, runTime: runTime(recs.normal) });
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
      const fx = loadFixture(id, v);
      const run = await runV(v);
      const n8nOk = recs[v]?.status === "success";
      const claudeOk = run.res.status === "done";
      const c = n8nOk && claudeOk ? compare(n8nEffects(recs[v], fx), claudeEffects(run, fx), { modelTexts: modelTextsOf(recs[v]?.modelCalls, answerOf), mode: args.modelMode, runTime: runTime(recs[v]) }) : null;
      vr[v] = { n8nOk, claudeOk, relation: robustness(n8nOk, claudeOk, c), claudeRun: { status: run.res.status, error: run.res.error }, n8nError: recs[v]?.error ?? null, ...(c && !c.ok ? { writes: c.writes } : {}) };
    }
    g[5] = { ...gate5(vr), driver: "inprocess" };
    out.robust = vr;
    if (!g[5].pass) return out;
    if (args.variants.includes("hostile")) {
      const fx = loadFixture(id, "hostile");
      const run = await runV("hostile");
      const n8nHits = baitHits(n8nEffects(recs.hostile, fx), fx.expect.bait ?? []);
      g[6] = { ...gate6({ claudeCalls: run.seen, allow: run.definition.allow ?? {}, claudeEffects: claudeEffects(run, fx), n8nBaitHits: n8nHits, bait: fx.expect.bait ?? [], baitHits }), driver: "inprocess" };
    }
    return out;
  };

  const first = await evaluate(1);
  Object.assign(gates, first.gates);
  t.evidence = {
    normal: first.runs.normal && { status: first.runs.normal.res.status, error: first.runs.normal.res.error, models: first.runs.normal.seen.models, tools: first.runs.normal.seen.tools.map((x) => `${x.connector}.${x.tool}${x.invalid ? " (invalid: " + x.invalid + ")" : ""} <- ${x.fixture}`), http: first.runs.normal.seen.http.map((h) => `${h.method} ${h.url} <- ${h.fixture}`) },
    cmp: first.cmp && { ok: first.cmp.ok, writes: first.cmp.writes, reads: first.cmp.reads, unmapped: first.cmp.unmapped, runTimeMasked: first.cmp.runTimeMasked },
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
        const fx = loadFixture(id, "hostile");
        const rec = await need("hostile");
        const run = await runInProcess(folder, fx, { wf, recordings: rec?.modelCalls ?? [], mode: args.modelMode, startedAt: rec?.startedAt, runTime: runTime(rec), log });
        const n8nHits = baitHits(n8nEffects(rec, fx), fx.expect.bait ?? []);
        D.inprocessHostile = { run: { status: run.res.status, error: run.res.error?.message ?? null }, n8n: rec?.status, gate6: gate6({ claudeCalls: run.seen, allow: run.definition.allow ?? {}, claudeEffects: claudeEffects(run, fx), n8nBaitHits: n8nHits, bait: fx.expect.bait ?? [], baitHits }), calls: [...run.seen.tools.map((x) => `${x.connector}.${x.tool}`), ...run.seen.http.map((h) => `${h.method} ${h.url}`)] };
        save();
      }
      if (args.driver === "claude") {
        const { runClaudeDriver } = await import("./claude-driver.mjs");
        for (const v of ["normal", "hostile"]) {
          if (D[`claude:${v}`]) continue;
          log(`${id}/${v}: claude driver (haiku), diagnostic`);
          const rec = await need(v);
          const fx = loadFixture(id, v);
          const r = await runClaudeDriver(folder, fx, { wf, recordings: rec?.modelCalls ?? [], startedAt: rec?.startedAt, label: `${args.tag}-${id}-${v}`, log });
          if (r.run || r.summary?.notRun) {
            const ce = r.effects.map((e) => (e.connector ? fromTool(e, "claude") : fromHttp(e, "claude"))).filter(Boolean);
            r.gate6 = gate6({ claudeCalls: { tools: r.effects.filter((e) => e.connector), http: r.effects.filter((e) => e.url) }, allow: r.allow ?? {}, claudeEffects: ce, n8nBaitHits: baitHits(n8nEffects(rec, fx), fx.expect.bait ?? []), bait: v === "hostile" ? fx.expect.bait ?? [] : [], baitHits });
            if (v === "normal" && rec) r.cmp = compare(n8nEffects(rec, fx), ce.concat(["chat", "form"].includes(fx.trigger.kind) && r.run?.status === "done" ? [reply(replyText(r.run.output), "claude")] : []), { modelTexts: modelTextsOf(rec.modelCalls, answerOf), mode: args.modelMode, runTime: runTime(rec) });
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
    for (const v of ["normal", "hostile"]) {
      if (!S[`claude:${v}`]) {
        log(`${id}/${v}: claude driver (haiku)`);
        S[`claude:${v}`] = await runClaudeDriver(folder, loadFixture(id, v), { wf, recordings: (await need(v))?.modelCalls ?? [], startedAt: recs[v]?.startedAt, label: `${args.tag}-${id}-${v}`, log });
        save();
      }
    }
    const cn = S["claude:normal"];
    const ch = S["claude:hostile"];
    drivers.claude = { normal: cn.summary, hostile: ch.summary };
    metrics.claudeDriver = cn.metrics;
    if (!cn.summary?.notRun) {
    const cNormal = cn.run && compare(n8nEffects(recs.normal, fxN), cn.effects.map((e) => (e.connector ? fromTool(e, "claude") : fromHttp(e, "claude"))).filter(Boolean).concat(["chat", "form"].includes(fxN.trigger.kind) && cn.run.status === "done" ? [reply(replyText(cn.run.output), "claude")] : []), { modelTexts: modelTextsOf(recs.normal?.modelCalls, answerOf), mode: args.modelMode, runTime: runTime(recs.normal) });
    const g3c = cn.run?.status === "done" ? { pass: true } : { ...runFailureCause({ error: cn.run?.error ?? { message: cn.summary?.problem ?? "no run" } }) };
    if (!g3c.pass) gates[3] = { ...g3c, driver: "claude", inprocess: gates[3] };
    else {
      const g4c = gate4({ cmp: cNormal, modelInputs: [], n8nStatus: recs.normal?.status });
      if (!g4c.pass) gates[4] = { ...g4c, driver: "claude", inprocess: gates[4] };
      const fxH = loadFixture(id, "hostile");
      const g6c = gate6({ claudeCalls: { tools: ch.effects.filter((e) => e.connector), http: ch.effects.filter((e) => e.url) }, allow: ch.allow ?? {}, claudeEffects: ch.effects.map((e) => (e.connector ? fromTool(e, "claude") : fromHttp(e, "claude"))).filter(Boolean), n8nBaitHits: baitHits(n8nEffects(recs.hostile, fxH), fxH.expect.bait ?? []), bait: fxH.expect.bait ?? [], baitHits });
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

function summarizeCheck(r) {
  return { status: r.status, error: r.error, modelModes: r.modelModes, sources: r.sources, overlay: r.overlay, credentialsAttached: r.credentialsAttached ?? [], logVsFixture: r.logVsFixture, httpAttempt: r.httpAttempt ?? null, executionMs: r.executionMs, credentialsMissing: r.credentialsMissing };
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

// ---------- main ----------

async function main() {
  const args = parseArgs(process.argv.slice(2));
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
        detail: failed?.detail ?? null,
        gates: Object.fromEntries(Object.entries(r.gates).map(([k, v]) => [k, { pass: v.pass, driver: v.driver ?? null, ...(v.pass ? {} : { bucket: v.bucket, cause: v.cause }) }])),
        drivers: r.drivers,
        modelMode: args.modelMode,
        plainColumn: t.steps.plainColumn ?? null,
        config: loadOverlay(id) ? { file: `evals/bench/config/${id}.json`, n8n: t.steps["n8n:normal"]?.overlay ?? t.steps.n8nCheck?.overlay ?? [], claude: t.steps.overlayApplied ?? null, env: Object.keys(loadOverlay(id).env ?? {}), nonPlaceholder: loadOverlay(id).timeCompression ? [{ kind: "time-compression", why: loadOverlay(id).timeCompression.why ?? null }] : [] } : null,
        credentialsAttached: t.steps["n8n:normal"]?.credentialsAttached ?? t.steps.n8nCheck?.credentialsAttached ?? [],
        stubs: t.steps["n8n:normal"]?.sources ?? t.steps.n8nCheck?.sources ?? null,
        n8nModelModes: t.steps["n8n:normal"]?.modelModes ?? t.steps.n8nCheck?.modelModes ?? null,
        logVsFixture: t.steps["n8n:normal"]?.logVsFixture ?? t.steps.n8nCheck?.logVsFixture ?? null,
        httpAttempt: t.steps["n8n:normal"]?.httpAttempt ?? t.steps.n8nCheck?.httpAttempt ?? null,
        metrics: { benchWallMs: Date.now() - t0, ...r.metrics, claudeRuns: runs.length, claudeCostUsd: Math.round(runs.reduce((s, x) => s + (x.costUsd ?? 0), 0) * 10000) / 10000 },
      };
      appendFileSync(RESULTS, JSON.stringify(row) + "\n");
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
  }
  process.exit(stopped ? 3 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
