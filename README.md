# skills

Installable agent skills for design engineers who delegate work to coding
agents (Grok, Cursor, and friends). Practical, daily-use guardrails —
not concept demos.

Each skill is a self-contained folder under [`skills/`](skills/): a
`SKILL.md` in the standard Agent Skills format (YAML frontmatter with
`name` and `description`, then instructions), a `README.md` for humans,
and any scripts it ships.

## Skills

| Skill | What it does |
| --- | --- |
| [chip](skills/chip/) | Pushes agents toward the smallest responsible step: plan small revertable increments, state blast radius, and a `chip-check` CLI + GitHub Action that fails loudly until the work is chipped. |
| [scrub](skills/scrub/) | Frame-by-frame UI animation inspection: drop a screen recording or GIF in chat and the agent gets stamped contact sheets, diff images, and a per-frame motion table to reason about timing, easing, and jank. Needs ffmpeg. |
| [plinth](skills/plinth/) | Device-framed, DPR-correct screenshots of a running app or URL (phone/tablet/laptop/browser frames, generated CSS, no vendor artwork) with self-verifying dimensions and alignment; optional scrolled mp4/gif. Needs Chrome; ffmpeg for video. |

## Installing a skill

Copy the skill folder into the location your tool reads. Using `chip` as
the example (all paths verified against each tool's docs as of Sep 2026):

**Grok** (Grok CLI / Grok Build) — [docs](https://docs.x.ai/build/features/skills-plugins-marketplaces)

```bash
# per project (walked up to the repo root)
cp -r skills/chip <your-repo>/.grok/skills/chip
# personal (all projects): $GROK_HOME/skills, default ~/.grok/skills
cp -r skills/chip ~/.grok/skills/chip
```

Grok also discovers `~/.agents/skills/` and project `.agents/skills/`
(the AGENTS.md-family locations), and scans Cursor and Claude skill
directories for compatibility. Run `grok inspect` to verify discovery.

**Cursor** — [docs](https://cursor.com/docs/skills)

```bash
# per project
cp -r skills/chip <your-repo>/.cursor/skills/chip
# personal: ~/.cursor/skills/chip  (only this one syncs to Cloud Agents)
```

Cursor also reads project `.agents/skills/` and user `~/.agents/skills/`,
plus `.claude/skills/` and `.codex/skills/` for compatibility.

**Also works with:**

- **Codex** — [docs](https://developers.openai.com/codex/skills):
  `~/.codex/skills/chip` (personal) or `<your-repo>/.agents/skills/chip`
  (per repo). Some Codex versions gate skills behind
  `[features] skills = true` in `~/.codex/config.toml`; current releases
  load them by default.
- **Claude Code** — [docs](https://code.claude.com/docs/en/skills):
  `~/.claude/skills/chip` (personal) or `<your-repo>/.claude/skills/chip`
  (per project).

Tip: project-level `.agents/skills/<name>/` is read by Grok, Cursor, and
Codex alike — one location covers all three.

Skills that ship a CI check (like chip) also include a ready-to-copy
GitHub Action workflow — see the skill's own README.

## Contributing

One folder per skill under `skills/`, self-contained: `SKILL.md`
(frontmatter `name` must match the folder name), `README.md`, and any
`scripts/` with tests. Keep `SKILL.md` lean — skills cost context; put
deep material in referenced files. Scripts should be dependency-light
and runnable without an install step. PRs to this repo are expected to
pass its own chip check.

## License

[MIT](LICENSE) © 2026 Claudio Angrigiani
