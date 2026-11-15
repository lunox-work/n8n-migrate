// n8n's Markdown node, HTML to Markdown: node-html-markdown 1.2.0 on node-html-parser 5.4.2, the
// versions n8n 2.47.7 ships, their compiled CommonJS modules kept as they are inside a small
// module table, so the Markdown is byte for byte theirs. Their two dependencies are replaced: he's
// decode by htmldom.mjs decodeEntities (the same WHATWG references and legacy rules), css-select
// by a stub that refuses (node-html-markdown never selects). No browser parser is used
// (preferNativeParser stays off), and process.env is an empty object.
//
// node-html-markdown: MIT License, Copyright (c) 2021 Ron S. node-html-parser: MIT License,
// Copyright (c) 2019 Tao Qiufeng. Permission is hereby granted, free of charge, to any person
// obtaining a copy of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights to use, copy,
// modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
// KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
// FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
// BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
// IN THE SOFTWARE.

import { decodeEntities, UnsupportedHtml } from "./htmldom.mjs";

const NHM_MODULES = {
  "nhm/main": function (module, exports, require, process, window, document) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NodeHtmlMarkdown = void 0;
const translator_1 = require("./translator");
const config_1 = require("./config");
const utilities_1 = require("./utilities");
const visitor_1 = require("./visitor");
// endregion
/* ****************************************************************************************************************** */
// region: NodeHtmlMarkdown (class)
/* ****************************************************************************************************************** */
class NodeHtmlMarkdown {
    constructor(options, customTranslators, customCodeBlockTranslators) {
        var _a, _b, _c, _d;
        this.translators = new translator_1.TranslatorCollection();
        this.aTagTranslators = new translator_1.TranslatorCollection();
        this.codeBlockTranslators = new translator_1.TranslatorCollection();
        this.tableTranslators = new translator_1.TranslatorCollection();
        this.tableRowTranslators = new translator_1.TranslatorCollection();
        this.tableCellTranslators = new translator_1.TranslatorCollection();
        /* Setup Options */
        this.options = Object.assign(Object.assign({}, config_1.defaultOptions), options);
        const ignoredElements = (_b = (_a = this.options.ignore) === null || _a === void 0 ? void 0 : _a.concat(config_1.defaultIgnoreElements)) !== null && _b !== void 0 ? _b : config_1.defaultIgnoreElements;
        const blockElements = (_d = (_c = this.options.blockElements) === null || _c === void 0 ? void 0 : _c.concat(config_1.defaultBlockElements)) !== null && _d !== void 0 ? _d : config_1.defaultBlockElements;
        /* Setup Translator Bases */
        ignoredElements === null || ignoredElements === void 0 ? void 0 : ignoredElements.forEach(el => {
            this.translators.set(el, { ignore: true, recurse: false });
            this.codeBlockTranslators.set(el, { ignore: true, recurse: false });
        });
        blockElements === null || blockElements === void 0 ? void 0 : blockElements.forEach(el => {
            this.translators.set(el, { surroundingNewlines: 2 });
            this.codeBlockTranslators.set(el, { surroundingNewlines: 2 });
        });
        /* Add and merge bases with default and custom translator configs */
        for (const [elems, cfg] of Object.entries(Object.assign(Object.assign({}, config_1.defaultTranslators), customTranslators)))
            this.translators.set(elems, cfg, true);
        for (const [elems, cfg] of Object.entries(Object.assign(Object.assign({}, config_1.defaultCodeBlockTranslators), customCodeBlockTranslators)))
            this.codeBlockTranslators.set(elems, cfg, true);
        for (const [elems, cfg] of Object.entries(config_1.aTagTranslatorConfig))
            this.aTagTranslators.set(elems, cfg, true);
        for (const [elems, cfg] of Object.entries(config_1.tableTranslatorConfig))
            this.tableTranslators.set(elems, cfg, true);
        for (const [elems, cfg] of Object.entries(config_1.tableRowTranslatorConfig))
            this.tableRowTranslators.set(elems, cfg, true);
        for (const [elems, cfg] of Object.entries(config_1.tableCellTranslatorConfig))
            this.tableCellTranslators.set(elems, cfg, true);
        // TODO - Workaround for upstream issue (may not be fixed) - https://github.com/taoqf/node-html-parser/issues/78
        if (!this.options.textReplace)
            this.options.textReplace = [];
        this.options.textReplace.push([/^<!DOCTYPE.*>/gmi, '']);
    }
    static translate(htmlOrFiles, opt, customTranslators, customCodeBlockTranslators) {
        return NodeHtmlMarkdown.prototype.translateWorker.call(new NodeHtmlMarkdown(opt, customTranslators, customCodeBlockTranslators), htmlOrFiles);
    }
    translate(htmlOrFiles) {
        return this.translateWorker(htmlOrFiles);
    }
    // endregion
    /* ********************************************************* */
    // region: Internal Methods
    /* ********************************************************* */
    translateWorker(htmlOrFiles) {
        const inputIsCollection = typeof htmlOrFiles !== 'string';
        const inputFiles = !inputIsCollection ? { 'default': htmlOrFiles } : htmlOrFiles;
        const outputFiles = {};
        for (const [fileName, html] of Object.entries(inputFiles)) {
            const parsedHtml = (0, utilities_1.parseHTML)(html, this.options);
            outputFiles[fileName] = (0, visitor_1.getMarkdownForHtmlNodes)(this, parsedHtml, fileName !== 'default' ? fileName : void 0);
        }
        return inputIsCollection ? outputFiles : outputFiles['default'];
    }
}
exports.NodeHtmlMarkdown = NodeHtmlMarkdown;
// endregion
  },
  "nhm/config": function (module, exports, require, process, window, document) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.nodeHtmlParserConfig = exports.aTagTranslatorConfig = exports.defaultCodeBlockTranslators = exports.tableCellTranslatorConfig = exports.tableRowTranslatorConfig = exports.tableTranslatorConfig = exports.defaultTranslators = exports.defaultOptions = exports.contentlessElements = exports.defaultIgnoreElements = exports.defaultBlockElements = void 0;
