// PLAN Phase 1 item 2: in a chat or Cowork the runtime ships once, in the skill. A light
// folder is the definition and its report; the page, a chat skill and a task's files are built
// from it on demand (convert.mjs --light, --build; scripts/task.mjs on a light folder).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isLight } from "../skills/n8n-migrate/scripts/convert.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const S = join(ROOT, "skills/n8n-migrate/scripts");
const FIX = join(ROOT, "tests/fixtures/convert");
const node = (script, ...args) => spawnSync(process.execPath, ["--max-old-space-size=512", join(S, script), ...args], { encoding: "utf8" });
const sizeOf = (dir) => readdirSync(dir, { withFileTypes: true, recursive: true }).filter((d) => d.isFile()).reduce((n, d) => n + statSync(join(d.parentPath ?? d.path, d.name)).size, 0);
const filesOf = (dir) => readdirSync(dir).sort();

test("convert --light writes the definition and its report only; --build writes each part as a full conversion does", () => {
  const dir = mkdtempSync(join(tmpdir(), "n8m-light-"));
  try {
    const full = join(dir, "full");
    const light = join(dir, "light");
    assert.equal(node("convert.mjs", join(FIX, "chat-agent.n8n.json"), "--out", full, "--now", "2026-11-14T00:00:00Z").status, 0);
    const r = node("convert.mjs", join(FIX, "chat-agent.n8n.json"), "--out", light, "--light", "--now", "2026-11-14T00:00:00Z");
    assert.equal(r.status, 0, r.stderr);
    const [name] = JSON.parse(r.stdout).workflows.map((w) => w.folder);
    const f = join(light, name);
    assert.deepEqual(filesOf(f), ["MIGRATION.md", "definition.json", "overrides.json", "report.json", "source.n8n.json"]);
    assert.deepEqual(filesOf(light), [name], "no settings or hook at the root: nothing here runs from this folder");
    assert.ok(sizeOf(f) < 100_000, `a light folder is small (${sizeOf(f)} bytes)`);
    assert.ok(sizeOf(join(full, name)) > 3_000_000, "a full folder carries the runtime");
    assert.equal(readFileSync(join(f, "definition.json"), "utf8"), readFileSync(join(full, name, "definition.json"), "utf8"));
    assert.deepEqual([isLight(f), isLight(join(full, name))], [true, false]);

    // The page: the same file a full conversion writes.
    const page = node("convert.mjs", "--build", "page", f);
    assert.equal(page.status, 0, page.stderr);
    assert.deepEqual(JSON.parse(page.stdout).files, ["artifact.html", "artifact.capabilities.json"]);
    for (const x of ["artifact.html", "artifact.capabilities.json"]) assert.equal(readFileSync(join(f, x), "utf8"), readFileSync(join(full, name, x), "utf8"), x);
    // The chat skill: complete, with its own runtime.
    assert.equal(node("convert.mjs", "--build", "skill", f).status, 0);
    for (const x of ["SKILL.md", "definition.json", "task.json", "runtime/runner.mjs", "runtime/hook.mjs"]) assert.equal(readFileSync(join(f, "skill", x), "utf8"), readFileSync(join(full, name, "skill", x), "utf8"), x);
    assert.equal(isLight(f), true, "still light: a regenerate keeps the folder small");
    // Regenerate keeps it light and drops parts built from the definition before.
    assert.equal(node("convert.mjs", "--regenerate", f, "--now", "2026-11-14T00:00:00Z").status, 0);
    assert.deepEqual(filesOf(f), ["MIGRATION.md", "definition.json", "overrides.json", "report.json", "source.n8n.json"]);
    // The task's files make it a full folder, which a regenerate then keeps whole.
    assert.equal(node("convert.mjs", "--build", "task", f).status, 0);
    for (const x of ["runtime/runner.mjs", "task.json", "task-prompt.md", ".claude/settings.json"]) assert.ok(existsSync(join(f, x)), x);
    assert.ok(existsSync(join(light, "n8m-hook.mjs")) && existsSync(join(light, ".claude/settings.json")), "the root settings and hook come with a task");
    assert.equal(node("convert.mjs", "--regenerate", f).status, 0);
    assert.ok(existsSync(join(f, "artifact.html")) && existsSync(join(f, "runtime/runner.mjs")));
    // Refusals say why.
    const bad = node("convert.mjs", "--build", "everything", f);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--build takes page, skill, task or all, not everything/);
    assert.equal(node("convert.mjs", "--build", "page").status, 2);
    const notChat = join(dir, "sched");
    const s = JSON.parse(node("convert.mjs", join(FIX, "slice.n8n.json"), "--out", notChat, "--light").stdout).workflows[0].folder;
    assert.match(node("convert.mjs", "--build", "skill", join(notChat, s)).stderr, /is not a chat workflow: it has no skill to build/);
    assert.match(node("convert.mjs", "--build", "page", join(dir, "nowhere")).stderr, /has no definition\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migrate.mjs writes light folders, and a scheduled workflow's test run and task prompt work from one", () => {
  const dir = mkdtempSync(join(tmpdir(), "n8m-light-migrate-"));
  try {
    const out = join(dir, "out");
    const r = node("migrate.mjs", join(FIX, "slice.n8n.json"), "--out", out, "--connected", "gmail,slack", "--json");
    assert.equal(r.status, 0, r.stderr);
    const x = JSON.parse(r.stdout).groups.ready[0];
    const folder = join(out, "flows", x.folder);
    assert.equal(isLight(folder), true);
    assert.ok(sizeOf(join(out, "flows")) < 200_000, `the whole flows folder is small (${sizeOf(join(out, "flows"))} bytes)`);
    // The test run: set up from the light folder with the skill's own runtime, then a dry run starts.
    const tryDir = join(dir, "try");
    const setup = node("task.mjs", "setup", folder, "--local", "--dir", tryDir);
    assert.equal(setup.status, 0, setup.stdout + setup.stderr);
    assert.match(setup.stdout, /^READY: "Morning mail digest" is set up in /);
    assert.deepEqual(JSON.parse(readFileSync(join(tryDir, "task.json"), "utf8")).store, { kind: "file" });
    const start = spawnSync(process.execPath, [join(tryDir, "runtime/runner.mjs"), "start", "--dry-run"], { encoding: "utf8", cwd: tryDir });
    assert.match(start.stdout, /NEXT: call one tool/);
    assert.match(start.stdout, /Tool: mcp__Gmail__search_threads/, "the tool names of a claude.ai scheduled task");
    // The task's instructions, and the page it will set itself up from.
    const prompt = node("task.mjs", "prompt", folder, "--artifact", "https://claude.ai/artifact/AbC123");
    assert.equal(prompt.status, 0, prompt.stdout);
    assert.match(prompt.stdout, /You run the migrated n8n workflow "Morning mail digest"\. Its definition and its records live in the page https:\/\/claude\.ai\/artifact\/AbC123/);
    assert.equal(node("convert.mjs", "--build", "page", folder).status, 0);
    const fromPage = node("task.mjs", "setup", join(folder, "artifact.html"), "--artifact", "https://claude.ai/artifact/AbC123", "--dir", join(dir, "task"));
    assert.equal(fromPage.status, 0, fromPage.stdout);
    assert.equal(readFileSync(join(dir, "task", "definition.json"), "utf8"), readFileSync(join(tryDir, "definition.json"), "utf8"), "the page and the light folder set up the same definition");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
