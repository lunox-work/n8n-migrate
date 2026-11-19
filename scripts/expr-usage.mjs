#!/usr/bin/env node
// Scans n8n workflows for what their expressions and Code nodes call, so the
// runtime's expression coverage is measurable (evals/expr-usage.json).
//
//   node scripts/expr-usage.mjs [--out evals/expr-usage.json] [dirs...]
//
// Default inputs: the survey corpus (evals/survey/data/wf, git-ignored; the
// template wrapper keeps the workflow in .workflow.workflow) and the author's
// sibling repos next to this one (../n8n-*/workflows). Counts are occurrences.
// A method is counted when the source has `.name(` (or `?.name(`); globals are
// `$name` identifiers. `runtime` says whether the runtime supports the name:
// "extension" (n8n extension we implement), "native" (a JS built-in method on
// a value type), "missing" (an n8n extension the runtime lacks) or "other"
// (neither: user-defined helpers, library calls, typos).
import { readFileSync, readdirSync, existsSync, writeFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const out = outIdx >= 0 ? args.splice(outIdx, 2)[1] : join(ROOT, "evals/expr-usage.json");
const dirs = args.length ? args : [join(ROOT, "evals/survey/data/wf"), ...siblingDirs()];

function siblingDirs() {
  const up = resolve(ROOT, "..");
  return readdirSync(up)
    .filter((d) => d.startsWith("n8n-") && d !== "n8n-migrate")
    .map((d) => join(up, d, "workflows"))
    .filter((d) => existsSync(d) && statSync(d).isDirectory());
}

function workflowsOf(j) {
  if (Array.isArray(j)) return j.flatMap(workflowsOf);
  if (j?.workflow?.workflow?.nodes) return [j.workflow.workflow];
  if (j?.workflow?.nodes) return [j.workflow];
  if (j?.nodes) return [j];
  if (Array.isArray(j?.data)) return j.data.flatMap(workflowsOf);
  return [];
}

function strings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
}

// Code segments of an expression string: text between {{ and }}.
function exprSegments(s) {
  if (!s.startsWith("=")) return [];
  const segs = [];
  let i = 0;
  while ((i = s.indexOf("{{", i)) >= 0) {
    const j = s.indexOf("}}", i + 2);
    segs.push(s.slice(i + 2, j < 0 ? undefined : j));
    if (j < 0) break;
    i = j + 2;
  }
  return segs;
}

// Drop string literal contents and comments so words inside them are not counted.
function stripLiterals(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1 ")
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, '""');
}

const CODE_PARAMS = { "n8n-nodes-base.code": ["jsCode"], "n8n-nodes-base.function": ["functionCode"], "n8n-nodes-base.functionItem": ["functionCode"] };

const dict = () => Object.create(null);
const tally = { expressions: { methods: dict(), globals: dict() }, code: { methods: dict(), globals: dict() } };
const meta = { workflows: 0, files: 0, expressionStrings: 0, codeNodes: 0, pythonCodeNodes: 0, sources: [] };
const bump = (o, k) => (o[k] = (o[k] ?? 0) + 1);

function scan(code, bucket) {
  const c = stripLiterals(code);
  for (const m of c.matchAll(/\??\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) bump(bucket.methods, m[1]);
  for (const m of c.matchAll(/(?<![\w$.])(\$[A-Za-z_][\w]*)/g)) bump(bucket.globals, m[1]);
}

for (const dir of dirs) {
  if (!existsSync(dir)) continue;
  meta.sources.push(dir.startsWith(ROOT) ? dir.slice(ROOT.length + 1) : "../" + dir.split("/").slice(-2).join("/"));
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    let j;
    try {
      j = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      continue;
    }
    meta.files++;
    for (const wf of workflowsOf(j)) {
      meta.workflows++;
      for (const node of wf.nodes || []) {
        const p = node.parameters || {};
        const codeKeys = CODE_PARAMS[node.type] || [];
        if (node.type === "n8n-nodes-base.code" && /python/i.test(p.language || "")) meta.pythonCodeNodes++;
        else if (codeKeys.some((k) => typeof p[k] === "string")) {
          meta.codeNodes++;
          for (const k of codeKeys) if (typeof p[k] === "string") scan(p[k], tally.code);
        }
        for (const s of strings(p)) {
          const segs = exprSegments(s);
          if (segs.length) meta.expressionStrings++;
          for (const seg of segs) scan(seg, tally.expressions);
        }
      }
    }
  }
}

async function classify() {
  let rt = null;
  try {
    rt = await import(join(ROOT, "skills/n8n-migrate/runtime/dist/runner-core.mjs"));
  } catch {}
  const support = rt?.expressionSupport?.();
  const sortObj = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
  const rows = (o) =>
    Object.fromEntries(Object.entries(sortObj(o)).map(([k, n]) => [k, support ? { count: n, runtime: support.method(k) } : { count: n }]));
  const grows = (o) => Object.fromEntries(Object.entries(sortObj(o)).map(([k, n]) => [k, support ? { count: n, runtime: support.global(k) } : { count: n }]));
  const result = {
    $doc: "Generated by scripts/expr-usage.mjs. Method calls and $globals used in n8n expressions and JavaScript Code/Function nodes of the scanned workflows. runtime: extension | native | missing | other (see the script header).",
    meta,
    expressions: { methods: rows(tally.expressions.methods), globals: grows(tally.expressions.globals) },
    code: { methods: rows(tally.code.methods), globals: grows(tally.code.globals) },
  };
  if (support) {
    const cov = (bucket) => {
      const used = Object.entries(bucket).filter(([, r]) => r.runtime !== "other");
      const missing = used.filter(([, r]) => r.runtime === "missing").map(([k]) => k);
      return { used: used.length, supported: used.length - missing.length, missing };
    };
    result.coverage = {
      expressionMethods: cov(result.expressions.methods),
      codeMethods: cov(result.code.methods),
      expressionGlobals: cov(result.expressions.globals),
      codeGlobals: cov(result.code.globals),
    };
  }
  writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  console.log(`${meta.workflows} workflows, ${meta.expressionStrings} expression strings, ${meta.codeNodes} JS code nodes -> ${out}`);
  if (result.coverage) console.log(JSON.stringify(result.coverage));
}
await classify();
