/**
 * Walk every skill root, parse every SKILL.md, and flag duplicates and
 * overlaps. This module is the single source of truth: the CLI, the
 * HTML fallback reader, and the Electron app all consume its output.
 */

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { skillRoots } from "./paths.mjs";
import { parseSkill } from "./parse.mjs";

const STOPWORDS = new Set(
  ("a an and are as at be by for from has have how in into is it its of on or that the this to use used " +
    "when whenever with you your skill skills agent task tasks file files run running").split(" "),
);

function walkForSkills(dir, maxDepth = 5, depth = 0, out = []) {
  if (depth > maxDepth || !existsSync(dir)) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === "SKILL.md") out.push(full);
    else if (entry.isDirectory() || entry.isSymbolicLink()) walkForSkills(full, maxDepth, depth + 1, out);
  }
  return out;
}

export function tokenSet(text) {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

export const OVERLAP_THRESHOLD = 0.35;

/**
 * Discover everything. Returns { roots, skills, duplicates, overlaps }.
 * - duplicates: same skill name in ≥2 places (same skill installed for
 *   several tools, or two different skills sharing a name).
 * - overlaps: distinct names whose trigger text claims the same job
 *   (trigger-token Jaccard ≥ threshold). Pairs with identical content
 *   hashes are reported as duplicates instead.
 */
export function discover({ cwd = process.cwd() } = {}) {
  const roots = skillRoots({ cwd });
  const skills = [];
  const seenPaths = new Set();

  for (const root of roots) {
    if (root.error) continue;
    for (const file of walkForSkills(root.dir, root.tool === "codex" ? 8 : 5)) {
      const real = path.resolve(file);
      if (seenPaths.has(real)) continue;
      seenPaths.add(real);
      try {
        skills.push(parseSkill(real, { tool: root.tool, scope: root.scope, root: root.dir }));
      } catch (err) {
        skills.push({
          name: path.basename(path.dirname(real)),
          tool: root.tool, scope: root.scope, root: root.dir,
          path: real, dir: path.dirname(real),
          error: err.message, sections: [], triggers: "", whenNot: "",
          files: [], commands: [], riskyTools: [], tokens: 0, bytes: 0,
          description: `(parse error: ${err.message})`, frontmatter: {}, hash: "",
        });
      }
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name) || a.tool.localeCompare(b.tool));

  const byName = new Map();
  for (const s of skills) {
    if (!byName.has(s.name)) byName.set(s.name, []);
    byName.get(s.name).push(s);
  }
  const duplicates = [...byName.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([name, group]) => ({
      name,
      identical: new Set(group.map((s) => s.hash)).size === 1,
      installs: group.map((s) => ({ tool: s.tool, scope: s.scope, path: s.path, hash: s.hash.slice(0, 12) })),
    }));

  const overlaps = [];
  const sets = skills.map((s) => tokenSet(`${s.name} ${s.triggers}`));
  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      if (skills[i].name === skills[j].name) continue;
      const score = jaccard(sets[i], sets[j]);
      if (score >= OVERLAP_THRESHOLD) {
        overlaps.push({
          a: { name: skills[i].name, tool: skills[i].tool, path: skills[i].path },
          b: { name: skills[j].name, tool: skills[j].tool, path: skills[j].path },
          score: Number(score.toFixed(3)),
        });
      }
    }
  }
  overlaps.sort((a, b) => b.score - a.score);

  return {
    generatedAt: new Date().toISOString(),
    cwd,
    roots: roots.map((r) => ({ ...r, exists: existsSync(r.dir) })),
    skills,
    duplicates,
    overlaps,
  };
}

/** Rank skills for `where <query>`: name > triggers > description > body. */
export function where(data, query) {
  const q = tokenSet(query);
  const qLower = query.toLowerCase();
  return data.skills
    .map((s) => {
      let score = 0;
      if (s.name.toLowerCase() === qLower) score += 5;
      else if (s.name.toLowerCase().includes(qLower)) score += 2.5;
      score += 3 * jaccard(q, tokenSet(s.triggers));
      score += 1.5 * jaccard(q, tokenSet(s.description));
      score += 0.5 * jaccard(q, tokenSet(s.sections.map((x) => `${x.heading} ${x.text}`).join(" ").slice(0, 4000)));
      return { skill: s, score: Number(score.toFixed(3)) };
    })
    .filter((r) => r.score > 0.05)
    .sort((a, b) => b.score - a.score);
}
