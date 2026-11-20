// The report in plain words for someone who is not technical (a claude.ai chat or Cowork):
// every workflow lands in one of three groups, with one sentence each and nothing to read
// about tasks, surfaces or definitions.
//
//   ready  Ready to move: Claude can run it with no help from the person beyond a go-ahead.
//   needs  Needs one thing from you: an app to connect, or one question that decides it.
//   stays  Stays in n8n for now: the reason, and whether a developer could move it.
//
// It only reads what analyze.mjs (and, when given, convert.mjs) already decided; it never
// changes a verdict. Where it runs: a scheduled workflow becomes a Claude scheduled task
// (in Cowork: Scheduled), a chat workflow a skill, a manual one a page with a Run button or a
// skill. Anything that needs a stored key, a Google token, a database, the person's own disk
// or network, or runs more often than hourly, stays for this person: those need Claude Code
// (`claude-code` below) and are listed as "a developer can move it".
//
// Inputs per workflow: the analyzer's workflow record, the convert summary entry for it and
// the blocked or substituted steps from its definition.json (convertedSteps reads them), the
// person's answers (analyzer question ids, plus `<workflow id>/cadence`), and what Claude
// knows about the session: which connectors are connected and the person's timezone.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Requirement kinds a scheduled task with only the person's connectors cannot have; each
// needs Claude Code (a stored key, a token refresh, a database client, the computer).
// Observed 2026-11-19 in a claude.ai scheduled task's sandbox: outbound HTTPS goes through a
// filtering proxy (api.github.com answered, example.com and n8n.io did not), so a workflow that
// calls web services itself (http) cannot run there either.
const DEVELOPER_ONLY = {
  http: "calls web services directly, which Claude's online sandbox blocks",
  secret: "signs in with a saved key, which only Claude Code can keep today",
  "google-token": "signs in to Google with its own token, which needs a setup only Claude Code has today",
  db: "uses a database, which needs Claude Code",
  "db-client": "uses a database, which needs Claude Code",
  "host-disk": "reads or writes files on a computer, which needs Claude Code on that computer",
  "local-network": "reaches a computer on your own network, which needs Claude Code on that network",
  vector: "uses a vector store, which is not supported yet",
  state: "keeps its own memory between runs, which is not supported yet",
  "mcp-server": "talks to a custom MCP server, which needs setting up as a connector first",
  relay: "is started by another service pushing to it, which needs a small server in front",
  "task-handoff": "collects form entries and processes them later, which needs Claude Code",
  "missing-export": "uses another workflow that is missing",
};

// Cadences a scheduled task offers (support article 13854387: hourly, daily, weekly, weekdays).
// cron has seconds first, as the converter writes n8n's schedules.
export const CADENCES = {
  hourly: { seconds: 3600, words: "every hour", cron: "0 0 * * * *", runsPerDay: 24 },
  daily: { seconds: 86400, words: "every day at 09:00", cron: "0 0 9 * * *", runsPerDay: 1 },
  weekly: { seconds: 604800, words: "every Monday at 09:00", cron: "0 0 9 * * 1", runsPerDay: 1 / 7 },
};

const APP_NAMES = {
  gmail: "Gmail",
  "google-drive": "Google Drive",
  "google-calendar": "Google Calendar",
  notion: "Notion",
  slack: "Slack",
  github: "GitHub",
  "microsoft-365": "Microsoft 365",
  jira: "Jira",
  confluence: "Confluence",
  clickup: "ClickUp",
  hubspot: "HubSpot",
  atlassian: "Atlassian",
};
export const appName = (c) => APP_NAMES[c] ?? String(c).replace(/(^|-)([a-z])/g, (_, s, ch) => `${s ? " " : ""}${ch.toUpperCase()}`);

