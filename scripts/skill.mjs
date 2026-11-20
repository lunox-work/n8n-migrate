#!/usr/bin/env node
// The repository's agent skill (skills/<name>/SKILL.md) as the Agent Skills format
// (agentskills.io/specification), and the Claude plugin around it.
//
//   node scripts/skill.mjs check                     the rules below; exit 1 on any
//   node scripts/skill.mjs sync                      write VERSION into the manifests and package.json
//   node scripts/skill.mjs pack                      dist-skills/<name>-<version>.zip
//   node scripts/skill.mjs plugin-branch [--out <dir>] [--push]
//                                                    build the claude-plugin branch's commit
//
// VERSION is analyze.mjs's `export const VERSION`, the version the converter stamps into
// every folder it writes. The skill is self-contained (Node scripts, no install), so there
// is no npm pin to keep in step; check refuses an `npx` or `npm install` line in the skill.
//
// check: `name` matches its folder (lowercase, digits, single hyphens, at most 64);
// `description` 1 to 1024 characters without < or >, written as `description: >-` when it
// spans lines; `compatibility` at most 500; the body at most 500 lines; no symlinks; every
// relative Markdown link in the skill's .md files, and every `references/…` or `scripts/…`
// path SKILL.md names, resolves inside the skill's folder; no shipped file over 5 MiB;
// both .claude-plugin/ manifests carry VERSION; the plugin icon is a PNG.
// Directory-scanner wording (the Claude plugin directory read these as commands in a sibling
// skill): a line of a skill .md file starting with the word "pass" (read as the pass password
// manager), and a paragraph naming `fetch` or `eval` beside a module loaded from a URL (read
// as download-and-run). Both fail. A github.com URL in a file that also mentions credentials
// is printed as a note only: the hits are vendored Luxon's attribution comments and the
// GitHub credential's API host, which are what they say.
//
// pack: a zip of the skill folder as committed at HEAD (git archive), with one top-level
// folder named after the skill and SKILL.md at its root. Refuses when the folder has
// uncommitted changes, so the zip is exactly what a clone gets.
//
// plugin-branch: the plugin directory scans every file in the plugin folder, and on main
// that folder is the whole repository (evals, tests, PLAN). The directory tracks the
// claude-plugin branch instead: PLUGIN_FILES as of HEAD, plugin.json less LISTING_LINKS,
// and a README.md written from plugin.json, the skill's frontmatter and
// .claude-plugin/data.md (what is sent where; the directory requires a README). The commit
// is built with a private index, never touching the working tree or index. Without --push
// its objects go to a scratch object store (the repository's objects as alternates), so a
// dry run leaves nothing behind; --out <dir> writes the branch's files there to inspect.
// --push writes the objects into the repository, fetches origin's branch as the parent, and
// pushes; nothing else here talks to a remote.

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = join(ROOT, "skills");
const NAME = "n8n-migrate";
const MANIFESTS = [".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", "package.json"];
// The npm package under the old name: it depends on this one and runs it, so it moves with VERSION.
const ALIAS = "aliases/n8n-to-claude/package.json";
const MAX_FILE = 5 * 1024 * 1024;
const PLUGIN_BRANCH = "claude-plugin";
const PLUGIN_FILES = [".claude-plugin/icon.png", "LICENSE", "skills"];
// plugin.json fields only the directory's listing reads. Claude Code warns on them as unknown
// keys, so the branch's plugin.json drops them and its README carries them as links.
const LISTING_LINKS = { privacyPolicyUrl: "Privacy", documentationUrl: "Documentation", supportUrl: "Support" };

export function version(root = ROOT) {
  const src = readFileSync(join(root, "skills", NAME, "scripts", "analyze.mjs"), "utf8");
  const m = /^export const VERSION = "(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)";$/m.exec(src);
  if (!m) throw new Error("analyze.mjs: no `export const VERSION = \"x.y.z\";`");
  return m[1];
}

/** Top-level YAML keys of the frontmatter, folded the way YAML folds plain and `>` scalars; `multiline` marks keys whose value spans lines. */
export function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return null;
  const fields = {};
  const indicator = {};
  const multiline = {};
  let key = null;
  for (const line of match[1].split("\n")) {
    const top = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (top) {
      key = top[1];
      indicator[key] = /^[>|][+-]?$/.test(top[2]) ? top[2] : "";
      fields[key] = indicator[key] ? "" : top[2];
    } else if (key && /^\s/.test(line)) {
      multiline[key] = true;
      fields[key] = `${fields[key]} ${line.trim()}`.trim();
    }
  }
  for (const k of Object.keys(fields)) fields[k] = fields[k].replace(/^(["'])(.*)\1$/, "$2");
  return { fields, indicator, multiline, body: text.slice(match[0].length) };
}

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() ? walk(path) : [path];
  });
}

