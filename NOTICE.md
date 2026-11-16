# Notice

n8n-to-claude reads the workflow JSON that n8n exports (the editor's Download,
`n8n export:workflow`, or a template's JSON) and writes its own definitions,
runtime and pages from it. It was written without copying n8n's source code:
the runtime re-implements the behaviour of the nodes and expressions it
supports, checked against n8n's documentation and against n8n running in a
local container.

The node catalogue (`skills/n8n-to-claude/references/nodes.json`) is generated
by `scripts/gen-nodes.mjs` from the node descriptions published in the
`n8n-nodes-base` and `@n8n/n8n-nodes-langchain` packages
(`dist/types/nodes.json`): node type names, display names, versions, operation
names and credential type names, the identifiers an export refers to. No
package code is loaded or copied.

n8n is made by n8n GmbH and is distributed under the
[Sustainable Use License](https://docs.n8n.io/sustainable-use-license/) and
the n8n Enterprise License. No n8n code is redistributed here. The
evaluation bench runs the published `n8nio/n8n` Docker image locally as the
baseline; template JSON downloaded for the bench is git-ignored and only
template ids and content hashes are committed.

This project is not affiliated with, endorsed by or sponsored by n8n GmbH or
Anthropic. n8n is a trademark of n8n GmbH. Claude is a trademark of Anthropic,
PBC. Other names are trademarks of their owners and are used only to say what
the software works with.

## Bundled third-party code and assets

- `skills/n8n-to-claude/runtime/vendor/luxon.mjs` (and its copies in
  `runtime/dist/`): [Luxon](https://moment.github.io/luxon/), MIT License,
  copyright JS Foundation and other contributors.
- `skills/n8n-to-claude/runtime/vendor/pdfjs/` (pdf.min.mjs, pdf.worker.min.mjs; copied
  into a migrated folder only when it has a PDF step): [PDF.js](https://mozilla.github.io/pdf.js/)
  (npm pdfjs-dist 6.3.289, legacy build, unmodified), Apache License 2.0, copyright Mozilla
  Foundation; licence and checksums beside it.
- `skills/n8n-to-claude/runtime/vendor/xlsx/` (xlsx.mjs; copied into a migrated folder only
  when it has a spreadsheet step): [SheetJS](https://sheetjs.com/) Community Edition 0.20.3
  (npm @e965/xlsx 0.20.3, unmodified), Apache License 2.0, copyright SheetJS LLC; licence and
  checksum beside it.
- `skills/n8n-to-claude/runtime/src/xml.mjs` (and its copies in `runtime/dist/`): the
  published CommonJS modules of [xml2js](https://github.com/Leonidas-from-XIV/node-xml2js)
  0.6.2 (MIT License, copyright 2010–2013 its authors),
  [xmlbuilder](https://github.com/oozcitak/xmlbuilder-js) 11.0.1 (MIT License, copyright 2013
  Ozgur Ozcitak) and [sax](https://github.com/isaacs/sax-js) 1.2.4 (ISC License, copyright Isaac
  Z. Schlueter and contributors), in a module table with one line changed in xml2js's parser
  (its async error event); licences in the file's header.
- `skills/n8n-to-claude/runtime/src/htmlmarkdown.mjs`: the published CommonJS modules of
  [node-html-markdown](https://github.com/crosstype/node-html-markdown) 1.2.0 (MIT License,
  copyright 2021 Ron S.) and [node-html-parser](https://github.com/taoqf/node-html-parser) 5.4.2
  (MIT License, copyright 2019 Tao Qiufeng), in a module table, with their `he` and `css-select`
  dependencies replaced; licence in the file's header.
- `skills/n8n-to-claude/runtime/src/showdown.mjs`: the published module of
  [showdown](https://github.com/showdownjs/showdown) 2.1.0 (MIT License, copyright 2018, 2021
  ShowdownJS); licence in the file's header.
- `skills/n8n-to-claude/runtime/src/htmltext.mjs`: a port of
  [html-to-text](https://github.com/html-to-text/node-html-to-text) 9.0.5's `convert()` (MIT
  License, copyright 2012–2019 werk85, 2020–2022 KillyMXI), with
  [selderee](https://github.com/mxxii/selderee)'s `pick1` (MIT License, copyright 2021–2022
  KillyMXI) rewritten in place; licence in the file's header.
- `skills/n8n-to-claude/runtime/src/htmldom.mjs` and `htmlentities.mjs`: the HTML node's
  extraction (cheerio 1.1 on parse5 7, htmlparser2, css-select and domutils, which n8n uses) is
  written here to give the same trees, selections and text; no code from those libraries is
  copied. The entity table is the WHATWG HTML Standard's list of named character references (CC
  BY 4.0, copyright WHATWG) as the [entities](https://github.com/fb55/entities) package ships it
  (BSD 2-Clause License, copyright Felix Böhm).
- `skills/n8n-to-claude/runtime/src/feed.mjs`: RSS and Atom parsing follows
  [rss-parser](https://github.com/rbren/rss-parser) 3.13.0's feed building and field lists (MIT
  License, copyright 2016 Bobby Brennan) on xml2js's defaults (MIT, above).
- `skills/n8n-to-claude/runtime/src/rest.mjs` (the Wikipedia and SerpAPI agent tools) and
  `summarize.mjs`: ports of [LangChain.js](https://github.com/langchain-ai/langchainjs) code n8n
  runs: `WikipediaQueryRun` and `SerpAPI` (@langchain/community 1.1.27), the summarization chain's prompts and
  `JSONLoader` (@langchain/classic 1.0.27), the text splitters (@langchain/textsplitters 1.0.1)
  and f-string prompt templates (@langchain/core 1.2.8); `scripts/convert.mjs` carries
  LangChain's structured-chat (ReAct) prompt texts. MIT License, copyright LangChain, Inc.
- `skills/n8n-to-claude/runtime/vendor/pg/` (copied into a migrated folder only when it has a
  Postgres step): [node-postgres](https://github.com/brianc/node-postgres) pg 8.21.0 with
  pg-pool 3.14.0, pg-protocol 1.15.0, pg-connection-string 2.14.0, pg-types 2.2.0, pgpass 1.0.5,
  postgres-array 2.0.0, postgres-bytea 1.0.0, postgres-date 1.0.7, postgres-interval 1.2.0 and
  xtend 4.0.2 (MIT License; copyright Brian Carlson and the packages' authors), pg-int8 1.0.1
  and split2 4.2.0 (ISC License), the npm tarballs' files unmodified; licences and checksums
  beside them (`LICENSES.txt` for the two packages that ship no licence file).
- `skills/n8n-to-claude/runtime/src/pgformat.mjs`: a port of
  [pg-promise](https://github.com/vitaly-t/pg-promise) 11.9.1's query formatting and
  `helpers.concat` (MIT License, copyright 2015–2018 Vitaly Tomilov); licence in the file's
  header.
- `assets/src/fonts/`: DM Mono, DM Sans and Space Grotesk, SIL Open Font
  License 1.1. Used only to render the README images.

Every licence above allows redistribution with the copyright and licence notice kept: MIT
and ISC with the notice, Apache 2.0 with the licence text (beside the vendored files), BSD
2-Clause with the notice and disclaimer, CC BY 4.0 with attribution. The MIT notice for the
ports that carry no header of their own (LangChain.js, rss-parser):

> Permission is hereby granted, free of charge, to any person obtaining a copy of this
> software and associated documentation files (the "Software"), to deal in the Software
> without restriction, including without limitation the rights to use, copy, modify, merge,
> publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to
> whom the Software is furnished to do so, subject to the following conditions: The above
> copyright notice and this permission notice shall be included in all copies or substantial
> portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
> EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
> FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
> HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
> CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
> USE OR OTHER DEALINGS IN THE SOFTWARE.

The BSD 2-Clause notice for the `entities` table (copyright Felix Böhm, all rights reserved):

> Redistribution and use in source and binary forms, with or without modification, are
> permitted provided that the following conditions are met: Redistributions of source code must
> retain the above copyright notice, this list of conditions and the following disclaimer.
> Redistributions in binary form must reproduce the above copyright notice, this list of
> conditions and the following disclaimer in the documentation and/or other materials provided
> with the distribution. THIS IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
> ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
> MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
> COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
> EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE
> GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
> ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
> NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS, EVEN IF ADVISED OF THE
> POSSIBILITY OF SUCH DAMAGE.

Prompt and tool-description texts that n8n sends to a model (a classifier's or an agent's
system text, the Think tool's description) are reproduced where they must match n8n's request
word for word; they are quoted as n8n sends them, not taken from its source code.