const utilities_1 = require("./utilities");
const translator_1 = require("./translator");
/* ****************************************************************************************************************** */
// region: Elements
/* ****************************************************************************************************************** */
exports.defaultBlockElements = [
    'ADDRESS', 'ARTICLE', 'ASIDE', 'AUDIO', 'BLOCKQUOTE', 'BODY', 'CANVAS', 'CENTER', 'DD', 'DIR', 'DIV', 'DL',
    'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'FRAMESET', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'HEADER', 'HGROUP', 'HR', 'HTML', 'ISINDEX', 'LI', 'MAIN', 'MENU', 'NAV', 'NOFRAMES', 'NOSCRIPT', 'OL',
    'OUTPUT', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL'
];
exports.defaultIgnoreElements = [
    'AREA', 'BASE', 'COL', 'COMMAND', 'EMBED', 'HEAD', 'INPUT', 'KEYGEN', 'LINK', 'META', 'PARAM', 'SCRIPT',
    'SOURCE', 'STYLE', 'TRACK', 'WBR'
];
exports.contentlessElements = ['BR', 'HR', 'IMG'];
// endregion
/* ****************************************************************************************************************** */
// region: Options
/* ****************************************************************************************************************** */
// noinspection RegExpUnnecessaryNonCapturingGroup
exports.defaultOptions = Object.freeze({
    preferNativeParser: false,
    codeFence: '```',
    bulletMarker: '*',
    indent: '  ',
    codeBlockStyle: 'fenced',
    emDelimiter: '_',
    strongDelimiter: '**',
    maxConsecutiveNewlines: 3,
    /**
     * Character:               Affects:                       Example:
     *
     *     \                      Escaping                        \-
     *     `                      Code                            `` code ``,  ```lang\n code block \n```
     *     *                      Bullet & Separators             * item,  ***
     *     _                      Bold, Italics, Separator        _italic_,  __bold__,  ^___
     *     ~                      Strikethrough, Code             ~~strike~~,  ~~~lang\n code block \n~~~
     *     [                      Url                             [caption](url)
     *     ]                      Url                             [caption](url)
     */
    globalEscape: [/[\\`*_~\[\]]/gm, '\\$&'],
    /**
     * Note:  The following compiled pattern was selected after perf testing various alternatives.
     *        Please be mindful of performance if updating/changing it.
     *
     * Sequence:                Affects:                        Example:
     *
     *    +(space)                Bullets                         + item
     *    =                       Heading                         heading\n====
     *    #{1,6}(space)           Heading                         ## Heading
     *    >                       Blockquote                      > quote
     *    -                       Bullet, Header, Separator       - item, heading\n---, ---
     *    \d+\.(space)            Numbered list item              1. Item
     */
    lineStartEscape: [
        /^(\s*?)((?:\+\s)|(?:[=>-])|(?:#{1,6}\s))|(?:(\d+)(\.\s))/gm,
        '$1$3\\$2$4'
    ]
});
// endregion
/* ****************************************************************************************************************** */
// region: Translators
/* ****************************************************************************************************************** */
exports.defaultTranslators = {
    /* Pre-formatted text */
    'pre': { noEscape: true, preserveWhitespace: true },
    /* Line break */
    'br': { content: `  \n`, recurse: false },
    /* Horizontal Rule*/
    'hr': { content: '---', recurse: false },
    /* Headings */
    'h1,h2,h3,h4,h5,h6': ({ node }) => ({
        prefix: '#'.repeat(+node.tagName.charAt(1)) + ' '
    }),
    /* Bold / Strong */
    'strong,b': {
        spaceIfRepeatingChar: true,
        postprocess: ({ content, options: { strongDelimiter } }) => (0, utilities_1.isWhiteSpaceOnly)(content)
            ? translator_1.PostProcessResult.RemoveNode
            : (0, utilities_1.tagSurround)(content, strongDelimiter)
    },
    /* Strikethrough */
    'del,s,strike': {
        spaceIfRepeatingChar: true,
        postprocess: ({ content }) => (0, utilities_1.isWhiteSpaceOnly)(content)
            ? translator_1.PostProcessResult.RemoveNode
            : (0, utilities_1.tagSurround)(content, '~~')
    },
    /* Italic / Emphasis */
    'em,i': {
        spaceIfRepeatingChar: true,
        postprocess: ({ content, options: { emDelimiter } }) => (0, utilities_1.isWhiteSpaceOnly)(content)
            ? translator_1.PostProcessResult.RemoveNode
            : (0, utilities_1.tagSurround)(content, emDelimiter)
    },
    /* Lists (ordered & unordered) */
    'ol,ul': ({ listKind }) => ({
        surroundingNewlines: listKind ? 1 : 2,
    }),
    /* List Item */
    'li': ({ options: { bulletMarker }, indentLevel, listKind, listItemNumber }) => {
        const indentationLevel = +(indentLevel || 0);
        return {
            prefix: '   '.repeat(+(indentLevel || 0)) +
                (((listKind === 'OL') && (listItemNumber !== undefined)) ? `${listItemNumber}. ` : `${bulletMarker} `),
            surroundingNewlines: 1,
            postprocess: ({ content }) => (0, utilities_1.isWhiteSpaceOnly)(content)
                ? translator_1.PostProcessResult.RemoveNode
                : content
                    .trim()
                    .replace(/([^\r\n])(?:\r?\n)+/g, `$1  \n${'   '.repeat(indentationLevel)}`)
                    .replace(/(\S+?)[^\S\r\n]+$/gm, '$1  ')
        };
    },
    /* Block Quote */
    'blockquote': {
        postprocess: ({ content }) => (0, utilities_1.trimNewLines)(content).replace(/^(>*)[^\S\r\n]?/gm, `>$1 `)
    },
    /* Code (block / inline) */
    'code': ({ node, parent, options: { codeFence, codeBlockStyle }, visitor }) => {
        var _a, _b;
        const isCodeBlock = ['PRE', 'WRAPPED-PRE'].includes(parent === null || parent === void 0 ? void 0 : parent.tagName) && parent.childNodes.length < 2;
        /* Handle code (non-block) */
        if (!isCodeBlock)
            return {
                spaceIfRepeatingChar: true,
                noEscape: true,
                postprocess: ({ content }) => {
                    var _a, _b;
                    // Find longest occurring sequence of running backticks and add one more (so content is escaped)
                    const delimiter = '`' + (((_b = (_a = content.match(/`+/g)) === null || _a === void 0 ? void 0 : _a.sort((a, b) => b.length - a.length)) === null || _b === void 0 ? void 0 : _b[0]) || '');
                    const padding = delimiter.length > 1 ? ' ' : '';
                    return (0, utilities_1.surround)((0, utilities_1.surround)(content, padding), delimiter);
                }
            };
        /* Handle code block */
        if (codeBlockStyle === 'fenced') {
            const language = ((_b = (_a = node.getAttribute('class')) === null || _a === void 0 ? void 0 : _a.match(/language-(\S+)/)) === null || _b === void 0 ? void 0 : _b[1]) || '';
            return {
                noEscape: true,
                prefix: codeFence + language + '\n',
                postfix: '\n' + codeFence,
                childTranslators: visitor.instance.codeBlockTranslators
            };
        }
        else {
            return {
                noEscape: true,
                postprocess: ({ content }) => content.replace(/^/gm, '    '),
                childTranslators: visitor.instance.codeBlockTranslators
            };
        }
    },
    /* Table */
    'table': ({ visitor }) => ({
        surroundingNewlines: 2,
        childTranslators: visitor.instance.tableTranslators,
        postprocess: ({ content, nodeMetadata, node }) => {
            // Split and trim leading + trailing pipes
            const rawRows = (0, utilities_1.splitSpecial)(content).map(({ text }) => text.replace(/^(?:\|\s+)?(.+)\s*\|\s*$/, '$1'));
            /* Get Row Data */
            const rows = [];
            let colWidth = [];
            for (const row of rawRows) {
                if (!row)
                    continue;
                /* Track columns */
                const cols = row.split(' |').map((c, i) => {
                    c = c.trim();
                    if (colWidth.length < i + 1 || colWidth[i] < c.length)
                        colWidth[i] = c.length;
                    return c;
                });
                rows.push(cols);
            }
            if (rows.length < 1)
                return translator_1.PostProcessResult.RemoveNode;
            /* Compose Table */
            const maxCols = colWidth.length;
            let res = '';
            const caption = nodeMetadata.get(node).tableMeta.caption;
            if (caption)
                res += caption + '\n';
            rows.forEach((cols, rowNumber) => {
                var _a;
                res += '| ';
                /* Add Columns */
                for (let i = 0; i < maxCols; i++) {
                    let c = ((_a = cols[i]) !== null && _a !== void 0 ? _a : '');
                    c += ' '.repeat(Math.max(0, (colWidth[i] - c.length))); // Pad to max length
                    res += c + ' |' + (i < maxCols - 1 ? ' ' : '');
                }
                res += '\n';
                // Add separator row
                if (rowNumber === 0)
                    res += '|' + colWidth.map(w => ' ' + '-'.repeat(w) + ' |').join('') + '\n';
            });
            return res;
        }
    }),
    /* Link */
    'a': ({ node, options, visitor }) => {
        const href = node.getAttribute('href');
        if (!href)
            return {};
        // Encodes symbols that can cause problems in markdown
        let encodedHref = '';
        for (const chr of href) {
            switch (chr) {
                case '(':
                    encodedHref += '%28';
                    break;
                case ')':
                    encodedHref += '%29';
                    break;
                case '_':
                    encodedHref += '%5F';
                    break;
                case '*':
                    encodedHref += '%2A';
                    break;
                default:
                    encodedHref += chr;
            }
        }
        const title = node.getAttribute('title');
        // Inline link, when possible
        // See: https://github.com/crosstype/node-html-markdown/issues/17
        if (node.textContent === href)
            return { content: `<${encodedHref}>` };
        return {
            postprocess: ({ content }) => content.replace(/(?:\r?\n)+/g, ' '),
            childTranslators: visitor.instance.aTagTranslators,
            prefix: '[',
            postfix: ']' + (!options.useLinkReferenceDefinitions
                ? `(${encodedHref}${title ? ` "${title}"` : ''})`
                : `[${visitor.addOrGetUrlDefinition(encodedHref)}]`)
        };
    },
    /* Image */
    'img': ({ node, options }) => {
        const src = node.getAttribute('src') || '';
        if (!src || (!options.keepDataImages && /^data:/i.test(src)))
            return { ignore: true };
        const alt = node.getAttribute('alt') || '';
        const title = node.getAttribute('title') || '';
        return {
            content: `![${alt}](${src}${title && ` "${title}"`})`,
            recurse: false
        };
    },
};
exports.tableTranslatorConfig = {
    /* Table Caption */
    'caption': ({ visitor }) => ({
        surroundingNewlines: false,
        childTranslators: visitor.instance.tableCellTranslators,
        postprocess: ({ content, nodeMetadata, node }) => {
            const caption = content.replace(/(?:\r?\n)+/g, ' ').trim();
            if (caption)
                nodeMetadata.get(node).tableMeta.caption = '__' + caption + '__';
            return translator_1.PostProcessResult.RemoveNode;
        },
    }),
    /* Table row */
    'tr': ({ visitor }) => ({
        surroundingNewlines: false,
        childTranslators: visitor.instance.tableRowTranslators,
        postfix: '\n',
        prefix: '| ',
        postprocess: ({ content }) => !/ \|\s*$/.test(content) ? translator_1.PostProcessResult.RemoveNode : content
    }),
    /* Table cell, (header cell) */
    'th,td': ({ visitor }) => ({
        surroundingNewlines: false,
        childTranslators: visitor.instance.tableCellTranslators,
        prefix: ' ',
        postfix: ' |',
        postprocess: ({ content }) => (0, utilities_1.trimNewLines)(content)
            .replace('|', '\\|')
            .replace(/(?:\r?\n)+/g, ' ')
            .trim()
    }),
};
exports.tableRowTranslatorConfig = {
    'th,td': exports.tableTranslatorConfig['th,td']
};
exports.tableCellTranslatorConfig = {
    'a': exports.defaultTranslators['a'],
    'strong,b': exports.defaultTranslators['strong,b'],
    'del,s,strike': exports.defaultTranslators['del,s,strike'],
    'em,i': exports.defaultTranslators['em,i'],
    'img': exports.defaultTranslators['img']
};
exports.defaultCodeBlockTranslators = {
    'br': { content: `\n`, recurse: false },
    'hr': { content: '---', recurse: false },
    'h1,h2,h3,h4,h5,h6': { prefix: '[', postfix: ']' },
    'ol,ul': exports.defaultTranslators['ol,ul'],
    'li': exports.defaultTranslators['li'],
    'tr': { surroundingNewlines: true },
    'img': { recurse: false }
};
exports.aTagTranslatorConfig = {
    'br': { content: '\n', recurse: false },
    'hr': { content: '\n', recurse: false },
    'pre': exports.defaultTranslators['pre'],
    'strong,b': exports.defaultTranslators['strong,b'],
    'del,s,strike': exports.defaultTranslators['del,s,strike'],
    'em,i': exports.defaultTranslators['em,i'],
    'img': exports.defaultTranslators['img']
};
// endregion
/* ****************************************************************************************************************** */
// region: General
/* ****************************************************************************************************************** */
/**
 * Note: Do not change - values are tuned for performance
 */
exports.nodeHtmlParserConfig = {
    lowerCaseTagName: false,
    comment: false,
    blockTextElements: {
        script: false,
        noscript: false,
        style: false
    }
};
// endregion
  },
  "nhm/utilities": function (module, exports, require, process, window, document) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.perfStop = exports.perfStart = exports.getChildNodes = exports.parseHTML = exports.truthyStr = exports.getTrailingWhitespaceInfo = exports.tagSurround = exports.splitSpecial = exports.isWhiteSpaceOnly = exports.surround = exports.trimNewLines = void 0;
const config_1 = require("./config");
/* ****************************************************************************************************************** */
// region: String Utils
/* ****************************************************************************************************************** */
const trimNewLines = (s) => s.replace(/^\n+|\n+$/g, '');
exports.trimNewLines = trimNewLines;
const surround = (source, surroundStr) => `${surroundStr}${source}${surroundStr}`;
exports.surround = surround;
const isWhiteSpaceOnly = (s) => !/\S/.test(s);
exports.isWhiteSpaceOnly = isWhiteSpaceOnly;
/**
 * Split string, preserving specific newline used for each line
 */
function splitSpecial(s) {
    const lines = [];
    const strLen = s.length;
    for (let i = 0, startPos = 0; i < strLen; ++i) {
        let char = s.charAt(i);
        let newLineChar = '';
        if (char === '\r')
            newLineChar = (s.charAt(i + 1) === '\n') ? '\r\n' : char;
        else if (char === '\n')
            newLineChar = char;
        const endPos = newLineChar ? i :
            i === (strLen - 1) ? i + 1 :
                undefined;
        if (endPos === undefined)
            continue;
        lines.push({
            text: s.slice(startPos, endPos),
            newLineChar
        });
        startPos = endPos + newLineChar.length;
        if (newLineChar.length > 1)
            ++i;
    }
    return lines;
}
exports.splitSpecial = splitSpecial;
/**
 * Surround tag content with delimiter (moving any leading/trailing space to outside the tag
 */
function tagSurround(content, surroundStr) {
    // If un-escaped surroundStr already occurs, remove all instances
    // See: https://github.com/crosstype/node-html-markdown/issues/18
    const nestedSurroundStrIndex = content.indexOf(surroundStr);
    if (nestedSurroundStrIndex >= 0)
        content = content.replace(new RegExp(`([^\\\\])\\${surroundStr.split('').join('\\')}`, 'gm'), '$1');
    const lines = splitSpecial(content);
    let res = '';
    for (const { text, newLineChar } of lines) {
        let i = 0;
        let startPos = undefined;
        let endPos = undefined;
        while (i >= 0 && i < text.length) {
            if (/[\S]/.test(text[i])) {
                if (startPos === undefined) {
                    startPos = i;
                    i = text.length;
                }
                else {
                    endPos = i;
                    i = NaN;
                }
            }
            if (startPos === undefined)
                ++i;
            else
                --i;
        }
        // If whole string is non-breaking whitespace, don't surround it
        if (startPos === undefined) {
            res += text + newLineChar;
            continue;
        }
        if (endPos === undefined)
            endPos = text.length - 1;
        const leadingSpace = startPos > 0 ? text[startPos - 1] : '';
        const trailingSpace = endPos < (text.length - 1) ? text[endPos + 1] : '';
        const slicedText = text.slice(startPos, endPos + 1);
        res += leadingSpace + surroundStr + slicedText + surroundStr + trailingSpace + newLineChar;
    }
    return res;
}
exports.tagSurround = tagSurround;
const getTrailingWhitespaceInfo = (s) => {
    const res = { whitespace: 0, newLines: 0 };
    const minI = Math.max(s.length - 10, 0);
    for (let i = s.length - 1; i >= minI; --i) {
        const token = s.slice(i, i + 1);
        if (!/\s/.test(token))
            break;
        ++res.whitespace;
        if (['\r', '\n'].includes(token))
            ++res.newLines;
    }
    return res;
};
exports.getTrailingWhitespaceInfo = getTrailingWhitespaceInfo;
/**
 * If value is truthy, returns `value` (or `v` if no `value` provided), otherwise, returns an empty string
 * @param v - Var to check for truthiness
 * @param value - Value to return if true
 */
