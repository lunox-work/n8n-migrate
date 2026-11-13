// Declarative result adapters, argument coercion and poll cursors.
//
// A converter-written definition never carries code strings for these: every shape change
// is JSON the runtime interprets here, so a reviewer can read what a step does to a tool's
// output and a fix to this file reaches every migrated workflow on regeneration.
//
// Result adapter (step.tool.result, step.http.result, trigger poll.result):
//   {
//     items: "threads[*].messages[*]",  path to the elements that become items; "" = the
//                                       whole output. [*] flattens a list, [n] indexes.
//     fields: { outName: spec },        spec: "path" (relative to the element), "$.path"
//                                       (from the root output), "^.path" (from the element's
//                                       parent in a [*] chain), {path, default}, {const: v},
//                                       {first: [spec, ...]} (first defined), {split: spec,
//                                       sep} (text to a list), {join: spec, sep} (list to text),
//                                       {headers: spec} (a list of {name, value} to an object).
//                                       outName may be a dot path ("payload.mimeType").
//     passthrough: true,                keep the element's own fields (default true); false
//                                       emits only the listed fields.
//     wrap: "value",                    key for an element that is not an object.
//     empty: "none" | "one",            what an output without elements gives: no items
//                                       (default) or one empty item.
//   }
// adaptResult(spec, output) -> [json, ...]. Tool hosts pass the tool's structured result
// (structuredContent, or JSON-parsed text content); a text result arrives as a string and is
// parsed as JSON when it is JSON, else kept as {text}.
//
// Coercion (step.tool.coerce): {field: "string" | "string[]" | "integer" | "number" |
// "boolean" | "json"}, applied after the n8n expressions in the args are evaluated, so a
// comma-separated n8n "To" field reaches a tool that wants a list of addresses as a list.
// Fields that evaluate to undefined are dropped.
//
// Poll cursor (trigger poll.cursor): {field, strategy: "max", idField?, arg?, template?}.
// Items whose field is greater than the cursor (or equal with an id not seen at that value)
// are new; the next cursor is the greatest field value seen and the ids at that value. The
// template puts the cursor into one tool argument: {value}, {seconds} (epoch seconds),
// {iso}. Missed runs collapse into one run that reads everything after the cursor, never
// "since the last interval" (PLAN Phase 4).

import { isObject, deepCopy } from "./util.mjs";

// ---------- paths ----------

function splitPath(path) {
  const segs = [];
  for (const part of String(path).split(".")) {
    if (part === "") continue;
    const re = /([^[\]]+)|\[(\*|\d+)\]/g;
    let m;
    while ((m = re.exec(part))) {
      if (m[1] !== undefined) segs.push({ key: m[1] });
      else if (m[2] === "*") segs.push({ all: true });
      else segs.push({ index: Number(m[2]) });
    }
  }
  return segs;
}

// Elements at a path, each with its parent chain: [{value, parents: [...]}].
function select(root, path) {
  let cur = [{ value: root, parents: [] }];
  for (const seg of splitPath(path)) {
    const next = [];
    for (const { value, parents } of cur) {
      if (seg.all) {
        if (Array.isArray(value)) for (const v of value) next.push({ value: v, parents: [...parents, value] });
        else if (value !== undefined && value !== null) next.push({ value, parents });
      } else if (seg.index !== undefined) {
        if (Array.isArray(value) && value[seg.index] !== undefined) next.push({ value: value[seg.index], parents });
      } else if (isObject(value) && value[seg.key] !== undefined) {
        // A step down into an object field keeps the object as the parent of what follows.
        next.push({ value: value[seg.key], parents: [...parents, value] });
      }
    }
    cur = next;
  }
  return cur;
}

export function getAt(root, path) {
  const hit = select(root, path);
  if (!hit.length) return undefined;
  return splitPath(path).some((s) => s.all) ? hit.map((h) => h.value) : hit[0].value;
}

function setAt(obj, path, value) {
  const keys = String(path).split(".");
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!isObject(o[keys[i]])) o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys.at(-1)] = value;
}

// ---------- adapter ----------

function fieldValue(spec, el, root) {
  if (typeof spec === "string") {
    if (spec.startsWith("$.")) return getAt(root, spec.slice(2));
    if (spec === "$") return root;
    if (spec.startsWith("^.")) {
      const parent = el.parents.findLast((p) => isObject(p));
      return parent === undefined ? undefined : getAt(parent, spec.slice(2));
    }
    if (spec === "" || spec === ".") return el.value;
    return isObject(el.value) || Array.isArray(el.value) ? getAt(el.value, spec) : undefined;
  }
  if (!isObject(spec)) return undefined;
  if ("const" in spec) return deepCopy(spec.const);
  if (spec.first) {
    for (const s of spec.first) {
      const v = fieldValue(s, el, root);
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return spec.default;
  }
  if (spec.split !== undefined) {
    const v = fieldValue(spec.split, el, root);
    return typeof v === "string" ? v.split(spec.sep ?? ",").map((x) => x.trim()).filter((x) => x !== "") : v;
  }
  if (spec.join !== undefined) {
    const v = fieldValue(spec.join, el, root);
    return Array.isArray(v) ? v.join(spec.sep ?? ", ") : v;
  }
  if (spec.headers !== undefined) {
    const v = fieldValue(spec.headers, el, root);
    return Array.isArray(v) ? Object.fromEntries(v.filter((h) => isObject(h) && typeof h.name === "string").map((h) => [h.name, h.value])) : v;
  }
  if (spec.path !== undefined) {
    const v = fieldValue(spec.path, el, root);
    return v === undefined ? spec.default : v;
  }
  return undefined;
}

export function parseToolOutput(output) {
  if (typeof output !== "string") return output;
  const t = output.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t);
    } catch {
      /* text */
    }
  }
  return { text: output };
}

