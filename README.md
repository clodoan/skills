# skills

Installable agent skills for design engineers who delegate work to coding
agents (Claude Code, Cursor, Codex). Practical, daily-use guardrails —
not concept demos.

Each skill is a self-contained folder under [`skills/`](skills/): a
`SKILL.md` in the standard Agent Skills format (YAML frontmatter with
`name` and `description`, then instructions), a `README.md` for humans,
and any scripts it ships.

## Skills

| Skill | What it does |
| --- | --- |
| [chip](skills/chip/) | Pushes agents toward the smallest responsible step: plan small revertable increments, state blast radius, and a `chip-check` CLI + GitHub Action that fails loudly until the work is chipped. |

Likely next: **scrub** — frame-by-frame animation inspection for agents.

## Installing a skill

Copy the skill folder into the location your tool reads. Using `chip` as
the example (all paths verified against each tool's docs as of Sep 2026):

**Claude Code** — [docs](https://code.claude.com/docs/en/skills)

```bash
# personal (all projects)
cp -r skills/chip ~/.claude/skills/chip
# or per project
cp -r skills/chip <your-repo>/.claude/skills/chip
```

**Cursor** — [docs](https://cursor.com/docs/skills)

```bash
# per project (also readable by Codex)
cp -r skills/chip <your-repo>/.agents/skills/chip
# or Cursor-specific: <your-repo>/.cursor/skills/chip
# personal: ~/.cursor/skills/chip  (only this one syncs to Cloud Agents)
```

Cursor also reads `.claude/skills/` and `.codex/skills/` for
compatibility, so a skill installed for another tool is picked up too.

**Codex** — [docs](https://developers.openai.com/codex/skills)

```bash
# personal (all projects)
cp -r skills/chip ~/.codex/skills/chip
# or per repository
cp -r skills/chip <your-repo>/.agents/skills/chip
```

Note: some Codex versions gate skills behind `[features] skills = true`
in `~/.codex/config.toml`; current releases load them by default. If a
skill doesn't appear, check that flag and restart Codex.

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
