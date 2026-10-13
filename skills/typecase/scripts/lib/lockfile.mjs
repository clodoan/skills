/**
 * skills.lock + section-level diff + plain-language change paragraphs +
 * pin/restore snapshots + the running TYPECASE.md changelog.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, appendFileSync,
} from "node:fs";
import path from "node:path";

import { home } from "./paths.mjs";

export const LOCKFILE = "skills.lock";
export const CHANGELOG = "TYPECASE.md";

export function snapshotRoot() {
  return process.env.TYPECASE_SNAPSHOTS ?? path.join(home(), ".cache", "typecase", "snapshots");
}

function tryGit(dir, args) {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** Best-effort provenance: git remote+commit, or a nearby plugin version. */
export function sourceOf(skill) {
  const commit = tryGit(skill.dir, ["rev-parse", "HEAD"]);
  if (commit) {
    return {
      kind: "git",
      remote: tryGit(skill.dir, ["remote", "get-url", "origin"]) ?? null,
      commit,
      ref: tryGit(skill.dir, ["describe", "--tags", "--always"]),
    };
  }
  // plugin.json / package.json next to or above the skill dir (≤3 levels)
  let dir = skill.dir;
  for (let i = 0; i < 3; i++) {
    for (const name of ["plugin.json", "package.json", ".claude-plugin/plugin.json"]) {
      const file = path.join(dir, name);
      if (existsSync(file)) {
        try {
          const meta = JSON.parse(readFileSync(file, "utf8"));
          if (meta.version) return { kind: "plugin", manifest: file, name: meta.name ?? null, version: meta.version };
        } catch {
          // fall through
        }
      }
    }
    dir = path.dirname(dir);
  }
  return { kind: "local" };
}

export function keyOf(skill) {
  return `${skill.tool}:${skill.scope}:${skill.name}`;
}

export function writeLock(data, lockPath = LOCKFILE, { snapshot = true } = {}) {
  const lock = { version: 1, generatedAt: new Date().toISOString(), skills: {} };
  for (const s of data.skills) {
    if (s.error) continue;
    lock.skills[keyOf(s)] = {
      name: s.name, tool: s.tool, scope: s.scope, path: s.path, dir: s.dir,
      hash: s.hash, tokens: s.tokens, source: sourceOf(s),
      sections: s.sections.map((x) => ({ heading: x.heading, text: x.text })),
      triggers: s.triggers, whenNot: s.whenNot, description: s.description,
      files: s.files, commands: s.commands, riskyTools: s.riskyTools,
    };
    if (snapshot) {
      const snap = path.join(snapshotRoot(), s.hash);
      if (!existsSync(snap)) {
        mkdirSync(snap, { recursive: true });
        cpSync(s.dir, snap, { recursive: true });
      }
    }
  }
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
  return lock;
}

export function readLock(lockPath = LOCKFILE) {
  if (!existsSync(lockPath)) return null;
  return JSON.parse(readFileSync(lockPath, "utf8"));
}

/** Section-level diff between a locked record and a current skill. */
export function sectionDiff(locked, current) {
  const changes = [];
  const oldSecs = new Map((locked.sections ?? []).map((s) => [s.heading, s.text]));
  const newSecs = new Map(current.sections.map((s) => [s.heading, s.text]));
  for (const [heading, text] of newSecs) {
    if (!oldSecs.has(heading)) changes.push({ kind: "section-added", heading, text: text.slice(0, 400) });
    else if (oldSecs.get(heading) !== text) changes.push({ kind: "section-changed", heading });
  }
  for (const heading of oldSecs.keys()) {
    if (!newSecs.has(heading)) changes.push({ kind: "section-removed", heading });
  }
  if ((locked.description ?? "") !== current.description) {
    changes.push({ kind: "description", from: locked.description, to: current.description });
  }
  if ((locked.triggers ?? "") !== current.triggers) {
    changes.push({ kind: "triggers", from: locked.triggers, to: current.triggers });
  }
  if ((locked.whenNot ?? "") !== current.whenNot) {
    changes.push({ kind: "when-not", from: locked.whenNot, to: current.whenNot });
  }
  const addList = (kind, oldArr = [], newArr = []) => {
    const added = newArr.filter((x) => !oldArr.includes(x));
    const removed = oldArr.filter((x) => !newArr.includes(x));
    if (added.length || removed.length) changes.push({ kind, added, removed });
  };
  addList("commands", locked.commands, current.commands);
  addList("risky-tools", locked.riskyTools, current.riskyTools);
  addList("files", locked.files, current.files);
  return changes;
}

/**
 * One short plain-language paragraph: what will the agent now do
 * differently. Deterministic template by default; set TYPECASE_LLM_CMD
 * to a command that receives the change JSON on stdin and prints a
 * paragraph to use an LLM instead (falls back on any failure).
 */