export function adaptResult(spec, output) {
  const root = parseToolOutput(output);
  const s = spec ?? {};
  const wrap = s.wrap ?? "value";
  const els = s.items === undefined || s.items === "" ? (Array.isArray(root) ? root.map((v) => ({ value: v, parents: [root] })) : root === null || root === undefined ? [] : [{ value: root, parents: [] }]) : select(root, s.items);
  const out = [];
  for (const el of els) {
    const base = isObject(el.value) ? el.value : el.value === undefined || el.value === null ? {} : { [wrap]: el.value };
    const json = s.passthrough === false ? {} : deepCopy(base);
    for (const [name, fs] of Object.entries(s.fields ?? {})) {
      const v = fieldValue(fs, el, root);
      if (v !== undefined) setAt(json, name, deepCopy(v));
    }
    out.push(json);
  }
  if (!out.length && s.empty === "one") out.push({});
  return out;
}

// ---------- coercion ----------

export function coerceArgs(coerce, args) {
  if (!isObject(args)) return args;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    const want = coerce?.[k];
    out[k] = want ? coerceValue(want, v) : v;
  }
  return out;
}

function coerceValue(want, v) {
  switch (want) {
    case "string[]":
      if (Array.isArray(v)) return v.map((x) => String(x));
      if (typeof v === "string") return v.split(",").map((x) => x.trim()).filter((x) => x !== "");
      return v === null ? [] : [String(v)];
    case "integer":
    case "number": {
      if (typeof v === "number") return want === "integer" ? Math.trunc(v) : v;
      const n = Number(v);
      if (typeof v === "string" && v.trim() !== "" && Number.isFinite(n)) return want === "integer" ? Math.trunc(n) : n;
      return v;
    }
    case "boolean":
      if (v === "true") return true;
      if (v === "false") return false;
      return v;
    case "string":
      return v === null || typeof v === "object" ? JSON.stringify(v) : String(v);
    case "json":
      if (typeof v === "string") {
        try {
          return JSON.parse(v);
        } catch {
          return v;
        }
      }
      return v;
    default:
      return v;
  }
}

// ---------- poll cursor ----------

function comparable(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return v;
}
const cmp = (a, b) => {
  const x = comparable(a);
  const y = comparable(b);
  if (typeof x === "number" && typeof y === "number") return x - y;
  return String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0;
};

export function applyCursorArg(cursorSpec, args, cursor) {
  if (!cursorSpec?.arg || !cursor || cursor.value === undefined) return args;
  const ms = comparable(cursor.value);
  const values = { value: String(cursor.value), seconds: typeof ms === "number" ? String(Math.floor(ms / 1000)) : String(cursor.value), iso: typeof ms === "number" ? new Date(ms).toISOString() : String(cursor.value) };
  const piece = String(cursorSpec.template ?? "{value}").replace(/\{(value|seconds|iso)\}/g, (_, k) => values[k]);
  const prev = args[cursorSpec.arg];
  return { ...args, [cursorSpec.arg]: prev === undefined || prev === "" ? piece : `${prev}${cursorSpec.joiner ?? " "}${piece}` };
}

// -> {items: new items, cursor: next cursor}
export function advanceCursor(cursorSpec, items, cursor) {
  const field = cursorSpec.field;
  const idOf = (j) => (cursorSpec.idField ? getAt(j, cursorSpec.idField) : undefined);
  const fresh = items.filter((j) => {
    if (!cursor || cursor.value === undefined) return true;
    const v = getAt(j, field);
    if (v === undefined) return false;
    const c = cmp(v, cursor.value);
    if (c > 0) return true;
    if (c < 0) return false;
    const id = idOf(j);
    return id !== undefined && !(cursor.ids ?? []).includes(String(id));
  });
  let max = cursor?.value;
  for (const j of items) {
    const v = getAt(j, field);
    if (v !== undefined && (max === undefined || cmp(v, max) > 0)) max = v;
  }
  const next = { value: max };
  if (cursorSpec.idField && max !== undefined) {
    const ids = items.filter((j) => getAt(j, field) !== undefined && cmp(getAt(j, field), max) === 0).map((j) => String(idOf(j)));
    const carried = cursor && cursor.value !== undefined && cmp(cursor.value, max) === 0 ? cursor.ids ?? [] : [];
    next.ids = [...new Set([...carried, ...ids])].sort();
  }
  return { items: fresh, cursor: max === undefined ? cursor ?? null : next };
}
