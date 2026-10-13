#!/usr/bin/env node
/**
 * typecase — the case your agent skills live in. Reader, parser, and
 * lockfile/changelog for every skill installed across Grok, Cursor,
 * Claude Code and Codex. Fully headless; `typecase open` adds a desktop
 * reader (Electron) with a small static-HTML fallback.
 */

import { spawn } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { discover, where } from "./lib/discover.mjs";
import {
  LOCKFILE, CHANGELOG, writeLock, readLock, diffAgainstLock, appendChangelog, pin,
} from "./lib/lockfile.mjs";
import { htmlReader } from "./lib/html-reader.mjs";

const EXIT_OK = 0;
const EXIT_DIFFS = 1;
const EXIT_USAGE = 2;

const isTTY = process.stdout.isTTY;
const c = {
  dim: (s) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s),
  red: (s) => (isTTY ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s) => (isTTY ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s) => (isTTY ? `\x1b[36m${s}\x1b[0m` : s),
  green: (s) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s),
};

function usage() {
  return `Usage: typecase <command> [args]

Commands:
  ls [--tool t] [--scope s] [--json]   every installed skill: tool, scope, size, description
  where <query...>                     which skill(s) would handle a task, with paths
  show <skill>                         clean terminal render of one skill
  open                                 desktop reader (Electron), or static HTML fallback
  lock [--no-snapshot]                 write ${LOCKFILE} (+ folder snapshots for pin)
  diff [--write-changelog]             what changed since ${LOCKFILE}, one paragraph per skill
  pin <skill>                          restore the locked version of a skill
  -h, --help

Set TYPECASE_LLM_CMD to generate diff paragraphs with an LLM (stdin: change
JSON; stdout: paragraph); otherwise a deterministic summary is used.

Exit codes: 0 ok, 1 diff found changes, 2 usage error.`;
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return { present: false, args };
  const rest = [...args];
  rest.splice(i, 1);
  return { present: true, args: rest };
}

function opt(args, name) {
  const i = args.indexOf(name);
  if (i === -1 || i === args.length - 1) return { value: null, args };
  const rest = [...args];
  const [, value] = rest.splice(i, 2);
  return { value, args: rest };
}

const TOOL_BADGE = { grok: "grok", cursor: "cursor", claude: "claude", codex: "codex", shared: "shared" };

function cmdLs(args) {
  const json = flag(args, "--json");
  const tool = opt(json.args, "--tool");
  const scope = opt(tool.args, "--scope");
  const data = discover();
  let skills = [...data.skills].sort(
    (a, b) => a.tool.localeCompare(b.tool) || a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name),
  );
  if (tool.value) skills = skills.filter((s) => s.tool === tool.value);
  if (scope.value) skills = skills.filter((s) => s.scope === scope.value);

  if (json.present) {
    console.log(JSON.stringify({ ...data, skills }, null, 2));
    return;
  }
  const dupNames = new Set(data.duplicates.map((d) => d.name));
  const overlapNames = new Set(data.overlaps.flatMap((o) => [o.a.name, o.b.name]));
  console.log(c.bold(`${skills.length} skills`) + c.dim(` · ${data.roots.filter((r) => r.exists).length} roots scanned`));
  let lastGroup = "";
  for (const s of skills) {
    const group = `${s.tool} · ${s.scope}`;
    if (group !== lastGroup) {
      console.log("\n" + c.cyan(group));
      lastGroup = group;
    }
    const marks = [
      dupNames.has(s.name) ? c.yellow("dup") : "",
      overlapNames.has(s.name) ? c.yellow("overlap") : "",
      s.riskyTools.length ? c.red(s.riskyTools.join(",")) : "",
      s.error ? c.red("parse-error") : "",
    ].filter(Boolean).join(" ");
    const desc = (s.description || "").slice(0, 86);
    console.log(
      `  ${c.bold(s.name.padEnd(28).slice(0, 28))} ${String(s.tokens).padStart(5)}tok  ${desc}${marks ? "  " + marks : ""}`,
    );
  }
  if (data.duplicates.length) {
    console.log("\n" + c.yellow(`duplicates (${data.duplicates.length}):`));
    for (const d of data.duplicates) {
      console.log(`  ${c.bold(d.name)} ${d.identical ? c.dim("(identical copies)") : c.red("(DIFFERENT content, same name)")}`);
      for (const i of d.installs) console.log(c.dim(`    ${i.tool}/${i.scope}  ${i.path}`));
    }
  }
  if (data.overlaps.length) {
    console.log("\n" + c.yellow(`overlapping triggers (${data.overlaps.length}):`));
    for (const o of data.overlaps.slice(0, 12)) {
      console.log(`  ${c.bold(o.a.name)} (${o.a.tool}) ↔ ${c.bold(o.b.name)} (${o.b.tool})  ${c.dim("jaccard " + o.score)}`);
    }
  }
}

