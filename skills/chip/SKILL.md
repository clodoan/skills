---
name: chip
description: >-
  Plan changes as small, independently revertable steps and enforce them
  with chip-check. Use before a change touching more than a couple of
  files, when a diff outgrows its plan, or before declaring work done.
---

# Chip

## Before writing code

Plan the change as a numbered sequence of steps. Each step must be:

- **Reviewable alone** — a human can hold it in their head in one sitting.
- **Revertable alone** — `git revert` of that step leaves the system working.
- **Budgeted** — it would pass the chip check on its own (defaults:
  ≤300 changed lines, ≤12 files, ≤2 top-level areas).

For every step, state its **blast radius** in one line: files/packages
touched, public API or exports changed, migrations, dependency changes,
CI config.

## While working

1. Implement **one step at a time**. Commit at step boundaries.
2. Before saying a step is done, run the check (see below). If it fails,
   split — do not argue with it, and do not edit `chip.config.json` to
   make it pass (a budget change is its own step).
3. If you discover the work needs more than the planned steps, **stop**.
   Do not silently widen scope. Surface a short scope-expansion note:

   > **Scope expansion:** planned <X>, but <Y> also needs to change
   > because <reason>. Options: (a) split into a follow-up step,
   > (b) explicit override. Which do you want?

## Running the check

Run from the target repo:

```bash
node <path-to-skill>/scripts/chip-check.mjs            # working tree vs auto-detected base
node <path-to-skill>/scripts/chip-check.mjs --base origin/main
node <path-to-skill>/scripts/chip-check.mjs --range origin/main...HEAD   # committed range (CI)
```

Exit 0 means within budget, 1 prints which budget broke and a suggested
split — follow it — and 2 is a usage or git error. The escape hatch is a
`Chip-Override: <reason>` line in the **newest** commit message (older
commits' overrides are ignored, so restate it if you add commits) or
`--override "<reason>"`. It is loud on purpose. Full CLI, config, and CI
setup: [README.md](README.md).

## Splitting heuristics

- Risky surface first, alone: migration, dependency bump, CI change,
  budget change.
- Refactor-only step (no behavior change) before the behavior step.
- One area/package per step; tests ride with the code they test.
- Mass-mechanical changes (rename, format, regenerate) are their own step.
- If one area still exceeds budget, split by feature slice within it.

## Anti-rationalization table

| Excuse | Rebuttal |
| --- | --- |
| "It's all one logical change" | Logical ≠ reviewable. If it can't be reverted in one piece safely, it's several changes. |
| "Splitting adds overhead" | Splitting costs minutes; an unreviewable PR costs review cycles and rollback risk. |
| "Tests forced me to touch everything" | Mechanical test fallout is its own step, separate from the behavior change. |
| "I'll split it if the reviewer asks" | By then context is gone. Splitting is cheapest before the code exists. |
