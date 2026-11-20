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
//
// After a workflow is switched on the same page is its status: `plan.moved` (status.mjs writes
// it) holds, per workflow id, {since, page, task?, when?, zone?, n8n?, lastRun?: {at, outcome,
// did: [text]}}. Those workflows leave their group for "Running on Claude", each with its last
// run, the link to its own page (every run's history) and how to undo it. The plan is also
// carried in the page as JSON (readPlainPage), so a later conversation that has only the
// published page can update it; nothing in the page runs.
const MOVED = { key: "moved", title: "Running on Claude", tone: "ok" };
const PAGE_LINK = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+$/;
const jsonForScript = (v) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
export function readPlainPage(html) {
  const m = /<script type="application\/json" id="n8m-plan">([\s\S]*?)<\/script>/.exec(String(html));
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}
// Day, month, year and time ("20 Nov …, 08:03") in the workflow's timezone when it is known,
// else in UTC and said so.
function when(iso, zone) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  let z = zone || "UTC";
  let f;
  try {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: z, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  } catch {
    z = "UTC";
    f = new Intl.DateTimeFormat("en-GB", { timeZone: z, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return `${f.format(d)}${z === "UTC" ? " UTC" : ""}`;
}
const sentence = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : (xs[0] ?? ""));
function movedCard(x, m) {
  const body = [`<p>${esc(m.when ? `Runs on Claude ${m.when}${x.apps?.length ? `, with ${x.apps.join(" and ")}` : ""}.` : x.says || "Runs on Claude.")} <span class="mute">Since ${esc(when(m.since, m.zone))}.</span></p>`];
  const r = m.lastRun;
  if (!r) body.push('<p class="mute">No run yet.</p>');
  else if (r.outcome === "done") body.push(`<p><b>Last run</b> ${esc(when(r.at, m.zone))}: finished.${r.did?.length ? ` It ${esc(sentence(r.did))}.` : ""}</p>`);
  else if (r.outcome === "stopped") body.push(`<p class="warn"><b>Last run</b> ${esc(when(r.at, m.zone))}: stopped and is waiting for you. Open its page to see what it asks.</p>`);
  else body.push(`<p class="warn"><b>Last run</b> ${esc(when(r.at, m.zone))}: did not finish.${r.did?.length ? ` Before that it ${esc(sentence(r.did))}.` : ""} Open its page to see why.</p>`);
  const link = PAGE_LINK.test(String(m.page ?? "")) ? `<a href="${esc(m.page)}">Every run and what it sent</a>` : "";
  const undo = `To undo, tell Claude: <q>undo ${esc(x.name)}</q>. Claude pauses it here first${m.n8n === "was-off" ? "; it was already off in n8n" : ", then switches it back on in n8n, so nothing is sent twice"}.`;
  body.push(`<p class="foot">${link}${link ? " · " : ""}${undo}</p>`);
  const apps = x.apps?.length ? `<span class="apps">${x.apps.map(esc).join(" · ")}</span>` : "";
  return `<article class="card on"><header><h3>${esc(x.name)}</h3>${apps}</header>${body.join("")}</article>`;
}

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
        .map((o) => `<li${o.value === (t.likely ?? t.assumed) ? ' class="likely"' : ""}>${esc(o.label)}${o.value === (t.likely ?? t.assumed) ? " <span>likely</span>" : ""}</li>`);
      body.push(`<div class="todo"><p>${esc(t.text)}</p>${opts.length ? `<ul>${opts.join("")}</ul>` : ""}</div>`);
    }
  }
  if (group === "stays") body.push(`<p>Because ${esc(x.why)}.${x.developer ? " A developer can move it with Claude Code." : ""}</p>`);
  const apps = x.apps?.length && group !== "stays" ? `<span class="apps">${x.apps.map(esc).join(" · ")}</span>` : "";
  return `<article class="card${first ? " first" : ""}">${first ? '<div class="start">Start here</div>' : ""}<header><h3>${esc(x.name)}</h3>${apps}</header>${body.join("")}</article>`;
}

