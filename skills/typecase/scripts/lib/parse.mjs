/**
 * Parse one SKILL.md (plus its folder) into a structured record.
 * Hand-rolled frontmatter/markdown handling — zero dependencies, and
 * skills in the wild use only simple YAML (scalars and folded blocks).
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

/** Minimal YAML subset: `key: value`, `key: >-` folded blocks, lists. */
export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { frontmatter: {}, body: text };
  const fm = {};
  const lines = m[1].split(/\r?\n/);
  let key = null;
  let folded = false;
  for (const line of lines) {
    const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (kv && !line.startsWith(" ")) {
      key = kv[1].toLowerCase();
      const value = kv[2].trim();
      folded = value === ">-" || value === ">" || value === "|" || value === "|-";
      fm[key] = folded ? "" : value.replace(/^["']|["']$/g, "");
    } else if (key && (line.startsWith("  ") || line.trim() === "")) {
      const chunk = line.trim();
      if (chunk.startsWith("- ")) {
        fm[key] = (fm[key] ? fm[key] + "; " : "") + chunk.slice(2);
      } else if (chunk) {
        fm[key] = (fm[key] ? fm[key] + " " : "") + chunk;
      }
    }
  }
  return { frontmatter: fm, body: text.slice(m[0].length) };
}

function splitSections(body) {
  const sections = [];
  let current = { heading: "(intro)", level: 0, lines: [] };
  for (const line of body.split(/\r?\n/)) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      sections.push(current);
      current = { heading: h[2].trim(), level: h[1].length, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections.map((s) => ({
    heading: s.heading,
    level: s.level,
    text: s.lines.join("\n").trim(),
    tokens: Math.ceil(s.lines.join("\n").length / 4),
  }));
}

const RISKY = [
  { kind: "network", re: /\b(curl|wget|fetch\(|https?:\/\/[^\s)]+\s*\||axios|net\.connect)\b/i },
  { kind: "write", re: /\b(rm -rf?|writeFileSync?|git push|sed -i|>\s*\/|mkfs|chmod|chown)\b/ },
  { kind: "exec", re: /\b(exec(Sync|File)?|spawn(Sync)?|eval|bash -c|sh -c)\b/ },
  { kind: "sudo", re: /\bsudo\b/ },
];

function commandMentions(body) {
  const commands = new Set();
  for (const block of body.matchAll(/```(?:bash|sh|shell|zsh|console)?\n([\s\S]*?)```/g)) {
    for (const line of block[1].split("\n")) {
      const m = line.trim().replace(/^[$>]\s*/, "").match(/^([a-z][\w./-]*)/);
      if (m && !["the", "a", "if", "then", "fi", "for", "do", "done", "echo"].includes(m[1])) {
        commands.add(m[1]);
      }
    }
  }
  const NOT_COMMANDS = new Set(
    "use run see the a an when skill name file files open test type set get add with and or your this".split(" "),
  );
  for (const inline of body.matchAll(/`([a-z][\w.-]{1,24}) ([^`]{2,80})`/g)) {
    const bin = inline[1];
    const arg = inline[2];
    if (!NOT_COMMANDS.has(bin) && /^[-./a-z0-9"']/i.test(arg)) commands.add(bin);
  }
  return [...commands].sort();
}

function referencedFiles(body, dir) {
  const refs = new Set();
  const candidates = [
    ...[...body.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]),
    ...[...body.matchAll(/`([\w./-]+\.(?:md|mjs|js|ts|py|sh|json|yml|yaml|html|css))`/g)].map((m) => m[1]),
  ];
  for (const raw of candidates) {
    const rel = raw.split("#")[0].trim();
    if (!rel || /^[a-z]+:\/\//.test(rel) || rel.startsWith("/")) continue;
    if (existsSync(path.join(dir, rel))) refs.add(rel);
  }
  return [...refs].sort();
}

function triggerText(frontmatter, sections) {
  const parts = [frontmatter.description ?? "", frontmatter["when-to-use"] ?? frontmatter.when_to_use ?? ""];
  for (const s of sections) {
    if (/when to use|trigger|use this skill/i.test(s.heading)) parts.push(s.text);
    if (s.heading === "(intro)") {
      for (const sentence of s.text.split(/(?<=\.)\s+/)) {
        if (/\buse (this |it |when|whenever|for)\b/i.test(sentence)) parts.push(sentence);
      }
    }
  }
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function whenNotText(frontmatter, sections) {
  const parts = [];
  for (const s of sections) {
    if (/when not|don'?t use|not for|do not use|stop \/|out of scope/i.test(s.heading)) parts.push(s.text);
  }
  const all = (frontmatter.description ?? "") + " " + sections.map((s) => s.text).join(" ");
  for (const sentence of all.split(/(?<=\.)\s+/)) {
    if (/\b(do not use|don'?t use|not for|never use)\b/i.test(sentence)) parts.push(sentence.trim());
  }
  return [...new Set(parts)].join(" ").replace(/\s+/g, " ").trim().slice(0, 600);
}

/** sha256 over every file in the skill folder (names + bytes), stable order. */
export function hashSkillDir(dir) {
  const hash = createHash("sha256");
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        hash.update(path.relative(dir, full));
        hash.update("\0");
        hash.update(readFileSync(full));
      }
    }
  };
  walk(dir);
  return hash.digest("hex");
}

export function parseSkill(skillFile, { tool, scope, root }) {
  const dir = path.dirname(skillFile);
  const raw = readFileSync(skillFile, "utf8");
  const { frontmatter, body } = parseFrontmatter(raw);
  const sections = splitSections(body);
  const riskyTools = RISKY.filter(({ re }) => re.test(raw)).map(({ kind }) => kind);

  let bytes = 0;
  try {
    bytes = statSync(skillFile).size;
  } catch {
    // unreadable: keep 0
  }

  return {
    name: (frontmatter.name ?? path.basename(dir)).trim(),
    description: (frontmatter.description ?? "").replace(/\s+/g, " ").trim(),
    tool,
    scope,
    root,
    path: skillFile,
    dir,
    frontmatter,
    sections: sections.filter((s) => s.text || s.level > 0),
    triggers: triggerText(frontmatter, sections),
    whenNot: whenNotText(frontmatter, sections),
    files: referencedFiles(body, dir),
    commands: commandMentions(body),
    riskyTools,
    tokens: Math.ceil(raw.length / 4),
    bytes,
    hash: hashSkillDir(dir),
  };
}
