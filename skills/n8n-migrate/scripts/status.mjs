#!/usr/bin/env node
// What runs on Claude now, kept in the page the person already has (migrate.mjs page.html):
// after a workflow is switched on, the same page shows it under "Running on Claude" with its
// last run, the link to its own page and how to undo it. The page carries its plan as JSON,
// so this works from the folder migrate.mjs wrote or, in a later conversation, from the
// published page saved to a file (the Artifact tool's read). Files only: it never schedules,
// pauses or switches anything; the conversation does that, then records it here and publishes
// the page again to the same link.
//
//   status.mjs <page.html | folder> moved <workflow id> --page <the workflow's page link>
//              [--task <task name>] [--when "<every day at 08:00>"] [--zone <IANA zone>]
//              [--n8n off|was-off] [--at <ISO time>]
//       The workflow was switched on. --n8n was-off: the export showed it off already.
//   status.mjs <page> ran <workflow id> --outcome done|failed|stopped [--did "<plain words>"]...
//              [--at <ISO time>]
//       Its latest run, from the workflow's own page. --did: what it sent, as the person would
//       say it ("drafted a reply to Ana"); never a message body or an address list.
//   status.mjs <page> undone <workflow id>
//       It was paused on Claude and switched back on in n8n: back under "Ready to move".
//   status.mjs <page> show
//       What runs on Claude, as text.
//
// Writes the page in place, and plan.json beside it when there is one.
// Exit: 0 written (or shown), 1 the page or the workflow is not known, 2 bad usage.

import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readPlainPage, renderPlainHtml } from "./report-html.mjs";

const USAGE = `usage: status.mjs <page.html | folder> moved <workflow id> --page <link> [--task <name>] [--when "<words>"] [--zone <IANA zone>] [--n8n off|was-off] [--at <ISO>]
       status.mjs <page> ran <workflow id> --outcome done|failed|stopped [--did "<plain words>"]... [--at <ISO>]
       status.mjs <page> undone <workflow id>
       status.mjs <page> show`;
const PAGE_LINK = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+$/;
const GROUPS = ["ready", "needs", "stays"];

const workflowOf = (plan, id) => GROUPS.flatMap((g) => plan.groups?.[g] ?? []).find((x) => String(x.id) === String(id)) ?? null;

// The moved map with one change applied. -> {plan} or {error}
export function applyStatus(plan, cmd, id, o = {}) {
  const x = workflowOf(plan, id);
  if (!x) return { error: `no workflow with id ${id} in this page` };
  const moved = { ...(plan.moved ?? {}) };
  const at = o.at ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(at))) return { error: `--at is not a time: ${at}` };
  if (cmd === "moved") {
    if (!PAGE_LINK.test(String(o.page ?? ""))) return { error: "--page must be the workflow page's claude.ai/artifact/… link" };
    if (o.n8n !== undefined && !["off", "was-off"].includes(o.n8n)) return { error: "--n8n is off or was-off" };
    moved[String(id)] = { since: at, page: o.page, ...(o.task ? { task: o.task } : {}), ...(o.when ? { when: o.when } : {}), ...(o.zone ? { zone: o.zone } : {}), n8n: o.n8n ?? "off", ...(moved[String(id)]?.lastRun ? { lastRun: moved[String(id)].lastRun } : {}) };
  } else if (cmd === "ran") {
    if (!moved[String(id)]) return { error: `"${x.name}" is not recorded as running on Claude; record the switch-on first (moved)` };
    if (!["done", "failed", "stopped"].includes(o.outcome)) return { error: "--outcome is done, failed or stopped" };
    moved[String(id)] = { ...moved[String(id)], lastRun: { at, outcome: o.outcome, did: (o.did ?? []).map((t) => String(t).trim()).filter(Boolean) } };
  } else if (cmd === "undone") {
    if (!moved[String(id)]) return { error: `"${x.name}" is not recorded as running on Claude` };
    delete moved[String(id)];
  } else return { error: `unknown command ${cmd}` };
  const next = { ...plan, moved };
  if (!Object.keys(moved).length) delete next.moved;
  return { plan: next, name: x.name };
}

export function showStatus(plan) {
  const on = Object.entries(plan.moved ?? {});
  if (!on.length) return "Nothing runs on Claude yet.\n";
  return (
    on
      .map(([id, m]) => {
        const x = workflowOf(plan, id);
        const r = m.lastRun;
        return `${x?.name ?? id} (${id}): on Claude since ${m.since}${m.task ? `, task "${m.task}"` : ""}; ${r ? `last run ${r.at} ${r.outcome}${r.did?.length ? `: ${r.did.join("; ")}` : ""}` : "no run yet"}; page ${m.page}`;
      })
      .join("\n") + "\n"
  );
}

function main(argv = process.argv.slice(2)) {
  const [where, cmd, id] = argv;
  const flag = (n) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const flags = (n) => argv.flatMap((a, i) => (a === `--${n}` && argv[i + 1] !== undefined ? [argv[i + 1]] : []));
  if (!where || !["moved", "ran", "undone", "show"].includes(cmd) || (cmd !== "show" && !id)) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const page = existsSync(where) && statSync(where).isDirectory() ? join(resolve(where), "page.html") : resolve(where);
  if (!existsSync(page)) {
    process.stderr.write(`no page at ${page}\n`);
    return 1;
  }
  const plan = readPlainPage(readFileSync(page, "utf8"));
  if (!plan?.groups) {
    process.stderr.write("this is not a page written by migrate.mjs (it carries no plan); run migrate.mjs again and publish that page\n");
    return 1;
  }
  if (cmd === "show") {
    process.stdout.write(showStatus(plan));
    return 0;
  }
  const r = applyStatus(plan, cmd, id, { page: flag("page"), task: flag("task"), when: flag("when"), zone: flag("zone"), n8n: flag("n8n"), at: flag("at"), outcome: flag("outcome"), did: flags("did") });
  if (r.error) {
    process.stderr.write(`${r.error}\n`);
    return 1;
  }
  writeFileSync(page, renderPlainHtml(r.plan, { generated: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC" }));
  const planFile = join(dirname(page), "plan.json");
  if (existsSync(planFile)) writeFileSync(planFile, JSON.stringify(r.plan, null, 2) + "\n");
  process.stdout.write(`${cmd === "moved" ? `"${r.name}" is recorded as running on Claude` : cmd === "ran" ? `the last run of "${r.name}" is recorded` : `"${r.name}" is back under Ready to move`}. Publish ${page} again to the same link.\n`);
  return 0;
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) process.exitCode = main();
