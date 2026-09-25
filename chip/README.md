# chip

A skill + check that pushes coding agents toward the smallest responsible step. The [`SKILL.md`](SKILL.md) teaches the agent to plan scoped increments, state blast radius, and surface scope expansion instead of silently widening a diff. The check ([`scripts/chip.mjs`](scripts/chip.mjs)) fails loudly until the work is chipped.

- **Zero dependencies.** One Node script (Node ≥ 18), no install step.
- **Configurable budgets** with sensible defaults, overridable per repo.
- **Explicit escape hatch** — a commit trailer or PR label, never a silent bypass.

## What the check measures

Against the merge-base with your base branch (working tree included, so uncommitted work counts):

| Metric | Default budget | Why this default |
| --- | --- | --- |
| Lines changed (adds + deletes) | 400 | Review quality drops off sharply past a few hundred lines; ~400 keeps a PR reviewable in one sitting. Lockfiles and `ignoreLines` globs are excluded from the count (they're generated churn) but still show up as files and risky surfaces. |
| Files touched | 15 | More files than this and the reviewer is paging, not reading. |
| Top-level areas touched | 3 | An area is a top-level directory (root files count as one `(root)` area; children of `packages/`, `apps/`, etc. count individually). A change spanning `src` + `test` + a root config is normal; four-plus areas usually means two changes in one. |
| Risky surfaces touched | 1 | Lockfiles, migrations, public API/exports, CI config. Each deserves its own scoped PR — a dependency bump alone, a migration alone, then the code that uses them. |

Exit codes: `0` pass (or explicitly overridden), `1` over budget, `2` usage/git error.

## Running it locally (agents: do this before saying "done")

```sh
# from the target repo root, against the auto-detected base (origin/main, origin/master, main, master)
node path/to/chip/scripts/chip.mjs

# explicit base or commit range
node path/to/chip/scripts/chip.mjs --base origin/main
node path/to/chip/scripts/chip.mjs --range origin/main..HEAD

# machine-readable
node path/to/chip/scripts/chip.mjs --json
```

If the skill is installed in the conventional location, the path is e.g. `.claude/skills/chip/scripts/chip.mjs` (Claude Code) or `.cursor/skills/chip/scripts/chip.mjs` / `.agents/skills/chip/scripts/chip.mjs` (Cursor / Codex).

On failure it prints which budgets you blew and a concrete split suggestion — per-area file/line counts so each area can become its own PR, and which risky files to pull into separate changes.

## Configuration

Optional `chip.config.json` at the target repo root (or pass `--config <path>`). Anything omitted keeps the default:

```json
{
  "base": "origin/main",
  "budgets": {
    "maxLines": 400,
    "maxFiles": 15,
    "maxAreas": 3,
    "maxRiskySurfaces": 1
  },
  "workspaceRoots": ["packages", "apps", "libs", "crates", "services", "modules"],
  "ignoreLines": ["**/__generated__/**", "*.snap"],
  "risky": {
    "lockfiles": ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"],
    "migrations": ["**/migrations/**", "**/schema.prisma"],
    "ci": [".github/workflows/**"],
    "publicApi": ["package.json", "src/index.*", "**/*.d.ts"]
  }
}
```

Notes:

- `workspaceRoots`: top-level dirs whose children count as separate areas (so `packages/ui` and `packages/core` are two areas, not one).
- `ignoreLines`: globs excluded from the line budget (generated files). Lockfiles are always excluded from line counts.
- `risky.<category>`: setting a category replaces its default patterns. Globs without a `/` match basenames anywhere; globs with a `/` match from the repo root. `**`, `*`, `?`, and `{a,b}` are supported.

## Escape hatch (explicit, never silent)

Two forms, both visible to reviewers:

- **Commit trailer** — add to any commit message in the range:

  ```text
  Chip-Override: repo bootstrap, generated code cannot be split
  ```

- **PR label** — apply the `chip-override` label; the workflow below passes the label through as the override reason.

Overridden runs still print the full report plus a loud `OVERRIDDEN` banner with the reason, and exit `0`. There is no flag-less silent bypass.

## GitHub Action

Copy [`templates/chip.yml`](templates/chip.yml) to `.github/workflows/chip.yml` in the target repo and adjust the script path to where the skill is installed:

```yaml
name: chip
on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]

permissions:
  contents: read

jobs:
  chip:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: chip — smallest responsible step
        env:
          # The chip-override label is the explicit escape hatch; an empty
          # value is ignored by the CLI.
          CHIP_OVERRIDE: ${{ contains(github.event.pull_request.labels.*.name, 'chip-override') && 'PR label: chip-override' || '' }}
        run: |
          node chip/scripts/chip.mjs --base "origin/${GITHUB_BASE_REF}" --override "$CHIP_OVERRIDE"
```

`fetch-depth: 0` matters — the check needs the merge-base with the target branch.

## Tests

```sh
cd chip && npm test   # node --test, no dependencies
```

Covers: small diff passes; big diff fails with split suggestions; too many areas fails with per-area breakdown; risky surfaces (lockfile + migration) fail while a single risky surface passes; lockfile lines don't count against the line budget; escape hatch via commit trailer and via `--override`; config overrides.
