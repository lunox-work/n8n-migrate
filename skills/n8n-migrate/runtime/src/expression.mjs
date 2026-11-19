// n8n expression evaluation: `={{ ... }}` templates evaluated natively.
//
// Mirrors n8n-workflow's Expression + @n8n/tournament (legacy engine, n8n 2.47):
// - A parameter is an expression when it is a string starting with "=". The rest is a
//   template of text and `{{ code }}` segments; `\{{` escapes an opening bracket.
// - Exactly one segment with no surrounding text returns the raw value (number, object,
//   DateTime...). Anything else is joined into a string: each segment's value v becomes
//   `v || v === 0 || v === false ? v : ""`, then Array.join (objects -> "[object Object]",
//   arrays -> "a,b").
// - Errors inside a segment are swallowed (the segment becomes undefined / "") unless they
//   are expression errors (ExpressionError, UnsupportedExpression), which n8n rethrows.
//   A syntax error is thrown as "invalid syntax".
// - `.name(...)` calls whose name is an n8n extension function are rewritten to
//   `__ext(obj, "name", [args])`, which dispatches on the runtime type of obj exactly like
//   n8n's `extend()`; `obj?.name(...)` uses `__extOpt`. `$if(a, b, c)` becomes `(a ? b : c)`.
//   n8n does this with an AST transform; here a small JS tokenizer finds the call sites.
// - Identifiers resolve against a scope object first (n8n's data proxy, plus the globals
//   n8n allows); an unknown identifier is `undefined`, never the host global.
//
// This is not a security sandbox (neither is n8n's legacy engine). Containment of effects
// is enforced where requests leave the core, not here.

import { ExpressionError, UnsupportedExpression, RunnerError } from "./util.mjs";
import { EXTENSION_NAMES } from "./extensions.mjs";

export const isExpression = (v) => typeof v === "string" && v.charAt(0) === "=";

// @n8n/tournament's splitExpression: [{type: "text"|"code", text, hasClosingBrackets}].
// `{{` preceded by an odd number of backslashes is literal; a text chunk that ends at a
// real `{{` has its `\\` pairs collapsed to `\`; `\}}` inside code is `}}`.
export function splitExpression(expression) {
  if (expression === "") return [{ type: "text", text: "" }];
  const chunks = [];
  let searching = "open";
  let buffer = "";
  let index = 0;
  while (index < expression.length) {
    const rest = expression.slice(index);
    const at = rest.indexOf(searching === "open" ? "{{" : "}}");
    if (at < 0) {
      buffer += rest;
      chunks.push(searching === "open" ? { type: "text", text: buffer } : { type: "code", text: buffer.replace(/\\\}\}/g, "}}"), hasClosingBrackets: false });
      break;
    }
    const before = rest.slice(0, at);
    const slashes = before.match(/\\*$/)[0].length;
    if (slashes % 2 === 1) {
      buffer += rest.slice(0, at + 2);
      index += at + 2;
      continue;
    }
    buffer += before;
    if (searching === "open") chunks.push({ type: "text", text: buffer.replace(/\\\\/g, "\\") });
    else chunks.push({ type: "code", text: buffer.replace(/\\\}\}/g, "}}"), hasClosingBrackets: true });
    searching = searching === "open" ? "close" : "open";
    index += at + 2;
    buffer = "";
  }
  return chunks;
}

// ---------- JS tokenizer (enough to find call sites) ----------

const KEYWORDS_BEFORE_EXPR = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "await", "yield", "extends"]);
const ID_START = /[A-Za-z_$ -￿]/;
const ID_PART = /[\w$ -￿]/;
const PUNCS = [">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=", "?.", "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>"];

