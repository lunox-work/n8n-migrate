// N8M_STORE=file must keep a git-store folder's records local, even inside a checkout with a remote.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createStore } from "../skills/n8n-to-claude/runtime/src/store.mjs";

test("N8M_STORE=file overrides a git store: no fetch, no push, records in .n8m/records", () => {
  const base = mkdtempSync(join(tmpdir(), "n8m-store-"));
  const prev = process.env.N8M_STORE;
  try {
    const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git(base, "init", "--quiet", "--bare", "origin.git");
    git(base, "init", "--quiet", "work");
    const work = join(base, "work");
    git(work, "remote", "add", "origin", join(base, "origin.git"));
    const dir = join(work, "flow");
    mkdirSync(dir, { recursive: true });
    const P = { dir, n8m: join(dir, ".n8m") };
    process.env.N8M_STORE = "file";
    const store = createStore(P, { store: { kind: "git" } });
    assert.match(store.fellBack, /N8M_STORE=file/);
    store.set("cursors/trigger", { at: 1 });
    assert.ok(existsSync(join(dir, ".n8m", "records", "cursors", "trigger.json")));
    assert.equal(git(join(base, "origin.git"), "for-each-ref").trim(), "", "nothing reached the remote");
  } finally {
    if (prev === undefined) delete process.env.N8M_STORE;
    else process.env.N8M_STORE = prev;
    rmSync(base, { recursive: true, force: true });
  }
});
