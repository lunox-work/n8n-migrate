// A compact JMESPath (https://jmespath.org/specification.html) for n8n's $jmespath().
// Written from the specification: identifiers, sub-expressions, index/slice, list and
// object projections, flatten, filters, multiselect, pipes, literals, `@`, `&expr` and
// the common built-in functions. Anything else raises UnsupportedExpression.

import { UnsupportedExpression, ExpressionError, isEqual } from "./util.mjs";

function lex(q) {
  const toks = [];
  let i = 0;
  while (i < q.length) {
    const c = q[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[A-Za-z_]/.test(c)) { let j = i; while (j < q.length && /\w/.test(q[j])) j++; toks.push({ t: "id", v: q.slice(i, j) }); i = j; continue; }
    if (/[-\d]/.test(c) && /\d/.test(q[i + 1] ?? c)) { let j = i + 1; while (j < q.length && /\d/.test(q[j])) j++; toks.push({ t: "num", v: Number(q.slice(i, j)) }); i = j; continue; }
    if (c === '"') { let j = i + 1; while (j < q.length && q[j] !== '"') { if (q[j] === "\\") j++; j++; } toks.push({ t: "id", v: JSON.parse(q.slice(i, j + 1)) }); i = j + 1; continue; }
    if (c === "'") { let j = i + 1; let s = ""; while (j < q.length && q[j] !== "'") { if (q[j] === "\\" && q[j + 1] === "'") { s += "'"; j += 2; continue; } s += q[j++]; } toks.push({ t: "lit", v: s }); i = j + 1; continue; }
    if (c === "`") { let j = i + 1; let s = ""; while (j < q.length && q[j] !== "`") { if (q[j] === "\\" && q[j + 1] === "`") { s += "`"; j += 2; continue; } s += q[j++]; } let v; try { v = JSON.parse(s); } catch { v = JSON.parse(JSON.stringify(s.trim())); } toks.push({ t: "lit", v }); i = j + 1; continue; }
    const two = q.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||", "[]", "[?"].includes(two)) { toks.push({ t: two }); i += 2; continue; }
    if ("[]{}().,:|*@&!<>".includes(c)) { toks.push({ t: c }); i++; continue; }
    throw new UnsupportedExpression(`$jmespath: unexpected character "${c}"`, { function: "$jmespath" });
  }
  toks.push({ t: "eof" });
  return toks;
}

const BP = { eof: 0, ":": 0, ",": 0, "]": 0, "}": 0, ")": 0, "|": 1, "||": 2, "&&": 3, "==": 5, "!=": 5, "<": 5, "<=": 5, ">": 5, ">=": 5, "[]": 9, ".": 40, "*": 20, "[": 55, "[?": 55, "!": 45, "{": 50, "(": 60 };

function parse(q) {
  const toks = lex(q);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = (t) => {
    if (toks[p].t !== t) throw new ExpressionError(`$jmespath: expected ${t} in "${q}"`);
    return toks[p++];
  };
  function expr(rbp = 0) {
    let left = nud(next());
    while (rbp < (BP[peek().t] ?? 0)) left = led(next(), left);
    return left;
  }
  function projRhs(bp) {
    const t = peek().t;
    if ((BP[t] ?? 0) < 10) return { k: "cur" };
    let left = { k: "cur" };
    if (t === ".") { next(); left = dotRhs(bp); }
    else if (t !== "[" && t !== "[?" && t !== "[]") throw new ExpressionError(`$jmespath: unexpected token after projection in "${q}"`);
    while (bp < (BP[peek().t] ?? 0)) left = led(next(), left);
    return left;
  }
  function dotRhs(bp) {
    const t = peek().t;
    if (t === "id") return { k: "field", name: next().v };
    if (t === "[") { next(); return multiList(); }
    if (t === "{") { next(); return multiHash(); }
    if (t === "*") { next(); return { k: "objproj", left: { k: "cur" }, right: projRhs(BP["*"]) }; }
    return expr(bp);
  }
  function multiList() {
    const items = [expr()];
    while (peek().t === ",") { next(); items.push(expr()); }
    expect("]");
    return { k: "mlist", items };
  }
  function multiHash() {
    const pairs = [];
    do {
      if (pairs.length) next();
      const key = next().v;
      expect(":");
      pairs.push([key, expr()]);
    } while (peek().t === ",");
    expect("}");
    return { k: "mhash", pairs };
  }
  function bracket(left) {
    const t = peek();
    if (t.t === "num" || t.t === ":") {
      const parts = [null, null, null];
      let idx = 0;
      while (peek().t !== "]") {
        if (peek().t === ":") { next(); idx++; continue; }
        parts[idx] = next().v;
      }
      next();
      if (idx === 0) return { k: "index", left, index: parts[0] };
      return { k: "proj", left: { k: "slice", left, parts }, right: projRhs(BP["*"]) };
    }
    if (t.t === "*") { next(); expect("]"); return { k: "proj", left, right: projRhs(BP["*"]) }; }
    throw new UnsupportedExpression(`$jmespath: unsupported bracket expression in "${q}"`, { function: "$jmespath" });
  }
  function nud(t) {
    switch (t.t) {
      case "id":
        if (peek().t === "(") { next(); const args = []; while (peek().t !== ")") { if (args.length) expect(","); args.push(peek().t === "&" ? (next(), { k: "ref", e: expr() }) : expr()); } next(); return { k: "fn", name: t.v, args }; }
        return { k: "field", name: t.v };
      case "lit": return { k: "lit", v: t.v };
      case "@": return { k: "cur" };
      case "*": return { k: "objproj", left: { k: "cur" }, right: projRhs(BP["*"]) };
      case "[]": return { k: "proj", left: { k: "flat", left: { k: "cur" } }, right: projRhs(BP["[]"]) };
      case "[": return peek().t === "num" || peek().t === "*" || peek().t === ":" ? bracket({ k: "cur" }) : multiList();
      case "[?": { const cond = expr(); expect("]"); return { k: "proj", left: { k: "filter", left: { k: "cur" }, cond }, right: projRhs(BP["[?"]) }; }
      case "{": return multiHash();
      case "(": { const e = expr(); expect(")"); return e; }
      case "!": return { k: "not", e: expr(BP["!"]) };
      case "&": return { k: "ref", e: expr() };
    }
    throw new ExpressionError(`$jmespath: unexpected token ${t.t} in "${q}"`);
  }
  function led(t, left) {
    switch (t.t) {
      case ".": return { k: "sub", left, right: dotRhs(BP["."]) };
      case "|": return { k: "pipe", left, right: expr(BP["|"]) };
      case "||": return { k: "or", left, right: expr(BP["||"]) };
      case "&&": return { k: "and", left, right: expr(BP["&&"]) };
      case "==": case "!=": case "<": case "<=": case ">": case ">=": return { k: "cmp", op: t.t, left, right: expr(BP[t.t]) };
      case "[]": return { k: "proj", left: { k: "flat", left }, right: projRhs(BP["[]"]) };
      case "[": return bracket(left);
      case "[?": { const cond = expr(); expect("]"); return { k: "proj", left: { k: "filter", left, cond }, right: projRhs(BP["[?"]) }; }
    }
    throw new ExpressionError(`$jmespath: unexpected token ${t.t} in "${q}"`);
  }
  const ast = expr();
  if (peek().t !== "eof") throw new ExpressionError(`$jmespath: unexpected token ${peek().t} in "${q}"`);
  return ast;
}

const truthy = (v) => !(v === null || v === false || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0));
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const type = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? "object" : typeof v);

