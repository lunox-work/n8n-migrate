// Regression tests from the differential test against real n8n (evals/diff): each fixture in
// tests/fixtures/n8n-observed/ holds a small workflow, its pins and HTTP fixtures, and what
// n8n 2.47.7 did with it (run data, request log), observed on 2026-11-14. The runner must
// reproduce it: replayObserved reruns our side (no container) and compares the same way.
// A fixture may list `knownDifferences` (classes left on purpose, see evals/diff/REPORT.md).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { replayObserved } from "../evals/diff/differential.mjs";

const DIR = fileURLToPath(new URL("./fixtures/n8n-observed/", import.meta.url));

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json")).sort()) {
  const fixture = JSON.parse(readFileSync(join(DIR, file), "utf8"));
  test(`n8n 2.47.7 observed: ${file.replace(/\.json$/, "")}${fixture.title ? ` (${fixture.title})` : ""}`, async () => {
    assert.match(fixture.note, /observed from n8n 2\.47\.7 on 2026-11-14/);
    const work = mkdtempSync(join(tmpdir(), "n8n-observed-"));
    try {
      const rep = await replayObserved(fixture, { workDir: work });
      const expected = [...(fixture.knownDifferences ?? [])].sort();
      assert.deepEqual(rep.classes, expected, JSON.stringify(rep.diffs, null, 1).slice(0, 3000));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
}