const truthyStr = (v, value) => v ? ((value !== undefined) ? value : String(v)) : '';
exports.truthyStr = truthyStr;
// endregion
/* ****************************************************************************************************************** */
// region: Parser
/* ****************************************************************************************************************** */
function tryParseWithNativeDom(html) {
    try {
        if (!((window === null || window === void 0 ? void 0 : window.DOMParser) && (new window.DOMParser()).parseFromString('', 'text/html')))
            return void 0;
    }
    catch (_a) {
        return void 0;
    }
    /* Get a document */
    let doc;
    try {
        doc = document.implementation.createHTMLDocument('').open();
    }
    catch (e) {
        const { ActiveXObject } = window;
        if (ActiveXObject) {
            const doc = ActiveXObject('htmlfile');
            doc.designMode = 'on'; // disable on-page scripts
            return doc.open();
        }
        throw e;
    }
    // Prepare document, ensuring we have a wrapper node
    doc.write('<node-html-markdown>' + html + '</node-html-markdown>');
    doc.close();
    return doc.documentElement;
}
const getNodeHtmlParser = () => {
    try {
        return require('node-html-parser').parse;
    }
    catch (_a) {
        return undefined;
    }
};
/**
 * Parser string to HTMLElement
 */
function parseHTML(html, options) {
    let nodeHtmlParse;
    /* If specified, try to parse with native engine, fallback to node-html-parser */
    perfStart('parse');
    let el;
    if (options.preferNativeParser) {
        try {
            el = tryParseWithNativeDom(html);
        }
        catch (e) {
            nodeHtmlParse = getNodeHtmlParser();
            if (nodeHtmlParse)
                console.warn('Native DOM parser encountered an error during parse', e);
            else
                throw e;
        }
    }
    else
        nodeHtmlParse = getNodeHtmlParser();
    if (!el)
        el = nodeHtmlParse(html, config_1.nodeHtmlParserConfig);
    perfStop('parse');
    return el;
}
exports.parseHTML = parseHTML;
function getChildNodes(node) {
    if (!isNodeList(node.childNodes))
        return node.childNodes;
    const res = [];
    node.childNodes.forEach(n => res.push(n));
    return res;
    function isNodeList(v) {
        return (v != null) || (typeof v[Symbol.iterator] === 'function');
    }
}
exports.getChildNodes = getChildNodes;
function perfStart(label) {
    if (process.env.LOG_PERF)
        console.time(label);
}
exports.perfStart = perfStart;
function perfStop(label) {
    if (process.env.LOG_PERF)
        console.timeEnd(label);
}
exports.perfStop = perfStop;
// endregion
  },
  "nhm/visitor": function (module, exports, require, process, window, document) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMarkdownForHtmlNodes = exports.Visitor = void 0;
const nodes_1 = require("./nodes");
const utilities_1 = require("./utilities");
const translator_1 = require("./translator");
const config_1 = require("./config");
// endregion
/* ****************************************************************************************************************** */
// region: Visitor
/* ****************************************************************************************************************** */
/**
 * Properties & methods marked public are designated as such due to the fact that we may add middleware / transformer
 * support in the future
 */
class Visitor {
    constructor(instance, rootNode, fileName) {
        this.instance = instance;
        this.rootNode = rootNode;
        this.fileName = fileName;
        this.nodeMetadata = new Map();
        this.urlDefinitions = [];
        this.result = {
            text: '',
            trailingNewlineStats: {
                whitespace: 0,
                newLines: 0
            }
        };
        this.options = instance.options;
        this.optimizeTree(rootNode);
        this.visitNode(rootNode);
    }
    /* ********************************************************* */
    // region: Methods
    /* ********************************************************* */
    addOrGetUrlDefinition(url) {
        let id = this.urlDefinitions.findIndex(u => u === url);
        if (id < 0)
            id = this.urlDefinitions.push(url) - 1;
        return id + 1;
    }
    appendResult(s, startPos, spaceIfRepeatingChar) {
        if (!s && startPos === undefined)
            return;
        const { result } = this;
        if (startPos !== undefined)
            result.text = result.text.substr(0, startPos);
        result.text += (spaceIfRepeatingChar && result.text.slice(-1) === s[0] ? ' ' : '') + s;
        result.trailingNewlineStats = (0, utilities_1.getTrailingWhitespaceInfo)(result.text);
    }
    appendNewlines(count) {
        const { newLines } = this.result.trailingNewlineStats;
        this.appendResult('\n'.repeat(Math.max(0, (+count - newLines))));
    }
    // endregion
    /* ********************************************************* */
    // region: Internal Methods
    /* ********************************************************* */
    /**
     * Optimize tree, flagging nodes that have usable content
     */
    optimizeTree(node) {
        (0, utilities_1.perfStart)('Optimize tree');
        const { translators } = this.instance;
        (function visit(node) {
            let res = false;
            if ((0, nodes_1.isTextNode)(node) || ((0, nodes_1.isElementNode)(node) && config_1.contentlessElements.includes(node.tagName))) {
                res = true;
            }
            else {
                const childNodes = (0, utilities_1.getChildNodes)(node);
                if (!childNodes.length) {
                    const translator = translators[node.tagName];
                    if ((translator === null || translator === void 0 ? void 0 : translator.preserveIfEmpty) || typeof translator === 'function')
                        res = true;
                }
                else
                    for (const child of childNodes) {
                        if (!res)
                            res = visit(child);
                        else
                            visit(child);
                    }
            }
            return node.preserve = res;
        })(node);
        (0, utilities_1.perfStop)('Optimize tree');
    }
    /**
     * Apply escaping and custom replacement rules
     */
    processText(text, metadata) {
        let res = text;
        if (!(metadata === null || metadata === void 0 ? void 0 : metadata.preserveWhitespace))
            res = res.replace(/\s+/g, ' ');
        if (metadata === null || metadata === void 0 ? void 0 : metadata.noEscape)
            return res;
        const { lineStartEscape, globalEscape, textReplace } = this.options;
        res = res
            .replace(globalEscape[0], globalEscape[1])
            .replace(lineStartEscape[0], lineStartEscape[1]);
        /* If specified, apply custom replacement patterns */
        if (textReplace)
            for (const [pattern, r] of textReplace)
                res = res.replace(pattern, r);
        return res;
    }
    visitNode(node, textOnly, metadata) {
        var _a, _b;
        const { result } = this;
        if (!node.preserve)
            return;
        /* Handle text node */
        if ((0, nodes_1.isTextNode)(node))
            return node.isWhitespace && !(metadata === null || metadata === void 0 ? void 0 : metadata.preserveWhitespace)
                ? (!result.text.length || result.trailingNewlineStats.whitespace > 0) ? void 0 : this.appendResult(' ')
                : this.appendResult(this.processText((metadata === null || metadata === void 0 ? void 0 : metadata.preserveWhitespace) ? node.text : node.trimmedText, metadata));
        if (textOnly || !(0, nodes_1.isElementNode)(node))
            return;
        /* Handle element node */
        const translatorCfgOrFactory = (metadata === null || metadata === void 0 ? void 0 : metadata.translators) ? metadata.translators[node.tagName] : this.instance.translators[node.tagName];
        /* Update metadata with list detail */
        switch (node.tagName) {
            case 'UL':
            case 'OL':
                metadata = Object.assign(Object.assign({}, metadata), { listItemNumber: 0, listKind: node.tagName, indentLevel: ((_a = metadata === null || metadata === void 0 ? void 0 : metadata.indentLevel) !== null && _a !== void 0 ? _a : -1) + 1 });
                break;
            case 'LI':
                if ((metadata === null || metadata === void 0 ? void 0 : metadata.listKind) === 'OL')
                    metadata.listItemNumber = ((_b = metadata.listItemNumber) !== null && _b !== void 0 ? _b : 0) + 1;
                break;
            case 'PRE':
                metadata = Object.assign(Object.assign({}, metadata), { preserveWhitespace: true });
                break;
            case 'TABLE':
                metadata = Object.assign(Object.assign({}, metadata), { tableMeta: {
                        node: node
                    } });
        }
        if (metadata)
            this.nodeMetadata.set(node, metadata);
        // If no translator for element, visit children
        if (!translatorCfgOrFactory) {
            for (const child of (0, utilities_1.getChildNodes)(node))
                this.visitNode(child, textOnly, metadata);
            return;
        }
        /* Get Translator Config */
        let cfg;
        let ctx;
        if (!(0, translator_1.isTranslatorConfig)(translatorCfgOrFactory)) {
            ctx = (0, translator_1.createTranslatorContext)(this, node, metadata, translatorCfgOrFactory.base);
            cfg = Object.assign(Object.assign({}, translatorCfgOrFactory.base), translatorCfgOrFactory(ctx));
        }
        else
            cfg = translatorCfgOrFactory;
        // Skip and don't check children if ignore flag set
        if (cfg.ignore)
            return;
        /* Update metadata if needed */
        if (cfg.noEscape && !(metadata === null || metadata === void 0 ? void 0 : metadata.noEscape)) {
            metadata = Object.assign(Object.assign({}, metadata), { noEscape: cfg.noEscape });
            this.nodeMetadata.set(node, metadata);
        }
        if (cfg.childTranslators && (cfg.childTranslators !== (metadata === null || metadata === void 0 ? void 0 : metadata.translators))) {
            metadata = Object.assign(Object.assign({}, metadata), { translators: cfg.childTranslators });
            this.nodeMetadata.set(node, metadata);
        }
        const startPosOuter = result.text.length;
        /* Write opening */
        if (cfg.surroundingNewlines)
            this.appendNewlines(+cfg.surroundingNewlines);
        if (cfg.prefix)
            this.appendResult(cfg.prefix);
        /* Write inner content */
        if (typeof cfg.content === 'string')
            this.appendResult(cfg.content, void 0, cfg.spaceIfRepeatingChar);
        else {
            const startPos = result.text.length;
            // Process child nodes
            for (const child of (0, utilities_1.getChildNodes)(node))
                this.visitNode(child, (cfg.recurse === false), metadata);
            /* Apply translator post-processing */
            if (cfg.postprocess) {
                const postRes = cfg.postprocess(Object.assign(Object.assign({}, (ctx || (0, translator_1.createTranslatorContext)(this, node, metadata))), { content: result.text.substr(startPos) }));
                // If remove flag sent, remove / omit everything for this node (prefix, newlines, content, postfix)
                if (postRes === translator_1.PostProcessResult.RemoveNode) {
                    if (node.tagName === 'LI' && (metadata === null || metadata === void 0 ? void 0 : metadata.listItemNumber))
                        --metadata.listItemNumber;
                    return this.appendResult('', startPosOuter);
                }
                if (typeof postRes === 'string')
                    this.appendResult(postRes, startPos, cfg.spaceIfRepeatingChar);
            }
        }
        /* Write closing */
        if (cfg.postfix)
            this.appendResult(cfg.postfix);
        if (cfg.surroundingNewlines)
            this.appendNewlines(+cfg.surroundingNewlines);
    }
}
exports.Visitor = Visitor;
// endregion
/* ****************************************************************************************************************** */
// region: Utilities
/* ****************************************************************************************************************** */
function getMarkdownForHtmlNodes(instance, rootNode, fileName) {
    (0, utilities_1.perfStart)('walk');
    const visitor = new Visitor(instance, rootNode, fileName);
    let result = visitor.result.text;
    (0, utilities_1.perfStop)('walk');
    /* Post-processing */
    // Add link references, if set
    if (instance.options.useLinkReferenceDefinitions) {
        if (/[^\r\n]/.test(result.slice(-1)))
            result += '\n';
        visitor.urlDefinitions.forEach((url, idx) => {
            result += `\n[${idx + 1}]: ${url}`;
        });
    }
    // Fixup repeating newlines
    const { maxConsecutiveNewlines } = instance.options;
    if (maxConsecutiveNewlines)
        result = result.replace(new RegExp(String.raw `(?:\r?\n\s*)+((?:\r?\n\s*){${maxConsecutiveNewlines}})`, 'g'), '$1');
    return (0, utilities_1.trimNewLines)(result);
}
exports.getMarkdownForHtmlNodes = getMarkdownForHtmlNodes;
// endregion
  },
  "nhm/translator": function (module, exports, require, process, window, document) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTranslatorContext = exports.isTranslatorConfig = exports.TranslatorCollection = exports.PostProcessResult = void 0;
