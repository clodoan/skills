#!/usr/bin/env node
/**
 * ramble — a Mermaid flowchart of the screens and transitions that
 * actually exist in a codebase.
 *
 * Walks router conventions (Next.js app/ and pages/, React Router
 * config files) plus Link/href/navigate/redirect call sites, and emits
 * a flowchart of real routes: grouped by segment, dynamic params
 * labeled, redirect/middleware edges dashed. Unresolved or dynamic
 * navigations are reported, never silently dropped.
 *
 * Zero dependencies. Node >= 18.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, realpathSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const EXIT_OK = 0;
const EXIT_USAGE = 2;

const PAGE_RE = /^page\.(js|jsx|ts|tsx|mdx)$/;
const PAGES_EXT_RE = /\.(js|jsx|ts|tsx|mdx)$/;
const SOURCE_EXT_RE = /\.(js|jsx|ts|tsx|mjs|cjs|mdx)$/;
const PRUNE_DIRS = new Set([
  "node_modules", ".git", ".next", ".turbo", "dist", "build", "out",
  "coverage", ".vercel", "public", "static", ".storybook", "__tests__",
]);

class UsageError extends Error {}

function usage() {
  return `Usage: ramble <dir> [options]

Walks the router(s) in <dir> and writes a Mermaid flowchart of real
screens and transitions, plus a report of anything it could not
resolve.

Options:
  --out <dir>         Output directory (default: ramble-output)
  --include-shared    Add edges found in shared (non-route) files,
                      attributed to one [shared UI] node
  --max-label <n>     Truncate edge labels (default 24 chars)
  --thumbs            Also render screen thumbnails via the plinth skill
  --base-url <url>    Running app URL for --thumbs (required with it)
  --thumb-cap <n>     Max thumbnails (default 12, static routes only)
  -h, --help          Show this help

Outputs: flow.md (diagram + report), flow.mmd (raw Mermaid), and with
--thumbs a flow-visual.md gallery + thumbs/*.png.

Exit codes: 0 ok, 2 usage error.`;
}

function parseArgs(argv) {
  const opts = {
    root: null, out: "ramble-output", includeShared: false, maxLabel: 24,
    thumbs: false, baseUrl: null, thumbCap: 12,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case "--out": opts.out = next(); break;
      case "--include-shared": opts.includeShared = true; break;
      case "--max-label": opts.maxLabel = Number(next()); break;
      case "--thumbs": opts.thumbs = true; break;
      case "--base-url": opts.baseUrl = next(); break;
      case "--thumb-cap": opts.thumbCap = Number(next()); break;
      case "-h":
      case "--help":
        console.log(usage());
        process.exit(EXIT_OK);
        break;
      default:
        if (arg.startsWith("-")) throw new UsageError(`unknown option: ${arg}`);
        if (opts.root) throw new UsageError("only one directory is supported");
        opts.root = arg;
    }
  }
  if (!opts.root) throw new UsageError("missing target directory");
  if (!existsSync(opts.root)) throw new UsageError(`directory not found: ${opts.root}`);
  if (opts.thumbs && !opts.baseUrl) throw new UsageError("--thumbs requires --base-url <running app>");
  return opts;
}

// ---------------------------------------------------------- thumbnails

function renderThumbs(routes, opts) {
  const plinth = process.env.RAMBLE_PLINTH
    ?? fileURLToPath(new URL("../../plinth/scripts/plinth.mjs", import.meta.url));
  if (!existsSync(plinth)) {
    throw new UsageError(
      "--thumbs needs the plinth skill next to ramble (skills/plinth); set RAMBLE_PLINTH to its scripts/plinth.mjs",
    );
  }
  const targets = routes.filter((r) => !r.dynamic).slice(0, opts.thumbCap);
  const thumbsDir = path.join(opts.out, "thumbs");
  mkdirSync(thumbsDir, { recursive: true });
  const rows = [];
  for (const r of targets) {
    const slug = r.urlPath === "/" ? "home" : r.urlPath.slice(1).replace(/[^a-zA-Z0-9]+/g, "-");
    const png = path.join(thumbsDir, `${slug}.png`);
    const url = `${opts.baseUrl.replace(/\/$/, "")}${r.urlPath}`;
    const res = spawnSync(process.execPath, [
      plinth, url, "--device", "browser", "--padding", "16", "--no-shadow", "--bg", "none", "--out", png,
    ], { encoding: "utf8", timeout: 120000 });
    const ok = res.status === 0 && existsSync(png);
    if (ok) {
      // Halve for gallery weight; keep going without ffmpeg.
      spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", png, "-vf", "scale=560:-1:flags=lanczos", png + ".small.png"], {});
      rows.push({ route: r.urlPath, img: existsSync(png + ".small.png") ? `thumbs/${slug}.png.small.png` : `thumbs/${slug}.png` });
    } else {
      rows.push({ route: r.urlPath, error: (res.stdout + res.stderr).split("\n").find((l) => l.includes("plinth:")) ?? "capture failed" });
    }
    console.log(`  thumb ${r.urlPath} — ${ok ? "ok" : "FAILED"}`);
  }
  const cells = rows.map((row) =>
    row.img
      ? `<td align="center"><img src="${row.img}" width="280"/><br/><code>${row.route}</code></td>`
      : `<td align="center">⚠️ <code>${row.route}</code><br/>${row.error}</td>`);
  const tableRows = [];
  for (let i = 0; i < cells.length; i += 3) tableRows.push(`<tr>${cells.slice(i, i + 3).join("")}</tr>`);
  writeFileSync(
    path.join(opts.out, "flow-visual.md"),
    `# Visual screen map\n\nStatic routes captured from ${opts.baseUrl} (cap ${opts.thumbCap}; dynamic routes need real params — see flow.md).\n\n<table>\n${tableRows.join("\n")}\n</table>\n`,
  );
  return rows;
}

// ------------------------------------------------------------ fs walking

// Sorted by code point so output is identical on APFS (sorted) and ext4
// (hash order). Unreadable directories are skipped, not fatal.
function readdirSorted(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** "dir" | "file" | null, following symlinks; broken links are null. */
function entryKind(full, entry) {
  if (!entry.isSymbolicLink()) return entry.isDirectory() ? "dir" : entry.isFile() ? "file" : null;
  try {
    const st = statSync(full);
    return st.isDirectory() ? "dir" : st.isFile() ? "file" : null;
  } catch {
    return null;
  }
}

