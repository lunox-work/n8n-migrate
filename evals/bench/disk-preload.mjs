// Preloaded with NODE_OPTIONS=--import into the claude driver's runner processes when the
// definition has disk steps (PROPOSALS P44). The task driver answers a `file` request from the
// real disk (runtime/src/driver.mjs executeFile); in the bench it must never reach it. A
// relative path already lands in the session's copy of the folder (a scratch directory under
// .work); an absolute one is redirected here: every path inside an absolute `allow.files`
// entry (N8M_BENCH_DISK_DIRS, a JSON list) is moved under N8M_BENCH_DISK_ROOT (/tmp/x.xlsx ->
// <root>/tmp/x.xlsx), where the bench put the fixture's `file` sources first. Only the fs
// calls executeFile makes are wrapped; node:fs's ESM bindings are refreshed with
// syncBuiltinESMExports() so driver.mjs, loaded after this module, sees the wrapped ones.

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.N8M_BENCH_DISK_ROOT;
let dirs = [];
try {
  dirs = JSON.parse(process.env.N8M_BENCH_DISK_DIRS || "[]").filter((d) => typeof d === "string" && isAbsolute(d)).map((d) => normalize(d).replace(/\/+$/, "") || "/");
} catch {}

export function redirect(p, { base = root, within = dirs } = {}) {
  const s = p instanceof URL ? fileURLToPath(p) : p;
  if (typeof s !== "string" || !isAbsolute(s) || !base) return p;
  const n = normalize(s);
  if (n.startsWith(`${normalize(base)}/`)) return p;
  return within.some((d) => d !== "/" && (n === d || n.startsWith(`${d}/`))) ? join(base, n) : p;
}

if (root && dirs.length) {
  for (const name of ["readFileSync", "writeFileSync", "appendFileSync", "existsSync", "mkdirSync", "readdirSync", "statSync"]) {
    const orig = fs[name];
    fs[name] = function (p, ...rest) {
      return orig.call(this, redirect(p), ...rest);
    };
  }
  syncBuiltinESMExports();
}
