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
# working tree + local commits vs auto-detected base (origin/HEAD → main → master)
node skills/chip/scripts/chip-check.mjs

# explicit base
node skills/chip/scripts/chip-check.mjs --base origin/main

# committed range only (what CI runs)
node skills/chip/scripts/chip-check.mjs --range origin/main...HEAD
```

Requires Node ≥ 18 and git. No install, no dependencies — the script is
self-contained, so you can also vendor it anywhere in a repo and run it
directly.

## What it measures

| Signal | Default budget | Notes |
| --- | --- | --- |
| Lines changed | 300 | Additions + deletions. Lockfile bulk and binary files excluded. |
| Files touched | 12 | Includes untracked files in working-tree mode. |
| Top-level areas | 2 | Top-level dirs; children of `packages/`, `apps/`, `libs/`, `services/`, `crates/`, `skills/` count as their own areas. |
| Risky companions | 80 lines | When a lockfile, migration, or CI config is touched, everything *else* in the diff must stay under this so the risky change ships (nearly) alone. |

Risky surfaces are always reported: lockfiles, migrations, public
API/exports (`index.*`, `*.d.ts`, package manifests — informational),
and CI config.

Default budgets rationale: review effectiveness drops sharply past ~400
changed lines (the SmartBear/Cisco code review study), so the line budget
sits below that ceiling rather than at it; 12 files and 2 areas keep a
step revertable as a unit; 80 companion lines allows minimal glue around
a risky change without letting a feature hide behind a dep bump.

## Configuration

Optional `chip.config.json` at the target repo root (or pass `--config`):

```json
{
  "maxLines": 300,
  "maxFiles": 12,
  "maxAreas": 2,
  "riskyCompanionLines": 80,
  "areaRoots": ["packages", "apps", "libs", "services", "crates", "skills"],
  "ignore": ["**/*.snap", "**/generated/**"],
  "risky": {
    "lockfile": [],
    "migration": ["db/schema-changes/**"],
    "publicApi": [],
    "ci": []
  }
}
```

All keys optional. `ignore` removes files from every count. `risky.*`
globs are additive on top of the built-in patterns.

## Escape hatch (explicit, never silent)

When a big diff is genuinely the responsible step (repo bootstrap,
generated code sync, mass mechanical rename), override explicitly:

- **Commit trailer** — add to any commit in the checked range:

  ```
  Chip-Override: repo bootstrap; nothing exists yet to split against
  ```

- **Flag** — `--override "<reason>"` (the reason is required).
- **PR label** — the shipped workflow maps a `chip-override` label to the
  flag.

An override still prints the violations plus a loud banner with the
reason, so reviewers see exactly what was waived. There is no quiet
bypass.

## CI (GitHub Actions)

Copy [`workflows/chip.yml`](workflows/chip.yml) into your repo's
`.github/workflows/`. It fetches the pinned check script and runs it on
every PR; the `chip-override` label is the escape hatch. If you vendor
the skill into your repo (e.g. `.agents/skills/chip/`), point the
workflow at the vendored script instead of curling it.

## For agents: before saying "done"

Run the check locally against your work:

```bash
node <path-to-skill>/scripts/chip-check.mjs --base origin/main
```

If it fails, split as suggested. If you believe an override is justified,
say so to the human and use the commit trailer — with the reason — rather
than working around the check.

## Tests

```bash
node --test skills/chip/scripts/chip-check.test.mjs
```
