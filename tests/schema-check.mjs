// A small JSON Schema check for the subset report.schema.json uses: type,
// enum, const, pattern, required, properties, additionalProperties, items, $ref.
// Shared by the test files; not a test itself.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const schema = JSON.parse(readFileSync(join(ROOT, "skills/n8n-to-claude/references/report.schema.json"), "utf8"));

// root: the schema $refs resolve against (default: s itself when it has an $id, else the
// report schema).
export function validate(v, s, path = "$", root = s.$id ? s : schema) {
  if (s.$ref) return validate(v, s.$ref.split("/").slice(1).reduce((o, k) => o[k], root), path, root);
  const errs = [];
  const typeOf = (x) => (x === null ? "null" : Array.isArray(x) ? "array" : Number.isInteger(x) ? "integer" : typeof x);
  if (s.type) {
    const types = [].concat(s.type);
    const t = typeOf(v);
    if (!types.includes(t) && !(t === "integer" && types.includes("number"))) return [`${path}: ${t} is not ${types.join("|")}`];
  }
  if ("const" in s && v !== s.const) errs.push(`${path}: not ${s.const}`);
  if (s.enum && !s.enum.includes(v)) errs.push(`${path}: ${JSON.stringify(v)} not in enum`);
  if (s.pattern && typeof v === "string" && !new RegExp(s.pattern, "u").test(v)) errs.push(`${path}: ${v} does not match ${s.pattern}`);
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const k of s.required || []) if (!(k in v)) errs.push(`${path}: missing ${k}`);
    for (const [k, x] of Object.entries(v)) {
      if (s.properties?.[k]) errs.push(...validate(x, s.properties[k], `${path}.${k}`, root));
      else if (s.additionalProperties === false) errs.push(`${path}: unexpected ${k}`);
      else if (s.additionalProperties && typeof s.additionalProperties === "object") errs.push(...validate(x, s.additionalProperties, `${path}.${k}`, root));
    }
  }
  if (Array.isArray(v) && s.items) v.forEach((x, i) => errs.push(...validate(x, s.items, `${path}[${i}]`, root)));
  return errs;
}
