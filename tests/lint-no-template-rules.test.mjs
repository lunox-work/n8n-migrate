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
