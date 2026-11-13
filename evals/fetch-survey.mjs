#!/usr/bin/env node
// Re-creates the survey corpus: the 100 most-viewed n8n templates.
//
//   node evals/fetch-survey.mjs [--rows 100] [--pin evals/survey/corpus-YYYY-MM-DD.json]
//
// Writes into evals/survey/data/ (git-ignored): top100.json (the raw listing),
// ids.txt (one id per line, listing order) and wf/<id>.json (the raw template
// response). With --pin it also writes the committed pin file: the ids in
// listing order plus a sha256 of each template's `.workflow.workflow` JSON
// (re-serialised with sorted keys, so the hash ignores key order and
// whitespace in the API response but changes with any content change).
//
// Downloaded JSON is untrusted data: it is only parsed and hashed, never run.
// Requests are sequential with a small delay; zero dependencies (Node 18+ fetch).

import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "survey", "data");
const API = "https://api.n8n.io/api/templates";
const UA = "template-survey/0.1";
const DELAY_MS = 300;

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const rows = Number(opt("--rows", "100"));
const pin = opt("--pin", null);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (attempt >= 3) throw new Error(`${url}: ${e.message}`);
      await sleep(2000 * attempt);
    }
  }
}

// Stable serialisation: object keys sorted recursively, arrays kept in order.
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

async function main() {
  await mkdir(join(DATA, "wf"), { recursive: true });
  const listingText = await get(`${API}/search?rows=${rows}&page=1&sort=views:desc`);
  await writeFile(join(DATA, "top100.json"), listingText);
  const listing = JSON.parse(listingText);
  const ids = listing.workflows.map((w) => w.id);
  await writeFile(join(DATA, "ids.txt"), ids.join("\n") + "\n");

  const entries = [];
  const shapeProblems = [];
  for (const [i, id] of ids.entries()) {
    await sleep(DELAY_MS);
    const text = await get(`${API}/workflows/${id}`);
    await writeFile(join(DATA, "wf", `${id}.json`), text);
    const wf = JSON.parse(text)?.workflow?.workflow;
    // Expected wrapper: { workflow: { id, name, ..., workflow: { nodes, connections, settings?, pinData? } } }
    if (!wf || !Array.isArray(wf.nodes) || typeof wf.connections !== "object")
      shapeProblems.push(id);
    const sha256 = createHash("sha256").update(canonical(wf ?? null)).digest("hex");
    entries.push({ id, sha256 });
    if (process.stderr.isTTY) process.stderr.write(`\r${i + 1}/${ids.length}`);
  }
  if (process.stderr.isTTY) process.stderr.write("\n");

  if (pin) {
    const out = {
      source: `${API}/search?rows=${rows}&page=1&sort=views:desc`,
      // Local calendar date (the pin file name uses the same one).
      fetched: new Date().toLocaleDateString("sv"),
      hash: "sha256 of .workflow.workflow serialised with sorted keys (evals/fetch-survey.mjs canonical())",
      templates: entries,
    };
    // One template per line keeps the pin diffable.
    const text = JSON.stringify(out, null, 2).replace(
      /\{\s+"id": (\d+),\s+"sha256": ("[0-9a-f]+")\s+\}/g,
      '{ "id": $1, "sha256": $2 }',
    );
    await writeFile(pin, text + "\n");
  }
  console.log(`templates: ${ids.length}; wrapper .workflow.workflow missing or malformed: ${shapeProblems.length ? shapeProblems.join(", ") : "none"}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
