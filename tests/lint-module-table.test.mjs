// PROPOSALS P122: ids inside a runtime/src module table are skipped only where the module body is
// byte for byte the published file its SOURCE.txt hashes; a changed body is checked again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LINT = join(ROOT, "scripts", "lint-no-template-rules.mjs");

test("P122: a verified third-party module body is skipped for ids; a changed one and the code around it are not", () => {
  const id = JSON.parse(readFileSync(join(ROOT, "evals/bench/corpus.json"), "utf8")).templates.find((t) => String(t.id).length >= 3 && !t.topUp).id;
  const body = `var TABLE = { 'Alpha': ${id} };\nmodule.exports = TABLE;`;
  const table = (b) => `const M = {\n  "lib/table": function (module, exports, require) {\n${b}\n  },\n};\nconst after = ${id};\n`;
  const dir = mkdtempSync(join(tmpdir(), "n2c-lint-"));
  try {
    writeFileSync(join(dir, "lib.SOURCE.txt"), `sha256 lib/table ${createHash("sha256").update(body).digest("hex")} lib@1.0.0/table.js\n`);
    writeFileSync(join(dir, "lib.mjs"), table(body));
    let r = spawnSync(process.execPath, [LINT, "--dir", dir], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stderr, /lib\.mjs:3:/, "the verified body is skipped");
    assert.match(r.stderr, new RegExp(`lib\\.mjs:7: template id ${id}`), "code outside the table is checked");
    writeFileSync(join(dir, "lib.mjs"), table(body.replace("TABLE;", "TABLE; // changed")));
    r = spawnSync(process.execPath, [LINT, "--dir", dir], { encoding: "utf8" });
    assert.match(r.stderr, new RegExp(`lib\\.mjs:3: template id ${id}`), "a changed body is checked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
