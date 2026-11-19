// "Ask Claude alone" vs the analyzer: where can each n8n workflow run once it leaves n8n?
//
//   node evals/compare-claude/run.mjs [--model sonnet] [--concurrency 2] [--only analyzer] [--limit n (a trial, not saved)]
//
// The set (40): the 20 hand labels of evals/bench/labels.json (written before the analyzer was
// read for them; mostly workflows that should not move) and 20 templates proven to move: drawn
// with a fixed seed from the 50 dev templates that passed all 8 bench gates against n8n 2.47.7
// at release point 5 (assets/src/index.html lists them). Truth: the label's outcome, or
// `subscription` for a proven template.
//
// Arms, on the same exported workflow ({name, nodes, connections, settings, pinData}):
//   analyzer   analyze.mjs with default answers (no model)
//   claude     `claude -p` with prompt.md as the whole system prompt and the export as the
//              message: no tools, no MCP servers, no settings, an empty working folder (so no
//              CLAUDE.md and no auto-memory), one answer per template
// Writes results.jsonl (one row per template and arm) and prints the summary. Needs
// evals/bench/data/wf (node evals/bench/fetch.mjs) and, for the claude arm, the claude CLI
// signed in (CLAUDE_BIN, else `claude` on PATH, else the VS Code extension's binary).

import { readFileSync, writeFileSync, existsSync, mkdtempSync, readdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { analyze, unwrap } from "../../skills/n8n-migrate/scripts/analyze.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const REFS = join(ROOT, "skills/n8n-migrate/references");
const WF = join(ROOT, "evals/bench/data/wf");
const SEED = 20261118;
const PASSES = "585 1747 1900 1951 1953 1954 1957 1959 1963 1980 2006 2063 2085 2090 2139 2163 2197 2299 2384 2433 2473 2537 2552 2567 2572 2605 2612 2614 2648 2694 2695 2703 2729 2777 2799 2803 2813 2824 2859 2883 2956 3018 3085 3086 3102 3132 3904 4573 5035 13270".split(" ");
const OUTCOMES = ["subscription", "hosted", "keep-in-n8n", "replaced"];

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? true : all[i + 1]]] : a), []));
const MODEL = args.model ?? "sonnet";
const CONC = Number(args.concurrency ?? 2);

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 2 ** 32);
}
function sample(xs, n, seed) {
  const r = rng(seed);
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n).sort((x, y) => Number(x) - Number(y));
}

export function buildSet() {
  const labels = JSON.parse(readFileSync(join(ROOT, "evals/bench/labels.json"), "utf8")).labels;
  const set = labels.map((l) => ({ id: String(l.id), truth: l.outcome, source: "label" }));
  for (const id of sample(PASSES, 20, SEED)) set.push({ id, truth: "subscription", source: "passed-bench" });
  return set.map((t) => {
    const raw = JSON.parse(readFileSync(join(WF, `${t.id}.json`), "utf8"));
    const [w] = unwrap(raw, t.id);
    const { nodes, connections, settings, pinData } = w.wf;
    return { ...t, name: w.name, item: w, exported: { name: w.name, nodes, connections, settings: settings ?? {}, ...(pinData ? { pinData } : {}) } };
  });
}

function analyzerArm(set) {
  const ref = (n) => JSON.parse(readFileSync(join(REFS, n), "utf8"));
  const ctx = { nodes: ref("nodes.json"), capabilities: ref("capabilities.json"), hosts: ref("http-hosts.json"), now: Date.parse("2026-11-18T00:00:00Z") };
  return set.map((t) => {
    const t0 = performance.now();
    const w = analyze([{ ...t.item, file: `${t.id}.json` }], ctx).workflows[0];
    return { id: t.id, arm: "analyzer", truth: t.truth, source: t.source, answer: w.outcome.kind, why: w.outcome.reason, ms: Math.round(performance.now() - t0) };
  });
}

function claudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  if (spawnSync("sh", ["-c", "command -v claude"]).status === 0) return "claude";
  const ext = join(homedir(), ".vscode/extensions");
  const dir = existsSync(ext) ? readdirSync(ext).filter((d) => d.startsWith("anthropic.claude-code-")).sort().pop() : null;
  if (dir) return join(ext, dir, "resources/native-binary/claude");
  throw new Error("no claude CLI: set CLAUDE_BIN");
}

function ask(bin, system, t, cwd) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(bin, ["-p", "--model", MODEL, "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", "--output-format", "json", "--system-prompt", system], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      let answer = null;
      let why = null;
      let usage = null;
      try {
        const env = JSON.parse(out);
        usage = env.usage ?? null;
        const m = String(env.result ?? "").match(/\{[\s\S]*\}/);
        const j = m ? JSON.parse(m[0]) : null;
        answer = OUTCOMES.includes(j?.outcome) ? j.outcome : null;
        why = j?.why ?? String(env.result ?? "").slice(0, 300);
      } catch {
        why = (err || out).slice(0, 300);
      }
      resolve({ id: t.id, arm: `claude-${MODEL}`, truth: t.truth, source: t.source, answer, why, code, ms: Date.now() - t0, inputTokens: usage?.input_tokens ?? null, cacheRead: usage?.cache_read_input_tokens ?? null });
    });
    p.stdin.end(`Here is the n8n workflow, exported from n8n:\n\n\`\`\`json\n${JSON.stringify(t.exported, null, 2)}\n\`\`\``);
  });
}

async function claudeArm(set, onRow) {
  const bin = claudeBin();
  const system = readFileSync(join(HERE, "prompt.md"), "utf8");
  const cwd = mkdtempSync(join(tmpdir(), "n8m-alone-"));
  const rows = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: CONC }, async () => {
      while (next < set.length) {
        const t = set[next++];
        const r = await ask(bin, system, t, cwd);
        rows.push(r);
        onRow(r);
      }
    }),
  );
  return rows;
}

export function summarize(rows) {
  const by = {};
  for (const r of rows) {
    const s = (by[r.arm] ??= { n: 0, right: 0, noAnswer: 0, saidMovesWrongly: 0, cannotMove: 0, saidStaysWrongly: 0, proven: 0 });
    s.n++;
    if (r.answer === null) s.noAnswer++;
    if (r.answer === r.truth) s.right++;
    if (r.truth !== "subscription") {
      s.cannotMove++;
      if (r.answer === "subscription") s.saidMovesWrongly++;
    } else {
      s.proven++;
      if (r.answer !== "subscription") s.saidStaysWrongly++;
    }
  }
  return by;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const set = args.limit ? buildSet().slice(0, Number(args.limit)) : buildSet();
  const out = args.limit ? join(tmpdir(), "n8m-alone-trial.jsonl") : join(HERE, "results.jsonl");
  const stamp = new Date().toISOString();
  const rows = analyzerArm(set);
  if (args.only !== "analyzer") {
    process.stderr.write(`claude arm: ${set.length} templates, model ${MODEL}, ${CONC} at a time\n`);
    rows.push(...(await claudeArm(set, (r) => process.stderr.write(`  ${r.id} truth ${r.truth} -> ${r.answer ?? "no answer"} (${Math.round(r.ms / 1000)} s)\n`))));
  }
  for (const r of rows) appendFileSync(out, JSON.stringify({ at: stamp, model: MODEL, ...r }) + "\n");
  console.log(JSON.stringify({ set: { labels: set.filter((t) => t.source === "label").length, provenToMove: set.filter((t) => t.source === "passed-bench").length }, arms: summarize(rows) }, null, 2));
}
