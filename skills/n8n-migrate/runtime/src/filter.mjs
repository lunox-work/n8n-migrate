// The "filter" parameter evaluator used by If v2, Filter v2 and Switch v3 (n8n 2.47).
//
// Mirrors n8n-workflow's node-parameters/filter-parameter.ts:
// - options default to {caseSensitive: true, typeValidation: "strict", version: 1} and are
//   read from the stored filter value (the editor writes them), combinator defaults "and".
// - Each side is parsed to the operator's type (rightType for array length and similar):
//   strict mode accepts only the exact JS type; loose mode converts ("1" -> 1, "true" ->
//   true, JSON text -> array/object); version >= 3 reads "" and [] as null for numbers.
//   A value that cannot be parsed fails with n8n's "Wrong type" / "Conversion error".
// - exists / notExists look only at the left value (not null, undefined or NaN).
// - Case-insensitive string comparisons lowercase both sides; from version 4 regex
//   conditions use the `i` flag instead of lowercasing the left side.

import { DateTime } from "../vendor/luxon.mjs";
import { RunnerError } from "./util.mjs";
import { tryToParseDateTime } from "./extensions.mjs";

export class FilterError extends RunnerError {}

const DEFAULT_OPTIONS = { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 1 };

const article = (noun) => ("aeiou".includes(noun.charAt(0)) ? "an" : "a") + " " + noun;
const valueDesc = (v) => (typeof v === "object" ? (v === null ? "'null'" : Array.isArray(v) ? "array" : "object") : `'${String(v)}'`);

