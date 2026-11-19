// The plain page as the person's status page (scripts/status.mjs, report-html.mjs): what runs
// on Claude, its last run and how to undo it, kept in the page itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { applyStatus, showStatus } from "../skills/n8n-migrate/scripts/status.mjs";
import { renderPlainHtml, readPlainPage } from "../skills/n8n-migrate/scripts/report-html.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATUS = join(ROOT, "skills/n8n-migrate/scripts/status.mjs");
const MIGRATE = join(ROOT, "skills/n8n-migrate/scripts/migrate.mjs");
const PAGE = "https://claude.ai/artifact/AbC123_x-9";

const item = (id, name, o = {}) => ({ id, name, group: "ready", runs: "scheduled-task", says: "Runs on Claude every day, with Gmail.", why: null, todo: [], fix: [], developer: false, apps: ["Gmail"], n8n: "on", ...o });
const plan = () => ({ groups: { ready: [item("a", "Morning digest"), item("b", "Weekly <report>")], needs: [], stays: [item("c", "Keyed", { group: "stays", runs: null, says: "", why: "it signs in with a saved key", developer: true })] }, counts: { ready: 2, needs: 0, stays: 1 }, easiest: "a", fix: [], developer: 1 });

test("a workflow switched on moves to Running on Claude, with its last run, its page and how to undo it", () => {
  const p0 = plan();
  const before = renderPlainHtml(p0);
  assert.ok(!before.includes("Running on Claude"));
  assert.match(before, /Nothing has changed in n8n\./);
  assert.deepEqual(readPlainPage(before), p0, "the page carries its plan");

  const on = applyStatus(p0, "moved", "a", { page: PAGE, task: "Morning digest", when: "every day at 08:00", zone: "Asia/Singapore", at: "2026-11-20T00:05:00Z" });
  assert.equal(on.error, undefined);
  let html = renderPlainHtml(on.plan);
  assert.match(html, /<h2>Running on Claude <span class="count">1<\/span><\/h2>/);
  assert.match(html, /One workflow runs on Claude now; its n8n copy is switched off\./);
  assert.match(html, /Runs on Claude every day at 08:00, with Gmail\. <span class="mute">Since 20 Nov 2026, 08:05\.<\/span>/, "times in the workflow's timezone");
  assert.match(html, /No run yet\./);
  assert.match(html, new RegExp(`<a href="${PAGE}">Every run and what it sent</a>`));
  assert.match(html, /To undo, tell Claude: <q>undo Morning digest<\/q>\. Claude pauses it here first, then switches it back on in n8n, so nothing is sent twice\./);
  // It left Ready to move; the tiles count what is left, and the first move is the next ready one.
  assert.deepEqual([...html.matchAll(/<div class="tile [a-z]+"><b>(\d+)<\/b><span>([^<]+)<\/span>/g)].map((m) => [m[2], Number(m[1])]), [["Running on Claude", 1], ["Ready to move", 1], ["Needs one thing from you", 0], ["Stays in n8n for now", 1]]);
  assert.match(html, /<article class="card first"><div class="start">Start here<\/div><header><h3>Weekly &lt;report&gt;<\/h3>/);
  assert.equal((html.match(/Morning digest<\/h3>/g) ?? []).length, 1, "listed once");

  // Its runs: what it did in plain words; a failure and a stop point to its page.
  const ran = applyStatus(on.plan, "ran", "a", { outcome: "done", did: ["drafted a reply to Ana", " posted to #sales "], at: "2026-11-21T00:03:00Z" });
  html = renderPlainHtml(ran.plan);
  assert.match(html, /<b>Last run<\/b> 21 Nov 2026, 08:03: finished\. It drafted a reply to Ana and posted to #sales\./);
  assert.match(renderPlainHtml(applyStatus(ran.plan, "ran", "a", { outcome: "failed", at: "2026-11-22T00:03:00Z" }).plan), /22 Nov 2026, 08:03: did not finish\. Open its page to see why\./);
  assert.match(renderPlainHtml(applyStatus(ran.plan, "ran", "a", { outcome: "stopped", at: "2026-11-22T00:03:00Z" }).plan), /stopped and is waiting for you\./);
  assert.equal(showStatus(ran.plan), `Morning digest (a): on Claude since 2026-11-20T00:05:00Z, task "Morning digest"; last run 2026-11-21T00:03:00Z done: drafted a reply to Ana; posted to #sales; page ${PAGE}\n`);
  // Switched on again later: the last run is kept. Without a timezone, times say UTC.
  assert.deepEqual(applyStatus(ran.plan, "moved", "a", { page: PAGE, at: "2026-11-23T00:00:00Z" }).plan.moved.a.lastRun.outcome, "done");
  assert.match(renderPlainHtml(applyStatus(p0, "moved", "b", { page: PAGE, n8n: "was-off", at: "2026-11-20T00:05:00Z" }).plan), /Since 20 Nov 2026, 00:05 UTC\..*undo Weekly &lt;report&gt;<\/q>\. Claude pauses it here first; it was already off in n8n\./s);

  // Undo: back under Ready to move, and the page reads as before.
  const undone = applyStatus(ran.plan, "undone", "a");
  assert.deepEqual(undone.plan, p0);
  assert.equal(showStatus(undone.plan), "Nothing runs on Claude yet.\n");
});

test("status.mjs refuses what it cannot record, and never takes a link that is not a Claude page", () => {
  const p0 = plan();
  assert.match(applyStatus(p0, "moved", "zzz", { page: PAGE }).error, /no workflow with id zzz/);
  for (const page of [undefined, "https://example.com/artifact/x", "javascript:alert(1)", `${PAGE}"><script>`]) assert.match(applyStatus(p0, "moved", "a", { page }).error, /--page must be the workflow page's claude\.ai\/artifact/);
  assert.match(applyStatus(p0, "ran", "a", { outcome: "done" }).error, /not recorded as running on Claude; record the switch-on first/);
  assert.match(applyStatus(p0, "undone", "a").error, /not recorded as running on Claude/);
  const on = applyStatus(p0, "moved", "a", { page: PAGE }).plan;
  assert.match(applyStatus(on, "ran", "a", { outcome: "great" }).error, /--outcome is done, failed or stopped/);
  assert.match(applyStatus(on, "ran", "a", { outcome: "done", at: "yesterday" }).error, /--at is not a time/);
  assert.match(applyStatus(p0, "moved", "a", { page: PAGE, n8n: "maybe" }).error, /--n8n is off or was-off/);
  // What a run did is text in the page, never markup.
  const html = renderPlainHtml(applyStatus(on, "ran", "a", { outcome: "done", did: ['sent <img src=x onerror="1">'] }).plan);
  assert.ok(html.includes("sent &lt;img src=x onerror=&quot;1&quot;&gt;") && !html.includes("<img"));
  // The embedded plan cannot close its own script element.
  const tricky = plan();
  tricky.groups.ready[0].name = "x</script><script>alert(1)</script>";
  const page = renderPlainHtml(tricky);
  assert.equal((page.match(/<script/g) ?? []).length, 1);
  assert.equal(readPlainPage(page).groups.ready[0].name, "x</script><script>alert(1)</script>");
});

test("the commands write the page in place; migrate.mjs keeps what runs on Claude when it sorts again", () => {
  const dir = mkdtempSync(join(tmpdir(), "n8m-status-"));
  try {
    const node = (script, ...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    const fixture = join(ROOT, "tests/fixtures/convert/slice.n8n.json");
    const out = join(dir, "out");
    assert.equal(node(MIGRATE, fixture, "--out", out, "--connected", "gmail,slack").status, 0);
    const id = JSON.parse(readFileSync(join(out, "plan.json"), "utf8")).groups.ready[0].id;
    assert.equal(node(STATUS, out, "show").stdout, "Nothing runs on Claude yet.\n");
    const moved = node(STATUS, out, "moved", id, "--page", PAGE, "--task", "Digest", "--when", "every day at 08:00", "--zone", "Asia/Singapore");
    assert.equal(moved.status, 0, moved.stderr);
    assert.match(moved.stdout, /is recorded as running on Claude\. Publish .*page\.html again to the same link\./);
    assert.equal(node(STATUS, out, "ran", id, "--outcome", "done", "--did", "posted the digest to #mail", "--did", "read 2 emails").status, 0);
    const html = readFileSync(join(out, "page.html"), "utf8");
    assert.match(html, /finished\. It posted the digest to #mail and read 2 emails\./);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(out, "plan.json"), "utf8")).moved), [String(id)]);
    // Sorting again in the same folder keeps it; so does a new folder given a saved copy of the page.
    assert.equal(node(MIGRATE, fixture, "--out", out, "--connected", "gmail,slack").status, 0);
    assert.match(readFileSync(join(out, "page.html"), "utf8"), /Running on Claude/);
    writeFileSync(join(dir, "saved.html"), html);
    const fresh = join(dir, "fresh");
    assert.equal(node(MIGRATE, fixture, "--out", fresh, "--connected", "gmail,slack", "--status", join(dir, "saved.html")).status, 0);
    assert.equal(readPlainPage(readFileSync(join(fresh, "page.html"), "utf8")).moved[String(id)].lastRun.outcome, "done");
    // A saved copy of the published page is enough to work on, and undo puts it back.
    assert.equal(node(STATUS, join(dir, "saved.html"), "undone", id).status, 0);
    assert.ok(!readFileSync(join(dir, "saved.html"), "utf8").includes("Running on Claude"));
    // Refusals: exit 1 with the reason, exit 2 for bad usage, and a page without a plan is named.
    assert.deepEqual([node(STATUS, out, "ran", "nope", "--outcome", "done").status, node(STATUS, out).status, node(STATUS, join(dir, "missing.html"), "show").status], [1, 2, 1]);
    writeFileSync(join(dir, "old.html"), "<html><body>old page</body></html>");
    assert.match(node(STATUS, join(dir, "old.html"), "show").stderr, /not a page written by migrate\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
