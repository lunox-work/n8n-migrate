// Bench fixtures (evals/bench/fixtures) validate against fixture.schema.json and their
// cross-checks. Template cross-checks run only where evals/bench/data/ was downloaded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkFixture } from "../evals/bench/validate.mjs";

const BENCH = join(dirname(fileURLToPath(import.meta.url)), "..", "evals", "bench");
const VARIANTS = ["normal", "empty", "malformed", "hostile"];

test("every bench fixture validates, four variants per template", async () => {
  const ids = readdirSync(join(BENCH, "fixtures"));
  assert.ok(ids.length >= 50);
  for (const id of ids) {
    const tpl = join(BENCH, "data", "wf", `${id}.json`);
    const raw = existsSync(tpl) ? JSON.parse(readFileSync(tpl, "utf8")) : null;
    for (const v of VARIANTS) {
      const fx = JSON.parse(readFileSync(join(BENCH, "fixtures", id, `${v}.json`), "utf8"));
      assert.equal(fx.template, Number(id));
      assert.equal(fx.variant, v);
      const { errors } = await checkFixture(fx, raw);
      assert.deepEqual(errors, [], `${id}/${v}`);
    }
  }
});

test("the first thirty dev templates of splits.json have fixtures", () => {
  const splits = JSON.parse(readFileSync(join(BENCH, "splits.json"), "utf8"));
  for (const { id } of splits.dev.slice(0, 30)) assert.ok(existsSync(join(BENCH, "fixtures", String(id), "normal.json")), String(id));
});

// Held-out fixtures feed release points only (EXCLUSIONS.md); the first twenty in the seeded
// order exist so the first release point can run. Each pins the hash splits.json recorded.
test("the first twenty held-out templates of splits.json have fixtures pinned to their hash", () => {
  const splits = JSON.parse(readFileSync(join(BENCH, "splits.json"), "utf8"));
  for (const { id, sha256 } of splits.heldOut.slice(0, 20)) {
    for (const v of VARIANTS) {
      const p = join(BENCH, "fixtures", String(id), `${v}.json`);
      assert.ok(existsSync(p), `${id}/${v}`);
      assert.equal(JSON.parse(readFileSync(p, "utf8")).sha256, sha256, `${id}/${v}`);
    }
  }
});