function cmdWhere(args) {
  const json = flag(args, "--json");
  const query = json.args.join(" ").trim();
  if (!query) throw new UsageError("where needs a query");
  const results = where(discover(), query).slice(0, 8);
  if (json.present) {
    console.log(JSON.stringify(results.map((r) => ({ name: r.skill.name, tool: r.skill.tool, scope: r.skill.scope, score: r.score, path: r.skill.path })), null, 2));
    return;
  }
  if (!results.length) {
    console.log(c.dim(`no installed skill claims “${query}”`));
    return;
  }
  for (const { skill, score } of results) {
    console.log(`${c.bold(skill.name)} ${c.dim(`(${skill.tool}/${skill.scope}, score ${score})`)}`);
    console.log(`  ${(skill.description || skill.triggers).slice(0, 110)}`);
    console.log(c.dim(`  ${skill.path}`));
  }
}

function findSkill(data, nameArg) {
  const matches = data.skills.filter((s) => s.name === nameArg);
  if (!matches.length) {
    const close = data.skills.filter((s) => s.name.includes(nameArg));
    if (close.length === 1) return close[0];
    throw new UsageError(
      `no skill named "${nameArg}"${close.length ? ` — close: ${close.map((s) => s.name).join(", ")}` : ""}`,
    );
  }
  return matches[0];
}

function cmdShow(args) {
  if (!args[0]) throw new UsageError("show needs a skill name");
  const data = discover();
  const s = findSkill(data, args[0]);
  const rule = c.dim("─".repeat(Math.min(72, process.stdout.columns || 72)));
  console.log(`${c.bold(s.name)}  ${c.dim(`${s.tool} · ${s.scope} · ${s.tokens} tokens`)}`);
  console.log(s.description);
  console.log(rule);
  if (s.triggers) console.log(`${c.cyan("triggers")}  ${s.triggers.slice(0, 400)}`);
  if (s.whenNot) console.log(`${c.cyan("when not")}  ${s.whenNot.slice(0, 300)}`);
  if (s.riskyTools.length) console.log(`${c.red("risky")}     ${s.riskyTools.join(", ")}`);
  if (s.commands.length) console.log(`${c.cyan("commands")}  ${s.commands.join(", ")}`);
  if (s.files.length) console.log(`${c.cyan("files")}     ${s.files.join(", ")}`);
  console.log(`${c.cyan("path")}      ${s.path}`);
  const related = data.overlaps.filter((o) => o.a.name === s.name || o.b.name === s.name);
  for (const o of related) {
    const other = o.a.name === s.name ? o.b : o.a;
    console.log(`${c.yellow("overlaps")}  ${other.name} (${other.tool}) — jaccard ${o.score}`);
  }
  console.log(rule);
  for (const sec of s.sections) {
    if (sec.level > 0) console.log("\n" + c.bold("#".repeat(sec.level) + " " + sec.heading) + c.dim(`  (${sec.tokens} tok)`));
    if (sec.text) console.log(sec.text);
  }
}

