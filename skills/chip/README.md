# Chip

A guardrail against the giant agent PR. Chip has two halves:

1. **`SKILL.md`** — teaches an agent to plan a change as small,
   independently revertable steps, state each step's blast radius, and
   stop with a scope-expansion note instead of silently widening scope.
2. **`chip-check`** — a zero-dependency Node CLI that inspects a git diff
   and fails loudly until the work is chipped.

Inspired by Addy Osmani's framing of bias-to-action as "the smallest
responsible step, with guardrails and limited blast radius."

## Quick start

```bash
# working tree + local commits vs auto-detected base
# (origin/HEAD → origin/main → origin/master → main → master)
node skills/chip/scripts/chip-check.mjs

# explicit base
node skills/chip/scripts/chip-check.mjs --base origin/main

# committed range only (what CI runs); must contain ".." or "..."
node skills/chip/scripts/chip-check.mjs --range origin/main...HEAD
```

Requires Node ≥ 18 and git. No install, no dependencies — the script is
self-contained, so you can also vendor it anywhere in a repo and run it
directly. It can run from any subdirectory; paths are always repo-root
relative. Exit codes: 0 within budget (or overridden), 1 over budget,
2 usage or git error.

## What it measures

| Signal | Default budget | Notes |
| --- | --- | --- |
| Lines changed | 300 | Additions + deletions. Lockfile bulk and binary files excluded. Renames count only their edits. |
| Files touched | 12 | Includes untracked files in working-tree mode. |
| Top-level areas | 2 | Top-level dirs; children of each `areaRoots` entry (default `packages/`, `apps/`, `libs/`, `services/`, `crates/`, `skills/`) count as their own areas. Files directly at the repo root are listed as `(root)` but don't count. A top-level `test/` dir is its own area. A rename counts the areas of both paths. |
| Risky companions | 80 lines | When a lockfile, migration, `chip.config.json`, or CI config is touched, everything *else* in the diff must stay at or under this so the risky change ships (nearly) alone. |

Risky surfaces are always reported: lockfiles, migrations (not `.md`,
`.mdx`, `.rst`, `.txt` prose), `chip.config.json`, public API/exports
(`index.*`, `*.d.ts`, package manifests — informational), and CI config
(`.github/workflows/`, `.github/actions/`, GitLab, Jenkins, CircleCI,
Buildkite, Travis). A rename is checked against both its old and new path.

Default budgets rationale: review effectiveness drops sharply past ~400
changed lines (the SmartBear/Cisco code review study), so the line budget
sits below that ceiling rather than at it; 12 files and 2 areas keep a
step revertable as a unit; 80 companion lines allows minimal glue around
a risky change without letting a feature hide behind a dep bump.

## Configuration

Optional `chip.config.json` at the target repo root (or pass `--config`,
resolved against `--cwd`):

```json
{
  "maxLines": 300,
  "maxFiles": 12,
  "maxAreas": 2,
  "riskyCompanionLines": 80,
  "areaRoots": ["packages", "apps", "libs", "services", "crates", "skills"],
  "ignore": ["*.snap", "**/generated/**"],
  "risky": {
    "lockfile": [],
    "migration": ["db/schema-changes/**"],
    "config": [],
    "publicApi": [],
    "ci": []
  }
}
```

- All keys optional; unknown keys, wrong types, and invalid JSON exit 2.
- `areaRoots` entries may be nested (`"frontend/apps"`).
- `ignore` removes files from every count, except `chip.config.json`
  itself. `risky.*` globs add to the built-in patterns.
- Globs work like `.gitignore`: a pattern without `/` matches at any
  depth (`*.snap`), one with `/` is anchored at the repo root. `*`, `**`,
  `?`, and `{a,b}` are supported.
- **Which config applies:** `--range` reads `chip.config.json` at the
  range's merge base, so a PR cannot relax its own budgets; working-tree
  mode reads the working-tree file. `--config` always wins. The report's
  first line names the config used.

## Escape hatch (explicit, never silent)

When a big diff is genuinely the responsible step (repo bootstrap,
generated code sync, mass mechanical rename), override explicitly:

- **Commit message line** — on the **newest** non-merge commit of the
  checked range (the PR head in CI), at the start of a line:

  ```
  Chip-Override: repo bootstrap; nothing exists yet to split against
  ```

  The key is case-insensitive and the reason must be on the same line.
  Overrides on older commits are listed as ignored, so one waiver can't
  cover everything pushed after it; restate it if you add commits.
- **Flag** — `--override "<reason>"` (the reason is required).
- **PR label** — the shipped workflow maps a `chip-override` label to the
  flag.

An override still prints the violations plus a loud banner with the
reason and its source, so reviewers see exactly what was waived.

## CI (GitHub Actions)

Copy [`workflows/chip.yml`](workflows/chip.yml) into your repo's
`.github/workflows/`. It downloads chip-check from a pinned commit,
verifies its sha256, and runs it on every PR; the `chip-override` label
is the escape hatch. The pin is the last published commit
(`e8f4ad4`, which predates the newest-commit override and base-config
rules above); bump `CHIP_COMMIT` and `CHIP_SHA256` together to upgrade.
If you vendor the skill into your repo (e.g. `.agents/skills/chip/`),
point the workflow at the vendored script instead.

## Known limits

- Base auto-detection prefers a local `main` over `master` when both
  exist; pass `--base` if your default branch differs.
- Working-tree mode trusts the working-tree `chip.config.json`; CI's
  `--range` check is the enforcement point.

## Tests

```bash
node --test skills/chip/scripts/chip-check.test.mjs
```
