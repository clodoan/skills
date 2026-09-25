---
name: ramble
description: >-
  Document the screens and navigation flows that already exist in a
  codebase. Use whenever the user asks for a screen map, user-flow
  diagram, sitemap, route overview, "what screens does this app have",
  or "diagram how these pages connect". Walks the router (Next.js app/
  and pages/, React Router) plus link/redirect call sites and emits a
  Mermaid flowchart of real routes — no drawing, no guessing.
---

# Ramble

The flow diagram is already in the code — routers and links define it.
Ramble walks them and emits a Mermaid flowchart of real screens and real
transitions, with a report of everything it could not resolve.

## Workflow

1. Run it on the repo (or the app inside a monorepo):

   ```bash
   node <path-to-skill>/scripts/ramble.mjs .            # or apps/web
   ```

   It writes `map-output/flow.md` (diagram + report) and `flow.mmd`.
   GitHub and most editors render the Mermaid block directly.

2. **Read the report before showing the diagram.** It lists: routers
   found, screen/edge counts, API handlers (not screens), parallel route
   slots and intercepting routes (rendered in place, not URLs), and —
   most importantly — **unresolved navigations** with file:line. Those
   are real transitions the static scan couldn't resolve (expression
   hrefs, computed pushes). Mention them; never present the diagram as
   complete without them.

3. Reading the diagram: solid arrows are links/navigations; dashed
   arrows are redirects (including middleware and next.config) — the
   auth-gate edges. Dynamic params are `:param`, catch-alls `:param*`,
   optional catch-alls `:param*?`.

4. Optional visual mode (needs the plinth skill and a running app):

   ```bash
   node <path-to-skill>/scripts/ramble.mjs . --thumbs --base-url http://localhost:3000
   ```

   Adds `flow-visual.md` with framed screenshots of static routes.

## When output looks wrong

- Screens missing → is that router expressed in code the walker knows
  (Next app/pages conventions, React Router `path:` config)? The report
  names the routers it found.
- Edges missing → links built from variables are in the unresolved
  list, not the diagram; `--include-shared` adds edges found in shared
  components (navbars) under one `shared` node.
- A route you can't find in the URL bar → check the report's parallel
  slot / intercepting route notes; those render inside other screens.