const isText = (path) => /\.(md|mjs|js|json|txt|html|ya?ml)$/i.test(path);

/** Wording the plugin directory's scanner reads as a command, per .md file. */
export function scannerWording(text, at) {
  const problems = [];
  text.split("\n").forEach((line, i) => {
    if (/^\s*(?:[-*>]\s+|\d+\.\s+)?pass(?:es|ed|ing)?\b/i.test(line)) {
      problems.push(`${at}:${i + 1}: a line starting with "pass" reads as the pass password manager; reword ("passing", "a pass" mid-line)`);
    }
  });
  let line = 1;
  for (const para of text.split(/\n\s*\n/)) {
    if (/`(?:fetch|eval)`/.test(para) && /(?:loaded|imported|fetched)\s+(?:from|by)\s+a\s+URL|import\s+by\s+URL/i.test(para)) {
      problems.push(`${at}:${line}: \`fetch\`/\`eval\` beside a module loaded from a URL reads as download-and-run; spell them out ("the global fetch function", "dynamic code evaluation")`);
    }
    line += para.split("\n").length + 1;
  }
  return problems;
}

export function check(root = ROOT) {
  const problems = [];
  const notes = [];
  const skills = join(root, "skills");
  const names = existsSync(skills) ? readdirSync(skills).filter((n) => existsSync(join(skills, n, "SKILL.md"))) : [];
  if (names.length === 0) problems.push("skills/: no <name>/SKILL.md");
  const VERSION = version(root);
  for (const name of names) {
    const dir = join(skills, name);
    const text = readFileSync(join(dir, "SKILL.md"), "utf8");
    const parsed = frontmatter(text);
    const at = `skills/${name}/SKILL.md`;
    if (!parsed) {
      problems.push(`${at}: no frontmatter`);
      continue;
    }
    const { fields, indicator, multiline, body } = parsed;
    if (fields.name !== name) problems.push(`${at}: name "${fields.name}" is not its folder's name`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) problems.push(`${at}: folder name breaks the name rule`);
    const description = fields.description ?? "";
    if (description.length < 1 || description.length > 1024) problems.push(`${at}: description is ${description.length} characters (1 to 1024)`);
    if (/[<>]/.test(description)) problems.push(`${at}: description holds < or >`);
    if (multiline.description && indicator.description !== ">-") problems.push(`${at}: a description over several lines must be written \`description: >-\``);
    if ((fields.compatibility ?? "").length > 500) problems.push(`${at}: compatibility is over 500 characters`);
    const lines = body.split("\n").length;
    if (lines > 500) problems.push(`${at}: body is ${lines} lines (at most 500; move detail to references/)`);
    for (const path of walk(dir)) {
      const rel = relative(root, path);
      if (lstatSync(path).isSymbolicLink()) {
        problems.push(`${rel}: a symlink`);
        continue;
      }
      if (statSync(path).size > MAX_FILE) problems.push(`${rel}: ${(statSync(path).size / 1048576).toFixed(1)} MiB, over 5 MiB`);
      if (!isText(path)) continue;
      const content = readFileSync(path, "utf8");
      if (/\.md$/i.test(path)) {
        problems.push(...scannerWording(content, rel));
        for (const [, target] of content.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
          if (/^[a-z]+:/i.test(target)) continue;
          const to = resolve(dirname(path), target);
          if (!to.startsWith(dir + "/")) problems.push(`${rel}: link ${target} leaves the skill's folder`);
          else if (!existsSync(to)) problems.push(`${rel}: link ${target} does not exist`);
        }
        content.split("\n").forEach((l, i) => {
          if (/\bnpx\s|\bnpm\s+(?:i|install|ci)\b/.test(l)) problems.push(`${rel}:${i + 1}: an npx or npm install line; the skill ships self-contained`);
        });
      }
      if (/https?:\/\/(?:[\w-]+\.)*github\.com\b/.test(content) && /credential|password|secret|api[ _-]?key/i.test(content)) {
        notes.push(`${rel}: a github.com URL in a file that also mentions credentials`);
      }
    }
    for (const ref of new Set([...text.matchAll(/`((?:references|scripts)\/[\w./-]+)`/g)].map((m) => m[1]))) {
      if (!existsSync(join(dir, ref))) problems.push(`${at}: names ${ref}, which does not exist`);
    }
  }
  const plugin = readJson(root, MANIFESTS[0]);
  const market = readJson(root, MANIFESTS[1]);
  if (!plugin) problems.push(`${MANIFESTS[0]}: missing`);
  else if (plugin.name !== NAME || plugin.version !== VERSION) problems.push(`${MANIFESTS[0]}: name and version are not ${NAME} ${VERSION} (node scripts/skill.mjs sync)`);
  const listed = market?.plugins?.find((p) => p.name === NAME);
  if (!listed) problems.push(`${MANIFESTS[1]}: no plugin named ${NAME}`);
  else if (listed.version !== undefined && listed.version !== VERSION) problems.push(`${MANIFESTS[1]}: version is not ${VERSION} (node scripts/skill.mjs sync)`);
  const pkg = readJson(root, MANIFESTS[2]);
  if (pkg && (pkg.name !== NAME || pkg.version !== VERSION)) problems.push(`${MANIFESTS[2]}: name and version are not ${NAME} ${VERSION} (node scripts/skill.mjs sync)`);
  const alias = readJson(root, ALIAS);
  if (alias && (alias.version !== VERSION || alias.dependencies?.[NAME] !== `^${VERSION}`)) problems.push(`${ALIAS}: version and its ${NAME} dependency are not ${VERSION} (node scripts/skill.mjs sync)`);
  const icon = join(root, ".claude-plugin", "icon.png");
  if (!existsSync(icon) || readFileSync(icon).subarray(1, 4).toString() !== "PNG") problems.push(".claude-plugin/icon.png: missing or not a PNG (node assets/src/render.mjs icon)");
  return { problems, notes };
}

