// RSS and Atom feeds read as n8n's RSS Read node reads them (n8n-nodes-base 2.47
// RssFeedRead/GenericFunctions.ts parseFeedUrl): the feed's text goes through rss-parser 3.13
// (`parseString`), which parses XML with xml2js 0.6 (default options, sax in strict mode, tag
// and attribute names through n8n's sanitizeXmlName) and builds the feed object. Both are
// followed here so the items carry the same fields in the same order:
//   - parseXml(): xml2js's object: every child element is a list (explicitArray), attributes
//     under `$`, text under `_` when the element also has attributes or children, an element
//     with only text is its string, whitespace-only text is dropped next to children, an empty
//     element is "" (its whitespace when it has some), CDATA is text, the root is wrapped
//     (explicitRoot). Strict XML: the five predefined entities and numeric references only.
//   - parseFeed(): rss-parser's buildAtomFeed, buildRSS2 (with iTunes fields), buildRSS1 and
//     buildRSS0_9, with its field lists, snippets and isoDate.
// Limits: HTML entities in snippets are decoded from a table of the common named entities and
// numeric references (rss-parser uses the full HTML5 table of the `entities` package); a
// description given as XML child elements is rebuilt without its original text order.

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const DANGEROUS_XML_NAMES = new Set(["__proto__", "constructor", "prototype"]);
// n8n-workflow sanitizeXmlName, applied to tag and attribute names.
const sanitizeXmlName = (name) => (DANGEROUS_XML_NAMES.has(name) ? `sanitized_${name}` : name);

class XmlError extends Error {}

function decodeXmlEntities(s, line) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][\w.-]*);/g, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(n);
    }
    if (e in XML_ENTITIES) return XML_ENTITIES[e];
    throw new XmlError(`Invalid character entity\nLine: ${line}\nChar: ;`);
  });
}

const isEmptyObj = (o) => o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length === 0;

// xml2js.Parser().parseString with its defaults. Throws on malformed XML.
export function parseXml(input) {
  let s = String(input);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const stack = [];
  let result = null;
  let i = 0;
  const lineAt = (k) => s.slice(0, k).split("\n").length - 1;
  const text = (t, cdata) => {
    const top = stack.at(-1);
    if (!top) {
      if (/\S/.test(t)) throw new XmlError(`Non-whitespace before first tag.\nLine: ${lineAt(i)}`);
      return;
    }
    top.obj._ += t;
    if (cdata) top.cdata = true;
  };
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) {
      text(decodeXmlEntities(s.slice(i), lineAt(i)));
      break;
    }
    if (lt > i) text(decodeXmlEntities(s.slice(i, lt), lineAt(i)));
    if (s.startsWith("<!--", lt)) {
      const end = s.indexOf("-->", lt + 4);
      if (end < 0) throw new XmlError("Unclosed comment");
      i = end + 3;
    } else if (s.startsWith("<![CDATA[", lt)) {
      const end = s.indexOf("]]>", lt + 9);
      if (end < 0) throw new XmlError("Unclosed CDATA");
      text(s.slice(lt + 9, end), true);
      i = end + 3;
    } else if (s.startsWith("<?", lt)) {
      const end = s.indexOf("?>", lt + 2);
      if (end < 0) throw new XmlError("Unclosed processing instruction");
      i = end + 2;
    } else if (s.startsWith("<!", lt)) {
      // DOCTYPE (with an internal subset in brackets) is skipped.
      let depth = 0;
      let k = lt + 2;
      for (; k < s.length; k++) {
        if (s[k] === "[") depth++;
        else if (s[k] === "]") depth--;
        else if (s[k] === ">" && depth <= 0) break;
      }
      i = k + 1;
    } else if (s[lt + 1] === "/") {
      const end = s.indexOf(">", lt);
      if (end < 0) throw new XmlError("Unclosed end tag");
      const name = sanitizeXmlName(s.slice(lt + 2, end).trim());
      const top = stack.pop();
      if (!top || top.name !== name) throw new XmlError(`Unexpected close tag\nLine: ${lineAt(lt)}\nChar: >`);
      close(top);
      i = end + 1;
    } else {
      // A start tag: name, attributes (quoted values), maybe self-closing.
      const m = /^<([^\s/>]+)/.exec(s.slice(lt, lt + 512));
      if (!m) throw new XmlError(`Unencoded <\nLine: ${lineAt(lt)}`);
      if (!stack.length && result) throw new XmlError(`Text data outside of root node.\nLine: ${lineAt(lt)}`);
      let k = lt + m[0].length;
      const attrs = {};
      let selfClosing = false;
      for (;;) {
        while (/\s/.test(s[k] ?? "")) k++;
        if (k >= s.length) throw new XmlError("Unclosed start tag");
        if (s[k] === ">") {
          k++;
          break;
        }
        if (s[k] === "/" && s[k + 1] === ">") {
          selfClosing = true;
          k += 2;
          break;
        }
        const am = /^([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/.exec(s.slice(k));
        if (!am) throw new XmlError(`Attribute without value\nLine: ${lineAt(k)}`);
        attrs[sanitizeXmlName(am[1])] = decodeXmlEntities(am[3] ?? am[4], lineAt(k));
        k += am[0].length;
      }
      const obj = { _: "" };
      if (Object.keys(attrs).length) obj.$ = attrs;
      const node = { name: sanitizeXmlName(m[1]), obj, cdata: false };
      stack.push(node);
      if (selfClosing) close(stack.pop());
      i = k;
    }
  }
  if (stack.length) throw new XmlError("Unclosed root tag");
  if (!result) throw new XmlError("Unable to parse XML.");
  return result;

  function close(node) {
    let obj = node.obj;
    let emptyStr = "";
    if (/^\s*$/.test(obj._) && !node.cdata) {
      emptyStr = obj._;
      delete obj._;
    } else if (Object.keys(obj).length === 1) obj = obj._;
    if (isEmptyObj(obj)) obj = emptyStr;
    const parent = stack.at(-1);
    if (parent) {
      const p = parent.obj;
      // xml2js keeps the text key first; children follow in document order.
      if (!(node.name in p)) p[node.name] = [];
      p[node.name].push(obj);
    } else result = { [node.name]: obj };
  }
}