function parseBoolean(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string" && ["true", "false"].includes(v.toLowerCase())) return v.toLowerCase() === "true";
  if (!(typeof v === "string" && v.trim() === "")) {
    const n = Number(v);
    if (n === 0) return false;
    if (n === 1) return true;
  }
  throw new Error("Failed to parse value as boolean");
}
function parseArray(v) {
  if (Array.isArray(v)) return v;
  let p;
  try {
    p = JSON.parse(String(v));
  } catch {
    p = JSON.parse(String(v).replace(/'/g, '"'));
  }
  if (!Array.isArray(p)) throw new Error("Value is not a valid array");
  return p;
}
function parseObject(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) return v;
  let o;
  try {
    o = JSON.parse(String(v));
  } catch {
    // n8n's jsonParse(acceptJSObject): unquoted keys and single quotes.
    o = JSON.parse(String(v).replace(/'/g, '"').replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":'));
  }
  if (typeof o !== "object" || o === null || Array.isArray(o)) throw new Error("Value is not a valid object");
  return o;
}

// n8n validateFieldType for the types filters use. Returns {valid, newValue}.
export function validateFieldType(value, type, { strict = false, parseStrings = false } = {}) {
  if (value === null || value === undefined) return { valid: true };
  try {
    switch (type.toLowerCase()) {
      case "string":
        if (!parseStrings) return { valid: true, newValue: value };
        if (strict && typeof value !== "string") return { valid: false };
        return { valid: true, newValue: typeof value === "object" ? JSON.stringify(value) : String(value) };
      case "number":
        if (strict && typeof value !== "number") return { valid: false };
        if (Number.isNaN(Number(value))) return { valid: false };
        return { valid: true, newValue: Number(value) };
      case "boolean":
        if (strict && typeof value !== "boolean") return { valid: false };
        return { valid: true, newValue: parseBoolean(value) };
      case "datetime":
        return { valid: true, newValue: tryToParseDateTime(value) };
      case "object":
        if (strict && (value === null || typeof value !== "object")) return { valid: false };
        return { valid: true, newValue: parseObject(value) };
      case "array":
        if (strict && !Array.isArray(value)) return { valid: false };
        return { valid: true, newValue: parseArray(value) };
      default:
        return { valid: true, newValue: value };
    }
  } catch {
    return { valid: false };
  }
}

function parseSingle(value, type, strict, version) {
  if (type === "any" || value === null || value === undefined) return { valid: true, newValue: value };
  if (type === "boolean" && !strict) {
    if (version >= 2) {
      const r = validateFieldType(value, type);
      if (r.valid) return r;
    }
    return { valid: true, newValue: Boolean(value) };
  }
  if (type === "number") {
    if (Number.isNaN(value)) return { valid: true, newValue: value };
    const emptyStr = typeof value === "string" && value.trim() === "";
    const emptyArr = Array.isArray(value) && value.length === 0;
    if ((emptyStr || emptyArr) && version >= 3) return { valid: true, newValue: null };
  }
  return validateFieldType(value, type, { strict, parseStrings: true });
}

function parseValues(condition, options, index, itemIndex) {
  const strict = options.typeValidation === "strict";
  const version = options.version ?? 1;
  const op = condition.operator ?? {};
  const rightType = op.rightType ?? op.type;
  const L = parseSingle(condition.leftValue, op.type, strict, version);
  const R = parseSingle(condition.rightValue, rightType, strict, version);
  const rightValid = R.valid || !!op.singleValue;
  const suffix = `[condition ${index}, item ${itemIndex}]`;
  const msg = (type, from, value) =>
    strict ? `Wrong type: '${value}' is ${article(from.toLocaleLowerCase())} but was expecting ${article(type)} ${suffix}` : `Conversion error: the ${from.toLocaleLowerCase()} '${value}' can't be converted to ${article(type)} ${suffix}`;
  if (!L.valid && !rightValid && typeof condition.leftValue === typeof condition.rightValue) {
    throw new FilterError(`Comparison type expects ${article(op.type)} but both fields are ${article(typeof condition.leftValue)}`);
  }
  if (!L.valid) throw new FilterError(msg(op.type, typeof condition.leftValue, String(condition.leftValue)));
  if (!rightValid) throw new FilterError(msg(rightType, typeof condition.rightValue, String(condition.rightValue)));
  return { left: L.valid ? L.newValue : undefined, right: R.valid ? R.newValue : undefined };
}

function parseRegexLiteral(value, ignoreCase) {
  const m = /^\/(.*?)\/([gimusy]*)$/.exec(String(value));
  if (!m) return { source: String(value), flags: ignoreCase ? "i" : "" };
  let flags = m[2] ?? "";
  if (ignoreCase && !flags.includes("i")) flags += "i";
  return { source: m[1] ?? "", flags };
}

function arrayContains(arr, value, ignoreCase) {
  if (ignoreCase && typeof value === "string") return arr.some((x) => typeof x === "string" && x.toLocaleLowerCase() === value.toLocaleLowerCase());
  return arr.includes(value);
}

export function executeFilterCondition(condition, options, { index = 0, itemIndex = 0 } = {}) {
  const ignoreCase = !options.caseSensitive;
  const op = condition.operator ?? {};
  const isRegex = op.operation === "regex" || op.operation === "notRegex";
  const regexIgnoreCase = ignoreCase && (options.version ?? 1) >= 4 && isRegex;
  const { left: leftValue, right: rightValue } = parseValues(condition, options, index, itemIndex);
  const exists = leftValue !== undefined && leftValue !== null && !Number.isNaN(leftValue);
  if (op.operation === "exists") return exists;
  if (op.operation === "notExists") return !exists;
  switch (op.type) {
    case "string": {
      let l = leftValue;
      let r = rightValue;
      if (ignoreCase) {
        if (typeof l === "string" && !regexIgnoreCase) l = l.toLocaleLowerCase();
        if (typeof r === "string" && !isRegex) r = r.toLocaleLowerCase();
      }
      l = l ?? "";
      r = r ?? "";
      switch (op.operation) {
        case "empty": return l.length === 0;
        case "notEmpty": return l.length !== 0;
        case "equals": return l === r;
        case "notEquals": return l !== r;
        case "contains": return l.includes(r);
        case "notContains": return !l.includes(r);
        case "startsWith": return l.startsWith(r);
        case "notStartsWith": return !l.startsWith(r);
        case "endsWith": return l.endsWith(r);
        case "notEndsWith": return !l.endsWith(r);
        case "regex":
        case "notRegex": {
          const { source, flags } = parseRegexLiteral(r, regexIgnoreCase);
          const hit = new RegExp(source, flags.replace("g", "")).test(l);
          return op.operation === "regex" ? hit : !hit;
        }
      }
      break;
    }
    case "number":
      switch (op.operation) {
        case "empty": return !exists;
        case "notEmpty": return exists;
        case "equals": return leftValue === rightValue;
        case "notEquals": return leftValue !== rightValue;
        case "gt": return leftValue > rightValue;
        case "lt": return leftValue < rightValue;
        case "gte": return leftValue >= rightValue;
        case "lte": return leftValue <= rightValue;
      }
      break;
    case "dateTime": {
      if (op.operation === "empty") return !exists;
      if (op.operation === "notEmpty") return exists;
      if (!leftValue || !rightValue) return false;
      const a = DateTime.isDateTime(leftValue) ? leftValue.toMillis() : NaN;
      const b = DateTime.isDateTime(rightValue) ? rightValue.toMillis() : NaN;
      switch (op.operation) {
        case "equals": return a === b;
        case "notEquals": return a !== b;
        case "after": return a > b;
        case "before": return a < b;
        case "afterOrEquals": return a >= b;
        case "beforeOrEquals": return a <= b;
      }
      break;
    }
    case "boolean":
      switch (op.operation) {
        case "empty": return !exists;
        case "notEmpty": return exists;
        case "true": return leftValue;
        case "false": return !leftValue;
        case "equals": return leftValue === rightValue;
        case "notEquals": return leftValue !== rightValue;
      }
      break;
    case "array": {
      const l = leftValue ?? [];
      switch (op.operation) {
        case "contains": return arrayContains(l, rightValue, ignoreCase);
        case "notContains": return !arrayContains(l, rightValue, ignoreCase);
        case "lengthEquals": return l.length === rightValue;
        case "lengthNotEquals": return l.length !== rightValue;
        case "lengthGt": return l.length > rightValue;
        case "lengthLt": return l.length < rightValue;
        case "lengthGte": return l.length >= rightValue;
        case "lengthLte": return l.length <= rightValue;
        case "empty": return l.length === 0;
        case "notEmpty": return l.length !== 0;
      }
      break;
    }
    case "object":
      switch (op.operation) {
        case "empty": return !leftValue || Object.keys(leftValue).length === 0;
        case "notEmpty": return !!leftValue && Object.keys(leftValue).length !== 0;
      }
      break;
  }
  // n8n logs a warning and returns false for an unknown operator.
  return false;
}

// value: the resolved filter parameter {conditions, combinator, options}.
export function executeFilter(value, { itemIndex = 0 } = {}) {
  const options = { ...DEFAULT_OPTIONS, ...(value?.options ?? {}) };
  const conditions = value?.conditions ?? [];
  const combinator = value?.combinator ?? "and";
  const pass = (c, index) => executeFilterCondition(c, options, { index, itemIndex });
  if (combinator === "and") return conditions.every(pass);
  if (combinator === "or") return conditions.some(pass);
  return false;
}
