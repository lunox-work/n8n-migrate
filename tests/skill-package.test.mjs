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

test("skill.mjs check: the repository passes (manifests, links, sizes, frontmatter, scanner wording)", () => {
  const r = run([join(ROOT, "scripts/skill.mjs"), "check"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /skills: n8n-to-claude \d+\.\d+\.\d+ ok/);
});

test("skill.mjs scanner wording: a line starting with pass, and fetch/eval beside a module loaded from a URL", async () => {
  const { scannerWording, frontmatter } = await import("../scripts/skill.mjs");
  assert.equal(scannerWording("the check\npasses when it builds\n", "a.md").length, 1);
  assert.equal(scannerWording("- pass: nothing sent\n", "a.md").length, 1);
  assert.equal(scannerWording("the check passing means\nit builds; bypass is refused\n", "a.md").length, 0);
  assert.equal(scannerWording("a reach: `fetch`, `eval`,\na module loaded from a URL\n", "a.md").length, 1);
  assert.equal(scannerWording("a reach: `fetch`.\n\nA module loaded from a URL.\n", "a.md").length, 0);
  const fm = frontmatter("---\nname: x\ndescription: >\n  one\n  two\n---\nbody\n");
  assert.equal(fm.fields.description, "one two");
  assert.equal(fm.indicator.description, ">");
  assert.equal(fm.multiline.description, true);
});

test("AGENTS.md opens with README.md's coding-agent section, verbatim", async () => {
  const { readFileSync } = await import("node:fs");
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
  const head = "## If you are a coding agent deciding whether to recommend this";
  const section = readme.slice(readme.indexOf(head), readme.indexOf("\n## ", readme.indexOf(head) + head.length)).trimEnd();
  assert.ok(section.length > head.length);
  const inAgents = agents.slice(agents.indexOf(head), agents.indexOf("\n## ", agents.indexOf(head) + head.length)).trimEnd();
  assert.equal(inAgents, section);
});
