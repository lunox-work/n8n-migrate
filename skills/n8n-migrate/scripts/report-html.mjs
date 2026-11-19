// The fit report as one self-contained HTML page (`analyze.mjs --html <file>`, start.mjs): the
// totals, then each workflow grouped by outcome with the same lines as the text report
// (renderText is the one place that words them; this file only lays them out). No script, no
// external request; light and dark follow the system.

import { renderText } from "./analyze.mjs";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const GROUPS = [
  { kind: "subscription", title: "Moves to your Claude subscription", tone: "ok" },
  { kind: "replaced", title: "Replaced by Claude itself", tone: "info" },
  { kind: "hosted", title: "Needs hosting elsewhere", tone: "warn" },
  { kind: "keep-in-n8n", title: "Stays in n8n", tone: "no" },
];

// renderText's block for each workflow, in report order: a head line, then indented lines.
export function workflowBlocks(report) {
  const text = renderText(report, false);
  const blocks = text.split("\n\n").slice(0, report.workflows.length);
  return report.workflows.map((w, i) => {
    const [head, ...rest] = (blocks[i] ?? "").split("\n");
    const at = head.indexOf(" — ");
    const lines = rest.map((l) => {
      const t = l.replace(/^ {2}/, "");
      if (t.startsWith("? ")) {
        const m = /^\? (.*?)(?: \[([^\]]+)\])?$/.exec(t);
        return { label: "question", text: m?.[1] ?? t.slice(2), id: m?.[2] ?? null };
      }
      const m = /^([a-z][a-z ]*?): (.*)$/.exec(t);
      return m ? { label: m[1], text: m[2] } : { label: "", text: t };
    });
    return { w, verdict: at >= 0 ? head.slice(at + 3) : head, lines };
  });
}

const LABEL = { why: "Why", needs: "Needs", "to set up": "To set up", approve: "Approve", option: "Option", note: "Note", also: "Also", "setup only": "Setup only", question: "Question" };

function card({ w, verdict, lines }, tone) {
  const rows = lines
    .map((l) => {
      const label = LABEL[l.label] ?? (l.label ? l.label[0].toUpperCase() + l.label.slice(1) : "");
      const id = l.id ? ` <code>${esc(l.id)}</code>` : "";
      return `<div class="row${l.label === "question" ? " q" : ""}"><dt>${esc(label)}</dt><dd>${esc(l.text)}${id}</dd></div>`;
    })
    .join("");
  return `<article class="card"><header><h3>${esc(w.name)}</h3><span class="pill ${tone}">${esc(verdict.split(" · ")[0].replace(/^moves: /, ""))}</span></header><p class="wake">${esc(verdict.split(" · ").slice(1).join(" · "))}</p><dl>${rows}</dl></article>`;
}