function readJson(root, path) {
  const full = join(root, path);
  return existsSync(full) ? JSON.parse(readFileSync(full, "utf8")) : null;
}

function sync() {
  const VERSION = version();
  for (const path of MANIFESTS) {
    const full = join(ROOT, path);
    if (!existsSync(full)) continue;
    const json = JSON.parse(readFileSync(full, "utf8"));
    if (json.version !== undefined) json.version = VERSION;
    for (const plugin of json.plugins ?? []) if (plugin.name === NAME) plugin.version = VERSION;
    writeFileSync(full, `${JSON.stringify(json, null, 2)}\n`);
  }
  const alias = readJson(ROOT, ALIAS);
  if (alias) {
    alias.version = VERSION;
    alias.dependencies = { ...alias.dependencies, [NAME]: `^${VERSION}` };
    writeFileSync(join(ROOT, ALIAS), `${JSON.stringify(alias, null, 2)}\n`);
  }
}

function git(args, env = {}, input) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", input, env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${(result.stderr || "").trim()}`);
  return result.stdout.trim();
}

function pack() {
  const { problems } = check();
  if (problems.length > 0) return problems;
  const dirty = git(["status", "--porcelain", "--", `skills/${NAME}`]);
  if (dirty) return [`skills/${NAME} has uncommitted changes; commit them first so the zip matches HEAD:\n${dirty}`];
  const out = join(ROOT, "dist-skills");
  mkdirSync(out, { recursive: true });
  const zip = join(out, `${NAME}-${version()}.zip`);
  rmSync(zip, { force: true });
  git(["archive", "--format=zip", `--prefix=${NAME}/`, "-o", zip, `HEAD:skills/${NAME}`]);
  console.log(`${relative(ROOT, zip)} (${(statSync(zip).size / 1048576).toFixed(1)} MiB, HEAD ${git(["rev-parse", "--short", "HEAD"])})`);
  return [];
}

/** The plugin branch's README: what the plugin does, its skill, how to install, what it needs, the data note. */
function pluginReadme(show) {
  const plugin = JSON.parse(show(".claude-plugin/plugin.json"));
  const market = JSON.parse(show(".claude-plugin/marketplace.json"));
  const names = git(["ls-tree", "--name-only", "HEAD:skills"]).split("\n").filter(Boolean);
  const lines = [`# ${plugin.name}`, "", plugin.description, "", "## Skills", ""];
  const needs = [];
  for (const name of names) {
    const { fields } = frontmatter(show(`skills/${name}/SKILL.md`));
    lines.push(`- **${fields.name}**: ${fields.description}`, "");
    if (fields.compatibility) needs.push(`- **${fields.name}**: ${fields.compatibility}`, "");
  }
  lines.push("## Install", "", "```sh", `claude plugin marketplace add ${plugin.repository.replace(/^https:\/\/github\.com\//, "")}`);
  lines.push(`claude plugin install ${plugin.name}@${market.name}`, "```", "");
  if (needs.length > 0) lines.push("## Requirements", "", ...needs);
  lines.push("## Data", "", show(".claude-plugin/data.md").trim(), "");
  const links = Object.entries(LISTING_LINKS).filter(([key]) => plugin[key]);
  if (links.length > 0) lines.push("## Links", "", ...links.map(([key, label]) => `- [${label}](${plugin[key]})`), "");
  lines.push("## Source", "", "This branch holds only the plugin's files. The evaluation bench, tests and");
  lines.push(`documentation are on the main branch of ${plugin.repository}. License: ${plugin.license}.`, "");
  return lines.join("\n");
}

