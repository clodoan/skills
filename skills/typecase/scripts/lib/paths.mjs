/**
 * Where installed agent skills live, per tool. Every path is sourced:
 *
 * [GROK]   docs.x.ai/build/features/skills-plugins-marketplaces —
 *          project `.grok/skills` (walked up to the repo root), user
 *          `$GROK_HOME/skills` (default `~/.grok/skills`), plugins under
 *          `./.grok/plugins`, `~/.grok/plugins` and marketplace installs
 *          in `~/.grok/plugins/marketplaces/`, each plugin's `skills/`.
 *          Grok also reads the AGENTS.md-family dirs ([AGENTS]).
 * [CURSOR] cursor.com/docs/skills — project `.cursor/skills` and
 *          `.agents/skills` (nested project dirs too), user
 *          `~/.cursor/skills` and `~/.agents/skills`; reads
 *          `.claude/skills` / `.codex/skills` for compatibility.
 *          Plugin-delivered skills appear under
 *          `~/.cursor/plugins/cache/<marketplace>/<id>/<rev>/skills/`
 *          (observed layout on real machines, not documented — may change).
 * [CLAUDE] code.claude.com/docs/en/skills — project `.claude/skills`
 *          (this dir and parents up to the repo root), user
 *          `~/.claude/skills`; plugins ship `skills/` folders, installed
 *          under `~/.claude/plugins/` (marketplaces/cache layouts
 *          observed; scanned generically).
 * [CODEX]  developers.openai.com/codex/skills — repo `.agents/skills`
 *          from cwd up to the repo root, user `~/.codex/skills`
 *          (`$CODEX_HOME/skills`, scanned recursively per docs) and
 *          `~/.agents/skills`, admin `/etc/codex/skills`.
 * [AGENTS] `.agents/skills` / `~/.agents/skills` are shared dirs read by
 *          Grok, Cursor and Codex alike; they are reported once under
 *          the pseudo-tool "shared" so one install isn't triple-counted.
 *
 * Extra roots come from `typecase.json` (`{ "paths": [{ "dir": …,
 * "tool": …, "scope": … }] }`) in the project root or `~/.config/
 * typecase/typecase.json`. `TYPECASE_HOME` overrides `~` for tests.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const TOOLS = ["grok", "cursor", "claude", "codex", "shared"];

function gitRoot(from) {
  let dir = path.resolve(from);
  while (true) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Project dirs named `rel` from cwd up to the repo root (or cwd only). */
function walkUp(cwd, rel) {
  const stop = gitRoot(cwd) ?? cwd;
  const dirs = [];
  let dir = path.resolve(cwd);
  while (true) {
    dirs.push(path.join(dir, rel));
    if (dir === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

export function home() {
  return process.env.TYPECASE_HOME ?? homedir();
}

/**
 * All skill roots as { tool, scope, dir, note } (dirs may not exist —
 * discovery filters). scope: "project" | "user" | "plugin" | "admin".
 */
export function skillRoots({ cwd = process.cwd() } = {}) {
  const h = home();
  const roots = [];
  const add = (tool, scope, dir, note = "") => roots.push({ tool, scope, dir: path.resolve(dir), note });

  // Grok [GROK]
  for (const dir of walkUp(cwd, ".grok/skills")) add("grok", "project", dir);
  add("grok", "user", path.join(process.env.GROK_HOME ?? path.join(h, ".grok"), "skills"));
  add("grok", "plugin", path.join(h, ".grok", "plugins"), "plugin skills/ dirs");
  add("grok", "plugin", path.join(cwd, ".grok", "plugins"), "project plugin skills/ dirs");

  // Cursor [CURSOR]
  for (const dir of walkUp(cwd, ".cursor/skills")) add("cursor", "project", dir);
  add("cursor", "user", path.join(h, ".cursor", "skills"));
  add("cursor", "plugin", path.join(h, ".cursor", "plugins", "cache"), "observed marketplace cache layout");

  // Claude Code [CLAUDE]
  for (const dir of walkUp(cwd, ".claude/skills")) add("claude", "project", dir);
  add("claude", "user", path.join(h, ".claude", "skills"));
  add("claude", "plugin", path.join(h, ".claude", "plugins"), "plugin skills/ dirs");

  // Codex [CODEX]
  add("codex", "user", path.join(process.env.CODEX_HOME ?? path.join(h, ".codex"), "skills"), "recursive per docs");
  add("codex", "admin", "/etc/codex/skills");

  // Shared AGENTS.md-family dirs [AGENTS] — read by Grok, Cursor, Codex.
  for (const dir of walkUp(cwd, ".agents/skills")) add("shared", "project", dir);
  add("shared", "user", path.join(h, ".agents", "skills"));

  // Config extras.
  for (const cfg of [path.join(cwd, "typecase.json"), path.join(h, ".config", "typecase", "typecase.json")]) {
    if (!existsSync(cfg)) continue;
    try {
      const extra = JSON.parse(readFileSync(cfg, "utf8"));
      for (const p of extra.paths ?? []) {
        add(p.tool ?? "shared", p.scope ?? "user", path.resolve(path.dirname(cfg), p.dir), `from ${cfg}`);
      }
    } catch (err) {
      roots.push({ tool: "shared", scope: "user", dir: cfg, note: `config parse error: ${err.message}`, error: true });
    }
  }

  // De-duplicate identical dirs (e.g. cwd == git root).
  const seen = new Set();
  return roots.filter((r) => {
    const key = `${r.tool}:${r.dir}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
