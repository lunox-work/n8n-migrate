// The shipped runtime: dist is current, the core is browser-safe, the CLI contract holds,
// and 500 items run fast enough.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildRuntime } from "../scripts/build-runtime.mjs";
import { wf, node, start, CLOCK } from "./runtime-helpers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RT = join(ROOT, "skills/n8n-to-claude/runtime");
const DIST = join(RT, "dist");

test("runtime/dist is what scripts/build-runtime.mjs produces from runtime/src", () => {
  for (const [name, content] of Object.entries(buildRuntime())) {
    assert.equal(readFileSync(join(DIST, name), "utf8"), content, `dist/${name} is stale: run node scripts/build-runtime.mjs`);
  }
});

test("the core is browser-safe: no node: imports, no Node globals, Luxon is its only import", () => {
  const core = readFileSync(join(DIST, "runner-core.mjs"), "utf8");
  const imports = [...core.matchAll(/^\s*import\s.*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./luxon.mjs"]);
  const hits = [...core.matchAll(/from\s+["']node:|import\(\s*["']node:|\brequire\s*\(\s*["'](node:|fs|path|crypto|child_process)|\bprocess\.(env|argv|exit|cwd|versions)\b|\bBuffer\.(from|alloc)|(?<!")\b__(dirname|filename)\b(?!")/g)];
  assert.deepEqual(hits.map((m) => core.slice(Math.max(0, m.index - 40), m.index + 40)), []);
  for (const f of readdirSync(join(RT, "src")).filter((f) => f !== "cli.mjs")) {
    assert.doesNotMatch(readFileSync(join(RT, "src", f), "utf8"), /from\s+"node:/, `src/${f} imports a node: module`);
  }
  const luxon = readFileSync(join(DIST, "luxon.mjs"), "utf8");
  assert.match(luxon, /^\/\*! Luxon 3\.7\.2/);
  assert.match(luxon, /Permission is hereby granted, free of charge/);
});

test("the bundled core runs a workflow", async () => {
  const core = await import(join(DIST, "runner-core.mjs"));
  const r = await core.run(wf([start(), node("Set", "set", { assignments: { assignments: [{ name: "x", type: "string", value: "={{ $json.a.toUpperCase() }}" }] }, options: {} }, { v: 3.4 })], [["Start", "Set"]]), { trigger: [{ a: "b" }], clock: CLOCK });
  assert.equal(r.status, "done");
  assert.deepEqual(r.output, [{ x: "B" }]);
});

function cli(args) {
  const r = spawnSync(process.execPath, ["--max-old-space-size=256", join(DIST, "runner.mjs"), ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout.trim().split("\n").pop()) : null, stderr: r.stderr };
}

test("CLI: run -> needs (10) -> resume -> done (0); bad input (2); failed (1)", () => {
  const dir = mkdtempSync(join(tmpdir(), "n2c-cli-"));
  try {
    const def = wf([start(), node("Fetch", "httpRequest", { url: "=https://api.example.com/o/{{ $json.id }}", options: {} }, { v: 4.2 })], [["Start", "Fetch"]], { allow: { http: [{ method: "GET", host: "api.example.com", pathPrefix: "/o/" }] } });
    writeFileSync(join(dir, "def.json"), JSON.stringify(def));
    const state = join(dir, "run.json");
    const a = cli(["run", join(dir, "def.json"), "--trigger", '[{"id": 7}]', "--state", state, "--clock", CLOCK.startedAt]);
    assert.equal(a.code, 10, a.stderr);
    assert.equal(a.out.status, "needs");
    assert.deepEqual(a.out.requests.map((r) => [r.id, r.url]), [["Fetch#0#0", "https://api.example.com/o/7"]]);
    writeFileSync(join(dir, "results.json"), JSON.stringify({ "Fetch#0#0": { ok: true, value: { status: 200, headers: { "content-type": "application/json" }, body: { total: 3 } } } }));
    const b = cli(["resume", "--state", state, "--results", join(dir, "results.json")]);
    assert.equal(b.code, 0, b.stderr);
    assert.deepEqual(b.out, { status: "done", runId: a.out.runId, output: [{ total: 3 }], effects: 1 });
    assert.equal(cli(["resume", "--state", state, "--results", join(dir, "results.json")]).code, 2);
    assert.equal(cli(["run", join(dir, "nope.json"), "--state", state]).code, 2);
    writeFileSync(join(dir, "bad.json"), JSON.stringify(wf([start(), node("Stop", "stopAndError", { errorMessage: "halt" })], [["Start", "Stop"]])));
    const f = cli(["run", join(dir, "bad.json"), "--state", join(dir, "run2.json")]);
    assert.equal(f.code, 1);
    assert.equal(f.out.error.message, "halt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("performance: 500 items through Set -> If -> Code -> Merge in under a second", async () => {
  const core = await import(join(DIST, "runner-core.mjs"));
  const def = wf(
    [
      start(),
      node("Set", "set", { assignments: { assignments: [{ name: "n", type: "number", value: "={{ $json.i * 3 }}" }, { name: "label", type: "string", value: "=item {{ $json.i }} of {{ $input.all().length }}" }, { name: "src", type: "number", value: "={{ $('Start').item.json.i }}" }] }, includeOtherFields: true, options: {} }, { v: 3.4, pos: [200, 0] }),
      node("If", "if", { conditions: { options: { version: 2, typeValidation: "strict", caseSensitive: true }, combinator: "and", conditions: [{ leftValue: "={{ $json.n % 2 }}", rightValue: 0, operator: { type: "number", operation: "equals" } }] }, options: {} }, { v: 2.2, pos: [400, 0] }),
      node("Code", "code", { jsCode: "return $input.all().map(i => ({ json: { ...i.json, even: true, root: $('Set').item ? 1 : 0 } }));" }, { v: 2, pos: [600, -100] }),
      node("Merge", "merge", {}, { v: 3, pos: [800, 0] }),
    ],
    [["Start", "Set"], ["Set", "If"], ["If", "Code", 0], ["If", "Merge", 1, 1], ["Code", "Merge", 0, 0]],
  );
  const trigger = Array.from({ length: 500 }, (_, i) => ({ i }));
  await core.run(def, { trigger: trigger.slice(0, 5), clock: CLOCK });
  const t0 = performance.now();
  const r = await core.run(def, { trigger, clock: CLOCK });
  const ms = performance.now() - t0;
  assert.equal(r.status, "done");
  assert.equal(r.output.length, 500);
  assert.equal(r.output.filter((o) => o.even).length, 250);
  console.log(`# perf: 500 items Set -> If -> Code -> Merge: ${ms.toFixed(0)} ms`);
  assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
});
