/**
 * Mount a React component with a forced state, no Storybook required.
 *
 * Bundles a generated entry (via esbuild `stdin` with `resolveDir` at the
 * states file's directory, so `react` and every other import resolve from
 * the TARGET APP's node_modules, not this skill's) and serves it from an
 * ephemeral local HTTP server. The page reads `?state=` and `?theme=`
 * from the query string, applies the theme to <html> (class, data-theme,
 * and color-scheme), renders the chosen state into #root, and reports
 * readiness or a render error on `window.__statesheet`. The states
 * file's config (state names, dark class, backgrounds) is exposed on
 * `window.__statesheet.config` so the CLI reads it from one source of
 * truth instead of re-parsing the file.
 */

import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);

let esbuild;
try {
  esbuild = require("esbuild");
} catch {
  throw new Error(
    "esbuild is not installed. Run `npm install` in the statesheet skill directory (skills/statesheet).",
  );
}

function canResolve(id, fromDir) {
  try {
    require.resolve(id, { paths: [fromDir] });
    return true;
  } catch {
    return false;
  }
}

// Walk up from the states file for a tsconfig/jsconfig so path aliases and
// JSX settings of the target app are honored.
function findTsconfig(fromDir) {
  let dir = fromDir;
  for (;;) {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return file;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function entrySource(statesFileAbs, hasReactDomClient) {
  const render = hasReactDomClient
    ? `import { createRoot } from "react-dom/client";
const mount = (node) => createRoot(document.getElementById("root")).render(node);`
    : `import ReactDOM from "react-dom";
const mount = (node) => ReactDOM.render(node, document.getElementById("root"));`;

  return `
import React from "react";
${render}
import def from ${JSON.stringify(statesFileAbs)};

const q = new URLSearchParams(location.search);
const stateName = q.get("state");
const theme = q.get("theme") || "light";
const darkClass = def.darkClass || "dark";
const padding = def.padding === undefined ? 16 : def.padding;
const background = (def.background && def.background[theme]) || "";

const config = {
  name: def.name || (def.component && (def.component.displayName || def.component.name)) || null,
  states: Object.keys(def.states || {}),
  darkClass: darkClass,
};

const doc = document.documentElement;
doc.style.colorScheme = theme;
doc.dataset.theme = theme;
if (theme === "dark") doc.classList.add(darkClass);
if (background) document.body.style.background = background;

function report(error) {
  window.__statesheet = {
    ready: true,
    error: error == null ? null : String((error && error.stack) || error),
    config: config,
  };
}
window.addEventListener("error", (e) => {
  if (!window.__statesheet) report(e.error || e.message);
});

const root = document.getElementById("root");
root.style.padding = padding + "px";

try {
  if (stateName === null) {
    // Metadata-only load: the CLI reads config without rendering.
    report(null);
  } else {
    const spec = def.states && def.states[stateName];
    if (spec === undefined) {
      throw new Error("unknown state " + JSON.stringify(stateName) + " (have: " + Object.keys(def.states || {}).join(", ") + ")");
    }
    const el = typeof spec === "function" ? spec() : React.createElement(def.component, spec);
    const node = typeof def.wrap === "function" ? def.wrap(el, { theme: theme, state: stateName }) : el;
    mount(node);
    requestAnimationFrame(() => requestAnimationFrame(() => report(null)));
  }
} catch (err) {
  report(err);
}
`;
}

function bundleError(err) {
  const first = err.errors?.[0];
  if (!first) return err instanceof Error ? err : new Error(String(err));
  const loc = first.location ? ` (${first.location.file}:${first.location.line})` : "";
  return new Error(`bundling failed: ${first.text}${loc}`);
}

/** Bundle the harness for one states file. Returns { js, css }. */
export async function bundle(statesFile, { alias, nodePaths } = {}) {
  const statesFileAbs = path.resolve(statesFile);
  const statesDir = path.dirname(statesFileAbs);
  const hasReactDomClient = canResolve("react-dom/client", statesDir);
  const tsconfig = findTsconfig(statesDir);

  const options = {
    stdin: {
      contents: entrySource(statesFileAbs, hasReactDomClient),
      resolveDir: statesDir,
      sourcefile: "statesheet-entry.tsx",
      loader: "tsx",
    },
    bundle: true,
    write: false,
    outdir: "statesheet-virtual",
    format: "iife",
    platform: "browser",
    define: { "process.env.NODE_ENV": '"development"' },
    loader: Object.fromEntries(
      [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp4", ".webm"]
        .map((ext) => [ext, "dataurl"]),
    ),
    alias: alias && Object.keys(alias).length > 0 ? alias : undefined,
    nodePaths: nodePaths?.map((p) => path.resolve(statesDir, p)),
    logLevel: "silent",
  };

  let result;
  try {
    result = await esbuild.build(tsconfig ? { ...options, tsconfig } : options);
  } catch (err) {
    // A tsconfig esbuild cannot digest (exotic extends chains) should not
    // block mounting; retry without it.
    if (!tsconfig) throw bundleError(err);
    try {
      result = await esbuild.build(options);
    } catch (err2) {
      throw bundleError(err2);
    }
  }

  let js = null;
  let css = null;
  for (const file of result.outputFiles) {
    if (file.path.endsWith(".js")) js = file.text;
    else if (file.path.endsWith(".css")) css = file.text;
  }
  if (!js) throw new Error("esbuild produced no JS output");
  return { js, css };
}

function harnessHtml(hasCss) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin: 0; }
  #root { box-sizing: border-box; min-height: 48px; }
  /* Deterministic frames: freeze animations and transitions. */
  *, *::before, *::after {
    animation-play-state: paused !important;
    transition: none !important;
    caret-color: transparent !important;
  }
</style>
${hasCss ? '<link rel="stylesheet" href="/bundle.css">' : ""}
</head>
<body>
<script>window.global = window; window.process = window.process || { env: { NODE_ENV: "development" } };</script>
<div id="root"></div>
<script src="/bundle.js"></script>
</body>
</html>
`;
}

/**
 * Bundle and serve the harness on 127.0.0.1:<random port>.
 * Returns { url, close }.
 */
export async function serve(statesFile, { alias, nodePaths } = {}) {
  const { js, css } = await bundle(statesFile, { alias, nodePaths });
  const html = harnessHtml(Boolean(css));

  const server = createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname === "/bundle.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(js);
    } else if (pathname === "/bundle.css" && css) {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      res.end(css);
    } else {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
