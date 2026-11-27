// The Summarization Chain v2 as n8n 2.47.7 runs it (@n8n/n8n-nodes-langchain ChainSummarization
// V2 processItem, @n8n/ai-utilities N8nJsonLoader, @langchain/classic loadSummarizationChain and
// JSONLoader, @langchain/textsplitters, @langchain/core PromptTemplate), for the cases it can
// reproduce exactly. Per item:
//
//   documents  the item's JSON (Use Node Input (JSON)) or a Default Data Loader of type JSON:
//              LangChain's JSONLoader takes the string values (objects found by a pointer are
//              read again, so nested strings repeat, as LangChain's does), or an expression's
//              text as one document; then the text splitter splits each document.
//   chain      stuff: one call with every document joined by a blank line. map_reduce: the same
//              single call with the combine prompt while it fits the chain's 3000-token limit;
//              the runtime only knows that for text under 3000 UTF-8 bytes (a token is at least
//              one byte) and refuses longer text, since n8n then counts tokens with the model's
//              tokenizer and summarises chunk by chunk. refine: the question prompt on the first
//              document, the refine prompt on each next one.
//   prompts    n8n's parameters, evaluated on the item, then formatted as LangChain f-strings
//              ({text}, {existing_answer}; {{ and }} are literal braces). Each call sends the
//              prompt as the user's message, nothing else.
//   output     {response: {text}} (v2, or v2.1 without batching) or {output: {text}} (v2.1 with
//              batches); refine gives {output_text}.
//
// spec (definition, step.model.summarize): {method, prompts: {prompt, combineMapPrompt,
// refinePrompt, refineQuestionPrompt}, docs: {jsonMode, jsonData, pointers, splitter},
// outputKey}; splitter: {kind: "recursive", chunkSize, chunkOverlap, keepSeparator} |
// {kind: "character", separator, chunkSize, chunkOverlap} | {kind: "token", chunkSize,
// chunkOverlap} | null.

export const DEFAULT_PROMPT = 'Write a concise summary of the following:\n\n\n"{text}"\n\n\nCONCISE SUMMARY:';
export const REFINE_PROMPT = 'Your job is to produce a final summary\nWe have provided an existing summary up to a certain point: "{existing_answer}"\nWe have the opportunity to refine the existing summary\n(only if needed) with some more context below.\n------------\n"{text}"\n------------\n\nGiven the new context, refine the original summary\nIf the context isn\'t useful, return the original summary.\n\nREFINED SUMMARY:';
const MAP_REDUCE_MAX_TOKENS = 3000;

// ---------- @langchain/core f-string templates ----------

export function parseFString(template) {
  const chars = String(template).split("");
  const nodes = [];
  const next = (set, start) => {
    for (let i = start; i < chars.length; i += 1) if (set.includes(chars[i])) return i;
    return -1;
  };
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === "{" && chars[i + 1] === "{") nodes.push({ type: "literal", text: "{" }), (i += 2);
    else if (chars[i] === "}" && chars[i + 1] === "}") nodes.push({ type: "literal", text: "}" }), (i += 2);
    else if (chars[i] === "{") {
      const j = next("}", i);
      if (j < 0) throw new Error("Unclosed '{' in template.");
      nodes.push({ type: "variable", name: chars.slice(i + 1, j).join("") });
      i = j + 1;
    } else if (chars[i] === "}") throw new Error("Single '}' in template.");
    else {
      const j = next("{}", i);
      nodes.push({ type: "literal", text: (j < 0 ? chars.slice(i) : chars.slice(i, j)).join("") });
      i = j < 0 ? chars.length : j;
    }
  }
  return nodes;
}
export function formatFString(template, values) {
  return parseFString(template).reduce((out, n) => {
    if (n.type !== "variable") return out + n.text;
    if (!(n.name in values)) throw new Error(`(f-string) Missing value for input ${n.name}`);
    return out + (typeof values[n.name] === "string" ? values[n.name] : JSON.stringify(values[n.name]));
  }, "");
}
// PromptTemplate's constructor check: the template renders with every declared input set.
function checkTemplate(template, inputs) {
  formatFString(template, Object.fromEntries(inputs.map((k) => [k, "foo"])));
  return template;
}

