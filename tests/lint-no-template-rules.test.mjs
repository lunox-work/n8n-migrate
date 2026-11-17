// PLAN Phase 6: skill files must not carry template ids, names or fixture strings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LINT = join(ROOT, "scripts", "lint-no-template-rules.mjs");
const run = (...a) => spawnSync(process.execPath, [LINT, ...a], { encoding: "utf8" });

// A round-5-on walk entry that no rule lets into the bench (the lint's header).
const splitsDoc = JSON.parse(readFileSync(join(ROOT, "evals/bench/splits.json"), "utf8"));
const drawnHeld = new Set([...Object.entries(splitsDoc).filter(([k]) => /^heldOutFresh\d*$/.test(k)).flatMap(([, v]) => v.templates ?? []), ...(splitsDoc.experiments ?? []).flatMap((e) => e.templates ?? [])].map((t) => t.id));
const outsideBench = (t) => ((t.topUp ?? 0) >= 5 && (t.excluded || t.pool !== "fresh")) || ((t.heldRefill ?? 0) >= 5 && !drawnHeld.has(t.id));

test("skills/ carries no template id, name or fixture string", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
});

test("the lint catches a planted id and a planted fixture string", () => {
  const dir = mkdtempSync(join(tmpdir(), "n2c-lint-"));
  try {
    const id = JSON.parse(readFileSync(join(ROOT, "evals/bench/corpus.json"), "utf8")).templates[0].id;
    writeFileSync(join(dir, "a.mjs"), `if (template === ${id}) fix();\nconst v = "1.${id}"; // a version is not an id\n`);
    writeFileSync(join(dir, "b.md"), "Ask for priya@acme-logistics.example when the sender is empty.\n");
    const r = run("--dir", dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`a\\.mjs:1: template id ${id}`));
    assert.doesNotMatch(r.stderr, /a\.mjs:2/);
    assert.match(r.stderr, /b\.md:1: fixture string/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A template id that is also an HTTP status code is not a hit next to its own reason phrase (a
// status table), and still is anywhere else.
test("an HTTP status code beside its reason phrase is not a template id", async () => {
  const { STATUS_CODES } = await import("node:http");
  const ids = JSON.parse(readFileSync(join(ROOT, "evals/bench/corpus.json"), "utf8")).templates.filter((t) => !outsideBench(t)).map((t) => t.id);
  const code = ids.find((id) => STATUS_CODES[id]);
  if (!code) return; // no corpus id is a status code
  const dir = mkdtempSync(join(tmpdir(), "n2c-lint-"));
  try {
    writeFileSync(join(dir, "a.mjs"), `const REASONS = { ${code}: "${STATUS_CODES[code].toUpperCase()}" };\nif (template === ${code}) fix();\n`);
    const r = run("--dir", dir);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stderr, /a\.mjs:1/);
    assert.match(r.stderr, new RegExp(`a\\.mjs:2: template id ${code}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// From round 5 a held-out walk's entries that can never enter the bench (excluded, or not pool
// `fresh`) are not id hits; its candidates and every earlier corpus id still are.
test("a round-5 walk entry outside the bench is not an id hit; a candidate is", () => {
  const t = JSON.parse(readFileSync(join(ROOT, "evals/bench/corpus.json"), "utf8")).templates;
  const all = new Set(t.filter((x) => !outsideBench(x)).map((x) => x.id));
  const out = t.find((x) => outsideBench(x) && String(x.id).length >= 3 && !all.has(x.id));
  const cand = t.find((x) => x.topUp >= 5 && !outsideBench(x) && String(x.id).length >= 3);
  if (!out || !cand) return;
  const dir = mkdtempSync(join(tmpdir(), "n2c-lint-"));
  try {
    writeFileSync(join(dir, "a.mjs"), `const n = ${out.id};\nif (template === ${cand.id}) fix();\n`);
    const r = run("--dir", dir);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stderr, /a\.mjs:1/);
    assert.match(r.stderr, new RegExp(`a\\.mjs:2: template id ${cand.id}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
