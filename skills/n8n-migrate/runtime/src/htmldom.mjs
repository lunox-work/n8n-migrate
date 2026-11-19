// HTML documents for the HTML node's extraction, built the way n8n's libraries build them:
//
// - parseHtml(html): the tree cheerio 1.1's load() gives (parse5 7: html, head and body always
//   present, implied end tags, tbody inserted in tables, text in a table moved before it). This
//   is the common subset of the HTML tree-construction algorithm, not all of it: misnested
//   formatting elements are closed where they end instead of being reconstructed (the adoption
//   agency), and frameset and template contents are plain children.
// - parseHtmlLoose(html): the tree htmlparser2 8 gives (html-to-text parses with it): no implied
//   html, head, body or tbody; a start tag closes the open tags its table names
//   (openImpliesClose); an end tag closes up to its open element, or is ignored.
// - selectAll(selector, roots): css-select's matching (cheerio's $(selector)) in document order.
// - innerHtml(el), outerHtml(node): parse5's serializer, as cheerio's .html() renders.
// - textContent(node): domutils' textContent (cheerio's .text()), comments left out.
//
// Nodes are domhandler-shaped, which is what css-select and html-to-text walk: {type: "root" |
// "tag" | "script" | "style" | "text" | "comment" | "directive", name, attribs, children, parent,
// data}. A selector or construct this module does not carry throws UnsupportedHtml, so a step
// refuses instead of extracting something n8n would not.

import { NAMED_ENTITIES, LEGACY_ENTITIES, NUMERIC_REMAP } from "./htmlentities.mjs";

export class UnsupportedHtml extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsupportedHtml";
  }
}

const set = (s) => new Set(s.split(" "));
export const VOID_ELEMENTS = set("area base basefont bgsound br col embed frame hr img input keygen link meta param source track wbr");
const LOOSE_VOID = set("area base basefont br col command embed frame hr img input isindex keygen link meta param source track wbr");

// ---------- entities ----------

