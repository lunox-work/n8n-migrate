#!/usr/bin/env node
// PLAN Phase 6, "no template-specific rules": fails when a file under skills/ names a bench
// template. A rule keyed on one template would raise the pass rate without moving the skill.
//
//   node scripts/lint-no-template-rules.mjs [--verbose] [--dir <folder>]   (--dir: scan another folder, for tests)
//
// Checked in every file under skills/ (text files only):
//   - template ids: every id in evals/bench/corpus.json, as a whole number not part of a longer
//     number, version or identifier (not in vendored or built code: runtime/vendor holds
//     luxon, runtime/dist is built from runtime/src and vendor, and src is checked); an id that
//     is an HTTP status code is not a hit on a line that also carries that code's reason phrase
//     (node:http STATUS_CODES, case-insensitive: a status table, not a template rule);
//   - third-party libraries vendored unmodified under runtime/vendor/<lib>/ (their SHA-256 as
//     the folder's SOURCE.txt records it) are skipped for ids and fixture strings;
//   - template names: the `name` of each corpus template in evals/bench/data/wf (git-ignored;
//     skipped with a note on a fresh clone), case-insensitive, names of 12+ characters;
//   - fixture strings: string values of 12+ characters in evals/bench/fixtures that look
//     invented (contain a space, an @, or both letters and digits), are not URLs or paths, and
//     are not n8n's or a connector's own vocabulary (strings that also occur in the generated
//     node catalogue references/nodes.json or the captured connector schemas).
// Exit 1 with file:line and the match on any hit.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = join(ROOT, "skills");
const dirArg = process.argv.includes("--dir") ? resolve(process.argv[process.argv.indexOf("--dir") + 1]) : null;
const SCAN = dirArg ?? SKILLS;
const BENCH = join(ROOT, "evals", "bench");
const MIN = 12;
const verbose = process.argv.includes("--verbose");

const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const TEXT = /\.(mjs|js|json|md|html|txt|ya?ml|css)$/i;
const files = walk(SCAN).filter((f) => TEXT.test(f));
const content = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const read = (f) => content.get(f) ?? (existsSync(f) ? readFileSync(f, "utf8") : "");

// Vendor vocabulary: generated or captured files, not written by the loop.
const VENDOR = [join(SKILLS, "n8n-to-claude", "references", "nodes.json"), ...walk(join(SKILLS, "n8n-to-claude", "references", "connectors"))];
const NO_ID_CHECK = [join(SKILLS, "n8n-to-claude", "runtime", "vendor"), join(SKILLS, "n8n-to-claude", "runtime", "dist")];
const vendorText = VENDOR.map(read).join("\n");
// Third-party libraries vendored unmodified (runtime/vendor/<lib>/, files.mjs): a file counts
// as one only when its SHA-256 is the one its folder's SOURCE.txt records ("sha256 <file>
// <hex>"), so nothing the loop writes can hide there. They are skipped for ids and fixture
// strings (SheetJS carries MIME header lines that also occur in fixtures); names stay checked.
const THIRD_PARTY = new Set();
const VENDOR_DIR = join(SKILLS, "n8n-to-claude", "runtime", "vendor");
if (existsSync(VENDOR_DIR))
  for (const d of readdirSync(VENDOR_DIR).filter((x) => statSync(join(VENDOR_DIR, x)).isDirectory())) {
    const src = join(VENDOR_DIR, d, "SOURCE.txt");
    if (!existsSync(src)) continue;
    for (const m of readFileSync(src, "utf8").matchAll(/^sha256\s+(\S+)\s+([0-9a-f]{64})\s*$/gm)) {
      const f = join(VENDOR_DIR, d, m[1]);
      if (existsSync(f) && createHash("sha256").update(readFileSync(f)).digest("hex") === m[2]) THIRD_PARTY.add(f);
    }
  }

const corpus = JSON.parse(readFileSync(join(BENCH, "corpus.json"), "utf8"));
const ids = [...new Set(corpus.templates.map((t) => String(t.id)))];

const names = [];
let namesMissing = 0;
for (const id of ids) {
  const p = join(BENCH, "data", "wf", `${id}.json`);
  if (!existsSync(p)) {
    namesMissing++;
    continue;
  }
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    const name = String(j.name ?? j.workflow?.name ?? "").trim();
    if (name.length >= MIN) names.push({ id, name });
  } catch {}
}

const fixtureStrings = new Set();
const FIXTURES = join(BENCH, "fixtures");
const SKIP_KEYS = new Set(["sha256", "now", "schemaVersion", "variant", "template"]);
const collect = (v, key) => {
  if (typeof v === "string") {
    const s = v.trim();
    if (s.length < MIN || SKIP_KEYS.has(key)) return;
    if (/^(https?:)?\/\//i.test(s) || /^\/[\w./{}:-]*$/.test(s)) return; // URLs and paths are the API's
    if (!(/\s/.test(s) || s.includes("@") || (/[a-z]/i.test(s) && /\d/.test(s)))) return;
    if (vendorText.includes(s)) return;
    fixtureStrings.add(s);
  } else if (Array.isArray(v)) v.forEach((x) => collect(x, key));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) collect(x, k);
};
if (existsSync(FIXTURES)) for (const f of walk(FIXTURES).filter((f) => f.endsWith(".json"))) collect(JSON.parse(readFileSync(f, "utf8")), null);

const hits = [];
const lineOf = (text, idx) => text.slice(0, idx).split("\n").length;
const idRe = new RegExp(`(?<![\\w.\\-])(${ids.join("|")})(?![\\w.\\-])`, "g");
for (const [file, text] of content) {
  const rel = relative(ROOT, file);
  const vendor = VENDOR.includes(file) || THIRD_PARTY.has(file);
  // Ids: vendor files are generated from n8n or captured from connectors, never by the loop,
  // and carry many unrelated numbers; skip them for ids only.
  if (!vendor && !NO_ID_CHECK.some((d) => file.startsWith(d + "/")))
    for (const m of text.matchAll(idRe)) {
      const line = text.split("\n")[lineOf(text, m.index) - 1].toLowerCase();
      if (STATUS_CODES[m[1]] && line.includes(STATUS_CODES[m[1]].toLowerCase())) continue;
      hits.push(`${rel}:${lineOf(text, m.index)}: template id ${m[1]}`);
    }
  const lower = text.toLowerCase();
  for (const { id, name } of names) {
    const i = lower.indexOf(name.toLowerCase());
    if (i >= 0) hits.push(`${rel}:${lineOf(text, i)}: name of template ${id} ("${name}")`);
  }
  if (!vendor)
    for (const s of fixtureStrings) {
      const i = text.indexOf(s);
      if (i >= 0) hits.push(`${rel}:${lineOf(text, i)}: fixture string "${s.length > 80 ? s.slice(0, 77) + "..." : s}"`);
    }
}

if (verbose || namesMissing) console.error(`lint-no-template-rules: ${files.length} files, ${ids.length} ids, ${names.length} names${namesMissing ? ` (${namesMissing} template files missing: names not checked for them)` : ""}, ${fixtureStrings.size} fixture strings`);
if (hits.length) {
  console.error(`lint-no-template-rules: ${hits.length} hit(s)`);
  for (const h of hits) console.error("  " + h);
  process.exit(1);
}
console.log("lint-no-template-rules: ok");