export function renderPlainHtml(plan, opts = {}) {
  const title = opts.title ?? "Your n8n workflows on Claude";
  // Workflows already switched on leave their group; the first move is marked among the rest.
  const moved = plan.moved ?? {};
  const isOn = (x) => Object.prototype.hasOwnProperty.call(moved, String(x.id));
  const everything = PLAIN_GROUPS.flatMap((g) => plan.groups[g.key]);
  const on = everything.filter(isOn);
  const rest = Object.fromEntries(PLAIN_GROUPS.map((g) => [g.key, plan.groups[g.key].filter((x) => !isOn(x))]));
  const first = isOn({ id: plan.easiest }) ? (rest.ready.find((x) => x.runs !== "nothing")?.id ?? null) : plan.easiest;
  const tileList = [...(on.length ? [{ ...MOVED, n: on.length }] : []), ...PLAIN_GROUPS.map((g) => ({ ...g, n: rest[g.key].length }))];
  const tiles = tileList.map((g) => `<div class="tile ${g.tone}"><b>${g.n}</b><span>${esc(g.title)}</span></div>`).join("");
  const movedSection = on.length ? `<section><h2>${esc(MOVED.title)} <span class="count">${on.length}</span></h2>${on.map((x) => movedCard(x, moved[String(x.id)])).join("")}</section>` : "";
  const sections =
    movedSection +
    PLAIN_GROUPS.map((g) => {
      const xs = [...rest[g.key]].sort((a, b) => (b.id === first) - (a.id === first));
      if (!xs.length) return g.empty && !on.length ? `<section><h2>${esc(g.title)}</h2><p class="mute">${esc(g.empty)}</p></section>` : "";
      return `<section><h2>${esc(g.title)} <span class="count">${xs.length}</span></h2>${xs.map((x) => plainCard(x, g.key, x.id === first)).join("")}</section>`;
    }).join("");
  const sub = on.length
    ? `${on.length === 1 ? "One workflow runs" : `${on.length} workflows run`} on Claude now; ${on.length === 1 ? "its n8n copy is" : "their n8n copies are"} switched off. Claude moves another only when you say so, and switches the n8n one off first so nothing is sent twice.`
    : "Nothing has changed in n8n. Claude moves a workflow only when you say so, and switches the n8n one off first so nothing is sent twice.";
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
.tiles{display:grid;grid-template-columns:repeat(${tileList.length},1fr);gap:8px;margin-top:20px}.tile{border:1px solid var(--line);background:var(--card);border-radius:8px;padding:14px}
.tile b{display:block;font-size:30px;letter-spacing:-.03em}.tile span{color:var(--mute);font-size:13px}.tile.ok b{color:var(--ok)}.tile.warn b{color:var(--warn)}.tile.mute b{color:var(--mute)}
.card{border:1px solid var(--line);background:var(--card);border-radius:8px;padding:14px 16px;margin:0 0 10px}
.card.first{border-color:var(--ok);border-width:2px}.start{color:var(--ok);font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px}
.card header{display:flex;flex-wrap:wrap;justify-content:space-between;gap:2px 12px;align-items:baseline}.card h3{margin:0;font-size:16px}
.apps{color:var(--mute);font-size:13px}.card p{margin:6px 0 0}
.card.on{box-shadow:inset 3px 0 0 var(--ok)}.card p.warn{color:var(--warn)}.card p.foot{color:var(--mute);font-size:14px;border-top:1px solid var(--line);margin-top:10px;padding-top:8px}
.card a{color:inherit}q{font-weight:600;color:var(--fg)}
.todo{border-top:1px solid var(--line);margin-top:10px;padding-top:8px}.todo ul{margin:6px 0 0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:6px}
.todo li{border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:14px}.todo li.likely{border-color:var(--fg)}.todo li span{color:var(--mute);font-size:12px}
footer{color:var(--mute);font-size:12px;margin-top:48px}
@media (max-width:560px){.tile{padding:10px}.tile b{font-size:24px}.tile span{font-size:12px}${tileList.length > 3 ? ".tiles{grid-template-columns:repeat(2,1fr)}" : ""}}
</style></head><body><main>
<h1>${esc(title)}</h1>
<p class="sub">${esc(sub)}</p>
<div class="tiles">${tiles}</div>
${sections}
<footer>n8n-migrate${opts.generated ? ` · ${esc(opts.generated)}` : ""}</footer>
</main>
<script type="application/json" id="n8m-plan">${jsonForScript(plan)}</script>
</body></html>
`;
}