const MAX_NAME = Math.max(...Object.keys(NAMED_ENTITIES).map((k) => k.length));
function codePoint(n) {
  if (n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return "\uFFFD";
  if (NUMERIC_REMAP[n] !== undefined) return String.fromCodePoint(NUMERIC_REMAP[n]);
  return String.fromCodePoint(n);
}
const isAlnum = (c) => /[A-Za-z0-9]/.test(c ?? "");

// Decodes the character reference at s[i] === "&". Returns [text, length] or null.
function entityAt(s, i, inAttribute) {
  const c = s[i + 1];
  if (c === "#") {
    const hex = s[i + 2] === "x" || s[i + 2] === "X";
    const re = hex ? /^[0-9a-fA-F]+/ : /^[0-9]+/;
    const m = re.exec(s.slice(i + (hex ? 3 : 2), i + (hex ? 3 : 2) + 12));
    if (!m) return null;
    let len = (hex ? 3 : 2) + m[0].length;
    if (s[i + len] === ";") len++;
    return [codePoint(parseInt(m[0], hex ? 16 : 10)), len];
  }
  if (!isAlnum(c)) return null;
  let j = i + 1;
  while (j < s.length && j - i - 1 < MAX_NAME && isAlnum(s[j])) j++;
  const name = s.slice(i + 1, j);
  if (s[j] === ";" && NAMED_ENTITIES[name] !== undefined) return [NAMED_ENTITIES[name], name.length + 2];
  // Legacy names decode without ";" (the longest that matches); in an attribute value not when
  // an alphanumeric or "=" follows.
  for (let k = name.length; k > 1; k--) {
    const n = name.slice(0, k);
    if (!LEGACY_ENTITIES.has(n)) continue;
    const next = s[i + 1 + k];
    if (inAttribute && (next === "=" || isAlnum(next))) return null;
    return [NAMED_ENTITIES[n], k + 1];
  }
  return null;
}

export function decodeEntities(s, inAttribute = false) {
  if (!s.includes("&")) return s;
  let out = "";
  let last = 0;
  for (let i = s.indexOf("&"); i !== -1; i = s.indexOf("&", i + 1)) {
    const e = entityAt(s, i, inAttribute);
    if (!e) continue;
    out += s.slice(last, i) + e[0];
    last = i + e[1];
    i = last - 1;
  }
  return out + s.slice(last);
}

// ---------- tokenizer ----------

const WS = /[\t\n\f\r ]/;

// Pull tokenizer. After a start tag the builder may call raw(name, kind): "raw" (no entities, no
// tags), "rcdata" (entities, no tags) or "plaintext", until the matching end tag.
class Tokenizer {
  constructor(src) {
    this.s = src;
    this.i = 0;
    this.rawName = null;
    this.rawKind = null;
  }
  raw(name, kind) {
    this.rawName = name;
    this.rawKind = kind;
  }
  next() {
    const s = this.s;
    if (this.i >= s.length) return null;
    if (this.rawKind) {
      const kind = this.rawKind;
      const name = this.rawName;
      this.rawKind = this.rawName = null;
      let end = s.length;
      if (kind !== "plaintext") {
        const re = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, "ig");
        re.lastIndex = this.i;
        const m = re.exec(s);
        if (m) end = m.index;
      }
      const data = s.slice(this.i, end);
      this.i = end;
      if (data) return { type: "text", data: kind === "rcdata" ? decodeEntities(data) : data, raw: true };
      return this.next();
    }
    if (s[this.i] !== "<") {
      let j = s.indexOf("<", this.i);
      while (j !== -1 && !this.tagStartsAt(j)) j = s.indexOf("<", j + 1);
      if (j === -1) j = s.length;
      const data = s.slice(this.i, j);
      this.i = j;
      return { type: "text", data: decodeEntities(data) };
    }
    if (!this.tagStartsAt(this.i)) {
      // A lone "<" is text.
      let j = s.indexOf("<", this.i + 1);
      while (j !== -1 && !this.tagStartsAt(j)) j = s.indexOf("<", j + 1);
      if (j === -1) j = s.length;
      const data = s.slice(this.i, j);
      this.i = j;
      return { type: "text", data: decodeEntities(data) };
    }
    const c = s[this.i + 1];
    if (c === "!") {
      if (s.startsWith("<!--", this.i)) {
        const start = this.i + 4;
        let end;
        if (s.startsWith(">", start)) end = start, (this.i = start + 1);
        else if (s.startsWith("->", start)) end = start, (this.i = start + 2);
        else {
          const k = s.indexOf("-->", start);
          end = k === -1 ? s.length : k;
          this.i = k === -1 ? s.length : k + 3;
        }
        return { type: "comment", data: s.slice(start, end) };
      }
      const k = s.indexOf(">", this.i);
      const body = s.slice(this.i + 2, k === -1 ? s.length : k);
      this.i = k === -1 ? s.length : k + 1;
      if (/^doctype/i.test(body)) return { type: "doctype", data: body };
      return { type: "comment", data: body };
    }
    if (c === "?") {
      const k = s.indexOf(">", this.i);
      const body = s.slice(this.i + 1, k === -1 ? s.length : k);
      this.i = k === -1 ? s.length : k + 1;
      return { type: "comment", data: body, pi: true };
    }
    if (c === "/") {
      if (s[this.i + 2] === ">") {
        this.i += 3;
        return this.next();
      }
      if (!/[A-Za-z]/.test(s[this.i + 2] ?? "")) {
        const k = s.indexOf(">", this.i);
        const body = s.slice(this.i + 2, k === -1 ? s.length : k);
        this.i = k === -1 ? s.length : k + 1;
        return { type: "comment", data: body };
      }
      const m = /^<\/([^\t\n\f\r />]+)/.exec(s.slice(this.i, this.i + 256));
      const k = s.indexOf(">", this.i);
      this.i = k === -1 ? s.length : k + 1;
      return { type: "end", name: m[1].toLowerCase() };
    }
    return this.startTag();
  }
  tagStartsAt(j) {
    const c = this.s[j + 1];
    return c !== undefined && (/[A-Za-z!?]/.test(c) || (c === "/" && this.s[j + 2] !== undefined));
  }
  startTag() {
    const s = this.s;
    let i = this.i + 1;
    let j = i;
    while (j < s.length && !WS.test(s[j]) && s[j] !== "/" && s[j] !== ">") j++;
    const name = s.slice(i, j).toLowerCase();
    i = j;
    const attrs = [];
    let selfClosing = false;
    for (;;) {
      while (i < s.length && (WS.test(s[i]) || (s[i] === "/" && s[i + 1] !== ">"))) i++;
      if (i >= s.length) break;
      if (s[i] === ">") {
        i++;
        break;
      }
      if (s[i] === "/" && s[i + 1] === ">") {
        selfClosing = true;
        i += 2;
        break;
      }
      let k = i + 1;
      while (k < s.length && !WS.test(s[k]) && s[k] !== "/" && s[k] !== ">" && s[k] !== "=") k++;
      const an = s.slice(i, k).toLowerCase();
      i = k;
      while (i < s.length && WS.test(s[i])) i++;
      let value = "";
      if (s[i] === "=") {
        i++;
        while (i < s.length && WS.test(s[i])) i++;
        const q = s[i];
        if (q === '"' || q === "'") {
          const e = s.indexOf(q, i + 1);
          value = s.slice(i + 1, e === -1 ? s.length : e);
          i = e === -1 ? s.length : e + 1;
        } else {
          let e = i;
          while (e < s.length && !WS.test(s[e]) && s[e] !== ">") e++;
          value = s.slice(i, e);
          i = e;
        }
        value = decodeEntities(value, true);
      }
      if (!attrs.some(([n]) => n === an)) attrs.push([an, value]);
    }
    this.i = i;
    return { type: "start", name, attrs, selfClosing };
  }
}

// ---------- nodes ----------

const elementType = (name) => (name === "script" ? "script" : name === "style" ? "style" : "tag");
function element(name, attrs = []) {
  return { type: elementType(name), name, attribs: Object.fromEntries(attrs), children: [], parent: null };
}
function append(parent, node) {
  const last = parent.children[parent.children.length - 1];
  if (node.type === "text" && last?.type === "text") {
    last.data += node.data;
    return last;
  }
  node.parent = parent;
  parent.children.push(node);
  return node;
}
function insertBefore(parent, node, ref) {
  const at = parent.children.indexOf(ref);
  const prev = parent.children[at - 1];
  if (node.type === "text" && prev?.type === "text") {
    prev.data += node.data;
    return prev;
  }
  node.parent = parent;
  parent.children.splice(at, 0, node);
  return node;
}

// ---------- parse5-like tree construction (cheerio.load) ----------

const SPECIAL = set(
  "address applet area article aside base basefont bgsound blockquote body br button caption center col colgroup dd details dir div dl dt embed fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html iframe img input keygen li link listing main marquee menu meta nav noembed noframes noscript object ol p param plaintext pre script search section select source style summary table tbody td template textarea tfoot th thead title tr track ul wbr xmp",
);
const CLOSES_P = set("address article aside blockquote center details dialog dir div dl fieldset figcaption figure footer header hgroup main menu nav ol p search section summary ul");
const HEADINGS = set("h1 h2 h3 h4 h5 h6");
const IMPLIED_END = set("dd dt li optgroup option p rb rp rt rtc");
const SCOPE = set("applet caption html table td th marquee object template");
const HEAD_ELEMENTS = set("base basefont bgsound link meta noframes script style template title");
const RAW_TEXT = set("style xmp iframe noembed noframes noscript");
const TABLE_CONTEXT = set("table tbody thead tfoot tr");
const TABLE_SECTIONS = set("tbody thead tfoot");

