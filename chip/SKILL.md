---
name: chip
description: Ship the smallest responsible step instead of one giant PR. Use when starting any coding task, when a change is growing past a few files, when tempted to refactor "while you're in there", or before declaring work done. Plan small independently shippable steps, state blast radius, never widen scope silently, and run the chip check before finishing.
---

# Chip — the smallest responsible step

Bias to action means the smallest responsible step, with guardrails and limited blast radius — not the biggest diff you can produce in one run. One giant PR is slower to review, riskier to land, and impossible to revert cleanly.

## The loop

1. **Plan the chips before writing code.** Break the task into steps where each step is independently reviewable, independently revertable, and leaves the codebase working. List them (one line each) before the first edit. If a step depends on another, order them; don't merge them.
2. **Ship one chip at a time.** Implement exactly one step. Do not start the next step in the same change.
3. **State the blast radius.** For each chip, say concretely what it can break: files and packages touched, public APIs or exports changed, migrations or schema changes, CI/config changes. If you can't state it in two sentences, the chip is too big.
4. **Never widen scope silently.** The moment the work wants to grow past the planned chip — a refactor "while you're in there", a rename cascading through the codebase, a dependency bump the fix "needs" — stop and surface a scope expansion note instead of doing it:

   > **Scope expansion:** fixing X turns out to require Y (~n files in `<area>`). Options: (a) ship X small with a workaround, (b) chip Y first as its own step, (c) accept the bigger diff. Recommending (b).

5. **Run the check before saying done.** From the repo root:

   ```sh
   node <skill-dir>/scripts/chip.mjs
   ```

   It diffs your work against the base branch and fails if you're over budget on lines, files, areas, or risky surfaces. **If it fails, split — don't rationalize.** Re-plan the remaining work as chips and ship the first one.

6. **Escape hatch — explicit, never silent.** Some changes genuinely can't be split (generated code, an atomic rename, a bootstrap). Say so where reviewers will see it: commit trailer `Chip-Override: <reason>`, or the `chip-override` PR label in CI. The check still prints the full report; the override is loud on purpose.

## Anti-rationalization table

| Excuse | Rebuttal |
| --- | --- |
| "It's all one logical change." | Logical ≠ atomic. A migration + the code using it are one idea and two chips. |
| "Splitting takes longer." | Splitting is minutes; reviewing/reverting/bisecting a 2,000-line PR costs everyone hours. |
| "The tests only pass with everything together." | That's a sequencing problem. Land the substrate first (types, flags, adapters), then the behavior. |
| "While I'm in here, I'll also fix…" | That's a second chip. Note it, finish the current one. |
| "The refactor is needed for the fix." | Then the refactor is chip 1 (no behavior change) and the fix is chip 2. |
| "Reviewers can just skim the big parts." | Unreviewed code with an approval stamp is worse than unreviewed code. |
| "It's mostly generated/mechanical." | Then isolate the generated part in its own chip (or override explicitly) so the hand-written part gets real review. |

## What counts as risky

Lockfiles, migrations/schema, public API/exports, CI config. One risky surface per chip, alone or nearly alone — a lockfile bump is its own PR, a migration is its own PR, and the code that depends on them comes after.

Full CLI docs, config schema, budget rationale, and the ready-to-copy GitHub Action: see [README.md](README.md) in this skill folder.