// Returns tokens [{t: type, v: text, s: start, e: end, parts?}] for a code string.
// type: name | num | str | tpl | regex | punc. Template tokens carry `parts`: the raw
// text and the code of each ${...} substitution (rewritten recursively later).
export function tokenize(code) {
  const toks = [];
  let i = 0;
  const n = code.length;
  const regexAllowed = () => {
    const p = toks[toks.length - 1];
    if (!p) return true;
    if (p.t === "num" || p.t === "str" || p.t === "tpl" || p.t === "regex") return false;
    if (p.t === "name") return KEYWORDS_BEFORE_EXPR.has(p.v);
    return !(p.v === ")" || p.v === "]" || p.v === "}");
  };
  while (i < n) {
    const c = code[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && code[i + 1] === "/") { while (i < n && code[i] !== "\n") i++; continue; }
    if (c === "/" && code[i + 1] === "*") { const j = code.indexOf("*/", i + 2); i = j < 0 ? n : j + 2; continue; }
    const s = i;
    if (ID_START.test(c)) {
      while (i < n && ID_PART.test(code[i])) i++;
      toks.push({ t: "name", v: code.slice(s, i), s, e: i });
      continue;
    }
    if (/\d/.test(c) || (c === "." && /\d/.test(code[i + 1] ?? ""))) {
      i++;
      while (i < n && /[\w.]/.test(code[i])) {
        if (code[i] === "." && code.slice(s, i).includes(".")) break;
        i++;
      }
      toks.push({ t: "num", v: code.slice(s, i), s, e: i });
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < n && code[i] !== c) { if (code[i] === "\\") i++; i++; }
      i++;
      toks.push({ t: "str", v: code.slice(s, i), s, e: i });
      continue;
    }
    if (c === "`") {
      const parts = [];
      i++;
      let textStart = i;
      while (i < n && code[i] !== "`") {
        if (code[i] === "\\") { i += 2; continue; }
        if (code[i] === "$" && code[i + 1] === "{") {
          parts.push({ text: code.slice(textStart, i) });
          i += 2;
          let depth = 1;
          const cs = i;
          // Find the matching "}" while skipping nested strings/templates.
          while (i < n && depth > 0) {
            const ch = code[i];
            if (ch === "'" || ch === '"') { i++; while (i < n && code[i] !== ch) { if (code[i] === "\\") i++; i++; } i++; continue; }
            if (ch === "`") { const sub = tokenize(code.slice(i)); const t0 = sub[0]; i += t0 ? t0.e : n - i; continue; }
            if (ch === "{") depth++;
            else if (ch === "}") depth--;
            if (depth > 0) i++;
          }
          parts.push({ code: code.slice(cs, i) });
          i++;
          textStart = i;
          continue;
        }
        i++;
      }
      parts.push({ text: code.slice(textStart, i) });
      i++;
      toks.push({ t: "tpl", v: code.slice(s, i), s, e: i, parts });
      continue;
    }
    if (c === "/" && regexAllowed()) {
      i++;
      let inClass = false;
      while (i < n) {
        if (code[i] === "\\") { i += 2; continue; }
        if (code[i] === "[") inClass = true;
        else if (code[i] === "]") inClass = false;
        else if (code[i] === "/" && !inClass) break;
        else if (code[i] === "\n") break;
        i++;
      }
      i++;
      while (i < n && /[a-z]/i.test(code[i])) i++;
      toks.push({ t: "regex", v: code.slice(s, i), s, e: i });
      continue;
    }
    let p = PUNCS.find((x) => code.startsWith(x, i));
    if (p === "?." && /\d/.test(code[i + 2] ?? "")) p = undefined; // a ?.5 : b
    p = p ?? c;
    i += p.length;
    toks.push({ t: "punc", v: p, s, e: i });
  }
  return toks;
}

function matchBrackets(toks) {
  const match = new Array(toks.length).fill(-1);
  const stack = [];
  const pair = { ")": "(", "]": "[", "}": "{" };
  toks.forEach((t, i) => {
    if (t.t !== "punc") return;
    if (t.v === "(" || t.v === "[" || t.v === "{") stack.push(i);
    else if (pair[t.v]) {
      const j = stack.pop();
      if (j !== undefined) { match[i] = j; match[j] = i; }
    }
  });
  return match;
}

const LITERAL_NAMES = new Set(["this", "null", "true", "false", "undefined", "super"]);
const isValueEnd = (t) =>
  t && (t.t === "num" || t.t === "str" || t.t === "tpl" || t.t === "regex" || (t.t === "name" && (!KEYWORDS_BEFORE_EXPR.has(t.v) || LITERAL_NAMES.has(t.v))) || (t.t === "punc" && (t.v === ")" || t.v === "]")));