// A credential in words, from its type when the report has it ("openAiApi" -> "OpenAI"), else
// from its name; the name is the person's own label, so the type comes first.
const CREDENTIAL_APPS = {
  openai: "OpenAI",
  serp: "SerpAPI",
  telegram: "Telegram",
  wordpress: "WordPress",
  pinecone: "Pinecone",
  supabase: "Supabase",
  notion: "Notion",
  googlepalm: "Google Gemini",
  facebookgraph: "Facebook",
  whatsapp: "WhatsApp",
  httpheaderauth: "a web service",
  httpcustomauth: "a web service",
  httpbasicauth: "a web service",
  httpqueryauth: "a web service",
  httprequest: "a web service",
  linkedin: "LinkedIn",
  twitter: "X",
  gmail: "Gmail",
  n8n: "your n8n",
  postgres: "Postgres",
  mysql: "MySQL",
  woocommerce: "WooCommerce",
  s3: "S3",
  anthropic: "Anthropic",
  groq: "Groq",
  mistralcloud: "Mistral",
  ollama: "Ollama",
  elevenlabs: "ElevenLabs",
  airtable: "Airtable",
  hubspot: "HubSpot",
  microsoftoutlook: "Outlook",
};
export function credentialApp(name, type = null) {
  const k = String(type ?? name)
    .replace(/\s*\(.*$/, "")
    .replace(/\s+(credential|account).*$/i, "")
    .replace(/(OAuth2)?Api$/i, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
  return CREDENTIAL_APPS[k] ?? (k ? k[0].toUpperCase() + k.slice(1) : "a service");
}

const q1 = (s) => `"${String(s).replace(/"/g, "'")}"`;

const listWords = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : (xs[0] ?? ""));

function cadenceOf(seconds) {
  return Object.entries(CADENCES).find(([, c]) => c.seconds === seconds)?.[0] ?? null;
}
function everyWords(seconds) {
  if (seconds == null) return "on its schedule";
  const c = cadenceOf(seconds);
  if (c) return { hourly: "every hour", daily: "every day", weekly: "every week" }[c];
  if (seconds < 3600) return `every ${Math.round(seconds / 60)} minute${seconds === 60 ? "" : "s"}`;
  if (seconds < 86400) return `every ${Math.round(seconds / 3600)} hours`;
  return `every ${Math.round(seconds / 86400)} days`;
}

// A question in plain words with options, or null when the person need not see it. Only
// questions that can move the workflow between groups, or that a run cannot do without, are
// shown; the rest keep their assumed answer (a step that might write counts as a write).
export function plainQuestion(q, w, { timezone } = {}) {
  const kind = q.id.split("/")[1];
  const node = q.nodes?.[0] ?? "";
  const base = { id: q.id };
  if (kind === "chat-app-users")
    return {
      ...base,
      text: `Who messages the bot ${q1(node)} and waits for its replies?`,
      options: [
        { value: "outsiders", label: "Customers or other people" },
        { value: "in-claude", label: "Only me, and I'm happy to message Claude instead" },
        { value: "no-reply", label: "Nobody waits for a reply" },
      ],
      assumed: q.assumed,
    };
  if (kind === "endpoint-callers")
    return {
      ...base,
      text: `Who uses the web address of ${q1(node)} and waits for its answer?`,
      options: [
        { value: "outsiders", label: "Other people or other systems" },
        { value: "only-me", label: "Only me" },
      ],
      assumed: q.assumed,
    };
  if (kind === "chat-outsiders")
    return {
      ...base,
      text: `Do people outside your organisation use the chat page of ${q1(node)}?`,
      options: [
        { value: false, label: "No, only us" },
        { value: true, label: "Yes" },
      ],
      assumed: q.assumed,
    };
  if (kind === "form-outsiders")
    return {
      ...base,
      text: `Do people outside your organisation fill in the form ${q1(node)}?`,
      options: [
        { value: false, label: "No, only people in my organisation" },
        { value: true, label: "Yes, anyone with the link" },
      ],
      assumed: q.assumed,
    };
  if (kind === "mcp-only-client")
    return {
      ...base,
      text: `Is Claude the only app that uses ${q1(node)}?`,
      options: [
        { value: true, label: "Yes" },
        { value: false, label: "No, other apps use it too" },
      ],
      assumed: q.assumed,
    };
  if (kind === "hosts")
    return {
      ...base,
      text: `The step ${q1(node)} visits web addresses it finds while running. Which websites may it visit?`,
      options: [
        { value: "public", label: "Any public website" },
        { value: null, label: "Only these (type them)", free: true },
      ],
      assumed: null,
    };
  if (kind === "search-with")
    return {
      ...base,
      text: `The step ${q1(node)} searches the web with SerpAPI and your own key. Let Claude search the web itself instead? Its results can differ a little.`,
      options: [
        { value: "claude", label: "Yes, use Claude's search" },
        { value: "keep", label: "No, keep SerpAPI" },
      ],
      assumed: q.assumed,
      // Unanswered it keeps SerpAPI (assumed); for someone moving off n8n the likely answer
      // is the one that lets the workflow move.
      likely: "claude",
    };
  if (kind === "timezone") {
    if ((w.schedule?.shortestIntervalSec ?? 0) < 86400) return null;
    return { ...base, text: `Which timezone should ${q1(w.name)} run in?`, options: [{ value: timezone ?? q.assumed, label: timezone ?? q.assumed }], assumed: timezone ?? q.assumed, free: true };
  }
  return null;
}

function substitutionText(id, names) {
  const which = names.length > 1 ? `The steps ${listWords(names.map(q1))}` : `The step ${q1(names[0])}`;
  if (id === "llm-api-to-claude") return `${which} ${names.length > 1 ? "call" : "calls"} another AI service with your API key. Use Claude for ${names.length > 1 ? "them" : "it"} instead?`;
  if (id === "smtp-to-gmail") return `${which} ${names.length > 1 ? "send" : "sends"} email through a mail server. Send from your Gmail instead?`;
  return `${which} cannot run on Claude as ${names.length > 1 ? "they are" : "it is"}. Use a Claude replacement (${id})?`;
}

// The same question about several steps (five webhooks in one workflow) is asked once; its
// answer goes to every id in `ids`.
const PLURAL = {
  "endpoint-callers": (ns) => `Who uses the web addresses of ${listWords(ns.map(q1))} and waits for their answers?`,
  "chat-app-users": (ns) => `Who messages the bots ${listWords(ns.map(q1))} and waits for their replies?`,
  hosts: (ns) => `The steps ${listWords(ns.map(q1))} visit web addresses they find while running. Which websites may they visit?`,
};
function mergeQuestions(qs) {
  const out = [];
  for (const q of qs) {
    const kind = q.id.split("/")[1];
    const same = out.find((x) => x.id.split("/")[1] === kind && JSON.stringify(x.options) === JSON.stringify(q.options) && x.assumed === q.assumed && PLURAL[kind]);
    if (!same) {
      out.push({ ...q, ids: [q.id], nodes: [q.id.split("/").slice(2).join("/")] });
      continue;
    }
    same.ids.push(q.id);
    same.nodes.push(q.id.split("/").slice(2).join("/"));
    same.text = PLURAL[kind](same.nodes);
  }
  return out.map(({ nodes, ...q }) => q);
}

// The steps of a converted folder that keep it from running, and the substitutions it offers.
export function convertedSteps(folder) {
  const p = join(folder, "definition.json");
  if (!existsSync(p)) return { blocked: [], substitutions: [] };
  const def = JSON.parse(readFileSync(p, "utf8"));
  const blocked = [];
  const substitutions = [];
  for (const [name, s] of Object.entries(def.steps ?? {})) {
    if (s.substitution && !s.substitution.approved) substitutions.push({ step: name, id: s.substitution.id, from: s.substitution.from, to: s.substitution.to });
    if (s.kind === "blocked" && s.blocked?.kind !== "substitution") blocked.push({ step: name, reason: s.blocked?.reason ?? "not supported yet" });
  }
  return { blocked, substitutions };
}

function stayWhy(w) {
  const o = w.outcome;
  const r = String(o.reason ?? "");
  if (o.kind === "hosted") {
    if (/chat app/.test(r)) return "people message it in a chat app and wait for each answer, which needs a server running all the time";
    if (/outsiders chat/.test(r)) return "people outside your organisation chat with it on a public page, which needs a server";
    if (/fill the form/.test(r)) return "people outside your organisation fill in its form and wait for the result, which needs a server";
    if (/other MCP clients/.test(r)) return "other apps use it, so it needs a server";
    return "another system calls it and waits for the answer, which needs a server running all the time";
  }
  if (/human reply through an n8n webhook|waits for a person/.test(r)) return "it waits for a person to reply partway through, which is not supported yet";
  if (/error workflow/.test(r)) return "it handles errors for the workflows that stay in n8n";
  if (/not an automation|tutorial/.test(r)) return "it looks like an n8n tutorial";
  return r || "it uses something Claude cannot run yet";
}

// One workflow in plain words.
//   w: analyzer workflow record; conv: {status, folder} from convert's summary (optional);
//   steps: convertedSteps(folder) (optional); answers: {id: value}; connected: connector
//   names known to be connected (null: unknown); timezone: the person's IANA zone.
//   whatIf(w, {id: value}): whether that answer would let a person without Claude Code move it
//   (plainReport builds it from a re-analysis); without it every rescue question is shown.
const RESCUE = new Set(["chat-app-users", "endpoint-callers", "chat-outsiders", "form-outsiders", "mcp-only-client"]);
const SWAP = new Set(["search-with"]);
export function plainWorkflow(w, { conv = null, steps = null, answers = {}, connected = null, timezone = null, whatIf = null } = {}) {
  const o = w.outcome;
  const out = { id: w.id, name: w.name, group: "stays", runs: null, says: "", why: null, todo: [], fix: [], developer: false, folder: conv?.folder ?? null, unverified: [] };
  // Whether n8n runs it now, from the export: "off" skips the switch-off step, "unknown" (a
  // paste from the editor) is asked together with the go-ahead.
  out.n8n = w.activeInN8n === true ? "on" : w.activeInN8n === false ? "off" : "unknown";
  const connectors = [...new Set((w.requires ?? []).filter((r) => r.kind === "connector").map((r) => r.name))];
  out.apps = connectors.map(appName);

  // Another workflow that was not shared: Claude fetches it itself before showing the page.
  const missing = (w.blockers ?? []).filter((b) => b.kind === "input-incomplete" && /sub-workflow/.test(b.reason));
  if (missing.length) {
    for (const b of missing) {
      const m = /"([^"]+)"(?: \("([^"]+)"\))?/.exec(b.reason);
      out.fix.push({ kind: "fetch-sub-workflow", id: m?.[1] ?? null, name: m?.[2] ?? null });
    }
    out.why = `it uses another workflow${out.fix[0].name ? `, ${q1(out.fix[0].name)},` : ""} that was not shared`;
    return out;
  }

  // A tutorial: nothing worth moving.
  if ((w.blockers ?? []).some((b) => b.kind === "not-an-automation")) {
    out.why = "it looks like an n8n tutorial or example, so there is nothing to move";
    return out;
  }

  if (o.kind === "replaced") {
    out.group = "ready";
    out.runs = "nothing";
    out.says = `Claude does this itself${connectors.length ? ` once ${out.apps.join(" and ")} ${connectors.length > 1 ? "are" : "is"} connected` : ""}: nothing to move, and you can switch it off in n8n.`;
    return out;
  }

  // Questions whose other answer could bring it over, or that a run cannot do without.
  const shown = mergeQuestions(
    (w.questions ?? [])
      .filter((q) => q.answer == null && answers[q.id] === undefined)
      .map((q) => plainQuestion(q, w, { timezone }))
      .filter(Boolean),
  );

  if (o.kind !== "subscription") {
    out.why = stayWhy(w);
    const rescue = shown.filter((q) => RESCUE.has(q.id.split("/")[1]) && (!whatIf || q.options.some((op) => op.value !== q.assumed && whatIf(w, { [q.id]: op.value }))));
    if (rescue.length && o.kind === "hosted") {
      out.group = "needs";
      out.todo.push(...rescue.map((q) => ({ kind: "question", ...q })));
    }
    return out;
  }

  // On the subscription: can a person without Claude Code have it?
  const devKinds = [...new Set((w.requires ?? []).map((r) => r.kind).filter((k) => DEVELOPER_ONLY[k]))];
  const wake = w.wakeup?.kind;
  const every = w.schedule?.shortestIntervalSec ?? null;
  if (devKinds.length) {
    // A swap to something Claude has built in (its own web search for a search service with a
    // key) that would let it move: ask that, instead of sending the person to a developer.
    const swaps = shown.filter((q) => SWAP.has(q.id.split("/")[1]) && whatIf && q.options.some((op) => op.value !== q.assumed && whatIf(w, Object.fromEntries(q.ids.map((id) => [id, op.value])))));
    if (swaps.length) {
      out.group = "needs";
      out.todo.push(...swaps.map((q) => ({ kind: "question", ...q })));
      return out;
    }
    out.developer = true;
    const typeOf = new Map((w.credentials ?? []).map((c) => [c.name, c.type]));
    const apps = [...new Set((w.requires ?? []).filter((r) => r.kind === "secret").map((r) => credentialApp(r.name, typeOf.get(r.name))))];
    out.why = devKinds[0] === "secret" && apps.length ? `it signs in to ${listWords(apps)} with a saved key, which only Claude Code can keep today` : `it ${DEVELOPER_ONLY[devKinds[0]]}`;
    return out;
  }
  if (wake === "schedule" && every != null && every < 3600) {
    out.developer = true;
    out.why = `it runs ${everyWords(every)}, and Claude's scheduled tasks run at most every hour (Claude Code on your computer can run it more often)`;
    return out;
  }

  // Where it runs, in words.
  const cadence = answers[`${w.id}/cadence`] ?? (every != null ? cadenceOf(every) : null);
  if (wake === "schedule" || wake === "poll") {
    out.runs = "scheduled-task";
    out.unverified.push("scheduled-task-runs-the-runner");
    if (!cadence) {
      out.todo.push({
        kind: "question",
        id: `${w.id}/cadence`,
        text:
          wake === "poll"
            ? `${q1(w.name)} checks for new items ${everyWords(every)}. Claude checks at most every hour. Is every hour all right?`
            : `${q1(w.name)} runs ${everyWords(every)}. Claude's scheduled tasks run every hour, day or week. Which should it be?`,
        options: wake === "poll" ? [{ value: "hourly", label: "Yes, every hour" }] : Object.entries(CADENCES).map(([v, c]) => ({ value: v, label: c.words })),
        assumed: wake === "poll" ? "hourly" : null,
      });
    }
    // A chosen cadence names its time; the workflow's own schedule keeps its own.
    const chosen = answers[`${w.id}/cadence`];
    const when = chosen ? CADENCES[chosen].words : cadence ? everyWords(every) : wake === "poll" ? "every hour, if that is all right" : "on a schedule you pick";
    out.says = `Runs on Claude ${when}${out.apps.length ? `, with ${out.apps.join(" and ")}` : ""}.`;
  } else if (o.target === "skill") {
    out.runs = "skill";
    out.says = wake === "chat" ? "Becomes a skill: you message Claude and it runs this workflow." : "Runs whenever you ask Claude to.";
  } else if (o.target === "artifact") {
    out.runs = "page";
    out.says = "Becomes a page with a Run button.";
  } else if (o.target === "artifact-form") {
    out.runs = "form";
    out.says = "Becomes a form page for people in your organisation.";
  } else {
    out.runs = "scheduled-task";
    out.says = "Runs on Claude.";
  }

  // What the conversion found.
  if (conv?.status === "refused") {
    out.group = "stays";
    out.why = "it could not be converted";
    return out;
  }
  if (steps?.blocked?.length) {
    out.group = "stays";
    out.runs = null;
    const b = steps.blocked[0];
    out.why = steps.blocked.length === 1 ? `its step ${q1(b.step)} cannot move yet` : `${steps.blocked.length} of its steps cannot move yet, starting with ${q1(b.step)}`;
    out.blocked = steps.blocked;
    return out;
  }
  const subs = new Map();
  for (const s of steps?.substitutions ?? []) if (!(answers.approve ?? []).includes(s.id)) subs.set(s.id, [...(subs.get(s.id) ?? []), s.step]);
  for (const [id, names] of subs)
    out.todo.push({
      kind: "approve",
      id,
      text: substitutionText(id, names),
      options: [
        { value: true, label: "Yes" },
        { value: false, label: "No, keep it as it is" },
      ],
      assumed: null,
    });

  // Apps to connect, when Claude knows what is connected.
  if (connected) for (const c of connectors) if (!connected.includes(c)) out.todo.push({ kind: "connect", connector: c, text: `Connect ${appName(c)} (Customize > Connectors)` });
  out.todo.push(...shown.map((q) => ({ kind: "question", ...q })));
  out.group = out.todo.length ? "needs" : "ready";
  return out;
}