// ---------- rss-parser 3.13 ----------

const FIELDS = {
  feed: [["author", "creator"], ["dc:publisher", "publisher"], ["dc:creator", "creator"], ["dc:source", "source"], ["dc:title", "title"], ["dc:type", "type"], "title", "description", "author", "pubDate", "webMaster", "managingEditor", "generator", "link", "language", "copyright", "lastBuildDate", "docs", "generator", "ttl", "rating", "skipHours", "skipDays"],
  item: [["author", "creator"], ["dc:creator", "creator"], ["dc:date", "date"], ["dc:language", "language"], ["dc:rights", "rights"], ["dc:source", "source"], ["dc:title", "title"], "title", "link", "pubDate", "author", "summary", ["content:encoded", "content:encoded", { includeSnippet: true }], "enclosure", "dc:creator", "dc:date", "comments"],
  podcastFeed: ["author", "subtitle", "summary", "explicit"].map((f) => [`itunes:${f}`, f]),
  podcastItem: ["author", "subtitle", "summary", "explicit", "duration", "image", "episode", "image", "season", "keywords", "episodeType"].map((f) => [`itunes:${f}`, f]),
};

// The named HTML entities decodeHTML is most often asked for (see the limits above).
const HTML_ENTITIES = { ...XML_ENTITIES, nbsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„", laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™", deg: "°", euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶", middot: "·", bull: "•", times: "×", divide: "÷", plusmn: "±", frac12: "½", frac14: "¼", frac34: "¾", iexcl: "¡", iquest: "¿", shy: "­", aacute: "á", Aacute: "Á", agrave: "à", Agrave: "À", acirc: "â", auml: "ä", Auml: "Ä", atilde: "ã", aring: "å", aelig: "æ", ccedil: "ç", Ccedil: "Ç", eacute: "é", Eacute: "É", egrave: "è", Egrave: "È", ecirc: "ê", euml: "ë", iacute: "í", igrave: "ì", icirc: "î", iuml: "ï", ntilde: "ñ", Ntilde: "Ñ", oacute: "ó", Oacute: "Ó", ograve: "ò", ocirc: "ô", ouml: "ö", Ouml: "Ö", otilde: "õ", oslash: "ø", uacute: "ú", Uacute: "Ú", ugrave: "ù", ucirc: "û", uuml: "ü", Uuml: "Ü", szlig: "ß", yacute: "ý", yuml: "ÿ", thinsp: " ", ensp: " ", emsp: " ", zwnj: "‌", zwj: "‍", lrm: "‎", rlm: "‏", larr: "←", rarr: "→", uarr: "↑", darr: "↓", hearts: "♥" };
const decodeHtml = (s) =>
  s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "\uFFFD";
    }
    return e in HTML_ENTITIES ? HTML_ENTITIES[e] : m;
  });