// ---------- @langchain/classic JSONLoader ----------

function compilePointer(p) {
  if (p[0] !== "/") throw new Error("Invalid JSON pointer: " + p);
  const parts = p.slice(1).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  return (json) => {
    let v = json;
    for (const k of parts) {
      if (v === null || typeof v !== "object") return undefined;
      v = v[k];
    }
    return v;
  };
}
// jsonpointer's get: "" is the document itself.
const pointerGet = (p) => (p === "" ? (json) => json : compilePointer(p));

export function jsonStrings(json, pointerList) {
  const pointers = pointerList.map(pointerGet);
  const extract = (v, all, found = false) => {
    if (!v) return [];
    if (typeof v === "string" && all) return [v];
    if (Array.isArray(v) && all) return v.flatMap((x) => extract(x, true));
    if (typeof v === "object") {
      if (all) return extract(Object.values(v), true);
      const targeted = pointers.map((g) => g(v)).filter(Boolean);
      const rest = Object.values(v).filter((x) => !targeted.includes(x));
      if (targeted.length) return [...targeted.flatMap((x) => extract(x, true, true)), ...rest.flatMap((x) => extract(x, false, true))];
      if (all || !found) return rest.flatMap((x) => extract(x, all));
      return [];
    }
    return [];
  };
  return extract(json, !(pointers.length > 0));
}

// ---------- @langchain/textsplitters ----------

function splitOnSeparator(text, separator, keep) {
  let splits;
  if (separator) splits = keep ? text.split(new RegExp(`(?=${separator.replace(/[/\-\\^$*+?.()|[\]{}]/g, "\\$&")})`)) : text.split(separator);
  else splits = text.split("");
  return splits.filter((s) => s !== "");
}
function mergeSplits(splits, separator, { chunkSize, chunkOverlap }) {
  const docs = [];
  let current = [];
  let total = 0;
  const join = (list) => {
    const t = list.join(separator).trim();
    return t === "" ? null : t;
  };
  for (const d of splits) {
    const len = d.length;
    if (total + len + current.length * separator.length > chunkSize && current.length > 0) {
      const doc = join(current);
      if (doc !== null) docs.push(doc);
      while (total > chunkOverlap || (total + len + current.length * separator.length > chunkSize && total > 0)) {
        total -= current[0].length;
        current.shift();
      }
    }
    current.push(d);
    total += len;
  }
  const doc = join(current);
  if (doc !== null) docs.push(doc);
  return docs;
}
function recursiveSplit(text, separators, opts) {
  const out = [];
  let separator = separators[separators.length - 1];
  let rest;
  for (let i = 0; i < separators.length; i += 1) {
    const s = separators[i];
    if (s === "") {
      separator = s;
      break;
    }
    if (text.includes(s)) {
      separator = s;
      rest = separators.slice(i + 1);
      break;
    }
  }
  const splits = splitOnSeparator(text, separator, opts.keepSeparator);
  const sep = opts.keepSeparator ? "" : separator;
  let good = [];
  for (const s of splits) {
    if (s.length < opts.chunkSize) good.push(s);
    else {
      if (good.length) out.push(...mergeSplits(good, sep, opts)), (good = []);
      if (!rest) out.push(s);
      else out.push(...recursiveSplit(s, rest, opts));
    }
  }
  if (good.length) out.push(...mergeSplits(good, sep, opts));
  return out;
}
// n8n's TokenTextSplitter (cl100k_base): a text of at most chunkSize UTF-8 bytes is at most
// chunkSize tokens, so it stays one chunk (tiktoken decodes it back unchanged); anything longer
// needs the tokenizer, which the runtime does not carry.
function hasLongSequentialRepeat(text, threshold = 1000) {
  if (typeof text !== "string" || text.length < threshold) return false;
  let prev;
  let count = 0;
  for (const ch of text) {
    if (ch === prev) {
      if (++count >= threshold) return true;
    } else (prev = ch), (count = 1);
  }
  return false;
}
export function splitText(text, splitter, refuse) {
  if (!splitter) return [text];
  const { chunkSize, chunkOverlap } = splitter;
  if (chunkOverlap >= chunkSize) throw new Error("Cannot have chunkOverlap >= chunkSize");
  if (splitter.kind === "recursive") return recursiveSplit(text, ["\n\n", "\n", " ", ""], splitter);
  if (splitter.kind === "character") return mergeSplits(splitOnSeparator(text, splitter.separator ?? "\n\n", false), splitter.separator ?? "\n\n", splitter);
  if (splitter.kind === "token") {
    if (!text) return [];
    if (!hasLongSequentialRepeat(text) && Buffer.byteLength(text, "utf8") <= chunkSize) return [text];
    throw refuse(`the Token Splitter's chunks of a text over ${chunkSize} bytes (it counts tokens with its tokenizer)`);
  }
  throw refuse(`text splitter ${splitter.kind}`);
}

