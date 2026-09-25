---
name: ramble
description: >-
  Map the screens and navigation flows already in a codebase as a Mermaid
  flowchart. Use for screen maps, user-flow diagrams, sitemaps, route
  overviews, "what screens does this app have", or "diagram how these
  pages connect". Reads Next.js app/pages and React Router routes plus
  link/redirect call sites.
---

# Ramble

1. Run it on the app (in a monorepo, prefer the app's own directory):

   ```bash
   node <path-to-skill>/scripts/ramble.mjs apps/web
   ```

   Writes `ramble-output/flow.md` (diagram + report) and
   `ramble-output/flow.mmd`, relative to the current directory
   (`--out <dir>` to change).

2. **Read the report before showing the diagram.** Relay its
   **unresolved navigations** (file:line: unmatched targets, expressions,
   relative paths), API handlers, parallel slots and intercepting routes
   (render in place, not URLs). Never present the diagram as complete
   without them.

3. Solid arrows are links; dashed are redirects, middleware/proxy, and
   labeled next.config redirects/rewrites. Dynamic params are `:param`,
   catch-alls `:param*`, optional catch-alls `:param*?`.

4. Screenshots (needs the plinth skill installed next to ramble, with
   `npm install` run in it, and the app running):

   ```bash
   node <path-to-skill>/scripts/ramble.mjs . --thumbs --base-url http://localhost:3000
   ```

   Adds `flow-visual.md` with framed screenshots of static routes.

## When output looks wrong

- Missing screens → check the report's Routers line; only Next.js
  app/pages and React Router route definitions are read.
- Missing edges → links in layouts, navbars, and components that aren't
  a route's page or element are counted under "shared" and hidden;
  `--include-shared` draws them from one `shared` node.
- A route you can't find in the URL bar → see the slot/intercept notes.