// Index of the first token of the member/call chain that ends at token `end`
// (`new X(...)` belongs to the chain: `new Date().format()` is a member of the new object).
function chainStart(toks, match, end) {
  const s = chainStartRaw(toks, match, end);
  return s > 0 && toks[s - 1].t === "name" && toks[s - 1].v === "new" ? s - 1 : s;
}
function chainStartRaw(toks, match, end) {
  let i = end;
  for (;;) {
    const t = toks[i];
    if (!t) return -1;
    if (t.t === "punc" && (t.v === ")" || t.v === "]")) {
      const open = match[i];
      if (open < 0) return -1;
      const prev = toks[open - 1];
      if (prev && prev.t === "punc" && prev.v === "?.") { i = open - 2; continue; }
      if (isValueEnd(prev) && !(prev.t === "name" && KEYWORDS_BEFORE_EXPR.has(prev.v))) { i = open - 1; continue; }
      return open;
    }
    if (t.t === "punc" && t.v === "}") return match[i];
    if (t.t === "name" || t.t === "num" || t.t === "str" || t.t === "tpl" || t.t === "regex") {
      if (t.t === "name" && KEYWORDS_BEFORE_EXPR.has(t.v)) return -1;
      const prev = toks[i - 1];
      if (prev && prev.t === "punc" && (prev.v === "." || prev.v === "?.")) { i -= 2; continue; }
      return i;
    }
    return -1;
  }
}

const EXT_SET = new Set(EXTENSION_NAMES);