const FUNCS = {
  length: (v) => (typeof v === "string" || Array.isArray(v) ? v.length : Object.keys(v).length),
  keys: (v) => Object.keys(v),
  values: (v) => Object.values(v),
  sort: (v) => [...v].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  reverse: (v) => (typeof v === "string" ? [...v].reverse().join("") : [...v].reverse()),
  join: (sep, v) => v.join(sep),
  contains: (s, x) => (typeof s === "string" ? s.includes(x) : s.some((y) => isEqual(y, x))),
  starts_with: (s, x) => s.startsWith(x),
  ends_with: (s, x) => s.endsWith(x),
  to_string: (v) => (typeof v === "string" ? v : JSON.stringify(v)),
  to_number: (v) => { const n = typeof v === "number" ? v : Number(v); return Number.isNaN(n) || typeof v === "boolean" || v === null ? null : n; },
  to_array: (v) => (Array.isArray(v) ? v : [v]),
  max: (v) => (v.length ? v.reduce((a, b) => (b > a ? b : a)) : null),
  min: (v) => (v.length ? v.reduce((a, b) => (b < a ? b : a)) : null),
  sum: (v) => v.reduce((a, b) => a + b, 0),
  avg: (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null),
  abs: Math.abs,
  ceil: Math.ceil,
  floor: Math.floor,
  type,
  not_null: (...a) => a.find((x) => x !== null) ?? null,
  merge: (...a) => Object.assign({}, ...a),
};