// ---------- one item ----------

export function documentsOf(docs, item, evaluate, refuse) {
  let texts;
  const mode = docs.jsonMode ?? "allInputData";
  const pointers = String(docs.pointers ?? "").split(",").map((p) => p.trim());
  if (mode === "allInputData") texts = jsonStrings(JSON.parse(JSON.stringify(item.json ?? {}).trim()), pointers);
  else if (mode === "expressionData") {
    const data = evaluate(docs.jsonData);
    if (data !== null && typeof data === "object") texts = jsonStrings(JSON.parse(JSON.stringify(data).trim()), pointers);
    else if (typeof data === "string") texts = [data];
    else throw new Error("Document loader is not initialized");
  } else throw refuse(`JSON mode "${mode}"`);
  return texts.flatMap((t) => splitText(t, docs.splitter, refuse));
}

// Runs the chain for one item; `call(prompt)` asks the model and returns its text.
export async function summarizeItem(spec, item, { evaluate, call, refuse }) {
  const ev = (raw, dflt) => {
    if (raw === undefined || raw === null || raw === "") return dflt;
    const v = evaluate(raw);
    return v === undefined || v === null || v === "" ? dflt : String(v);
  };
  const p = spec.prompts ?? {};
  const docs = documentsOf(spec.docs ?? {}, item, evaluate, refuse);
  const method = spec.method ?? "map_reduce";
  if (method === "stuff" || method === "map_reduce") {
    const tmpl = checkTemplate(ev(p.prompt, DEFAULT_PROMPT), ["text"]);
    if (method === "map_reduce") checkTemplate(ev(p.combineMapPrompt, DEFAULT_PROMPT), ["text"]);
    const prompt = formatFString(tmpl, { text: docs.join("\n\n") });
    if (method === "map_reduce" && Buffer.byteLength(prompt, "utf8") >= MAP_REDUCE_MAX_TOKENS) throw refuse(`map-reduce over text that may exceed the chain's ${MAP_REDUCE_MAX_TOKENS}-token limit (${Buffer.byteLength(prompt, "utf8")} bytes; n8n counts tokens with the model's tokenizer and summarises chunk by chunk)`);
    return { text: await call(prompt) };
  }
  if (method === "refine") {
    const question = checkTemplate(ev(p.refineQuestionPrompt, DEFAULT_PROMPT), ["text"]);
    const refine = checkTemplate(ev(p.refinePrompt, REFINE_PROMPT), ["existing_answer", "text"]);
    if (!docs.length) throw new Error("Cannot read properties of undefined (reading 'pageContent')");
    let res = await call(formatFString(question, { text: docs[0] }));
    for (const d of docs.slice(1)) res = await call(formatFString(refine, { existing_answer: res, text: d }));
    return { output_text: res };
  }
  throw refuse(`summarization method "${method}"`);
}