// Rewrite extension calls and $if; returns the new code string.
export function rewriteExtensions(code) {
  if (!/\.\s*[A-Za-z_$]|\$if\s*\(/.test(code)) return code;
  const toks = tokenize(code);
  const match = matchBrackets(toks);
  const rewrites = [];
  for (let i = 0; i < toks.length - 2; i++) {
    const d = toks[i];
    if (d.t === "punc" && (d.v === "." || d.v === "?.") && toks[i + 1].t === "name" && EXT_SET.has(toks[i + 1].v) && toks[i + 2].v === "(" && toks[i + 2].t === "punc") {
      const start = chainStart(toks, match, i - 1);
      const close = match[i + 2];
      if (start < 0 || close < 0) continue;
      rewrites.push({ kind: "ext", start, dot: i, close, optional: d.v === "?.", name: toks[i + 1].v });
    } else if (d.t === "name" && d.v === "$if" && toks[i + 1].v === "(" && toks[i + 1].t === "punc" && !(toks[i - 1] && toks[i - 1].t === "punc" && (toks[i - 1].v === "." || toks[i - 1].v === "?."))) {
      const close = match[i + 1];
      if (close < 0) continue;
      rewrites.push({ kind: "if", start: i, open: i + 1, close });
    }
  }
  const hasTpl = toks.some((t) => t.t === "tpl" && t.parts.some((p) => p.code !== undefined));
  if (!rewrites.length && !hasTpl) return code;
  rewrites.sort((a, b) => a.start - b.start || b.close - a.close);

  // emit tokens [from, to] (inclusive) as text, applying rewrites contained in the range.
  const emit = (from, to, avoid) => {
    let out = "";
    let pos = toks[from] ? toks[from].s : 0;
    let i = from;
    while (i <= to) {
      const rw = rewrites.find((r) => r !== avoid && r.start === i && r.close <= to);
      if (rw) {
        out += code.slice(pos, toks[i].s) + emitRewrite(rw);
        i = rw.close + 1;
        pos = toks[rw.close].e;
        continue;
      }
      const t = toks[i];
      if (t.t === "tpl" && t.parts.some((p) => p.code !== undefined)) {
        out += code.slice(pos, t.s) + "`" + t.parts.map((p) => (p.code !== undefined ? "${" + rewriteExtensions(p.code) + "}" : p.text)).join("") + "`";
        pos = t.e;
      }
      i++;
    }
    return out + code.slice(pos, toks[to] ? toks[to].e : pos);
  };
  const splitArgs = (open, close) => {
    const args = [];
    let start = open + 1;
    for (let i = open + 1; i < close; i++) {
      const t = toks[i];
      if (t.t === "punc" && (t.v === "(" || t.v === "[" || t.v === "{")) { i = match[i]; continue; }
      if (t.t === "punc" && t.v === ",") { args.push([start, i - 1]); start = i + 1; }
    }
    if (start <= close - 1) args.push([start, close - 1]);
    return args;
  };
  const emitRewrite = (rw) => {
    if (rw.kind === "if") {
      const args = splitArgs(rw.open, rw.close);
      if (args.length < 2) throw new ExpressionError("$if requires at least 2 parameters: test, value_if_true[, and value_if_false]");
      const [a, b, c] = args.map(([s, e]) => emit(s, e));
      return `((${a}) ? (${b}) : (${c === undefined ? "false" : c}))`;
    }
    const obj = emit(rw.start, rw.dot - 1, rw);
    const args = rw.close - 1 >= rw.dot + 3 ? emit(rw.dot + 3, rw.close - 1) : "";
    return `${rw.optional ? "__extOpt" : "__ext"}(${obj}, ${JSON.stringify(rw.name)}, [${args}])`;
  };
  return emit(0, toks.length - 1);
}

// ---------- compilation ----------

const CACHE = new Map();
const CACHE_MAX = 5000;

function compileSegment(code) {
  let src = code.trim();
  if (src.endsWith(";")) src = src.replace(/;+\s*$/, "");
  if (src === "") throw new RunnerError("invalid syntax", { expressionSyntax: true });
  if (/\.\s*constructor/.test(src)) {
    throw new ExpressionError("Expression contains invalid constructor function call");
  }
  if (src.trimStart()[0] === "{") src = "(" + src + ")";
  const rewritten = rewriteExtensions(src);
  try {
    // eslint-disable-next-line no-new-func
    return new Function("__s", "with (__s) { return (\n" + rewritten + "\n); }");
  } catch (e) {
    throw new RunnerError("invalid syntax", { expressionSyntax: true, cause: e });
  }
}

function getCompiled(template) {
  let c = CACHE.get(template);
  if (c) return c;
  const chunks = splitExpression(template);
  const raw = chunks.length === 2 && chunks[0].text === "" && chunks[1].type === "code";
  c = { raw, parts: chunks.map((ch) => (ch.type === "code" ? { fn: compileSegment(ch.text) } : { text: ch.text })) };
  if (CACHE.size > CACHE_MAX) CACHE.clear();
  CACHE.set(template, c);
  return c;
}

const rethrows = (e) => e instanceof ExpressionError || e instanceof UnsupportedExpression;
const THIS = Object.freeze({});

function runSegment(fn, scope) {
  try {
    return fn.call(THIS, scope);
  } catch (e) {
    if (rethrows(e)) throw e;
    return undefined;
  }
}

// Evaluates a template (the expression without its leading "=") against a scope proxy.
export function evaluateTemplate(template, scope) {
  if (template === "") return "";
  let compiled;
  try {
    compiled = getCompiled(template);
  } catch (e) {
    if (e.expressionSyntax) throw new ExpressionError("invalid syntax");
    throw e;
  }
  if (compiled.raw) return runSegment(compiled.parts[1].fn, scope);
  let out = "";
  for (const p of compiled.parts) {
    if (p.fn === undefined) {
      out += p.text;
      continue;
    }
    const v = runSegment(p.fn, scope);
    const shown = v || v === 0 || v === false ? v : "";
    out += shown == null ? "" : String(shown);
  }
  return out;
}

// Mirrors Expression.finalizeResolvedValue.
function finalize(v) {
  if (typeof v === "function") {
    if (v.name === "DateTime") throw new ExpressionError("this is a DateTime, please access its methods");
    throw new ExpressionError("this is a function, please add ()");
  }
  return v;
}

export function evaluateExpression(value, scope) {
  if (!isExpression(value)) return value;
  return finalize(evaluateTemplate(value.slice(1), scope));
}

// Mirrors WorkflowExpression.getParameterValue: resolves expressions anywhere inside a
// parameter value (objects and arrays recursively). `scopeFor()` builds the scope lazily.
export function resolveParameter(value, scopeFor) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return isExpression(value) ? evaluateExpression(value, scopeFor()) : value;
  if (Array.isArray(value)) return value.map((v) => resolveParameter(v, scopeFor));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = resolveParameter(v, scopeFor);
  return out;
}

// Wraps a plain lookup object as a `with` scope: every identifier resolves through it.
export function makeScope(lookup) {
  const locals = Object.create(null);
  return new Proxy(locals, {
    has: (_, k) => k !== "__s" && typeof k === "string",
    get(_, k) {
      if (k === Symbol.unscopables) return undefined;
      if (k in locals) return locals[k];
      return lookup(k);
    },
    set(_, k, v) {
      locals[k] = v;
      return true;
    },
  });
}

// Compiles a Code node body (statements with `return`) into an async function of a scope.
export function compileCode(code) {
  const key = "code\n" + code;
  let fn = CACHE.get(key);
  if (fn) return fn;
  fn = new Function("__s", "with (__s) { return (async function () {\n" + code + "\n}).call(this); }");
  CACHE.set(key, fn);
  return fn;
}