/** True the first time a directory's real path is seen (symlink-loop guard). */
function firstVisit(visited, dir) {
  let real;
  try {
    real = realpathSync(dir);
  } catch {
    return false;
  }
  if (visited.has(real)) return false;
  visited.add(real);
  return true;
}

// Scans never follow directory symlinks; router walks do, with a guard.
function* walkDirs(dir) {
  yield dir;
  for (const entry of readdirSorted(dir)) {
    if (!entry.isDirectory() || PRUNE_DIRS.has(entry.name)) continue;
    yield* walkDirs(path.join(dir, entry.name));
  }
}

function* walkFiles(dir) {
  for (const entry of readdirSorted(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!PRUNE_DIRS.has(entry.name)) yield* walkFiles(full);
    } else if (SOURCE_EXT_RE.test(entry.name) && entryKind(full, entry) === "file") {
      yield full;
    }
  }
}

const textCache = new Map();
function readText(file) {
  if (!textCache.has(file)) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      // unreadable: treated as empty
    }
    textCache.set(file, text);
  }
  return textCache.get(file);
}

// ---------------------------------------------------------------- roots

function hasPageFileBelow(dir, depth = 0) {
  if (depth > 8) return false;
  for (const entry of readdirSorted(dir)) {
    if (entry.isFile() && PAGE_RE.test(entry.name)) return true;
    if (entry.isDirectory() && !PRUNE_DIRS.has(entry.name)) {
      if (hasPageFileBelow(path.join(dir, entry.name), depth + 1)) return true;
    }
  }
  return false;
}

