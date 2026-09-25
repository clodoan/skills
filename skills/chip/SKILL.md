---
name: chip
description: >-
  Ship the smallest responsible step instead of one giant diff. Use when
  starting any change that will touch more than a couple of files, when a
  diff is growing past its plan, or before declaring work done: plan small
  independently revertable steps, state each step's blast radius, run the
  chip check, and stop with a scope-expansion note instead of silently
  widening scope.
---

# Chip

Bias to action means the smallest responsible step, with guardrails and
limited blast radius — not the biggest diff you can produce in one run.
One giant PR is slower to review, riskier to revert, and hides mistakes.

## Before writing code

Plan the change as a numbered sequence of steps. Each step must be:

- **Reviewable alone** — a human can hold it in their head in one sitting.
- **Revertable alone** — `git revert` of that step leaves the system working.
- **Budgeted** — it would pass the chip check on its own (defaults:
  ≤300 changed lines, ≤12 files, ≤2 top-level areas).

For every step, state its **blast radius** in one line: files/packages
touched, public API or exports changed, migrations, dependency changes,
CI config. Risky surfaces (lockfiles, migrations, CI) get their own step
and ship (nearly) alone.

## While working

1. Implement **one step at a time**. Commit at step boundaries.
2. Before saying a step is done, run the check (see below). If it fails,
   split — do not argue with it.
3. If you discover the work needs more than the planned steps, **stop**.
   Do not silently widen scope. Surface a short scope-expansion note:

   > **Scope expansion:** planned <X>, but <Y> also needs to change
   > because <reason>. Options: (a) split into a follow-up step,
   > (b) explicit override. Which do you want?

## Running the check

From the repo where the skill is installed (any of these locations):

```bash
node <path-to-skill>/scripts/chip-check.mjs            # working tree vs auto-detected base
node <path-to-skill>/scripts/chip-check.mjs --base origin/main
node <path-to-skill>/scripts/chip-check.mjs --range origin/main...HEAD   # committed range (CI)
```

Exit 0 means within budget. Exit 1 prints which budget broke and a
suggested split — follow it. Budgets are configurable per repo via
`chip.config.json`; escape hatch is a `Chip-Override: <reason>` commit
trailer or `--override "<reason>"` (loud on purpose, never silent).
Full CLI, config, and CI setup: [README.md](README.md).

## Splitting heuristics

- Risky surface first, alone: migration, dependency bump, CI change.
- Refactor-only step (no behavior change) before the behavior step.
- One area/package per step; tests ride with the code they test.
- Mass-mechanical changes (rename, format, regenerate) are their own step.
- If one area still exceeds budget, split by feature slice within it.

## Anti-rationalization table

| Excuse | Rebuttal |
| --- | --- |
| "It's all one logical change" | Logical ≠ reviewable. If it can't be reverted in one piece safely, it's several changes. |
| "Splitting adds overhead" | Splitting costs minutes; an unreviewable PR costs review cycles and rollback risk. |
| "The refactor was necessary for the feature" | Then the refactor is step 1, behavior-neutral, and ships first. |
| "Tests forced me to touch everything" | Mechanical test fallout is its own step, separate from the behavior change. |
| "The lockfile changed as a side effect" | Dependency changes are a step. Ship the bump alone; the code that uses it follows. |
| "It's mostly generated code" | Regenerate in its own step so review focuses on the source change. |
| "The migration is only two lines" | Migrations change production state; they ship alone with their own revert story. |
| "I'll split it if the reviewer asks" | By then context is gone. Splitting is cheapest before the code exists. |