function pluginBranch({ push, out }) {
  const scratch = mkdtempSync(join(tmpdir(), "plugin-branch-"));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    if (!push) {
      // Dry run: new objects go to a scratch store; the repository's objects stay readable.
      const objects = join(scratch, "objects");
      mkdirSync(objects);
      env.GIT_OBJECT_DIRECTORY = objects;
      env.GIT_ALTERNATE_OBJECT_DIRECTORIES = resolve(ROOT, git(["rev-parse", "--git-path", "objects"]));
    }
    const show = (path) => git(["show", `HEAD:${path}`]);
    git(["read-tree", "--empty"], env);
    for (const path of PLUGIN_FILES) {
      const [mode, type, object] = git(["ls-tree", "HEAD", "--", path]).split(/\s+/);
      if (!object) return [`${path}: not in HEAD`];
      if (type === "tree") git(["read-tree", `--prefix=${path}/`, object], env);
      else git(["update-index", "--add", "--cacheinfo", `${mode},${object},${path}`], env);
    }
    const manifest = JSON.parse(show(".claude-plugin/plugin.json"));
    for (const key of Object.keys(LISTING_LINKS)) delete manifest[key];
    const json = git(["hash-object", "-w", "--stdin"], env, `${JSON.stringify(manifest, null, 2)}\n`);
    git(["update-index", "--add", "--cacheinfo", `100644,${json},.claude-plugin/plugin.json`], env);
    const readme = git(["hash-object", "-w", "--stdin"], env, pluginReadme(show));
    git(["update-index", "--add", "--cacheinfo", `100644,${readme},README.md`], env);
    const tree = git(["write-tree"], env);
    let parent = null;
    if (push) {
      if (spawnSync("git", ["fetch", "--quiet", "origin", PLUGIN_BRANCH], { cwd: ROOT }).status === 0) parent = git(["rev-parse", "FETCH_HEAD"]);
    } else if (spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${PLUGIN_BRANCH}`], { cwd: ROOT }).status === 0) {
      parent = git(["rev-parse", `refs/remotes/origin/${PLUGIN_BRANCH}`]);
    }
    if (parent && git(["rev-parse", `${parent}^{tree}`], env) === tree) {
      console.log(`${PLUGIN_BRANCH}: up to date at ${parent.slice(0, 7)}`);
      return [];
    }
    const head = git(["rev-parse", "--short", "HEAD"]);
    const message = `Plugin files from main ${head}\n\n${PLUGIN_FILES.join(", ")}; built by scripts/skill.mjs plugin-branch.`;
    const commit = git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], env);
    if (out) {
      mkdirSync(out, { recursive: true });
      const tar = spawnSync("git", ["archive", "--format=tar", commit], { cwd: ROOT, env: { ...process.env, ...env }, maxBuffer: 1 << 30 });
      if (tar.status !== 0) return [`git archive: ${tar.stderr.toString().trim()}`];
      const x = spawnSync("tar", ["-x", "-C", out], { input: tar.stdout });
      if (x.status !== 0) return [`tar: ${x.stderr.toString().trim()}`];
    }
    const files = git(["ls-tree", "-r", "--name-only", commit], env).split("\n").length;
    if (push) git(["push", "--quiet", "origin", `${commit}:refs/heads/${PLUGIN_BRANCH}`]);
    console.log(`${PLUGIN_BRANCH}: ${commit.slice(0, 7)} from main ${head}, ${files} files${out ? `, written to ${out}` : ""}${push ? ", pushed" : " (dry run: not stored or pushed; add --push)"}`);
    return [];
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [command, ...args] = process.argv.slice(2);
  const outAt = args.indexOf("--out");
  let problems = [];
  let notes = [];
  if (command === "check") ({ problems, notes } = check());
  else if (command === "sync") (sync(), ({ problems, notes } = check()));
  else if (command === "pack") problems = pack();
  else if (command === "plugin-branch") problems = pluginBranch({ push: args.includes("--push"), out: outAt >= 0 ? resolve(args[outAt + 1]) : null });
  else {
    console.error("usage: node scripts/skill.mjs check | sync | pack | plugin-branch [--out <dir>] [--push]");
    process.exit(1);
  }
  for (const note of notes) console.log(`note: ${note}`);
  for (const problem of problems) console.error(problem);
  if (problems.length === 0 && command === "check") console.log(`skills: ${NAME} ${version()} ok`);
  process.exit(problems.length > 0 ? 1 : 0);
}