function detectRoots(root) {
  const roots = [];
  for (const dir of walkDirs(root)) {
    const base = path.basename(dir);
    const parent = path.basename(path.dirname(dir));
    if (base === "app" && parent !== "pages" && hasPageFileBelow(dir)) {
      roots.push({ kind: "next-app", dir });
    } else if (base === "pages" && !dir.includes(`${path.sep}app${path.sep}`)) {
      // A real Next.js pages/ root sits next to package.json (or inside
      // src/ next to one) — content folders named "pages" (MDX etc.) don't.
      const parentDir = path.dirname(dir);
      const anchor = path.basename(parentDir) === "src" ? path.dirname(parentDir) : parentDir;
      if (!existsSync(path.join(anchor, "package.json"))) continue;
      const hasPages = readdirSorted(dir).some(
        (e) => (e.isFile() && PAGES_EXT_RE.test(e.name)) || (e.isDirectory() && !PRUNE_DIRS.has(e.name)),
      );
      if (hasPages) roots.push({ kind: "next-pages", dir });
    }
  }
  // React Router: files that define routes.
  const rrFiles = [];
  for (const file of walkFiles(root)) {
    const text = readText(file);
    if (/createBrowserRouter|createHashRouter|createMemoryRouter|createRoutesFromElements|useRoutes\s*\(/.test(text)) {
      rrFiles.push(file);
    }
  }
  if (rrFiles.length) roots.push({ kind: "react-router", files: rrFiles });
  return roots;
}

// ------------------------------------------------------- next app router

function segmentToUrl(seg) {
  if (/^\[\[\.\.\.(.+)\]\]$/.test(seg)) return `:${seg.slice(5, -2)}*?`;
  if (/^\[\.\.\.(.+)\]$/.test(seg)) return `:${seg.slice(4, -1)}*`;
  if (/^\[(.+)\]$/.test(seg)) return `:${seg.slice(1, -1)}`;
  return seg;
}

function walkAppRouter(appDir, appLabel) {
  const routes = [];
  const slots = [];
  const intercepts = [];
  let apiRoutes = 0;
  const visited = new Set();

  const recurse = (dir, urlSegs, groups, inSlot, host) => {
    if (!firstVisit(visited, dir)) return;
    for (const entry of readdirSorted(dir)) {
      const full = path.join(dir, entry.name);
      const kind = entryKind(full, entry);
      if (kind === "file") {
        if (PAGE_RE.test(entry.name)) {
          const urlPath = "/" + urlSegs.join("/");
          if (inSlot) {
            slots.push({ slot: inSlot, urlPath, file: full });
          } else {
            routes.push({
              urlPath: urlPath === "/" ? "/" : urlPath.replace(/\/$/, ""),
              file: full,
              groups: [...groups],
              app: host ? `${appLabel} · ${host}` : appLabel,
              dynamic: urlSegs.some((s) => s.startsWith(":")),
            });
          }
        } else if (/^route\.(js|jsx|ts|tsx)$/.test(entry.name)) {
          apiRoutes += 1;
        }
        continue;
      }
      // Inside a router every folder is a segment ("build", "public", …);
      // only node_modules is skipped.
      if (kind !== "dir" || entry.name === "node_modules") continue;
      const name = entry.name;
      if (name.startsWith("_")) continue; // private folder
      if (name.startsWith("@")) {
        recurse(full, urlSegs, groups, name, host);
        continue;
      }
      const interceptMatch = name.match(/^(\(\.{1,3}\)|\(\.\.\)\(\.\.\))(.+)$/);
      if (interceptMatch) {
        intercepts.push({
          from: "/" + urlSegs.join("/"),
          target: interceptMatch[2],
          marker: interceptMatch[1],
          dir: full,
        });
        continue; // intercepted content is a modal-in-place, not a screen URL
      }
      if (/^\(.+\)$/.test(name)) {
        recurse(full, urlSegs, [...groups, name.slice(1, -1)], inSlot, host);
        continue;
      }
      // Host-based top-level folders (dub-style multi-tenant: app/app.dub.co/…)
      // are routing domains, not URL segments.
      if (urlSegs.length === 0 && !host && name.includes(".") && !name.startsWith("[")) {
        recurse(full, urlSegs, groups, inSlot, name);
        continue;
      }
      recurse(full, [...urlSegs, segmentToUrl(name)], groups, inSlot, host);
    }
  };
  recurse(appDir, [], [], null, null);
  return { routes, slots, intercepts, apiRoutes };
}

// ----------------------------------------------------- next pages router

const PAGES_SPECIAL = new Set(["_app", "_document", "_error", "_middleware", "404", "500"]);

function walkPagesRouter(pagesDir, appLabel) {
  const routes = [];
  const visited = new Set();
  const recurse = (dir, urlSegs) => {
    if (!firstVisit(visited, dir)) return;
    for (const entry of readdirSorted(dir)) {
      const full = path.join(dir, entry.name);
      const kind = entryKind(full, entry);
      if (kind === "dir") {
        // Only the top-level pages/api is API; pages/docs/api/ is a page.
        const isApi = urlSegs.length === 0 && entry.name === "api";
        if (entry.name !== "node_modules" && !isApi) {
          recurse(full, [...urlSegs, segmentToUrl(entry.name)]);
        }
        continue;
      }
      if (kind !== "file" || !PAGES_EXT_RE.test(entry.name) || entry.name.endsWith(".d.ts")) continue;
      const base = entry.name.replace(PAGES_EXT_RE, "");
      if (PAGES_SPECIAL.has(base)) continue;
      const segs = base === "index" ? urlSegs : [...urlSegs, segmentToUrl(base)];
      const urlPath = "/" + segs.join("/");
      routes.push({
        urlPath: urlPath === "/" ? "/" : urlPath.replace(/\/$/, ""),
        file: full,
        groups: [],
        app: appLabel,
        dynamic: segs.some((s) => s.startsWith(":")),
      });
    }
  };
  recurse(pagesDir, []);
  return routes;
}

// ---------------------------------------------------------- react router

/**
 * Extract a balanced { … } object literal starting at text[start] === "{",
 * skipping string/template contents.
 */
function extractObjectLiteral(text, start) {
  let depth = 0;
  let i = start;
  let quote = null;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Within an object literal, find `key:`'s value at depth 1. */
function objectValue(objText, key) {
  let depth = 0;
  let quote = null;
  const keyRe = new RegExp(`^${key}\\s*:`);
  for (let i = 0; i < objText.length; i++) {
    const ch = objText[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "{") { depth++; continue; }
    if (ch === "}") { depth--; continue; }
    if (depth !== 1) continue;
    const rest = objText.slice(i);
    const m = rest.match(keyRe);
    if (m && /[,{\s]/.test(objText[i - 1] ?? "{")) {
      const after = objText.slice(i + m[0].length).trimStart();
      if (after.startsWith("{")) return extractObjectLiteral(after, 0);
      const lit = after.match(/^(["'`])((?:(?!\1).)*)\1/);
      return lit ? lit[2] : null;
    }
  }
  return null;
}

/**
 * Resolve an identifier chain like `paths.app.discussions.path` against a
 * config object literal defined anywhere in the scanned files (the
 * bulletproof-react central-paths pattern).
 */
function makeChainResolver(allFiles) {
  const configCache = new Map();
  const findConfig = (ident) => {
    if (configCache.has(ident)) return configCache.get(ident);
    let found = null;
    for (const file of allFiles) {
      const text = readText(file);
      const m = text.match(new RegExp(`(?:export\\s+)?const\\s+${ident}\\s*(?:=|:[^=]*=)\\s*`));
      if (!m) continue;
      const braceIdx = text.indexOf("{", m.index + m[0].length - 1);
      if (braceIdx === -1) continue;
      const obj = extractObjectLiteral(text, braceIdx);
      if (obj) { found = obj; break; }
    }
    configCache.set(ident, found);
    return found;
  };
  return (chain) => {
    const [root, ...keys] = chain.split(".");
    let node = findConfig(root);
    for (const key of keys) {
      if (typeof node !== "string" || !node.startsWith("{")) return null;
      node = objectValue(node, key);
      if (node === null) return null;
    }
    return typeof node === "string" && !node.startsWith("{") ? node : null;
  };
}

/**
 * Best-effort, regex-based (no AST): collects `path:` values from
 * router config objects — string literals or identifier chains resolved
 * through a central paths config — joining relative child paths to the
 * nearest shallower `path` by brace depth. JSX <Route path> is
 * collected flat.
 */
function parseReactRouter(files, appLabel, resolveChain) {
  const routes = [];
  const unresolvedPaths = [];
  const seen = new Set();
  for (const file of files) {
    const text = readText(file);
    const stack = []; // { depth, path }
    let depth = 0;
    const re = /\{|\}|path\s*:\s*(["'`])((?:(?!\1).)*)\1|path\s*:\s*([\w$][\w$.]+)|<Route[^>]*\spath=(["'])((?:(?!\4).)*)\4/g;
    let m;
    while ((m = re.exec(text))) {
      if (m[0] === "{") { depth++; continue; }
      if (m[0] === "}") {
        depth--;
        while (stack.length && stack.at(-1).depth > depth) stack.pop();
        continue;
      }
      let raw = m[2] ?? m[5];
      if (raw === undefined && m[3]) {
        raw = resolveChain?.(m[3]) ?? undefined;
        if (raw === undefined) {
          unresolvedPaths.push({
            value: m[3],
            file,
            line: text.slice(0, m.index).split("\n").length,
          });
          continue;
        }
      }
      if (raw === undefined) continue;
      let urlPath;
      if (raw.startsWith("/")) {
        urlPath = raw;
        stack.push({ depth, path: raw });
      } else {
        while (stack.length && stack.at(-1).depth >= depth) stack.pop();
        const parent = stack.at(-1)?.path ?? "";
        urlPath = `${parent}/${raw}`.replace(/\/+/g, "/");
        stack.push({ depth, path: urlPath });
      }
      urlPath = urlPath.replace(/\/\*$/, "/:rest*");
      if (urlPath !== "/") urlPath = urlPath.replace(/\/$/, "");
      if (seen.has(urlPath)) continue;
      seen.add(urlPath);
      routes.push({
        urlPath,
        file,
        groups: [],
        app: appLabel,
        dynamic: /:/.test(urlPath),
      });
    }
  }
  return { routes, unresolvedPaths };
}

// ----------------------------------------------------------------- edges

const NAV_PATTERNS = [
  { re: /(?:href|to)=\{?["']([^"'}]+)["']\}?/g, kind: "link" },
  // Template literals get their own patterns: ${…} contains "}" which
  // the quoted patterns must exclude.
  { re: /(?:href|to)=\{\s*`([^`]+)`\s*\}/g, kind: "link" },
  { re: /router\.(?:push|replace)\(\s*["']([^"']+)["']/g, kind: "link" },
  { re: /router\.(?:push|replace)\(\s*`([^`]+)`/g, kind: "link" },
  { re: /navigate\(\s*["']([^"']+)["']/g, kind: "link" },
  { re: /navigate\(\s*`([^`]+)`/g, kind: "link" },
  { re: /(?:permanentR|r)edirect\(\s*["']([^"']+)["']/g, kind: "redirect" },
  { re: /(?:permanentR|r)edirect\(\s*`([^`]+)`/g, kind: "redirect" },
  { re: /NextResponse\.redirect\([^)]*["'`]([^"'`]+)["'`]/g, kind: "redirect" },
];

// Expression-valued navigations (to={paths.x.getHref()}, router.push(url))
// cannot be resolved statically — they are REPORTED, never dropped.
const NAV_EXPR_PATTERNS = [
  /(?:href|to)=\{([A-Za-z_$][^"'`}]*)\}/g,
  /router\.(?:push|replace)\(\s*([A-Za-z_$][\w$.()[\] ]*)\s*[,)]/g,
  /navigate\(\s*([A-Za-z_$][\w$.()[\] ]*)\s*[,)]/g,
];

function normalizeTarget(raw) {
  let t = raw.trim();
  if (/^(https?:|mailto:|tel:|#)/.test(t)) return { external: true, value: t };
  t = t.split(/[?#]/)[0];
  t = t.replace(/\$\{[^}]*\}/g, ":x");
  if (!t.startsWith("/")) return { relative: true, value: t };
  if (t !== "/") t = t.replace(/\/$/, "");
  return { value: t };
}

function routeMatchers(routes) {
  return routes.map((r) => {
    const pattern = r.urlPath
      .split("/")
      .map((seg) => {
        if (seg.startsWith(":")) return seg.endsWith("*") || seg.endsWith("*?") ? ".+" : "[^/]+";
        return seg.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      })
      .join("/");
    return { route: r, re: new RegExp(`^${pattern}$`) };
  });
}

function collectEdges({ rootDir, routes, includeShared }) {
  const matchers = routeMatchers(routes);
  const staticMap = new Map(routes.map((r) => [r.urlPath, r]));
  const routeDirs = routes
    .map((r) => ({ dir: path.dirname(r.file), route: r }))
    .sort((a, b) => b.dir.length - a.dir.length);

  const sourceRouteFor = (file) => {
    for (const { dir, route } of routeDirs) {
      if (file === route.file || file.startsWith(dir + path.sep)) return route;
    }
    return null;
  };

  const resolveTarget = (value) => {
    const exact = staticMap.get(value);
    if (exact) return exact;
    for (const { route, re } of matchers) {
      if (re.test(value)) return route;
    }
    return null;
  };

  const edges = [];
  const unresolved = [];
  const external = new Set();
  const seen = new Set();

  for (const file of walkFiles(rootDir)) {
    const text = readText(file);
    const isMiddleware = /(^|\/)middleware\.(js|ts)$/.test(file);
    const source = isMiddleware ? "middleware" : sourceRouteFor(file);
    if (!source && !includeShared && !isMiddleware) {
      // Still scan shared files so unresolved/dynamic navigation is
      // reported rather than dropped — they just don't become edges.
    }
    for (const { re, kind } of NAV_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const target = normalizeTarget(m[1]);
        if (target.external) { external.add(target.value.split("/")[2] ?? target.value); continue; }
        if (target.relative) continue; // relative hrefs: not resolvable without runtime
        const resolved = resolveTarget(target.value);
        const line = text.slice(0, m.index).split("\n").length;
        if (!resolved) {
          unresolved.push({ value: m[1], file: path.relative(rootDir, file), line });
          continue;
        }
        const src = source === "middleware" ? "middleware" : source ?? (includeShared ? "shared" : null);
        if (!src) continue;
        const edgeKind = isMiddleware ? "middleware" : kind;
        const key = `${src === "middleware" || src === "shared" ? src : src.urlPath}→${resolved.urlPath}:${edgeKind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ source: src, target: resolved, kind: edgeKind });
      }
    }
    for (const re of NAV_EXPR_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const line = text.slice(0, m.index).split("\n").length;
        unresolved.push({ value: `{${m[1].trim()}}`, file: path.relative(rootDir, file), line, expr: true });
      }
    }
  }
  return { edges, unresolved, external: [...external] };
}

// next.config redirects()
function collectConfigRedirects(rootDir, routes) {
  const matchers = routeMatchers(routes);
  const edges = [];
  for (const name of ["next.config.js", "next.config.mjs", "next.config.ts"]) {
    const file = path.join(rootDir, name);
    if (!existsSync(file)) continue;
    const text = readText(file);
    const re = /source\s*:\s*["'`]([^"'`]+)["'`][\s\S]{0,200}?destination\s*:\s*["'`]([^"'`]+)["'`]/g;
    let m;
    while ((m = re.exec(text))) {
      const to = matchers.find(({ re: r }) => r.test(m[2].split(/[?#]/)[0]))?.route;
      if (to) edges.push({ source: "middleware", target: to, kind: "config-redirect", label: m[1] });
    }
  }
  return edges;
}

// --------------------------------------------------------------- mermaid

function sanitizeId(s) {
  return s.replace(/[^a-zA-Z0-9]/g, "_");
}

function emitMermaid({ routes, edges, maxLabel }) {
  const ids = new Map();
  routes.forEach((r, i) => ids.set(r, `r${i}`));
  const lines = ["flowchart TD"];

  const apps = [...new Set(routes.map((r) => r.app))];
  for (const app of apps) {
    const appRoutes = routes.filter((r) => r.app === app);
    const groups = new Map();
    for (const r of appRoutes) {
      const seg = r.urlPath === "/" ? "/" : `/${r.urlPath.split("/")[1]}`;
      if (!groups.get(seg)) groups.set(seg, []);
      groups.get(seg).push(r);
    }
    const indent = apps.length > 1 ? "    " : "  ";
    if (apps.length > 1) lines.push(`  subgraph APP_${sanitizeId(app)}["${app}"]`);
    for (const [seg, rs] of [...groups.entries()].sort()) {
      const many = rs.length > 1;
      if (many) lines.push(`${indent}subgraph G_${sanitizeId(app + seg)}["${seg}"]`);
      for (const r of rs) {
        const label = r.urlPath.replace(/"/g, "'");
        lines.push(`${indent}${many ? "  " : ""}${ids.get(r)}["${label}"]`);
      }
      if (many) lines.push(`${indent}end`);
    }
    if (apps.length > 1) lines.push("  end");
  }

  const specials = new Set(edges.map((e) => e.source).filter((s) => typeof s === "string"));
  for (const s of specials) lines.push(`  ${sanitizeId(s)}{{"${s}"}}`);

  for (const e of edges) {
    const from = typeof e.source === "string" ? sanitizeId(e.source) : ids.get(e.source);
    const to = ids.get(e.target);
    const label = e.label ? `|"${e.label.slice(0, maxLabel).replace(/"/g, "'")}"|` : "";
    const arrow = e.kind === "link" ? `-->${label}` : `-. ${e.kind} .->`;
    lines.push(`  ${from} ${arrow} ${to}`);
  }
  return lines.join("\n");
}

// ----------------------------------------------------------------- main

function validate(routes, edges, mermaid) {
  const problems = [];
  for (const r of routes) {
    if (!mermaid.includes(`["${r.urlPath.replace(/"/g, "'")}"]`)) {
      problems.push(`route missing from diagram: ${r.urlPath} (${r.file})`);
    }
  }
  const routeSet = new Set(routes);
  for (const e of edges) {
    if (!routeSet.has(e.target)) problems.push(`edge to unknown route: ${e.target?.urlPath}`);
    if (typeof e.source !== "string" && !routeSet.has(e.source)) {
      problems.push(`edge from unknown route: ${e.source?.urlPath}`);
    }
  }
  return problems;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(opts.root);

  const roots = detectRoots(rootDir);
  if (roots.length === 0) {
    throw new UsageError(
      "no routers found (looked for Next.js app/ and pages/ directories and React Router config files)",
    );
  }

  const routes = [];
  const unresolvedRoutePaths = [];
  let slots = [];
  let intercepts = [];
  let apiRoutes = 0;
  for (const r of roots) {
    if (r.kind === "next-app") {
      const label = path.relative(rootDir, r.dir) || "app";
      const res = walkAppRouter(r.dir, label);
      routes.push(...res.routes);
      slots = slots.concat(res.slots);
      intercepts = intercepts.concat(res.intercepts);
      apiRoutes += res.apiRoutes;
    } else if (r.kind === "next-pages") {
      routes.push(...walkPagesRouter(r.dir, path.relative(rootDir, r.dir) || "pages"));
    } else if (r.kind === "react-router") {
      const allFiles = [...walkFiles(rootDir)];
      const res = parseReactRouter(r.files, "react-router", makeChainResolver(allFiles));
      routes.push(...res.routes);
      unresolvedRoutePaths.push(...res.unresolvedPaths.map((u) => ({
        ...u,
        file: path.relative(rootDir, u.file),
      })));
    }
  }

  // Deduplicate same URL within one app (e.g. parallel group variants).
  const dedup = new Map();
  for (const r of routes) {
    const key = `${r.app}:${r.urlPath}`;
    if (!dedup.has(key)) dedup.set(key, r);
  }
  const appOrder = [...new Set(routes.map((r) => r.app))];
  const finalRoutes = [...dedup.values()].sort((a, b) =>
    appOrder.indexOf(a.app) - appOrder.indexOf(b.app) || (a.urlPath < b.urlPath ? -1 : a.urlPath > b.urlPath ? 1 : 0));

  const { edges, unresolved, external } = collectEdges({
    rootDir, routes: finalRoutes, includeShared: opts.includeShared,
  });
  edges.push(...collectConfigRedirects(rootDir, finalRoutes));

  const mermaid = emitMermaid({ routes: finalRoutes, edges, maxLabel: opts.maxLabel });
  const problems = validate(finalRoutes, edges, mermaid);

  const report = `## Ramble report

- **Routers:** ${roots.map((r) => r.kind + (r.dir ? ` (${path.relative(rootDir, r.dir)})` : "")).join(", ")}
- **Screens:** ${finalRoutes.length} (${finalRoutes.filter((r) => r.dynamic).length} dynamic)${routes.length !== finalRoutes.length ? ` — ${routes.length - finalRoutes.length} duplicate URL(s) merged` : ""}
- **Edges:** ${edges.length} (${edges.filter((e) => e.kind !== "link").length} redirect/middleware)
- **API route handlers (not screens):** ${apiRoutes}
- **Parallel route slots (render inside a screen, not URLs):** ${slots.length}${slots.length ? " — " + [...new Set(slots.map((s) => s.slot))].join(", ") : ""}
- **Intercepting routes (modals-in-place):** ${intercepts.length}${intercepts.length ? "\n" + intercepts.map((i) => `  - ${i.marker}${i.target} under ${i.from || "/"}`).join("\n") : ""}
- **External link hosts:** ${external.length ? external.join(", ") : "none"}
- **Unresolved route path expressions:** ${unresolvedRoutePaths.length}${unresolvedRoutePaths.length ? "\n" + unresolvedRoutePaths.slice(0, 20).map((u) => `  - \`${u.value}\` at ${u.file}:${u.line}`).join("\n") : ""}
- **Unresolved navigations (need eyes, NOT dropped silently):** ${unresolved.length} (${unresolved.filter((u) => u.expr).length} expression-valued)
${unresolved.slice(0, 40).map((u) => `  - \`${u.value}\` at ${u.file}:${u.line}`).join("\n")}${unresolved.length > 40 ? `\n  - …and ${unresolved.length - 40} more` : ""}
${problems.length ? `\n**SELF-CHECK FAILURES:**\n${problems.map((p) => `- ${p}`).join("\n")}` : "\nSelf-check: every route file appears in the diagram; every edge points to an existing route."}`;

  mkdirSync(opts.out, { recursive: true });
  writeFileSync(path.join(opts.out, "flow.mmd"), mermaid + "\n");
  writeFileSync(
    path.join(opts.out, "flow.md"),
    `# Screen map\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n\n${report}\n`,
  );

  console.log(`ramble · ${finalRoutes.length} screens, ${edges.length} edges → ${path.join(opts.out, "flow.md")}`);
  console.log(report.split("\n").slice(2, 10).join("\n"));
  if (opts.thumbs) renderThumbs(finalRoutes, opts);
  if (problems.length) {
    console.error(`ramble: self-check failed:\n${problems.join("\n")}`);
    process.exit(1);
  }
}

try {
  main();
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`ramble: ${err.message}`);
    console.error("");
    console.error(usage());
    process.exit(EXIT_USAGE);
  }
  console.error(`ramble: unexpected error: ${err?.stack ?? err}`);
  process.exit(EXIT_USAGE);
}