var PostProcessResult;
(function (PostProcessResult) {
    PostProcessResult[PostProcessResult["NoChange"] = 0] = "NoChange";
    PostProcessResult[PostProcessResult["RemoveNode"] = 1] = "RemoveNode";
})(PostProcessResult = exports.PostProcessResult || (exports.PostProcessResult = {}));
// endregion
/* ****************************************************************************************************************** */
// region: TranslatorCollection
/* ****************************************************************************************************************** */
class TranslatorCollection {
    get size() { return Object.keys(this).length; }
    /**
     * Add / update translator config for one or more element tags
     */
    set(keys, config, /* @internal */ preserveBase) {
        keys.split(',').forEach(el => {
            el = el.toUpperCase();
            let res = config;
            if (preserveBase) {
                const base = this[el];
                if ((0, exports.isTranslatorConfig)(base))
                    res = !(0, exports.isTranslatorConfig)(config)
                        ? Object.assign((...args) => config.apply(void 0, args), { base })
                        : Object.assign(Object.assign({}, base), config);
            }
            this[el] = res;
        });
    }
    /**
     * Get translator config for element tag
     */
    get(key) {
        return this[key.toUpperCase()];
    }
    /**
     * Returns array of entries
     */
    entries() {
        return Object.entries(this);
    }
    /**
     * Remove translator config for one or more element tags
     */
    remove(keys) {
        keys.split(',').forEach(el => delete this[el.toUpperCase()]);
    }
}
exports.TranslatorCollection = TranslatorCollection;
// endregion
/* ****************************************************************************************************************** */
// region: Utilities
/* ****************************************************************************************************************** */
/**
 * Only use to narrow union of types where only TranslatorConfig has JS type 'object'
 */
const isTranslatorConfig = (v) => typeof v === 'object';
exports.isTranslatorConfig = isTranslatorConfig;
function createTranslatorContext(visitor, node, metadata, base) {
    const { instance, nodeMetadata, } = visitor;
    return Object.assign({ node, options: instance.options, parent: node.parentNode, nodeMetadata,
        visitor,
        base }, metadata);
}
exports.createTranslatorContext = createTranslatorContext;
// endregion
  },
  "nhm/nodes": function (module, exports, require, process, window, document) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isElementNode = exports.isCommentNode = exports.isTextNode = exports.CommentNode = exports.NodeType = void 0;
const node_html_parser_1 = require("node-html-parser");
Object.defineProperty(exports, "CommentNode", { enumerable: true, get: function () { return node_html_parser_1.CommentNode; } });
Object.defineProperty(exports, "NodeType", { enumerable: true, get: function () { return node_html_parser_1.NodeType; } });
// endregion
/* ****************************************************************************************************************** */
// region: TypeGuards
/* ****************************************************************************************************************** */
const isTextNode = (node) => node.nodeType === node_html_parser_1.NodeType.TEXT_NODE;
exports.isTextNode = isTextNode;
const isCommentNode = (node) => node.nodeType === node_html_parser_1.NodeType.COMMENT_NODE;
exports.isCommentNode = isCommentNode;
const isElementNode = (node) => node.nodeType === node_html_parser_1.NodeType.ELEMENT_NODE;
exports.isElementNode = isElementNode;
// endregion
  },
  "nhm/options": function (module, exports, require, process, window, document) {
"use strict";
/* ****************************************************************************************************************** */
// region: Types
/* ****************************************************************************************************************** */
Object.defineProperty(exports, "__esModule", { value: true });
// endregion
  },
  "nhm/index": function (module, exports, require, process, window, document) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PostProcessResult = exports.TranslatorCollection = exports.NodeHtmlMarkdown = void 0;
var main_1 = require("./main");
Object.defineProperty(exports, "NodeHtmlMarkdown", { enumerable: true, get: function () { return main_1.NodeHtmlMarkdown; } });
var translator_1 = require("./translator");
Object.defineProperty(exports, "TranslatorCollection", { enumerable: true, get: function () { return translator_1.TranslatorCollection; } });
Object.defineProperty(exports, "PostProcessResult", { enumerable: true, get: function () { return translator_1.PostProcessResult; } });
  },
  "nhp/index": function (module, exports, require, process, window, document) {
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NodeType = exports.TextNode = exports.Node = exports.valid = exports.CommentNode = exports.HTMLElement = exports.parse = void 0;
var comment_1 = __importDefault(require("./nodes/comment"));
exports.CommentNode = comment_1.default;
var html_1 = __importDefault(require("./nodes/html"));
exports.HTMLElement = html_1.default;
var node_1 = __importDefault(require("./nodes/node"));
exports.Node = node_1.default;
var text_1 = __importDefault(require("./nodes/text"));
exports.TextNode = text_1.default;
var type_1 = __importDefault(require("./nodes/type"));
exports.NodeType = type_1.default;
var parse_1 = __importDefault(require("./parse"));
var valid_1 = __importDefault(require("./valid"));
exports.valid = valid_1.default;
function parse(data, options) {
    if (options === void 0) { options = {
        lowerCaseTagName: false,
        comment: false
    }; }
    return (0, parse_1.default)(data, options);
}
exports.default = parse;
exports.parse = parse;
parse.parse = parse_1.default;
parse.HTMLElement = html_1.default;
parse.CommentNode = comment_1.default;
parse.valid = valid_1.default;
parse.Node = node_1.default;
parse.TextNode = text_1.default;
parse.NodeType = type_1.default;
  },
  "nhp/parse": function (module, exports, require, process, window, document) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = void 0;
var html_1 = require("./nodes/html");
Object.defineProperty(exports, "default", { enumerable: true, get: function () { return html_1.parse; } });
  },
  "nhp/valid": function (module, exports, require, process, window, document) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var html_1 = require("./nodes/html");
/**
 * Parses HTML and returns a root element
 * Parse a chuck of HTML source.
 */
function valid(data, options) {
    if (options === void 0) { options = { lowerCaseTagName: false, comment: false }; }
    var stack = (0, html_1.base_parse)(data, options);
    return Boolean(stack.length === 1);
}
exports.default = valid;
  },
  "nhp/matcher": function (module, exports, require, process, window, document) {
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
var type_1 = __importDefault(require("./nodes/type"));
function isTag(node) {
    return node && node.nodeType === type_1.default.ELEMENT_NODE;
}
function getAttributeValue(elem, name) {
    return isTag(elem) ? elem.getAttribute(name) : undefined;
}
function getName(elem) {
    return ((elem && elem.rawTagName) || '').toLowerCase();
}
function getChildren(node) {
    return node && node.childNodes;
}
function getParent(node) {
    return node ? node.parentNode : null;
}
function getText(node) {
    return node.text;
}
function removeSubsets(nodes) {
    var idx = nodes.length;
    var node;
    var ancestor;
    var replace;
    // Check if each node (or one of its ancestors) is already contained in the
    // array.
    while (--idx > -1) {
        node = ancestor = nodes[idx];
        // Temporarily remove the node under consideration
        nodes[idx] = null;
        replace = true;
        while (ancestor) {
            if (nodes.indexOf(ancestor) > -1) {
                replace = false;
                nodes.splice(idx, 1);
                break;
            }
            ancestor = getParent(ancestor);
        }
        // If the node has been found to be unique, re-insert it.
        if (replace) {
            nodes[idx] = node;
        }
    }
    return nodes;
}
function existsOne(test, elems) {
    return elems.some(function (elem) {
        return isTag(elem) ? test(elem) || existsOne(test, getChildren(elem)) : false;
    });
}
function getSiblings(node) {
    var parent = getParent(node);
    return parent && getChildren(parent);
}
function hasAttrib(elem, name) {
    return getAttributeValue(elem, name) !== undefined;
}
function findOne(test, elems) {
    var elem = null;
    for (var i = 0, l = elems.length; i < l && !elem; i++) {
        var el = elems[i];
        if (test(el)) {
            elem = el;
        }
        else {
            var childs = getChildren(el);
            if (childs && childs.length > 0) {
                elem = findOne(test, childs);
            }
        }
    }
    return elem;
}
function findAll(test, nodes) {
    var result = [];
    for (var i = 0, j = nodes.length; i < j; i++) {
        if (!isTag(nodes[i]))
            continue;
        if (test(nodes[i]))
            result.push(nodes[i]);
        var childs = getChildren(nodes[i]);
        if (childs)
            result = result.concat(findAll(test, childs));
    }
    return result;
}
exports.default = {
    isTag: isTag,
    getAttributeValue: getAttributeValue,
    getName: getName,
    getChildren: getChildren,
    getParent: getParent,
    getText: getText,
    removeSubsets: removeSubsets,
    existsOne: existsOne,
    getSiblings: getSiblings,
    hasAttrib: hasAttrib,
    findOne: findOne,
    findAll: findAll
};
  },
  "nhp/back": function (module, exports, require, process, window, document) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