function evaluate(n, v) {
  switch (n.k) {
    case "cur": return v;
    case "lit": return n.v;
    case "field": return isObj(v) ? (v[n.name] ?? null) : null;
    case "sub": { const l = evaluate(n.left, v); return l === null ? null : evaluate(n.right, l); }
    case "pipe": return evaluate(n.right, evaluate(n.left, v));
    case "index": { const l = evaluate(n.left, v); if (!Array.isArray(l)) return null; const i = n.index < 0 ? l.length + n.index : n.index; return l[i] ?? null; }
    case "slice": {
      const l = evaluate(n.left, v);
      if (!Array.isArray(l)) return null;
      const [s, e, st = 1] = n.parts;
      const step = st ?? 1;
      const len = l.length;
      const norm = (x, d) => (x === null ? d : x < 0 ? Math.max(len + x, step < 0 ? -1 : 0) : Math.min(x, step < 0 ? len - 1 : len));
      const start = norm(s, step < 0 ? len - 1 : 0);
      const end = norm(e, step < 0 ? -1 : len);
      const out = [];
      for (let i = start; step > 0 ? i < end : i > end; i += step) out.push(l[i]);
      return out;
    }
    case "flat": { const l = evaluate(n.left, v); if (!Array.isArray(l)) return null; return l.flatMap((x) => (Array.isArray(x) ? x : [x])); }
    case "filter": { const l = evaluate(n.left, v); if (!Array.isArray(l)) return null; return l.filter((x) => truthy(evaluate(n.cond, x))); }
    case "proj": { const l = evaluate(n.left, v); if (!Array.isArray(l)) return null; return l.map((x) => evaluate(n.right, x)).filter((x) => x !== null); }
    case "objproj": { const l = evaluate(n.left, v); if (!isObj(l)) return null; return Object.values(l).map((x) => evaluate(n.right, x)).filter((x) => x !== null); }
    case "mlist": return v === null ? null : n.items.map((e) => evaluate(e, v));
    case "mhash": return v === null ? null : Object.fromEntries(n.pairs.map(([k, e]) => [k, evaluate(e, v)]));
    case "or": { const l = evaluate(n.left, v); return truthy(l) ? l : evaluate(n.right, v); }
    case "and": { const l = evaluate(n.left, v); return truthy(l) ? evaluate(n.right, v) : l; }
    case "not": return !truthy(evaluate(n.e, v));
    case "cmp": {
      const a = evaluate(n.left, v);
      const b = evaluate(n.right, v);
      if (n.op === "==") return isEqual(a, b);
      if (n.op === "!=") return !isEqual(a, b);
      if (typeof a !== "number" || typeof b !== "number") return null;
      return n.op === "<" ? a < b : n.op === "<=" ? a <= b : n.op === ">" ? a > b : a >= b;
    }
    case "ref": return { __ref: n.e };
    case "fn": {
      const args = n.args.map((a) => (a.k === "ref" ? a : evaluate(a, v)));
      if (n.name === "map") return evaluate(n.args[1], v)?.map((x) => evaluate(args[0].e, x)) ?? null;
      if (["sort_by", "max_by", "min_by"].includes(n.name)) {
        const arr = args[0];
        const key = (x) => evaluate(args[1].e, x);
        if (n.name === "sort_by") return [...arr].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
        if (!arr.length) return null;
        return arr.reduce((best, x) => ((n.name === "max_by" ? key(x) > key(best) : key(x) < key(best)) ? x : best));
      }
      const f = FUNCS[n.name];
      if (!f) throw new UnsupportedExpression(`$jmespath: function ${n.name}() is not supported`, { function: "$jmespath" });
      return f(...args);
    }
  }
  throw new UnsupportedExpression(`$jmespath: unsupported node ${n.k}`, { function: "$jmespath" });
}

const CACHE = new Map();
export function jmespathSearch(data, query) {
  let ast = CACHE.get(query);
  if (!ast) {
    ast = parse(query);
    CACHE.set(query, ast);
  }
  return evaluate(ast, JSON.parse(JSON.stringify(data ?? null)));
}