function stripHtml(str) {
  str = str.replace(/([^\n])<\/?(h|br|p|ul|ol|li|blockquote|section|table|tr|div)(?:.|\n)*?>([^\n])/gm, "$1\n$3");
  return str.replace(/<(?:.|\n)*?>/gm, "");
}
const getSnippet = (str) => decodeHtml(stripHtml(str)).trim();

function getLink(links, rel, fallbackIdx) {
  if (!links) return undefined;
  for (const l of links) if (l?.$?.rel === rel) return l.$.href;
  return links[fallbackIdx] ? links[fallbackIdx].$?.href : undefined;
}

// xml2js.Builder({headless: true, rootName: "div", renderOpts: {pretty: false}}).buildObject.
const escXml = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (v) => escXml(v).replace(/"/g, "&quot;");
function buildXml(name, v) {
  if (v === null || v === undefined || typeof v !== "object") return `<${name}>${escXml(v ?? "")}</${name}>`;
  if (Array.isArray(v)) return v.map((x) => buildXml(name, x)).join("");
  const attrs = v.$ ? Object.entries(v.$).map(([k, x]) => ` ${k}="${escAttr(x)}"`).join("") : "";
  const inner = Object.entries(v).filter(([k]) => k !== "$").map(([k, x]) => (k === "_" ? escXml(x) : buildXml(k, x))).join("");
  return inner ? `<${name}${attrs}>${inner}</${name}>` : `<${name}${attrs}/>`;
}
function getContent(content) {
  if (typeof content?._ === "string") return content._;
  if (content && typeof content === "object") return buildXml("div", content);
  return content;
}

function copyFromXML(xml, dest, fields) {
  for (const f of fields) {
    let from = f;
    let to = f;
    let options = {};
    if (Array.isArray(f)) {
      [from, to] = f;
      if (f.length > 2) options = f[2];
    }
    if (xml[from] !== undefined) dest[to] = options.keepArray ? xml[from] : xml[from][0];
    if (dest[to] && typeof dest[to]._ === "string") dest[to] = dest[to]._;
    if (options.includeSnippet && dest[to] && typeof dest[to] === "string") dest[`${to}Snippet`] = getSnippet(dest[to]);
  }
}

function setISODate(item) {
  const date = item.pubDate || item.date;
  if (!date) return;
  const d = new Date(String(date).trim());
  // new Date(bad).toISOString() throws a RangeError, which rss-parser ignores.
  if (!Number.isNaN(d.getTime())) item.isoDate = d.toISOString();
}

// Custom fields (the node's "Custom Fields" option, comma-separated): rss-parser's
// options.customFields.item; n8n passes no feed-level custom fields.
export function parseFeed(xmlText, { customItemFields = [] } = {}) {
  const result = parseXml(xmlText);
  const opts = { item: customItemFields, feed: [] };
  if (result.feed) return buildAtomFeed(result, opts);
  const ver = result.rss?.$?.version;
  if (result.rss && ver && /^2/.test(ver)) return buildRSS2(result, opts);
  if (result["rdf:RDF"]) {
    const x = result["rdf:RDF"];
    return buildRSS(x.channel[0], x.item, opts);
  }
  if (result.rss && ver && /0\.9/.test(ver)) return buildRSS(result.rss.channel[0], result.rss.channel[0].item, opts);
  throw new Error("Feed not recognized as RSS 1 or 2.");
}

function buildAtomFeed(xmlObj, opts) {
  const feed = { items: [] };
  copyFromXML(xmlObj.feed, feed, opts.feed);
  if (xmlObj.feed.link) {
    feed.link = getLink(xmlObj.feed.link, "alternate", 0);
    feed.feedUrl = getLink(xmlObj.feed.link, "self", 1);
  }
  if (xmlObj.feed.title) {
    let title = xmlObj.feed.title[0] || "";
    if (title._) title = title._;
    if (title) feed.title = title;
  }
  if (xmlObj.feed.updated) feed.lastBuildDate = xmlObj.feed.updated[0];
  feed.items = (xmlObj.feed.entry || []).map((entry) => parseItemAtom(entry, opts));
  return feed;
}

function parseItemAtom(entry, opts) {
  const item = {};
  copyFromXML(entry, item, opts.item);
  if (entry.title) {
    let title = entry.title[0] || "";
    if (title._) title = title._;
    if (title) item.title = title;
  }
  if (entry.link && entry.link.length) item.link = getLink(entry.link, "alternate", 0);
  if (entry.published && entry.published.length && entry.published[0].length) item.pubDate = new Date(entry.published[0]).toISOString();
  if (!item.pubDate && entry.updated && entry.updated.length && entry.updated[0].length) item.pubDate = new Date(entry.updated[0]).toISOString();
  if (entry.author && entry.author.length && entry.author[0].name && entry.author[0].name.length) item.author = entry.author[0].name[0];
  if (entry.content && entry.content.length) {
    item.content = getContent(entry.content[0]);
    item.contentSnippet = getSnippet(item.content);
  }
  if (entry.summary && entry.summary.length) item.summary = getContent(entry.summary[0]);
  if (entry.id) item.id = entry.id[0];
  setISODate(item);
  return item;
}

function buildRSS2(xmlObj, opts) {
  const channel = xmlObj.rss.channel[0];
  const feed = buildRSS(channel, channel.item, opts);
  if (xmlObj.rss.$ && xmlObj.rss.$["xmlns:itunes"]) decorateItunes(feed, channel);
  return feed;
}

function buildRSS(channel, items, opts) {
  items = items || [];
  const feed = { items: [] };
  const feedFields = FIELDS.feed.concat(opts.feed);
  const itemFields = FIELDS.item.concat(opts.item);
  if (channel["atom:link"] && channel["atom:link"][0] && channel["atom:link"][0].$) feed.feedUrl = channel["atom:link"][0].$.href;
  if (channel.image && channel.image[0] && channel.image[0].url) {
    feed.image = {};
    const image = channel.image[0];
    if (image.link) feed.image.link = image.link[0];
    if (image.url) feed.image.url = image.url[0];
    if (image.title) feed.image.title = image.title[0];
    if (image.width) feed.image.width = image.width[0];
    if (image.height) feed.image.height = image.height[0];
  }
  const pagination = {};
  for (const link of channel["atom:link"] ?? []) if (link?.$ && ["self", "first", "next", "prev", "last"].includes(link.$.rel)) pagination[link.$.rel] = link.$.href;
  if (Object.keys(pagination).length) feed.paginationLinks = pagination;
  copyFromXML(channel, feed, feedFields);
  feed.items = items.map((x) => parseItemRss(x, itemFields));
  return feed;
}

function parseItemRss(xmlItem, itemFields) {
  const item = {};
  copyFromXML(xmlItem, item, itemFields);
  if (xmlItem.enclosure) item.enclosure = xmlItem.enclosure[0].$;
  if (xmlItem.description) {
    item.content = getContent(xmlItem.description[0]);
    item.contentSnippet = getSnippet(item.content);
  }
  if (xmlItem.guid) {
    item.guid = xmlItem.guid[0];
    if (item.guid._) item.guid = item.guid._;
  }
  if (xmlItem.$ && xmlItem.$["rdf:about"]) item["rdf:about"] = xmlItem.$["rdf:about"];
  if (xmlItem.category) item.categories = xmlItem.category;
  setISODate(item);
  return item;
}

function decorateItunes(feed, channel) {
  const items = channel.item || [];
  feed.itunes = {};
  if (channel["itunes:owner"]) {
    const owner = {};
    if (channel["itunes:owner"][0]["itunes:name"]) owner.name = channel["itunes:owner"][0]["itunes:name"][0];
    if (channel["itunes:owner"][0]["itunes:email"]) owner.email = channel["itunes:owner"][0]["itunes:email"][0];
    feed.itunes.owner = owner;
  }
  if (channel["itunes:image"]) {
    const href = channel["itunes:image"][0]?.$?.href;
    if (href) feed.itunes.image = href;
  }
  if (channel["itunes:category"]) {
    const withSubs = channel["itunes:category"].map((c) => ({ name: c?.$?.text, subs: c["itunes:category"] ? c["itunes:category"].map((s) => ({ name: s?.$?.text })) : null }));
    feed.itunes.categories = withSubs.map((c) => c.name);
    feed.itunes.categoriesWithSubs = withSubs;
  }
  if (channel["itunes:keywords"]) {
    if (channel["itunes:keywords"].length > 1) feed.itunes.keywords = channel["itunes:keywords"].map((k) => k?.$?.text);
    else {
      let k = channel["itunes:keywords"][0];
      if (k && typeof k._ === "string") k = k._;
      if (k?.$?.text) feed.itunes.keywords = k.$.text.split(",");
      else if (typeof k === "string") feed.itunes.keywords = k.split(",");
    }
  }
  copyFromXML(channel, feed.itunes, FIELDS.podcastFeed);
  items.forEach((item, index) => {
    const entry = feed.items[index];
    entry.itunes = {};
    copyFromXML(item, entry.itunes, FIELDS.podcastItem);
    const href = item["itunes:image"]?.[0]?.$?.href;
    if (href) entry.itunes.image = href;
  });
}