function arr_back(arr) {
    return arr[arr.length - 1];
}
exports.default = arr_back;
  },
  "nhp/void-tag": function (module, exports, require, process, window, document) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var VoidTag = /** @class */ (function () {
    function VoidTag(addClosingSlash, tags) {
        if (addClosingSlash === void 0) { addClosingSlash = false; }
        this.addClosingSlash = addClosingSlash;
        if (Array.isArray(tags)) {
            this.voidTags = tags.reduce(function (set, tag) {
                return set.add(tag.toLowerCase());
            }, new Set());
        }
        else {
            this.voidTags = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'].reduce(function (set, tag) {
                return set.add(tag);
            }, new Set());
        }
    }
    VoidTag.prototype.formatNode = function (tag, attrs, innerHTML) {
        var addClosingSlash = this.addClosingSlash;
        var closingSpace = (addClosingSlash && attrs && !attrs.endsWith(' ')) ? ' ' : '';
        var closingSlash = addClosingSlash ? "".concat(closingSpace, "/") : '';
        return this.isVoidElement(tag.toLowerCase()) ? "<".concat(tag).concat(attrs).concat(closingSlash, ">") : "<".concat(tag).concat(attrs, ">").concat(innerHTML, "</").concat(tag, ">");
    };
    VoidTag.prototype.isVoidElement = function (tag) {
        return this.voidTags.has(tag);
    };
    return VoidTag;
}());
exports.default = VoidTag;
  },
  "nhp/nodes/html": function (module, exports, require, process, window, document) {
"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        if (typeof b !== "function" && b !== null)
            throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parse = exports.base_parse = void 0;
var css_select_1 = require("css-select");
var he_1 = __importDefault(require("he"));
var back_1 = __importDefault(require("../back"));
var matcher_1 = __importDefault(require("../matcher"));
var void_tag_1 = __importDefault(require("../void-tag"));
var comment_1 = __importDefault(require("./comment"));
var node_1 = __importDefault(require("./node"));
var text_1 = __importDefault(require("./text"));
var type_1 = __importDefault(require("./type"));
function decode(val) {
    // clone string
    return JSON.parse(JSON.stringify(he_1.default.decode(val)));
}
// https://developer.mozilla.org/en-US/docs/Web/HTML/Block-level_elements
var Htags = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup'];
var Dtags = ['details', 'dialog', 'dd', 'div', 'dt'];
var Ftags = ['fieldset', 'figcaption', 'figure', 'footer', 'form'];
var tableTags = ['table', 'td', 'tr'];
var htmlTags = ['address', 'article', 'aside', 'blockquote', 'br', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'ul'];
var kBlockElements = new Set();
function addToKBlockElement() {
    var args = [];
    for (var _i = 0; _i < arguments.length; _i++) {
        args[_i] = arguments[_i];
    }
    var addToSet = function (array) {
        for (var index = 0; index < array.length; index++) {
            var element = array[index];
            kBlockElements.add(element);
            kBlockElements.add(element.toUpperCase());
        }
    };
    for (var _a = 0, args_1 = args; _a < args_1.length; _a++) {
        var arg = args_1[_a];
        addToSet(arg);
    }
}
addToKBlockElement(Htags, Dtags, Ftags, tableTags, htmlTags);
var DOMTokenList = /** @class */ (function () {
    function DOMTokenList(valuesInit, afterUpdate) {
        if (valuesInit === void 0) { valuesInit = []; }
        if (afterUpdate === void 0) { afterUpdate = function () { return null; }; }
        this._set = new Set(valuesInit);
        this._afterUpdate = afterUpdate;
    }
    DOMTokenList.prototype._validate = function (c) {
        if (/\s/.test(c)) {
            throw new Error("DOMException in DOMTokenList.add: The token '".concat(c, "' contains HTML space characters, which are not valid in tokens."));
        }
    };
    DOMTokenList.prototype.add = function (c) {
        this._validate(c);
        this._set.add(c);
        this._afterUpdate(this); // eslint-disable-line @typescript-eslint/no-unsafe-call
    };
    DOMTokenList.prototype.replace = function (c1, c2) {
        this._validate(c2);
        this._set.delete(c1);
        this._set.add(c2);
        this._afterUpdate(this); // eslint-disable-line @typescript-eslint/no-unsafe-call
    };
    DOMTokenList.prototype.remove = function (c) {
        this._set.delete(c) && this._afterUpdate(this); // eslint-disable-line @typescript-eslint/no-unsafe-call
    };
    DOMTokenList.prototype.toggle = function (c) {
        this._validate(c);
        if (this._set.has(c))
            this._set.delete(c);
        else
            this._set.add(c);
        this._afterUpdate(this); // eslint-disable-line @typescript-eslint/no-unsafe-call
    };
    DOMTokenList.prototype.contains = function (c) {
        return this._set.has(c);
    };
    Object.defineProperty(DOMTokenList.prototype, "length", {
        get: function () {
            return this._set.size;
        },
        enumerable: false,
        configurable: true
    });
    DOMTokenList.prototype.values = function () {
        return this._set.values();
    };
    Object.defineProperty(DOMTokenList.prototype, "value", {
        get: function () {
            return Array.from(this._set.values());
        },
        enumerable: false,
        configurable: true
    });
    DOMTokenList.prototype.toString = function () {
        return Array.from(this._set.values()).join(' ');
    };
    return DOMTokenList;
}());
/**
 * HTMLElement, which contains a set of children.
 *
 * Note: this is a minimalist implementation, no complete tree
 *   structure provided (no parentNode, nextSibling,
 *   previousSibling etc).
 * @class HTMLElement
 * @extends {Node}
 */
var HTMLElement = /** @class */ (function (_super) {
    __extends(HTMLElement, _super);
    /**
     * Creates an instance of HTMLElement.
     * @param keyAttrs	id and class attribute
     * @param [rawAttrs]	attributes in string
     *
     * @memberof HTMLElement
     */
    function HTMLElement(tagName, keyAttrs, rawAttrs, parentNode, range, voidTag) {
        if (rawAttrs === void 0) { rawAttrs = ''; }
        if (voidTag === void 0) { voidTag = new void_tag_1.default(); }
        var _this = _super.call(this, parentNode, range) || this;
        _this.rawAttrs = rawAttrs;
        _this.voidTag = voidTag;
        /**
         * Node Type declaration.
         */
        _this.nodeType = type_1.default.ELEMENT_NODE;
        _this.rawTagName = tagName;
        _this.rawAttrs = rawAttrs || '';
        _this.id = keyAttrs.id || '';
        _this.childNodes = [];
        _this.classList = new DOMTokenList(keyAttrs.class ? keyAttrs.class.split(/\s+/) : [], function (classList) { return _this.setAttribute('class', classList.toString()); } // eslint-disable-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        );
        if (keyAttrs.id) {
            if (!rawAttrs) {
                _this.rawAttrs = "id=\"".concat(keyAttrs.id, "\"");
            }
        }
        if (keyAttrs.class) {
            if (!rawAttrs) {
                var cls = "class=\"".concat(_this.classList.toString(), "\"");
                if (_this.rawAttrs) {
                    _this.rawAttrs += " ".concat(cls);
                }
                else {
                    _this.rawAttrs = cls;
                }
            }
        }
        return _this;
    }
    /**
     * Quote attribute values
     * @param attr attribute value
     * @returns {string} quoted value
     */
    HTMLElement.prototype.quoteAttribute = function (attr) {
        if (attr == null) {
            return 'null';
        }
        return JSON.stringify(attr.replace(/"/g, '&quot;'));
    };
    /**
     * Remove Child element from childNodes array
     * @param {HTMLElement} node     node to remove
     */
    HTMLElement.prototype.removeChild = function (node) {
        this.childNodes = this.childNodes.filter(function (child) {
            return child !== node;
        });
        return this;
    };
    /**
     * Exchanges given child with new child
     * @param {HTMLElement} oldNode     node to exchange
     * @param {HTMLElement} newNode     new node
     */
    HTMLElement.prototype.exchangeChild = function (oldNode, newNode) {
        var children = this.childNodes;
        this.childNodes = children.map(function (child) {
            if (child === oldNode) {
                return newNode;
            }
            return child;
        });
        return this;
    };
    Object.defineProperty(HTMLElement.prototype, "tagName", {
        get: function () {
            return this.rawTagName ? this.rawTagName.toUpperCase() : this.rawTagName;
        },
        set: function (newname) {
            this.rawTagName = newname.toLowerCase();
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(HTMLElement.prototype, "localName", {
        get: function () {
            return this.rawTagName.toLowerCase();
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(HTMLElement.prototype, "isVoidElement", {
        get: function () {
            return this.voidTag.isVoidElement(this.localName);
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(HTMLElement.prototype, "rawText", {
        /**
         * Get escpaed (as-it) text value of current node and its children.
         * @return {string} text content
         */
        get: function () {
            return this.childNodes.reduce(function (pre, cur) {
                return (pre += cur.rawText);
            }, '');
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(HTMLElement.prototype, "textContent", {
        get: function () {
            return decode(this.rawText);
        },
        set: function (val) {
            var content = [new text_1.default(val, this)];
            this.childNodes = content;
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(HTMLElement.prototype, "text", {
        /**
         * Get unescaped text value of current node and its children.
         * @return {string} text content
         */
        get: function () {
            return decode(this.rawText);
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(HTMLElement.prototype, "structuredText", {
        /**
         * Get structured Text (with '\n' etc.)
         * @return {string} structured text
         */
        get: function () {
            var currentBlock = [];
            var blocks = [currentBlock];
            function dfs(node) {
                if (node.nodeType === type_1.default.ELEMENT_NODE) {
                    if (kBlockElements.has(node.rawTagName)) {
                        if (currentBlock.length > 0) {
                            blocks.push((currentBlock = []));
                        }
                        node.childNodes.forEach(dfs);
                        if (currentBlock.length > 0) {
                            blocks.push((currentBlock = []));
                        }
                    }
                    else {
                        node.childNodes.forEach(dfs);
                    }
                }
                else if (node.nodeType === type_1.default.TEXT_NODE) {
                    if (node.isWhitespace) {
                        // Whitespace node, postponed output
                        currentBlock.prependWhitespace = true;
                    }
                    else {
                        var text = node.trimmedText;
                        if (currentBlock.prependWhitespace) {
                            text = " ".concat(text);
                            currentBlock.prependWhitespace = false;
                        }
                        currentBlock.push(text);
                    }
                }
            }
            dfs(this);
            return blocks
                .map(function (block) {
                return block.join('').replace(/\s{2,}/g, ' '); // Normalize each line's whitespace
            })
                .join('\n')
                .replace(/\s+$/, ''); // trimRight;
        },
        enumerable: false,
        configurable: true
    });
    HTMLElement.prototype.toString = function () {
        var tag = this.rawTagName;
        if (tag) {
            var attrs = this.rawAttrs ? " ".concat(this.rawAttrs) : '';
            return this.voidTag.formatNode(tag, attrs, this.innerHTML);
        }
        return this.innerHTML;
    };
    Object.defineProperty(HTMLElement.prototype, "innerHTML", {
        get: function () {
            return this.childNodes
                .map(function (child) {
                return child.toString();
            })
                .join('');
        },
        set: function (content) {
            //const r = parse(content, global.options); // TODO global.options ?
            var r = parse(content);
            var nodes = r.childNodes.length ? r.childNodes : [new text_1.default(content, this)];
            resetParent(nodes, this);
            resetParent(this.childNodes, null);
            this.childNodes = nodes;
        },
        enumerable: false,
        configurable: true
    });
    HTMLElement.prototype.set_content = function (content, options) {
        if (options === void 0) { options = {}; }
        if (content instanceof node_1.default) {
            content = [content];
        }
        else if (typeof content == 'string') {
            var r = parse(content, options);
            content = r.childNodes.length ? r.childNodes : [new text_1.default(content, this)];
        }
        resetParent(this.childNodes, null);
        resetParent(content, this);
        this.childNodes = content;
        return this;
    };
    HTMLElement.prototype.replaceWith = function () {
        var _this = this;
        var nodes = [];
        for (var _i = 0; _i < arguments.length; _i++) {
            nodes[_i] = arguments[_i];
        }
        var parent = this.parentNode;
        var content = nodes
            .map(function (node) {
            if (node instanceof node_1.default) {
                return [node];
            }
            else if (typeof node == 'string') {
                // const r = parse(content, global.options); // TODO global.options ?
                var r = parse(node);
                return r.childNodes.length ? r.childNodes : [new text_1.default(node, _this)];
            }
            return [];
        })
            .flat();
        var idx = parent.childNodes.findIndex(function (child) {
            return child === _this;
        });
        resetParent([this], null);
        parent.childNodes = __spreadArray(__spreadArray(__spreadArray([], parent.childNodes.slice(0, idx), true), resetParent(content, parent), true), parent.childNodes.slice(idx + 1), true);
    };
    Object.defineProperty(HTMLElement.prototype, "outerHTML", {
        get: function () {
            return this.toString();
        },
        enumerable: false,
        configurable: true
    });
    /**
     * Trim element from right (in block) after seeing pattern in a TextNode.
     * @param  {RegExp} pattern pattern to find
     * @return {HTMLElement}    reference to current node
     */
    HTMLElement.prototype.trimRight = function (pattern) {
        for (var i = 0; i < this.childNodes.length; i++) {
            var childNode = this.childNodes[i];
            if (childNode.nodeType === type_1.default.ELEMENT_NODE) {
                childNode.trimRight(pattern);
            }
            else {
                var index = childNode.rawText.search(pattern);
                if (index > -1) {
                    childNode.rawText = childNode.rawText.substr(0, index);
                    // trim all following nodes.
                    this.childNodes.length = i + 1;
                }
            }
        }
        return this;
    };
    Object.defineProperty(HTMLElement.prototype, "structure", {
        /**
         * Get DOM structure
         * @return {string} strucutre
         */
        get: function () {
            var res = [];
            var indention = 0;
            function write(str) {
                res.push('  '.repeat(indention) + str);
            }
            function dfs(node) {
                var idStr = node.id ? "#".concat(node.id) : '';
                var classStr = node.classList.length ? ".".concat(node.classList.value.join('.')) : ''; // eslint-disable-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-unsafe-call
                write("".concat(node.rawTagName).concat(idStr).concat(classStr));
                indention++;
                node.childNodes.forEach(function (childNode) {
                    if (childNode.nodeType === type_1.default.ELEMENT_NODE) {
                        dfs(childNode);
                    }
                    else if (childNode.nodeType === type_1.default.TEXT_NODE) {
                        if (!childNode.isWhitespace) {
                            write('#text');
                        }
                    }
                });
                indention--;
            }
            dfs(this);
            return res.join('\n');
        },
        enumerable: false,
        configurable: true
    });
    /**
     * Remove whitespaces in this sub tree.
     * @return {HTMLElement} pointer to this
     */
    HTMLElement.prototype.removeWhitespace = function () {
        var _this = this;
        var o = 0;
        this.childNodes.forEach(function (node) {
            if (node.nodeType === type_1.default.TEXT_NODE) {
                if (node.isWhitespace) {
                    return;
                }
                node.rawText = node.trimmedRawText;
            }
            else if (node.nodeType === type_1.default.ELEMENT_NODE) {
                node.removeWhitespace();
            }
            _this.childNodes[o++] = node;
        });
        this.childNodes.length = o;
        return this;
    };
    /**
     * Query CSS selector to find matching nodes.
     * @param  {string}         selector Simplified CSS selector
     * @return {HTMLElement[]}  matching elements
     */
    HTMLElement.prototype.querySelectorAll = function (selector) {
        return (0, css_select_1.selectAll)(selector, this, {
            xmlMode: true,
            adapter: matcher_1.default,
        });
    };
    /**
     * Query CSS Selector to find matching node.
     * @param  {string}         selector Simplified CSS selector
     * @return {(HTMLElement|null)}    matching node
     */
    HTMLElement.prototype.querySelector = function (selector) {
        return (0, css_select_1.selectOne)(selector, this, {
            xmlMode: true,
            adapter: matcher_1.default,
        });
    };
    /**
     * find elements by their tagName
     * @param {string} tagName the tagName of the elements to select
     */
    HTMLElement.prototype.getElementsByTagName = function (tagName) {
        var upperCasedTagName = tagName.toUpperCase();
        var re = [];
        var stack = [];
        var currentNodeReference = this;
        var index = 0;
        // index turns to undefined once the stack is empty and the first condition occurs
        // which happens once all relevant children are searched through
        while (index !== undefined) {
            var child = void 0;
            // make it work with sparse arrays
            do {
                child = currentNodeReference.childNodes[index++];
            } while (index < currentNodeReference.childNodes.length && child === undefined);
            // if the child does not exist we move on with the last provided index (which belongs to the parentNode)
            if (child === undefined) {
                currentNodeReference = currentNodeReference.parentNode;
                index = stack.pop();
                continue;
            }
            if (child.nodeType === type_1.default.ELEMENT_NODE) {
                // https://developer.mozilla.org/en-US/docs/Web/API/Element/getElementsByTagName#syntax
                if (tagName === '*' || child.tagName === upperCasedTagName)
                    re.push(child);
                // if children are existing push the current status to the stack and keep searching for elements in the level below
                if (child.childNodes.length > 0) {
                    stack.push(index);
                    currentNodeReference = child;
                    index = 0;
                }
            }
        }
        return re;
    };
    /**
     * find element by it's id
     * @param {string} id the id of the element to select
     */
    HTMLElement.prototype.getElementById = function (id) {
        var stack = [];
        var currentNodeReference = this;
        var index = 0;
        // index turns to undefined once the stack is empty and the first condition occurs
        // which happens once all relevant children are searched through
        while (index !== undefined) {
            var child = void 0;
            // make it work with sparse arrays
            do {
                child = currentNodeReference.childNodes[index++];
            } while (index < currentNodeReference.childNodes.length && child === undefined);
            // if the child does not exist we move on with the last provided index (which belongs to the parentNode)
            if (child === undefined) {
                currentNodeReference = currentNodeReference.parentNode;
                index = stack.pop();
                continue;
            }
            if (child.nodeType === type_1.default.ELEMENT_NODE) {
                if (child.id === id) {
                    return child;
                }
                ;
                // if children are existing push the current status to the stack and keep searching for elements in the level below
                if (child.childNodes.length > 0) {
                    stack.push(index);
                    currentNodeReference = child;
                    index = 0;
                }
            }
        }
        return null;
    };
    /**
     * traverses the Element and its parents (heading toward the document root) until it finds a node that matches the provided selector string. Will return itself or the matching ancestor. If no such element exists, it returns null.
     * @param selector a DOMString containing a selector list
     */
    HTMLElement.prototype.closest = function (selector) {
        var mapChild = new Map();
        var el = this;
        var old = null;
        function findOne(test, elems) {
            var elem = null;
            for (var i = 0, l = elems.length; i < l && !elem; i++) {
                var el_1 = elems[i];
                if (test(el_1)) {
                    elem = el_1;
                }
                else {
                    var child = mapChild.get(el_1);
                    if (child) {
                        elem = findOne(test, [child]);
                    }
                }
            }
            return elem;
        }
        while (el) {
            mapChild.set(el, old);
            old = el;
            el = el.parentNode;
        }
        el = this;
        while (el) {
            var e = (0, css_select_1.selectOne)(selector, el, {
                xmlMode: true,
                adapter: __assign(__assign({}, matcher_1.default), { getChildren: function (node) {
                        var child = mapChild.get(node);
                        return child && [child];
                    }, getSiblings: function (node) {
                        return [node];
                    }, findOne: findOne, findAll: function () {
                        return [];
                    } }),
            });
            if (e) {
                return e;
            }
            el = el.parentNode;
        }
        return null;
    };
    /**
     * Append a child node to childNodes
     * @param  {Node} node node to append
     * @return {Node}      node appended
     */
    HTMLElement.prototype.appendChild = function (node) {
        // remove the node from it's parent
        node.remove();
        this.childNodes.push(node);
        node.parentNode = this;
        return node;
    };
    Object.defineProperty(HTMLElement.prototype, "firstChild", {
        /**
         * Get first child node
         * @return {Node} first child node
         */
        get: function () {
            return this.childNodes[0];
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(HTMLElement.prototype, "lastChild", {
        /**
         * Get last child node
         * @return {Node} last child node
         */
        get: function () {
            return (0, back_1.default)(this.childNodes);
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(HTMLElement.prototype, "attrs", {
        /**
         * Get attributes
         * @access private
         * @return {Object} parsed and unescaped attributes
         */
        get: function () {
            if (this._attrs) {
                return this._attrs;
            }
            this._attrs = {};
            var attrs = this.rawAttributes;
            for (var key in attrs) {
                var val = attrs[key] || '';
                this._attrs[key.toLowerCase()] = decode(val);
            }
            return this._attrs;
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(HTMLElement.prototype, "attributes", {
        get: function () {
            var ret_attrs = {};
            var attrs = this.rawAttributes;
            for (var key in attrs) {
                var val = attrs[key] || '';
                ret_attrs[key] = decode(val);
            }
            return ret_attrs;
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(HTMLElement.prototype, "rawAttributes", {
        /**
         * Get escaped (as-is) attributes
         * @return {Object} parsed attributes
         */
        get: function () {
            if (this._rawAttrs) {
                return this._rawAttrs;
            }
            var attrs = {};
            if (this.rawAttrs) {
                var re = /([a-zA-Z()[\]#@][a-zA-Z0-9-_:()[\]#]*)(?:\s*=\s*((?:'[^']*')|(?:"[^"]*")|\S+))?/g;
                var match = void 0;
                while ((match = re.exec(this.rawAttrs))) {
                    var key = match[1];
                    var val = match[2] || null;
                    if (val && (val[0] === "'" || val[0] === "\""))
                        val = val.slice(1, val.length - 1);
                    attrs[key] = val;
                }
            }
            this._rawAttrs = attrs;
            return attrs;
        },
        enumerable: false,
        configurable: true
    });
    HTMLElement.prototype.removeAttribute = function (key) {
        var attrs = this.rawAttributes;
        delete attrs[key];
        // Update this.attribute
        if (this._attrs) {
            delete this._attrs[key];
        }
        // Update rawString
        this.rawAttrs = Object.keys(attrs)
            .map(function (name) {
            var val = JSON.stringify(attrs[name]);
            if (val === undefined || val === 'null') {
                return name;
            }
            return "".concat(name, "=").concat(val);
        })
            .join(' ');
        // Update this.id
        if (key === 'id') {
            this.id = '';
        }
        return this;
    };
    HTMLElement.prototype.hasAttribute = function (key) {
        return key.toLowerCase() in this.attrs;
    };
    /**
     * Get an attribute
     * @return {string} value of the attribute
     */
    HTMLElement.prototype.getAttribute = function (key) {
        return this.attrs[key.toLowerCase()];
    };
    /**
     * Set an attribute value to the HTMLElement
     * @param {string} key The attribute name
     * @param {string} value The value to set, or null / undefined to remove an attribute
     */
    HTMLElement.prototype.setAttribute = function (key, value) {
        var _this = this;
        if (arguments.length < 2) {
            throw new Error("Failed to execute 'setAttribute' on 'Element'");
        }
        var k2 = key.toLowerCase();
        var attrs = this.rawAttributes;
        for (var k in attrs) {
            if (k.toLowerCase() === k2) {
                key = k;
                break;
            }
        }
        attrs[key] = String(value);
        // update this.attrs
        if (this._attrs) {
            this._attrs[k2] = decode(attrs[key]);
        }
        // Update rawString
        this.rawAttrs = Object.keys(attrs)
            .map(function (name) {
            var val = _this.quoteAttribute(attrs[name]);
            if (val === 'null' || val === '""')
                return name;
            return "".concat(name, "=").concat(val);
        })
            .join(' ');
        // Update this.id
        if (key === 'id') {
            this.id = value;
        }
    };
    /**
     * Replace all the attributes of the HTMLElement by the provided attributes
     * @param {Attributes} attributes the new attribute set
     */
    HTMLElement.prototype.setAttributes = function (attributes) {
        var _this = this;
        // Invalidate current this.attributes
        if (this._attrs) {
            delete this._attrs;
        }
        // Invalidate current this.rawAttributes
        if (this._rawAttrs) {
            delete this._rawAttrs;
        }
        // Update rawString
        this.rawAttrs = Object.keys(attributes)
            .map(function (name) {
            var val = attributes[name];
            if (val === 'null' || val === '""')
                return name;
            return "".concat(name, "=").concat(_this.quoteAttribute(String(val)));
        })
            .join(' ');
        return this;
    };
    HTMLElement.prototype.insertAdjacentHTML = function (where, html) {
        var _a, _b, _c;
        var _this = this;
        if (arguments.length < 2) {
            throw new Error('2 arguments required');
        }
        var p = parse(html);
        if (where === 'afterend') {
            var idx = this.parentNode.childNodes.findIndex(function (child) {
                return child === _this;
            });
            resetParent(p.childNodes, this.parentNode);
            (_a = this.parentNode.childNodes).splice.apply(_a, __spreadArray([idx + 1, 0], p.childNodes, false));
        }
        else if (where === 'afterbegin') {
            resetParent(p.childNodes, this);
            (_b = this.childNodes).unshift.apply(_b, p.childNodes);
        }
        else if (where === 'beforeend') {
            p.childNodes.forEach(function (n) {
                _this.appendChild(n);
            });
        }
        else if (where === 'beforebegin') {
            var idx = this.parentNode.childNodes.findIndex(function (child) {
                return child === _this;
            });
            resetParent(p.childNodes, this.parentNode);
            (_c = this.parentNode.childNodes).splice.apply(_c, __spreadArray([idx, 0], p.childNodes, false));
        }
        else {
            throw new Error("The value provided ('".concat(where, "') is not one of 'beforebegin', 'afterbegin', 'beforeend', or 'afterend'"));
        }
        return this;
        // if (!where || html === undefined || html === null) {
        // 	return;
        // }
    };
    Object.defineProperty(HTMLElement.prototype, "nextSibling", {
        get: function () {
            if (this.parentNode) {
                var children = this.parentNode.childNodes;
                var i = 0;
                while (i < children.length) {
                    var child = children[i++];
                    if (this === child)
                        return children[i] || null;
                }
                return null;
            }
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(HTMLElement.prototype, "nextElementSibling", {
        get: function () {
            if (this.parentNode) {
                var children = this.parentNode.childNodes;
                var i = 0;
                var find = false;
                while (i < children.length) {
                    var child = children[i++];
                    if (find) {
                        if (child instanceof HTMLElement) {
                            return child || null;
                        }
                    }
                    else if (this === child) {
                        find = true;
                    }
                }
                return null;
            }
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(HTMLElement.prototype, "previousSibling", {
        get: function () {
            if (this.parentNode) {
                var children = this.parentNode.childNodes;
                var i = children.length;
                while (i > 0) {
                    var child = children[--i];
                    if (this === child)
                        return children[i - 1] || null;
                }
                return null;
            }
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(HTMLElement.prototype, "previousElementSibling", {
        get: function () {
            if (this.parentNode) {
                var children = this.parentNode.childNodes;
                var i = children.length;
                var find = false;
                while (i > 0) {
                    var child = children[--i];
                    if (find) {
                        if (child instanceof HTMLElement) {
                            return child || null;
                        }
                    }
                    else if (this === child) {
                        find = true;
                    }
                }
                return null;
            }
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(HTMLElement.prototype, "classNames", {
        get: function () {
            return this.classList.toString();
        },
        enumerable: false,
        configurable: true
    });
    /**
     * Clone this Node
     */
    HTMLElement.prototype.clone = function () {
        return parse(this.toString()).firstChild;
    };
    return HTMLElement;
}(node_1.default));
exports.default = HTMLElement;
// https://html.spec.whatwg.org/multipage/custom-elements.html#valid-custom-element-name
var kMarkupPattern = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][-.:0-9_a-zA-Z]*)((?:\s+[^>]*?(?:(?:'[^']*')|(?:"[^"]*"))?)*)\s*(\/?)>/g;
var kAttributePattern = /(?:^|\s)(id|class)\s*=\s*((?:'[^']*')|(?:"[^"]*")|\S+)/gi;
var kSelfClosingElements = {
    area: true,
    AREA: true,
    base: true,
    BASE: true,
    br: true,
    BR: true,
    col: true,
    COL: true,
    hr: true,
    HR: true,
    img: true,
    IMG: true,
    input: true,
    INPUT: true,
    link: true,
    LINK: true,
    meta: true,
    META: true,
    source: true,
    SOURCE: true,
    embed: true,
    EMBED: true,
    param: true,
    PARAM: true,
    track: true,
    TRACK: true,
    wbr: true,
    WBR: true,
};
var kElementsClosedByOpening = {
    li: { li: true, LI: true },
    LI: { li: true, LI: true },
    p: { p: true, div: true, P: true, DIV: true },
    P: { p: true, div: true, P: true, DIV: true },
    b: { div: true, DIV: true },
    B: { div: true, DIV: true },
    td: { td: true, th: true, TD: true, TH: true },
    TD: { td: true, th: true, TD: true, TH: true },
    th: { td: true, th: true, TD: true, TH: true },
    TH: { td: true, th: true, TD: true, TH: true },
    h1: { h1: true, H1: true },
    H1: { h1: true, H1: true },
    h2: { h2: true, H2: true },
    H2: { h2: true, H2: true },
    h3: { h3: true, H3: true },
    H3: { h3: true, H3: true },
    h4: { h4: true, H4: true },
    H4: { h4: true, H4: true },
    h5: { h5: true, H5: true },
    H5: { h5: true, H5: true },
    h6: { h6: true, H6: true },
    H6: { h6: true, H6: true },
};
var kElementsClosedByClosing = {
    li: { ul: true, ol: true, UL: true, OL: true },
    LI: { ul: true, ol: true, UL: true, OL: true },
    a: { div: true, DIV: true },
    A: { div: true, DIV: true },
    b: { div: true, DIV: true },
    B: { div: true, DIV: true },
    i: { div: true, DIV: true },
    I: { div: true, DIV: true },
    p: { div: true, DIV: true },
    P: { div: true, DIV: true },
    td: { tr: true, table: true, TR: true, TABLE: true },
    TD: { tr: true, table: true, TR: true, TABLE: true },
    th: { tr: true, table: true, TR: true, TABLE: true },
    TH: { tr: true, table: true, TR: true, TABLE: true },
};
var frameflag = 'documentfragmentcontainer';
/**
 * Parses HTML and returns a root element
 * Parse a chuck of HTML source.
 * @param  {string} data      html
 * @return {HTMLElement}      root element
 */
function base_parse(data, options) {
    var _a, _b;
    if (options === void 0) { options = { lowerCaseTagName: false, comment: false }; }
    var voidTag = new void_tag_1.default((_a = options === null || options === void 0 ? void 0 : options.voidTag) === null || _a === void 0 ? void 0 : _a.closingSlash, (_b = options === null || options === void 0 ? void 0 : options.voidTag) === null || _b === void 0 ? void 0 : _b.tags);
    var elements = options.blockTextElements || {
        script: true,
        noscript: true,
        style: true,
        pre: true,
    };
    var element_names = Object.keys(elements);
    var kBlockTextElements = element_names.map(function (it) { return new RegExp("^".concat(it, "$"), 'i'); });
    var kIgnoreElements = element_names.filter(function (it) { return elements[it]; }).map(function (it) { return new RegExp("^".concat(it, "$"), 'i'); });
    function element_should_be_ignore(tag) {
        return kIgnoreElements.some(function (it) { return it.test(tag); });
    }
    function is_block_text_element(tag) {
        return kBlockTextElements.some(function (it) { return it.test(tag); });
    }
    var createRange = function (startPos, endPos) { return [startPos - frameFlagOffset, endPos - frameFlagOffset]; };
    var root = new HTMLElement(null, {}, '', null, [0, data.length], voidTag);
    var currentParent = root;
    var stack = [root];
    var lastTextPos = -1;
    var noNestedTagIndex = undefined;
    var match;
    // https://github.com/taoqf/node-html-parser/issues/38
    data = "<".concat(frameflag, ">").concat(data, "</").concat(frameflag, ">");
    var lowerCaseTagName = options.lowerCaseTagName;
    var dataEndPos = data.length - (frameflag.length + 2);
    var frameFlagOffset = frameflag.length + 2;
    while ((match = kMarkupPattern.exec(data))) {
        // Note: Object destructuring here consistently tests as higher performance than array destructuring
        // eslint-disable-next-line prefer-const
        var matchText = match[0], leadingSlash = match[1], tagName = match[2], attributes = match[3], closingSlash = match[4];
        var matchLength = matchText.length;
        var tagStartPos = kMarkupPattern.lastIndex - matchLength;
        var tagEndPos = kMarkupPattern.lastIndex;
        // Add TextNode if content
        if (lastTextPos > -1) {
            if (lastTextPos + matchLength < tagEndPos) {
                var text = data.substring(lastTextPos, tagStartPos);
                currentParent.appendChild(new text_1.default(text, currentParent, createRange(lastTextPos, tagStartPos)));
            }
        }
        lastTextPos = kMarkupPattern.lastIndex;
        // https://github.com/taoqf/node-html-parser/issues/38
        // Skip frameflag node
        if (tagName === frameflag)
            continue;
        // Handle comments
        if (matchText[1] === '!') {
            if (options.comment) {
                // Only keep what is in between <!-- and -->
                var text = data.substring(tagStartPos + 4, tagEndPos - 3);
                currentParent.appendChild(new comment_1.default(text, currentParent, createRange(tagStartPos, tagEndPos)));
            }
            continue;
        }
        /* -- Handle tag matching -- */
        // Fix tag casing if necessary
        if (lowerCaseTagName)
            tagName = tagName.toLowerCase();
        // Handle opening tags (ie. <this> not </that>)
        if (!leadingSlash) {
            /* Populate attributes */
            var attrs = {};
            for (var attMatch = void 0; (attMatch = kAttributePattern.exec(attributes));) {
                var key = attMatch[1], val = attMatch[2];
                var isQuoted = val[0] === "'" || val[0] === "\"";
                attrs[key.toLowerCase()] = isQuoted ? val.slice(1, val.length - 1) : val;
            }
            var parentTagName = currentParent.rawTagName;
            if (!closingSlash && kElementsClosedByOpening[parentTagName]) {
                if (kElementsClosedByOpening[parentTagName][tagName]) {
                    stack.pop();
                    currentParent = (0, back_1.default)(stack);
                }
            }
            // Prevent nested A tags by terminating the last A and starting a new one : see issue #144
            if (tagName === 'a' || tagName === 'A') {
                if (noNestedTagIndex !== undefined) {
                    stack.splice(noNestedTagIndex);
                    currentParent = (0, back_1.default)(stack);
                }
                noNestedTagIndex = stack.length;
            }
            var tagEndPos_1 = kMarkupPattern.lastIndex;
            var tagStartPos_1 = tagEndPos_1 - matchLength;
            currentParent = currentParent.appendChild(
            // Initialize range (end position updated later for closed tags)
            new HTMLElement(tagName, attrs, attributes.slice(1), null, createRange(tagStartPos_1, tagEndPos_1), voidTag));
            stack.push(currentParent);
            if (is_block_text_element(tagName)) {
                // Find closing tag
                var closeMarkup = "</".concat(tagName, ">");
                var closeIndex = lowerCaseTagName
                    ? data.toLocaleLowerCase().indexOf(closeMarkup, kMarkupPattern.lastIndex)
                    : data.indexOf(closeMarkup, kMarkupPattern.lastIndex);
                var textEndPos = closeIndex === -1 ? dataEndPos : closeIndex;
                if (element_should_be_ignore(tagName)) {
                    var text = data.substring(tagEndPos_1, textEndPos);
                    if (text.length > 0 && /\S/.test(text)) {
                        currentParent.appendChild(new text_1.default(text, currentParent, createRange(tagEndPos_1, textEndPos)));
                    }
                }
                if (closeIndex === -1) {
                    lastTextPos = kMarkupPattern.lastIndex = data.length + 1;
                }
                else {
                    lastTextPos = kMarkupPattern.lastIndex = closeIndex + closeMarkup.length;
                    // Cause to be treated as self-closing, because no close found
                    leadingSlash = '/';
                }
            }
        }
        // Handle closing tags or self-closed elements (ie </tag> or <br>)
        if (leadingSlash || closingSlash || kSelfClosingElements[tagName]) {
            while (true) {
                if (tagName === 'a' || tagName === 'A')
                    noNestedTagIndex = undefined;
                if (currentParent.rawTagName === tagName) {
                    // Update range end for closed tag
                    currentParent.range[1] = createRange(-1, Math.max(lastTextPos, tagEndPos))[1];
                    stack.pop();
                    currentParent = (0, back_1.default)(stack);
                    break;
                }
                else {
                    var parentTagName = currentParent.tagName;
                    // Trying to close current tag, and move on
                    if (kElementsClosedByClosing[parentTagName]) {
                        if (kElementsClosedByClosing[parentTagName][tagName]) {
                            stack.pop();
                            currentParent = (0, back_1.default)(stack);
                            continue;
                        }
                    }
                    // Use aggressive strategy to handle unmatching markups.
                    break;
                }
            }
        }
    }
    return stack;
}
exports.base_parse = base_parse;
/**
 * Parses HTML and returns a root element
 * Parse a chuck of HTML source.
 */
function parse(data, options) {
    if (options === void 0) { options = { lowerCaseTagName: false, comment: false }; }
    var stack = base_parse(data, options);
    var root = stack[0];
    var _loop_1 = function () {
        // Handle each error elements.
        var last = stack.pop();
        var oneBefore = (0, back_1.default)(stack);
        if (last.parentNode && last.parentNode.parentNode) {
            if (last.parentNode === oneBefore && last.tagName === oneBefore.tagName) {
                // Pair error case <h3> <h3> handle : Fixes to <h3> </h3>
                // this is wrong, becouse this will put the H3 outside the current right position which should be inside the current Html Element, see issue 152 for more info
                if (options.parseNoneClosedTags !== true) {
                    oneBefore.removeChild(last);
                    last.childNodes.forEach(function (child) {
                        oneBefore.parentNode.appendChild(child);
                    });
                    stack.pop();
                }
            }
            else {
                // Single error  <div> <h3> </div> handle: Just removes <h3>
                // Why remove? this is already a HtmlElement and the missing <H3> is already added in this case. see issue 152 for more info
                // eslint-disable-next-line no-lonely-if
                if (options.parseNoneClosedTags !== true) {
                    oneBefore.removeChild(last);
                    last.childNodes.forEach(function (child) {
                        oneBefore.appendChild(child);
                    });
                }
            }
        }
        else {
            // If it's final element just skip.
        }
    };
    while (stack.length > 1) {
        _loop_1();
    }
    // response.childNodes.forEach((node) => {
    // 	if (node instanceof HTMLElement) {
    // 		node.parentNode = null;
    // 	}
    // });
    return root;
}
exports.parse = parse;
function resetParent(nodes, parent) {
    return nodes.map(function (node) {
        node.parentNode = parent;
        return node;
    });
}
  },
  "nhp/nodes/text": function (module, exports, require, process, window, document) {
"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        if (typeof b !== "function" && b !== null)
            throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
var he_1 = require("he");
var node_1 = __importDefault(require("./node"));
var type_1 = __importDefault(require("./type"));
/**
 * TextNode to contain a text element in DOM tree.
 * @param {string} value [description]
 */
var TextNode = /** @class */ (function (_super) {
    __extends(TextNode, _super);
    function TextNode(rawText, parentNode, range) {
        var _this = _super.call(this, parentNode, range) || this;
        /**
         * Node Type declaration.
         * @type {Number}
         */
        _this.nodeType = type_1.default.TEXT_NODE;
        _this._rawText = rawText;
        return _this;
    }
    TextNode.prototype.clone = function () {
        return new TextNode(this._rawText, null);
    };
    Object.defineProperty(TextNode.prototype, "rawText", {
        get: function () {
            return this._rawText;
        },
        /**
         * Set rawText and invalidate trimmed caches
         */
        set: function (text) {
            this._rawText = text;
            this._trimmedRawText = void 0;
            this._trimmedText = void 0;
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(TextNode.prototype, "trimmedRawText", {
        /**
         * Returns raw text with all whitespace trimmed except single leading/trailing non-breaking space
         */
        get: function () {
            if (this._trimmedRawText !== undefined)
                return this._trimmedRawText;
            this._trimmedRawText = trimText(this.rawText);
            return this._trimmedRawText;
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(TextNode.prototype, "trimmedText", {
        /**
         * Returns text with all whitespace trimmed except single leading/trailing non-breaking space
         */
        get: function () {
            if (this._trimmedText !== undefined)
                return this._trimmedText;
            this._trimmedText = trimText(this.text);
            return this._trimmedText;
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(TextNode.prototype, "text", {
        /**
         * Get unescaped text value of current node and its children.
         * @return {string} text content
         */
        get: function () {
            return (0, he_1.decode)(this.rawText);
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(TextNode.prototype, "isWhitespace", {
        /**
         * Detect if the node contains only white space.
         * @return {boolean}
         */
        get: function () {
            return /^(\s|&nbsp;)*$/.test(this.rawText);
        },
        enumerable: false,
        configurable: true
    });
    TextNode.prototype.toString = function () {
        return this.rawText;
    };
    return TextNode;
}(node_1.default));
exports.default = TextNode;
/**
 * Trim whitespace except single leading/trailing non-breaking space
 */
function trimText(text) {
    var i = 0;
    var startPos;
    var endPos;
    while (i >= 0 && i < text.length) {
        if (/\S/.test(text[i])) {
            if (startPos === undefined) {
                startPos = i;
                i = text.length;
            }
            else {
                endPos = i;
                i = void 0;
            }
        }
        if (startPos === undefined)
            i++;
        else
            i--;
    }
    if (startPos === undefined)
        startPos = 0;
    if (endPos === undefined)
        endPos = text.length - 1;
    var hasLeadingSpace = startPos > 0 && /[^\S\r\n]/.test(text[startPos - 1]);
    var hasTrailingSpace = endPos < (text.length - 1) && /[^\S\r\n]/.test(text[endPos + 1]);
    return (hasLeadingSpace ? ' ' : '') + text.slice(startPos, endPos + 1) + (hasTrailingSpace ? ' ' : '');
}
  },
  "nhp/nodes/comment": function (module, exports, require, process, window, document) {
"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        if (typeof b !== "function" && b !== null)
            throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
var node_1 = __importDefault(require("./node"));
var type_1 = __importDefault(require("./type"));
var CommentNode = /** @class */ (function (_super) {
    __extends(CommentNode, _super);
    function CommentNode(rawText, parentNode, range) {
        var _this = _super.call(this, parentNode, range) || this;
        _this.rawText = rawText;
        /**
         * Node Type declaration.
         * @type {Number}
         */
        _this.nodeType = type_1.default.COMMENT_NODE;
        return _this;
    }
    CommentNode.prototype.clone = function () {
        return new CommentNode(this.rawText, null);
    };
    Object.defineProperty(CommentNode.prototype, "text", {
        /**
         * Get unescaped text value of current node and its children.
         * @return {string} text content
         */
        get: function () {
            return this.rawText;
        },
        enumerable: false,
        configurable: true
    });
    CommentNode.prototype.toString = function () {
        return "<!--".concat(this.rawText, "-->");
    };
    return CommentNode;
}(node_1.default));
exports.default = CommentNode;
  },
  "nhp/nodes/node": function (module, exports, require, process, window, document) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var he_1 = require("he");
/**
 * Node Class as base class for TextNode and HTMLElement.
 */
var Node = /** @class */ (function () {
    function Node(parentNode, range) {
        if (parentNode === void 0) { parentNode = null; }
        this.parentNode = parentNode;
        this.childNodes = [];
        Object.defineProperty(this, 'range', {
            enumerable: false,
            writable: true,
            configurable: true,
            value: range !== null && range !== void 0 ? range : [-1, -1]
        });
    }
    /**
     * Remove current node
     */
    Node.prototype.remove = function () {
        var _this = this;
        if (this.parentNode) {
            var children = this.parentNode.childNodes;
            this.parentNode.childNodes = children.filter(function (child) {
                return _this !== child;
            });
            this.parentNode = null;
        }
        return this;
    };
    Object.defineProperty(Node.prototype, "innerText", {
        get: function () {
            return this.rawText;
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(Node.prototype, "textContent", {
        get: function () {
            return (0, he_1.decode)(this.rawText);
        },
        set: function (val) {
            this.rawText = (0, he_1.encode)(val);
        },
        enumerable: false,
        configurable: true
    });
    return Node;
}());
exports.default = Node;
  },
  "nhp/nodes/type": function (module, exports, require, process, window, document) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var NodeType;
(function (NodeType) {
    NodeType[NodeType["ELEMENT_NODE"] = 1] = "ELEMENT_NODE";
    NodeType[NodeType["TEXT_NODE"] = 3] = "TEXT_NODE";
    NodeType[NodeType["COMMENT_NODE"] = 8] = "COMMENT_NODE";
})(NodeType || (NodeType = {}));
exports.default = NodeType;
  },
};

const NHM_SHIMS = {
  he: { decode: (s) => decodeEntities(String(s)), encode: (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;") },
  "css-select": new Proxy({}, { get: () => () => { throw new UnsupportedHtml("CSS selection inside node-html-parser is not carried"); } }),
};
const NHM_PROCESS = { env: {} };
const nhmCache = {};
function nhmRequire(name, from) {
  if (name in NHM_SHIMS) return NHM_SHIMS[name];
  let key;
  if (name === "node-html-parser") key = "nhp/index";
  else {
    const parts = from.split("/").slice(0, -1);
    for (const p of name.split("/")) {
      if (p === "." || p === "") continue;
      if (p === "..") parts.pop();
      else parts.push(p);
    }
    key = parts.join("/");
    if (!(key in NHM_MODULES) && key + "/index" in NHM_MODULES) key += "/index";
  }
  if (!(key in NHM_MODULES)) throw new Error(`node-html-markdown bundle: no module ${name} from ${from}`);
  if (nhmCache[key]) return nhmCache[key].exports;
  const module = { exports: {} };
  nhmCache[key] = module;
  NHM_MODULES[key](module, module.exports, (n) => nhmRequire(n, key), NHM_PROCESS, undefined, undefined);
  return module.exports;
}

// NodeHtmlMarkdown.translate(html, options), as n8n's Markdown node calls it.
export function htmlToMarkdown(html, options = {}) {
  return nhmRequire("./nhm/index", "x").NodeHtmlMarkdown.translate(html, options);
}
