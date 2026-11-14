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
- `assets/src/fonts/`: DM Mono, DM Sans and Space Grotesk, SIL Open Font
  License 1.1. Used only to render the README images.