// The order the page offers the first move in: fewest apps, then a page or skill before a
// schedule (a test run shows its result at once), then name.
const RUNS_ORDER = ["page", "skill", "form", "scheduled-task", "nothing"];
export function easiest(list) {
  const ready = list.filter((x) => x.group === "ready" && x.runs !== "nothing");
  ready.sort((a, b) => a.apps.length - b.apps.length || RUNS_ORDER.indexOf(a.runs) - RUNS_ORDER.indexOf(b.runs) || a.name.localeCompare(b.name));
  return ready[0]?.id ?? null;
}

// The whole report: {groups: {ready, needs, stays}, counts, easiest, fix}.
//   reanalyze(w, answers): the workflow's analyzer record with those extra answers (migrate.mjs
//   passes one); used to ask a question only when another answer would let the workflow move.
export function plainReport(report, { convert = null, stepsOf = () => null, answers = {}, connected = null, timezone = null, reanalyze = null } = {}) {
  const byId = new Map((convert?.workflows ?? []).map((c) => [String(c.id), c]));
  const whatIf = reanalyze
    ? (w, extra) => {
        const again = reanalyze(w, { ...answers, ...extra });
        return !!again && plainWorkflow(again, { answers: { ...answers, ...extra }, connected, timezone }).group !== "stays";
      }
    : null;
  const list = report.workflows.map((w) => {
    const conv = byId.get(String(w.id)) ?? null;
    return plainWorkflow(w, { conv, steps: conv ? stepsOf(conv) : null, answers, connected, timezone, whatIf });
  });
  const groups = { ready: [], needs: [], stays: [] };
  for (const x of list) groups[x.group].push(x);
  return {
    groups,
    counts: { ready: groups.ready.length, needs: groups.needs.length, stays: groups.stays.length },
    easiest: easiest(list),
    fix: list.flatMap((x) => x.fix.map((f) => ({ ...f, workflow: x.id }))),
    developer: list.filter((x) => x.developer).length,
  };
}

export const GROUP_TITLES = { ready: "Ready to move", needs: "Needs one thing from you", stays: "Stays in n8n for now" };

// The same, as short text for a chat reply.
export function renderPlainText(p) {
  const L = [];
  for (const g of ["ready", "needs", "stays"]) {
    const xs = p.groups[g];
    if (!xs.length) continue;
    L.push(`${GROUP_TITLES[g]} (${xs.length})`);
    for (const x of xs) {
      if (g === "ready") L.push(`- ${x.name}: ${x.says}`);
      else if (g === "needs") L.push(`- ${x.name}: ${x.todo.map((t) => t.text).join(" / ")}`);
      else L.push(`- ${x.name}: ${x.why}${x.developer ? " (a developer can move it with Claude Code)" : ""}`);
    }
    L.push("");
  }
  const first = p.groups.ready.find((x) => x.id === p.easiest);
  if (first) L.push(`Easiest to start with: ${first.name}.`);
  return L.join("\n").trimEnd() + "\n";
}
