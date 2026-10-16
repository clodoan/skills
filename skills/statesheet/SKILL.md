---
name: statesheet
description: >-
  See and tame React component state. Renders a component in every
  declared state × viewport (375/768/1280) × light/dark into one
  pixel-verified contact-sheet PNG (Playwright mounts it directly — no
  Storybook), finds components whose state is a pile of booleans
  (isLoading && !error && …), and proposes a reducer with an explicit
  transition table. Use when the user asks for a state contact sheet,
  state matrix screenshots, "every state of this component", boolean
  state cleanup, impossible states, or a reducer/transition-table
  refactor.
---

# Statesheet

Component state you can see (one contact sheet) and audit (one
transition table).

## Workflow

1. One-time setup in the skill directory: `npm install` (installs
   esbuild + playwright-core; drives the system Chrome — no browser
   download). The target app's own node_modules must be installed:
   components are bundled and `react` is resolved from the app.

2. Find the boolean piles:

   ```bash
   node <path-to-skill>/scripts/statesheet.mjs scan src/
   ```

   Reports components with ≥2 boolean useStates (`isLoading`,
   `isFormOpen`, …), their 2^n combination count, and companions like
   `error`/`data`. Heuristic lexical pass — verify hits before acting.

3. Propose the reducer (`--write` saves next to the source):

   ```bash
   node <path-to-skill>/scripts/statesheet.mjs propose src/Comment.jsx --component Comment
   ```

   Emits TypeScript: a status union, an event union, and a `transitions`
   table the reducer consults exclusively — a transition that is not a
   row in the table throws in dev. **Never bypass the table**: to allow
   a new transition, add a row to `transitions`, where review sees it.
   Orthogonal toggles (`isOpen`, `showTooltip`) are reported as flags,
   not forced into the machine.

4. Declare the states to photograph in a states file next to the
   component (props object or render function per state):

   ```tsx
   // panel.states.tsx
   import { Panel } from "./panel";
   export default {
     component: Panel,
     states: {
       loading: { isLoading: true },
       error: { error: "GET /api returned 503" },
       success: { data: rows },
     },
     // optional: wrap: (el) => <Providers>{el}</Providers>,
     // background: { light: "#fff", dark: "#0c0e12" }, darkClass: "dark"
   };
   ```

5. Render the sheet:

   ```bash
   node <path-to-skill>/scripts/statesheet.mjs sheet panel.states.tsx --out panel.png
   ```

   Every state × viewport (375/768/1280) × light/dark on one evenly
   spaced labeled grid. Dark = Chrome `prefers-color-scheme: dark` plus
   a `dark` class and `data-theme="dark"` on `<html>`.

6. **Trust the checks, and say what they said.** Every run verifies the
   output against the computed geometry and prints `check:` lines
   (exact sheet dimensions, cell borders, gutters). Exit 1 means a
   check failed and no PNG was written — report it, don't hand over a
   sheet that wasn't verified. Then look at the image: real components
   have real problems (unseeded data, fonts swapping → `--wait 1000`).

If a component hides its booleans internally, the sheet cannot force
them from outside — that is the finding, not a tool gap. Run `propose`,
lift the status into a prop or reducer, then photograph it.

App bundling knobs: `--alias key=path` (webpack/tsconfig aliases),
`--node-paths <dirs>` (apps importing from a src root, e.g. `shared/…`).
Full option reference and real-app examples: [README.md](README.md).
