// The skill as shipped: its scripts run from a linked install, and scripts/skill.mjs check
// holds for the repository (manifests, links, sizes, wording a directory scanner misreads).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = join(ROOT, "skills/n8n-to-claude");
const run = (args, opts = {}) => spawnSync(process.execPath, args, { encoding: "utf8", ...opts });

test("scripts run when the skill folder is reached through a symlink (skills installers link it)", () => {
  const dir = mkdtempSync(join(tmpdir(), "n2c-link-"));
  try {
    symlinkSync(SKILL, join(dir, "n8n-to-claude"));
    const linked = join(dir, "n8n-to-claude", "scripts");
    const report = run([join(linked, "analyze.mjs"), join(ROOT, "tests/fixtures/convert/poll-code-http.n8n.json")]);
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /1 workflows: /);
    for (const script of ["convert.mjs", "cutover.mjs", "try-step.mjs"]) {
      const usage = run([join(linked, script)]);
      assert.match(usage.stdout + usage.stderr, /usage: /, script);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