export function changeParagraph(entry) {
  if (process.env.TYPECASE_LLM_CMD) {
    const res = spawnSync(process.env.TYPECASE_LLM_CMD, {
      shell: true, input: JSON.stringify(entry), encoding: "utf8", timeout: 60000,
    });
    const out = res.stdout?.trim();
    if (res.status === 0 && out) return out;
  }
  const { name, status, changes = [], source } = entry;
  const ver = source?.ref ? ` (${source.ref})` : "";
  if (status === "added") {
    return `**${name}**${ver} is newly installed: your agent can now ${entry.description ? entry.description.replace(/\.$/, "").charAt(0).toLowerCase() + entry.description.replace(/\.$/, "").slice(1) : "use it"}. It will trigger on: ${entry.triggers?.slice(0, 180) || "see its description"}.`;
  }
  if (status === "removed") {
    return `**${name}** was removed: your agent no longer loads it, so tasks it used to catch (${(entry.triggers ?? "").slice(0, 140) || "its triggers"}) fall back to default behavior.`;
  }
  // One SHORT paragraph: lead with behavior-relevant changes, name at
  // most a couple of sections, and fold the rest into counts.
  const bits = [];
  const added = changes.filter((x) => x.kind === "section-added");
  const removed = changes.filter((x) => x.kind === "section-removed");
  const rewritten = changes.filter((x) => x.kind === "section-changed");

  const risky = changes.find((x) => x.kind === "risky-tools");
  if (risky?.added?.length) bits.push(`⚠ it now touches ${risky.added.join("/")} operations`);
  if (changes.some((x) => x.kind === "triggers")) bits.push("it fires in different situations (the trigger text changed)");
  if (changes.some((x) => x.kind === "when-not")) bits.push("the cases it refuses changed");
  else if (changes.some((x) => x.kind === "description")) bits.push("its stated job changed");

  for (const a of added.slice(0, 2)) bits.push(`a new “${a.heading}” rule was added`);
  if (added.length > 2) bits.push(`${added.length - 2} more rules were added`);
  if (removed.length) {
    bits.push(removed.length === 1 ? `the “${removed[0].heading}” rule was dropped` : `${removed.length} rules were dropped`);
  }
  if (rewritten.length) {
    bits.push(rewritten.length <= 2
      ? rewritten.map((r) => `the “${r.heading}” section was rewritten`).join(" and ")
      : `${rewritten.length} sections were rewritten`);
  }
  const cmds = changes.find((x) => x.kind === "commands");
  if (cmds?.added?.length) bits.push(`it now reaches for ${cmds.added.slice(0, 3).join(", ")}`);
  const files = changes.find((x) => x.kind === "files");
  if (files?.added?.length) bits.push(`${files.added.length} new reference file${files.added.length > 1 ? "s" : ""}`);

  const summary = bits.length
    ? bits.slice(0, 5).join("; ")
    : "its content hash changed (formatting or helper files)";
  return `**${name}**${ver} changed: ${summary}.`;
}

/** Diff a lock against a fresh discovery. */
export function diffAgainstLock(lock, data) {
  const current = new Map(data.skills.filter((s) => !s.error).map((s) => [keyOf(s), s]));
  const locked = new Map(Object.entries(lock.skills));
  const entries = [];
  for (const [key, s] of current) {
    if (!locked.has(key)) {
      entries.push({ key, name: s.name, status: "added", description: s.description, triggers: s.triggers, source: sourceOf(s) });
    } else if (locked.get(key).hash !== s.hash) {
      entries.push({
        key, name: s.name, status: "changed",
        changes: sectionDiff(locked.get(key), s),
        fromHash: locked.get(key).hash.slice(0, 12), toHash: s.hash.slice(0, 12),
        source: sourceOf(s), lockedSource: locked.get(key).source,
      });
    }
  }
  for (const [key, rec] of locked) {
    if (!current.has(key)) {
      entries.push({ key, name: rec.name, status: "removed", triggers: rec.triggers, source: rec.source });
    }
  }
  return entries.map((e) => ({ ...e, paragraph: changeParagraph(e) }));
}

export function appendChangelog(entries, changelogPath = CHANGELOG) {
  if (!entries.length) return;
  const date = new Date().toISOString().slice(0, 10);
  let text = "";
  if (!existsSync(changelogPath)) {
    text += "# Typecase changelog\n\nWhat your agent does differently, one paragraph per skill change.\n";
  }
  text += `\n## ${date}\n\n`;
  for (const e of entries) text += `- ${e.paragraph}\n`;
  appendFileSync(changelogPath, text);
}

/** Restore the locked version of one skill from its snapshot. */
export function pin(lock, data, name) {
  const locked = Object.values(lock.skills).filter((s) => s.name === name);
  if (!locked.length) throw new Error(`"${name}" is not in ${LOCKFILE}`);
  const results = [];
  for (const rec of locked) {
    const snap = path.join(snapshotRoot(), rec.hash);
    if (!existsSync(snap)) throw new Error(`no snapshot for ${rec.name}@${rec.hash.slice(0, 12)} — was lock run with snapshots on?`);
    const current = data.skills.find((s) => keyOf(s) === `${rec.tool}:${rec.scope}:${rec.name}`);
    if (current && current.hash !== rec.hash) {
      const backup = path.join(snapshotRoot(), current.hash);
      if (!existsSync(backup)) {
        mkdirSync(backup, { recursive: true });
        cpSync(current.dir, backup, { recursive: true });
      }
    }
    rmSync(rec.dir, { recursive: true, force: true });
    mkdirSync(path.dirname(rec.dir), { recursive: true });
    cpSync(snap, rec.dir, { recursive: true });
    results.push({ name: rec.name, dir: rec.dir, restored: rec.hash.slice(0, 12), backedUp: current && current.hash !== rec.hash ? current.hash.slice(0, 12) : null });
  }
  return results;
}