function quirksOf(doctype) {
  if (doctype === null) return true;
  const m = /^doctype\s+(\S+)?\s*(.*)$/is.exec(doctype.trim());
  if (!m || (m[1] ?? "").toLowerCase() !== "html") return true;
  const rest = m[2] ?? "";
  const pub = /public\s+["']([^"']*)["']\s*(["'][^"']*["'])?/i.exec(rest);
  if (!pub) return false;
  const id = pub[1].toLowerCase();
  const system = pub[2];
  if (/^-\/\/w3c\/\/dtd html 4\.01 (transitional|frameset)\/\//.test(id)) return !system;
  if (/^-\/\/w3c\/\/dtd xhtml 1\.0 (transitional|frameset)\/\//.test(id)) return false;
  if (/^-\/\/(w3c|ietf|w3o|webtechs|softquad|sun microsystems|o'reilly|netscape|microsoft|metrius|spyglass|sq|as|advasoft|silmaril|ibm)\/\/dtd /.test(id) && !/^-\/\/w3c\/\/dtd (html 4\.01|xhtml)/.test(id)) return true;
  return false;
}

export function parseHtml(html) {
  const tok = new Tokenizer(String(html));
  const doc = { type: "root", name: "root", children: [], parent: null };
  let htmlEl = null;
  let head = null;
  let body = null;
  const stack = [];
  let doctype = null;
  let quirks = null;
  let dropNewline = false;
  const current = () => stack[stack.length - 1];
  const ensureHtml = (attrs = []) => {
    if (htmlEl) return;
    htmlEl = append(doc, element("html", attrs));
    stack.push(htmlEl);
  };
  const ensureHead = () => {
    ensureHtml();
    if (head) return;
    head = append(htmlEl, element("head"));
  };
  const ensureBody = (attrs = []) => {
    ensureHead();
    if (body) return;
    body = append(htmlEl, element("body", attrs));
    stack.length = 0;
    stack.push(htmlEl, body);
  };
  const inScope = (names, extra = null) => {
    for (let k = stack.length - 1; k >= 0; k--) {
      const n = stack[k].name;
      if (names.has(n)) return k;
      if (SCOPE.has(n) || extra?.has(n)) return -1;
    }
    return -1;
  };
  const BUTTON = set("button");
  const LIST = set("ol ul");
  const TABLE_SCOPE = set("html table template");
  const inTableScope = (names) => {
    for (let k = stack.length - 1; k >= 0; k--) {
      if (names.has(stack[k].name)) return k;
      if (TABLE_SCOPE.has(stack[k].name)) return -1;
    }
    return -1;
  };
  const popTo = (k) => {
    if (k >= 0) stack.length = Math.max(k, 2);
  };
  const generateImplied = (except = null) => {
    while (stack.length > 2 && IMPLIED_END.has(current().name) && current().name !== except) stack.pop();
  };
  const closeP = () => {
    const k = inScope(set("p"), BUTTON);
    if (k >= 0) {
      generateImplied("p");
      popTo(k);
    }
  };
  // Where a node goes: the current node, or before the table when the current node is a table
  // part (foster parenting).
  const insert = (node, foster = true) => {
    const cur = current();
    if (foster && TABLE_CONTEXT.has(cur.name) && !(node.type === "text" && !/[^\t\n\f\r ]/.test(node.data))) {
      let t = -1;
      for (let k = stack.length - 1; k >= 0; k--) if (stack[k].name === "table") (t = k), (k = -1);
      const table = stack[t];
      if (table?.parent) return insertBefore(table.parent, node, table);
      return append(stack[t - 1] ?? cur, node);
    }
    return append(cur, node);
  };
  const insertElement = (t, push = true, foster = true) => {
    const el = insert(element(t.name === "image" ? "img" : t.name, t.attrs), foster);
    if (push && !VOID_ELEMENTS.has(el.name) && !(t.selfClosing && inForeign())) stack.push(el);
    return el;
  };
  const inForeign = () => stack.some((e) => e.name === "svg" || e.name === "math");
  // The innermost table part on the stack decides how table tokens are handled.
  const tableMode = () => {
    for (let k = stack.length - 1; k >= 0; k--) {
      const n = stack[k].name;
      if (n === "td" || n === "th") return "cell";
      if (n === "caption") return "caption";
      if (n === "tr") return "row";
      if (TABLE_SECTIONS.has(n)) return "section";
      if (n === "table") return "table";
    }
    return null;
  };
  const clearTo = (names) => {
    while (stack.length > 2 && !names.has(current().name)) stack.pop();
  };

  const startInBody = (t) => {
    const n = t.name;
    if (n === "html") {
      for (const [a, v] of t.attrs) if (!(a in htmlEl.attribs)) htmlEl.attribs[a] = v;
      return;
    }
    if (n === "body") {
      for (const [a, v] of t.attrs) if (!(a in body.attribs)) body.attribs[a] = v;
      return;
    }
    if (n === "head" || n === "frameset" || n === "frame") return;
    // Table structure.
    const mode = tableMode();
    if (["caption", "col", "colgroup", "tbody", "tfoot", "thead", "td", "th", "tr", "table"].includes(n) && mode) return startInTable(t, mode);
    if (n === "table" && !mode) {
      if (!quirks) closeP();
      insertElement(t);
      return;
    }
    if (["caption", "col", "colgroup", "tbody", "tfoot", "thead", "td", "th", "tr"].includes(n)) return; // outside a table: ignored
    if (HEAD_ELEMENTS.has(n)) {
      const el = insertElement(t, true, !["script", "style", "template"].includes(n));
      if (n === "title") tok.raw("title", "rcdata");
      else if (n === "script") tok.raw("script", "raw");
      else if (n === "style" || n === "noframes") tok.raw(n, "raw");
      return el;
    }
    if (CLOSES_P.has(n)) {
      closeP();
      insertElement(t);
      return;
    }
    if (HEADINGS.has(n)) {
      closeP();
      if (HEADINGS.has(current().name)) stack.pop();
      insertElement(t);
      return;
    }
    if (n === "pre" || n === "listing") {
      closeP();
      insertElement(t);
      dropNewline = true;
      return;
    }
    if (n === "form") {
      closeP();
      insertElement(t);
      return;
    }
    if (n === "li" || n === "dd" || n === "dt") {
      const names = n === "li" ? set("li") : set("dd dt");
      for (let k = stack.length - 1; k >= 2; k--) {
        const e = stack[k];
        if (names.has(e.name)) {
          generateImplied(e.name);
          popTo(k);
          break;
        }
        if (SPECIAL.has(e.name) && !["address", "div", "p"].includes(e.name)) break;
      }
      closeP();
      insertElement(t);
      return;
    }
    if (n === "plaintext") {
      closeP();
      insertElement(t);
      tok.raw("plaintext", "plaintext");
      return;
    }
    if (n === "button") {
      const k = inScope(set("button"));
      if (k >= 0) {
        generateImplied();
        popTo(k);
      }
      insertElement(t);
      return;
    }
    if (n === "a") {
      // A second <a> closes the first (the adoption agency, for the common case).
      for (let k = stack.length - 1; k >= 2; k--) {
        if (stack[k].name === "a") {
          popTo(k);
          break;
        }
        if (SPECIAL.has(stack[k].name)) break;
      }
      insertElement(t);
      return;
    }
    if (n === "nobr") {
      const k = inScope(set("nobr"));
      if (k >= 0) popTo(k);
      insertElement(t);
      return;
    }
    if (n === "hr") {
      closeP();
      insertElement(t);
      return;
    }
    if (n === "textarea") {
      insertElement(t);
      tok.raw("textarea", "rcdata");
      dropNewline = true;
      return;
    }
    if (n === "xmp") {
      closeP();
      insertElement(t);
      tok.raw("xmp", "raw");
      return;
    }
    if (RAW_TEXT.has(n)) {
      insertElement(t);
      tok.raw(n, "raw");
      return;
    }
    if (n === "option" || n === "optgroup") {
      if (current().name === "option") stack.pop();
      insertElement(t);
      return;
    }
    if (n === "rb" || n === "rtc") {
      if (inScope(set("ruby")) >= 0) generateImplied();
      insertElement(t);
      return;
    }
    if (n === "rp" || n === "rt") {
      if (inScope(set("ruby")) >= 0) generateImplied("rtc");
      insertElement(t);
      return;
    }
    if (n === "select") {
      insertElement(t);
      return;
    }
    insertElement(t);
  };

  const startInTable = (t, mode) => {
    const n = t.name;
    if (mode === "cell" || mode === "caption") {
      if (["caption", "col", "colgroup", "tbody", "tfoot", "thead", "td", "th", "tr", "table"].includes(n)) {
        if (n === "table" && mode === "cell") {
          // A table inside a cell is content of the cell.
          if (!quirks) closeP();
          insertElement(t, true, false);
          return;
        }
        const k = inTableScope(mode === "cell" ? set("td th") : set("caption"));
        if (k < 0) return;
        generateImplied();
        popTo(k);
        return startInBody(t);
      }
    }
    if (mode === "row") {
      if (n === "td" || n === "th") {
        clearTo(set("tr template html"));
        insertElement(t, true, false);
        return;
      }
      clearTo(set("tr template html"));
      if (current().name === "tr") stack.pop();
      return startInBody(t);
    }
    if (mode === "section") {
      if (n === "tr") {
        clearTo(set("tbody thead tfoot template html"));
        insertElement(t, true, false);
        return;
      }
      if (n === "td" || n === "th") {
        clearTo(set("tbody thead tfoot template html"));
        insertElement({ name: "tr", attrs: [] }, true, false);
        insertElement(t, true, false);
        return;
      }
      clearTo(set("tbody thead tfoot template html"));
      if (TABLE_SECTIONS.has(current().name)) stack.pop();
      return startInBody(t);
    }
    // mode === "table"
    if (n === "caption") {
      clearTo(set("table template html"));
      insertElement(t, true, false);
      return;
    }
    if (n === "colgroup") {
      clearTo(set("table template html"));
      insertElement(t, true, false);
      return;
    }
    if (n === "col") {
      clearTo(set("table template html"));
      const cg = insertElement({ name: "colgroup", attrs: [] }, true, false);
      append(cg, element("col", t.attrs));
      stack.pop();
      return;
    }
    if (TABLE_SECTIONS.has(n)) {
      clearTo(set("table template html"));
      insertElement(t, true, false);
      return;
    }
    if (n === "td" || n === "th" || n === "tr") {
      clearTo(set("table template html"));
      insertElement({ name: "tbody", attrs: [] }, true, false);
      return startInTable(t, "section");
    }
    if (n === "table") {
      const k = inTableScope(set("table"));
      if (k < 0) return;
      popTo(k);
      return startInBody(t);
    }
  };

  const endInBody = (name) => {
    if (name === "body" || name === "html") return;
    const mode = tableMode();
    if (mode && ["table", "tbody", "tfoot", "thead", "tr", "td", "th", "caption", "colgroup"].includes(name)) {
      const k = inTableScope(set(name));
      if (k < 0) return;
      generateImplied();
      popTo(k);
      return;
    }
    if (name === "p") {
      if (inScope(set("p"), BUTTON) < 0) {
        insertElement({ name: "p", attrs: [] });
      }
      closeP();
      return;
    }
    if (name === "li") {
      const k = inScope(set("li"), LIST);
      if (k >= 0) {
        generateImplied("li");
        popTo(k);
      }
      return;
    }
    if (name === "dd" || name === "dt") {
      const k = inScope(set(name));
      if (k >= 0) {
        generateImplied(name);
        popTo(k);
      }
      return;
    }
    if (HEADINGS.has(name)) {
      const k = inScope(HEADINGS);
      if (k >= 0) {
        generateImplied();
        popTo(k);
      }
      return;
    }
    if (name === "br") {
      insertElement({ name: "br", attrs: [] });
      return;
    }
    if (CLOSES_P.has(name) || ["pre", "listing", "form", "button", "applet", "marquee", "object"].includes(name)) {
      const k = inScope(set(name));
      if (k >= 0) {
        generateImplied();
        popTo(k);
      }
      return;
    }
    for (let k = stack.length - 1; k >= 2; k--) {
      const e = stack[k];
      if (e.name === name) {
        generateImplied(name);
        popTo(k);
        return;
      }
      if (SPECIAL.has(e.name)) return;
    }
  };

  for (let t = tok.next(); t; t = tok.next()) {
    if (t.type === "doctype") {
      if (!htmlEl && doctype === null) {
        doctype = t.data;
        const name = /^doctype\s*(\S*)/i.exec(t.data)?.[1]?.toLowerCase() ?? "";
        append(doc, { type: "directive", name: "!doctype", data: `!${t.data}`, doctypeName: name, parent: null });
      }
      continue;
    }
    if (quirks === null && t.type !== "comment") quirks = quirksOf(doctype);
    if (t.type === "comment") {
      const where = body ? current() : head && stack.includes(head) ? head : htmlEl ?? doc;
      insertComment(where, t.data, insert, body);
      continue;
    }
    if (t.type === "text") {
      let data = t.data;
      if (dropNewline) {
        dropNewline = false;
        if (data.startsWith("\n")) data = data.slice(1);
        if (!data) continue;
      }
      if (!body) {
        const lead = /^[\t\n\f\r ]*/.exec(data)[0];
        if (!htmlEl || !head) {
          data = data.slice(lead.length);
          if (!data) continue;
        } else if (stack[stack.length - 1] === head || t.raw) {
          if (t.raw) {
            append(current(), { type: "text", data });
            continue;
          }
          if (lead) append(head, { type: "text", data: lead });
          data = data.slice(lead.length);
          if (!data) continue;
          stack.pop(); // head
        } else {
          if (lead) append(htmlEl, { type: "text", data: lead });
          data = data.slice(lead.length);
          if (!data) continue;
        }
        ensureBody();
      }
      insert({ type: "text", data });
      continue;
    }
    if (t.type === "start") {
      dropNewline = false;
      if (!body) {
        if (t.name === "html") {
          if (!htmlEl) ensureHtml(t.attrs);
          else for (const [a, v] of t.attrs) if (!(a in htmlEl.attribs)) htmlEl.attribs[a] = v;
          continue;
        }
        if (t.name === "head" && !head) {
          ensureHtml();
          head = append(htmlEl, element("head", t.attrs));
          stack.push(head);
          continue;
        }
        if (HEAD_ELEMENTS.has(t.name) || (t.name === "noscript" && current() === head)) {
          // In head (or back into it after head): the element goes into head; a raw-text one
          // stays open on the stack until its end tag.
          ensureHead();
          const el = append(head, element(t.name, t.attrs));
          if (!VOID_ELEMENTS.has(t.name)) {
            stack.push(el);
            tok.raw(t.name, t.name === "title" ? "rcdata" : "raw");
          }
          continue;
        }
        if (t.name === "body") {
          if (current() === head) stack.pop();
          ensureBody(t.attrs);
          continue;
        }
        if (current() === head) stack.pop();
        ensureBody();
      }
      startInBody(t);
      continue;
    }
    if (t.type === "end") {
      if (!body) {
        if (current() !== head && current() !== htmlEl && current().name === t.name) {
          stack.pop();
          continue;
        }
        if (t.name === "head" && current() === head) {
          stack.pop();
          continue;
        }
        if (!["body", "html", "br"].includes(t.name)) continue;
        if (t.name === "br") {
          if (current() === head) stack.pop();
          ensureBody();
        } else continue;
      }
      endInBody(t.name);
    }
  }
  ensureBody();
  return doc;
}

function insertComment(where, data, insert, inBody) {
  const node = { type: "comment", data, parent: null };
  if (inBody) insert(node);
  else append(where, node);
}

// ---------- htmlparser2-like tree construction (html-to-text) ----------

const P = set("p");
const FORM_TAGS = set("input option optgroup select button datalist textarea");
const DDT = set("dd dt");
const RTP = set("rt rp");
const SECTIONS = set("thead tbody");
const OPEN_IMPLIES_CLOSE = new Map([
  ["tr", set("tr th td")],
  ["th", set("th")],
  ["td", set("thead th td")],
  ["body", set("head link script")],
  ["li", set("li")],
  ...["p", "h1", "h2", "h3", "h4", "h5", "h6"].map((n) => [n, P]),
  ...["select", "input", "output", "button", "datalist", "textarea"].map((n) => [n, FORM_TAGS]),
  ["option", set("option")],
  ["optgroup", set("optgroup option")],
  ["dd", DDT],
  ["dt", DDT],
  ...["address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figcaption", "figure", "footer", "form", "header", "hr", "main", "nav", "ol", "pre", "section", "table", "ul"].map((n) => [n, P]),
  ["rt", RTP],
  ["rp", RTP],
  ["tbody", SECTIONS],
  ["tfoot", SECTIONS],
]);
const FOREIGN = set("math svg");
const INTEGRATION = set("mi mo mn ms mtext annotation-xml foreignobject desc title");

export function parseHtmlLoose(html) {
  const tok = new Tokenizer(String(html));
  const doc = { type: "root", name: "root", children: [], parent: null };
  const stack = [doc];
  const foreign = [];
  const current = () => stack[stack.length - 1];
  for (let t = tok.next(); t; t = tok.next()) {
    if (t.type === "text") append(current(), { type: "text", data: t.data });
    else if (t.type === "comment") {
      if (t.pi) append(current(), { type: "directive", name: t.data.split(/\s|\//)[0].toLowerCase(), data: t.data, parent: null });
      else append(current(), { type: "comment", data: t.data, parent: null });
    } else if (t.type === "doctype") append(current(), { type: "directive", name: "!doctype", data: `!${t.data}`, parent: null });
    else if (t.type === "start") {
      const imp = OPEN_IMPLIES_CLOSE.get(t.name);
      if (imp) while (stack.length > 1 && imp.has(current().name)) stack.pop();
      const el = append(current(), element(t.name, t.attrs));
      if (LOOSE_VOID.has(t.name)) continue;
      if (FOREIGN.has(t.name)) foreign.push(true);
      else if (INTEGRATION.has(t.name)) foreign.push(false);
      if (t.selfClosing && foreign[foreign.length - 1]) {
        if (FOREIGN.has(t.name) || INTEGRATION.has(t.name)) foreign.pop();
        continue;
      }
      stack.push(el);
      if (t.name === "script" || t.name === "style") tok.raw(t.name, "raw");
      else if (t.name === "title") tok.raw("title", "rcdata");
    } else if (t.type === "end") {
      if (FOREIGN.has(t.name) || INTEGRATION.has(t.name)) foreign.pop();
      if (LOOSE_VOID.has(t.name)) {
        if (t.name === "br") append(current(), element("br"));
        continue;
      }
      let k = stack.length - 1;
      while (k > 0 && stack[k].name !== t.name) k--;
      if (k > 0) stack.length = k;
      else if (t.name === "p") append(current(), element("p"));
    }
  }
  return doc;
}

// ---------- serializer (parse5) and text ----------

const RAW_PARENTS = set("style script xmp iframe noembed noframes plaintext noscript");
const escapeText = (s) => s.replace(/&/g, "&amp;").replace(/ /g, "&nbsp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s) => s.replace(/&/g, "&amp;").replace(/ /g, "&nbsp;").replace(/"/g, "&quot;");

export function outerHtml(node) {
  if (node.type === "text") return node.parent && RAW_PARENTS.has(node.parent.name) ? node.data : escapeText(node.data);
  if (node.type === "comment") return `<!--${node.data}-->`;
  if (node.type === "directive") return node.name === "!doctype" ? `<!DOCTYPE ${node.doctypeName ?? "html"}>` : `<${node.data}>`;
  if (node.type === "root") return innerHtml(node);
  let s = `<${node.name}`;
  for (const [a, v] of Object.entries(node.attribs ?? {})) s += ` ${a}="${escapeAttr(String(v))}"`;
  s += ">";
  if (VOID_ELEMENTS.has(node.name)) return s;
  return `${s}${innerHtml(node)}</${node.name}>`;
}
export const innerHtml = (node) => (node.children ?? []).map(outerHtml).join("");

export function textContent(node) {
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (node.type === "text") return node.data;
  if (node.type === "comment" || node.type === "directive") return "";
  return (node.children ?? []).map(textContent).join("");
}

export const isTag = (n) => n?.type === "tag" || n?.type === "script" || n?.type === "style";

// ---------- CSS selectors (css-select, with cheerio's defaults) ----------

// Parses a selector list into [[{combinator, compound}]]; compound = {tag, ids, classes, attrs,
// pseudos}. Throws UnsupportedHtml on syntax it does not carry.
export function parseSelector(src) {
  const s = String(src);
  let i = 0;
  const groups = [];
  let seq = [];
  let comb = null;
  const ws = () => {
    const st = i;
    while (i < s.length && /\s/.test(s[i])) i++;
    return i > st;
  };
  const ident = () => {
    const m = /^(?:\\.|[\w -￿-])+/.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[0].replace(/\\(.)/g, "$1");
  };
  const fail = (why) => {
    throw new UnsupportedHtml(`CSS selector "${s}": ${why}`);
  };
  ws();
  while (i < s.length) {
    const compound = { tag: null, ids: [], classes: [], attrs: [], pseudos: [] };
    let any = false;
    if (s[i] === "*") {
      i++;
      any = true;
    } else {
      const t = ident();
      if (t) (compound.tag = t.toLowerCase()), (any = true);
    }
    for (;;) {
      const c = s[i];
      if (c === "#") {
        i++;
        const v = ident();
        if (v === null) fail("an id needs a name");
        compound.ids.push(v);
      } else if (c === ".") {
        i++;
        const v = ident();
        if (v === null) fail("a class needs a name");
        compound.classes.push(v);
      } else if (c === "[") {
        i++;
        ws();
        const name = ident();
        if (!name) fail("an attribute selector needs a name");
        ws();
        let op = null;
        let value = null;
        let flag = null;
        const m = /^([~|^$*!]?=)/.exec(s.slice(i));
        if (m) {
          op = m[1];
          i += m[1].length;
          ws();
          const q = s[i];
          if (q === '"' || q === "'") {
            let j = i + 1;
            let v = "";
            while (j < s.length && s[j] !== q) {
              if (s[j] === "\\" && j + 1 < s.length) j++;
              v += s[j++];
            }
            if (j >= s.length) fail("an unclosed string");
            value = v;
            i = j + 1;
          } else {
            value = ident();
            if (value === null) fail("an attribute value");
          }
          ws();
          const f = /^([iIsS])(?=\s*\])/.exec(s.slice(i));
          if (f) (flag = f[1].toLowerCase()), (i += 1), ws();
        }
        if (s[i] !== "]") fail("an unclosed attribute selector");
        i++;
        compound.attrs.push({ name: name.toLowerCase(), op, value, flag });
      } else if (c === ":") {
        i++;
        if (s[i] === ":") fail("pseudo-elements select nothing");
        const name = (ident() ?? "").toLowerCase();
        if (!name) fail("a pseudo-class needs a name");
        let arg = null;
        if (s[i] === "(") {
          let depth = 1;
          let j = i + 1;
          let quote = null;
          while (j < s.length && depth) {
            const ch = s[j];
            if (quote) {
              if (ch === "\\") j++;
              else if (ch === quote) quote = null;
            } else if (ch === '"' || ch === "'") quote = ch;
            else if (ch === "(") depth++;
            else if (ch === ")") depth--;
            j++;
          }
          if (depth) fail("an unclosed pseudo-class argument");
          arg = s.slice(i + 1, j - 1).trim();
          i = j;
        }
        compound.pseudos.push(pseudo(name, arg, fail));
      } else break;
      any = true;
    }
    if (!any) fail(`unexpected "${s[i]}"`);
    seq.push({ combinator: comb ?? (seq.length ? " " : null), compound });
    comb = null;
    const hadWs = ws();
    const c = s[i];
    if (c === ">" || c === "+" || c === "~") {
      comb = c;
      i++;
      ws();
    } else if (c === ",") {
      groups.push(seq);
      seq = [];
      i++;
      ws();
    } else if (i < s.length) {
      if (!hadWs) fail(`unexpected "${c}"`);
      comb = " ";
    }
  }
  if (comb && comb !== " ") fail("a combinator without a selector after it");
  if (!seq.length) fail("an empty selector");
  groups.push(seq);
  return groups;
}

function nthParser(arg, fail) {
  const a0 = String(arg ?? "").trim().toLowerCase().replace(/\s+/g, "");
  if (a0 === "odd") return [2, 1];
  if (a0 === "even") return [2, 0];
  const m = /^([+-]?\d*)?n([+-]\d+)?$/.exec(a0);
  if (m) {
    const a = m[1] === undefined || m[1] === "" || m[1] === "+" ? 1 : m[1] === "-" ? -1 : Number(m[1]);
    return [a, m[2] ? Number(m[2]) : 0];
  }
  if (/^[+-]?\d+$/.test(a0)) return [0, Number(a0)];
  fail(`nth argument "${arg}"`);
}
const nthMatch = ([a, b], pos) => (a === 0 ? pos === b : (pos - b) / a >= 0 && (pos - b) % a === 0);
const unquote = (x) => {
  const t = String(x ?? "").trim();
  return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t;
};

function pseudo(name, arg, fail) {
  switch (name) {
    case "first-child":
    case "last-child":
    case "only-child":
    case "first-of-type":
    case "last-of-type":
    case "only-of-type":
    case "empty":
    case "root":
    case "checked":
    case "selected":
    case "disabled":
    case "enabled":
    case "header":
    case "parent":
    case "link":
    case "any-link":
      return { name };
    case "nth-child":
    case "nth-last-child":
    case "nth-of-type":
    case "nth-last-of-type":
      return { name, nth: nthParser(arg, fail) };
    case "not":
    case "is":
    case "matches":
    case "where":
    case "has":
      if (!arg) fail(`:${name}() needs a selector`);
      return { name, groups: parseSelector(arg) };
    case "contains":
    case "icontains":
      return { name, text: unquote(arg) };
    default:
      fail(`:${name} is not carried`);
  }
}

const elementSiblings = (el) => (el.parent?.children ?? [el]).filter(isTag);

function matchAttr(el, a) {
  const attribs = el.attribs ?? {};
  if (!Object.prototype.hasOwnProperty.call(attribs, a.name)) return a.op === "!=";
  if (!a.op) return true;
  let v = String(attribs[a.name]);
  let want = a.value;
  // css-select compares these HTML attributes case-insensitively unless the flag says "s".
  const ci = a.flag === "i" || (a.flag !== "s" && CI_ATTRS.has(a.name));
  if (ci) (v = v.toLowerCase()), (want = want.toLowerCase());
  switch (a.op) {
    case "=":
      return v === want;
    case "!=":
      return v !== want;
    case "~=":
      return want !== "" && !/\s/.test(want) && v.split(/[\t\n\f\r ]+/).includes(want);
    case "|=":
      return v === want || v.startsWith(want + "-");
    case "^=":
      return want !== "" && v.startsWith(want);
    case "$=":
      return want !== "" && v.endsWith(want);
    case "*=":
      return want !== "" && v.includes(want);
  }
  return false;
}
const CI_ATTRS = set("accept accept-charset align alink axis bgcolor charset checked clear codetype color compact declare defer dir direction disabled enctype face frame hreflang http-equiv lang language link media method multiple nohref noresize noshade nowrap readonly rel rev rules scope scrolling selected shape target text type valign valuetype vlink");

function matchCompound(el, c, scope) {
  if (!isTag(el)) return false;
  if (c.tag && el.name !== c.tag) return false;
  const attribs = el.attribs ?? {};
  for (const id of c.ids) if (attribs.id !== id) return false;
  if (c.classes.length) {
    const cls = String(attribs.class ?? "").split(/[\t\n\f\r ]+/);
    for (const k of c.classes) if (!cls.includes(k)) return false;
  }
  for (const a of c.attrs) if (!matchAttr(el, a)) return false;
  for (const p of c.pseudos) if (!matchPseudo(el, p, scope)) return false;
  return true;
}

function matchPseudo(el, p, scope) {
  const sib = () => elementSiblings(el);
  const sameType = () => sib().filter((x) => x.name === el.name);
  switch (p.name) {
    case "first-child":
      return sib()[0] === el;
    case "last-child":
      return sib().at(-1) === el;
    case "only-child":
      return sib().length === 1;
    case "first-of-type":
      return sameType()[0] === el;
    case "last-of-type":
      return sameType().at(-1) === el;
    case "only-of-type":
      return sameType().length === 1;
    case "nth-child":
      return nthMatch(p.nth, sib().indexOf(el) + 1);
    case "nth-last-child": {
      const s = sib();
      return nthMatch(p.nth, s.length - s.indexOf(el));
    }
    case "nth-of-type":
      return nthMatch(p.nth, sameType().indexOf(el) + 1);
    case "nth-last-of-type": {
      const s = sameType();
      return nthMatch(p.nth, s.length - s.indexOf(el));
    }
    case "empty":
      return !(el.children ?? []).some((c) => isTag(c) || (c.type === "text" && c.data !== ""));
    case "parent":
      return (el.children ?? []).some((c) => isTag(c) || (c.type === "text" && c.data !== ""));
    case "root":
      return !isTag(el.parent);
    case "checked":
      return (el.name === "input" && "checked" in (el.attribs ?? {})) || (el.name === "option" && "selected" in (el.attribs ?? {}));
    case "selected":
      if ("selected" in (el.attribs ?? {})) return el.name === "option";
      return el.name === "option" && selectedByDefault(el);
    case "disabled":
      return "disabled" in (el.attribs ?? {}) && ["button", "input", "select", "textarea", "optgroup", "option", "fieldset"].includes(el.name);
    case "enabled":
      return !("disabled" in (el.attribs ?? {})) && ["button", "input", "select", "textarea", "optgroup", "option", "fieldset"].includes(el.name);
    case "header":
      return HEADINGS.has(el.name);
    case "link":
    case "any-link":
      return ["a", "area", "link"].includes(el.name) && "href" in (el.attribs ?? {});
    case "not":
      return !p.groups.some((g) => matchComplex(el, g, scope));
    case "is":
    case "matches":
    case "where":
      return p.groups.some((g) => matchComplex(el, g, scope));
    case "has":
      return descendants(el).some((d) => p.groups.some((g) => matchComplex(d, g, el)));
    case "contains":
      return textContent(el).includes(p.text);
    case "icontains":
      return textContent(el).toLowerCase().includes(p.text.toLowerCase());
  }
  return false;
}

// css-select's :selected for an option without the attribute: the first option of a select
// that has no selected option and is not multiple.
function selectedByDefault(opt) {
  let sel = opt.parent;
  if (sel?.name === "optgroup") sel = sel.parent;
  if (sel?.name !== "select" || "multiple" in (sel.attribs ?? {})) return false;
  const opts = descendants(sel).filter((x) => x.name === "option");
  return !opts.some((o) => "selected" in (o.attribs ?? {})) && opts[0] === opt;
}

// Right to left over the compound list.
function matchComplex(el, seq, scope, k = seq.length - 1) {
  if (!matchCompound(el, seq[k].compound, scope)) return false;
  if (k === 0) return true;
  const comb = seq[k].combinator;
  if (comb === ">") return isTag(el.parent) && matchComplex(el.parent, seq, scope, k - 1);
  if (comb === " ") {
    for (let p = el.parent; isTag(p); p = p.parent) if (matchComplex(p, seq, scope, k - 1)) return true;
    return false;
  }
  const s = elementSiblings(el);
  const at = s.indexOf(el);
  if (comb === "+") return at > 0 && matchComplex(s[at - 1], seq, scope, k - 1);
  if (comb === "~") {
    for (let j = at - 1; j >= 0; j--) if (matchComplex(s[j], seq, scope, k - 1)) return true;
    return false;
  }
  return false;
}

function descendants(node, out = []) {
  for (const c of node.children ?? []) {
    if (isTag(c)) out.push(c);
    if (c.children) descendants(c, out);
  }
  return out;
}

// Elements under the roots (roots included only when they are elements matched as descendants
// of a document) matching the selector, in document order, each once.
export function selectAll(selector, roots) {
  const groups = typeof selector === "string" ? parseSelector(selector) : selector;
  const out = [];
  for (const r of [].concat(roots)) for (const el of r.type === "root" ? descendants(r) : [r, ...descendants(r)]) if (groups.some((g) => matchComplex(el, g, r))) out.push(el);
  return out;
}

export const matches = (el, selector) => (typeof selector === "string" ? parseSelector(selector) : selector).some((g) => matchComplex(el, g, null));

// Specificity [ids, classes+attributes+pseudo-classes, types] of one complex selector, as
// html-to-text's selector picker ranks its formats.
export function specificity(seq) {
  const sp = [0, 0, 0];
  for (const { compound: c } of seq) {
    sp[0] += c.ids.length;
    sp[1] += c.classes.length + c.attrs.length + c.pseudos.length;
    if (c.tag) sp[2]++;
  }
  return sp;
}
