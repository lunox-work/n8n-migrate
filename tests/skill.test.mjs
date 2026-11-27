// The skill package: SKILL.md's frontmatter and size, the references it points to, and the
// translation dry-run helper (scripts/try-step.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = join(ROOT, "skills/n8n-to-claude");

test("SKILL.md: frontmatter, triggers, compact body, every reference it names exists", () => {
  const md = readFileSync(join(SKILL, "SKILL.md"), "utf8");
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(md)?.[1];
  assert.ok(fm, "frontmatter");
  for (const k of ["name: n8n-to-claude", "description:", "license:", "compatibility:"]) assert.ok(fm.includes(k), k);
  const desc = fm.slice(fm.indexOf("description:"), fm.indexOf("license:")).replace(/\s+/g, " ");
  for (const phrase of ["move, migrate or port n8n workflows to Claude", "whether an n8n workflow can run on Claude", "pastes n8n workflow JSON"]) assert.ok(desc.includes(phrase), phrase);
  assert.ok(desc.length <= 1024, `description is ${desc.length} characters`);
  assert.ok(md.split("\n").length < 250, `SKILL.md has ${md.split("\n").length} lines`);
  for (const ref of new Set([...md.matchAll(/references\/[\w.-]+/g)].map((m) => m[0]))) assert.ok(existsSync(join(SKILL, ref)), ref);
  for (const s of new Set([...md.matchAll(/scripts\/[\w.-]+\.mjs/g)].map((m) => m[0]))) assert.ok(existsSync(join(SKILL, s)), s);
});

test("try-step: runs one step alone on sample items; requests are recorded, nothing is sent", () => {
  const out = mkdtempSync(join(tmpdir(), "n8m-try-"));
  try {
    const r = JSON.parse(spawnSync(process.execPath, [join(SKILL, "scripts/convert.mjs"), join(ROOT, "tests/fixtures/convert/poll-code-http.n8n.json"), "--out", out], { encoding: "utf8" }).stdout);
    const folder = join(out, r.workflows[0].folder);
    writeFileSync(join(out, "items.json"), JSON.stringify([{ subject: "Invoice 7", snippet: "Total $99.50 due" }, { json: { subject: "x", snippet: "no amount" } }]));
    const code = spawnSync(process.execPath, [join(SKILL, "scripts/try-step.mjs"), folder, "Extract amount", "--items", join(out, "items.json")], { encoding: "utf8" });
    assert.equal(code.status, 0, code.stderr);
    const res = JSON.parse(code.stdout);
    assert.equal(res.status, "done");
    assert.equal(res.output[0].amount, 99.5);
    assert.deepEqual(res.requests, []);
    const http = JSON.parse(spawnSync(process.execPath, [join(SKILL, "scripts/try-step.mjs"), folder, "Notify accounts", "--items", join(out, "items.json")], { encoding: "utf8" }).stdout);
    assert.deepEqual(http.requests.map((q) => [q.kind, q.method, q.url]), [["http", "POST", "https://api.accounts.example.com/v1/invoices"], ["http", "POST", "https://api.accounts.example.com/v1/invoices"]]);
    const bad = spawnSync(process.execPath, [join(SKILL, "scripts/try-step.mjs"), folder, "No such step"], { encoding: "utf8" });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /no step "No such step"/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
