---
name: typecase
description: >-
  Read, audit, and track the agent skills installed on this machine. Use
  for "what skills are installed", "which skill handles X", "do any
  skills overlap or duplicate", "what changed in my skills since last
  week", or before adding a new skill (to check the name and triggers
  are free). Discovers Grok, Cursor, Claude Code, and Codex install
  locations, parses every SKILL.md, and keeps a lockfile + changelog.
---

# Typecase

A reader, parser, and lockfile for installed agent skills. All commands
run from the directory whose `skills.lock` you care about (usually the
repo root or `$HOME`).

1. **List everything installed** — grouped by tool and scope, with
   duplicate/overlap/risky marks and token sizes:

   ```bash
   node <path-to-skill>/scripts/typecase.mjs ls
   node <path-to-skill>/scripts/typecase.mjs ls --tool cursor --json
   ```

2. **Answer "which skill handles X?"** — ranked by name, triggers, and
   description match; prints the winning skill and its path:

   ```bash
   node <path-to-skill>/scripts/typecase.mjs where "resize a video"
   ```

3. **Read one skill** without opening files:

   ```bash
   node <path-to-skill>/scripts/typecase.mjs show <skill-name>
   ```

4. **Pin and track changes.** `lock` writes `skills.lock` (content hash
   + git commit or plugin version per skill) and snapshots each skill so
   `pin` can restore it. `diff` compares the live installs against the
   lock, section by section, and prints one plain-language paragraph per
   changed skill ("what will the agent now do differently"). It exits 1
   when anything changed, so it works as a guard:

   ```bash
   node <path-to-skill>/scripts/typecase.mjs lock
   node <path-to-skill>/scripts/typecase.mjs diff --write-changelog   # appends TYPECASE.md
   node <path-to-skill>/scripts/typecase.mjs pin <skill-name>        # restore locked version
   ```

5. **Desktop reader.** `open` launches the Typecase app (if its
   dependencies are installed under `<path-to-skill>/app`) or falls back
   to a static HTML reader in the browser:

   ```bash
   node <path-to-skill>/scripts/typecase.mjs open
   ```

Notes:

- Zero dependencies for the CLI; Node ≥ 18. The desktop app is a
  separate optional package (`app/`).
- Extra install locations: create `typecase.json` with
  `{ "paths": [{ "dir": "...", "tool": "...", "scope": "..." }] }` in
  the working directory or `~/.config/typecase/`.
- `diff` paragraphs are deterministic by default. Set `TYPECASE_LLM_CMD`
  to a shell command (receives change JSON on stdin, prints a paragraph)
  to use an LLM instead; any failure falls back to the deterministic text.
- Before creating a new skill, run `ls` and `where` with the planned
  name/triggers to catch collisions and overlaps first.