// opts.title, opts.next: [{text, code}] steps shown under the totals, opts.generated (ISO).
export function renderHtml(report, opts = {}) {
  const s = report.summary;
  const blocks = workflowBlocks(report);
  const tiles = GROUPS.map((g) => `<div class="tile ${g.tone}"><b>${s.outcomes[g.kind] ?? 0}</b><span>${esc(g.title)}</span></div>`).join("");
  const sections = GROUPS.map((g) => {
    const mine = blocks.filter((b) => b.w.outcome.kind === g.kind);
    return mine.length ? `<section><h2>${esc(g.title)} <span class="count">${mine.length}</span></h2>${mine.map((b) => card(b, g.tone)).join("")}</section>` : "";
  }).join("");
  const next = (opts.next ?? []).length
    ? `<section class="next"><h2>Next</h2><ol>${opts.next.map((n) => `<li>${esc(n.text)}${n.code ? `<pre><code>${esc(n.code)}</code></pre>` : ""}</li>`).join("")}</ol></section>`
    : "";
  const extra = [];
  if (s.questions) extra.push(`${s.questions} open question${s.questions === 1 ? "" : "s"}: answering them can change a verdict.`);
  if (s.inputErrors?.length) extra.push(`${s.inputErrors.length} file${s.inputErrors.length === 1 ? "" : "s"} skipped (not an n8n workflow).`);
  const title = opts.title ?? "n8n workflows on Claude";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#fafafa;--fg:#0a0a0a;--mute:#6b6b6b;--line:#e5e5e5;--card:#fff;--ok:#15803d;--info:#1d4ed8;--warn:#b45309;--no:#b91c1c;--code:#f2f2f2}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--fg:#ededed;--mute:#9a9a9a;--line:#262626;--card:#111;--ok:#4ade80;--info:#93c5fd;--warn:#fbbf24;--no:#f87171;--code:#1c1c1c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:960px;margin:0 auto;padding:40px 16px 64px}
h1{font-size:28px;letter-spacing:-.02em;margin:0 0 4px}h2{font-size:16px;margin:40px 0 12px;display:flex;gap:8px;align-items:center}
.sub{color:var(--mute);margin:0 0 24px}.count{color:var(--mute);font-weight:400}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.tile{border:1px solid var(--line);background:var(--card);border-radius:8px;padding:14px}
.tile b{display:block;font-size:30px;letter-spacing:-.03em}.tile span{color:var(--mute);font-size:13px}
.tile.ok b{color:var(--ok)}.tile.info b{color:var(--info)}.tile.warn b{color:var(--warn)}.tile.no b{color:var(--no)}
.extra{color:var(--mute);font-size:13px;margin-top:10px}
.card{border:1px solid var(--line);background:var(--card);border-radius:8px;padding:16px 18px;margin:0 0 10px}
.card header{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 12px;align-items:baseline}.card h3{margin:0;font-size:15px}
.pill{font-size:12px;border:1px solid currentColor;border-radius:999px;padding:1px 9px;white-space:nowrap}
.pill.ok{color:var(--ok)}.pill.info{color:var(--info)}.pill.warn{color:var(--warn)}.pill.no{color:var(--no)}
.wake{color:var(--mute);font-size:13px;margin:2px 0 10px}dl{margin:0}.row{display:grid;grid-template-columns:96px 1fr;gap:12px;padding:5px 0;border-top:1px solid var(--line)}
dt{color:var(--mute);font-size:13px}dd{margin:0;overflow-wrap:anywhere}.row.q dd{font-style:italic}
code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);border-radius:4px;padding:1px 5px}
pre{background:var(--code);border-radius:6px;padding:10px 12px;overflow-x:auto}pre code{background:none;padding:0}
.next ol{padding-left:20px}.next li{margin:0 0 10px}
footer{color:var(--mute);font-size:12px;margin-top:48px}
@media (max-width:640px){.tiles{grid-template-columns:repeat(2,1fr)}.row{grid-template-columns:1fr;gap:0}}
</style></head><body><main>
<h1>${esc(title)}</h1>
<p class="sub">${s.workflows} workflow${s.workflows === 1 ? "" : "s"} checked by code from the export alone, no model involved.</p>
<div class="tiles">${tiles}</div>
${extra.length ? `<p class="extra">${extra.map(esc).join(" ")}</p>` : ""}
${next}
${sections}
<footer>n8n-migrate ${esc(report.analyzer?.version ?? "")}${opts.generated ? ` · ${esc(opts.generated)}` : ""}</footer>
</main></body></html>
`;
}

// The page for someone who is not technical (migrate.mjs, plain.mjs): three groups in plain
// words, the easiest workflow marked "Start here", the open questions with the likely answer
// first. Claude asks the questions in the conversation; the page only shows them.
const PLAIN_GROUPS = [
  { key: "ready", title: "Ready to move", tone: "ok", empty: "Nothing is ready yet." },
  { key: "needs", title: "Needs one thing from you", tone: "warn", empty: "" },
  { key: "stays", title: "Stays in n8n for now", tone: "mute", empty: "" },
];

function plainCard(x, group, first) {
  const body = [];
  if (group === "ready") body.push(`<p>${esc(x.says)}</p>`);
  if (group === "needs") {
    if (x.says) body.push(`<p>${esc(x.says)}</p>`);
    for (const t of x.todo) {
      const opts = (t.options ?? [])
        .filter((o) => !o.free)
        .map((o) => `<li${o.value === t.assumed ? ' class="likely"' : ""}>${esc(o.label)}${o.value === t.assumed ? " <span>likely</span>" : ""}</li>`);
      body.push(`<div class="todo"><p>${esc(t.text)}</p>${opts.length ? `<ul>${opts.join("")}</ul>` : ""}</div>`);
    }
  }
  if (group === "stays") body.push(`<p>Because ${esc(x.why)}.${x.developer ? " A developer can move it with Claude Code." : ""}</p>`);
  const apps = x.apps?.length && group !== "stays" ? `<span class="apps">${x.apps.map(esc).join(" · ")}</span>` : "";
  return `<article class="card${first ? " first" : ""}">${first ? '<div class="start">Start here</div>' : ""}<header><h3>${esc(x.name)}</h3>${apps}</header>${body.join("")}</article>`;
}

export function renderPlainHtml(plan, opts = {}) {
  const title = opts.title ?? "Your n8n workflows on Claude";
  const ordered = (xs) => [...xs].sort((a, b) => (b.id === plan.easiest) - (a.id === plan.easiest));
  const tiles = PLAIN_GROUPS.map((g) => `<div class="tile ${g.tone}"><b>${plan.counts[g.key]}</b><span>${esc(g.title)}</span></div>`).join("");
  const sections = PLAIN_GROUPS.map((g) => {
    const xs = ordered(plan.groups[g.key]);
    if (!xs.length) return g.empty ? `<section><h2>${esc(g.title)}</h2><p class="mute">${esc(g.empty)}</p></section>` : "";
    return `<section><h2>${esc(g.title)} <span class="count">${xs.length}</span></h2>${xs.map((x) => plainCard(x, g.key, x.id === plan.easiest)).join("")}</section>`;
  }).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#fafafa;--fg:#0a0a0a;--mute:#6b6b6b;--line:#e5e5e5;--card:#fff;--ok:#15803d;--warn:#b45309;--soft:#f2f2f2}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--fg:#ededed;--mute:#9a9a9a;--line:#262626;--card:#111;--ok:#4ade80;--warn:#fbbf24;--soft:#1c1c1c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:40px 16px 64px}
h1{font-size:28px;letter-spacing:-.02em;margin:0 0 4px}h2{font-size:17px;margin:36px 0 12px;display:flex;gap:8px;align-items:center}
.sub,.mute,.count{color:var(--mute)}.count{font-weight:400}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:20px}.tile{border:1px solid var(--line);background:var(--card);border-radius:8px;padding:14px}
.tile b{display:block;font-size:30px;letter-spacing:-.03em}.tile span{color:var(--mute);font-size:13px}.tile.ok b{color:var(--ok)}.tile.warn b{color:var(--warn)}.tile.mute b{color:var(--mute)}
.card{border:1px solid var(--line);background:var(--card);border-radius:8px;padding:14px 16px;margin:0 0 10px}
.card.first{border-color:var(--ok);border-width:2px}.start{color:var(--ok);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px}
.card header{display:flex;flex-wrap:wrap;justify-content:space-between;gap:2px 12px;align-items:baseline}.card h3{margin:0;font-size:16px}
.apps{color:var(--mute);font-size:13px}.card p{margin:6px 0 0}
.todo{border-top:1px solid var(--line);margin-top:10px;padding-top:8px}.todo ul{margin:6px 0 0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:6px}
.todo li{border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:14px}.todo li.likely{border-color:var(--fg)}.todo li span{color:var(--mute);font-size:12px}
footer{color:var(--mute);font-size:12px;margin-top:48px}
@media (max-width:560px){.tiles{grid-template-columns:1fr}}
</style></head><body><main>
<h1>${esc(title)}</h1>
<p class="sub">Nothing has changed in n8n. Claude moves a workflow only when you say so, and switches the n8n one off first so nothing is sent twice.</p>
<div class="tiles">${tiles}</div>
${sections}
<footer>n8n-migrate${opts.generated ? ` · ${esc(opts.generated)}` : ""}</footer>
</main></body></html>
`;
}
