#!/usr/bin/env node
// A migrated workflow as a claude.ai scheduled task (Cowork), with nothing kept between runs.
// The workflow's artifact page is the one place it lives: the page carries the definition and
// the task settings (its n8m-definition and n8m-build JSON, written by convert.mjs), and its
// database keeps the run records (runtime store "artifact"). The runtime comes from this skill.
//
//   task.mjs setup <page.html> --artifact <url> [--dir <dir>]
//       In the task, after the session saved the page with the Artifact tool (action read):
//       checks the definition against its hash, writes <dir> (default /tmp/n8m/<slug>) with
//       definition.json, task.json (artifactUrl set) and runtime/, and prints the runner
//       command. Prints FAILED and exits 1 when the page is not a converted workflow.
//   task.mjs prompt <page.html | folder> --artifact <url>
//       In the setup conversation: the scheduled task's instructions for that workflow.
//
// Zero dependencies; reads and writes local files only.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeRuntime } from "./convert.mjs";
import { definitionHash } from "../runtime/src/api.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REFS = join(HERE, "..", "references");

const scriptJson = (html, id) => {
  const m = new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)</script>`).exec(html);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
};

export function slugOf(name) {
  return (
    String(name ?? "workflow")
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 60)
      .replace(/^-|-$/g, "") || "workflow"
  );
}

// The page's definition and build, checked. {def, build} or {error}.
export function readPage(html) {
  const def = scriptJson(html, "n8m-definition");
  const build = scriptJson(html, "n8m-build");
  if (!def || !build) return { error: "this page is not a workflow page converted by n8n-migrate (no n8m-definition)" };
  if (definitionHash(def) !== build.definitionHash) return { error: "the page's definition does not match its hash; publish the page again from the converted folder" };
  if (!build.cowork) return { error: "the page was converted before scheduled tasks without a repository were supported; convert again and publish the new page" };
  return { def, build };
}

const pageOf = (p) => (existsSync(join(p, "artifact.html")) ? join(p, "artifact.html") : p);
const URL_RE = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+$/;

export function setup(pagePath, { artifact, dir } = {}) {
  if (!URL_RE.test(String(artifact ?? ""))) return { error: "--artifact must be the page's claude.ai/artifact/… link" };
  const page = readPage(readFileSync(pageOf(pagePath), "utf8"));
  if (page.error) return page;
  const out = resolve(dir ?? join("/tmp/n8m", slugOf(page.def.name)));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "definition.json"), JSON.stringify(page.def, null, 2) + "\n");
  writeFileSync(join(out, "task.json"), JSON.stringify({ ...page.build.cowork, artifactUrl: artifact }, null, 2) + "\n");
  writeRuntime(out, page.def);
  return { dir: out, runner: `node ${out}/runtime/runner.mjs`, name: page.def.name };
}

export function prompt(pagePath, { artifact } = {}) {
  if (!URL_RE.test(String(artifact ?? ""))) return { error: "--artifact must be the page's claude.ai/artifact/… link" };
  const page = readPage(readFileSync(pageOf(pagePath), "utf8"));
  if (page.error) return page;
  const slug = slugOf(page.def.name);
  const runner = `node /tmp/n8m/${slug}/runtime/runner.mjs`;
  const body = readFileSync(join(REFS, "task-prompt.md"), "utf8").split("__N8M_RUNNER__").join(runner);
  const head = readFileSync(join(REFS, "cowork-task-prompt.md"), "utf8")
    .split("__N8M_NAME__")
    .join(page.def.name.replace(/"/g, "'"))
    .split("__N8M_URL__")
    .join(artifact)
    .split("__N8M_SLUG__")
    .join(slug);
  return { text: `${head.trimEnd()}\n\n${body}` };
}

function main(argv = process.argv.slice(2)) {
  const [cmd, path] = argv;
  const flag = (n) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (!["setup", "prompt"].includes(cmd) || !path) {
    process.stderr.write("usage: task.mjs setup <page.html> --artifact <url> [--dir <dir>]\n       task.mjs prompt <page.html|folder> --artifact <url>\n");
    return 2;
  }
  try {
    const r = cmd === "setup" ? setup(path, { artifact: flag("artifact"), dir: flag("dir") }) : prompt(path, { artifact: flag("artifact") });
    if (r.error) {
      process.stdout.write(`FAILED: ${r.error}. Stop now.\n`);
      return 1;
    }
    process.stdout.write(cmd === "setup" ? `READY: "${r.name}" is set up in ${r.dir}. Now run exactly: ${r.runner} start\n` : r.text);
    return 0;
  } catch (e) {
    process.stdout.write(`FAILED: ${e.message}. Stop now.\n`);
    return 1;
  }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) process.exitCode = main();