function cmdLock(args) {
  const noSnap = flag(args, "--no-snapshot");
  const data = discover();
  const prior = readLock();
  if (prior) {
    const entries = diffAgainstLock(prior, data);
    if (entries.length) appendChangelog(entries);
  }
  const lock = writeLock(data, LOCKFILE, { snapshot: !noSnap.present });
  console.log(`${c.green("locked")} ${Object.keys(lock.skills).length} skills → ${LOCKFILE}${noSnap.present ? "" : c.dim(" (+snapshots)")}`);
}

function cmdDiff(args) {
  const write = flag(args, "--write-changelog");
  const json = flag(write.args, "--json");
  const lock = readLock();
  if (!lock) throw new UsageError(`no ${LOCKFILE} here — run \`typecase lock\` first`);
  const entries = diffAgainstLock(lock, discover());
  if (json.present) {
    console.log(JSON.stringify(entries, null, 2));
  } else if (!entries.length) {
    console.log(c.green(`no changes since ${LOCKFILE} (${lock.generatedAt})`));
  } else {
    console.log(c.bold(`${entries.length} change(s) since ${lock.generatedAt}:`) + "\n");
    for (const e of entries) {
      const tag = e.status === "added" ? c.green("+ added") : e.status === "removed" ? c.red("− removed") : c.yellow("~ changed");
      console.log(`${tag}  ${e.paragraph.replace(/\*\*/g, "")}\n`);
    }
  }
  if (write.present && entries.length) {
    appendChangelog(entries);
    console.log(c.dim(`appended ${entries.length} entries to ${CHANGELOG}`));
  }
  process.exit(entries.length ? EXIT_DIFFS : EXIT_OK);
}

function cmdPin(args) {
  if (!args[0]) throw new UsageError("pin needs a skill name");
  const lock = readLock();
  if (!lock) throw new UsageError(`no ${LOCKFILE} here — run \`typecase lock\` first`);
  const results = pin(lock, discover(), args[0]);
  for (const r of results) {
    console.log(`${c.green("pinned")} ${r.name} → ${r.restored} at ${r.dir}${r.backedUp ? c.dim(` (previous ${r.backedUp} snapshotted)`) : ""}`);
  }
}

function cmdOpen() {
  const appDir = fileURLToPath(new URL("../app", import.meta.url));
  const electron = path.join(appDir, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
  if (existsSync(electron)) {
    const child = spawn(electron, [appDir], {
      detached: true, stdio: "ignore",
      env: { ...process.env, TYPECASE_CWD: process.cwd() },
    });
    child.unref();
    console.log("opened the Typecase app");
    return;
  }
  // Fallback: a small static HTML reader built from the same parser
  // output (for headless boxes and agents; `cd app && npm install` to
  // get the desktop app).
  const data = discover();
  const file = path.join(tmpdir(), "typecase-reader.html");
  writeFileSync(file, htmlReader(data, { lock: readLock() }));
  console.log(`desktop app not installed (cd ${path.relative(process.cwd(), appDir) || "app"} && npm install)`);
  console.log(`static reader written → ${file}`);
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [file], { detached: true, stdio: "ignore" }).on("error", () => {});
}

class UsageError extends Error {}

const [cmd, ...rest] = process.argv.slice(2);
try {
  switch (cmd) {
    case "ls": cmdLs(rest); break;
    case "where": cmdWhere(rest); break;
    case "show": cmdShow(rest); break;
    case "lock": cmdLock(rest); break;
    case "diff": cmdDiff(rest); break;
    case "pin": cmdPin(rest); break;
    case "open": cmdOpen(rest); break;
    case "-h":
    case "--help":
    case undefined:
      console.log(usage());
      break;
    default:
      throw new UsageError(`unknown command: ${cmd}`);
  }
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`typecase: ${err.message}\n`);
    console.error(usage());
    process.exit(EXIT_USAGE);
  }
  console.error(`typecase: ${err?.stack ?? err}`);
  process.exit(EXIT_USAGE);
}
