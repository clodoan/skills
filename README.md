# skills

Installable [Agent Skills](https://agentskills.io) for design engineers who delegate work to coding agents (Claude Code, Cursor, Codex).

Each skill is a self-contained folder with a `SKILL.md` (the instructions the agent loads), a `README.md` (docs for humans), and any scripts the skill needs. Install a skill by copying its folder into your tool's skills directory — no build step, no dependencies.

## Skills

| Skill | What it does |
| --- | --- |
| [`chip`](chip/) | Pushes agents toward the smallest responsible step: plan scoped increments, state blast radius, never widen scope silently. Ships a zero-dependency CLI check that fails until the work is chipped, plus a GitHub Action to enforce it on PRs. |

## Installing a skill

Copy the skill folder (e.g. `chip/`) into the skills directory for your tool. The folder name must match the `name` in the skill's frontmatter.

### Claude Code

- Project (shared with the repo): `.claude/skills/chip/`
- Personal (all your projects): `~/.claude/skills/chip/`

```sh
mkdir -p ~/.claude/skills && cp -R chip ~/.claude/skills/
```

### Cursor

- Project: `.cursor/skills/chip/` or `.agents/skills/chip/`
- Personal: `~/.cursor/skills/chip/` or `~/.agents/skills/chip/`

Cursor also loads skills from the Claude Code and Codex directories (`.claude/skills/`, `.codex/skills/`, and their `~/` equivalents), so a skill installed for one of those tools is picked up too.

### Codex

- Project (scanned from your working directory up to the repo root): `.agents/skills/chip/`
- Personal: `~/.agents/skills/chip/`

Older Codex versions used the experimental `~/.codex/skills/` location behind a `[features] skills = true` config flag; current releases document `.agents/skills/`. If skills don't load, check which version you're on and restart Codex after installing — skills are discovered at startup.

### One copy for every tool

`.agents/skills/` is read by both Cursor and Codex, so committing a skill there covers both. Claude Code only reads `.claude/skills/`, so for full coverage commit the skill under `.claude/skills/` and symlink it:

```sh
mkdir -p .claude/skills .agents/skills
cp -R chip .claude/skills/
ln -s ../../.claude/skills/chip .agents/skills/chip
```

(Note: Codex follows symlinked skill *directories* but skips symlinked `SKILL.md` *files* — link the folder, not the file.)

## Contributing

One folder per skill, self-contained: `SKILL.md` with `name` and `description` frontmatter, a `README.md` for humans, and scripts under `scripts/` with tests. Skills cost context — keep `SKILL.md` lean and push deep material into referenced files. Practical over conceptual: a skill should be something you'd reach for daily, with a way to verify it worked.

## License

[MIT](LICENSE) © 2026 Claudio Angrigiani
